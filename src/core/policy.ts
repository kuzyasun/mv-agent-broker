/**
 * Effective write-policy narrowing (spec §12.1, §8.7).
 *
 * The operator profile defines the MAXIMUM capabilities. The coordinator MAY
 * narrow it via SpawnRequest.policy_restrictions (`access`, `write_scope`) —
 * it can never widen privileges, network access or account permissions.
 *
 * The effective normalized policy is computed once inside authoritative spawn
 * admission and bound immutably to the session: it is stored in the existing
 * provision_session intent payload (no DDL) together with the requested
 * restrictions and the profile config/fingerprint captured at spawn time.
 * Scope enforcement (BrokerCore.checkWriteScopeCoverage, TurnExecutor
 * post-run evidence check) reads THIS binding — never the live policy profile
 * config, which the operator may edit after spawn.
 *
 * Coordinator-side enforcement only: no native sandbox and no claim
 * enforcement is implemented here. Unknown mandatory restrictions are
 * POLICY_UNSUPPORTED; malformed values are INVALID_REQUEST; any privilege or
 * scope widening is rejected before session/reservation/dispatch.
 */
import type { RegistryDb } from "../storage/db.ts";
import type { ErrorCode } from "../shared/errors.ts";
import { sha256Hex } from "../shared/ids.ts";
import {
  matchesPrefix,
  normalizeRelPath,
  parsePolicyWriteScope,
  type PolicyWriteScope,
} from "../workspaces/coverage.ts";

/** Binding schema version; the session profile version convention stays "1". */
export const EFFECTIVE_POLICY_BINDING_VERSION = 1;

export type PolicyAccess = "read_only" | "workspace_write";

/**
 * Immutable per-session write policy. `write_scope` holds normalized
 * relative prefixes; `[]` (and any `read_only` access) permits no writes.
 */
export interface EffectiveWritePolicy {
  binding_version: 1;
  access: PolicyAccess;
  write_scope: string[];
  policy_profile_id: string;
  policy_profile_version: string;
  /** Profile config JSON captured at spawn time (verbatim text). */
  profile_config: string;
  /** Integrity fingerprint: sha256 over profile_config. */
  profile_fingerprint: string;
  /** Validated requested restrictions (canonical shape), null when none. */
  requested_restrictions: Record<string, unknown> | null;
}

const KNOWN_RESTRICTION_KEYS = new Set(["access", "write_scope"]);
const ACCESS_VALUES: readonly PolicyAccess[] = ["read_only", "workspace_write"];

export type RestrictionParse =
  | { kind: "none" }
  | { kind: "ok"; value: { access?: PolicyAccess; write_scope?: string[] }; canonical: Record<string, unknown> }
  | { kind: "error"; code: ErrorCode; reason: string };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the requested restrictions (§12.1): unknown mandatory keys are
 * POLICY_UNSUPPORTED (never silently ignored); malformed values are
 * INVALID_REQUEST. Prefixes are normalized with coverage component semantics;
 * duplicates are rejected fail-closed.
 */
export function parseRequestedPolicyRestrictions(raw: unknown): RestrictionParse {
  if (raw === undefined) return { kind: "none" };
  if (!isPlainObject(raw)) {
    return { kind: "error", code: "INVALID_REQUEST", reason: "policy_restrictions must be an object" };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_RESTRICTION_KEYS.has(key)) {
      return {
        kind: "error",
        code: "POLICY_UNSUPPORTED",
        reason: `Unknown mandatory policy restriction '${key}' (§12.1)`,
      };
    }
  }
  let access: PolicyAccess | undefined;
  if (raw.access !== undefined) {
    if (typeof raw.access !== "string" || !ACCESS_VALUES.includes(raw.access as PolicyAccess)) {
      return {
        kind: "error",
        code: "INVALID_REQUEST",
        reason: "policy_restrictions.access must be 'read_only' or 'workspace_write'",
      };
    }
    access = raw.access as PolicyAccess;
  }
  let writeScope: string[] | undefined;
  if (raw.write_scope !== undefined) {
    if (!Array.isArray(raw.write_scope) || raw.write_scope.some((x) => typeof x !== "string")) {
      return {
        kind: "error",
        code: "INVALID_REQUEST",
        reason: "policy_restrictions.write_scope must be an array of relative path prefixes",
      };
    }
    const seen = new Set<string>();
    const normalized: string[] = [];
    for (const entry of raw.write_scope as string[]) {
      let prefix: string;
      try {
        prefix = normalizeRelPath(entry);
      } catch {
        return {
          kind: "error",
          code: "INVALID_REQUEST",
          reason: `policy_restrictions.write_scope contains an invalid path prefix: ${String(entry)}`,
        };
      }
      if (seen.has(prefix)) {
        return {
          kind: "error",
          code: "INVALID_REQUEST",
          reason: `policy_restrictions.write_scope has duplicate prefix ${prefix}`,
        };
      }
      seen.add(prefix);
      normalized.push(prefix);
    }
    writeScope = normalized;
  }
  const value: { access?: PolicyAccess; write_scope?: string[] } = {};
  const canonical: Record<string, unknown> = {};
  if (access !== undefined) {
    value.access = access;
    canonical.access = access;
  }
  if (writeScope !== undefined) {
    value.write_scope = writeScope;
    canonical.write_scope = [...writeScope];
  }
  return { kind: "ok", value, canonical };
}

/** Profile-side policy state parsed from the operator config (§8.1). */
export interface OperatorProfilePolicy {
  access: PolicyAccess; // absent → workspace_write (profile maximum)
  scope: PolicyWriteScope; // absent write_scope → nothing permitted
}

export function parseOperatorProfilePolicy(profileConfigJson: string): OperatorProfilePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profileConfigJson);
  } catch {
    throw new Error("policy profile config is not valid JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new Error("policy profile config must be a JSON object");
  }
  let access: PolicyAccess = "workspace_write";
  if (parsed.access !== undefined) {
    if (typeof parsed.access !== "string" || !ACCESS_VALUES.includes(parsed.access as PolicyAccess)) {
      throw new Error("policy profile access must be 'read_only' or 'workspace_write'");
    }
    access = parsed.access as PolicyAccess;
  }
  // Reuses the exact tri-state semantics of the profile write_scope (§8.7);
  // access is validated above, write_scope errors surface as invalid scope.
  const scope = parsePolicyWriteScope(profileConfigJson);
  return { access, scope };
}

export type NarrowResult =
  | { ok: true; policy: EffectiveWritePolicy }
  | { ok: false; code: ErrorCode; reason: string };

/**
 * Narrow the operator profile by the requested restrictions and normalize the
 * result (§12.1). Widening of access or scope — including prefix siblings
 * like requested `src-other` against profile `src` — is rejected. Fails
 * closed on any unreadable profile config.
 */
export function computeEffectiveWritePolicy(args: {
  policy_profile_id: string;
  policy_profile_version: string;
  profileConfigJson: string;
  requestedRestrictions: unknown;
}): NarrowResult {
  let profile: OperatorProfilePolicy;
  try {
    profile = parseOperatorProfilePolicy(args.profileConfigJson);
  } catch (e) {
    return { ok: false, code: "POLICY_UNSUPPORTED", reason: (e as Error).message };
  }
  if (profile.scope.kind === "invalid") {
    return { ok: false, code: "POLICY_UNSUPPORTED", reason: `policy profile write_scope is invalid: ${profile.scope.reason}` };
  }
  const parsed = parseRequestedPolicyRestrictions(args.requestedRestrictions);
  if (parsed.kind === "error") return { ok: false, code: parsed.code, reason: parsed.reason };

  const requested = parsed.kind === "ok" ? parsed.value : {};
  // Access narrowing: read_only ⊂ workspace_write; the reverse is widening.
  const access: PolicyAccess = requested.access ?? profile.access;
  if (profile.access === "read_only" && access === "workspace_write") {
    return {
      ok: false,
      code: "INVALID_REQUEST",
      reason: "policy_restrictions widen the profile: access 'workspace_write' exceeds operator profile 'read_only'",
    };
  }

  // read_only implies [] (§12.1): any requested write_scope is dominated.
  let writeScope: string[];
  if (access === "read_only") {
    writeScope = [];
  } else if (requested.write_scope !== undefined) {
    const profilePrefixes = profile.scope.kind === "declared" ? profile.scope.prefixes : [];
    for (const prefix of requested.write_scope) {
      const covered = profilePrefixes.some((p) => matchesPrefix(prefix, p));
      if (!covered) {
        return {
          ok: false,
          code: "INVALID_REQUEST",
          reason: `policy_restrictions widen the profile: write scope '${prefix}' is outside the operator profile write scope`,
        };
      }
    }
    writeScope = requested.write_scope;
  } else {
    writeScope = profile.scope.kind === "declared" ? profile.scope.prefixes : [];
  }

  return {
    ok: true,
    policy: {
      binding_version: 1,
      access,
      write_scope: writeScope,
      policy_profile_id: args.policy_profile_id,
      policy_profile_version: args.policy_profile_version,
      profile_config: args.profileConfigJson,
      profile_fingerprint: sha256Hex(args.profileConfigJson),
      requested_restrictions: parsed.kind === "ok" ? parsed.canonical : null,
    },
  };
}

// ─── durable binding (provision_session intent payload, no DDL) ─────────────

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

type StoredBindingValidation =
  | { kind: "absent" } // no historical restrictions can be recovered
  | { kind: "ok"; policy: EffectiveWritePolicy }
  | { kind: "malformed"; reason: string };

/** Structural + integrity validation of a stored binding. */
function validateStoredBinding(
  raw: unknown,
  session: { policy_profile_id: string; policy_profile_version: string },
): StoredBindingValidation {
  if (raw === undefined) return { kind: "absent" };
  if (!isPlainObject(raw)) return { kind: "malformed", reason: "effective_policy binding is not an object" };
  if (raw.binding_version !== EFFECTIVE_POLICY_BINDING_VERSION) {
    return { kind: "malformed", reason: `effective_policy binding_version must be ${EFFECTIVE_POLICY_BINDING_VERSION}` };
  }
  if (
    typeof raw.access !== "string" ||
    !ACCESS_VALUES.includes(raw.access as PolicyAccess) ||
    !Array.isArray(raw.write_scope) ||
    raw.write_scope.some((x) => typeof x !== "string") ||
    typeof raw.policy_profile_id !== "string" ||
    typeof raw.policy_profile_version !== "string" ||
    typeof raw.profile_config !== "string" ||
    typeof raw.profile_fingerprint !== "string" ||
    (raw.requested_restrictions !== null && !isPlainObject(raw.requested_restrictions))
  ) {
    return { kind: "malformed", reason: "effective_policy binding fields are malformed" };
  }
  if (raw.policy_profile_id !== session.policy_profile_id || raw.policy_profile_version !== session.policy_profile_version) {
    return { kind: "malformed", reason: "effective_policy binding does not match the session's policy profile binding" };
  }
  if (sha256Hex(raw.profile_config) !== raw.profile_fingerprint) {
    return { kind: "malformed", reason: "effective_policy profile fingerprint mismatch" };
  }
  // The stored effective policy must still be a faithful narrowing of the
  // captured profile config (binding_version 1 semantics); any drift in the
  // payload fails closed instead of broadening silently.
  const rederived = computeEffectiveWritePolicy({
    policy_profile_id: raw.policy_profile_id,
    policy_profile_version: raw.policy_profile_version,
    profileConfigJson: raw.profile_config,
    // null in the stored binding means "no restrictions requested".
    requestedRestrictions: raw.requested_restrictions ?? undefined,
  });
  if (!rederived.ok) {
    return { kind: "malformed", reason: `effective_policy binding is not reproducible: ${rederived.reason}` };
  }
  const derived = rederived.policy;
  if (
    derived.access !== raw.access ||
    JSON.stringify(derived.write_scope) !== JSON.stringify(raw.write_scope) ||
    derived.profile_fingerprint !== raw.profile_fingerprint ||
    JSON.stringify(derived.requested_restrictions) !== JSON.stringify(raw.requested_restrictions)
  ) {
    return { kind: "malformed", reason: "effective_policy binding does not match its narrowing derivation" };
  }
  return {
    kind: "ok",
    policy: {
      binding_version: 1,
      access: raw.access as PolicyAccess,
      write_scope: raw.write_scope as string[],
      policy_profile_id: raw.policy_profile_id,
      policy_profile_version: raw.policy_profile_version,
      profile_config: raw.profile_config,
      profile_fingerprint: raw.profile_fingerprint,
      requested_restrictions: raw.requested_restrictions as Record<string, unknown> | null,
    },
  };
}

/**
 * Resolve the durable effective write policy for a session. Sessions whose
 * journal predates the binding cannot recover historical restrictions and
 * must be replaced before another turn. Unreadable payloads fail closed;
 * consulting the live profile would invent a broader historical grant.
 */
export function loadSessionWritePolicy(
  db: RegistryDb,
  session: Pick<SessionLike, "session_id" | "policy_profile_id" | "policy_profile_version">,
): BindingLookup {
  const payload = findProvisionIntentPayload(db, session.session_id);
  if (payload === null) return { kind: "legacy" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { kind: "malformed", reason: "provision payload is not valid JSON" };
  }
  if (!isPlainObject(parsed)) return { kind: "malformed", reason: "provision payload is not an object" };
  if (parsed.effective_policy === undefined) return { kind: "legacy" };
  const validated = validateStoredBinding(parsed.effective_policy, session);
  if (validated.kind === "absent") return { kind: "legacy" };
  if (validated.kind === "malformed") return validated;
  return { kind: "effective", policy: validated.policy };
}

export interface SessionLike {
  session_id: string;
  policy_profile_id: string;
  policy_profile_version: string;
}

/**
 * The effective write scope a session is held to at its current lifecycle
 * checkpoints (§8.7), as the tri-state the scope checks already consume.
 * Missing legacy bindings and malformed bindings are invalid. Neither can
 * fall back to a live profile with unprovable historical restrictions.
 */
export function sessionWriteScope(
  db: RegistryDb,
  session: SessionLike,
): { kind: "declared"; prefixes: string[] } | { kind: "absent" } | { kind: "invalid"; reason: string } {
  const lookup = loadSessionWritePolicy(db, session);
  if (lookup.kind === "effective") {
    // read_only implies []: declared-but-empty denies every write.
    return { kind: "declared", prefixes: lookup.policy.access === "read_only" ? [] : lookup.policy.write_scope };
  }
  if (lookup.kind === "malformed") {
    return { kind: "invalid", reason: `effective write-policy binding unusable: ${lookup.reason}` };
  }
  return { kind: "invalid", reason: "Legacy session has no immutable write-policy binding; spawn a replacement session." };
}
