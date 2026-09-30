import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { insertWorkspace } from "../../src/storage/repo.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";

interface ManifestInputEntry {
  input_id: string;
  origin: string;
  artifact_id: string;
  content_hash: string;
  content_type: string;
  size_bytes: number;
  delivery: string;
}

interface ManifestDoc {
  inputs: ManifestInputEntry[];
}

describe("review turn derived inputs (§7.1.1, §9.4)", () => {
  it("reviewer receives baseline manifest + derived diff as required inputs", async () => {
    const h = createHarness();
    try {
      // 2. Seed a review-slot workspace bound to the same coverage profile
      insertWorkspace(h.db, {
        workspace_id: "ws-review",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      // 3. Spawn the reviewer session (metadata-only provisioning for review slots)
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review" },
      });
      expect(reviewer.state).toBe("IDLE");

      // 5. Worker snapshot baseline taken before workspace file is changed
      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = workerStatus.initial_snapshot_id;
      expect(baseline).toBeTruthy();

      // 4. Worker changes the code so a diff exists
      h.writeWorkspaceFile("src/main.c", "int main(){return 42;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-1",
      });
      expect(target.capture_state).toBe("SEALED");

      // 5. Send a review binding turn on the REVIEWER session
      const r1 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "review-1",
        task: {
          goal: "Review the diff.",
          acceptance_criteria: ["findings with refs"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: baseline!,
          target_snapshot_id: target.snapshot_id,
        },
      });

      // 6. Plan turn with barrier and start
      h.adapter.plan(r1.turn_id, [
        { kind: "barrier", name: "hold-review" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, r1);

      // 7. WHILE RUNNING (barrier held): verify input manifest and derived patch
      const turn = h.core.turnStatus(h.seed.coordinatorId, r1.turn_id);
      expect(turn.input_manifest_id).toBeTruthy();

      const artRow = h.db.raw
        .prepare("SELECT content_hash FROM artifacts WHERE artifact_id = ?")
        .get(turn.input_manifest_id!) as { content_hash: string };
      expect(artRow).toBeDefined();
      expect(artRow.content_hash).toBeTruthy();

      const blobs = openBlobStore(h.blobRoot);
      const manifest = JSON.parse(
        Buffer.from(blobs.read(h.seed.projectId, artRow.content_hash)).toString("utf8"),
      ) as ManifestDoc;

      expect(manifest.inputs).toHaveLength(2);
      const origins = manifest.inputs.map((entry) => entry.origin).sort();
      expect(origins).toEqual(["review_baseline", "review_diff"]);

      const reviewDiff = manifest.inputs.find((entry) => entry.origin === "review_diff");
      expect(reviewDiff).toBeDefined();
      expect(reviewDiff?.content_type).toBe("text/plain");
      expect(reviewDiff?.content_hash).toMatch(/^[0-9a-f]{64}$/);

      const diffBlobBytes = blobs.read(h.seed.projectId, reviewDiff!.content_hash);
      const diffText = Buffer.from(diffBlobBytes).toString("utf8");
      expect(diffText).toContain("+int main(){return 42;}");
      expect(diffText).toContain("-int main(){return 0;}");

      const patchCount = (
        h.db.raw.prepare("SELECT COUNT(*) c FROM artifacts WHERE kind='patch' AND state='sealed'").get() as {
          c: number;
        }
      ).c;
      expect(patchCount).toBeGreaterThanOrEqual(1);

      // 8. Release barrier and settle
      h.adapter.releaseBarrier("hold-review");
      await settle(h);

      const finalTurn = h.core.turnStatus(h.seed.coordinatorId, r1.turn_id);
      expect(finalTurn.state).toBe("SUCCEEDED");

      const reviewerStatus = h.core.sessionStatus(h.seed.coordinatorId, reviewer.session_id);
      expect(reviewerStatus.state).toBe("IDLE");

      expect(existsSync(path.join(h.inputRoot, r1.turn_id))).toBe(false);
    } finally {
      // 9. Cleanup
      h.cleanup();
    }
  });
});
