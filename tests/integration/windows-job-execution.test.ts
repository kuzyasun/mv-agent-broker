import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { getSession, getTurn, listPendingIntents, listActiveReservationsByOwner } from "../../src/storage/repo.ts";

// Core/journal fault tests: synthetic ownership receipts, never native proof.
const ownership = () => ({ launch_uuid: "00000000-0000-4000-8000-000000000001",
  named_job: "Local\\agent-broker-job-fixture", root_pid: 123, root_creation_time: "123456",
  helper_pid: 124, owner_pid: process.pid, owner_creation_time: "123455" });

describe("managed ownership journal and outcome boundaries (core fixtures)", () => {
  it("persists exact launch identity atomically before the caller may acknowledge resume", async () => {
    const h = createHarness();
    try {
      const s = await h.spawnWorkerSession();
      const t = h.sendTask(s.session_id, "owned");
      h.adapter.executeTurn = async (_request, gate, event) => {
        gate.acquireDispatchPermission();
        event({ type: "owned_launch", payload: ownership() });
        const journal = listPendingIntents(h.db, "launch_turn").find(i => i.turn_id === t.turn_id)!;
        expect(JSON.parse(journal.payload!).ownership).toEqual(ownership());
        expect(getSession(h.db, s.session_id)?.runtime_id).toBe(getTurn(h.db, t.turn_id)?.runtime_id);
        expect(getTurn(h.db, t.turn_id)?.runtime_id).toContain("winjob:");
        event({ type: "owned_resumed", payload: {} });
        return { native_outcome: "completed", native_conversation_ref: "owned-fixture" };
      };
      h.executor.startTurn(t.turn_id);
      await h.executor.drain();
      expect(getTurn(h.db, t.turn_id)?.state).toBe("SUCCEEDED");
    } finally { h.cleanup(); }
  });

  for (const fault of ["zero-creation", "corrupt-intent", "missing-intent", "duplicate-intent"] as const) {
    it(`refuses ${fault} before acknowledgement without partial ownership journal`, async () => {
      const h = createHarness();
      try {
        const s = await h.spawnWorkerSession();
        const t = h.sendTask(s.session_id, fault);
        let acknowledged = false;
        h.adapter.executeTurn = async (_request, gate, event) => {
          gate.acquireDispatchPermission();
          const intent = listPendingIntents(h.db, "launch_turn").find(i => i.turn_id === t.turn_id)!;
          if (fault === "corrupt-intent") h.db.raw.prepare("UPDATE intents SET payload = '{' WHERE intent_id = ?").run(intent.intent_id);
          if (fault === "missing-intent") h.db.raw.prepare("DELETE FROM intents WHERE intent_id = ?").run(intent.intent_id);
          if (fault === "duplicate-intent") h.db.raw.prepare("INSERT INTO intents SELECT 'duplicate-fixture',kind,session_id,turn_id,state,payload,created_at,updated_at FROM intents WHERE intent_id = ?").run(intent.intent_id);
          event({ type: "owned_launch", payload: { ...ownership(), ...(fault === "zero-creation" ? { root_creation_time: "0" } : {}) } });
          acknowledged = true;
          return { native_outcome: "completed", native_conversation_ref: "never" };
        };
        h.executor.startTurn(t.turn_id);
        await h.executor.drain();
        expect(acknowledged).toBe(false);
        expect(getSession(h.db, s.session_id)?.runtime_id).toBeNull();
        expect(getTurn(h.db, t.turn_id)?.runtime_id).toBeNull();
        expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE turn_id = ? AND type = 'adapter:owned_launch'").get(t.turn_id)).toEqual(expect.objectContaining({ n: 0 }));
      } finally { h.cleanup(); }
    });
  }

  it("typed UNKNOWN retains workspace reservation and active blocked session", async () => {
    const h = createHarness();
    try {
      const s = await h.spawnWorkerSession();
      const t = h.sendTask(s.session_id, "lost-helper");
      h.adapter.executeTurn = async (_request, gate, event) => {
        gate.acquireDispatchPermission();
        event({ type: "owned_launch", payload: ownership() });
        event({ type: "owned_resumed", payload: {} });
        throw new BrokerError("EXECUTION_UNKNOWN", "owned helper lost", { executionStarted: null });
      };
      h.executor.startTurn(t.turn_id);
      await h.executor.drain();
      expect(getTurn(h.db, t.turn_id)?.state).toBe("UNKNOWN");
      expect(getSession(h.db, s.session_id)).toMatchObject({ state: "BLOCKED", active_turn_id: t.turn_id });
      expect(listActiveReservationsByOwner(h.db, t.turn_id).length).toBeGreaterThan(0);
    } finally { h.cleanup(); }
  });

  it("journaled zero-resume proof corrects the earlier permission grant", async () => {
    const h = createHarness();
    try {
      const s = await h.spawnWorkerSession();
      const t = h.sendTask(s.session_id, "zero-resume");
      h.adapter.executeTurn = async (_request, gate, event) => {
        gate.acquireDispatchPermission();
        event({ type: "owned_launch", payload: ownership() });
        event({ type: "owned_zero_resume", payload: { quiesced: true, ownership: ownership(), reason: "resume_refused" } });
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "helper refused", { executionStarted: true });
      };
      h.executor.startTurn(t.turn_id);
      await h.executor.drain();
      expect(getTurn(h.db, t.turn_id)).toMatchObject({ state: "FAILED", execution_started: false });
      expect(getSession(h.db, s.session_id)?.state).toBe("IDLE");
    } finally { h.cleanup(); }
  });
});
