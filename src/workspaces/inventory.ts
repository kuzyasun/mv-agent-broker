/**
 * Independent workspace inventory (spec §8.7, §9.2).
 *
 * Walks the filesystem directly — never `git ls-files`, never the previous
 * snapshot manifest. `.gitignore` does not hide a new file inside a writable
 * source prefix. Untracked/new files are first-class entries.
 */
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { classifyPath, normalizeRelPath, type CoverageConfig } from "./coverage.ts";
import { CoverageError } from "./coverage.ts";

export const SOURCE_SET_BYTE_CAP = 256 * 1024 * 1024; // §15.1: 256 MiB

export interface InventoryEntry {
  path: string; // POSIX-style relative
  type: "file" | "dir";
  content_hash: string | null;
  executable: boolean;
  size: number | null;
}

export interface InventoryResult {
  /** Source entries (files + directories) admitted by the coverage contract. */
  entries: InventoryEntry[];
  /** Allowed non-source outputs observed (bounded list, no content). */
  nonSourceObserved: string[];
  /** Files outside every declared class observed in the tree (no content). */
  protectedObserved: string[];
  /**
   * Top-level files inside excluded subtrees (`.git` etc.), bounded — enough
   * to detect agent writes into Git metadata without walking large trees
   * (§8.7 protected classification includes broker/Git metadata).
   */
  excludedObserved: string[];
  totalSourceBytes: number;
  inventoryCoverage: "complete";
}

/** Bound for metadata-only observation lists (memory safety, §15.2). */
const OBSERVED_LIST_CAP = 1000;

function toPosix(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}

function hashFile(absPath: string): { hash: string; size: number; executable: boolean } {
  const st = statSync(absPath);
  const content = readFileSync(absPath);
  const hash = createHash("sha256").update(content).digest("hex");
  // Windows FAT/NTFS via Node reports no exec bits; `!!(mode & 0o111)` is a
  // stable platform answer (false there, meaningful on POSIX).
  const executable = (st.mode & 0o111) !== 0;
  return { hash, size: st.size, executable };
}

/**
 * Take an independent inventory under `root`. Throws CoverageError with
 * code SNAPSHOT_UNSUPPORTED for symlinks/special files inside the admitted
 * source set (§9.1), and INPUT_LIMIT when the admitted source set exceeds
 * the byte cap (§15.1) — never a silent partial inventory.
 */
export function takeInventory(root: string, config: CoverageConfig, opts: { byteCap?: number } = {}): InventoryResult {
  const cap = opts.byteCap ?? SOURCE_SET_BYTE_CAP;
  const entries: InventoryEntry[] = [];
  const nonSourceObserved: string[] = [];
  const protectedObserved: string[] = [];
  const excludedObserved: string[] = [];
  let totalSourceBytes = 0;

  const boundedPush = (list: string[], value: string): void => {
    if (list.length < OBSERVED_LIST_CAP) list.push(value);
  };

  /** First level of an excluded subtree: enough to see .git metadata writes. */
  const observeExcludedTopLevel = (relDir: string): void => {
    const absDir = relDir === "" ? root : path.join(root, relDir);
    for (const name of readdirSync(absDir)) {
      const rel = toPosix(relDir === "" ? name : path.join(relDir, name));
      try {
        if (lstatSync(path.join(root, rel)).isFile()) boundedPush(excludedObserved, rel);
      } catch {
        /* vanished between readdir and lstat: not an inventory failure */
      }
    }
  };

  const walk = (relDir: string): void => {
    const absDir = relDir === "" ? root : path.join(root, relDir);
    for (const name of readdirSync(absDir)) {
      const rel = toPosix(relDir === "" ? name : path.join(relDir, name));
      const abs = path.join(root, rel);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        if (classifyPath(rel, config) === "source") {
          throw new CoverageError(`Symlink inside admitted source set: ${rel}`, "SNAPSHOT_UNSUPPORTED");
        }
        continue; // non-source symlinks: not captured
      }
      if (st.isDirectory()) {
        const category = classifyPath(rel, config);
        if (category === "excluded") {
          observeExcludedTopLevel(rel); // skip subtree, observe metadata level
          continue;
        }
        if (category === "source") {
          entries.push({ path: rel, type: "dir", content_hash: null, executable: false, size: null });
        } else if (category === "non_source_output") {
          boundedPush(nonSourceObserved, `${rel}/`);
        }
        walk(rel);
        continue;
      }
      if (st.isFile()) {
        const category = classifyPath(rel, config);
        if (category === "excluded") {
          boundedPush(excludedObserved, rel);
        } else if (category === "source") {
          const { hash, size, executable } = hashFile(abs);
          totalSourceBytes += size;
          if (totalSourceBytes > cap) {
            throw new CoverageError(
              `Admitted source set exceeds byte cap (${cap}) at ${rel}`,
              "INPUT_LIMIT",
            );
          }
          entries.push({ path: rel, type: "file", content_hash: hash, executable, size });
        } else if (category === "non_source_output") {
          boundedPush(nonSourceObserved, rel);
        } else {
          boundedPush(protectedObserved, rel);
        }
        continue;
      }
      // FIFOs, sockets, device nodes
      if (classifyPath(rel, config) === "source") {
        throw new CoverageError(`Special file inside admitted source set: ${rel}`, "SNAPSHOT_UNSUPPORTED");
      }
    }
  };

  walk("");

  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  excludedObserved.sort();
  return { entries, nonSourceObserved, protectedObserved, excludedObserved, totalSourceBytes, inventoryCoverage: "complete" };
}

/**
 * source_digest (§5.4): SHA-256 over the canonical ordered source manifest —
 * relative path, entry type, executable bit, content hash — plus the
 * coverage profile id/version/contract hash. Timestamps, capture IDs and
 * absolute paths are excluded, so two captures of identical state under the
 * same contract share a digest even with different snapshot_ids.
 */
export function computeSourceDigest(
  entries: readonly InventoryEntry[],
  coverage: { profile_id: string; version: string; contract_hash: string },
): string {
  const canonical = entries
    .map((e) => `${e.path}|${e.type}|${e.executable ? "x" : "-"}|${e.content_hash ?? ""}`)
    .join("\n");
  const material = `coverage:${coverage.profile_id}:${coverage.version}:${coverage.contract_hash}\n${canonical}`;
  return createHash("sha256").update(material).digest("hex");
}

export { normalizeRelPath };
