import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { diffSnapshots, renderDiffDocument } from "../../src/snapshots/diff.ts";
import type { SnapshotManifest, SnapshotManifestEntry } from "../../src/shared/api-types.ts";

function makeManifest(entries: SnapshotManifestEntry[]): SnapshotManifest {
  return {
    snapshot_id: "snap-test",
    project_id: "proj-test",
    workspace_id: "ws-test",
    coverage: {
      profile_id: "cov-test",
      version: "1",
      contract_hash: "hash-test",
    },
    entries,
    source_digest: "digest-test",
    non_source_observed: [],
    protected_observed: [],
    excluded_observed: [],
    capture_consistency: "broker_exclusive",
    git_provenance: null,
    captured_at: 1000,
  };
}

describe("snapshot diff (§7.1.1, §9.4)", () => {
  it("added/modified/deleted classification + summary", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    const hashOldA = registerBlob("old a\n");
    const hashB = registerBlob("b\n");
    const hashNewA = registerBlob("new a\n");
    const hashC = registerBlob("c\n");

    const baseline = makeManifest([
      { path: "a.c", type: "file", content_hash: hashOldA, executable: false, size: 6 },
      { path: "b.c", type: "file", content_hash: hashB, executable: false, size: 2 },
    ]);

    const target = makeManifest([
      { path: "a.c", type: "file", content_hash: hashNewA, executable: false, size: 6 },
      { path: "c.c", type: "file", content_hash: hashC, executable: false, size: 2 },
    ]);

    const result = diffSnapshots(baseline, target, readBlob);

    expect(result.summary).toMatch(/3 files changed: 1 added, 1 modified, 1 deleted/);
    expect(result.files).toHaveLength(3);

    // Sorted by path: a.c, b.c, c.c
    expect(result.files[0]?.path).toBe("a.c");
    expect(result.files[0]?.kind).toBe("modified");
    expect(result.files[0]?.old_hash).toBe(hashOldA);
    expect(result.files[0]?.new_hash).toBe(hashNewA);
    expect(result.files[0]?.old_hash).not.toBe(result.files[0]?.new_hash);

    expect(result.files[1]?.path).toBe("b.c");
    expect(result.files[1]?.kind).toBe("deleted");
    expect(result.files[1]?.old_hash).toBe(hashB);
    expect(result.files[1]?.new_hash).toBeNull();

    expect(result.files[2]?.path).toBe("c.c");
    expect(result.files[2]?.kind).toBe("added");
    expect(result.files[2]?.old_hash).toBeNull();
    expect(result.files[2]?.new_hash).toBe(hashC);
  });

  it("unified diff text for a modified file", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    const hashOldA = registerBlob("old a\n");
    const hashNewA = registerBlob("new a\n");

    const baseline = makeManifest([
      { path: "a.c", type: "file", content_hash: hashOldA, executable: false, size: 6 },
    ]);
    const target = makeManifest([
      { path: "a.c", type: "file", content_hash: hashNewA, executable: false, size: 6 },
    ]);

    const result = diffSnapshots(baseline, target, readBlob);
    const entry = result.files[0];
    expect(entry).toBeDefined();
    expect(entry?.text).not.toBeNull();
    expect(entry?.text).toContain("--- a/a.c");
    expect(entry?.text).toContain("+++ b/a.c");
    expect(entry?.text).toContain("-old a");
    expect(entry?.text).toContain("+new a");
  });

  it("added file shows only + lines; deleted only - lines; readBlob null → text null", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    const hashAdded = registerBlob("line 1\nline 2\n");
    const hashDeleted = registerBlob("old line\n");
    const missingHash = createHash("sha256").update("missing").digest("hex");

    const baseline = makeManifest([
      { path: "deleted.txt", type: "file", content_hash: hashDeleted, executable: false, size: 9 },
      { path: "missing.txt", type: "file", content_hash: missingHash, executable: false, size: 7 },
    ]);
    const target = makeManifest([
      { path: "added.txt", type: "file", content_hash: hashAdded, executable: false, size: 14 },
    ]);

    const result = diffSnapshots(baseline, target, readBlob);
    const addedEntry = result.files.find((f) => f.path === "added.txt");
    const deletedEntry = result.files.find((f) => f.path === "deleted.txt");
    const missingEntry = result.files.find((f) => f.path === "missing.txt");

    expect(addedEntry).toBeDefined();
    expect(addedEntry?.text).not.toBeNull();
    const addedLines = (addedEntry?.text ?? "").split("\n").slice(3); // skip ---, +++, @@ header
    expect(addedLines.every((l) => l.startsWith("+"))).toBe(true);

    expect(deletedEntry).toBeDefined();
    expect(deletedEntry?.text).not.toBeNull();
    const deletedLines = (deletedEntry?.text ?? "").split("\n").slice(3); // skip header
    expect(deletedLines.every((l) => l.startsWith("-"))).toBe(true);

    expect(missingEntry).toBeDefined();
    expect(missingEntry?.text).toBeNull();
  });

  it("unchanged files produce no entries", () => {
    const readBlob = (): Uint8Array | null => null;
    const hash = createHash("sha256").update("content").digest("hex");

    const baseline = makeManifest([
      { path: "same.txt", type: "file", content_hash: hash, executable: false, size: 7 },
    ]);
    const target = makeManifest([
      { path: "same.txt", type: "file", content_hash: hash, executable: false, size: 7 },
    ]);

    const result = diffSnapshots(baseline, target, readBlob);
    expect(result.files).toEqual([]);
    expect(result.summary).toBe("0 files changed: 0 added, 0 modified, 0 deleted");
  });

  it("renderDiffDocument truncates at maxBytes with a trailing notice", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    const hashOld = registerBlob("line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\n");
    const hashNew = registerBlob("line 1\nmodified 2\nline 3\nmodified 4\nline 5\nmodified 6\nline 7\n");

    const baseline = makeManifest([
      { path: "large.txt", type: "file", content_hash: hashOld, executable: false, size: 56 },
    ]);
    const target = makeManifest([
      { path: "large.txt", type: "file", content_hash: hashNew, executable: false, size: 62 },
    ]);

    const diff = diffSnapshots(baseline, target, readBlob);
    const fullDoc = renderDiffDocument(diff, 100_000);
    const fullByteLength = Buffer.byteLength(fullDoc, "utf8");

    // Set maxBytes smaller than the full document
    const maxBytes = Math.floor(fullByteLength / 2);
    const truncatedDoc = renderDiffDocument(diff, maxBytes);

    expect(truncatedDoc.endsWith("[diff truncated]")).toBe(true);
    expect(Buffer.byteLength(truncatedDoc, "utf8")).toBeLessThanOrEqual(maxBytes);
  });

  it("directories are ignored", () => {
    const readBlob = (): Uint8Array | null => null;

    const baseline = makeManifest([
      { path: "src", type: "dir", content_hash: null, executable: false, size: null },
      { path: "common", type: "dir", content_hash: null, executable: false, size: null },
    ]);
    const target = makeManifest([
      { path: "dist", type: "dir", content_hash: null, executable: false, size: null },
      { path: "common", type: "dir", content_hash: null, executable: false, size: null },
    ]);

    const result = diffSnapshots(baseline, target, readBlob);
    expect(result.files).toEqual([]);
    expect(result.summary).toBe("0 files changed: 0 added, 0 modified, 0 deleted");
  });
});
