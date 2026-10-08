import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { callBridgeTool } from "../../src/bridge/tools.ts";
import { createHarness, start, settle } from "../helpers/harness.ts";

describe("trusted local read-only results", () => {
  it("retains completed output when a coordinator edits the shared checkout", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession({ access: "read_only" });
      const sent = h.sendTask(session.session_id, "read-only-result");
      h.adapter.plan(sent.turn_id, [
        { kind: "barrier", name: "external-editor" },
        { kind: "complete", outcome: "completed", summary: "Independent report. No agent edits." },
      ]);
      await start(h, sent);
      expect(h.adapter.pendingBarriers()).toContain("external-editor");
      writeFileSync(path.join(h.workspaceRoot, "src", "coordinator-note.md"), "Coordinator accepted decision.\n");
      h.adapter.releaseBarrier("external-editor");
      await settle(h);
      const result = await callBridgeTool({ core: h.core, coordinatorId: h.seed.coordinatorId }, "agent_turn_result", { turn_id: sent.turn_id }) as {
        execution_status: string; quality_status: string; full_message_artifact_id: string;
        broker_observed: { native_outcome: string; error_code: string | null; final_snapshot_id: string | null };
      };
      expect(result).toMatchObject({ execution_status: "SUCCEEDED", quality_status: "unreviewed",
        broker_observed: { native_outcome: "completed", error_code: null, final_snapshot_id: null },
      });
      expect(result.full_message_artifact_id).toBeTruthy();
      expect(h.core.artifactRead(h.seed.coordinatorId, result.full_message_artifact_id).data).toContain("Independent report. No agent edits.");
      expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM snapshot_records").get()).toMatchObject({ n: 0 });
      await expect(callBridgeTool({ core: h.core, coordinatorId: h.seed.outsiderId }, "agent_turn_result", { turn_id: sent.turn_id }))
        .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally { h.cleanup(); }
  });
});
