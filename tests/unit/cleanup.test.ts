import { describe, expect, it } from "vitest";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openRegistryDb } from "../../src/storage/db.ts";
import { previewCleanup, executeCleanup } from "../../src/storage/cleanup.ts";
import type { SnapshotManifest } from "../../src/shared/api-types.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function createTestHarness() {
  const dir = mkdtempSync(path.join(tmpdir(), "cleanup-test-"));
  const dbPath = path.join(dir, "registry.db");
  const blobPath = path.join(dir, "blobs");
  const db = openRegistryDb(dbPath);
  const blobs = openBlobStore(blobPath);
  const projectId = "proj-test";

  db.raw
    .prepare("INSERT INTO projects (project_id, display_name, created_at) VALUES (?, ?, ?)")
    .run(projectId, "Test Project", 1000);

  return {
    dir,
    db,
    blobs,
    projectId,
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("Operator cleanup and pin-aware blob GC (§15.3)", () => {
  it("preview distinguishes eligible and protected artifacts with pin reasons (§15.3.3)", () => {
    const h = createTestHarness();
    try {
      // 1. Create blobs
      const b1 = h.blobs.write(h.projectId, "blob content 1");
      const b2 = h.blobs.write(h.projectId, "blob content 2");
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, b1.hash, b1.size, 1000);
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, b2.hash, b2.size, 1000);

      // 2. Create an unpinned sealed artifact (eligible)
      h.db.raw
        .prepare(
          "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("art-unpinned", h.projectId, "findings", b1.hash, b1.size, "sealed", 1010, 1010);

      // 3. Create a pinned sealed artifact (protected)
      h.db.raw
        .prepare(
          "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("art-pinned", h.projectId, "findings", b2.hash, b2.size, "sealed", 1020, 1020);
      h.db.raw
        .prepare(
          "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("pin-1", "art-pinned", "active_turn", null, "turn-1", 1020);

      const preview = previewCleanup(h.db, h.blobs, h.projectId);

      expect(preview.eligible).toHaveLength(1);
      expect(preview.eligible[0].artifact_id).toBe("art-unpinned");
      expect(preview.eligible[0].size_bytes).toBe(b1.size);

      expect(preview.protected).toHaveLength(1);
      expect(preview.protected[0].artifact_id).toBe("art-pinned");
      expect(preview.protected[0].pins).toEqual([
        { root_kind: "active_turn", owner_session_id: null, owner_turn_id: "turn-1" },
      ]);

      expect(preview.retainedBlobHashes).toContain(b2.hash);
      expect(preview.retainedBlobHashes).not.toContain(b1.hash);
      expect(preview.reclaimableBytes).toBe(b1.size);
      expect(preview.reclaimableBlobCount).toBe(1);
      expect(preview.totalBlobBytes).toBe(b1.size + b2.size);
      expect(preview.totalBlobCount).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it("manifest file content hashes are respected in live and retained blob references (§15.3.3)", () => {
    const h = createTestHarness();
    try {
      // Create file blobs
      const fileBlob = h.blobs.write(h.projectId, "code content");
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, fileBlob.hash, fileBlob.size, 1000);

      // Create snapshot manifest referring to fileBlob
      const manifest: SnapshotManifest = {
        snapshot_id: "snap-1",
        project_id: h.projectId,
        workspace_id: "ws-1",
        coverage: { profile_id: "cov-1", version: "1", contract_hash: "ch1" },
        entries: [
          { path: "main.ts", type: "file", content_hash: fileBlob.hash, executable: false, size: fileBlob.size },
        ],
        source_digest: "digest-1",
        non_source_observed: [],
        protected_observed: [],
        excluded_observed: [],
        capture_consistency: "broker_exclusive",
        git_provenance: null,
        captured_at: 1000,
      };
      const manifestJson = JSON.stringify(manifest);
      const manifestBlob = h.blobs.write(h.projectId, manifestJson);
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, manifestBlob.hash, manifestBlob.size, 1000);

      // Insert sealed artifact for the manifest
      h.db.raw
        .prepare(
          "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("art-manifest", h.projectId, "snapshot_manifest", manifestBlob.hash, manifestBlob.size, "sealed", 1000, 1000);

      // Pin the manifest
      h.db.raw
        .prepare(
          "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("pin-m", "art-manifest", "session_anchor", "sess-1", null, 1000);

      const preview = previewCleanup(h.db, h.blobs, h.projectId);
      expect(preview.eligible).toHaveLength(0);
      expect(preview.protected).toHaveLength(1);
      // Both the manifest blob and the file blob inside the manifest must be retained!
      expect(preview.retainedBlobHashes).toContain(manifestBlob.hash);
      expect(preview.retainedBlobHashes).toContain(fileBlob.hash);
      expect(preview.reclaimableBytes).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("executeCleanup expires unpinned artifacts, re-checks pins, and GC deletes orphan blobs (§15.3.2)", () => {
    const h = createTestHarness();
    try {
      const b1 = h.blobs.write(h.projectId, "blob 1");
      const b2 = h.blobs.write(h.projectId, "blob 2");
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, b1.hash, b1.size, 1000);
      h.db.raw
        .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
        .run(h.projectId, b2.hash, b2.size, 1000);

      h.db.raw
        .prepare(
          "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("art-1", h.projectId, "report", b1.hash, b1.size, "sealed", 1000, 1000);

      h.db.raw
        .prepare(
          "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("art-2", h.projectId, "report", b2.hash, b2.size, "sealed", 1001, 1001);

      // Pin art-2 to simulate concurrent pin race
      h.db.raw
        .prepare(
          "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("pin-2", "art-2", "operator_hold", null, null, 1002);

      const res = executeCleanup(
        h.db,
        h.blobs,
        h.projectId,
        { artifact_ids: ["art-1", "art-2"] },
        2000,
      );

      expect(res.expiredArtifactIds).toEqual(["art-1"]);
      expect(res.skippedPinned).toEqual(["art-2"]);
      expect(res.deletedBlobHashes).toEqual([b1.hash]);
      expect(res.reclaimedBytes).toBe(b1.size);

      // Tombstone stays in artifacts table
      const art1Row = h.db.raw
        .prepare("SELECT state, expired_at FROM artifacts WHERE artifact_id = 'art-1'")
        .get() as { state: string; expired_at: number };
      expect(art1Row.state).toBe("expired");
      expect(art1Row.expired_at).toBe(2000);

      // Orphan blob deleted from store and registry
      expect(h.blobs.has(h.projectId, b1.hash)).toBe(false);
      expect(h.blobs.has(h.projectId, b2.hash)).toBe(true);

      const blob1Row = h.db.raw
        .prepare("SELECT * FROM blobs WHERE project_id = ? AND content_hash = ?")
        .get(h.projectId, b1.hash);
      expect(blob1Row).toBeUndefined();

      // Subsequent preview shows 0 reclaimable
      const preview2 = previewCleanup(h.db, h.blobs, h.projectId);
      expect(preview2.eligible).toHaveLength(0);
      expect(preview2.reclaimableBytes).toBe(0);
      expect(preview2.totalBlobBytes).toBe(b2.size);
      expect(preview2.totalBlobCount).toBe(1);
    } finally {
      h.cleanup();
    }
  });
});
