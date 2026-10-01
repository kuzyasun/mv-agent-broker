/**
 * Required-input integrity: same-size blob corruption and irregular owned
 * inodes must fail closed BEFORE acquireDispatchPermission / native call.
 * Exercises broker execution (TurnExecutor + MockAdapter), not helpers alone.
 */
import { describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { insertWorkspace } from "../../src/storage/repo.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openInputViewStore } from "../../src/inputs/views.ts";
import { openReviewSlotStore } from "../../src/workspaces/slot.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import type { SnapshotManifest } from "../../src/shared/api-types.ts";
import type { TurnInputManifest } from "../../src/inputs/manifest.ts";
import type { TurnExecutionRequest } from "../../src/runtime/adapter.ts";

function blobPath(h: ReturnType<typeof createHarness>, hash: string): string {
  return path.join(h.blobRoot, h.seed.projectId, hash.slice(0, 2), hash);
}

/** Same-length EVIL under GOOD content address (the coordinator frozen fixture). */
function overwriteSameSize(file: string, evil: string): void {
  const original = readFileSync(file);
  const evilBuf = Buffer.from(evil, "utf8");
  expect(evilBuf.byteLength).toBe(original.byteLength);
  writeFileSync(file, evilBuf);
}

function countNativeCalls(h: ReturnType<typeof createHarness>): {
  spy: ReturnType<typeof vi.spyOn>;
  calls: () => number;
} {
  const spy = vi.spyOn(h.adapter, "executeTurn");
  return { spy, calls: () => spy.mock.calls.length };
}

async function expectPreDispatchFailure(
  h: ReturnType<typeof createHarness>,
  turnId: string,
  code: string,
  native: { calls: () => number },
): Promise<void> {
  await settle(h);
  const turn = h.core.turnStatus(h.seed.coordinatorId, turnId);
  expect(turn.state).toBe("FAILED");
  expect(turn.error_code).toBe(code);
  expect(turn.execution_started).toBe(false);
  expect(turn.input_manifest_id).toBeNull();
  expect(h.adapter.dispatchPermissionAcquired(turnId)).toBeNull();
  expect(native.calls()).toBe(0);
}

function makeSlotManifest(entries: SnapshotManifest["entries"]): SnapshotManifest {
  return {
    snapshot_id: "snap-1",
    project_id: "proj-1",
    workspace_id: "ws-1",
    coverage: { profile_id: "p", version: "1", contract_hash: "c" },
    entries,
    source_digest: "d",
    non_source_observed: [],
    protected_observed: [],
    excluded_observed: [],
    capture_consistency: "broker_exclusive",
    git_provenance: null,
    captured_at: 1,
  };
}

describe("required-input integrity (same-size / irregular)", () => {
  it("same-size corruption of inline required artifact: ARTIFACT_CORRUPT, zero native calls", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const good = "GOOD-INLINE-BYTES!!"; // 18
      const evil = "EVIL-INLINE-BYTES!!"; // 18
      const art = h.publishArtifact(good);
      const sent = h.sendTask(spawn.session_id, "int-inline-evil", "Use findings.", {
        task: { goal: "Use findings.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      overwriteSameSize(blobPath(h, art.content_hash), evil);
      // Unverified read would return EVIL under GOOD address.
      expect(Buffer.from(openBlobStore(h.blobRoot).read(h.seed.projectId, art.content_hash)).toString("utf8")).toBe(evil);
      await start(h, sent);
      await expectPreDispatchFailure(h, sent.turn_id, "ARTIFACT_CORRUPT", native);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("same-size corruption of large path-delivered artifact: ARTIFACT_CORRUPT, zero native calls", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const good = "G".repeat(17 * 1024);
      const evil = "E".repeat(17 * 1024);
      const art = h.publishArtifact(good);
      const sent = h.sendTask(spawn.session_id, "int-path-evil", "Use big input.", {
        task: { goal: "Use big input.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      overwriteSameSize(blobPath(h, art.content_hash), evil);
      await start(h, sent);
      await expectPreDispatchFailure(h, sent.turn_id, "ARTIFACT_CORRUPT", native);
      expect(existsSync(path.join(h.inputRoot, sent.turn_id))).toBe(false);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("positive inline delivery: succeeds; executeTurn envelope contains original inline bytes", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const body = "honest-inline-payload\n";
      const art = h.publishArtifact(body);
      const sent = h.sendTask(spawn.session_id, "int-inline-ok", "Use findings.", {
        task: { goal: "Use findings.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(native.calls()).toBe(1);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBe(true);
      const req = native.spy.mock.calls[0]![0] as TurnExecutionRequest;
      expect(req.task_envelope).toContain(body);
      expect(req.task_envelope).toContain(`sha256=${art.content_hash}`);
      expect(turn.input_manifest_id).toBeTruthy();
      const manifestArt = h.core.artifactRead(h.seed.coordinatorId, turn.input_manifest_id!);
      expect(manifestArt.data).toBeTruthy();
      const manifest = JSON.parse(manifestArt.data!) as {
        manifest_hash: string;
        inputs: Array<{ delivery: string; content_hash: string; size_bytes: number }>;
      };
      expect(manifest.inputs).toHaveLength(1);
      expect(manifest.inputs[0]!.delivery).toBe("inline");
      expect(manifest.inputs[0]!.content_hash).toBe(art.content_hash);
      expect(manifest.inputs[0]!.size_bytes).toBe(art.size_bytes);
      expect(manifest.inputs[0]!.content_hash).toBe(sha256Hex(body));
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("positive path delivery: view bytes equal sealed content; manifest hash retained", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const body = "P".repeat(17 * 1024);
      const art = h.publishArtifact(body);
      const sent = h.sendTask(spawn.session_id, "int-path-ok", "Use big input.", {
        task: { goal: "Use big input.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      h.adapter.plan(sent.turn_id, [
        { kind: "barrier", name: "hold-path-ok" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, sent);
      const viewPath = path.join(h.inputRoot, sent.turn_id, "in-1.txt");
      expect(readFileSync(viewPath, "utf8")).toBe(body);
      expect(sha256Hex(readFileSync(viewPath))).toBe(art.content_hash);
      expect(lstatSync(viewPath).nlink).toBe(1);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      const manifestArt = h.core.artifactRead(h.seed.coordinatorId, turn.input_manifest_id!);
      const manifest = JSON.parse(manifestArt.data!) as {
        inputs: Array<{ delivery: string; content_hash: string; size_bytes: number }>;
      };
      expect(manifest.inputs[0]!.delivery).toBe("read_only_path");
      expect(manifest.inputs[0]!.content_hash).toBe(art.content_hash);
      expect(manifest.inputs[0]!.size_bytes).toBe(body.length);
      h.adapter.releaseBarrier("hold-path-ok");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("blob replaced by file symlink: refuses before native dispatch", async (ctx) => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("symlink-fixture-body");
      const sent = h.sendTask(spawn.session_id, "int-symlink", "Use findings.", {
        task: { goal: "Use findings.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      const target = blobPath(h, art.content_hash);
      const outside = path.join(h.blobRoot, "outside-symlink-target.bin");
      writeFileSync(outside, readFileSync(target));
      rmSync(target);
      try {
        symlinkSync(outside, target, "file");
      } catch {
        native.spy.mockRestore();
        ctx.skip("symlink creation unavailable on this platform/privileges");
        return;
      }
      await start(h, sent);
      await expectPreDispatchFailure(h, sent.turn_id, "ARTIFACT_CORRUPT", native);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("blob-prefix ancestor junction to owned physical dir: refuses before native dispatch", async (ctx) => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("directory-fixture-body");
      const sent = h.sendTask(spawn.session_id, "int-dir", "Use findings.", {
        task: { goal: "Use findings.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      const target = blobPath(h, art.content_hash);
      const prefixDir = path.dirname(target);
      const physical = path.join(h.blobRoot, "owned-physical-prefix");
      mkdirSync(physical, { recursive: true });
      // Move the real blob file into the physical prefix stand-in, then replace
      // the store prefix with a junction/symlink pointing at that owned dir.
      renameSync(target, path.join(physical, path.basename(target)));
      rmSync(prefixDir, { recursive: true, force: true });
      try {
        symlinkSync(physical, prefixDir, process.platform === "win32" ? "junction" : "dir");
      } catch {
        native.spy.mockRestore();
        ctx.skip("directory junction/symlink creation unavailable on this platform/privileges");
        return;
      }
      expect(lstatSync(prefixDir).isSymbolicLink()).toBe(true);
      await start(h, sent);
      await expectPreDispatchFailure(h, sent.turn_id, "ARTIFACT_CORRUPT", native);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("hardlinked blob inode: refuses before native dispatch", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("hardlink-fixture-body");
      const sent = h.sendTask(spawn.session_id, "int-hardlink", "Use findings.", {
        task: { goal: "Use findings.", acceptance_criteria: ["done"], artifact_refs: [art.artifact_id] },
      });
      const target = blobPath(h, art.content_hash);
      const alias = path.join(h.blobRoot, "owned-hardlink-fixture");
      linkSync(target, alias);
      await start(h, sent);
      await expectPreDispatchFailure(h, sent.turn_id, "ARTIFACT_CORRUPT", native);
      rmSync(alias, { force: true });
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("view callback wrong bytes: refuses before file publish", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "input-view-int-"));
    try {
      const store = openInputViewStore(tmpDir);
      const turnId = "turn-wrong-bytes";
      const root = store.turnRoot(turnId);
      const binding = path.join(root, "in-1.txt");
      const good = Buffer.from("expected-view-bytes", "utf8");
      const hash = sha256Hex(good);
      const manifest: TurnInputManifest = {
        manifest_version: 1,
        turn_id: turnId,
        session_id: "sess-1",
        policy_binding: { policy_profile_id: "p", policy_profile_version: "1" },
        workspace_binding: { workspace_id: "ws", expected_snapshot_id: "snap" },
        inputs: [
          {
            input_id: "in-1",
            origin: "task_artifact",
            artifact_id: "art-1",
            content_type: "text/plain",
            content_hash: hash,
            size_bytes: good.byteLength,
            delivery: "read_only_path",
            binding,
            access_enforcement: "enforced",
            lifetime: "turn_until_quiescence",
          },
        ],
        created_at: 1,
        manifest_hash: "m",
      };
      expect(() =>
        store.materialize(manifest, () => Buffer.from("WRONG-view-bytes!!!!", "utf8")),
      ).toThrow("INPUT_VIEW_BYTES_MISMATCH");
      expect(existsSync(binding)).toBe(false);
      expect(existsSync(`${binding}.tmp-${turnId}`)).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("malformed slot SHA refusal leaves prior slot contents untouched", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-int-"));
    try {
      const store = openReviewSlotStore(tmpDir);
      const body = Buffer.from("hello", "utf8");
      const goodHash = sha256Hex(body);
      store.refresh(
        "sess-keep",
        makeSlotManifest([
          { path: "src", type: "dir", content_hash: null, executable: false, size: null },
          { path: "src/a.c", type: "file", content_hash: goodHash, executable: false, size: body.byteLength },
        ]),
        (h) => {
          if (h === goodHash) return body;
          throw new Error("unexpected hash");
        },
      );
      const prior = path.join(store.slotPath("sess-keep"), "src", "a.c");
      expect(readFileSync(prior, "utf8")).toBe("hello");

      expect(() =>
        store.refresh(
          "sess-keep",
          makeSlotManifest([
            { path: "src/b.c", type: "file", content_hash: "deadbeef", executable: false, size: 4 },
          ]),
          () => Buffer.from("nope"),
        ),
      ).toThrow("SLOT_ENTRY_INVALID_HASH");
      expect(readFileSync(prior, "utf8")).toBe("hello");
      expect(existsSync(path.join(store.slotPath("sess-keep"), "src", "b.c"))).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("review target manifest same-size corruption: ARTIFACT_CORRUPT before native; slot untouched", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      insertWorkspace(h.db, {
        workspace_id: "ws-review-manifest",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-manifest" },
      });
      const worker = await h.spawnWorkerSession();
      const baseline = h.core.sessionStatus(h.seed.coordinatorId, worker.session_id).initial_snapshot_id!;
      h.writeWorkspaceFile("src/main.c", "int main(){return 11;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "int-manifest-s1",
      });
      expect(target.capture_state).toBe("SEALED");

      const sent = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "int-r-manifest",
        task: { goal: "Review S1.", acceptance_criteria: ["refs"], artifact_refs: [] },
        review_binding: {
          baseline_snapshot_id: baseline,
          target_snapshot_id: target.snapshot_id,
        },
      });

      const manifestRow = h.db.raw
        .prepare(
          "SELECT content_hash, size_bytes FROM artifacts WHERE artifact_id = (SELECT manifest_artifact_id FROM snapshot_records WHERE snapshot_id = ?)",
        )
        .get(target.snapshot_id) as { content_hash: string; size_bytes: number };
      const manifestPath = blobPath(h, manifestRow.content_hash);
      const original = readFileSync(manifestPath);
      expect(original.byteLength).toBe(manifestRow.size_bytes);
      // Same-size corruption retains the stored artifact hash while altering
      // manifest bytes that would otherwise rewrite the review slot tree.
      overwriteSameSize(manifestPath, "X".repeat(original.byteLength));
      expect(Buffer.from(openBlobStore(h.blobRoot).read(h.seed.projectId, manifestRow.content_hash)).toString("utf8")).not.toContain("src/main.c");

      const slotBefore = path.join(h.slotsRoot, reviewer.session_id);
      const marker = path.join(slotBefore, "pre-existing-marker.txt");
      mkdirSync(slotBefore, { recursive: true });
      writeFileSync(marker, "retain-me");

      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("ARTIFACT_CORRUPT");
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
      expect(native.calls()).toBe(0);
      expect(readFileSync(marker, "utf8")).toBe("retain-me");
      expect(existsSync(path.join(slotBefore, "src", "main.c"))).toBe(false);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("review slot source missing/hash-mismatch: fails before native; zero calls", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      insertWorkspace(h.db, {
        workspace_id: "ws-review-int",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-int" },
      });
      const worker = await h.spawnWorkerSession();
      const baseline = h.core.sessionStatus(h.seed.coordinatorId, worker.session_id).initial_snapshot_id!;
      h.writeWorkspaceFile("src/main.c", "int main(){return 99;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "int-s1",
      });
      expect(target.capture_state).toBe("SEALED");

      const manifestRow = h.db.raw
        .prepare(
          "SELECT content_hash FROM artifacts WHERE artifact_id = (SELECT manifest_artifact_id FROM snapshot_records WHERE snapshot_id = ?)",
        )
        .get(target.snapshot_id) as { content_hash: string };
      const manifest = JSON.parse(
        Buffer.from(openBlobStore(h.blobRoot).read(h.seed.projectId, manifestRow.content_hash)).toString("utf8"),
      ) as SnapshotManifest;
      const fileEntry = manifest.entries.find((e) => e.type === "file" && e.path === "src/main.c");
      expect(fileEntry?.content_hash).toBeTruthy();

      const sent = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "int-r1",
        task: { goal: "Review S1.", acceptance_criteria: ["refs"], artifact_refs: [] },
        review_binding: {
          baseline_snapshot_id: baseline,
          target_snapshot_id: target.snapshot_id,
        },
      });

      // Same-size EVIL under GOOD source content address for the review slot tree.
      const goodPath = blobPath(h, fileEntry!.content_hash!);
      const good = readFileSync(goodPath);
      overwriteSameSize(goodPath, "E".repeat(good.byteLength));

      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(["ARTIFACT_CORRUPT", "EVIDENCE_CAPTURE_FAILED"]).toContain(turn.error_code);
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
      expect(native.calls()).toBe(0);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });

  it("review slot source blob deleted: fails before native", async () => {
    const h = createHarness();
    try {
      const native = countNativeCalls(h);
      insertWorkspace(h.db, {
        workspace_id: "ws-review-miss",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review-miss" },
      });
      const worker = await h.spawnWorkerSession();
      const baseline = h.core.sessionStatus(h.seed.coordinatorId, worker.session_id).initial_snapshot_id!;
      h.writeWorkspaceFile("src/main.c", "int main(){return 7;}\n");
      const target = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "int-miss-s1",
      });
      const manifestRow = h.db.raw
        .prepare(
          "SELECT content_hash FROM artifacts WHERE artifact_id = (SELECT manifest_artifact_id FROM snapshot_records WHERE snapshot_id = ?)",
        )
        .get(target.snapshot_id) as { content_hash: string };
      const manifest = JSON.parse(
        Buffer.from(openBlobStore(h.blobRoot).read(h.seed.projectId, manifestRow.content_hash)).toString("utf8"),
      ) as SnapshotManifest;
      const fileEntry = manifest.entries.find((e) => e.type === "file" && e.path.endsWith("main.c"));
      expect(fileEntry?.content_hash).toBeTruthy();

      const sent = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "int-r-miss",
        task: { goal: "Review missing.", acceptance_criteria: ["refs"], artifact_refs: [] },
        review_binding: {
          baseline_snapshot_id: baseline,
          target_snapshot_id: target.snapshot_id,
        },
      });
      rmSync(blobPath(h, fileEntry!.content_hash!), { force: true });
      await start(h, sent);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(["ARTIFACT_CORRUPT", "EVIDENCE_CAPTURE_FAILED"]).toContain(turn.error_code);
      expect(turn.execution_started).toBe(false);
      expect(native.calls()).toBe(0);
      native.spy.mockRestore();
    } finally {
      h.cleanup();
    }
  });
});
