/**
 * Operator-only project storage preview and explicitly confirmed exact-preview
 * cleanup (spec §15.3, operator surface).
 *
 * A preview binds a short-lived token to the exact project, the eligible
 * artifact IDs and the candidate blob hashes computed at preview time. Execute
 * re-checks authorization, pins, live manifest references and publications
 * before destroying anything, and only ever expires/deletes the exact preview
 * candidates. Completed responses are cached per token until handle expiry so
 * a replay never performs extra cleanup or duplicates the audit event.
 *
 * The handlers are fully synchronous (node:sqlite) — the daemon is the sole
 * registry owner and no await can interleave with metadata mutation + GC.
 */
import { randomBytes } from "node:crypto";
import { BrokerError } from "../shared/errors.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import type { RegistryDb } from "../storage/db.ts";
import { executeCleanup, isCleanupStateEligible, previewCleanup } from "../storage/cleanup.ts";
import { appendEvent, getCoordinator, getProject } from "../storage/repo.ts";

const PREVIEW_HANDLE_TTL_MS = 5 * 60_000;
const MAX_PREVIEW_HANDLES = 20;
const DEFAULT_RETENTION_DAYS = 7;
const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 86_400_000;

/** A retained snapshot_manifest blob is unreadable — blob references are untrusted. */
export const GC_BLOCKED_UNREADABLE_MANIFEST = "unreadable_retained_manifest";
/** A retained artifact is an in-flight publication (no content_hash yet) — GC is unsafe. */
export const GC_BLOCKED_IN_FLIGHT_PUBLICATION = "in_flight_publication";

export interface OperatorStorageHandlers {
  preview(params: Record<string, unknown>): Record<string, unknown>;
  execute(params: Record<string, unknown>): Record<string, unknown>;
}

interface PreviewHandle {
  project_id: string;
  expires_at: number;
  eligibleArtifactIds: string[];
  candidateBlobHashes: string[];
  completed: Record<string, unknown> | null;
}

function invalid(message: string): BrokerError {
  return new BrokerError("INVALID_REQUEST", message);
}

function unauthorized(): BrokerError {
  return new BrokerError("UNAUTHORIZED", "project is not allowed for this operator coordinator");
}

/**
 * Stable, bounded GC-block reason for HTTP/RPC output. Maps the low-level
 * gcSkippedReason (which may embed artifact IDs) onto the fixed vocabulary.
 */
function normalizeGcBlockedReason(reason: string): string {
  if (reason.startsWith("unreadable-retained-manifests")) return GC_BLOCKED_UNREADABLE_MANIFEST;
  if (reason === "in-flight-publication") return GC_BLOCKED_IN_FLIGHT_PUBLICATION;
  return "gc_skipped";
}

/**
 * Preview-time blocking reason: an unreadable retained manifest or any
 * in-flight publication (non-expired artifact without content_hash) makes the
 * reclaimable estimate untrusted — the preview reports zero reclaimable.
 */
function blockedReasonForPreview(db: RegistryDb, projectId: string, unreadableCount: number, eligibleIds: ReadonlySet<string>): string | null {
  if (unreadableCount > 0) return GC_BLOCKED_UNREADABLE_MANIFEST;
  const staging = db.raw
    .prepare("SELECT artifact_id FROM artifacts WHERE project_id = ? AND state != 'expired' AND content_hash IS NULL")
    .all(projectId) as Array<{ artifact_id: string }>;
  if (staging.some(row => !eligibleIds.has(row.artifact_id))) return GC_BLOCKED_IN_FLIGHT_PUBLICATION;
  return null;
}

export function createOperatorStorageHandlers(
  db: RegistryDb,
  blobs: BlobStore,
  coordinatorId: string,
  now: () => number = Date.now,
): OperatorStorageHandlers {
  const handles = new Map<string, PreviewHandle>();

  function purgeExpiredHandles(at: number): void {
    for (const [token, handle] of handles) {
      if (handle.expires_at <= at) handles.delete(token);
    }
  }

  function assertProjectAuthorized(projectId: string): void {
    if (!getProject(db, projectId)) throw invalid("project does not exist");
    const coordinator = getCoordinator(db, coordinatorId);
    if (!coordinator || coordinator.revoked || !coordinator.allowed_project_ids.includes(projectId)) {
      throw unauthorized();
    }
  }

  function parsePreviewParams(params: Record<string, unknown>): { project_id: string; retention_days: number } {
    const projectId = params.project_id;
    if (typeof projectId !== "string" || projectId.length === 0) {
      throw invalid("project_id is required");
    }
    const rawDays = params.retention_days;
    if (rawDays !== undefined && (typeof rawDays !== "number" || !Number.isSafeInteger(rawDays) || rawDays < 0 || rawDays > MAX_RETENTION_DAYS)) {
      throw invalid(`retention_days must be an integer from 0 to ${MAX_RETENTION_DAYS}`);
    }
    return { project_id: projectId, retention_days: rawDays === undefined ? DEFAULT_RETENTION_DAYS : rawDays };
  }

  function preview(params: Record<string, unknown>): Record<string, unknown> {
    const at = now();
    const { project_id, retention_days } = parsePreviewParams(params);
    assertProjectAuthorized(project_id);

    const cutoffAt = at - retention_days * DAY_MS;
    const result = previewCleanup(db, blobs, project_id, { cutoffAt });
    const blockedReason = blockedReasonForPreview(db, project_id, result.unreadableManifests.length, new Set(result.eligible.map(artifact => artifact.artifact_id)));

    const token = randomBytes(32).toString("hex");
    purgeExpiredHandles(at);
    while (handles.size >= MAX_PREVIEW_HANDLES) {
      const oldest = handles.keys().next();
      if (oldest.done) break;
      handles.delete(oldest.value);
    }
    const expiresAt = at + PREVIEW_HANDLE_TTL_MS;
    handles.set(token, {
      project_id,
      expires_at: expiresAt,
      eligibleArtifactIds: result.eligible.map(artifact => artifact.artifact_id),
      // Fail-closed: a blocked preview never binds GC candidates.
      candidateBlobHashes: blockedReason === null ? result.reclaimableBlobHashes : [],
      completed: null,
    });

    const reasonCounts = new Map<string, number>();
    for (const item of result.protected) {
      for (const rootKind of new Set(item.pins.map(pin => pin.root_kind))) {
        reasonCounts.set(rootKind, (reasonCounts.get(rootKind) ?? 0) + 1);
      }
    }

    return {
      project_id,
      retention_days,
      cutoff_at: cutoffAt,
      preview_token: token,
      expires_at: expiresAt,
      registered_blob_bytes: result.totalBlobBytes,
      registered_blob_count: result.totalBlobCount,
      eligible_artifact_count: result.eligible.length,
      protected_artifact_count: result.protected.length,
      reclaimable_registered_bytes: blockedReason === null ? result.reclaimableBytes : 0,
      reclaimable_blob_count: blockedReason === null ? result.reclaimableBlobCount : 0,
      gc_blocked_reason: blockedReason,
      protected_reasons: [...reasonCounts.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([root_kind, count]) => ({ root_kind, count })),
    };
  }

  /**
   * Upfront destructive-operation guard: the retained set is every non-expired
   * artifact minus the candidates that still pass the state-eligible+unpinned recheck.
   * An unreadable retained manifest or an in-flight publication blocks the
   * whole operation before any mutation (fail-closed, no partial cleanup).
   */
  function executeBlockedReason(handle: PreviewHandle): string | null {
    const willExpire = new Set<string>();
    for (const artifactId of handle.eligibleArtifactIds) {
      const row = db.raw
        .prepare("SELECT artifact_id, kind, content_hash, state FROM artifacts WHERE artifact_id = ? AND project_id = ?")
        .get(artifactId, handle.project_id) as { artifact_id: string; kind: string; content_hash: string | null; state: string } | undefined;
      if (!row || !isCleanupStateEligible(db, handle.project_id, row)) continue;
      const pins = db.raw
        .prepare("SELECT COUNT(*) c FROM artifact_pins WHERE artifact_id = ?")
        .get(artifactId) as { c: number };
      if (Number(pins.c) > 0) continue;
      willExpire.add(artifactId);
    }

    let unreadable = false;
    let inFlight = false;
    const rows = db.raw
      .prepare("SELECT artifact_id, kind, content_hash FROM artifacts WHERE project_id = ? AND state != 'expired'")
      .all(handle.project_id) as Array<Record<string, unknown>>;
    for (const row of rows) {
      if (willExpire.has(String(row.artifact_id))) continue;
      const contentHash = row.content_hash === null || row.content_hash === undefined ? null : String(row.content_hash);
      if (contentHash === null) {
        inFlight = true;
        continue;
      }
      if (String(row.kind) !== "snapshot_manifest" || unreadable) continue;
      try {
        const manifest = JSON.parse(Buffer.from(blobs.read(handle.project_id, contentHash)).toString("utf8")) as {
          entries?: unknown;
        };
        if (!Array.isArray(manifest.entries)) unreadable = true;
      } catch {
        unreadable = true;
      }
    }
    if (unreadable) return GC_BLOCKED_UNREADABLE_MANIFEST;
    if (inFlight) return GC_BLOCKED_IN_FLIGHT_PUBLICATION;
    return null;
  }

  function execute(params: Record<string, unknown>): Record<string, unknown> {
    const at = now();
    const token = params.preview_token;
    if (typeof token !== "string" || token.length === 0) {
      throw invalid("preview_token is required");
    }
    const handle = handles.get(token);
    if (!handle || handle.expires_at <= at) {
      if (handle) handles.delete(token);
      throw invalid("preview_token is unknown or expired");
    }
    // Cached results still require current project authorization.
    assertProjectAuthorized(handle.project_id);
    if (handle.completed) {
      return { ...handle.completed, replayed_request: true };
    }

    const blockedReason = executeBlockedReason(handle);
    if (blockedReason !== null) {
      handle.completed = {
        project_id: handle.project_id,
        expired_artifact_count: 0,
        skipped_artifact_count: 0,
        deleted_blob_count: 0,
        reclaimed_registered_bytes: 0,
        gc_blocked_reason: blockedReason,
        replayed_request: false,
      };
      return { ...handle.completed };
    }

    const result = executeCleanup(
      db,
      blobs,
      handle.project_id,
      { artifact_ids: handle.eligibleArtifactIds },
      at,
      { candidateBlobHashes: new Set(handle.candidateBlobHashes) },
    );
    const response: Record<string, unknown> = {
      project_id: handle.project_id,
      expired_artifact_count: result.expiredArtifactIds.length,
      skipped_artifact_count: result.skippedPinned.length,
      deleted_blob_count: result.deletedBlobHashes.length,
      reclaimed_registered_bytes: result.reclaimedBytes,
      gc_blocked_reason: result.gcSkippedReason ? normalizeGcBlockedReason(result.gcSkippedReason) : null,
      replayed_request: false,
    };
    // Audit records the operator-visible counts only — never tokens, IDs, or native data.
    appendEvent(db, {
      turn_id: null,
      session_id: null,
      type: "operator_storage_cleanup",
      payload: {
        project_id: handle.project_id,
        expired_artifact_count: response.expired_artifact_count,
        skipped_artifact_count: response.skipped_artifact_count,
        deleted_blob_count: response.deleted_blob_count,
        reclaimed_registered_bytes: response.reclaimed_registered_bytes,
      },
      created_at: at,
    });
    handle.completed = response;
    return { ...response };
  }

  return { preview, execute };
}
