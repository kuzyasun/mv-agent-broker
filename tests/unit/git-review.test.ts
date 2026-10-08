/** Physical read-only review behavior: ordinary turns use the live checkout. */
import { describe, expect, it } from "vitest";
import { createHarness, settle, settleTurn, start } from "../helpers/harness.ts";
import { requiredSendBinding } from "../../src/core/broker.ts";
import { callBridgeTool, bridgeToolDefs } from "../../src/bridge/tools.ts";

describe("physical read-only reviews", () => {
  it("sends a plain task and succeeds after concurrent writes and external edits", async () => {
    const h = createHarness();
    try {
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        access: "read_only",
        account_profile_id: h.seed.accountMock3OtherQuota,
      });
      const writer = await h.spawnWorkerSession();
      const reviewerStatus = h.core.sessionStatus(h.seed.coordinatorId, reviewer.session_id);
      expect(h.core.sessionEffectivePolicy(h.seed.coordinatorId, reviewer.session_id)).toMatchObject({ access: "read_only" });
      expect(requiredSendBinding(reviewerStatus)).toBe("none");

      const review = h.sendTask(reviewer.session_id, "plain-review", "Review the current checkout.");
      h.adapter.plan(review.turn_id, [
        { kind: "barrier", name: "review-in-progress" },
        { kind: "complete", outcome: "completed", summary: "Review finished." },
      ]);
      await start(h, review);
      expect(h.adapter.pendingBarriers()).toContain("review-in-progress");

      const write = h.sendTask(writer.session_id, "concurrent-write", "Update the checkout.");
      h.adapter.plan(write.turn_id, [
        { kind: "workspace_write", files: [{ path: "docs/concurrent.md", content: "writer change\n" }] },
        { kind: "complete", outcome: "completed", summary: "Write finished." },
      ]);
      await start(h, write);
      await settleTurn(h, write.turn_id);
      expect(h.core.turnStatus(h.seed.coordinatorId, write.turn_id).state).toBe("SUCCEEDED");

      // An ordinary external edit also remains visible to the shared review.
      h.writeWorkspaceFile("README.md", "operator edit during review\n");
      h.adapter.releaseBarrier("review-in-progress");
      await settle(h);

      expect(h.core.turnStatus(h.seed.coordinatorId, review.turn_id)).toMatchObject({
        state: "SUCCEEDED",
        baseline_snapshot_id: null,
        review_target_snapshot_id: null,
        final_snapshot_id: null,
      });
      expect(h.core.turnReportArtifact(h.seed.coordinatorId, review.turn_id)?.kind).toBe("findings");
    } finally {
      h.cleanup();
    }
  });

  it("exposes plain physical sends and keeps snapshot review explicit", async () => {
    const sendDef = bridgeToolDefs().find((definition) => definition.name === "agent_session_send")!;
    const schema = sendDef.inputSchema as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty("workspace_precondition");
    expect(schema.properties).not.toHaveProperty("git_review_binding");
    expect(schema.properties).toHaveProperty("review_binding");

    const h = createHarness();
    try {
      const reviewer = await h.spawnWorkerSession({ role: "reviewer", access: "read_only" });
      const result = await callBridgeTool(
        { coordinatorId: h.seed.coordinatorId, core: h.core },
        "agent_session_status",
        { session_id: reviewer.session_id },
      ) as { required_send_binding: string };
      expect(result.required_send_binding).toBe("none");
    } finally {
      h.cleanup();
    }
  });
});
