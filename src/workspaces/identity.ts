/**
 * Authoritative physical checkout identity (A05, INV-02).
 *
 * A registered workspace id is a NAME; the writable checkout is a physical
 * directory that the same project may reach through several names: another
 * registered workspace row, a Windows junction, a symlink, a relative or
 * dot-segment spelling, or a differently cased spelling of the same path.
 * Exclusive writer leases must therefore be scoped by the checkout itself,
 * resolved by the FILESYSTEM (realpath/stat) — never by lexical string
 * folding, which invents OS guarantees it does not have (case-sensitive
 * filesystems exist, and Windows realpath preserves caller casing).
 */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

/** Namespace prefix marking a workspace_lease scope as a physical checkout identity. */
export const PHYSICAL_LEASE_SCOPE_PREFIX = "checkout:";

export interface PhysicalCheckoutIdentity {
  /** Durable lease scope encoding the FS-resolved checkout identity. */
  scope: string;
  /** FS-resolved absolute path (realpath) — diagnostics, never compared lexically. */
  resolvedPath: string;
}

/** True when a reservation scope was written as a physical checkout identity (not a legacy workspace_id). */
export function isPhysicalLeaseScope(scope: string): boolean {
  return /^checkout:v1:\d+:\d+$/.test(scope);
}

/**
 * Resolve the authoritative physical identity of a registered checkout path.
 * realpath folds junctions, symlinks and dot-segments into one absolute path;
 * the OS file identity (stat dev/ino, followed through reparse points) is the
 * comparison key, so Windows path-casing spellings collapse correctly —
 * something lexical folding cannot promise and Windows realpath does not do.
 * Filesystems without a usable inode id are refused: realpath spelling
 * cannot establish alias exclusion on a case-insensitive filesystem.
 * Returns null when the path is relative or does not resolve to an existing
 * directory: callers fail closed instead of guessing an ownership scope.
 */
export function resolvePhysicalCheckoutIdentity(canonicalPath: string): PhysicalCheckoutIdentity | null {
  if (!canonicalPath || !path.isAbsolute(canonicalPath)) return null;
  try {
    const resolved = realpathSync(canonicalPath);
    const st = statSync(resolved, { bigint: true });
    if (!st.isDirectory() || st.ino === 0n) return null;
    const scope = `${PHYSICAL_LEASE_SCOPE_PREFIX}v1:${st.dev}:${st.ino}`;
    return { scope, resolvedPath: resolved };
  } catch {
    return null;
  }
}
