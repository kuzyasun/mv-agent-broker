import path from "node:path";
import { realpathSync } from "node:fs";

/**
 * Normalizes system paths across platforms.
 *
 * On macOS (Darwin), `/var`, `/tmp`, and `/etc` are root-level symlinks pointing
 * to `/private/var`, `/private/tmp`, and `/private/etc`. Code that inspects directory
 * components with `lstat` or checks for symlinks will fail on macOS if the path
 * uses `/var/...` (such as `os.tmpdir()`) rather than `/private/var/...`.
 */
export function normalizeSystemPath(p: string): string {
  if (process.platform === "darwin") {
    const resolved = path.resolve(p);
    if (resolved === "/var" || resolved.startsWith("/var/")) return "/private" + resolved;
    if (resolved === "/tmp" || resolved.startsWith("/tmp/")) return "/private" + resolved;
    if (resolved === "/etc" || resolved.startsWith("/etc/")) return "/private" + resolved;
    return resolved;
  }
  return path.resolve(p);
}

/**
 * Compares two paths for equality taking into account platform casing rules
 * (Windows and macOS APFS are case-insensitive by default) and macOS /private prefix.
 */
export function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  const normA = normalizeSystemPath(a);
  const normB = normalizeSystemPath(b);
  if (normA === normB) return true;
  if (process.platform === "win32" || process.platform === "darwin") {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return false;
}

/**
 * Checks whether a path component is a standard macOS system root symlink
 * (/var -> /private/var, /tmp -> /private/tmp, /etc -> /private/etc).
 */
export function isAllowedMacSystemSymlink(p: string): boolean {
  if (process.platform !== "darwin") return false;
  const resolved = path.resolve(p);
  if (resolved === "/var") {
    try { return realpathSync(resolved) === "/private/var"; } catch { return false; }
  }
  if (resolved === "/tmp") {
    try { return realpathSync(resolved) === "/private/tmp"; } catch { return false; }
  }
  if (resolved === "/etc") {
    try { return realpathSync(resolved) === "/private/etc"; } catch { return false; }
  }
  return false;
}
