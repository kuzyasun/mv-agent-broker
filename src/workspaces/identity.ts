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
import type { RegistryDb } from "../storage/db.ts";

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

// ─── session-bound physical cwd (A06: dispatch pins the checkout) ───────────

/** Binding schema version for the session-owned physical cwd binding. */
export const PHYSICAL_CWD_BINDING_VERSION = 1;

/**
 * Durable binding of a session to the PHYSICAL checkout its native cwd was
 * pinned to at provisioning. Stored inside the session-owned provision_session
 * intent payload (no DDL, no public API change); immutable once the intent
 * completes. Turns dispatch this exact cwd — never a re-resolved mutable
 * registered alias — so a junction retarget after dispatch cannot move native
 * workspace IO to a checkout this session does not lease.
 */
export interface SessionPhysicalCwdBinding {
  binding_version: number;
  /** FS-resolved absolute physical cwd, dispatched verbatim. */
  canonical_cwd: string;
  /** The physical checkout identity scope the cwd resolved to at binding time. */
  lease_scope: string;
  bound_at: number;
}

export type SessionPhysicalBindingLookup =
  | { kind: "bound"; binding: SessionPhysicalCwdBinding }
  | { kind: "unbound" }
  | { kind: "malformed"; reason: string };

/**
 * Read the durable physical cwd binding from the session's provision intent.
 * `unbound` marks sessions provisioned before this binding existed: their
 * historical cwd cannot be proved against the mutable registered alias, so
 * callers must refuse another turn (replacement required; recorded native
 * context and history retained) instead of reinterpreting the alias.
 * Unreadable payloads fail closed as `malformed`.
 */
export function readSessionPhysicalBinding(db: RegistryDb, sessionId: string): SessionPhysicalBindingLookup {
  const row = db.raw
    .prepare("SELECT payload FROM intents WHERE kind = 'provision_session' AND session_id = ? LIMIT 1")
    .get(sessionId) as { payload: string | null } | undefined;
  if (!row || row.payload === null) return { kind: "unbound" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.payload);
  } catch {
    return { kind: "malformed", reason: "provision payload is not valid JSON" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "provision payload is not an object" };
  }
  const raw = (parsed as { physical_workspace?: unknown }).physical_workspace;
  if (raw === undefined) return { kind: "unbound" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "malformed", reason: "physical_workspace binding is not an object" };
  }
  const b = raw as Record<string, unknown>;
  if (
    b.binding_version !== PHYSICAL_CWD_BINDING_VERSION ||
    typeof b.canonical_cwd !== "string" ||
    !path.isAbsolute(b.canonical_cwd) ||
    typeof b.lease_scope !== "string" ||
    !isPhysicalLeaseScope(b.lease_scope) ||
    typeof b.bound_at !== "number" ||
    !Number.isFinite(b.bound_at)
  ) {
    return { kind: "malformed", reason: "physical_workspace binding fields are malformed" };
  }
  return {
    kind: "bound",
    binding: {
      binding_version: PHYSICAL_CWD_BINDING_VERSION,
      canonical_cwd: b.canonical_cwd,
      lease_scope: b.lease_scope,
      bound_at: b.bound_at,
    },
  };
}
