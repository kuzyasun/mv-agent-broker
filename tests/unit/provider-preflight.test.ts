/**
 * Dispatch-time provider checks and immutable access handoff.
 * All cases use the mock adapter; no native CLI or inference is invoked.
 */
import { describe, expect, it } from "vitest";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, start, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../src/runtime/adapter.ts";
import { insertAccount } from "../../src/storage/repo.ts";

class SpyAdapter implements ProviderAdapter {
  readonly preflightCalls: Array<Record<string, unknown>> = [];
  readonly executeRequests: TurnExecutionRequest[] = [];
  readonly executePathChecks: Array<boolean[]> = [];
  preflightError: BrokerError | null = null;
  versionOverride: string | null = null;

  constructor(private readonly inner: ProviderAdapter) {}

  get providerId(): string { return this.inner.providerId; }
  get adapterVersion(): string { return this.versionOverride ?? this.inner.adapterVersion; }

  preflight(config: Record<string, unknown>): void {
    this.preflightCalls.push(config);
    if (this.preflightError) throw this.preflightError;
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

  shutdownIdleRuntime(sessionId: string): Promise<void> { return this.inner.shutdownIdleRuntime(sessionId); }
  inspectRuntime(sessionId: string): RuntimeObservation | null { return this.inner.inspectRuntime(sessionId); }
  interruptTurn(turnId: string): Promise<boolean> { return this.inner.interruptTurn(turnId); }
}

function installSpy(h: Harness): SpyAdapter {
  const spy = new SpyAdapter(h.adapter);
  h.core.adapters.set("mock", spy);
  return spy;
}

function sessionCount(h: Harness): number {
  return (h.db.raw.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c;
}

describe("dispatch provider preflight", () => {
  it("spawns without probing, then checks the selected route exactly once at dispatch", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const session = await h.spawnWorkerSession({ effort: "high" });
      expect(session.state).toBe("IDLE");
      expect(spy.preflightCalls).toHaveLength(0);

      const turn = h.sendTask(session.session_id, "dispatch-preflight");
      expect(spy.preflightCalls).toHaveLength(0);
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, turn);
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe("SUCCEEDED");
      expect(spy.preflightCalls).toHaveLength(1);
      expect(spy.preflightCalls[0]).toMatchObject({
        provider: "mock",
        model: "mock-model-1",
        effort: "high",
        role: "worker",
        workspace_mode: "current",
        account: {
          account_profile_id: h.seed.accountMock1,
          auth_mode: "native",
          quota_scope_id: "qs-shared",
        },
        effective_policy: { access: "workspace_write", write_scope: ["."] },
      });
      expect(spy.executeRequests).toHaveLength(1);
    } finally {
      h.cleanup();
    }
  });

  it("uses the current adapter version and captured access without rejecting idle-session drift", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const session = await h.spawnWorkerSession();
      expect(spy.preflightCalls).toHaveLength(0);

      // Version and live profile changes affect later observations/new sessions;
      // this session keeps its captured permission and is checked at dispatch.
      spy.versionOverride = "9.9.9";
      h.db.raw
        .prepare("UPDATE policy_profiles SET config=? WHERE policy_profile_id='pol-writer' AND version='1'")
        .run(JSON.stringify({ access: "read_only" }));
      const turn = h.sendTask(session.session_id, "version-drift");
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, turn);
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe("SUCCEEDED");
      expect(spy.preflightCalls).toHaveLength(1);
      expect((spy.preflightCalls[0]!.effective_policy as Record<string, unknown>).access).toBe("workspace_write");
      expect(h.core.sessionStatus(h.seed.coordinatorId, session.session_id).state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });

  it.each([
    ["AUTH_REQUIRED", "mock CLI is not authenticated"],
    ["MODEL_UNAVAILABLE", "selected model is not in the current catalog"],
  ] as const)("blocks inference for current dispatch error %s", async (code, message) => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const session = await h.spawnWorkerSession();
      expect(spy.preflightCalls).toHaveLength(0);
      spy.preflightError = new BrokerError(code, message, { executionStarted: false });
      const turn = h.sendTask(session.session_id, `dispatch-${code}`);
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, turn);
      await settle(h);

      expect(spy.preflightCalls).toHaveLength(1);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({
        state: "FAILED",
        execution_started: false,
        error_code: code,
      });
      expect(h.adapter.dispatchPermissionAcquired(turn.turn_id)).toBe(false);
      expect(h.adapter.executedSteps(turn.turn_id)).toContain("dispatch_refused");
    } finally {
      h.cleanup();
    }
  });

  it("rejects an unregistered or provider-mismatched account before creating a session", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const before = sessionCount(h);
      await expect(h.spawnWorkerSession({ idempotency_key: "acct-ghost", account_profile_id: "acct-ghost" }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", executionStarted: false });

      insertAccount(h.db, {
        account_profile_id: "acct-other-provider",
        provider: "claude-code",
        quota_scope_id: "qs-other",
        auth_mode: "cli-owned",
      });
      await expect(h.spawnWorkerSession({ idempotency_key: "acct-mismatch", account_profile_id: "acct-other-provider" }))
        .rejects.toMatchObject({ code: "PROVIDER_INCOMPATIBLE", executionStarted: false });
      expect(sessionCount(h)).toBe(before);
      expect(spy.preflightCalls).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  it("does not run provider preflight when cancellation wins before dispatch", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const session = await h.spawnWorkerSession();
      const turn = h.sendTask(session.session_id, "cancel-before-dispatch");
      const cancelled = h.core.cancel(h.seed.coordinatorId, {
        turn_id: turn.turn_id,
        idempotency_key: "cancel-before-dispatch",
        reason: "cancel before native dispatch",
      });
      expect(cancelled.state).toBe("CANCELLING");

      await start(h, turn);
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({
        state: "CANCELLED",
        execution_started: false,
      });
      expect(spy.preflightCalls).toHaveLength(0);
      expect(h.adapter.dispatchPermissionAcquired(turn.turn_id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("task input delivery", () => {
  it("sets read-only input paths to the sealed manifest bindings", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h);
      const session = await h.spawnWorkerSession();
      const artifact = h.publishArtifact("x".repeat(17 * 1024));
      const turn = h.sendTask(session.session_id, "read-only-paths", "Consume the artifact.", {
        task: { goal: "Consume the artifact.", acceptance_criteria: ["done"], artifact_refs: [artifact.artifact_id] },
      });
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, turn);
      await settle(h);

      const status = h.core.turnStatus(h.seed.coordinatorId, turn.turn_id);
      expect(status.state).toBe("SUCCEEDED");
      expect(status.input_manifest_id).toBeTruthy();
      const page = h.core.artifactRead(h.seed.coordinatorId, status.input_manifest_id!);
      const manifest = JSON.parse(page.data!) as { inputs: Array<{ delivery: string; binding: string }> };
      const expected = manifest.inputs.filter((input) => input.delivery === "read_only_path").map((input) => input.binding);
      expect(expected.length).toBeGreaterThan(0);
      expect([...spy.executeRequests[0]!.read_only_input_paths!]).toEqual(expected);
      expect(spy.executePathChecks[0]!.every(Boolean)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("fails before dispatch when a required artifact is corrupt", async () => {
    const h = createHarness();
    try {
      installSpy(h);
      const session = await h.spawnWorkerSession();
      const artifact = h.publishArtifact("deterministic content\n");
      const turn = h.sendTask(session.session_id, "corrupt-artifact", "Consume the artifact.", {
        task: { goal: "Consume the artifact.", acceptance_criteria: ["done"], artifact_refs: [artifact.artifact_id] },
      });
      const blobPath = path.join(h.blobRoot, h.seed.projectId, artifact.content_hash.slice(0, 2), artifact.content_hash);
      writeFileSync(blobPath, "tampered bytes\n", "utf8");
      await start(h, turn);
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({
        state: "FAILED",
        error_code: "ARTIFACT_CORRUPT",
        execution_started: false,
        input_manifest_id: null,
      });
      expect(h.adapter.dispatchPermissionAcquired(turn.turn_id)).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});
