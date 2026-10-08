/**
 * Regression tests for the second P2 review pass:
 * - failed explicit capture is a durable idempotent operation (§10.1.1)
 * - external file edits do not veto trusted local execution
 * - ordinary turns pin task inputs without source snapshots
 */
import { describe, expect, it } from "vitest";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { insertWorkspace as insertWorkspaceDirect } from "../../src/storage/repo.ts";

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

describe("P2 review-fix regressions", () => {
  it("failed explicit capture is durable: same key replays the same FAILED capture (§10.1.1)", () => {
    const h = createHarness();
    try {
      // Workspace whose canonical path is a FILE, not a directory: capture
      // fails mid-run (ENOTDIR) → CaptureError → the broker records a
      // durable idempotent FAILED operation (no silent retry on replay).
      const filePath = path.join(h.workspaceRoot, "src", "main.c");
      insertWorkspaceDirect(h.db, {
        workspace_id: "ws-file",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: filePath,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const req = {
        project_id: h.seed.projectId,
        workspace_id: "ws-file",
        idempotency_key: "failed-cap-1",
      };

      const first = expectBrokerError(
        () => h.core.snapshot(h.seed.coordinatorId, req),
        "EVIDENCE_CAPTURE_FAILED",
      );
      const failedId = (first.details as { snapshot_id?: string }).snapshot_id;
      expect(failedId).toBeTruthy();

      // Replay with the SAME key returns the SAME failed capture — the
      // executed failure is an operation, not a free retry (§7.3).
      const replay = h.core.snapshot(h.seed.coordinatorId, req);
      expect(replay.replayed_request).toBe(true);
      expect(replay.capture_state).toBe("FAILED");
      expect(replay.snapshot_id).toBe(failedId);
      expect(replay.source_digest).toBeNull();

      const failed = h.db.raw
        .prepare("SELECT COUNT(*) c FROM snapshot_records WHERE state = 'FAILED'")
        .get() as { c: number };
      expect(failed.c).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("external file edits do not veto a trusted physical turn", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed" }]);

      // External write AFTER admission, BEFORE the executor starts.
      h.writeWorkspaceFile("src/main.c", "externally changed after admission");
      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.error_code).toBeNull();
      expect(turn.execution_started).toBe(true);
      expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBe(true);
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });

  it("physical turn pins only its input manifest and releases it at completion", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-pin" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      const pinCount = () =>
        (h.db.raw
          .prepare("SELECT COUNT(*) c FROM artifact_pins WHERE owner_turn_id = ? AND root_kind = 'active_turn'")
          .get(t1.turn_id) as { c: number }).c;

      // Ordinary turns seal the task input without capturing project files.
      expect(pinCount()).toBe(1);
      expect(h.db.raw.prepare("SELECT COUNT(*) c FROM snapshot_records").get()?.c).toBe(0);

      h.adapter.releaseBarrier("hold-pin");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
      expect(pinCount()).toBe(0); // released at terminal commit
    } finally {
      h.cleanup();
    }
  });
});
