/**
 * F4 Guards tests (spec §18):
 * - GUARD 1: A22 Incarnation fencing (§4.1.1)
 * - GUARD 2: A32 Adapter version drift (§13.3)
 * - GUARD 3: A48 Discovery pagination with config change (§10.1.2)
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
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

describe("f4 guards: incarnation fencing, adapter drift, discovery pagination", () => {
  it("A22: incarnation fencing rejects stale adapter commit after daemon restart (§4.1.1)", async () => {
    const h = createHarness();
    const dir1 = await mkdtemp(path.join(tmpdir(), "agent-broker-fencing-1-"));
    const dir2 = await mkdtemp(path.join(tmpdir(), "agent-broker-fencing-2-"));
    try {
      // 1. Harness starts with no incarnation attached initially.
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "f" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("RUNNING");

      // 2. Attach expected incarnation to executor (as set during bootstrap after ownership).
      const lifecycle = new DaemonLifecycle(h.db, h.clock);
      await lifecycle.start(dir1);
      h.executor.attachIncarnation(lifecycle.currentIncarnation);

      // 3. Simulate daemon restart in the same process: writes a NEW incarnation into daemon_state
      // and recovery barrier conservatively marks running turn as UNKNOWN.
      const restart = new DaemonLifecycle(h.db, h.clock);
      await restart.start(dir2);
      expect(restart.currentIncarnation).not.toBe(lifecycle.currentIncarnation);

      // 4. Stale executor attempts late commit: must be rejected with stale_write_rejected.
      h.adapter.releaseBarrier("f");
      await settle(h);

      // Turn did NOT reach a terminal state via the executor's own commit path.
      // Final state is UNKNOWN from recovery barrier; session is BLOCKED.
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("UNKNOWN");
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.state).toBe("BLOCKED");

      // Crucially, events for the turn include stale_write_rejected.
      const events = h.core.turnEvents(h.seed.coordinatorId, t1.turn_id, 0, 100);
      const staleEvent = events.find((e) => e.type === "stale_write_rejected");
      expect(staleEvent).toBeDefined();
      const payload = JSON.parse(staleEvent?.payload ?? "{}") as { executor_incarnation?: string };
      expect(payload.executor_incarnation).toBe(lifecycle.currentIncarnation);

      const evidenceCount = (
        h.db.raw.prepare("SELECT COUNT(*) AS c FROM turn_outcome_evidence WHERE turn_id = ?").get(t1.turn_id) as { c: number }
      ).c;
      expect(evidenceCount).toBe(0);

      await restart.shutdown();
      await lifecycle.shutdown();
    } finally {
      await rm(dir1, { recursive: true, force: true });
      await rm(dir2, { recursive: true, force: true });
      h.cleanup();
    }
  });

  it("A22: stale executor cannot acquire dispatch permission after recovery marks the turn UNKNOWN", async () => {
    const h = createHarness();
    const dir = await mkdtemp(path.join(tmpdir(), "agent-broker-fencing-dispatch-"));
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "g" },
        { kind: "complete", outcome: "completed" },
      ]);

      // Do NOT start the executor at all after admission; run lifecycle restart FIRST
      // (turn still ACCEPTED -> recovery prestart path applies ONLY when no launch intent;
      // the executor hasn't started so no launch intent exists -> recovery marks it FAILED prestart).
      const restart = new DaemonLifecycle(h.db, h.clock);
      await restart.start(dir);

      h.executor.attachIncarnation(restart.currentIncarnation);
      await start(h, t1);
      await settle(h);

      // beginStarting sees state != ACCEPTED -> returns; no dispatch happens.
      expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBeFalsy();
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("DAEMON_RESTART_PRESTART");

      await restart.shutdown();
    } finally {
      await rm(dir, { recursive: true, force: true });
      h.cleanup();
    }
  });

  it("A32: adapter upgrades do not invalidate a reusable session (§13.3)", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      // CLI upgrade / version drift: simulate session recorded with older adapter version
      h.db.raw.prepare("UPDATE sessions SET adapter_version = '0.0.9-old' WHERE session_id = ?").run(spawn.session_id);

      const t2 = h.sendTask(spawn.session_id, "t2");
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");

      // Restore adapter_version to the real value ('0.1.0')
      const realVersion = h.adapter.adapterVersion;
      h.db.raw.prepare("UPDATE sessions SET adapter_version = ? WHERE session_id = ?").run(realVersion, spawn.session_id);

      // Session is usable again once revalidated
      const t3 = h.sendTask(spawn.session_id, "t3");
      await start(h, t3);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t3.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("A48: discovery paging cycle with config change raises DISCOVERY_CHANGED (§10.1.2)", () => {
    const h = createHarness();
    try {
      const page1 = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 2);
      expect(page1.entries).toHaveLength(2);
      const cursor = page1.next_cursor;
      expect(cursor).not.toBeNull();
      expect(cursor).toMatch(/^r\d+:\d+$/);

      // Bump project configuration revision during pagination
      h.db.raw.prepare("UPDATE projects SET configuration_revision = configuration_revision + 1 WHERE project_id = ?").run(h.seed.projectId);

      expectBrokerError(
        () => h.core.discovery(h.seed.coordinatorId, h.seed.projectId, cursor, 2),
        "DISCOVERY_CHANGED",
      );

      // Fresh pagination with null cursor succeeds and returns updated revision
      const fresh = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 2);
      expect(fresh.configuration_revision).toBe(page1.configuration_revision + 1);
      expect(fresh.entries).toHaveLength(2);
    } finally {
      h.cleanup();
    }
  });
});
