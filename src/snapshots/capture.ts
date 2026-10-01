/**
 * Snapshot capture and sealing (spec §9.1, §9.2, §14.1).
 *
 * Pipeline: (under the caller-held workspace lease)
 *   inventory → copy admitted source into content-addressed blobs →
 *   stability re-inventory → seal manifest artifact → publish snapshot
 *   record. A detected change of the source set during capture is
 *   SNAPSHOT_UNSTABLE; a partial capture is never published as sealed.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { RegistryDb } from "../storage/db.ts";
import {
  appendEvent,
  getArtifact,
  insertArtifact,
  insertBlobRecord,
  insertSnapshotRecord,
  sealArtifact,
  updateSnapshotState,
} from "../storage/repo.ts";
import { newId, ID_PREFIX } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type { SnapshotManifest, SnapshotRecord } from "../shared/api-types.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import { computeSourceDigest, takeInventory } from "../workspaces/inventory.ts";
import type { CoverageConfig } from "../workspaces/coverage.ts";
import { CoverageError } from "../workspaces/coverage.ts";

export interface CaptureArgs {
  db: RegistryDb;
  blobs: BlobStore;
  clock: Clock;
  projectId: string;
  workspaceId: string | null;
  workspaceRoot: string;
  coverage: {
    profile_id: string;
    version: string;
    contract_hash: string;
    config: CoverageConfig;
  };
  /** Fault-injection hooks (tests): run between capture phases. */
  hooks?: {
    afterFirstInventory?: () => void;
  };
}

export interface CaptureResult {
  snapshot: SnapshotRecord;
  manifest: SnapshotManifest;
}

/** Best-effort Git provenance for current-mode workspaces (§8.2). */
function gitProvenance(root: string): { head: string | null; dirty: boolean | null } {
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  if (head.status !== 0) return { head: null, dirty: null };
  const status = spawnSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" });
  const dirty = status.status === 0 ? status.stdout.trim().length > 0 : null;
  return { head: head.stdout.trim(), dirty };
}

/**
 * Capture the admitted source set of a workspace. Throws CoverageError
 * (SNAPSHOT_UNSTABLE / SNAPSHOT_UNSUPPORTED / INPUT_LIMIT) on failure —
 * the snapshot record is then durably FAILED and never sealed.
 */
export function captureSnapshot(args: CaptureArgs): CaptureResult {
  const { db, blobs, clock, projectId, workspaceId, workspaceRoot, coverage } = args;
  const now = clock.now();
  const snapshotId = newId(ID_PREFIX.snapshot);
  const artifactId = newId(ID_PREFIX.artifact);

  // Journal the capture first: a crash mid-capture leaves a FAILED/CAPTURING
  // record, never a fabricated sealed snapshot (§14.1 staging rules).
  insertArtifact(db, {
    artifact_id: artifactId,
    project_id: projectId,
    kind: "snapshot_manifest",
    content_hash: null,
    size_bytes: null,
    state: "staging",
    created_at: now,
    sealed_at: null,
    expired_at: null,
  });
  insertSnapshotRecord(db, {
    snapshot_id: snapshotId,
    project_id: projectId,
    workspace_id: workspaceId,
    coverage_profile_id: coverage.profile_id,
    coverage_profile_version: coverage.version,
    coverage_contract_hash: coverage.contract_hash,
    source_digest: "", // filled at seal
    manifest_artifact_id: artifactId,
    state: "CAPTURING",
    fail_reason: null,
    git_head: null,
    git_dirty: null,
    captured_at: now,
  });

  try {
    const first = takeInventory(workspaceRoot, coverage.config);
    args.hooks?.afterFirstInventory?.();

    // Copy admitted source files into the content-addressed store (§14.1:
    // blobs addressed by (project, sha256), reused across manifests).
    for (const entry of first.entries) {
      if (entry.type === "file" && entry.content_hash && !blobs.has(projectId, entry.content_hash)) {
        const abs = `${workspaceRoot}/${entry.path}`;
        const content = readFileSync(abs);
        const written = blobs.write(projectId, content);
        if (written.hash !== entry.content_hash) {
          throw new CoverageError(
            `Blob hash mismatch while staging ${entry.path}`,
            "SNAPSHOT_UNSTABLE",
          );
        }
        insertBlobRecord(db, {
          project_id: projectId,
          content_hash: written.hash,
          size_bytes: written.size,
          created_at: now,
        });
      }
    }

    // Stability check: the source set must not change during capture (§9.2).
    const second = takeInventory(workspaceRoot, coverage.config);
    const digestFirst = computeSourceDigest(first.entries, coverage);
    const digestSecond = computeSourceDigest(second.entries, coverage);
    if (digestFirst !== digestSecond) {
      throw new CoverageError("Source set changed during capture", "SNAPSHOT_UNSTABLE");
    }

    const manifest: SnapshotManifest = {
      snapshot_id: snapshotId,
      project_id: projectId,
      workspace_id: workspaceId,
      coverage: { profile_id: coverage.profile_id, version: coverage.version, contract_hash: coverage.contract_hash },
      entries: second.entries.map((e) => ({
        path: e.path,
        type: e.type,
        content_hash: e.content_hash,
        executable: e.executable,
        size: e.size,
      })),
      source_digest: digestSecond,
      non_source_observed: second.nonSourceObserved,
      protected_observed: second.protectedObserved,
      excluded_observed: second.excludedObserved,
      capture_consistency: "broker_exclusive",
      git_provenance: workspaceId ? gitProvenance(workspaceRoot) : null,
      captured_at: now,
    };

    // Publish: manifest bytes → blob → sealed artifact → SEALED snapshot,
    // all inside one metadata transaction (no sealed-artifact-with-
    // CAPTURING-record window).
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const manifestBlob = blobs.write(projectId, manifestBytes);
    insertBlobRecord(db, {
      project_id: projectId,
      content_hash: manifestBlob.hash,
      size_bytes: manifestBlob.size,
      created_at: now,
    });

    db.tx(() => {
      sealArtifact(db, artifactId, manifestBlob.hash, manifestBlob.size, now);
      db.raw
        .prepare(
          `UPDATE snapshot_records SET source_digest = ?, state = 'SEALED', fail_reason = NULL,
           git_head = ?, git_dirty = ?, captured_at = ? WHERE snapshot_id = ?`,
        )
        .run(
          manifest.source_digest,
          manifest.git_provenance?.head ?? null,
          manifest.git_provenance?.dirty === null || manifest.git_provenance === null
            ? null
            : manifest.git_provenance.dirty
              ? 1
              : 0,
          now,
          snapshotId,
        );
      appendEvent(db, {
        turn_id: null,
        session_id: null,
        type: "snapshot_sealed",
        payload: { snapshot_id: snapshotId, workspace_id: workspaceId, source_digest: manifest.source_digest },
        created_at: now,
      });
    });

    return {
      snapshot: {
        snapshot_id: snapshotId,
        project_id: projectId,
        workspace_id: workspaceId,
        coverage_profile_id: coverage.profile_id,
        coverage_profile_version: coverage.version,
        coverage_contract_hash: coverage.contract_hash,
        source_digest: manifest.source_digest,
        manifest_artifact_id: artifactId,
        state: "SEALED",
        fail_reason: null,
        git_head: manifest.git_provenance?.head ?? null,
        git_dirty: manifest.git_provenance?.dirty ?? null,
        captured_at: now,
      },
      manifest,
    };
  } catch (e) {
    const reason = e instanceof CoverageError ? `${e.code}: ${e.message}` : String(e);
    updateSnapshotState(db, snapshotId, "FAILED", reason);
    // Every mid-capture failure becomes a CaptureError: the record is durable
    // FAILED, and callers treat an executed-but-failed capture as an
    // idempotent operation, never a silent retry (§7.3, §10.1.1).
    if (e instanceof CaptureError) throw e;
    if (e instanceof CoverageError) throw new CaptureError(e.message, e.code, snapshotId);
    throw new CaptureError(String(e), "EVIDENCE_CAPTURE_FAILED", snapshotId);
  }
}

/** Capture failure carrying the durable snapshot record id (§10.1.1 replay). */
export class CaptureError extends CoverageError {
  constructor(message: string, code: string, readonly snapshotId: string) {
    super(message, code);
    this.name = "CaptureError";
  }
}
/** Read and parse a sealed snapshot's manifest from the blob store. */
export function readManifest(args: {
  db: RegistryDb;
  blobs: BlobStore;
  projectId: string;
  snapshot: SnapshotRecord;
}): SnapshotManifest {
  const artifact = getArtifact(args.db, args.snapshot.manifest_artifact_id);
  if (!artifact) {
    throw new CoverageError("Manifest artifact is not ready", "ARTIFACT_NOT_READY");
  }
  if (artifact.project_id !== args.projectId || artifact.project_id !== args.snapshot.project_id) {
    throw new CoverageError("Manifest artifact failed verification", "ARTIFACT_CORRUPT");
  }
  if (artifact.state === "expired") {
    throw new CoverageError("Manifest artifact has expired", "ARTIFACT_EXPIRED");
  }
  if (artifact.state !== "sealed" || !artifact.content_hash || artifact.size_bytes === null) {
    throw new CoverageError("Manifest artifact is not sealed", "ARTIFACT_NOT_READY");
  }
  let bytes: Uint8Array;
  try {
    bytes = args.blobs.readVerified(args.projectId, artifact.content_hash, artifact.size_bytes);
  } catch (e) {
    const reason = e instanceof Error ? e.message : "verification failed";
    if (
      reason === "BLOB_NOT_FOUND" ||
      reason === "BLOB_HASH_MISMATCH" ||
      reason === "BLOB_SIZE_MISMATCH" ||
      reason === "BLOB_NOT_REGULAR" ||
      reason === "INVALID_BLOB_ID"
    ) {
      throw new CoverageError(`Manifest artifact failed verification (${reason})`, "ARTIFACT_CORRUPT");
    }
    throw new CoverageError("Manifest artifact failed verification", "ARTIFACT_CORRUPT");
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as SnapshotManifest;
  } catch {
    throw new CoverageError("Manifest artifact failed verification", "ARTIFACT_CORRUPT");
  }
}

export interface ManifestDelta {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * baseline → target manifest diff. Only meaningful under the SAME coverage
 * binding (§9.5): an incompatible pair throws instead of publishing a diff
 * that could misreport an excluded file as a deletion.
 */
export function diffManifests(baseline: SnapshotManifest, target: SnapshotManifest): ManifestDelta {
  const b = baseline.coverage;
  const t = target.coverage;
  if (b.profile_id !== t.profile_id || b.version !== t.version || b.contract_hash !== t.contract_hash) {
    throw new CoverageError(
      "Cannot diff snapshots with different coverage bindings",
      "SNAPSHOT_COVERAGE_MISMATCH",
    );
  }
  const baselineFiles = new Map(baseline.entries.filter((e) => e.type === "file").map((e) => [e.path, e.content_hash ?? ""]));
  const targetFiles = new Map(target.entries.filter((e) => e.type === "file").map((e) => [e.path, e.content_hash ?? ""]));
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, h] of targetFiles) {
    if (!baselineFiles.has(p)) added.push(p);
    else if (baselineFiles.get(p) !== h) modified.push(p);
  }
  for (const p of baselineFiles.keys()) {
    if (!targetFiles.has(p)) deleted.push(p);
  }
  added.sort();
  modified.sort();
  deleted.sort();
  return { added, modified, deleted };
}
