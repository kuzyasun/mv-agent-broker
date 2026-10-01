/**
 * Integration tests for daemon deadline supervision (spec §14.6, §16.1).
 *
 * Verifies:
 *   - Periodic deadline monitor automatically interrupts hanging mock adapters on wall-clock deadline
 *     without manually calling scanDeadlines.
 *   - Quiescence semantics: TIMED_OUT only committed after adapter settles; turn and session remain
 *     held in CANCELLING/ACTIVE until completion (never force release on elapsed deadline alone).
 *   - Shared shutdown path drains hanging turns before releasing state ownership.
 *   - Explicit idempotent stop of deadline monitor.
 *   - Monitor teardown prevents orphan timer ticks and DB access after close.
 *   - Existing direct startDaemon callers safely clean up monitor via lifecycle.shutdown().
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { daemonEnvFromProcess, startDaemon, type Daemon } from "../../src/daemon/bootstrap.ts";
import { DeadlineMonitor } from "../../src/daemon/deadlineMonitor.ts";
import type { TurnExecutor } from "../../src/core/execution.ts";
import { MockAdapter, type MockStep } from "../../src/providers/mock/mockAdapter.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../src/runtime/adapter.ts";
import {
  insertAccount,
  insertCoordinator,
  insertCoverageProfile,
  insertPolicyProfile,
  insertProject,
  insertWorkspace,
  listEventsByTurn,
} from "../../src/storage/repo.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";

/**
 * Mock adapter that applies a planned sequence of steps (barriers, hangs, etc.)
 * as turns arrive, without requiring pre-knowledge of turn IDs.
 */
class HangingMockAdapter extends MockAdapter {
  constructor(private readonly defaultSteps: MockStep[] = [{ kind: "hang" }]) {
    super();
  }

  override async executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    if (!this.executedSteps(req.turn_id).length) {
      super.plan(req.turn_id, this.defaultSteps);
    }
    return super.executeTurn(req, gate, onEvent);
  }
}

interface TestFixture {
  stateDir: string;
  wsRoot: string;
  daemon: Daemon;
  cleanup: () => Promise<void>;
}

async function setupFixture(opts?: {
  adapter?: ProviderAdapter;
  deadlinePollIntervalMs?: number;
  hardTurnDeadlineMs?: number;
}): Promise<TestFixture> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ab-deadlines-"));
  const wsRoot = path.join(stateDir, "ws-main");
  mkdirSync(path.join(wsRoot, "src"), { recursive: true });
  writeFileSync(path.join(wsRoot, "src", "main.c"), "int main(){return 0;}\n", "utf8");

  const daemon = await startDaemon({
    stateDir,
    coordinatorId: "coord-dl",
    deadlinePollIntervalMs: opts?.deadlinePollIntervalMs ?? 20,
    limits: opts?.hardTurnDeadlineMs ? { hardTurnDeadlineMs: opts.hardTurnDeadlineMs } : undefined,
  });

  if (opts?.adapter) {
    daemon.adapters.set("mock", opts.adapter);
  }

  const coverage = {
    source_prefixes: ["src", "tests"],
    non_source_prefixes: ["dist"],
    excluded_prefixes: [".git", "node_modules"],
  };

  insertProject(daemon.db, {
    project_id: "p-dl",
    display_name: "Deadlines Test Project",
    configuration_revision: 1,
    session_cap: 5,
    created_at: Date.now(),
  });
  insertCoordinator(daemon.db, {
    coordinator_id: "coord-dl",
    display_name: "Deadlines Coordinator",
    allowed_project_ids: ["p-dl"],
    revoked: false,
    config_revision: 1,
  });
  insertAccount(daemon.db, { account_profile_id: "acct-dl", provider: "mock", auth_mode: "native", quota_scope_id: "shared:mock" });
  insertCoverageProfile(daemon.db, {
    coverage_profile_id: "cov-dl",
    version: "1",
    config: JSON.stringify(coverage),
    contract_hash: coverageContractHash(coverage),
  });
  insertPolicyProfile(daemon.db, {
    policy_profile_id: "pol-dl",
    version: "1",
    config: JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests"] }),
  });
  insertWorkspace(daemon.db, {
    workspace_id: "ws-dl",
    project_id: "p-dl",
    mode: "current",
    canonical_path: wsRoot,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: "cov-dl",
  });

  const cleanup = async () => {
    try {
      await daemon.core.drain();
      await daemon.executor.drain();
    } catch {
      // ignore
    } finally {
      daemon.stopDeadlineMonitor();
      await daemon.lifecycle.shutdown();
      daemon.db.close();
      rmSync(stateDir, { recursive: true, force: true });
    }
  };

  return { stateDir, wsRoot, daemon, cleanup };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  stepMs = 15,
): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for predicate after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

describe("daemon deadline supervision (spec §14.6)", () => {
  it("automatically interrupts a hanging mock turn on wall-clock deadline without manual scanDeadlines", async () => {
    const adapter = new HangingMockAdapter([
      { kind: "report_native_ref", ref: "mock-native-dl-1" },
      { kind: "barrier", name: "slow-operation" },
      { kind: "complete", outcome: "completed" },
    ]);
    const fixture = await setupFixture({ adapter, deadlinePollIntervalMs: 20 });
    try {
      const { daemon } = fixture;
      const spawn = daemon.core.spawn("coord-dl", {
        project_id: "p-dl",
        idempotency_key: "spawn-auto-dl",
        provider: "mock",
        account_profile_id: "acct-dl",
        model: "mock-model",
        effort: null,
        role: "worker",
        instructions: "Test auto deadline supervision.",
        workspace: { mode: "current", workspace_id: "ws-dl" },
        policy_profile_id: "pol-dl",
      });

      // Plan a barrier that simulates a hanging child operation
      const send = daemon.core.send("coord-dl", {
        session_id: spawn.session_id,
        idempotency_key: "send-auto-dl",
        task: { goal: "Long running parser under deadline", acceptance_criteria: ["none"], artifact_refs: [] },
        deadline_ms: 100, // 100ms wall-clock deadline
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      });

      // Turn starts and begins running
      await waitFor(() => {
        const turn = daemon.core.turnStatus("coord-dl", send.turn_id);
        return turn.state === "RUNNING";
      });

      const runningTurn = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(runningTurn.state).toBe("RUNNING");
      expect(runningTurn.execution_started).toBe(true);

      // Do NOT call scanDeadlines() manually!
      // The periodic monitor ticks every 20ms and will observe Date.now() >= deadline_at.
      // Wait for terminal state TIMED_OUT.
      await waitFor(() => {
        const turn = daemon.core.turnStatus("coord-dl", send.turn_id);
        return turn.state === "TIMED_OUT";
      }, 3000);

      const finalTurn = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(finalTurn.state).toBe("TIMED_OUT");
      expect(finalTurn.termination_reason).toBe("deadline");
      expect(finalTurn.execution_started).toBe(true);
      expect(finalTurn.final_snapshot_id).toBeNull();

      // Session returns to IDLE (safe and reusable)
      const sessionAfterTimeout = daemon.core.sessionStatus("coord-dl", spawn.session_id);
      expect(sessionAfterTimeout.state).toBe("IDLE");

      // Verify event log contains deadline_reached
      const events = listEventsByTurn(daemon.db, send.turn_id, 0, 100);
      expect(events.map((e) => e.type)).toContain("deadline_reached");
    } finally {
      await fixture.cleanup();
    }
  });

  it("preserves quiescence: remains held in CANCELLING until completion, never force-releases on elapsed deadline alone", async () => {
    // Custom mock adapter that delays settlement upon interrupt.
    // Direct fake adapters stay compatible: optional ownership events are not required.
    class QuiescingMockAdapter implements ProviderAdapter {
      readonly providerId = "mock";
      readonly adapterVersion = "0.1.0";
      public interruptReceived = false;
      private releaseQuiescence: (() => void) | null = null;
      public readonly quiescenceBarrier = new Promise<void>((resolve) => {
        this.releaseQuiescence = resolve;
      });

      preflight(): void {}

      async executeTurn(
        req: TurnExecutionRequest,
        gate: DispatchGate,
        onEvent: (ev: AdapterEvent) => void,
      ): Promise<TurnExecutionResult> {
        gate.acquireDispatchPermission();
        onEvent({ type: "native_ref_obtained", payload: { ref: `mock-native-${req.turn_id}` } });

        // Simulate child process executing until quiescence is explicitly released
        await this.quiescenceBarrier;

        if (this.interruptReceived) {
          throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "interrupted after quiescence", {
            executionStarted: true,
          });
        }

        return {
          native_outcome: "completed",
          native_conversation_ref: `mock-native-${req.turn_id}`,
          agent_reported: { summary: "done", format_status: "text_only" },
        };
      }

      async interruptTurn(): Promise<boolean> {
        this.interruptReceived = true;
        // Do NOT release quiescence here: simulate child processes taking time to clean up
        return true;
      }

      settle(): void {
        this.releaseQuiescence?.();
      }

      async shutdownIdleRuntime(): Promise<void> {}
      inspectRuntime() {
        return null;
      }
    }

    const adapter = new QuiescingMockAdapter();
    const fixture = await setupFixture({ adapter, deadlinePollIntervalMs: 20 });
    try {
      const { daemon } = fixture;
      const spawn = daemon.core.spawn("coord-dl", {
        project_id: "p-dl",
        idempotency_key: "spawn-quiesce",
        provider: "mock",
        account_profile_id: "acct-dl",
        model: "mock-model",
        effort: null,
        role: "worker",
        instructions: "Test quiescence preservation.",
        workspace: { mode: "current", workspace_id: "ws-dl" },
        policy_profile_id: "pol-dl",
      });

      const send = daemon.core.send("coord-dl", {
        session_id: spawn.session_id,
        idempotency_key: "send-quiesce",
        task: { goal: "Long task with delayed quiescence", acceptance_criteria: ["none"], artifact_refs: [] },
        deadline_ms: 80,
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      });

      // Wait for turn to enter RUNNING
      await waitFor(() => {
        const turn = daemon.core.turnStatus("coord-dl", send.turn_id);
        return turn.state === "RUNNING";
      });

      // Wait for wall-clock deadline to elapse and periodic monitor to interrupt the adapter
      await waitFor(() => adapter.interruptReceived, 2000);

      // Verify that the turn is now CANCELLING with termination_reason "deadline"
      const turnDuringCancelling = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(turnDuringCancelling.state).toBe("CANCELLING");
      expect(turnDuringCancelling.termination_reason).toBe("deadline");

      // Verify session is STILL ACTIVE (resources not prematurely released)
      const sessionDuringCancelling = daemon.core.sessionStatus("coord-dl", spawn.session_id);
      expect(sessionDuringCancelling.state).toBe("ACTIVE");
      expect(sessionDuringCancelling.active_turn_id).toBe(send.turn_id);

      // Wait additional wall-clock time past deadline: turn MUST remain in CANCELLING, NOT TIMED_OUT!
      await new Promise((resolve) => setTimeout(resolve, 60));
      const turnStillCancelling = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(turnStillCancelling.state).toBe("CANCELLING");
      const sessionStillActive = daemon.core.sessionStatus("coord-dl", spawn.session_id);
      expect(sessionStillActive.state).toBe("ACTIVE");

      // Now release quiescence so the adapter settles
      adapter.settle();

      // Only now does the turn transition to TIMED_OUT and the session returns to IDLE
      await waitFor(() => {
        const turn = daemon.core.turnStatus("coord-dl", send.turn_id);
        return turn.state === "TIMED_OUT";
      });

      const finalTurn = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(finalTurn.state).toBe("TIMED_OUT");
      expect(finalTurn.termination_reason).toBe("deadline");

      const finalSession = daemon.core.sessionStatus("coord-dl", spawn.session_id);
      expect(finalSession.state).toBe("IDLE");
      expect(finalSession.active_turn_id).toBeNull();
    } finally {
      adapter.settle();
      await fixture.cleanup();
    }
  });

  it.each(["stop", "lifecycle"] as const)("%s drains a hanging turn before releasing ownership", async (entry) => {
    const adapter = new HangingMockAdapter([
      { kind: "report_native_ref", ref: "mock-native-drain" },
      { kind: "hang" },
    ]);
    const fixture = await setupFixture({ adapter, deadlinePollIntervalMs: 20 });
    try {
      const { daemon } = fixture;
      const spawn = daemon.core.spawn("coord-dl", {
        project_id: "p-dl",
        idempotency_key: "spawn-drain-dl",
        provider: "mock",
        account_profile_id: "acct-dl",
        model: "mock-model",
        effort: null,
        role: "worker",
        instructions: "Test drain deadline cancellation.",
        workspace: { mode: "current", workspace_id: "ws-dl" },
        policy_profile_id: "pol-dl",
      });

      // Plan a hang step under a 100ms deadline
      const send = daemon.core.send("coord-dl", {
        session_id: spawn.session_id,
        idempotency_key: "send-drain-dl",
        task: { goal: "Hanging task during drain", acceptance_criteria: ["none"], artifact_refs: [] },
        deadline_ms: 100,
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      });

      // Wait for turn to start
      await waitFor(() => {
        const turn = daemon.core.turnStatus("coord-dl", send.turn_id);
        return turn.state === "RUNNING";
      });

      // Shutdown draining: if deadline monitor were stopped before drain, this would hang indefinitely!
      // Because the deadline monitor is active during drain, the 100ms deadline expires,
      // the monitor interrupts the mock adapter, the turn settles to TIMED_OUT, and drain completes.
      const stopping = entry === "stop" ? daemon.stop() : daemon.lifecycle.shutdown();
      expect(daemon.stop()).toBe(stopping);
      expect(daemon.lifecycle.shutdown()).toBe(stopping);
      expect(existsSync(path.join(fixture.stateDir, "daemon.lock"))).toBe(true);
      expect(daemon.deadlineMonitor.isRunning).toBe(true);
      expect(() => daemon.core.spawn("coord-dl", {
        project_id: "p-dl", idempotency_key: "spawn-after-stop", provider: "mock",
        account_profile_id: "acct-dl", model: "mock-model", effort: null, role: "worker",
        instructions: "must not start", workspace: { mode: "current", workspace_id: "ws-dl" },
        policy_profile_id: "pol-dl",
      })).toThrowError(expect.objectContaining({ code: "DAEMON_NOT_READY" }));
      expect(() => daemon.core.send("coord-dl", {
        session_id: spawn.session_id, idempotency_key: "send-after-stop",
        task: { goal: "must not start", artifact_refs: [] },
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      })).toThrowError(expect.objectContaining({ code: "DAEMON_NOT_READY" }));
      // Already accepted operations remain replayable during drain.
      expect(daemon.core.send("coord-dl", {
        session_id: spawn.session_id, idempotency_key: "send-drain-dl",
        task: { goal: "Hanging task during drain", acceptance_criteria: ["none"], artifact_refs: [] },
        deadline_ms: 100, workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      }).turn_id).toBe(send.turn_id);
      await expect(startDaemon({ stateDir: fixture.stateDir, coordinatorId: "second" }))
        .rejects.toMatchObject({ code: "DAEMON_ALREADY_RUNNING" });
      await stopping;
      expect(existsSync(path.join(fixture.stateDir, "daemon.lock"))).toBe(false);

      const turnAfterDrain = daemon.core.turnStatus("coord-dl", send.turn_id);
      expect(turnAfterDrain.state).toBe("TIMED_OUT");
      expect(turnAfterDrain.termination_reason).toBe("deadline");

      // Stop monitor and shutdown cleanly
      daemon.stopDeadlineMonitor();
      expect(daemon.deadlineMonitor.isStopped).toBe(true);

      await daemon.lifecycle.shutdown();
      daemon.db.close();
    } finally {
      fixture.daemon.stopDeadlineMonitor();
      await fixture.daemon.lifecycle.shutdown().catch(() => undefined);
      try {
        fixture.daemon.db.close();
      } catch {
        // already closed
      }
      rmSync(fixture.stateDir, { recursive: true, force: true });
    }
  });

  it.each([NaN, Infinity, -1, 0, 4, 60_001, 5.5])("rejects invalid interval %s before opening state", async (interval) => {
    const root = mkdtempSync(path.join(tmpdir(), "ab-invalid-deadline-"));
    const stateDir = path.join(root, "state");
    try {
      await expect(startDaemon({ stateDir, coordinatorId: "test", deadlinePollIntervalMs: interval }))
        .rejects.toThrow("Deadline polling interval");
      expect(existsSync(stateDir)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(["", "50ms", "50.5", "NaN", "Infinity", " 50", "4", "60001"])("rejects invalid environment interval %j", value => {
    expect(() => daemonEnvFromProcess({ AB_DEADLINE_POLL_MS: value })).toThrow();
  });

  it("uses the default interval and accepts both configured bounds", () => {
    expect(daemonEnvFromProcess({}).deadlinePollIntervalMs).toBeUndefined();
    for (const value of ["5", "50", "60000"]) {
      expect(daemonEnvFromProcess({ AB_DEADLINE_POLL_MS: value }).deadlinePollIntervalMs).toBe(Number(value));
    }
  });

  it("reports a scan failure streak once, recovers, and never scans after stop", () => {
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
    const scan = vi.fn().mockImplementation(() => { throw new Error("private database detail"); });
    const monitor = new DeadlineMonitor({ scanDeadlines: scan } as unknown as TurnExecutor);
    try {
      for (let i = 0; i < 10; i++) monitor.tick();
      expect(monitor.totalScans).toBe(10);
      expect(monitor.failedScans).toBe(10);
      expect(monitor.consecutiveFailedScans).toBe(10);
      expect(diagnostic).toHaveBeenCalledTimes(1);
      expect(diagnostic.mock.calls.flat().join(" ")).not.toContain("private database detail");
      scan.mockImplementation(() => {});
      monitor.tick();
      expect(monitor.consecutiveFailedScans).toBe(0);
      expect(diagnostic).toHaveBeenCalledTimes(2);
      // Alternating failures/recoveries must not flood the daemon stderr.
      for (let i = 0; i < 10; i++) {
        scan.mockImplementation(() => { throw new Error("transient"); }); monitor.tick();
        scan.mockImplementation(() => {}); monitor.tick();
      }
      expect(diagnostic).toHaveBeenCalledTimes(2);
      monitor.stop(); monitor.tick();
      expect(scan).toHaveBeenCalledTimes(31);
    } finally { monitor.stop(); diagnostic.mockRestore(); }
  });

  it("retains ownership and supervision if shutdown drain fails", async () => {
    const fixture = await setupFixture();
    const drain = vi.spyOn(fixture.daemon.core, "drain").mockRejectedValue(new Error("drain failure"));
    try {
      await expect(fixture.daemon.stop()).rejects.toThrow("drain failure");
      expect(fixture.daemon.deadlineMonitor.isRunning).toBe(true);
      expect(existsSync(path.join(fixture.stateDir, "daemon.lock"))).toBe(true);
      drain.mockRestore();
      await fixture.daemon.stop();
      expect(fixture.daemon.deadlineMonitor.isStopped).toBe(true);
      expect(existsSync(path.join(fixture.stateDir, "daemon.lock"))).toBe(false);
    } finally {
      drain.mockRestore();
      fixture.daemon.stopDeadlineMonitor();
      fixture.daemon.db.close();
      rmSync(fixture.stateDir, { recursive: true, force: true });
    }
  });

  it("monitor teardown prevents orphan timer callbacks and DB access after close", async () => {
    const fixture = await setupFixture({ deadlinePollIntervalMs: 20 });
    const { daemon, stateDir } = fixture;

    expect(daemon.deadlineMonitor.isRunning).toBe(true);
    expect(daemon.deadlineMonitor.isStopped).toBe(false);

    // Explicit stop
    daemon.stopDeadlineMonitor();
    expect(daemon.deadlineMonitor.isRunning).toBe(false);
    expect(daemon.deadlineMonitor.isStopped).toBe(true);

    // Idempotent stop: calling again must not throw or alter state
    daemon.stopDeadlineMonitor();
    expect(daemon.deadlineMonitor.isStopped).toBe(true);

    // Shutdown lifecycle and close database
    await daemon.lifecycle.shutdown();
    daemon.db.close();

    const scansAtClose = daemon.deadlineMonitor.totalScans;

    // Wait past several poll intervals (100ms = 5 intervals of 20ms)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Verify no scans ran after close, and no SQLite errors were thrown
    expect(daemon.deadlineMonitor.totalScans).toBe(scansAtClose);
    expect(daemon.deadlineMonitor.isStopped).toBe(true);

    rmSync(stateDir, { recursive: true, force: true });
  });

  it("direct startDaemon callers clean up monitor safely via lifecycle.shutdown()", async () => {
    // Simulates callers/existing tests that only invoke lifecycle.shutdown() and db.close()
    const stateDir = mkdtempSync(path.join(tmpdir(), "ab-direct-caller-"));
    const daemon = await startDaemon({
      stateDir,
      coordinatorId: "coord-direct",
      deadlinePollIntervalMs: 20,
    });

    expect(daemon.deadlineMonitor.isRunning).toBe(true);

    // Direct caller pattern: lifecycle.shutdown() without calling daemon.stopDeadlineMonitor()
    await daemon.lifecycle.shutdown();
    expect(daemon.deadlineMonitor.isStopped).toBe(true);

    // Database can be closed immediately without orphan timer access
    daemon.db.close();

    const scansAtClose = daemon.deadlineMonitor.totalScans;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(daemon.deadlineMonitor.totalScans).toBe(scansAtClose);

    rmSync(stateDir, { recursive: true, force: true });
  });
});
