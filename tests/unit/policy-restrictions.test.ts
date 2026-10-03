/**
 * Effective write-policy package (spec §12.1): coordinator narrowing of the
 * operator profile via SpawnRequest.policy_restrictions (access, write_scope).
 *
 * Covered here:
 * - prefix narrowing/normalization (component semantics; src must not allow
 *   src-other; read_only implies []; [] denies all writes; "." is the
 *   whole-project prefix),
 * - the operator default grant: workspace_write without write_scope covers
 *   the WHOLE project including new root entries,
 * - denial of access/scope widening,
 * - unknown/malformed restrictions with zero dispatch and no accepted state,
 * - replay vs different-payload conflict,
 * - accepted narrowed writes / out-of-scope source writes => SCOPE_VIOLATION,
 * - read_only denies writes,
 * - durable binding across config drift and reconstructed core/executor,
 * - legacy journals (no invented restrictions) and malformed bindings
 *   failing closed before inference.
 * All mock-level, no inference.
 */
import { describe, expect, it } from "vitest";
import { createHarness, settle, start, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import type { TurnRecord } from "../../src/shared/api-types.ts";
import {
  computeEffectiveWritePolicy,
  parseRequestedPolicyRestrictions,
  sessionWriteScope,
} from "../../src/core/policy.ts";
import { BrokerCore } from "../../src/core/broker.ts";
import { TurnExecutor } from "../../src/core/execution.ts";
import { insertCoverageProfile, insertPolicyProfile, insertWorkspace } from "../../src/storage/repo.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";

const WRITER_PROFILE = JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests"] });

function narrow(args: {
  profileConfigJson?: string;
  requestedRestrictions: unknown;
  policy_profile_id?: string;
}): ReturnType<typeof computeEffectiveWritePolicy> {
  return computeEffectiveWritePolicy({
    policy_profile_id: args.policy_profile_id ?? "pol-writer",
    policy_profile_version: "1",
    profileConfigJson: args.profileConfigJson ?? WRITER_PROFILE,
    requestedRestrictions: args.requestedRestrictions,
  });
}

function expectBrokerError(fn: () => unknown, code: string): BrokerError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

async function expectBrokerErrorAsync(fn: () => Promise<unknown>, code: string): Promise<BrokerError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

function provisionPayload(h: Harness, sessionId: string): Record<string, unknown> {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=?")
    .get(sessionId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function rewriteProvisionPayload(h: Harness, sessionId: string, mutate: (p: Record<string, unknown>) => void): void {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=?")
    .get(sessionId) as { payload: string };
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  mutate(payload);
  h.db.raw
    .prepare("UPDATE intents SET payload=? WHERE kind='provision_session' AND session_id=?")
    .run(JSON.stringify(payload), sessionId);
}

function stripEffectivePolicy(h: Harness, sessionId: string): void {
  rewriteProvisionPayload(h, sessionId, (p) => {
    delete p.effective_policy; // simulate a pre-package journal
  });
}

function brokerCounts(h: Harness): { sessions: number; turns: number; idempotency: number } {
  const one = (sql: string): number => (h.db.raw.prepare(sql).get() as { c: number }).c;
  return {
    sessions: one("SELECT COUNT(*) c FROM sessions"),
    turns: one("SELECT COUNT(*) c FROM turns"),
    idempotency: one("SELECT COUNT(*) c FROM idempotency_records"),
  };
}

/** Send one task and let the mocked agent write `files`, then complete. */
async function runWriteTurn(
  h: Harness,
  sessionId: string,
  key: string,
  files: Array<{ path: string; content: string }>,
): Promise<TurnRecord> {
  const resp = h.sendTask(sessionId, key);
  h.adapter.plan(resp.turn_id, [
    { kind: "workspace_write", files },
    { kind: "complete", outcome: "completed", summary: "done" },
  ]);
  await start(h, resp);
  await settle(h);
  return h.core.turnStatus(h.seed.coordinatorId, resp.turn_id);
}

/** Send one task with no agent writes (clean completion). */
async function runCleanTurn(h: Harness, sessionId: string, key: string): Promise<TurnRecord> {
  const resp = h.sendTask(sessionId, key);
  h.adapter.plan(resp.turn_id, [{ kind: "complete", outcome: "completed", summary: "done" }]);
  await start(h, resp);
  await settle(h);
  return h.core.turnStatus(h.seed.coordinatorId, resp.turn_id);
}

// ─── restriction validation and narrowing (§12.1, unit level) ────────────────

describe("requested restriction validation", () => {
  it("no restrictions parse as none; non-object is INVALID_REQUEST", () => {
    expect(parseRequestedPolicyRestrictions(undefined).kind).toBe("none");
    expect(parseRequestedPolicyRestrictions({}).kind).toBe("ok");
    for (const bad of [null, "read_only", 42, ["src"]]) {
      const parsed = parseRequestedPolicyRestrictions(bad);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") expect(parsed.code).toBe("INVALID_REQUEST");
    }
  });

  it("unknown mandatory restrictions are POLICY_UNSUPPORTED, never ignored", () => {
    for (const raw of [{ sandbox: "none" }, { access: "read_only", tool_network: "deny" }]) {
      const parsed = parseRequestedPolicyRestrictions(raw);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") expect(parsed.code).toBe("POLICY_UNSUPPORTED");
    }
  });

  it("malformed values are INVALID_REQUEST", () => {
    const cases: unknown[] = [
      { access: "WRITE" },
      { access: 42 },
      { write_scope: "src" }, // not an array
      { write_scope: [42] },
      { write_scope: ["../escape"] },
      { write_scope: ["src/"] }, // empty segment
      { write_scope: ["/abs"] },
      { write_scope: ["src", "src"] }, // duplicate
    ];
    for (const raw of cases) {
      const parsed = parseRequestedPolicyRestrictions(raw);
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") expect(parsed.code).toBe("INVALID_REQUEST");
    }
  });

  it("prefixes normalize with coverage component semantics", () => {
    const parsed = parseRequestedPolicyRestrictions({ write_scope: ["./src", "src\\parser"] });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(parsed.value.write_scope).toEqual(["src", "src/parser"]);
  });

  it("the project-root prefix '.' is a valid restriction; real file paths are not", () => {
    const root = parseRequestedPolicyRestrictions({ write_scope: ["."] });
    expect(root.kind).toBe("ok");
    if (root.kind === "ok") expect(root.value.write_scope).toEqual(["."]);

    for (const bad of [["/abs"], ["../escape"], ["src/../.."], ["a/./b"], [""]]) {
      const parsed = parseRequestedPolicyRestrictions({ write_scope: bad });
      expect(parsed.kind).toBe("error");
      if (parsed.kind === "error") expect(parsed.code).toBe("INVALID_REQUEST");
    }
  });
});

describe("effective policy narrowing", () => {
  it("narrowed prefixes are normalized and stored with provenance", () => {
    const result = narrow({ requestedRestrictions: { write_scope: ["./src", "src\\parser"] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.policy.access).toBe("workspace_write");
    expect(result.policy.write_scope).toEqual(["src", "src/parser"]);
    expect(result.policy.profile_config).toBe(WRITER_PROFILE);
    expect(result.policy.profile_fingerprint).toBe(sha256Hex(WRITER_PROFILE));
    expect(result.policy.requested_restrictions).toEqual({ write_scope: ["src", "src/parser"] });
    expect(result.policy.binding_version).toBe(1);
  });

  it("component semantics: requested src must not allow src-other; nested narrowing is fine", () => {
    const sibling = narrow({ requestedRestrictions: { write_scope: ["src-other"] } });
    expect(sibling.ok).toBe(false);
    if (!sibling.ok) expect(sibling.code).toBe("INVALID_REQUEST");

    const nested = narrow({ requestedRestrictions: { write_scope: ["src/parser"] } });
    expect(nested.ok).toBe(true);
    if (nested.ok) expect(nested.policy.write_scope).toEqual(["src/parser"]);
  });

  it("access widening is rejected; read_only narrowing implies []", () => {
    const readonlyProfile = JSON.stringify({ access: "read_only" });
    const widening = narrow({ profileConfigJson: readonlyProfile, requestedRestrictions: { access: "workspace_write" } });
    expect(widening.ok).toBe(false);
    if (!widening.ok) expect(widening.code).toBe("INVALID_REQUEST");

    const narrowed = narrow({ profileConfigJson: readonlyProfile, requestedRestrictions: {} });
    expect(narrowed.ok).toBe(true);
    if (narrowed.ok) {
      expect(narrowed.policy.access).toBe("read_only");
      expect(narrowed.policy.write_scope).toEqual([]);
    }
  });

  it("read_only dominates a requested write_scope; [] denies all writes", () => {
    const dominated = narrow({ requestedRestrictions: { access: "read_only", write_scope: ["src"] } });
    expect(dominated.ok).toBe(true);
    if (dominated.ok) expect(dominated.policy.write_scope).toEqual([]);

    const denyAll = narrow({ requestedRestrictions: { write_scope: [] } });
    expect(denyAll.ok).toBe(true);
    if (denyAll.ok) {
      expect(denyAll.policy.access).toBe("workspace_write");
      expect(denyAll.policy.write_scope).toEqual([]);
    }
  });

  it("profile defaults: absent access is workspace_write; absent write_scope grants the whole project", () => {
    const noAccess = narrow({ profileConfigJson: JSON.stringify({ write_scope: ["src"] }), requestedRestrictions: undefined });
    expect(noAccess.ok).toBe(true);
    if (noAccess.ok) expect(noAccess.policy.access).toBe("workspace_write");

    const noScope = narrow({ profileConfigJson: JSON.stringify({ access: "workspace_write" }), requestedRestrictions: undefined });
    expect(noScope.ok).toBe(true);
    if (noScope.ok) {
      expect(noScope.policy.access).toBe("workspace_write");
      expect(noScope.policy.write_scope).toEqual(["."]);
    }

    // read_only without write_scope still permits no writes.
    const readOnly = narrow({ profileConfigJson: JSON.stringify({ access: "read_only" }), requestedRestrictions: undefined });
    expect(readOnly.ok).toBe(true);
    if (readOnly.ok) expect(readOnly.policy.write_scope).toEqual([]);
  });

  it("an explicit scope array stays a deliberate restriction; [] denies writes; '.' narrows only whole-project profiles", () => {
    const explicit = narrow({ requestedRestrictions: undefined });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.policy.write_scope).toEqual(["src", "tests"]);

    const denyAll = narrow({ profileConfigJson: JSON.stringify({ access: "workspace_write" }), requestedRestrictions: { write_scope: [] } });
    expect(denyAll.ok).toBe(true);
    if (denyAll.ok) expect(denyAll.policy.write_scope).toEqual([]);

    // "." covers src/tests, so it is a valid narrowing of the default grant…
    const rootNarrow = narrow({ profileConfigJson: JSON.stringify({ access: "workspace_write" }), requestedRestrictions: { write_scope: ["."] } });
    expect(rootNarrow.ok).toBe(true);
    if (rootNarrow.ok) expect(rootNarrow.policy.write_scope).toEqual(["."]);

    // …but a widening sibling against an explicitly enumerated profile.
    const rootWiden = narrow({ requestedRestrictions: { write_scope: ["."] } });
    expect(rootWiden.ok).toBe(false);
    if (!rootWiden.ok) expect(rootWiden.code).toBe("INVALID_REQUEST");
  });

  it("unreadable profile config fails closed with POLICY_UNSUPPORTED", () => {
    for (const bad of ["not json", "[]", JSON.stringify({ access: "WRITE" }), JSON.stringify({ write_scope: "src" })]) {
      const result = narrow({ profileConfigJson: bad, requestedRestrictions: undefined });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("POLICY_UNSUPPORTED");
    }
  });
});

// ─── spawn admission (§12.1 before session/reservation/dispatch) ─────────────

describe("spawn admission with policy restrictions", () => {
  it("accepted narrowing is bound immutably in the provision intent payload", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["./src"] } });
      expect(spawn.state).toBe("IDLE");
      const payload = provisionPayload(h, spawn.session_id);
      const binding = payload.effective_policy as Record<string, unknown>;
      expect(binding).toBeTruthy();
      expect(binding.access).toBe("workspace_write");
      expect(binding.write_scope).toEqual(["src"]); // normalized
      expect(binding.requested_restrictions).toEqual({ write_scope: ["src"] }); // preserved
      expect(binding.profile_config).toBe(JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests"] }));
      expect(binding.profile_fingerprint).toBe(sha256Hex(binding.profile_config as string));
      expect(payload.request_hash).toBeTruthy();
      expect(payload.instructions).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it("sessions WITHOUT restrictions also get an immutable binding", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const binding = provisionPayload(h, spawn.session_id).effective_policy as Record<string, unknown>;
      expect(binding.access).toBe("workspace_write");
      expect(binding.write_scope).toEqual(["src", "tests"]);
      expect(binding.requested_restrictions).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("access/scope widening is rejected before any session or reservation exists", async () => {
    const h = createHarness();
    try {
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-readonly",
        version: "1",
        config: JSON.stringify({ access: "read_only", write_scope: ["src"] }),
      });
      const before = brokerCounts(h);
      await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ policy_profile_id: "pol-readonly", policy_restrictions: { access: "workspace_write" } }),
        "INVALID_REQUEST",
      );
      await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src-other"] } }),
        "INVALID_REQUEST",
      );
      await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ policy_restrictions: { write_scope: ["docs"] } }),
        "INVALID_REQUEST",
      );
      expect(brokerCounts(h)).toEqual(before); // zero sessions/reservations/ledger entries
    } finally {
      h.cleanup();
    }
  });

  it("unknown/malformed restrictions: POLICY_UNSUPPORTED or INVALID_REQUEST, no accepted state, key stays free", async () => {
    const h = createHarness();
    try {
      const before = brokerCounts(h);
      for (const [restriction, code] of [
        [{ sandbox: "none" }, "POLICY_UNSUPPORTED"],
        [{ access: "workspace-write" }, "INVALID_REQUEST"],
        [{ write_scope: ["../x"] }, "INVALID_REQUEST"],
        ["read_only", "INVALID_REQUEST"],
      ] as const) {
        const error = await expectBrokerErrorAsync(() => h.spawnWorkerSession({ policy_restrictions: restriction }), code);
        expect(error.executionStarted).toBe(false);
      }
      expect(brokerCounts(h)).toEqual(before);
      const events = h.db.raw.prepare("SELECT COUNT(*) c FROM events WHERE type='session_spawned'").get() as { c: number };
      expect(events.c).toBe(0);

      // The rejection is mutable: the same key is reusable for a valid spawn.
      const retry = await h.spawnWorkerSession({ idempotency_key: "spawn-retry", policy_restrictions: { write_scope: ["src"] } });
      expect(retry.state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });

  it("same idempotency key with different restrictions is an IDEMPOTENCY_CONFLICT", async () => {
    const h = createHarness();
    try {
      const first = await h.spawnWorkerSession({ idempotency_key: "spawn-key-1", policy_restrictions: { write_scope: ["src"] } });
      const replay = await h.spawnWorkerSession({ idempotency_key: "spawn-key-1", policy_restrictions: { write_scope: ["src"] } });
      expect(replay.session_id).toBe(first.session_id);
      expect(replay.replayed_request).toBe(true);
      // The conflict is decided against the committed ledger record before
      // any policy work; spawnWorkerSession is async, so await the rejection.
      await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "spawn-key-1", policy_restrictions: { write_scope: ["tests"] } }),
        "IDEMPOTENCY_CONFLICT",
      );
      const sessions = h.db.raw.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number };
      expect(sessions.c).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});

// ─── scope enforcement reads the SAME effective policy ──────────────────────

describe("effective scope enforcement", () => {
  it("accepted narrowed writes succeed and are sealed", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });
      const turn = await runWriteTurn(h, spawn.session_id, "t-ok", [{ path: "src/impl.c", content: "int impl;\n" }]);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.error_code).toBeNull();
      expect(turn.final_snapshot_id).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it("out-of-scope source writes fail the turn with SCOPE_VIOLATION", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });
      const turn = await runWriteTurn(h, spawn.session_id, "t-scope", [{ path: "tests/new_test.c", content: "int t;\n" }]);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
      expect(turn.finalization_error).toContain("SCOPE_VIOLATION");
      expect(turn.final_snapshot_id).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("read_only denies every source write but allows clean completion", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { access: "read_only" } });
      const binding = provisionPayload(h, spawn.session_id).effective_policy as Record<string, unknown>;
      expect(binding.access).toBe("read_only");
      expect(binding.write_scope).toEqual([]);

      const denied = await runWriteTurn(h, spawn.session_id, "t-ro-1", [{ path: "src/impl.c", content: "int impl;\n" }]);
      expect(denied.state).toBe("FAILED");
      expect(denied.error_code).toBe("SCOPE_VIOLATION");

      // A fresh read_only session (the denied turn's writes stay on disk):
      // completing without writes must succeed under the empty scope.
      const cleanSession = await h.spawnWorkerSession({ policy_restrictions: { access: "read_only" } });
      const clean = await runCleanTurn(h, cleanSession.session_id, "t-ro-2");
      expect(clean.state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("sessionWriteScope reflects the binding: narrowed, read_only, legacy, malformed", async () => {
    const h = createHarness();
    try {
      const narrowed = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });
      const s1 = h.core.sessionStatus(h.seed.coordinatorId, narrowed.session_id);
      expect(sessionWriteScope(h.db, s1)).toEqual({ kind: "declared", prefixes: ["src"] });

      const readonlySession = await h.spawnWorkerSession({ policy_restrictions: { access: "read_only" } });
      const s2 = h.core.sessionStatus(h.seed.coordinatorId, readonlySession.session_id);
      expect(sessionWriteScope(h.db, s2)).toEqual({ kind: "declared", prefixes: [] });

      const legacy = await h.spawnWorkerSession();
      stripEffectivePolicy(h, legacy.session_id);
      const s3 = h.core.sessionStatus(h.seed.coordinatorId, legacy.session_id);
      expect(sessionWriteScope(h.db, s3).kind).toBe("invalid");

      const malformed = await h.spawnWorkerSession();
      rewriteProvisionPayload(h, malformed.session_id, (p) => {
        const binding = p.effective_policy as Record<string, unknown>;
        binding.write_scope = ["src", "tests", "everything"]; // widened beyond the derivation
      });
      const s4 = h.core.sessionStatus(h.seed.coordinatorId, malformed.session_id);
      const scope = sessionWriteScope(h.db, s4);
      expect(scope.kind).toBe("invalid");
    } finally {
      h.cleanup();
    }
  });
});

// ─── whole-project default grant (operator rule) ────────────────────────────

const ROOT_COVERAGE = { source_prefixes: ["."], non_source_prefixes: [], excluded_prefixes: [".git", "node_modules", ".state"] };

/** Seed a root coverage profile, a scope-less worker policy and its workspace. */
function seedRootGrant(h: Harness): void {
  insertCoverageProfile(h.db, {
    coverage_profile_id: "cov-root",
    version: "1",
    config: JSON.stringify(ROOT_COVERAGE),
    contract_hash: coverageContractHash(ROOT_COVERAGE),
  });
  insertPolicyProfile(h.db, {
    policy_profile_id: "pol-root",
    version: "1",
    config: JSON.stringify({ access: "workspace_write" }),
  });
  insertWorkspace(h.db, {
    workspace_id: "ws-root",
    project_id: h.seed.projectId,
    mode: "current",
    canonical_path: h.workspaceRoot,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: "cov-root",
  });
}

describe("whole-project default grant", () => {
  it("end-to-end: a scope-less worker creates a previously undeclared root test/doc directory and root file", async () => {
    const h = createHarness();
    try {
      seedRootGrant(h);
      const spawn = await h.spawnWorkerSession({
        policy_profile_id: "pol-root",
        workspace: { mode: "current", workspace_id: "ws-root" },
      });
      const binding = provisionPayload(h, spawn.session_id).effective_policy as Record<string, unknown>;
      expect(binding.binding_version).toBe(1);
      expect(binding.access).toBe("workspace_write");
      expect(binding.write_scope).toEqual(["."]); // whole project, no explicit list

      const turn = await runWriteTurn(h, spawn.session_id, "t-root-new", [
        { path: "test-docs/new-root-note.md", content: "# new root directory\n" },
        { path: "NEW_ROOT.md", content: "root file created by the worker\n" },
      ]);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.error_code).toBeNull();
      expect(turn.final_snapshot_id).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });

  it("excluded subtrees stay protected under the whole-project grant", async () => {
    const h = createHarness();
    try {
      seedRootGrant(h);
      const spawn = await h.spawnWorkerSession({
        policy_profile_id: "pol-root",
        workspace: { mode: "current", workspace_id: "ws-root" },
      });
      const turn = await runWriteTurn(h, spawn.session_id, "t-root-excluded", [
        { path: "node_modules/loose-cache.js", content: "cached\n" },
      ]);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
    } finally {
      h.cleanup();
    }
  });

  it("a read_only worker write is still refused", async () => {
    const h = createHarness();
    try {
      seedRootGrant(h);
      const spawn = await h.spawnWorkerSession({
        policy_profile_id: "pol-root",
        workspace: { mode: "current", workspace_id: "ws-root" },
        policy_restrictions: { access: "read_only" },
      });
      const binding = provisionPayload(h, spawn.session_id).effective_policy as Record<string, unknown>;
      expect(binding.write_scope).toEqual([]);
      const turn = await runWriteTurn(h, spawn.session_id, "t-root-readonly", [
        { path: "test-docs/forbidden.md", content: "denied\n" },
      ]);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
      expect(turn.final_snapshot_id).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("whole-project scope requires root coverage admission (narrowing and coverage agree)", async () => {
    const h = createHarness();
    try {
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-root",
        version: "1",
        config: JSON.stringify({ access: "workspace_write" }),
      });
      // Seeded workspace coverage covers src/tests only — the default grant
      // is not admissible there, before any turn is accepted.
      const spawn = await h.spawnWorkerSession({ policy_profile_id: "pol-root" });
      const before = brokerCounts(h);
      expectBrokerError(() => h.sendTask(spawn.session_id, "t-uncovered"), "SNAPSHOT_COVERAGE_MISMATCH");
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });

  it("an unsupported binding schema fails closed", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      rewriteProvisionPayload(h, session.session_id, (p) => {
        (p.effective_policy as Record<string, unknown>).binding_version = 99;
      });
      const before = brokerCounts(h);
      expectBrokerError(() => h.sendTask(session.session_id, "t-v1-binding"), "POLICY_UNSUPPORTED");
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });
});

// ─── durable binding: config drift + reconstruction ─────────────────────────

describe("durable binding across drift and reconstruction", () => {
  it("operator widening of the same-version config does not widen a bound session", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });
      // Operator edits the SAME profile version to a wider scope.
      h.db.raw
        .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
        .run(JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests", "docs"] }));

      const turn = await runWriteTurn(h, spawn.session_id, "t-drift", [{ path: "tests/new_test.c", content: "int t;\n" }]);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
    } finally {
      h.cleanup();
    }
  });

  it("operator narrowing of the same-version config does not narrow an already-bound session", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession(); // bound to ["src","tests"] at spawn
      h.db.raw
        .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
        .run(JSON.stringify({ access: "workspace_write", write_scope: ["src"] }));

      const turn = await runWriteTurn(h, spawn.session_id, "t-narrow", [{ path: "tests/new_test.c", content: "int t;\n" }]);
      expect(turn.state).toBe("SUCCEEDED"); // spawn-time grant stands
    } finally {
      h.cleanup();
    }
  });

  it("a reconstructed core/executor enforces the same binding", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });

      const reconstructedCore = new BrokerCore({
        db: h.db,
        clock: h.clock,
        limits: h.limits,
        adapters: new Map([["mock", h.adapter]]),
        deferExecution: true,
        blobStore: openBlobStore(h.blobRoot),
      });
      const reconstructedExecutor = new TurnExecutor({
        db: h.db,
        clock: h.clock,
        limits: h.limits,
        adapters: new Map([["mock", h.adapter]]),
        blobs: openBlobStore(h.blobRoot),
      });
      reconstructedCore.attachExecutor(reconstructedExecutor);

      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      const resp = reconstructedCore.send(h.seed.coordinatorId, {
        session_id: spawn.session_id,
        idempotency_key: "t-reconstructed",
        task: { goal: "Implement the parser.", acceptance_criteria: ["Tests pass."], artifact_refs: [] },
        workspace_precondition: { expected_snapshot_id: session.latest_snapshot_id ?? session.initial_snapshot_id! },
      });
      // The shared mock adapter is registered on both executors.
      h.adapter.plan(resp.turn_id, [
        { kind: "workspace_write", files: [{ path: "tests/new_test.c", content: "int t;\n" }] },
        { kind: "complete", outcome: "completed", summary: "done" },
      ]);
      reconstructedExecutor.startTurn(resp.turn_id);
      await h.executor.waitTurn(resp.turn_id).then(() => reconstructedExecutor.drain());

      const turn = h.core.turnStatus(h.seed.coordinatorId, resp.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
    } finally {
      h.cleanup();
    }
  });
});

// ─── legacy journals and malformed bindings ─────────────────────────────────

describe("legacy sessions and fail-closed bindings", () => {
  it("rejects an unreadable provision payload rather than falling back to the live profile", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession({ policy_restrictions: { write_scope: [] } });
      h.db.raw.prepare("UPDATE intents SET payload=? WHERE kind='provision_session' AND session_id=?").run("{", session.session_id);
      const before = brokerCounts(h);
      expectBrokerError(() => h.sendTask(session.session_id, "bad-json"), "POLICY_UNSUPPORTED");
      expect(brokerCounts(h)).toEqual(before);
    } finally { h.cleanup(); }
  });

  it("revalidates policy after send admission and before reviewer input delivery", async () => {
    const h = createHarness();
    try {
      const worker = await h.spawnWorkerSession();
      insertWorkspace(h.db, { workspace_id: "ws-review", project_id: h.seed.projectId, mode: "review_slot", canonical_path: null, quarantined: false, quarantine_reason: null, coverage_profile_id: h.seed.coverageProfileId });
      const reviewer = await h.spawnWorkerSession({ role: "reviewer", workspace: { mode: "review_slot", workspace_id: "ws-review" }, policy_restrictions: { access: "read_only" } });
      const sent = h.sendTask(reviewer.session_id, "review-corrupt", "Review source", { review_binding: { baseline_snapshot_id: worker.initial_snapshot_id!, target_snapshot_id: worker.initial_snapshot_id! } });
      stripEffectivePolicy(h, reviewer.session_id);
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("POLICY_UNSUPPORTED");
      expect(turn.execution_started).toBe(false);
      expect(turn.input_manifest_id).toBeNull();
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
    } finally { h.cleanup(); }
  });

  it("revalidates the grant inside dispatch permission when an adapter delays handoff", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      const sent = h.sendTask(session.session_id, "gate-corrupt");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      const execute = h.adapter.executeTurn.bind(h.adapter);
      h.adapter.executeTurn = async (req, gate, onEvent) => {
        rewriteProvisionPayload(h, session.session_id, (p) => { p.effective_policy = null; });
        return execute(req, gate, onEvent);
      };
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("POLICY_UNSUPPORTED");
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBe(false);
    } finally { h.cleanup(); }
  });

  it("legacy journal cannot reconstruct historical restrictions from a live profile", async () => {
    const h = createHarness();
    try {
      const legacyA = await h.spawnWorkerSession();
      stripEffectivePolicy(h, legacyA.session_id);
      const before = brokerCounts(h);
      expectBrokerError(() => h.sendTask(legacyA.session_id, "t-legacy-1"), "POLICY_UNSUPPORTED");
      expect(brokerCounts(h)).toEqual(before);

      // Changing the live profile cannot recover the historical grant.
      h.db.raw
        .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
        .run(JSON.stringify({ access: "workspace_write", write_scope: ["src"] }));
      const legacyB = await h.spawnWorkerSession();
      stripEffectivePolicy(h, legacyB.session_id);
      expectBrokerError(() => h.sendTask(legacyB.session_id, "t-legacy-2"), "POLICY_UNSUPPORTED");
    } finally {
      h.cleanup();
    }
  });

  it("a present-but-malformed binding fails closed before dispatch", async () => {
    const h = createHarness();
    try {
      const tampered = await h.spawnWorkerSession();
      rewriteProvisionPayload(h, tampered.session_id, (p) => {
        (p.effective_policy as Record<string, unknown>).write_scope = ["src", "tests", "everything"];
      });
      const before = brokerCounts(h);
      expectBrokerError(() => h.sendTask(tampered.session_id, "t-tampered"), "POLICY_UNSUPPORTED");
      expect(brokerCounts(h)).toEqual(before); // no turn accepted, zero dispatch

      const fingerprint = await h.spawnWorkerSession();
      rewriteProvisionPayload(h, fingerprint.session_id, (p) => {
        (p.effective_policy as Record<string, unknown>).profile_fingerprint = sha256Hex("other-config");
      });
      expectBrokerError(() => h.sendTask(fingerprint.session_id, "t-fingerprint"), "POLICY_UNSUPPORTED");
    } finally {
      h.cleanup();
    }
  });
});
