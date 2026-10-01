/**
 * Core provider preflight and policy handoff (spec §7.2, §12.1, §13.2/§13.3).
 *
 * Covered here:
 * - spawn calls adapter.preflight (no inference) with the bounded context
 *   (model, effort, role, workspace_mode, account binding, immutable
 *   effective policy) OUTSIDE the authoritative transaction,
 * - account validation: unregistered / provider-mismatched accounts create
 *   no accepted state and leave the key free,
 * - failed preflight ⇒ zero accepted state/dispatch, executionStarted=false,
 *   corrected same-key retry admitted; unexpected failure ⇒ PROVIDER_INCOMPATIBLE,
 * - accepted same-key replay never re-runs readiness; same-key payload
 *   conflict outranks a (now failing) preflight,
 * - config/adapter-version drift between preflight and the authoritative tx
 *   is refused via the pure candidate fingerprint (no stale admission),
 * - the persisted spawn-time policy is passed unchanged (and frozen) into
 *   execute even after live profile edits,
 * - read_only_input_paths equal the sealed manifest's materialized bindings,
 * - artifact corruption fails before dispatch.
 * All mock-level, no inference, no native CLIs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, start, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../src/runtime/adapter.ts";
import { insertAccount } from "../../src/storage/repo.ts";

/** Recording wrapper around the harness mock; injects preflight outcomes. */
class SpyAdapter implements ProviderAdapter {
  readonly preflightCalls: Array<Record<string, unknown>> = [];
  readonly executeRequests: TurnExecutionRequest[] = [];
  /** Existence of each read_only_input_path sampled at dispatch time. */
  readonly executePathChecks: Array<boolean[]> = [];
  preflightError: unknown = null;
  onPreflight: (() => void) | null = null;
  versionOverride: string | null = null;

  constructor(private readonly inner: ProviderAdapter) {}

  get providerId(): string {
    return this.inner.providerId;
  }

  get adapterVersion(): string {
    return this.versionOverride ?? this.inner.adapterVersion;
  }

  preflight(config: Record<string, unknown>): void {
    this.preflightCalls.push(config);
    this.onPreflight?.();
    if (this.preflightError !== null) throw this.preflightError;
  }

  executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    this.executeRequests.push(req);
    this.executePathChecks.push([...(req.read_only_input_paths ?? [])].map((p) => existsSync(p)));
    return this.inner.executeTurn(req, gate, onEvent);
  }

  shutdownIdleRuntime(sessionId: string): Promise<void> {
    return this.inner.shutdownIdleRuntime(sessionId);
  }

  inspectRuntime(sessionId: string): RuntimeObservation | null {
    return this.inner.inspectRuntime(sessionId);
  }

  interruptTurn(turnId: string): Promise<boolean> {
    return this.inner.interruptTurn(turnId);
  }
}

/** Swap the shared adapters map entry (core and executor hold the same Map). */
function installSpy(h: Harness): SpyAdapter {
  const spy = new SpyAdapter(h.adapter);
  h.core.adapters.set("mock", spy);
  return spy;
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

function brokerCounts(h: Harness): { sessions: number; turns: number; idempotency: number } {
  const one = (sql: string): number => (h.db.raw.prepare(sql).get() as { c: number }).c;
  return {
    sessions: one("SELECT COUNT(*) c FROM sessions"),
    turns: one("SELECT COUNT(*) c FROM turns"),
    idempotency: one("SELECT COUNT(*) c FROM idempotency_records"),
  };
}

function provisionPayload(h: Harness, sessionId: string): Record<string, unknown> {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=?")
    .get(sessionId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

// ─── preflight context and session binding (§13.2, §13.3) ────────────────────

describe("spawn provider preflight", () => {
  it("passes the bounded context to preflight and binds adapter version + registered auth_mode", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const spawn = await h.spawnWorkerSession();
      expect(spawn.state).toBe("IDLE");
      expect(spy.preflightCalls).toHaveLength(1);
      const ctx = spy.preflightCalls[0]!;
      expect(ctx.provider).toBe("mock");
      expect(ctx.model).toBe("mock-model-1");
      expect(ctx.effort).toBeNull();
      expect(ctx.role).toBe("worker");
      expect(ctx.workspace_mode).toBe("current");
      expect(ctx.account).toEqual({
        account_profile_id: h.seed.accountMock1,
        auth_mode: "native",
        quota_scope_id: "qs-shared",
      });
      const policy = ctx.effective_policy as Record<string, unknown>;
      expect(policy.access).toBe("workspace_write");
      expect(policy.write_scope).toEqual(["src", "tests"]);

      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.adapter_version).toBe("0.1.0");
      expect(session.auth_mode).toBe("native");
      // Never fabricated from requested values before real native evidence:
      expect(session.cli_version).toBeNull();
      expect(session.effective_model).toBeNull();
      expect(session.effective_effort).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  it("unsupported mandatory policy restriction propagates before the adapter preflight runs", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const before = brokerCounts(h);
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "pf-restrict", policy_restrictions: { sandbox: "none" } }),
        "POLICY_UNSUPPORTED",
      );
      expect(err.executionStarted).toBe(false);
      expect(spy.preflightCalls).toHaveLength(0); // policy decision precedes adapter readiness
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });
});

// ─── preflight failure handling (no accepted state, no dispatch) ──────────────

describe("preflight failure handling", () => {
  it("BrokerError preflight failure: zero accepted state, executionStarted false, corrected same-key retry admitted", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const before = brokerCounts(h);
      spy.preflightError = new BrokerError("AUTH_REQUIRED", "mock CLI not authenticated", { phase: "cli-readiness", executionStarted: true });
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "pf-fail" }),
        "AUTH_REQUIRED",
      );
      expect(err.message).toBe("mock CLI not authenticated");
      expect(err.phase).toBe("cli-readiness");
      expect(err.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before); // no ledger/session/reservation rows
      const events = h.db.raw.prepare("SELECT COUNT(*) c FROM events WHERE type='session_spawned'").get() as { c: number };
      expect(events.c).toBe(0);
      expect(spy.executeRequests).toHaveLength(0);

      spy.preflightError = null;
      const retry = await h.spawnWorkerSession({ idempotency_key: "pf-fail" });
      expect(retry.state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });

  it.each([new Error("probe crashed"), Object.assign(new Error("probe crashed"), { name: "BrokerError" })])("unexpected preflight failure becomes PROVIDER_INCOMPATIBLE with executionStarted false: %s", async (failure) => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const before = brokerCounts(h);
      spy.preflightError = failure;
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "pf-crash" }),
        "PROVIDER_INCOMPATIBLE",
      );
      expect(err.message).toContain("probe crashed");
      expect(err.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });

  it("unregistered account and provider-mismatched account are rejected before any session", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const before = brokerCounts(h);
      const ghost = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "acct-ghost", account_profile_id: "acct-ghost" }),
        "INVALID_REQUEST",
      );
      expect(ghost.executionStarted).toBe(false);
      expect(spy.preflightCalls).toHaveLength(0);

      insertAccount(h.db, {
        account_profile_id: "acct-other-provider",
        provider: "claude-code",
        quota_scope_id: "qs-other",
        auth_mode: "api-key",
      });
      const mismatch = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "acct-mismatch", account_profile_id: "acct-other-provider" }),
        "PROVIDER_INCOMPATIBLE",
      );
      expect(mismatch.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);

      // Keys stay free: a corrected retry under the registered account works.
      const fixed = await h.spawnWorkerSession({ idempotency_key: "acct-ghost" });
      expect(fixed.state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });
});

// ─── idempotent replay ordering (§7.2) ────────────────────────────────────────

describe("replay ordering with preflight", () => {
  it("accepted same-key replay never re-runs readiness", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const first = await h.spawnWorkerSession({ idempotency_key: "replay-key" });
      spy.preflightCalls.length = 0;
      spy.preflightError = new BrokerError("AUTH_REQUIRED", "cli vanished after acceptance");
      const replay = await h.spawnWorkerSession({ idempotency_key: "replay-key" });
      expect(replay.replayed_request).toBe(true);
      expect(replay.session_id).toBe(first.session_id);
      expect(replay.state).toBe("IDLE");
      expect(spy.preflightCalls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("same-key payload conflict outranks a failing preflight", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const first = await h.spawnWorkerSession({ idempotency_key: "conflict-key" });
      spy.preflightError = new BrokerError("AUTH_REQUIRED", "cli vanished");
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "conflict-key", instructions: "Different instructions." }),
        "IDEMPOTENCY_CONFLICT",
      );
      expect(err.message).toContain("different payload");
      expect(first.session_id).toBeTruthy();
    } finally {
      h.cleanup();
    }
  });
});

// ─── authoritative revalidation of the preflight candidate (§7.2) ─────────────

describe("config drift revalidation", () => {
  it("refuses an adapter replacement even when its version is unchanged", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      spy.onPreflight = () => h.core.adapters.set("mock", new SpyAdapter(h.adapter));
      const before = brokerCounts(h);
      const error = await expectBrokerErrorAsync(() => h.spawnWorkerSession({ idempotency_key: "adapter-replacement" }), "PROVIDER_INCOMPATIBLE");
      expect(error.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);
    } finally { h.cleanup(); }
  });

  it("blocks mutation of nested requested restrictions before accepted state", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      spy.onPreflight = () => {
        const policy = spy.preflightCalls[0]!.effective_policy as NonNullable<TurnExecutionRequest["effective_policy"]>;
        (policy.requested_restrictions!.write_scope as string[]).push("docs");
      };
      const before = brokerCounts(h);
      const request = { idempotency_key: "nested-policy-mutation", policy_restrictions: { write_scope: ["src"] } };
      const error = await expectBrokerErrorAsync(() => h.spawnWorkerSession(request), "PROVIDER_INCOMPATIBLE");
      expect(error.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);
      spy.onPreflight = null;
      const accepted = await h.spawnWorkerSession(request);
      expect(accepted.state).toBe("IDLE");
      const policy = provisionPayload(h, accepted.session_id).effective_policy as Record<string, unknown>;
      expect(policy.requested_restrictions).toEqual({ write_scope: ["src"] });
    } finally { h.cleanup(); }
  });

  it("policy profile drift during preflight is refused instead of admitted", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      spy.onPreflight = () => {
        h.db.raw
          .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
          .run(JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests", "docs"] }));
      };
      const before = brokerCounts(h);
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "drift-policy" }),
        "POLICY_UNSUPPORTED",
      );
      expect(err.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });

  it("account binding drift during preflight is refused instead of admitted", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      spy.onPreflight = () => {
        h.db.raw
          .prepare("UPDATE account_profiles SET auth_mode='api-key' WHERE account_profile_id=?")
          .run(h.seed.accountMock1);
      };
      const before = brokerCounts(h);
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "drift-account" }),
        "POLICY_UNSUPPORTED",
      );
      expect(err.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);
    } finally {
      h.cleanup();
    }
  });

  it("adapter version drift during preflight refuses admission; the bound version rejects later drift", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      spy.onPreflight = () => {
        spy.versionOverride = "9.9.9";
      };
      const before = brokerCounts(h);
      const err = await expectBrokerErrorAsync(
        () => h.spawnWorkerSession({ idempotency_key: "ver-drift" }),
        "PROVIDER_INCOMPATIBLE",
      );
      expect(err.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);

      // An accepted session records the observed version and send revalidates it.
      spy.onPreflight = null;
      spy.versionOverride = null;
      const spawn = await h.spawnWorkerSession({ idempotency_key: "ver-bound" });
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.adapter_version).toBe("0.1.0");
      h.db.raw
        .prepare("UPDATE sessions SET adapter_version='0.0.9-old' WHERE session_id=?")
        .run(spawn.session_id);
      expectBrokerError(() => h.sendTask(spawn.session_id, "ver-drift-send"), "PROVIDER_INCOMPATIBLE");
    } finally {
      h.cleanup();
    }
  });
});

// ─── policy handoff into execute (§12.1, §13.2.1) ────────────────────────────

describe("policy handoff into execute", () => {
  it("persisted spawn-time policy reaches execute unchanged despite later live profile edits", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const spawn = await h.spawnWorkerSession({ policy_restrictions: { write_scope: ["src"] } });
      const binding = provisionPayload(h, spawn.session_id).effective_policy as Record<string, unknown>;

      h.db.raw
        .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
        .run(JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests", "docs"] }));

      const sent = h.sendTask(spawn.session_id, "policy-handoff");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id).state).toBe("SUCCEEDED");

      expect(spy.executeRequests).toHaveLength(1);
      const policy = spy.executeRequests[0]!.effective_policy!;
      expect(policy.access).toBe("workspace_write");
      expect(policy.write_scope).toEqual(["src"]);
      expect(policy.profile_config).toBe(binding.profile_config);
      expect(policy.profile_fingerprint).toBe(binding.profile_fingerprint);
      expect(policy.profile_fingerprint).toBe(sha256Hex(policy.profile_config));
      expect(policy.requested_restrictions).toEqual({ write_scope: ["src"] });
      // Frozen copies: adapters cannot mutate the durable grant.
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.write_scope)).toBe(true);
      expect(Object.isFrozen(policy.requested_restrictions!.write_scope)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("read_only_input_paths are exactly the sealed manifest's materialized bindings", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const spawn = await h.spawnWorkerSession();
      const big = h.publishArtifact("x".repeat(17 * 1024)); // above the inline cap
      const sent = h.sendTask(spawn.session_id, "ro-paths", "Consume the artifact.", {
        task: { goal: "Consume the artifact.", acceptance_criteria: ["done"], artifact_refs: [big.artifact_id] },
      });
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.input_manifest_id).toBeTruthy();

      const page = h.core.artifactRead(h.seed.coordinatorId, turn.input_manifest_id!);
      const manifest = JSON.parse(page.data!) as { inputs: Array<{ delivery: string; binding: string }> };
      const expected = manifest.inputs
        .filter((i) => i.delivery === "read_only_path")
        .map((i) => i.binding);
      expect(expected.length).toBeGreaterThan(0);

      const req = spy.executeRequests[0]!;
      expect([...(req.read_only_input_paths ?? [])]).toEqual(expected);
      expect(Object.isFrozen(req.read_only_input_paths)).toBe(true);
      // The views are broker-materialized and present during dispatch; they
      // are cleaned up only after the terminal commit (§7.1.1 lifetime).
      expect(spy.executePathChecks[0]!.every(Boolean)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("artifact corruption fails before execute with zero dispatch", async () => {
    const h = createHarness();
    try {
      installSpy(h);
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("deterministic content\n");
      const sent = h.sendTask(spawn.session_id, "corrupt", "Consume the artifact.", {
        task: { goal: "Consume the artifact.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      // Corrupt the sealed blob AFTER acceptance, BEFORE dispatch.
      const blobPath = path.join(h.blobRoot, h.seed.projectId, art.content_hash.slice(0, 2), art.content_hash);
      writeFileSync(blobPath, "tampered bytes\n", "utf8");
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("ARTIFACT_CORRUPT");
      expect(turn.execution_started).toBe(false);
      expect(turn.input_manifest_id).toBeNull();
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
