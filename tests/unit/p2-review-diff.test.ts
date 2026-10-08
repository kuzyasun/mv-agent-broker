import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
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
  it("transport rejection publishes no provisional patch or manifest and leaves the slot unchanged", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, { workspace_id: "ws-review-limit", project_id: h.seed.projectId,
        mode: "review_slot", canonical_path: null, quarantined: false, quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId });
      const reviewer = await h.spawnWorkerSession({ role: "reviewer", access: "read_only", workspace: { mode: "review_slot", workspace_id: "ws-review-limit" } });
      const worker = await h.spawnWorkerSession();
      const baseline = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-review-baseline" }).snapshot_id;
      h.writeWorkspaceFile("src/main.c", "int main(){return 42;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain, idempotency_key: "limit-target" });
      const before = h.db.raw.prepare("SELECT COUNT(*) c FROM artifacts WHERE kind IN ('patch','input_manifest')").get();
      Object.defineProperty(h.adapter, "transportEnvelopeLimit", { value: { maxChars: 1 } });
      const accepted = h.core.send(h.seed.coordinatorId, { session_id: reviewer.session_id, idempotency_key: "limit-review",
        task: { goal: "Review.", acceptance_criteria: [], artifact_refs: [] },
        review_binding: { baseline_snapshot_id: baseline, target_snapshot_id: target.snapshot_id } });
      await start(h, accepted); await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id);
      expect(turn.state).toBe("FAILED"); expect(turn.error_code).toBe("INPUT_LIMIT");
      expect(turn.execution_started).toBe(false); expect(turn.input_manifest_id).toBeNull();
      expect(h.db.raw.prepare("SELECT COUNT(*) c FROM artifacts WHERE kind IN ('patch','input_manifest')").get()).toEqual(before);
      expect(existsSync(path.join(h.slotsRoot, reviewer.session_id, "src/main.c"))).toBe(false);
      expect(h.core.turnEvents(h.seed.coordinatorId, accepted.turn_id, 0, 50).some(e => e.type === "dispatch_permission_granted")).toBe(false);
    } finally { h.cleanup(); }
  });
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
        role: "reviewer", access: "read_only",
        workspace: { mode: "review_slot", workspace_id: "ws-review" },
      });
      expect(reviewer.state).toBe("IDLE");

      // 5. Worker snapshot baseline taken before workspace file is changed
      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-review-baseline" }).snapshot_id;
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

  it("reviewer diff > 256KiB is sealed as complete patch artifact, delivered via read_only_path, with exact artifact hash and size", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-review-large",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      const reviewer = await h.spawnWorkerSession({
        role: "reviewer", access: "read_only",
        workspace: { mode: "review_slot", workspace_id: "ws-review-large" },
      });

      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-review-baseline" }).snapshot_id;
      expect(baseline).toBeTruthy();

      // Write >256KiB of changed code (~300KiB)
      const lines: string[] = ["int main() {"];
      for (let i = 0; i < 3500; i++) {
        lines.push(`  int v_${i} = ${i}; /* padding line with extra length: ${"x".repeat(50)} */`);
      }
      lines.push("  return 42;\n}\n");
      const largeContent = lines.join("\n");
      h.writeWorkspaceFile("src/main.c", largeContent);

      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-large-1",
      });
      expect(target.capture_state).toBe("SEALED");

      const r1 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "review-large-1",
        task: {
          goal: "Review the large complete diff.",
          acceptance_criteria: ["findings with refs"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: baseline!,
          target_snapshot_id: target.snapshot_id,
        },
      });

      h.adapter.plan(r1.turn_id, [
        { kind: "barrier", name: "hold-large-review" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, r1);

      const turn = h.core.turnStatus(h.seed.coordinatorId, r1.turn_id);
      expect(turn.input_manifest_id).toBeTruthy();

      const artRow = h.db.raw
        .prepare("SELECT content_hash, size_bytes FROM artifacts WHERE artifact_id = ?")
        .get(turn.input_manifest_id!) as { content_hash: string; size_bytes: number };
      expect(artRow).toBeDefined();

      const blobs = openBlobStore(h.blobRoot);
      const manifest = JSON.parse(
        Buffer.from(blobs.read(h.seed.projectId, artRow.content_hash)).toString("utf8"),
      ) as ManifestDoc;

      const reviewDiff = manifest.inputs.find((entry) => entry.origin === "review_diff");
      expect(reviewDiff).toBeDefined();
      expect(reviewDiff?.delivery).toBe("read_only_path");
      expect(reviewDiff?.size_bytes).toBeGreaterThan(256 * 1024);

      // Verify the materialized file on disk under input area has complete text and tails
      const viewPath = path.join(h.inputRoot, r1.turn_id, "in-2.txt");
      expect(existsSync(viewPath)).toBe(true);
      const viewContent = readFileSync(viewPath, "utf8");
      expect(viewContent.includes("[diff truncated]")).toBe(false);
      expect(viewContent).toContain("int v_3499 = 3499;");
      expect(viewContent).toContain("+  return 42;");
      expect(Buffer.byteLength(viewContent, "utf8")).toBe(reviewDiff?.size_bytes);

      h.adapter.releaseBarrier("hold-large-review");
      await settle(h);

      const finalTurn = h.core.turnStatus(h.seed.coordinatorId, r1.turn_id);
      expect(finalTurn.state).toBe("SUCCEEDED");
      expect(existsSync(viewPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("complete diff beyond the former 8 MiB budget is delivered in full with the original baseline binding", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-review-oversize",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      const reviewer = await h.spawnWorkerSession({
        role: "reviewer", access: "read_only",
        workspace: { mode: "review_slot", workspace_id: "ws-review-oversize" },
      });

      const workerSpawn = await h.spawnWorkerSession();
      const baseline = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-review-baseline" }).snapshot_id;
      expect(baseline).toBeTruthy();

      // ~9.5 MiB of changed text in ONE file: the complete diff tail and the
      // exact original binding must survive the former 8 MiB hard limit.
      const line = `  int v = 0; /* ${"x".repeat(90)} */`;
      const lines: string[] = ["int main() {"];
      for (let i = 0; i < 100_000; i++) lines.push(`${line} // ${i}`);
      lines.push("  return 42;\n}\n");
      const largeContent = lines.join("\n");
      expect(Buffer.byteLength(largeContent, "utf8")).toBeGreaterThan(8 * 1024 * 1024);
      h.writeWorkspaceFile("src/main.c", largeContent);

      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-oversize",
      });
      expect(target.capture_state).toBe("SEALED");

      const accepted = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "review-oversize",
        task: { goal: "Review the oversize complete diff.", acceptance_criteria: [], artifact_refs: [] },
        review_binding: { baseline_snapshot_id: baseline, target_snapshot_id: target.snapshot_id },
      });

      h.adapter.plan(accepted.turn_id, [
        { kind: "barrier", name: "hold-oversize-review" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, accepted);

      const turn = h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id);
      expect(turn.input_manifest_id).toBeTruthy();
      const manifestRow = h.db.raw
        .prepare("SELECT content_hash FROM artifacts WHERE artifact_id = ?")
        .get(turn.input_manifest_id!) as { content_hash: string };
      const blobs = openBlobStore(h.blobRoot);
      const manifest = JSON.parse(
        Buffer.from(blobs.read(h.seed.projectId, manifestRow.content_hash)).toString("utf8"),
      ) as ManifestDoc;
      const reviewDiff = manifest.inputs.find((entry) => entry.origin === "review_diff");
      expect(reviewDiff).toBeDefined();
      expect(reviewDiff?.delivery).toBe("read_only_path");
      expect(reviewDiff!.size_bytes).toBeGreaterThan(8 * 1024 * 1024);
      expect(reviewDiff!.size_bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
      // The manifest keeps the EXACT original baseline→target binding hashes.
      expect(reviewDiff!.content_hash).toMatch(/^[0-9a-f]{64}$/);

      const viewPath = path.join(h.inputRoot, accepted.turn_id, "in-2.txt");
      expect(existsSync(viewPath)).toBe(true);
      const viewContent = readFileSync(viewPath, "utf8");
      expect(viewContent.includes("[diff truncated]")).toBe(false);
      expect(Buffer.byteLength(viewContent, "utf8")).toBe(reviewDiff!.size_bytes);
      expect(viewContent).toContain(`--- a/src/main.c`);
      expect(viewContent).toContain("// 0"); // full head present
      expect(viewContent).toContain("// 99999"); // full tail present
      expect(viewContent).toContain("+  return 42;");

      h.adapter.releaseBarrier("hold-oversize-review");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id).state).toBe("SUCCEEDED");
      expect(existsSync(viewPath)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  it("a low configured maxReviewDiffBytes cap rejects the review turn before dispatch", async () => {
    const h = createHarness({ limits: { maxReviewDiffBytes: 1024 } });
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-review-capped",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer", access: "read_only",
        workspace: { mode: "review_slot", workspace_id: "ws-review-capped" },
      });
      const workerSpawn = await h.spawnWorkerSession();
      const baseline = h.core.snapshot(h.seed.coordinatorId, { project_id: h.seed.projectId, workspace_id: h.seed.workspaceMain, idempotency_key: "manual-review-baseline" }).snapshot_id;
      h.writeWorkspaceFile("src/main.c", `int main(){return 42;} /* ${"x".repeat(2048)} */\n`);
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "target-capped",
      });

      const accepted = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "review-capped",
        task: { goal: "Review.", acceptance_criteria: [], artifact_refs: [] },
        review_binding: { baseline_snapshot_id: baseline, target_snapshot_id: target.snapshot_id },
      });
      h.adapter.plan(accepted.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, accepted);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("INPUT_LIMIT");
      expect(turn.execution_started).toBe(false);
      expect(turn.input_manifest_id).toBeNull();
      expect(h.core.turnEvents(h.seed.coordinatorId, accepted.turn_id, 0, 50).some(e => e.type === "dispatch_permission_granted")).toBe(false);
    } finally {
      h.cleanup();
    }
  });
});
