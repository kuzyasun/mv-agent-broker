/** Manual snapshot, bounded input, and blob-integrity behavior. */
import { describe, expect, it } from "vitest";
import { linkSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createHarness, COVERAGE_CONFIG } from "../helpers/harness.ts";
import { captureSnapshot } from "../../src/snapshots/capture.ts";
import { computeSourceDigest, takeInventory } from "../../src/workspaces/inventory.ts";
import { CoverageError } from "../../src/workspaces/coverage.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { ManualClock } from "../../src/shared/clock.ts";

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

// ─── whole-project root prefix (operator default coverage) ──────────────────

const ROOT_COVERAGE_CONFIG = {
  source_prefixes: ["."],
  non_source_prefixes: [],
  excluded_prefixes: [".git", "node_modules"],
};

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

  it("root coverage admits undeclared root entries and keeps exclusions", () => {
    const h = createHarness();
    try {
      h.writeWorkspaceFile("NEW_ROOT.md", "root");
      h.writeWorkspaceFile("test-docs/note.md", "doc");
      h.writeWorkspaceFile("node_modules/pkg/index.js", "cached");
      const inv = takeInventory(h.workspaceRoot, ROOT_COVERAGE_CONFIG);
      const paths = inv.entries.filter((e) => e.type === "file").map((e) => e.path);
      expect(paths).toContain("src/main.c");
      expect(paths).toContain("NEW_ROOT.md");
      expect(paths).toContain("test-docs/note.md");
      expect(paths).not.toContain("node_modules/pkg/index.js");
      expect(inv.protectedObserved).toEqual([]);
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

// ─── explicit snapshot capture semantics ────────────────────────────────────

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
});
