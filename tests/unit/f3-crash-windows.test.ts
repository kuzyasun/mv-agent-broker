/**
 * Fault-injection acceptance tests A18 and A19 (spec §18, §14.3 crash windows).
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHarness, start } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { DaemonLifecycle } from "../../src/daemon/lifecycle.ts";

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

describe("crash windows: A18 and A19 (spec §18, §14.3)", () => {
  it("A18: crash after worker file writes, before completion record → UNKNOWN + BLOCKED, workspace quarantined from new writers, replay forbidden", async () => {
    const h = createHarness({ limits: { globalUnfinishedTurns: 10, quotaScopeUnfinishedTurns: 10 } });
    const tmpDirs: string[] = [];
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "impl-a18");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "w" },
        { kind: "workspace_write", files: [{ path: "src/partial.c", content: "half-done" }] },
        { kind: "hang" },
      ]);
      await start(h, t1);
      h.adapter.releaseBarrier("w");
      while (!h.adapter.executedSteps(t1.turn_id).includes("hang")) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      // Worker file was written to disk
      const writtenContent = readFileSync(path.join(h.workspaceRoot, "src/partial.c"), "utf8");
      expect(writtenContent).toBe("half-done");

      // Supervisor crashes after file writes
      await h.executor.forceUnknownForTest(t1.turn_id, new Error("crash after writes"));

      // 2. Assert: turn UNKNOWN with native_outcome "unknown"; session BLOCKED
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("UNKNOWN");
      expect(turn.native_outcome).toBe("unknown");

      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("unknown");

      // 3. New writer on the SAME workspace is refused: spawn a second session
      // and expect its sendTask to throw BrokerError "WORKSPACE_BUSY" (the lease/reservation
      // of the UNKNOWN turn is still held — INV-02/§14.5).
      const s2 = await h.spawnWorkerSession();
      expectBrokerError(() => h.sendTask(s2.session_id, "impl-a18-s2"), "WORKSPACE_BUSY");

      // 4. Replay forbidden: h.sendTask with the SAME idempotency key as t1 returns
      // the SAME turn (replay, state UNKNOWN); and a NEW key on the blocked session throws "SESSION_BLOCKED".
      const replay = h.sendTask(spawn.session_id, "impl-a18");
      expect(replay.turn_id).toBe(t1.turn_id);
      expect(replay.state).toBe("UNKNOWN");
      expect(replay.replayed_request).toBe(true);

      expectBrokerError(() => h.sendTask(spawn.session_id, "impl-a18-new"), "SESSION_BLOCKED");

      // 5. Restart recovery: const lifecycle = new DaemonLifecycle(h.db, h.clock);
      // await lifecycle.start(tmpStateDir) with a mkdtemp dir; assert the turn STAYS UNKNOWN
      // (never auto-terminal) and the session stays BLOCKED.
      const tmpStateDir = await fs.mkdtemp(path.join(tmpdir(), "agent-broker-recovery-a18-"));
      tmpDirs.push(tmpStateDir);
      const lifecycle = new DaemonLifecycle(h.db, h.clock);
      const report = await lifecycle.start(tmpStateDir);
      expect(report.quarantined_unknown_turns).toContain(t1.turn_id);

      const turnAfterRecovery = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnAfterRecovery.state).toBe("UNKNOWN");
      expect(turnAfterRecovery.native_outcome).toBe("unknown");

      const sessionAfterRecovery = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(sessionAfterRecovery.state).toBe("BLOCKED");

      // Even after restart, workspace remains protected from new writers
      expectBrokerError(() => h.sendTask(s2.session_id, "impl-a18-s2-post-recovery"), "WORKSPACE_BUSY");

      await lifecycle.shutdown();
    } finally {
      for (const d of tmpDirs) {
        rmSync(d, { recursive: true, force: true });
      }
      h.cleanup();
    }
  });

  it("A19: crash after known completion before commit → recovery finishes sealing WITHOUT new inference", async () => {
    const h = createHarness();
    const tmpDirs: string[] = [];
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "impl-a19");
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed" }]);

      await h.executor.completeWithoutCommitForTest(t1.turn_id);

      // 1. After it, the turn is still nonterminal (RUNNING) and NO adapter process is alive
      const turnBeforeRecovery = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnBeforeRecovery.state).toBe("RUNNING");
      expect(turnBeforeRecovery.execution_started).toBe(true);

      const sessionBeforeRecovery = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(sessionBeforeRecovery.state).toBe("ACTIVE");
      expect(sessionBeforeRecovery.active_turn_id).toBe(t1.turn_id);

      const stepsBefore = h.adapter.executedSteps(t1.turn_id);
      expect(stepsBefore).toContain("complete:completed");
      expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBe(true);

      // Assert turn_outcome_evidence row exists with candidate SUCCEEDED and applied=0
      const evidenceRow = h.db.raw
        .prepare("SELECT * FROM turn_outcome_evidence WHERE turn_id = ?")
        .get(t1.turn_id) as Record<string, unknown> | undefined;
      expect(evidenceRow).toBeDefined();
      expect(evidenceRow?.candidate).toBe("SUCCEEDED");
      expect(evidenceRow?.applied).toBe(0);

      // 2. Run DaemonLifecycle recovery on the same db (mkdtemp state dir)
      const tmpStateDir = await fs.mkdtemp(path.join(tmpdir(), "agent-broker-recovery-a19-"));
      tmpDirs.push(tmpStateDir);
      const lifecycle = new DaemonLifecycle(h.db, h.clock);
      const report = await lifecycle.start(tmpStateDir);
      expect(report.quarantined_unknown_turns).not.toContain(t1.turn_id);

      const turnAfterRecovery = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnAfterRecovery.state).toBe("FINALIZING");

      // 3. Simulate the bootstrap wiring:
      h.executor.attachIncarnation(lifecycle.currentIncarnation);
      await h.executor.reconcileJournaledOutcomes();

      // 4. Assert: turn terminal SUCCEEDED; execution_started true; final_snapshot_id truthy; evidence applied=1
      const turnAfterReconcile = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnAfterReconcile.state).toBe("SUCCEEDED");
      expect(turnAfterReconcile.execution_started).toBe(true);
      expect(turnAfterReconcile.final_snapshot_id).toBeTruthy();

      const evidenceAfter = h.db.raw
        .prepare("SELECT applied FROM turn_outcome_evidence WHERE turn_id = ?")
        .get(t1.turn_id) as { applied: number };
      expect(evidenceAfter.applied).toBe(1);

      // 5. Adapter was NOT re-executed
      expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBe(true);
      const stepsAfter = h.adapter.executedSteps(t1.turn_id);
      const completeSteps = stepsAfter.filter((s) => s === "complete:completed");
      expect(completeSteps).toHaveLength(1);
      expect(stepsAfter).toEqual(stepsBefore);

      // 6. Session back to IDLE
      const sessionAfter = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(sessionAfter.state).toBe("IDLE");

      // 7. Follow-up same-key replay returns the SUCCEEDED turn
      const replay = h.sendTask(spawn.session_id, "impl-a19");
      expect(replay.turn_id).toBe(t1.turn_id);
      expect(replay.state).toBe("SUCCEEDED");
      expect(replay.replayed_request).toBe(true);

      await lifecycle.shutdown();
    } finally {
      for (const d of tmpDirs) {
        rmSync(d, { recursive: true, force: true });
      }
      h.cleanup();
    }
  });

  it("A19-evidence-failure variant: explicit evidence failure path finishes FAILED without new inference", async () => {
    const h = createHarness();
    const tmpDirs: string[] = [];
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "impl-a19-fail");
      h.db.raw.prepare("UPDATE turns SET state = 'RUNNING', execution_started = 1 WHERE turn_id = ?").run(t1.turn_id);

      h.db.raw.prepare(`
        INSERT INTO turn_outcome_evidence (
          turn_id, native_outcome, termination_hint, candidate, execution_started,
          native_conversation_ref, recorded_at, incarnation, applied
        ) VALUES (?, 'failed', 'normal', 'FAILED', 1, 'mock-ref-fail', ?, 'test-inc', 0)
      `).run(t1.turn_id, h.clock.now());

      const tmpStateDir = await fs.mkdtemp(path.join(tmpdir(), "agent-broker-recovery-a19-fail-"));
      tmpDirs.push(tmpStateDir);
      const lifecycle = new DaemonLifecycle(h.db, h.clock);
      const report = await lifecycle.start(tmpStateDir);
      expect(report.quarantined_unknown_turns).not.toContain(t1.turn_id);

      const turnFinalizing = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnFinalizing.state).toBe("FINALIZING");

      h.executor.attachIncarnation(lifecycle.currentIncarnation);
      await h.executor.reconcileJournaledOutcomes();

      const turnFinal = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnFinal.state).toBe("FAILED");
      expect(turnFinal.native_outcome).toBe("failed");
      expect(turnFinal.execution_started).toBe(true);

      const evidenceAfter = h.db.raw
        .prepare("SELECT applied FROM turn_outcome_evidence WHERE turn_id = ?")
        .get(t1.turn_id) as { applied: number };
      expect(evidenceAfter.applied).toBe(1);

      expect(h.adapter.executedSteps(t1.turn_id)).toHaveLength(0);

      await lifecycle.shutdown();
    } finally {
      for (const d of tmpDirs) {
        rmSync(d, { recursive: true, force: true });
      }
      h.cleanup();
    }
  });
});
