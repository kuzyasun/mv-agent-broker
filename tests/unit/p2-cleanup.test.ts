import { describe, expect, it } from "vitest";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { previewCleanup, executeCleanup } from "../../src/storage/cleanup.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { BrokerError } from "../../src/shared/errors.ts";

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

describe("cleanup and agent_artifact_read (§15.3, §10.1)", () => {
  it("A49: cleanup races with accepted-turn pins — pin wins while nonterminal, expiry frees the key afterwards", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const art = h.publishArtifact("some findings to fix");

      // Preview BEFORE send: eligible contains art.artifact_id, protected does NOT
      const prev1 = previewCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId);
      expect(prev1.eligible.some((e) => e.artifact_id === art.artifact_id)).toBe(true);
      expect(prev1.protected.some((p) => p.artifact_id === art.artifact_id)).toBe(false);

      // Send a turn that requires it
      const t1 = h.sendTask(spawn.session_id, "fix-1", "Fix.", {
        task: { goal: "Fix.", acceptance_criteria: ["x"], artifact_refs: [art.artifact_id] },
      });
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      // WHILE RUNNING: preview again → eligible does NOT contain art.artifact_id; protected DOES (root_kind active_turn)
      const prev2 = previewCleanup(h.db, openBlobStore(h.blobRoot), h.seed.projectId);
      expect(prev2.eligible.some((e) => e.artifact_id === art.artifact_id)).toBe(false);
      const prot = prev2.protected.find((p) => p.artifact_id === art.artifact_id);
      expect(prot).toBeDefined();
      expect(prot?.pins.some((pin) => pin.root_kind === "active_turn")).toBe(true);

      // Operator attempts cleanup anyway
      const res = executeCleanup(
        h.db,
        openBlobStore(h.blobRoot),
        h.seed.projectId,
        { artifact_ids: [art.artifact_id] },
        h.clock.now(),
      );
      expect(res.expiredArtifactIds).toEqual([]);
      expect(res.skippedPinned).toContain(art.artifact_id);
      expect(openBlobStore(h.blobRoot).has(h.seed.projectId, art.content_hash)).toBe(true);

      // Release barrier; settle; turn SUCCEEDED; active_turn pin released
      h.adapter.releaseBarrier("hold");
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");

      // Cleanup again → now expires
      const res2 = executeCleanup(
        h.db,
        openBlobStore(h.blobRoot),
        h.seed.projectId,
        { artifact_ids: [art.artifact_id] },
        h.clock.now(),
      );
      expect(res2.expiredArtifactIds).toContain(art.artifact_id);
      expect(openBlobStore(h.blobRoot).has(h.seed.projectId, art.content_hash)).toBe(false);

      // Replaying the old artifact through send now fails before inference
      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "fix-2", "Again.", {
            task: { goal: "Again.", acceptance_criteria: ["x"], artifact_refs: [art.artifact_id] },
          }),
        "ARTIFACT_EXPIRED",
      );

      // h.core.artifactRead throws BrokerError ARTIFACT_EXPIRED
      expectBrokerError(
        () => h.core.artifactRead(h.seed.coordinatorId, art.artifact_id),
        "ARTIFACT_EXPIRED",
      );
    } finally {
      h.cleanup();
    }
  });

  it("session anchors protect the initial baseline; retained manifests keep shared blobs alive", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const snap = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "snap-a",
      });
      expect(snap.capture_state).toBe("SEALED");

      const manifestArtifactIdOf = (snapshotId: string): string => {
        const row = h.db.raw
          .prepare("SELECT manifest_artifact_id FROM snapshot_records WHERE snapshot_id = ?")
          .get(snapshotId) as { manifest_artifact_id: string } | undefined;
        if (!row) throw new Error("snapshot record not found");
        return row.manifest_artifact_id;
      };

      const snapManifestArtId = manifestArtifactIdOf(snap.snapshot_id);
      const snapArtRow = h.db.raw
        .prepare("SELECT size_bytes, content_hash FROM artifacts WHERE artifact_id = ?")
        .get(snapManifestArtId) as { size_bytes: number; content_hash: string };

      const blobStore = openBlobStore(h.blobRoot);
      const preview = previewCleanup(h.db, blobStore, h.seed.projectId);

      // The explicit snapshot's manifest artifact IS eligible (no pins)
      expect(preview.eligible.some((e) => e.artifact_id === snapManifestArtId)).toBe(true);
      expect(preview.protected.some((p) => p.artifact_id === snapManifestArtId)).toBe(false);

      // Only the unpinned manifest JSON blob is reclaimable; all file blobs are shared
      // with the session's pinned initial snapshot and therefore retained (§15.3.1).
      expect(preview.reclaimableBytes).toBe(snapArtRow.size_bytes);
      expect(preview.reclaimableBlobCount).toBe(1);

      const res = executeCleanup(
        h.db,
        blobStore,
        h.seed.projectId,
        { artifact_ids: [snapManifestArtId] },
        h.clock.now(),
      );
      expect(res.expiredArtifactIds).toContain(snapManifestArtId);

      // Shared file blobs stay retained (§15.3.1 retained-manifest rule); only the unpinned
      // snapshot manifest blob was deleted.
      expect(res.deletedBlobHashes).toEqual([snapArtRow.content_hash]);

      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.initial_snapshot_id).toBeTruthy();
      const initialManifestArtId = manifestArtifactIdOf(session.initial_snapshot_id!);
      const initialArtRow = h.db.raw
        .prepare("SELECT content_hash FROM artifacts WHERE artifact_id = ?")
        .get(initialManifestArtId) as { content_hash: string };
      const initialManifestBytes = blobStore.read(h.seed.projectId, initialArtRow.content_hash);
      const initialManifest = JSON.parse(Buffer.from(initialManifestBytes).toString("utf8")) as {
        entries: Array<{ path: string; content_hash: string | null }>;
      };
      const initialFileHashOf = (relPath: string): string => {
        const entry = initialManifest.entries.find((e) => e.path === relPath);
        if (!entry || !entry.content_hash) throw new Error(`entry ${relPath} not found`);
        return entry.content_hash;
      };

      const mainHash = initialFileHashOf("src/main.c");
      expect(res.deletedBlobHashes).not.toContain(mainHash);
      expect(blobStore.has(h.seed.projectId, mainHash)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  it("agent_artifact_read: bounded page, offset, binary metadata-only, ACL", async () => {
    const h = createHarness();
    try {
      const art = h.publishArtifact("0123456789");

      // Full read
      const r = h.core.artifactRead(h.seed.coordinatorId, art.artifact_id);
      expect(r.content_type).toBe("text");
      expect(r.data).toBe("0123456789");
      expect(r.size_bytes).toBe(10);
      expect(r.truncated).toBe(false);

      // Page
      const r2 = h.core.artifactRead(h.seed.coordinatorId, art.artifact_id, {
        offset: 4,
        max_bytes: 3,
      });
      expect(r2.data).toBe("456");
      expect(r2.truncated).toBe(true);
      expect(r2.offset).toBe(4);

      // Binary metadata-only
      const binArt = h.publishArtifact("binary-content");
      h.db.raw
        .prepare("UPDATE artifacts SET kind = 'bundle' WHERE artifact_id = ?")
        .run(binArt.artifact_id);
      const rBin = h.core.artifactRead(h.seed.coordinatorId, binArt.artifact_id);
      expect(rBin.content_type).toBe("binary");
      expect(rBin.data).toBeNull();
      expect(rBin.size_bytes).toBe(binArt.size_bytes);

      // Outsider
      expectBrokerError(
        () => h.core.artifactRead(h.seed.outsiderId, art.artifact_id),
        "UNAUTHORIZED",
      );

      // Unknown id
      expectBrokerError(
        () => h.core.artifactRead(h.seed.coordinatorId, "art-none"),
        "UNAUTHORIZED",
      );
    } finally {
      h.cleanup();
    }
  });
});
