/**
 * Broker-managed stable review slot (spec §9.3).
 *
 * Holds the materialized TARGET snapshot tree for review sessions.
 * The broker refreshes it exclusively between quiescent turns;
 * clearing stale files happens only inside this broker-owned slot,
 * never in a worker checkout.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotManifest } from "../shared/api-types.ts";
import { sha256Hex } from "../shared/ids.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertSessionId(sessionId: string): void {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || sessionId.startsWith(".")) {
    throw new Error("INVALID_SESSION_ID");
  }
}

function assertOwnedDirectory(dir: string): void {
  for (let current = path.resolve(dir);;) {
    let entry;
    try { entry = lstatSync(current); } catch { throw new Error("SLOT_PATH_INVALID"); }
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("SLOT_PATH_INVALID");
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/**
 * Validates and maps a POSIX-style relative entry path to an OS path inside slotDir.
 * Throws SLOT_ENTRY_OUTSIDE_ROOT on path traversal or invalid entry names (§9.3).
 */
function resolveEntryPath(slotDir: string, entryPath: string): string {
  if (
    !entryPath ||
    entryPath.startsWith("/") ||
    entryPath.startsWith("\\") ||
    entryPath.includes("\\") ||
    entryPath.includes(":") ||
    /^[A-Za-z]:/.test(entryPath) ||
    path.isAbsolute(entryPath)
  ) {
    throw new Error("SLOT_ENTRY_OUTSIDE_ROOT");
  }

  const segments = entryPath.split("/");
  for (const seg of segments) {
    if (!seg || seg === "." || seg === ".." || seg.includes("\\")) {
      throw new Error("SLOT_ENTRY_OUTSIDE_ROOT");
    }
  }

  // POSIX-style entry paths mapped to local OS via path.join (Windows-safe)
  const targetPath = path.join(slotDir, ...segments);

  // Defense-in-depth: ensure targetPath is strictly inside slotDir
  const normalizedSlot = path.resolve(slotDir);
  const normalizedTarget = path.resolve(targetPath);
  const relative = path.relative(normalizedSlot, normalizedTarget);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("SLOT_ENTRY_OUTSIDE_ROOT");
  }

  return targetPath;
}

function assertFileEntryMetadata(entry: SnapshotManifest["entries"][number]): void {
  if (!entry.content_hash || !HASH_PATTERN.test(entry.content_hash)) {
    throw new Error("SLOT_ENTRY_INVALID_HASH");
  }
  if (entry.size === null || !Number.isInteger(entry.size) || entry.size < 0) {
    throw new Error("SLOT_ENTRY_INVALID_SIZE");
  }
}

export interface ReviewSlotStore {
  /** The stable per-session slot path (created if missing). */
  slotPath(sessionId: string): string;
  /**
   * Refresh the slot to exactly match the manifest's tree: clear ALL previous
   * contents INSIDE the slot directory, then materialize every entry (mkdir
   * for dirs, write file bytes via readBlob(content_hash)). Returns the file
   * count written. Throws Error("SLOT_ENTRY_OUTSIDE_ROOT") on path traversal.
   */
  refresh(sessionId: string, manifest: SnapshotManifest, readBlob: (contentHash: string) => Uint8Array): { files: number };
  /** Whether the slot directory exists. */
  exists(sessionId: string): boolean;
}

export function openReviewSlotStore(rootDir: string): ReviewSlotStore {
  return {
    slotPath(sessionId: string): string {
      assertSessionId(sessionId);
      assertOwnedDirectory(rootDir);
      const p = path.join(rootDir, sessionId);
      if (existsSync(p)) {
        assertOwnedDirectory(p);
      } else {
        mkdirSync(p, { recursive: true });
        assertOwnedDirectory(p);
      }
      return p;
    },

    refresh(
      sessionId: string,
      manifest: SnapshotManifest,
      readBlob: (contentHash: string) => Uint8Array,
    ): { files: number } {
      assertSessionId(sessionId);
      assertOwnedDirectory(rootDir);
      const slotDir = path.join(rootDir, sessionId);

      // Validate all entry paths and sealed file metadata before mutating the
      // filesystem (§9.3), including unknown entry types and case-folded
      // duplicate paths (Windows/NTFS is case-insensitive: two entries
      // differing only in case would silently overwrite each other).
      const seenFolded = new Set<string>();
      for (const entry of manifest.entries) {
        resolveEntryPath(slotDir, entry.path);
        if (entry.type !== "file" && entry.type !== "dir") {
          throw new Error(`SLOT_ENTRY_UNKNOWN_TYPE: ${String(entry.type)}`);
        }
        if (entry.type === "file") {
          assertFileEntryMetadata(entry);
        }
        const foldKey = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
        if (seenFolded.has(foldKey)) {
          throw new Error(`SLOT_ENTRY_DUPLICATE_PATH (case-folded): ${entry.path}`);
        }
        seenFolded.add(foldKey);
      }

      // Refuse linked slot roots without deleting or adopting the link target.
      if (existsSync(slotDir)) {
        assertOwnedDirectory(slotDir);
      }

      // Broker-managed slot is cleared fully between quiescent turns (§9.3).
      rmSync(slotDir, { recursive: true, force: true });
      mkdirSync(slotDir, { recursive: true });
      assertOwnedDirectory(slotDir);

      let files = 0;
      for (const entry of manifest.entries) {
        const targetPath = resolveEntryPath(slotDir, entry.path);

        if (entry.type === "dir") {
          mkdirSync(targetPath, { recursive: true });
        } else if (entry.type === "file") {
          // Metadata already validated above; size/hash are definite.
          const expectedHash = entry.content_hash!;
          const expectedSize = entry.size!;

          mkdirSync(path.dirname(targetPath), { recursive: true });

          const bytes = readBlob(expectedHash);
          // Exact sealed manifest size/hash for authoritative source entries.
          if (bytes.byteLength !== expectedSize) {
            throw new Error("SLOT_BLOB_SIZE_MISMATCH");
          }
          if (sha256Hex(bytes) !== expectedHash) {
            throw new Error("SLOT_BLOB_HASH_MISMATCH");
          }
          // Atomic-ish write: temp sibling + renameSync (§9.3). Copy only —
          // never a writable hardlink into blob storage.
          const tmpPath = `${targetPath}.tmp-${randomUUID()}`;
          try {
            writeFileSync(tmpPath, bytes);
            renameSync(tmpPath, targetPath);
          } catch (err) {
            try {
              rmSync(tmpPath, { force: true });
            } catch {
              // Best-effort cleanup of temporary file
            }
            throw err;
          }

          let published;
          try {
            published = lstatSync(targetPath);
          } catch {
            throw new Error("SLOT_ENTRY_NOT_REGULAR");
          }
          // Unknown/replaced published inode is retained for investigation —
          // never removed as an assumed owned file.
          if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1) {
            throw new Error("SLOT_ENTRY_NOT_REGULAR");
          }

          if (entry.executable) {
            try {
              chmodSync(targetPath, 0o555);
            } catch {
              // Best-effort chmod (§9.3): non-POSIX / Windows environments may not support executable mode.
            }
          }

          files++;
        }
      }

      return { files };
    },

    exists(sessionId: string): boolean {
      assertSessionId(sessionId);
      return existsSync(path.join(rootDir, sessionId));
    },
  };
}
