/**
 * Operator cleanup and pin-aware blob GC (spec §15.3).
 *
 * Implements preview and confirmed execution for operator-driven artifact
 * expiration and content-addressed blob garbage collection (§15.3.3).
 *
 * Pin roots (§15.3.1) and atomic admission/cleanup races (§15.3.2) ensure
 * that no evidence required by active turns, open sessions, or unresolved
 * intents is purged. Expired artifacts remain as metadata tombstones (§15.3.3).
 */
import { Buffer } from "node:buffer";
import type { RegistryDb } from "./db.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import type { SnapshotManifest } from "../shared/api-types.ts";

export interface CleanupEligibleArtifact {
  artifact_id: string;
  kind: string;
  content_hash: string | null;
  size_bytes: number | null;
  created_at: number;
}

export interface CleanupProtectedItem {
  artifact_id: string;
  pins: Array<{
    root_kind: string;
    owner_session_id: string | null;
    owner_turn_id: string | null;
  }>;
}

export interface CleanupPreview {
  eligible: CleanupEligibleArtifact[];
  protected: CleanupProtectedItem[];
  /** Blob hashes still referenced if all eligible artifacts were expired (i.e. NOT reclaimable). */
  retainedBlobHashes: string[];
  /** Unique blob bytes that would be reclaimed by expiring the eligible set. */
  reclaimableBytes: number;
  reclaimableBlobCount: number;
  totalBlobBytes: number;
  totalBlobCount: number;
  /** Retained manifests whose blob could not be read/parsed — the reclaimable estimate is untrusted (fail-closed). */
  unreadableManifests: string[];
}

export interface CleanupResult {
  expiredArtifactIds: string[];
  /** Selection items skipped at execution time: pinned, or not sealed/not found (§15.3.2 re-check). */
  skippedPinned: string[];
  deletedBlobHashes: string[];
  reclaimedBytes: number;
  /** Set when the blob-GC phase was skipped for safety (fail-closed). */
  gcSkippedReason?: string;
}

interface ArtifactRow {
  artifact_id: string;
  kind: string;
  content_hash: string | null;
  size_bytes: number | null;
  state: string;
  created_at: number;
}

/**
 * Scan all non-expired artifacts and parse snapshot manifests to discover
 * all live blob content_hashes referenced by this set of artifacts (§15.3.3).
 *
 * Fail-closed: a retained snapshot_manifest whose blob cannot be READ or
 * PARSED is reported in `unreadableManifests` instead of silently dropping
 * its file-blob references — callers must NOT delete blobs in that case
 * (§15.3.1: a retained object keeps every blob needed to read it fully).
 */
function collectBlobReferences(
  blobs: BlobStore,
  projectId: string,
  artifacts: ArtifactRow[],
): { refs: Set<string>; unreadableManifests: string[] } {
  const refs = new Set<string>();
  const unreadableManifests: string[] = [];
  for (const art of artifacts) {
    if (art.state === "expired") continue;
    if (art.content_hash) {
      refs.add(art.content_hash);
    }
    // Manifest entries reference content blobs not directly in SQL (§15.3.3).
    if (art.kind === "snapshot_manifest" && art.content_hash) {
      try {
        const bytes = blobs.read(projectId, art.content_hash);
        const text = Buffer.from(bytes).toString("utf8");
        const manifest = JSON.parse(text) as SnapshotManifest;
        if (Array.isArray(manifest.entries)) {
          for (const entry of manifest.entries) {
            if (entry && typeof entry.content_hash === "string" && entry.content_hash.length > 0) {
              refs.add(entry.content_hash);
            }
          }
        } else {
          unreadableManifests.push(art.artifact_id);
        }
      } catch {
        unreadableManifests.push(art.artifact_id);
      }
    }
  }
  return { refs, unreadableManifests };
}

/**
 * Operator preview (§15.3.3): sealed artifacts with ZERO pins are eligible;
 * pinned ones are listed as protected with their pin reasons. Blob references =
 * content_hash of every non-expired artifact PLUS file content_hashes parsed from
 * every non-expired snapshot_manifest artifact's JSON.
 */
export function previewCleanup(db: RegistryDb, blobs: BlobStore, projectId: string): CleanupPreview {
  const rawArtRows = db.raw
    .prepare(
      "SELECT artifact_id, kind, content_hash, size_bytes, state, created_at FROM artifacts WHERE project_id = ?",
    )
    .all(projectId) as Array<Record<string, unknown>>;

  const allArtifacts: ArtifactRow[] = rawArtRows.map((r) => ({
    artifact_id: String(r.artifact_id),
    kind: String(r.kind),
    content_hash: r.content_hash === null ? null : String(r.content_hash),
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    state: String(r.state),
    created_at: Number(r.created_at),
  }));

  const rawPinRows = db.raw
    .prepare(
      `SELECT p.artifact_id, p.root_kind, p.owner_session_id, p.owner_turn_id
       FROM artifact_pins p
       JOIN artifacts a ON p.artifact_id = a.artifact_id
       WHERE a.project_id = ?`,
    )
    .all(projectId) as Array<Record<string, unknown>>;

  const pinsByArtifact = new Map<
    string,
    Array<{ root_kind: string; owner_session_id: string | null; owner_turn_id: string | null }>
  >();

  for (const r of rawPinRows) {
    const artId = String(r.artifact_id);
    const pin = {
      root_kind: String(r.root_kind),
      owner_session_id: r.owner_session_id === null ? null : String(r.owner_session_id),
      owner_turn_id: r.owner_turn_id === null ? null : String(r.owner_turn_id),
    };
    const list = pinsByArtifact.get(artId) ?? [];
    list.push(pin);
    pinsByArtifact.set(artId, list);
  }

  const eligible: CleanupEligibleArtifact[] = [];
  const protectedItems: CleanupProtectedItem[] = [];

  for (const art of allArtifacts) {
    const pins = pinsByArtifact.get(art.artifact_id);
    if (pins && pins.length > 0) {
      protectedItems.push({
        artifact_id: art.artifact_id,
        pins: [...pins].sort(
          (a, b) =>
            a.root_kind.localeCompare(b.root_kind) ||
            (a.owner_session_id ?? "").localeCompare(b.owner_session_id ?? "") ||
            (a.owner_turn_id ?? "").localeCompare(b.owner_turn_id ?? ""),
        ),
      });
    } else if (art.state === "sealed") {
      eligible.push({
        artifact_id: art.artifact_id,
        kind: art.kind,
        content_hash: art.content_hash,
        size_bytes: art.size_bytes,
        created_at: art.created_at,
      });
    }
  }

  // Determinism: sort eligible by created_at then artifact_id (§15.3)
  eligible.sort((a, b) => a.created_at - b.created_at || a.artifact_id.localeCompare(b.artifact_id));
  protectedItems.sort((a, b) => a.artifact_id.localeCompare(b.artifact_id));

  // Determine retained blob hashes: live references if all eligible artifacts were expired (§15.3.3)
  const eligibleIdSet = new Set(eligible.map((e) => e.artifact_id));
  const retainedArtifacts = allArtifacts.filter(
    (a) => a.state !== "expired" && !eligibleIdSet.has(a.artifact_id),
  );
  const { refs: retainedRefs, unreadableManifests: previewUnreadable } = collectBlobReferences(blobs, projectId, retainedArtifacts);
  const retainedBlobHashes = Array.from(retainedRefs).sort();

  let totalBlobBytes = 0;
  let totalBlobCount = 0;
  if (previewUnreadable.length > 0) {
    // Fail-closed preview: with unreadable retained manifests the reclaimable
    // estimate cannot be trusted — report zero reclaimable (§15.3.1).
    return {
      eligible,
      protected: protectedItems,
      retainedBlobHashes,
      reclaimableBytes: 0,
      reclaimableBlobCount: 0,
      totalBlobBytes,
      totalBlobCount,
      unreadableManifests: previewUnreadable,
    };
  }

  // Query blobs table for project blob statistics and reclaimable byte calculations (§15.3.3)
  const rawBlobRows = db.raw
    .prepare("SELECT content_hash, size_bytes FROM blobs WHERE project_id = ?")
    .all(projectId) as Array<Record<string, unknown>>;

  let reclaimableBytes = 0;
  let reclaimableBlobCount = 0;

  for (const r of rawBlobRows) {
    const hash = String(r.content_hash);
    const size = Number(r.size_bytes);
    totalBlobCount++;
    totalBlobBytes += size;

    if (!retainedRefs.has(hash)) {
      reclaimableBlobCount++;
      reclaimableBytes += size;
    }
  }

  return {
    eligible,
    protected: protectedItems,
    retainedBlobHashes,
    reclaimableBytes,
    reclaimableBlobCount,
    totalBlobBytes,
    totalBlobCount,
    unreadableManifests: [],
  };
}

/**
 * Operator-confirmed execution (§15.3.2, §15.3.3): in ONE transaction expire
 * the selected artifacts (only those still sealed and still pin-free — re-check inside
 * the tx; others go to skippedPinned); AFTER commit, rescan live blob
 * references (non-expired artifacts + their manifest entries) and delete
 * orphan blobs via blobs.delete(projectId, hash) (missing files tolerated
 * silently). Tombstone (expired) records stay; nothing else is deleted.
 */
export function executeCleanup(
  db: RegistryDb,
  blobs: BlobStore,
  projectId: string,
  selection: { artifact_ids: string[] },
  now: number,
): CleanupResult {
  const expiredArtifactIds: string[] = [];
  const skippedPinned: string[] = [];

  const seenSelection = new Set<string>();
  const uniqueSelection: string[] = [];
  for (const id of selection.artifact_ids) {
    if (!seenSelection.has(id)) {
      seenSelection.add(id);
      uniqueSelection.push(id);
    }
  }

  // 1. In ONE transaction, expire the eligible selected artifacts (§15.3.2)
  db.tx(() => {
    for (const artId of uniqueSelection) {
      const art = db.raw
        .prepare("SELECT artifact_id, state FROM artifacts WHERE artifact_id = ? AND project_id = ?")
        .get(artId, projectId) as Record<string, unknown> | undefined;

      if (!art || String(art.state) !== "sealed") {
        skippedPinned.push(artId);
        continue;
      }

      const pinRow = db.raw
        .prepare("SELECT COUNT(*) c FROM artifact_pins WHERE artifact_id = ?")
        .get(artId) as Record<string, unknown> | undefined;

      const pinCount = pinRow ? Number(pinRow.c) : 0;
      if (pinCount > 0) {
        skippedPinned.push(artId);
        continue;
      }

      // Re-checked: still sealed and pin-free (§15.3.2 serialized metadata boundary)
      db.raw
        .prepare(
          "UPDATE artifacts SET state = 'expired', expired_at = ? WHERE artifact_id = ? AND project_id = ?",
        )
        .run(now, artId, projectId);
      expiredArtifactIds.push(artId);
    }
  });

  // 2. AFTER commit, rescan live blob references across remaining non-expired artifacts (§15.3.2)
  const rawLiveArts = db.raw
    .prepare(
      "SELECT artifact_id, kind, content_hash, size_bytes, state, created_at FROM artifacts WHERE project_id = ? AND state != 'expired'",
    )
    .all(projectId) as Array<Record<string, unknown>>;

  const liveArtifacts: ArtifactRow[] = rawLiveArts.map((r) => ({
    artifact_id: String(r.artifact_id),
    kind: String(r.kind),
    content_hash: r.content_hash === null ? null : String(r.content_hash),
    size_bytes: r.size_bytes === null ? null : Number(r.size_bytes),
    state: String(r.state),
    created_at: Number(r.created_at),
  }));

  const { refs: liveBlobRefs, unreadableManifests } = collectBlobReferences(blobs, projectId, liveArtifacts);

  // Fail-closed (§15.3.1): with unreadable retained manifests the reference
  // set is an under-approximation — deleting blobs now could destroy content
  // a retained object still needs. Skip the GC phase entirely.
  if (unreadableManifests.length > 0) {
    return {
      expiredArtifactIds,
      skippedPinned,
      deletedBlobHashes: [],
      reclaimedBytes: 0,
      gcSkippedReason: `unreadable-retained-manifests: ${unreadableManifests.join(",")}`,
    };
  }

  // In-flight publications (staging artifacts without content_hash) hold
  // blob references invisible to the SQL scan — skip GC while any exist
  // (§15.3.2: pending publications are accounted before deletion).
  const stagingCount = db.raw
    .prepare("SELECT COUNT(*) c FROM artifacts WHERE project_id = ? AND state != 'expired' AND content_hash IS NULL")
    .get(projectId) as { c: number };
  if (stagingCount.c > 0) {
    return {
      expiredArtifactIds,
      skippedPinned,
      deletedBlobHashes: [],
      reclaimedBytes: 0,
      gcSkippedReason: "in-flight-publication",
    };
  }

  // 3. Delete unreferenced orphan blobs (§15.3.2, §15.3.3). This is a
  // project-wide operator GC sweep consistent with previewCleanup's
  // reclaimable estimate: nothing referenced by a non-expired artifact is
  // ever deleted. A blobs.delete failure other than BLOB_NOT_FOUND leaves
  // both the file and its registry row intact (no untracked drift).
  const rawBlobs = db.raw
    .prepare("SELECT content_hash, size_bytes FROM blobs WHERE project_id = ?")
    .all(projectId) as Array<Record<string, unknown>>;

  const deletedBlobHashes: string[] = [];
  let reclaimedBytes = 0;

  for (const r of rawBlobs) {
    const hash = String(r.content_hash);
    const size = Number(r.size_bytes);

    if (!liveBlobRefs.has(hash)) {
      try {
        blobs.delete(projectId, hash);
      } catch (e) {
        if (e instanceof Error && e.message === "BLOB_NOT_FOUND") {
          // File already gone — still remove the registry row.
        } else {
          continue; // non-absence failure: keep row + skip (accounting stays consistent)
        }
      }
      db.raw
        .prepare("DELETE FROM blobs WHERE project_id = ? AND content_hash = ?")
        .run(projectId, hash);
      deletedBlobHashes.push(hash);
      reclaimedBytes += size;
    }
  }

  deletedBlobHashes.sort();

  return {
    expiredArtifactIds,
    skippedPinned,
    deletedBlobHashes,
    reclaimedBytes,
  };
}
