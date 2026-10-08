/** Access-only policy binding for trusted local agent sessions. */
import type { RegistryDb } from "../storage/db.ts";
import type { ErrorCode } from "../shared/errors.ts";
import { sha256Hex } from "../shared/ids.ts";

export const EFFECTIVE_POLICY_BINDING_VERSION = 1;
export type PolicyAccess = "read_only" | "workspace_write";

/** `write_scope` is an adapter directive derived solely from access. */
export interface EffectiveWritePolicy {
  binding_version: 1;
  access: PolicyAccess;
  write_scope: string[];
  policy_profile_id: string;
  policy_profile_version: string;
  profile_config: string;
  profile_fingerprint: string;
  requested_access: PolicyAccess | null;
}

export type NarrowResult =
  | { ok: true; policy: EffectiveWritePolicy }
  | { ok: false; code: ErrorCode; reason: string };

function parseProfileAccess(config: string): PolicyAccess | null {
  let parsed: unknown;
  try { parsed = JSON.parse(config); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const access = (parsed as Record<string, unknown>).access;
  if (access === undefined) return "workspace_write";
  return access === "read_only" || access === "workspace_write" ? access : null;
}

/** The operator profile sets the maximum access; a request can only narrow it. */
export function computeEffectiveWritePolicy(args: {
  policy_profile_id: string;
  policy_profile_version: string;
  profileConfigJson: string;
  requestedAccess?: PolicyAccess;
}): NarrowResult {
  const profileAccess = parseProfileAccess(args.profileConfigJson);
  if (!profileAccess) {
    return { ok: false, code: "POLICY_UNSUPPORTED", reason: "Policy profile access must be 'read_only' or 'workspace_write'." };
  }
  const requested = args.requestedAccess;
  if (requested !== undefined && requested !== "read_only" && requested !== "workspace_write") {
    return { ok: false, code: "INVALID_REQUEST", reason: "access must be 'read_only' or 'workspace_write'." };
  }
  if (profileAccess === "read_only" && requested === "workspace_write") {
    return { ok: false, code: "INVALID_REQUEST", reason: "access 'workspace_write' exceeds the read_only policy profile." };
  }
  const access = requested ?? profileAccess;
  return {
    ok: true,
    policy: {
      binding_version: EFFECTIVE_POLICY_BINDING_VERSION,
      access,
      write_scope: access === "read_only" ? [] : ["."],
      policy_profile_id: args.policy_profile_id,
      policy_profile_version: args.policy_profile_version,
      profile_config: args.profileConfigJson,
      profile_fingerprint: sha256Hex(args.profileConfigJson),
      requested_access: requested ?? null,
    },
  };
}

type BindingLookup =
  | { kind: "effective"; policy: EffectiveWritePolicy }
  | { kind: "legacy" }
  | { kind: "malformed"; reason: string };

function findProvisionIntentPayload(db: RegistryDb, sessionId: string): string | null {
  const row = db.raw
    .prepare("SELECT payload FROM intents WHERE kind = 'provision_session' AND session_id = ? LIMIT 1")
    .get(sessionId) as { payload: string | null } | undefined;
  return row?.payload ?? null;
}

function validateStoredBinding(
  raw: unknown,
  session: { policy_profile_id: string; policy_profile_version: string },
): { kind: "ok"; policy: EffectiveWritePolicy } | { kind: "malformed"; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "malformed", reason: "effective_policy binding is not an object" };
  }
  const value = raw as Record<string, unknown>;
  if (
    value.binding_version !== EFFECTIVE_POLICY_BINDING_VERSION ||
    (value.access !== "read_only" && value.access !== "workspace_write") ||
    !Array.isArray(value.write_scope) || value.write_scope.some((item) => typeof item !== "string") ||
    typeof value.policy_profile_id !== "string" || typeof value.policy_profile_version !== "string" ||
    typeof value.profile_config !== "string" || typeof value.profile_fingerprint !== "string" ||
    (value.requested_access !== null && value.requested_access !== "read_only" && value.requested_access !== "workspace_write")
  ) {
    return { kind: "malformed", reason: "effective_policy binding fields are malformed" };
  }
  if (value.policy_profile_id !== session.policy_profile_id || value.policy_profile_version !== session.policy_profile_version) {
    return { kind: "malformed", reason: "effective_policy binding does not match the session policy profile" };
  }
  if (sha256Hex(value.profile_config) !== value.profile_fingerprint) {
    return { kind: "malformed", reason: "effective_policy profile fingerprint mismatch" };
  }
  const derived = computeEffectiveWritePolicy({
    policy_profile_id: value.policy_profile_id,
    policy_profile_version: value.policy_profile_version,
    profileConfigJson: value.profile_config,
    requestedAccess: value.requested_access === null ? undefined : value.requested_access as PolicyAccess,
  });
  if (!derived.ok || JSON.stringify(derived.policy) !== JSON.stringify(value)) {
    return { kind: "malformed", reason: "effective_policy binding does not match its access derivation" };
  }
  return { kind: "ok", policy: derived.policy };
}

export interface SessionLike {
  session_id: string;
  policy_profile_id: string;
  policy_profile_version: string;
}

export function loadSessionWritePolicy(
  db: RegistryDb,
  session: SessionLike,
): BindingLookup {
  const payload = findProvisionIntentPayload(db, session.session_id);
  if (payload === null) return { kind: "legacy" };
  let parsed: unknown;
  try { parsed = JSON.parse(payload); } catch { return { kind: "malformed", reason: "provision payload is not valid JSON" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "provision payload is not an object" };
  }
  const raw = (parsed as Record<string, unknown>).effective_policy;
  if (raw === undefined) return { kind: "legacy" };
  const validated = validateStoredBinding(raw, session);
  return validated.kind === "ok" ? { kind: "effective", policy: validated.policy } : validated;
}

/** Adapter-facing whole-project/read-only directive, with legacy refusal kept fail-closed. */
export function sessionWriteScope(
  db: RegistryDb,
  session: SessionLike,
): { kind: "declared"; prefixes: string[] } | { kind: "absent" } | { kind: "invalid"; reason: string } {
  const lookup = loadSessionWritePolicy(db, session);
  if (lookup.kind === "effective") return { kind: "declared", prefixes: [...lookup.policy.write_scope] };
  if (lookup.kind === "malformed") return { kind: "invalid", reason: `effective policy binding unusable: ${lookup.reason}` };
  return { kind: "invalid", reason: "Legacy session has no immutable access-policy binding; spawn a replacement session." };
}
