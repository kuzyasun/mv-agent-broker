/**
 * Unit tests for the operator storage preview/execute handlers (§15.3 operator
 * surface) plus the low-level cleanup extension points they build on:
 * pin/age-aware preview eligibility, registered-blob-only accounting, blocking
 * reasons, exact-preview execution semantics and token lifecycle.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureSnapshot } from "../../src/snapshots/capture.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openRegistryDb, type RegistryDb } from "../../src/storage/db.ts";
import { executeCleanup, previewCleanup } from "../../src/storage/cleanup.ts";
import type { BlobStore } from "../../src/snapshots/blobs.ts";
import type { SnapshotManifest } from "../../src/shared/api-types.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { createOperatorStorageHandlers, type OperatorStorageHandlers } from "../../src/operator/storage.ts";

const DAY_MS = 86_400_000;
const BASE = 100 * DAY_MS;

interface Fixture {
  dir: string;
  db: RegistryDb;
  blobs: BlobStore;
  handlers: OperatorStorageHandlers;
  time: () => number;
  advance(ms: number): void;
  cleanup(): void;
}

function createFixture(allowedProjects: string[] = ["proj-a"]): Fixture {
  const dir = mkdtempSync(path.join(tmpdir(), "operator-storage-unit-"));
  const db = openRegistryDb(path.join(dir, "registry.db"));
  const blobs = openBlobStore(path.join(dir, "blobs"));
  let current = BASE;
  for (const projectId of ["proj-a", "proj-b"]) {
    db.raw
      .prepare("INSERT INTO projects (project_id, display_name, created_at) VALUES (?, ?, ?)")
      .run(projectId, `Project ${projectId}`, 1);
  }
  db.raw
    .prepare(
      "INSERT INTO coordinator_profiles (coordinator_id, display_name, allowed_project_ids, revoked, config_revision) VALUES (?, ?, ?, ?, ?)",
    )
    .run("coord-op", "Operator", JSON.stringify(allowedProjects), 0, 1);

  const fixture: Fixture = {
    dir,
    db,
    blobs,
    handlers: createOperatorStorageHandlers(db, blobs, "coord-op", () => current),
    time: () => current,
    advance(ms: number) {
      current += ms;
    },
    cleanup() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return fixture;
}

function insertBlob(f: Fixture, projectId: string, content: string, createdAt: number): { hash: string; size: number } {
  const written = f.blobs.write(projectId, content);
  f.db.raw
    .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
    .run(projectId, written.hash, written.size, createdAt);
  return { hash: written.hash, size: written.size };
}

function insertArtifact(
  f: Fixture,
  projectId: string,
  artifactId: string,
  kind: string,
  contentHash: string | null,
  size: number | null,
  state: string,
  createdAt: number,
  sealedAt: number | null = createdAt,
): void {
  f.db.raw
    .prepare(
      "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(artifactId, projectId, kind, contentHash, size, state, createdAt, sealedAt);
}

function insertPin(f: Fixture, artifactId: string, pinId: string, rootKind: string): void {
  f.db.raw
    .prepare(
      "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(pinId, artifactId, rootKind, rootKind === "active_turn" ? null : "sess-1", rootKind === "active_turn" ? "turn-1" : null, BASE);
}

function insertCaptureOwner(f: Fixture, artifactId: string, state: "CAPTURING" | "FAILED"): void {
  f.db.raw.prepare(`INSERT INTO snapshot_records (snapshot_id, project_id, coverage_profile_id,
    coverage_profile_version, coverage_contract_hash, source_digest, manifest_artifact_id, state, captured_at)
    VALUES (?, 'proj-a', 'coverage', '1', 'contract', '', ?, ?, ?)`)
    .run(`snap-${artifactId}`, artifactId, state, BASE - 30 * DAY_MS);
}

function expectBrokerError(fn: () => unknown, code: string): BrokerError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe(code);
    return error as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

function cleanupEventCount(f: Fixture): number {
  const row = f.db.raw.prepare("SELECT COUNT(*) c FROM events WHERE type = 'operator_storage_cleanup'").get() as { c: number };
  return Number(row.c);
}

describe("low-level cleanup extensions (selected/cutoff preview, candidate-blob execute)", () => {
  it("age cutoff retains artifacts sealed recently and bounds blob candidates by created_at", () => {
    const f = createFixture();
    try {
      const bOld = insertBlob(f, "proj-a", "old content", BASE - 30 * DAY_MS);
      const bNewOrphan = insertBlob(f, "proj-a", "fresh orphan", BASE - DAY_MS);
      insertArtifact(f, "proj-a", "art-resealed", "findings", bOld.hash, bOld.size, "sealed", BASE - 30 * DAY_MS, BASE - DAY_MS);

      const preview = previewCleanup(f.db, f.blobs, "proj-a", { cutoffAt: BASE - 7 * DAY_MS });
      expect(preview.eligible).toHaveLength(0); // created 30d ago but sealed 1d ago → retained
      expect(preview.reclaimableBlobCount).toBe(0); // blob older than cutoff, but still referenced
      expect(preview.totalBlobCount).toBe(2);

      insertArtifact(f, "proj-a", "art-old", "findings", bOld.hash, bOld.size, "sealed", BASE - 30 * DAY_MS);
      f.db.raw.prepare("DELETE FROM artifacts WHERE artifact_id = 'art-resealed'").run();
      const preview2 = previewCleanup(f.db, f.blobs, "proj-a", { cutoffAt: BASE - 7 * DAY_MS });
      expect(preview2.eligible.map(a => a.artifact_id)).toEqual(["art-old"]);
      // Only the old unreferenced-after-expiry blob is a candidate; the fresh orphan is not.
      expect(preview2.reclaimableBlobHashes).toEqual([bOld.hash]);
      expect(preview2.reclaimableBlobCount).toBe(1);
      expect(preview2.reclaimableBytes).toBe(bOld.size);

      const result = executeCleanup(f.db, f.blobs, "proj-a", { artifact_ids: ["art-old"] }, BASE, {
        candidateBlobHashes: new Set(preview2.reclaimableBlobHashes),
      });
      expect(result.expiredArtifactIds).toEqual(["art-old"]);
      expect(result.deletedBlobHashes).toEqual([bOld.hash]);
      expect(f.blobs.has("proj-a", bNewOrphan.hash)).toBe(true); // late orphan survives exact-preview GC
    } finally {
      f.cleanup();
    }
  });

  it("selectedArtifactIds intersects the default eligible set", () => {
    const f = createFixture();
    try {
      const b1 = insertBlob(f, "proj-a", "content-1", 1);
      const b2 = insertBlob(f, "proj-a", "content-2", 1);
      insertArtifact(f, "proj-a", "art-1", "findings", b1.hash, b1.size, "sealed", 10);
      insertArtifact(f, "proj-a", "art-2", "findings", b2.hash, b2.size, "sealed", 11);

      const preview = previewCleanup(f.db, f.blobs, "proj-a", { selectedArtifactIds: new Set(["art-2"]) });
      expect(preview.eligible.map(a => a.artifact_id)).toEqual(["art-2"]);
      expect(preview.retainedBlobHashes).toContain(b1.hash); // unselected artifact stays retained
      expect(preview.reclaimableBlobHashes).toEqual([b2.hash]);
    } finally {
      f.cleanup();
    }
  });
});

describe("operator storage handlers (§15.3 operator surface)", () => {
  it("previews old/new/shared blob accounting with pin reasons and registered totals only", () => {
    const f = createFixture();
    try {
      const bOld = insertBlob(f, "proj-a", "old report", BASE - 30 * DAY_MS);
      const sharedManifest: SnapshotManifest = {
        snapshot_id: "snap-shared",
        project_id: "proj-a",
        workspace_id: "ws-1",
        coverage: { profile_id: "cov-1", version: "1", contract_hash: "ch1" },
        entries: [],
        source_digest: "digest-1",
        non_source_observed: [],
        protected_observed: [],
        excluded_observed: [],
        capture_consistency: "broker_exclusive",
        git_provenance: null,
        captured_at: BASE - 30 * DAY_MS,
      };
      const bShared = insertBlob(f, "proj-a", JSON.stringify(sharedManifest), BASE - 30 * DAY_MS);
      const bNew = insertBlob(f, "proj-a", "new report", BASE - DAY_MS);
      insertArtifact(f, "proj-a", "art-old", "findings", bOld.hash, bOld.size, "sealed", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-new", "findings", bNew.hash, bNew.size, "sealed", BASE - DAY_MS);
      insertArtifact(f, "proj-a", "art-shared", "snapshot_manifest", bShared.hash, bShared.size, "sealed", BASE - 30 * DAY_MS);
      insertPin(f, "art-shared", "pin-shared", "session_anchor");

      const preview = f.handlers.preview({ project_id: "proj-a" });

      expect(preview).toMatchObject({
        project_id: "proj-a",
        retention_days: 7,
        cutoff_at: BASE - 7 * DAY_MS,
        registered_blob_count: 3,
        registered_blob_bytes: bOld.size + bShared.size + bNew.size,
        eligible_artifact_count: 1,
        protected_artifact_count: 1,
        reclaimable_registered_bytes: bOld.size,
        reclaimable_blob_count: 1,
        gc_blocked_reason: null,
        protected_reasons: [{ root_kind: "session_anchor", count: 1 }],
      });
      expect(typeof preview.preview_token).toBe("string");
      expect(preview.expires_at).toBe(BASE + 5 * 60_000);
      expect(JSON.stringify(preview)).not.toContain(bOld.hash);
    } finally {
      f.cleanup();
    }
  });

  it("reports every pin root kind in protected_reasons", () => {
    const f = createFixture();
    try {
      const b = insertBlob(f, "proj-a", "pinned everywhere", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-pinned", "findings", b.hash, b.size, "sealed", BASE - 30 * DAY_MS);
      insertPin(f, "art-pinned", "pin-1", "active_turn");
      insertPin(f, "art-pinned", "pin-2", "unknown_recovery");
      insertPin(f, "art-pinned", "pin-3", "operator_hold");

      const preview = f.handlers.preview({ project_id: "proj-a", retention_days: 30 });
      expect(preview).toMatchObject({
        eligible_artifact_count: 0,
        protected_artifact_count: 1,
        reclaimable_registered_bytes: 0,
        reclaimable_blob_count: 0,
        protected_reasons: [
          { root_kind: "active_turn", count: 1 },
          { root_kind: "operator_hold", count: 1 },
          { root_kind: "unknown_recovery", count: 1 },
        ],
      });
    } finally {
      f.cleanup();
    }
  });

  it("an unreadable retained manifest keeps totals visible but forces reclaimable 0 and blocks execute", () => {
    const f = createFixture();
    try {
      const bOld = insertBlob(f, "proj-a", "old report", BASE - 30 * DAY_MS);
      const bCorrupt = insertBlob(f, "proj-a", "not-json-at-all", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-old", "findings", bOld.hash, bOld.size, "sealed", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-manifest", "snapshot_manifest", bCorrupt.hash, bCorrupt.size, "sealed", BASE - 30 * DAY_MS);
      insertPin(f, "art-manifest", "pin-manifest", "session_anchor"); // retained, unreadable

      const preview = f.handlers.preview({ project_id: "proj-a", retention_days: 7 });
      expect(preview).toMatchObject({
        registered_blob_count: 2,
        eligible_artifact_count: 1,
        reclaimable_registered_bytes: 0,
        reclaimable_blob_count: 0,
        gc_blocked_reason: "unreadable_retained_manifest",
      });

      const token = preview.preview_token as string;
      const result = f.handlers.execute({ preview_token: token });
      expect(result).toMatchObject({
        project_id: "proj-a",
        expired_artifact_count: 0,
        skipped_artifact_count: 0,
        deleted_blob_count: 0,
        reclaimed_registered_bytes: 0,
        gc_blocked_reason: "unreadable_retained_manifest",
        replayed_request: false,
      });
      // No destructive side effects; replay returns the cached blocked response.
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-old'").get())
        .toMatchObject({ state: "sealed" });
      expect(f.blobs.has("proj-a", bOld.hash)).toBe(true);
      expect(f.handlers.execute({ preview_token: token })).toMatchObject({ replayed_request: true });
      expect(cleanupEventCount(f)).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("an actual failed capture can expire its old unpinned staging record without blocking project cleanup", () => {
    const f = createFixture();
    try {
      const root = path.join(f.dir, "workspace");
      mkdirSync(path.join(root, "src"), { recursive: true });
      writeFileSync(path.join(root, "src", "main.ts"), "export const n = 1;\n");
      expect(() => captureSnapshot({ db: f.db, blobs: f.blobs,
        clock: { now: () => BASE - 30 * DAY_MS }, projectId: "proj-a", workspaceId: null,
        workspaceRoot: root, coverage: { profile_id: "coverage", version: "1", contract_hash: "contract",
          config: { source_prefixes: ["src"], non_source_prefixes: [], excluded_prefixes: [] } },
        hooks: { afterFirstInventory: () => { throw new Error("capture interrupted"); } },
      })).toThrow("capture interrupted");
      const capture = f.db.raw.prepare("SELECT state, manifest_artifact_id FROM snapshot_records").get() as { state: string; manifest_artifact_id: string };
      expect(capture.state).toBe("FAILED");
      const stale = insertBlob(f, "proj-a", "old sealed report", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-old", "report", stale.hash, stale.size, "sealed", BASE - 30 * DAY_MS);
      const preview = f.handlers.preview({ project_id: "proj-a" });
      expect(preview).toMatchObject({ eligible_artifact_count: 2, reclaimable_blob_count: 1, gc_blocked_reason: null });
      expect(f.handlers.execute({ preview_token: preview.preview_token }))
        .toMatchObject({ expired_artifact_count: 2, deleted_blob_count: 1, gc_blocked_reason: null });
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = ?").get(capture.manifest_artifact_id))
        .toMatchObject({ state: "expired" });
      expect(f.db.raw.prepare("SELECT state FROM snapshot_records").get()).toMatchObject({ state: "FAILED" });
    } finally { f.cleanup(); }
  });

  it("a failed capture pinned after preview still blocks every destructive change", () => {
    const f = createFixture();
    try {
      const stale = insertBlob(f, "proj-a", "partial capture content", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-failed", "snapshot_manifest", null, null, "staging", BASE - 30 * DAY_MS, null);
      insertCaptureOwner(f, "art-failed", "FAILED");
      const preview = f.handlers.preview({ project_id: "proj-a" });
      expect(preview).toMatchObject({ eligible_artifact_count: 1, reclaimable_blob_count: 1, gc_blocked_reason: null });
      insertPin(f, "art-failed", "pin-recovery", "unknown_recovery");
      expect(f.handlers.execute({ preview_token: preview.preview_token }))
        .toMatchObject({ expired_artifact_count: 0, deleted_blob_count: 0, gc_blocked_reason: "in_flight_publication" });
      expect(f.blobs.has("proj-a", stale.hash)).toBe(true);
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id='art-failed'").get()).toMatchObject({ state: "staging" });
    } finally { f.cleanup(); }
  });

  it("an in-flight publication blocks the preview estimate and execute upfront", () => {
    const f = createFixture();
    try {
      const bOld = insertBlob(f, "proj-a", "old report", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-old", "findings", bOld.hash, bOld.size, "sealed", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-staging", "snapshot_manifest", null, null, "staging", BASE - 30 * DAY_MS, null);
      insertCaptureOwner(f, "art-staging", "CAPTURING");

      const preview = f.handlers.preview({ project_id: "proj-a" });
      expect(preview).toMatchObject({
        registered_blob_count: 1,
        eligible_artifact_count: 1,
        reclaimable_registered_bytes: 0,
        gc_blocked_reason: "in_flight_publication",
      });

      const result = f.handlers.execute({ preview_token: preview.preview_token as string });
      expect(result).toMatchObject({ expired_artifact_count: 0, deleted_blob_count: 0, gc_blocked_reason: "in_flight_publication" });
      expect(f.blobs.has("proj-a", bOld.hash)).toBe(true);
      expect(cleanupEventCount(f)).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("execute skips a pin added after preview and the blob survives", () => {
    const f = createFixture();
    try {
      const b = insertBlob(f, "proj-a", "soon pinned", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-a", "findings", b.hash, b.size, "sealed", BASE - 30 * DAY_MS);

      const token = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      insertPin(f, "art-a", "pin-late", "active_turn");

      const result = f.handlers.execute({ preview_token: token });
      expect(result).toMatchObject({
        expired_artifact_count: 0,
        skipped_artifact_count: 1,
        deleted_blob_count: 0,
        reclaimed_registered_bytes: 0,
        gc_blocked_reason: null,
      });
      expect(f.blobs.has("proj-a", b.hash)).toBe(true);
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-a'").get())
        .toMatchObject({ state: "sealed" });
    } finally {
      f.cleanup();
    }
  });

  it("execute deletes only exact preview candidates; late orphans and other projects survive", () => {
    const f = createFixture(["proj-a"]);
    try {
      const bA = insertBlob(f, "proj-a", "project a cleanup target", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-a", "art-a", "findings", bA.hash, bA.size, "sealed", BASE - 30 * DAY_MS);
      const bB = insertBlob(f, "proj-b", "project b content", BASE - 30 * DAY_MS);
      insertArtifact(f, "proj-b", "art-b", "findings", bB.hash, bB.size, "sealed", BASE - 30 * DAY_MS);

      const token = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      // A brand-new orphan blob registered after the preview must not be swept.
      const bLate = insertBlob(f, "proj-a", "late orphan", BASE);

      const result = f.handlers.execute({ preview_token: token });
      expect(result).toMatchObject({
        project_id: "proj-a",
        expired_artifact_count: 1,
        skipped_artifact_count: 0,
        deleted_blob_count: 1,
        reclaimed_registered_bytes: bA.size,
        gc_blocked_reason: null,
        replayed_request: false,
      });
      expect(f.blobs.has("proj-a", bA.hash)).toBe(false);
      expect(f.blobs.has("proj-a", bLate.hash)).toBe(true);
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-a'").get())
        .toMatchObject({ state: "expired" });
      // Other project untouched.
      expect(f.blobs.has("proj-b", bB.hash)).toBe(true);
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-b'").get())
        .toMatchObject({ state: "sealed" });

      const audit = f.db.raw
        .prepare("SELECT type, payload FROM events WHERE type = 'operator_storage_cleanup'")
        .all() as Array<{ type: string; payload: string }>;
      expect(audit).toHaveLength(1);
      const payload = JSON.parse(audit[0]!.payload) as Record<string, unknown>;
      expect(payload).toMatchObject({ project_id: "proj-a", expired_artifact_count: 1, deleted_blob_count: 1 });
      expect(JSON.stringify(payload)).not.toContain(token);

      // Replay: cached response, no extra cleanup, no duplicate audit.
      const replay = f.handlers.execute({ preview_token: token });
      expect(replay).toMatchObject({ ...result, replayed_request: true });
      expect(cleanupEventCount(f)).toBe(1);
      expect(f.blobs.has("proj-a", bLate.hash)).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("validates params, authorization and token lifecycle", () => {
    const f = createFixture(["proj-a"]);
    try {
      expectBrokerError(() => f.handlers.preview({}), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-a", retention_days: -1 }), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-a", retention_days: 1.5 }), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-a", retention_days: 3651 }), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-a", retention_days: "7" }), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-missing" }), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.preview({ project_id: "proj-b" }), "UNAUTHORIZED");
      expectBrokerError(() => f.handlers.execute({}), "INVALID_REQUEST");
      expectBrokerError(() => f.handlers.execute({ preview_token: "unknown-token" }), "INVALID_REQUEST");
      expect(cleanupEventCount(f)).toBe(0);

      // retention_days 0..3650 boundaries are accepted; 0 means "everything older than now".
      const b = insertBlob(f, "proj-a", "boundary content", 1);
      insertArtifact(f, "proj-a", "art-boundary", "findings", b.hash, b.size, "sealed", 1);
      expect(f.handlers.preview({ project_id: "proj-a", retention_days: 0 }).retention_days).toBe(0);
      expect(f.handlers.preview({ project_id: "proj-a", retention_days: 3650 }).retention_days).toBe(3650);

      // Token expiry: after 5 minutes the handle is gone, no side effects.
      const token = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      f.advance(5 * 60_000 + 1);
      expectBrokerError(() => f.handlers.execute({ preview_token: token }), "INVALID_REQUEST");
      expect(f.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-boundary'").get())
        .toMatchObject({ state: "sealed" });

      // Execute rechecks authorization: a revoked operator coordinator is rejected.
      const token2 = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      f.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = 'coord-op'").run();
      expectBrokerError(() => f.handlers.execute({ preview_token: token2 }), "UNAUTHORIZED");
      f.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 0 WHERE coordinator_id = 'coord-op'").run();

      // A project removed after preview fails the execute recheck without side effects.
      const token3 = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      f.db.raw.prepare("DELETE FROM projects WHERE project_id = 'proj-a'").run();
      expectBrokerError(() => f.handlers.execute({ preview_token: token3 }), "INVALID_REQUEST");
      f.db.raw
        .prepare("INSERT INTO projects (project_id, display_name, created_at) VALUES (?, ?, ?)")
        .run("proj-a", "Project proj-a", 1);
      expect(f.handlers.execute({ preview_token: token3 })).toMatchObject({ expired_artifact_count: 1 });
    } finally {
      f.cleanup();
    }
  });

  it("rechecks project grants and revocation before replaying a completed handle", () => {
    const f = createFixture(["proj-a"]);
    try {
      const token = f.handlers.preview({ project_id: "proj-a" }).preview_token as string;
      const result = f.handlers.execute({ preview_token: token });
      f.db.raw.prepare("UPDATE coordinator_profiles SET allowed_project_ids='[]' WHERE coordinator_id='coord-op'").run();
      expectBrokerError(() => f.handlers.execute({ preview_token: token }), "UNAUTHORIZED");
      f.db.raw.prepare("UPDATE coordinator_profiles SET allowed_project_ids='[\"proj-a\"]', revoked=1 WHERE coordinator_id='coord-op'").run();
      expectBrokerError(() => f.handlers.execute({ preview_token: token }), "UNAUTHORIZED");
      f.db.raw.prepare("UPDATE coordinator_profiles SET revoked=0 WHERE coordinator_id='coord-op'").run();
      expect(f.handlers.execute({ preview_token: token })).toMatchObject({ ...result, replayed_request: true });
      expect(cleanupEventCount(f)).toBe(1);
    } finally { f.cleanup(); }
  });

  it("keeps at most 20 preview handles and forgets the oldest", () => {
    const f = createFixture();
    try {
      const tokens: string[] = [];
      for (let index = 0; index < 21; index += 1) {
        tokens.push(f.handlers.preview({ project_id: "proj-a" }).preview_token as string);
        f.advance(1);
      }
      expectBrokerError(() => f.handlers.execute({ preview_token: tokens[0]! }), "INVALID_REQUEST");
      // The 20 most recent handles are still valid.
      const result = f.handlers.execute({ preview_token: tokens[20]! });
      expect(result).toMatchObject({ project_id: "proj-a", replayed_request: false });
    } finally {
      f.cleanup();
    }
  });
});
