/**
 * P2 acceptance subset (spec §18): A07, A08, A37, A38, A39 + snapshot
 * semantics (digest stability, immutability, unstable capture, pins).
 * All mock-level; filesystem fixtures are real temp directories.
 */
import { describe, expect, it } from "vitest";
import { linkSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, settleTurn, start, COVERAGE_CONFIG } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import {
  captureSnapshot,
  diffManifests,
  readManifest,
} from "../../src/snapshots/capture.ts";
import { getSnapshotRecord, insertWorkspace as insertWorkspaceDirect } from "../../src/storage/repo.ts";
import { computeSourceDigest, takeInventory } from "../../src/workspaces/inventory.ts";
import {
  classifyPath,
  coverageContractHash,
  matchesPrefix,
  uncoveredWriteScope,
  validateCoverageConfig,
  CoverageError,
} from "../../src/workspaces/coverage.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { ManualClock } from "../../src/shared/clock.ts";

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

// ─── blob verification (readVerified) ────────────────────────────────────────

describe("blob store readVerified", () => {
  it("rejects a hardlinked blob even when bytes and hash match", () => {
    const h = createHarness();
    try {
      const blobs = openBlobStore(h.blobRoot);
      const body = blobs.write(h.seed.projectId, "hardlink fixture");
      const target = path.join(h.blobRoot, h.seed.projectId, body.hash.slice(0, 2), body.hash);
      const alias = path.join(h.blobRoot, "owned-hardlink-fixture");
      linkSync(target, alias);
      expect(() => blobs.readVerified(h.seed.projectId, body.hash, body.size)).toThrow("BLOB_NOT_REGULAR");
      rmSync(alias);
      expect(Buffer.from(blobs.readVerified(h.seed.projectId, body.hash, body.size)).toString("utf8")).toBe("hardlink fixture");
    } finally { h.cleanup(); }
  });
  it("verifies size and hash and rejects non-regular owned-file entries", () => {
    const h = createHarness();
    try {
      const blobs = openBlobStore(h.blobRoot);
      const { hash, size } = blobs.write(h.seed.projectId, "verified-body");

      expect(Buffer.from(blobs.readVerified(h.seed.projectId, hash, size)).toString("utf8")).toBe("verified-body");
      expect(() => blobs.readVerified(h.seed.projectId, hash, size + 1)).toThrow("BLOB_SIZE_MISMATCH");

      const tamperedPath = path.join(h.blobRoot, h.seed.projectId, hash.slice(0, 2), hash);
      const original = readFileSync(tamperedPath);
      writeFileSync(tamperedPath, Buffer.from("VERIFIED-BODY", "utf8")); // same length
      expect(() => blobs.readVerified(h.seed.projectId, hash, size)).toThrow("BLOB_HASH_MISMATCH");

      // Directory in place of the owned regular file: never followed.
      rmSync(tamperedPath);
      mkdirSync(tamperedPath);
      expect(() => blobs.readVerified(h.seed.projectId, hash, size)).toThrow("BLOB_NOT_REGULAR");
      rmSync(tamperedPath, { recursive: true });

      // Symlink pointing elsewhere: rejected even when the target has the
      // right content (skipped where symlinks are unavailable).
      writeFileSync(tamperedPath, original);
      const outside = path.join(h.blobRoot, "outside-target.bin");
      writeFileSync(outside, original);
      rmSync(tamperedPath);
      try {
        symlinkSync(outside, tamperedPath, "file");
      } catch {
        return; // platform without symlink privilege: defense covered above
      }
      expect(() => blobs.readVerified(h.seed.projectId, hash, size)).toThrow("BLOB_NOT_REGULAR");
      rmSync(tamperedPath);
      rmSync(outside);

      expect(() => blobs.readVerified(h.seed.projectId, "a".repeat(64))).toThrow("BLOB_NOT_FOUND");
      // Restored regular file verifies again; legacy read stays API-compatible.
      writeFileSync(tamperedPath, original);
      expect(blobs.read(h.seed.projectId, hash).byteLength).toBe(size);
    } finally {
      h.cleanup();
    }
  });
});

// ─── classification unit checks (§8.5, §8.7) ────────────────────────────────

describe("coverage classification", () => {
  it("component-prefix matching excludes sibling look-alikes", () => {
    expect(matchesPrefix("src/parser/x.c", "src/parser")).toBe(true);
    expect(matchesPrefix("src/parser", "src/parser")).toBe(true);
    expect(matchesPrefix("src/parser-old/x.c", "src/parser")).toBe(false);
  });

  it("classification order: excluded → non-source → source → protected", () => {
    expect(classifyPath("src/a.c", COVERAGE_CONFIG)).toBe("source");
    expect(classifyPath("dist/out.js", COVERAGE_CONFIG)).toBe("non_source_output");
    expect(classifyPath(".git/config", COVERAGE_CONFIG)).toBe("excluded");
    expect(classifyPath("README.md", COVERAGE_CONFIG)).toBe("protected_or_undeclared");
  });

  it("overlapping source/non-source prefixes are rejected, not resolved", () => {
    expect(() =>
      validateCoverageConfig({ source_prefixes: ["src"], non_source_prefixes: ["src/gen"], excluded_prefixes: [] }),
    ).toThrow(CoverageError);
    expect(() =>
      validateCoverageConfig({ source_prefixes: ["a"], non_source_prefixes: [], excluded_prefixes: ["a/b"] }),
    ).toThrow(CoverageError);
    expect(() =>
      validateCoverageConfig({ source_prefixes: ["src"], non_source_prefixes: ["dist"], excluded_prefixes: [".git"] }),
    ).not.toThrow();
  });

  it("contract hash is stable and config-order independent", () => {
    const a = coverageContractHash({ source_prefixes: ["src", "tests"], non_source_prefixes: ["dist"], excluded_prefixes: [".git"] });
    const b = coverageContractHash({ excluded_prefixes: [".git"], source_prefixes: ["tests", "src"], non_source_prefixes: ["dist"] });
    expect(a).toBe(b);
    const c = coverageContractHash({ source_prefixes: ["src", "tests", "lib"], non_source_prefixes: ["dist"], excluded_prefixes: [".git"] });
    expect(a).not.toBe(c);
  });

  it("uncoveredWriteScope reports write prefixes outside the source selector", () => {
    expect(uncoveredWriteScope(["src", "tests"], COVERAGE_CONFIG)).toEqual([]);
    expect(uncoveredWriteScope(["src", "docs"], COVERAGE_CONFIG)).toEqual(["docs"]);
  });
});

// ─── inventory unit checks (§8.7, §9.1) ──────────────────────────────────────

describe("independent inventory", () => {
  it("sees untracked files, ignores .git/node_modules, ignores .gitignore semantics", async ({ }) => {
    const h = createHarness();
    try {
      // No git involved at all: a file that WOULD be git-ignored is still a
      // first-class source entry (§9.1: git staging is never a selector).
      h.writeWorkspaceFile("src/parser/new-module.c", "int parse(){return 1;}\n");
      h.writeWorkspaceFile("src/.gitignore", "*.log\n");
      h.writeWorkspaceFile("src/parser/trace.log", "noise");
      h.writeWorkspaceFile("dist/out.js", "built");
      h.writeWorkspaceFile("ROOT.txt", "outside coverage");

      const inv = takeInventory(h.workspaceRoot, COVERAGE_CONFIG);
      const paths = inv.entries.filter((e) => e.type === "file").map((e) => e.path);
      expect(paths).toContain("src/main.c");
      expect(paths).toContain("src/parser/new-module.c");
      expect(paths).toContain("src/.gitignore");
      expect(paths).toContain("src/parser/trace.log"); // not hidden by .gitignore
      expect(paths).not.toContain("dist/out.js");
      expect(paths).not.toContain("ROOT.txt");
      expect(inv.nonSourceObserved).toContain("dist/out.js");
      expect(inv.protectedObserved).toContain("ROOT.txt");
    } finally {
      h.cleanup();
    }
  });

  it("byte cap produces an explicit INPUT_LIMIT failure, not a partial inventory", () => {
    const h = createHarness();
    try {
      expect(() => takeInventory(h.workspaceRoot, COVERAGE_CONFIG, { byteCap: 4 })).toThrow(CoverageError);
      try {
        takeInventory(h.workspaceRoot, COVERAGE_CONFIG, { byteCap: 4 });
      } catch (e) {
        expect((e as CoverageError).code).toBe("INPUT_LIMIT");
      }
    } finally {
      h.cleanup();
    }
  });

  it("source digest is identical for identical state and changes with content", () => {
    const h = createHarness();
    try {
      const cov = { profile_id: "p", version: "1", contract_hash: "ch" };
      const a = takeInventory(h.workspaceRoot, COVERAGE_CONFIG);
      const b = takeInventory(h.workspaceRoot, COVERAGE_CONFIG);
      expect(computeSourceDigest(a.entries, cov)).toBe(computeSourceDigest(b.entries, cov));
      h.writeWorkspaceFile("src/main.c", "int main(){return 1;}\n");
      const c = takeInventory(h.workspaceRoot, COVERAGE_CONFIG);
      expect(computeSourceDigest(c.entries, cov)).not.toBe(computeSourceDigest(a.entries, cov));
    } finally {
      h.cleanup();
    }
  });
});

// ─── lifecycle integration (A07, A08, A37) ─────────────────────────────────

describe("P2 workspace lifecycle", () => {
  it("A07: dirty initial checkout becomes the baseline; delta does not attribute it to the worker", async () => {
    const h = createHarness();
    try {
      h.writeWorkspaceFile("src/uncommitted.c", "pre-existing dirty state\n"); // user's own dirty edit
      const spawn = await h.spawnWorkerSession();
      expect(spawn.state).toBe("IDLE");
      expect(spawn.initial_snapshot_id).toBeTruthy();

      const initial = getSnapshotRecord(h.db, spawn.initial_snapshot_id!);
      expect(initial?.state).toBe("SEALED");
      const initialManifest = readManifest({
        db: h.db,
        blobs: openBlobStore(h.blobRoot),
        projectId: h.seed.projectId,
        snapshot: initial!,
      });
      expect(initialManifest.entries.map((e) => e.path)).toContain("src/uncommitted.c");

      // Turn with no writes: final digest equals baseline; delta is empty —
      // the pre-existing dirty state is NOT attributed to the worker (§8.2).
      const t1 = h.sendTask(spawn.session_id, "t1");
      await start(h, t1);
      await settle(h);
      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.final_snapshot_id).toBeTruthy();
      const final = getSnapshotRecord(h.db, turn.final_snapshot_id!);
      expect(final?.source_digest).toBe(initial?.source_digest);
      const delta = diffManifests(initialManifest, readManifest({
        db: h.db,
        blobs: openBlobStore(h.blobRoot),
        projectId: h.seed.projectId,
        snapshot: final!,
      }));
      expect(delta.added).toEqual([]);
      expect(delta.modified).toEqual([]);
      expect(delta.deleted).toEqual([]);
    } finally {
      h.cleanup();
    }
  });

  it("A08: external edit after snapshot → WORKSPACE_CHANGED; explicit snapshot continues the same session", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "t1");
      await start(h, t1);
      await settle(h);
      const session1 = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      const lastSnapshot = session1.latest_snapshot_id!;

      // External (non-broker) edit invalidates the old precondition (§8.2).
      h.writeWorkspaceFile("src/main.c", "externally changed\n");
      expectBrokerError(() => h.sendTask(spawn.session_id, "t2"), "WORKSPACE_CHANGED");

      // Explicit snapshot refresh accepts the new state consciously (§16.3):
      // same session, same native conversation, no reset.
      const snap = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "refresh-1",
      });
      expect(snap.capture_state).toBe("SEALED");
      expect(snap.replayed_request).toBe(false);
      // Replay with the same key returns the same capture.
      const replay = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "refresh-1",
      });
      expect(replay.snapshot_id).toBe(snap.snapshot_id);
      expect(replay.replayed_request).toBe(true);

      // The turn now proceeds against the refreshed baseline.
      const t2 = h.sendTask(spawn.session_id, "t2", "Next task", {
        workspace_precondition: { expected_snapshot_id: snap.snapshot_id },
      });
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
      const session2 = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session2.state).toBe("IDLE");
      expect(session2.native_conversation_ref).toBe(session1.native_conversation_ref);
      void lastSnapshot;
    } finally {
      h.cleanup();
    }
  });

  it("A37: new module + test files without git add are captured, hashes present; reviewer-visible bytes are immutable", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "impl");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "mid-work" },
        {
          kind: "workspace_write",
          files: [
            { path: "src/parser/parser.c", content: "int parse(){return 42;}\n" },
            { path: "tests/parser/parser_test.c", content: "void test_parse(){}\n" },
          ],
        },
        { kind: "complete", outcome: "completed", summary: "parser added" },
      ]);
      await start(h, t1);
      h.adapter.releaseBarrier("mid-work");
      await settleTurn(h, t1.turn_id);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      const final = getSnapshotRecord(h.db, turn.final_snapshot_id!);
      expect(final?.state).toBe("SEALED");
      const blobs = openBlobStore(h.blobRoot);
      const manifest = readManifest({ db: h.db, blobs, projectId: h.seed.projectId, snapshot: final! });
      const parserEntry = manifest.entries.find((e) => e.path === "src/parser/parser.c");
      const testEntry = manifest.entries.find((e) => e.path === "tests/parser/parser_test.c");
      expect(parserEntry?.content_hash).toBeTruthy();
      expect(testEntry?.content_hash).toBeTruthy();

      // Blob bytes are immutable snapshots: later workspace edits never
      // change what a sealed manifest returns (§5.4, §9.2).
      h.writeWorkspaceFile("src/parser/parser.c", "tampered after sealing\n");
      const manifestAgain = readManifest({ db: h.db, blobs, projectId: h.seed.projectId, snapshot: final! });
      const stored = Buffer.from(blobs.read(h.seed.projectId, manifestAgain.entries.find((e) => e.path === "src/parser/parser.c")!.content_hash!)).toString("utf8");
      expect(stored).toBe("int parse(){return 42;}\n");
    } finally {
      h.cleanup();
    }
  });

  it("scope violation: write outside policy write scope fails the turn with evidence, no rollback", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const t1 = h.sendTask(spawn.session_id, "hack");
      h.adapter.plan(t1.turn_id, [
        {
          kind: "workspace_write",
          files: [{ path: "notes.md", content: "write into undeclared root area" }],
        },
        { kind: "complete", outcome: "completed", summary: "did something fishy" },
      ]);
      await start(h, t1);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      // Agent claimed completion; broker evidence check fails the turn (§11.2).
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("SCOPE_VIOLATION");
      expect(turn.final_snapshot_id).toBeNull();
      expect(turn.finalization_error).toContain("SCOPE_VIOLATION");
      // No rollback: the file stays on disk (INV-12).
      expect(() => readFileSync(path.join(h.workspaceRoot, "notes.md"), "utf8")).not.toThrow();
      // The native context survives: session returns to IDLE (§6.5.1).
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("IDLE");
    } finally {
      h.cleanup();
    }
  });
});

// ─── coverage binding compatibility (A38, A39) ──────────────────────────────

describe("P2 coverage binding", () => {
  it("A38: write scope not covered by the source selector → SNAPSHOT_COVERAGE_MISMATCH before dispatch", async () => {
    const h = createHarness();
    try {
      // A policy allowing writes into "docs" while the coverage contract
      // only captures "src"/"tests" — contradiction, rejected pre-dispatch.
      const { insertPolicyProfile } = await import("../../src/storage/repo.ts");
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-writer-uncovered",
        version: "1",
        config: JSON.stringify({ access: "workspace_write", write_scope: ["src", "docs"] }),
      });
      const spawn = await h.spawnWorkerSession({ policy_profile_id: "pol-writer-uncovered" });
      expect(spawn.state).toBe("IDLE");
      expectBrokerError(() => h.sendTask(spawn.session_id, "t1"), "SNAPSHOT_COVERAGE_MISMATCH");
      // Zero inference: no turn was created.
      const turns = h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
      expect(turns.c).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("A39: expected/review snapshot from a different coverage binding → mismatch before inference", async () => {
    const h = createHarness();
    try {
      // Alternate binding on the same project: profile with "lib" sources.
      const { insertCoverageProfile, insertWorkspace } = await import("../../src/storage/repo.ts");
      const altConfig = { source_prefixes: ["lib"], non_source_prefixes: [], excluded_prefixes: [".git"] };
      const altRoot = path.join(path.dirname(h.workspaceRoot), "ws-alt");
      mkdirSync(path.join(altRoot, "lib"), { recursive: true });
      writeFileSync(path.join(altRoot, "lib", "a.c"), "int a;\n", "utf8");
      insertCoverageProfile(h.db, {
        coverage_profile_id: "cov-alt",
        version: "1",
        config: JSON.stringify(altConfig),
        contract_hash: coverageContractHash(altConfig),
      });
      insertWorkspace(h.db, {
        workspace_id: "ws-alt",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: altRoot,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: "cov-alt",
      });

      const altSnap = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: "ws-alt",
        idempotency_key: "alt-1",
      });
      expect(altSnap.capture_state).toBe("SEALED");

      const spawn = await h.spawnWorkerSession(); // ws-main, cov-source binding
      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "t1", "goal", {
            workspace_precondition: { expected_snapshot_id: altSnap.snapshot_id },
          }),
        "SNAPSHOT_COVERAGE_MISMATCH",
      );
      // Pairwise review binding: baseline (cov-source) + target (cov-alt).
      const ownSnap = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "own-1",
      });
      expectBrokerError(
        () =>
          h.sendTask(spawn.session_id, "r1", "review", {
            review_binding: { baseline_snapshot_id: ownSnap.snapshot_id, target_snapshot_id: altSnap.snapshot_id },
          }),
        "SNAPSHOT_COVERAGE_MISMATCH",
      );
      const turns = h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
      expect(turns.c).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

// ─── capture stability + pins ────────────────────────────────────────────────

describe("capture semantics", () => {
  it("change during capture → SNAPSHOT_UNSTABLE; the record is FAILED, never sealed", () => {
    const h = createHarness();
    try {
      const clock = new ManualClock(42);
      const blobs = openBlobStore(h.blobRoot);
      expect(() =>
        captureSnapshot({
          db: h.db,
          blobs,
          clock,
          projectId: h.seed.projectId,
          workspaceId: h.seed.workspaceMain,
          workspaceRoot: h.workspaceRoot,
          coverage: { profile_id: "cov", version: "1", contract_hash: "ch", config: COVERAGE_CONFIG },
          hooks: {
            afterFirstInventory: () => h.writeWorkspaceFile("src/main.c", "changed mid-capture\n"),
          },
        }),
      ).toThrow(CoverageError);
      const failed = h.db.raw
        .prepare("SELECT state FROM snapshot_records WHERE state = 'FAILED'")
        .all() as Array<{ state: string }>;
      expect(failed.length).toBe(1);
      const sealed = h.db.raw
        .prepare("SELECT COUNT(*) c FROM snapshot_records WHERE state = 'SEALED'")
        .get() as { c: number };
      expect(sealed.c).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  it("two captures of identical state share the source_digest with different ids", async () => {
    const h = createHarness();
    try {
      const a = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "cap-a",
      });
      const b = h.core.snapshot(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        workspace_id: h.seed.workspaceMain,
        idempotency_key: "cap-b",
      });
      expect(a.snapshot_id).not.toBe(b.snapshot_id);
      expect(a.source_digest).toBe(b.source_digest);
    } finally {
      h.cleanup();
    }
  });

  it("pin anchors: initial baseline + latest final; close releases session anchors (§15.3.1)", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const anchorCount = () =>
        (h.db.raw
          .prepare("SELECT COUNT(*) c FROM artifact_pins p JOIN artifacts a ON a.artifact_id = p.artifact_id WHERE owner_session_id = ? AND root_kind = 'session_anchor' AND a.kind = 'snapshot_manifest'")
          .get(spawn.session_id) as { c: number }).c;

      expect(anchorCount()).toBe(1); // initial baseline

      const t1 = h.sendTask(spawn.session_id, "t1");
      h.adapter.plan(t1.turn_id, [
        { kind: "workspace_write", files: [{ path: "src/feat.c", content: "feature" }] },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      // Initial + latest: exactly two anchors after one validated result.
      expect(anchorCount()).toBe(2);

      h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" });
      await settle(h);
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("CLOSED");
      expect(anchorCount()).toBe(0); // close releases session roots (§6.4)
    } finally {
      h.cleanup();
    }
  });

  it("final snapshot anchor transfer never prunes a report pin (non-manifest anchors survive)", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();

      // Seed a session-anchored REPORT artifact (e.g. a deliberate retained
      // report root) alongside the initial snapshot anchor.
      const report = h.publishArtifact("retained-report-body", "report");
      h.db.raw
        .prepare(
          "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, 'session_anchor', ?, NULL, ?)",
        )
        .run("pin-report-anchor", report.artifact_id, spawn.session_id, 5_000);

      const t1 = h.sendTask(spawn.session_id, "t1-prune-guard");
      h.adapter.plan(t1.turn_id, [
        { kind: "workspace_write", files: [{ path: "src/pruned.c", content: "x" }] },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      // The snapshot anchor set rotated to initial+latest, but the report
      // anchor was NOT removed by the transfer.
      const anchors = h.db.raw
        .prepare("SELECT artifact_id FROM artifact_pins WHERE owner_session_id = ? AND root_kind = 'session_anchor'")
        .all(spawn.session_id) as Array<{ artifact_id: string }>;
      expect(anchors.some((a) => a.artifact_id === report.artifact_id)).toBe(true);
      expect(anchors.length).toBe(4); // initial + latest final + retained report + latest native report
    } finally {
      h.cleanup();
    }
  });

  it("provisioning failure on an unreadable workspace → BLOCKED with recorded reason (§6.1)", async () => {
    const h = createHarness();
    try {
      const { settle } = await import("../helpers/harness.ts");
      // Registered workspace whose directory does not exist: admission is
      // fine, the capture fails during provisioning → BLOCKED, no deletion.
      insertWorkspaceDirect(h.db, {
        workspace_id: "ws-broken",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: path.join(h.workspaceRoot, "definitely-missing"),
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const spawnReq = {
        project_id: h.seed.projectId,
        idempotency_key: "spawn-bad",
        provider: "mock",
        account_profile_id: h.seed.accountMock1,
        model: "mock-model-1",
        effort: null,
        role: "worker" as const,
        instructions: "x",
        workspace: { mode: "current" as const, workspace_id: "ws-broken" },
        policy_profile_id: "pol-writer",
      };
      const spawn = h.core.spawn(h.seed.coordinatorId, spawnReq);
      expect(spawn.state).toBe("BLOCKED");
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.block_reason).toContain("provisioning-failed");
      // Same-key replay returns the same failed provisioning — no duplicate.
      const replay = h.core.spawn(h.seed.coordinatorId, spawnReq);
      expect(replay.session_id).toBe(spawn.session_id);
      expect(replay.replayed_request).toBe(true);
      // A BLOCKED failed-provisioning session safe-closes (§6.4/A43).
      h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-bad" });
      await settle(h);
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("CLOSED");
    } finally {
      h.cleanup();
    }
  });
});
