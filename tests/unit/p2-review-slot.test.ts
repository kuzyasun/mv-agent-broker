import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { insertWorkspace } from "../../src/storage/repo.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openReviewSlotStore } from "../../src/workspaces/slot.ts";
import type { SnapshotManifest } from "../../src/shared/api-types.ts";

function walkFiles(dir: string, base = ""): string[] {
  const current = base ? path.join(dir, base) : dir;
  const entries = readdirSync(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...walkFiles(dir, rel));
    } else {
      files.push(rel);
    }
  }
  return files;
}


describe("stable review slot (§9.3)", () => {
  it("R1 sees S1 in the stable cwd; after fix R2 sees exactly S2; worker checkout untouched", async () => {
    const h = createHarness();
    try {
      // 1. Seed "ws-review" review_slot workspace
      insertWorkspace(h.db, {
        workspace_id: "ws-review",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });

      // 2. Spawn the reviewer session
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review" },
      });
      expect(reviewer.state).toBe("IDLE");

      // 3. Spawn worker session and get baseline snapshot
      const workerSpawn = await h.spawnWorkerSession();
      const workerStatus = h.core.sessionStatus(h.seed.coordinatorId, workerSpawn.session_id);
      const baseline = workerStatus.initial_snapshot_id;
      expect(baseline).toBeTruthy();

      // 4. Worker changes code so target1 snapshot can be taken
      h.writeWorkspaceFile("src/main.c", "int main(){return 42;}\n");
      h.writeWorkspaceFile("src/extra.c", "int extra;\n");
      const target1 = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "s1",
      });
      expect(target1.capture_state).toBe("SEALED");

      // 5. Review turn 1
      const r1 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "r1",
        task: {
          goal: "Review S1.",
          acceptance_criteria: ["refs"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: baseline!,
          target_snapshot_id: target1.snapshot_id,
        },
      });

      h.adapter.plan(r1.turn_id, [
        { kind: "barrier", name: "hold-r1" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, r1);

      const slot = path.join(h.slotsRoot, reviewer.session_id);
      // WHILE RUNNING
      expect(readFileSync(path.join(slot, "src", "main.c"), "utf8")).toBe("int main(){return 42;}\n");
      expect(readFileSync(path.join(slot, "src", "extra.c"), "utf8")).toBe("int extra;\n");

      h.adapter.releaseBarrier("hold-r1");
      await settle(h);

      const turn1 = h.core.turnStatus(h.seed.coordinatorId, r1.turn_id);
      expect(turn1.state).toBe("SUCCEEDED");

      const ref1 = h.core.sessionStatus(h.seed.coordinatorId, reviewer.session_id).native_conversation_ref;

      // 6. Fix cycle — worker adds a new file and deletes one
      h.writeWorkspaceFile("src/parser/new.c", "int parser;\n");
      rmSync(path.join(h.workspaceRoot, "src", "extra.c"));
      h.writeWorkspaceFile("src/main.c", "int main(){return 7;}\n");

      const target2 = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "s2",
      });
      expect(target2.capture_state).toBe("SEALED");

      // 7. Review turn 2 SAME reviewer session (native conversation continues)
      const r2 = h.core.send(h.seed.coordinatorId, {
        session_id: reviewer.session_id,
        idempotency_key: "r2",
        task: {
          goal: "Review S2.",
          acceptance_criteria: ["refs"],
          artifact_refs: [],
        },
        review_binding: {
          baseline_snapshot_id: target1.snapshot_id,
          target_snapshot_id: target2.snapshot_id,
        },
      });

      h.adapter.plan(r2.turn_id, [
        { kind: "barrier", name: "hold-r2" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, r2);

      // WHILE RUNNING the slot contains EXACTLY the S2 tree
      const manifestRow = h.db.raw
        .prepare(
          "SELECT content_hash FROM artifacts WHERE artifact_id = (SELECT manifest_artifact_id FROM snapshot_records WHERE snapshot_id = ?)",
        )
        .get(target2.snapshot_id) as { content_hash: string };
      const manifestBytes = openBlobStore(h.blobRoot).read(h.seed.projectId, manifestRow.content_hash);
      const manifest = JSON.parse(Buffer.from(manifestBytes).toString("utf8")) as SnapshotManifest;
      const expectedFileEntries = manifest.entries.filter((e) => e.type === "file");
      const expectedFiles = expectedFileEntries.map((e) => e.path).sort();

      const actualFiles = walkFiles(slot).sort();
      expect(actualFiles).toEqual(expectedFiles);

      for (const entry of expectedFileEntries) {
        const actualBytes = readFileSync(path.join(slot, entry.path));
        const expectedBytes = openBlobStore(h.blobRoot).read(h.seed.projectId, entry.content_hash!);
        expect(new Uint8Array(actualBytes)).toEqual(expectedBytes);
      }

      h.adapter.releaseBarrier("hold-r2");
      await settle(h);

      const turn2 = h.core.turnStatus(h.seed.coordinatorId, r2.turn_id);
      expect(turn2.state).toBe("SUCCEEDED");
      expect(turn2.continuation).toBe("native_resume");

      const reviewerStatus = h.core.sessionStatus(h.seed.coordinatorId, reviewer.session_id);
      expect(reviewerStatus.state).toBe("IDLE");
      expect(reviewerStatus.native_conversation_ref).toBe(ref1);

      // 8. Worker checkout untouched by slot refresh
      expect(readFileSync(path.join(h.workspaceRoot, "src", "parser", "new.c"), "utf8")).toBe("int parser;\n");
      expect(existsSync(path.join(h.workspaceRoot, "src", "main.c"))).toBe(true);
      expect(readFileSync(path.join(h.workspaceRoot, "src", "main.c"), "utf8")).toBe("int main(){return 7;}\n");
    } finally {
      // 9. Cleanup
      h.cleanup();
    }
  });
});

function makeManifest(entries: SnapshotManifest["entries"]): SnapshotManifest {
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

describe("review slot store guards", () => {
  it("traversal rejects dangerous entry paths", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-test-"));
    try {
      const store = openReviewSlotStore(tmpDir);
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "../escape", type: "file", content_hash: "h", executable: false, size: 0 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "/abs", type: "file", content_hash: "h", executable: false, size: 0 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "C:/x", type: "file", content_hash: "h", executable: false, size: 0 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "a\\b", type: "file", content_hash: "h", executable: false, size: 0 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "a/../b", type: "file", content_hash: "h", executable: false, size: 0 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("unknown entry type throws", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-test-"));
    try {
      const store = openReviewSlotStore(tmpDir);
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([{ path: "x", type: "weird" as never, content_hash: null, executable: false, size: 1 }]),
          () => new Uint8Array(),
        ),
      ).toThrow();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("case-folded duplicate on win32 throws", () => {
    if (process.platform === "win32") {
      const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-test-"));
      try {
        const store = openReviewSlotStore(tmpDir);
        expect(() =>
          store.refresh(
            "sess-1",
            makeManifest([
              { path: "src/A.c", type: "file", content_hash: "h1", executable: false, size: 0 },
              { path: "src/a.c", type: "file", content_hash: "h2", executable: false, size: 0 },
            ]),
            () => new Uint8Array(),
          ),
        ).toThrow();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  });

  it("successful refresh writes bytes + exec-bit best effort", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-test-"));
    try {
      const store = openReviewSlotStore(tmpDir);
      const res = store.refresh(
        "sess-1",
        makeManifest([
          { path: "src", type: "dir", content_hash: null, executable: false, size: null },
          { path: "src/a.c", type: "file", content_hash: "deadbeef", executable: true, size: 5 },
        ]),
        (h) => {
          if (h === "deadbeef") return Buffer.from("hello", "utf8");
          throw new Error("unexpected hash: " + h);
        },
      );
      expect(res).toEqual({ files: 1 });
      const content = readFileSync(path.join(store.slotPath("sess-1"), "src", "a.c"), "utf8");
      expect(content).toBe("hello");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("readBlob failure propagates error", () => {
    const tmpDir = mkdtempSync(path.join(tmpdir(), "review-slot-test-"));
    try {
      const store = openReviewSlotStore(tmpDir);
      expect(() =>
        store.refresh(
          "sess-1",
          makeManifest([
            { path: "src/a.c", type: "file", content_hash: "deadbeef", executable: false, size: 10 },
          ]),
          () => {
            throw new Error("BLOB_READ_FAILED");
          },
        ),
      ).toThrow("BLOB_READ_FAILED");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

