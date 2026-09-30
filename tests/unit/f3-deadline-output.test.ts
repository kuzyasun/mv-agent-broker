/**
 * Feature 3 acceptance tests: A21, A25, A27, A31-subset (spec §18).
 * Deadline enforcement, agent claim separation, bounded event streams, and event idempotency.
 */
import { describe, expect, it } from "vitest";
import { createHarness, settle, start } from "../helpers/harness.ts";

describe("A21: hard deadline interrupts an owned running tool; TIMED_OUT only after definite outcome", () => {
  it("deadline interrupt path and cancel path", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();

      // 1. spawn; t1 with deadline_ms 1000; plan barrier "tool" then complete.
      // await start(h, t1) → RUNNING with barrier held (simulates owned tool still working).
      const t1 = h.sendTask(spawn.session_id, "a21-t1", "Implement parser under deadline.", { deadline_ms: 1000 });
      h.adapter.plan(t1.turn_id, [
        { kind: "report_native_ref", ref: "mock-native-a21" },
        { kind: "barrier", name: "tool" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      const turnRunning = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnRunning.state).toBe("RUNNING");
      expect(turnRunning.execution_started).toBe(true);

      // 2. Advance clock past deadline and trigger deadline scan.
      // Scan transitions turn to CANCELLING with termination_reason "deadline",
      // then interrupts the adapter. The interrupted executeTurn settles.
      h.clock.advance(1500);
      h.executor.scanDeadlines();

      const turnCancelling = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnCancelling.state).toBe("CANCELLING");
      expect(turnCancelling.termination_reason).toBe("deadline");

      await settle(h);

      // Final terminal state: TIMED_OUT (deadline interrupt path).
      // Per §14.6 the deadline reason survives: termination_reason === "deadline",
      // execution_started === true, final_snapshot_id === null.
      const turnFinal = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turnFinal.state).toBe("TIMED_OUT");
      expect(turnFinal.termination_reason).toBe("deadline");
      expect(turnFinal.execution_started).toBe(true);
      expect(turnFinal.final_snapshot_id).toBeNull();

      // Session returns to IDLE: ref recorded + available + contextUsable,
      // so it is safe and reusable per §6.5.1 terminal_turn_committed_reusable.
      const sessionAfterTimeout = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(sessionAfterTimeout.state).toBe("IDLE");

      // Send a second turn t2 on the same session to assert continuation === "native_resume" (INV-05).
      const t2 = h.sendTask(spawn.session_id, "a21-t2", "Second task continuing native session.");
      h.adapter.plan(t2.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).continuation).toBe("native_resume");

      // 3. Cancel-path variant: third turn with {kind:"hang"}, then core.cancel
      // → CANCELLED with termination_reason "cancelled".
      const t3 = h.sendTask(spawn.session_id, "a21-t3", "Third task to cancel.");
      h.adapter.plan(t3.turn_id, [{ kind: "hang" }]);
      await start(h, t3);

      const cancelRes = h.core.cancel(h.seed.coordinatorId, {
        turn_id: t3.turn_id,
        idempotency_key: "a21-c3",
        reason: "cancelled",
      });
      expect(cancelRes.state).toBe("CANCELLING");

      await settle(h);

      const turn3Final = h.core.turnStatus(h.seed.coordinatorId, t3.turn_id);
      expect(turn3Final.state).toBe("CANCELLED");
      expect(turn3Final.termination_reason).toBe("cancelled");
      expect(turn3Final.execution_started).toBe(true);
      expect(turn3Final.final_snapshot_id).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("A25: agent claims tests passed while evidence is absent → claims stay separate, quality never auto-accepted", () => {
  it("agent summary text stays in agent_reported channel, never fused into broker_observed", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "a25-t1", "Run test suite.");
      const agentSummary = "All 42 tests passed.";
      h.adapter.plan(t1.turn_id, [
        { kind: "complete", outcome: "completed", summary: agentSummary },
      ]);
      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.error_code).toBeNull();
      expect(turn.final_snapshot_id).not.toBeNull();

      // Nothing marks quality: there is no quality field on the turn record.
      // (Single documented `any` cast as required by specification).
      expect((turn as any).quality).toBeUndefined();

      // The agent's summary string appears NOWHERE in the turn record fields
      // (task_goal_hash is a hash; broker_observed state never absorbs agent text).
      const turnJson = JSON.stringify(turn);
      expect(turnJson).not.toContain(agentSummary);
      expect(turnJson).not.toContain("42 tests");

      // Verify the events stream contains turn_terminal and also does not fuse agent summary.
      const events = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 100);
      const terminalEvent = events.find((e) => e.type === "turn_terminal");
      expect(terminalEvent).toBeDefined();
      expect(terminalEvent?.payload).not.toContain(agentSummary);
    } finally {
      h.cleanup();
    }
  });
});

describe("A27: bounded events + malformed output", () => {
  it("paginates 300+ events with bounded limit and handles malformed output safely", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();

      // 1. 300 progress steps then complete.
      const progressSteps: Array<{ kind: "progress"; label: string }> = Array.from({ length: 300 }, (_, i) => ({
        kind: "progress",
        label: `tick-${i}`,
      }));
      const t1 = h.sendTask(spawn.session_id, "a27-t1", "Process stream.");
      h.adapter.plan(t1.turn_id, [
        ...progressSteps,
        { kind: "complete", outcome: "completed", summary: "stream done" },
      ]);
      await start(h, t1);
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      // 2. Page through ALL events via core.turnEvents in a loop with limit 50 following seq cursors.
      let afterSeq = 0;
      const allEvents: Array<ReturnType<typeof h.core.turnEvents>[number]> = [];
      while (true) {
        const page = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, afterSeq, 50);
        expect(page.length).toBeLessThanOrEqual(50);
        if (page.length === 0) break;
        allEvents.push(...page);
        afterSeq = page[page.length - 1]!.seq;
      }

      // Assert total events >= 302 (300 progress + admission, starting, sealed, running, terminal...).
      expect(allEvents.length).toBeGreaterThanOrEqual(302);

      // Main assertion: pagination terminates, each page <= 50, no duplicate sequence IDs.
      const seqSet = new Set(allEvents.map((e) => e.seq));
      expect(seqSet.size).toBe(allEvents.length);

      // 3. Malformed output: t2 with new key plans complete_malformed.
      // Settle → turn SUCCEEDED, continuation and native ref are sane.
      // Malformed content must not crash the terminal commit (§11.3 text_only).
      const t2 = h.sendTask(spawn.session_id, "a27-t2", "Task with malformed output.");
      h.adapter.plan(t2.turn_id, [{ kind: "complete_malformed" }]);
      await start(h, t2);
      await settle(h);

      const turn2 = h.core.turnStatus(h.seed.coordinatorId, t2.turn_id);
      expect(turn2.state).toBe("SUCCEEDED");
      expect(turn2.native_conversation_ref).toBeTruthy();
      expect(turn2.continuation).toBe("native_resume");
    } finally {
      h.cleanup();
    }
  });
});

describe("A31-subset: event replay is idempotent; deleted/expired ranges are explicit", () => {
  it("replays event pages idempotently and returns empty page for cursor beyond max seq", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "a31-t1", "Event replay test.");
      h.adapter.plan(t1.turn_id, [
        { kind: "progress", label: "step-1" },
        { kind: "progress", label: "step-2" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      await settle(h);

      // 1. Re-read the same events page twice with the same after-cursor → identical results (deep equal).
      const page1 = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 10);
      const page2 = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 10);
      expect(page1.length).toBeGreaterThan(0);
      expect(page1).toEqual(page2);

      // 2. after_cursor larger than the last seq → empty array (not an error).
      // SQLite's events table uses INTEGER PRIMARY KEY AUTOINCREMENT on seq, ensuring
      // monotonically increasing sequence numbers. In standard execution, gaps do not occur.
      // Querying with an afterSeq beyond the maximum committed seq yields an empty array without error.
      const emptyPage = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 999_999_999, 10);
      expect(emptyPage).toEqual([]);
    } finally {
      h.cleanup();
    }
  });
});
