/**
 * Broker-managed stable review slot (spec §9.3).
 *
 * Holds the materialized TARGET snapshot tree for review sessions.
 * The broker refreshes it exclusively between quiescent turns;
 * clearing stale files happens only inside this broker-owned slot,
 * never in a worker checkout.
 */
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SnapshotManifest } from "../shared/api-types.ts";

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function assertSessionId(sessionId: string): void {
  if (!sessionId || !SESSION_ID_PATTERN.test(sessionId) || sessionId.startsWith(".")) {
    throw new Error("INVALID_SESSION_ID");
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
      const p = path.join(rootDir, sessionId);
      if (!existsSync(p)) {
        mkdirSync(p, { recursive: true });
      }
      return p;
    },

    refresh(
      sessionId: string,
      manifest: SnapshotManifest,
      readBlob: (contentHash: string) => Uint8Array,
    ): { files: number } {
      assertSessionId(sessionId);
      const slotDir = path.join(rootDir, sessionId);

      // Validate all entry paths before mutating the filesystem (§9.3),
      // including unknown entry types and case-folded duplicate paths
      // (Windows/NTFS is case-insensitive: two entries differing only in
      // case would silently overwrite each other).
      const seenFolded = new Set<string>();
      for (const entry of manifest.entries) {
        resolveEntryPath(slotDir, entry.path);
        if (entry.type !== "file" && entry.type !== "dir") {
          throw new Error(`SLOT_ENTRY_UNKNOWN_TYPE: ${String(entry.type)}`);
        }
        const foldKey = process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
        if (seenFolded.has(foldKey)) {
          throw new Error(`SLOT_ENTRY_DUPLICATE_PATH (case-folded): ${entry.path}`);
        }
        seenFolded.add(foldKey);
      }

      // Broker-managed slot is cleared fully between quiescent turns (§9.3).
      rmSync(slotDir, { recursive: true, force: true });
      mkdirSync(slotDir, { recursive: true });

      let files = 0;
      for (const entry of manifest.entries) {
        const targetPath = resolveEntryPath(slotDir, entry.path);

        if (entry.type === "dir") {
          mkdirSync(targetPath, { recursive: true });
        } else if (entry.type === "file") {
          if (!entry.content_hash) {
            throw new Error(`Snapshot file entry missing content_hash: ${entry.path}`);
          }

          mkdirSync(path.dirname(targetPath), { recursive: true });

          const bytes = readBlob(entry.content_hash);
          // Atomic-ish write: temp sibling + renameSync (§9.3).
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
