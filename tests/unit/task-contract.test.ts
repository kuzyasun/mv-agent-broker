import { describe, expect, it, vi } from "vitest";
import { createHarness, start, settle } from "../helpers/harness.ts";

describe("durable caller task and native report", () => {
  it.each(["missing-task", "changed-goal", "missing-instructions", "changed-instructions"])("fails %s before native dispatch", async mode => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession(); const sent = h.sendTask(session.session_id, "task", "Deliver me.");
      if (mode === "missing-task") h.db.raw.prepare("DELETE FROM events WHERE turn_id = ? AND type = 'turn_admitted'").run(sent.turn_id);
      if (mode === "changed-goal") h.db.raw.prepare("UPDATE events SET payload = ? WHERE turn_id = ? AND type = 'turn_admitted'")
        .run(JSON.stringify({ task: { goal: "different" } }), sent.turn_id);
      if (mode.endsWith("instructions")) h.db.raw.prepare("UPDATE intents SET payload = ? WHERE session_id = ? AND kind = 'provision_session'")
        .run(JSON.stringify(mode === "missing-instructions" ? {} : { instructions: "different" }), session.session_id);
      const execute = vi.spyOn(h.adapter, "executeTurn");
      await start(h, sent); await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id)).toMatchObject({ state: "FAILED", error_code: "INPUT_DELIVERY_FAILED", execution_started: false });
      expect(execute).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });
  it("bounds the report and enforces coordinator ownership", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession(); const sent = h.sendTask(session.session_id, "report");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed", summary: "x".repeat(5000) }]);
      await start(h, sent); await settle(h);
      expect(h.core.turnAgentReported(h.seed.coordinatorId, sent.turn_id)?.summary).toBe("x".repeat(4000));
      expect(() => h.core.turnAgentReported(h.seed.outsiderId, sent.turn_id)).toThrow();
    } finally { h.cleanup(); }
  });
});
