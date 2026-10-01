import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  diffSnapshots,
  renderDiffDocument,
  renderCompleteDiffDocument,
  renderDiffDocumentPreview,
  DEFAULT_MAX_DIFF_BYTES,
} from "../../src/snapshots/diff.ts";
import { BrokerError } from "../../src/shared/errors.ts";
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

  it("renderDiffDocumentPreview truncates at maxBytes with a trailing notice", () => {
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
    const fullDoc = renderDiffDocumentPreview(diff, 100_000);
    const fullByteLength = Buffer.byteLength(fullDoc, "utf8");

    // Set maxBytes smaller than the full document
    const maxBytes = Math.floor(fullByteLength / 2);
    const truncatedDoc = renderDiffDocumentPreview(diff, maxBytes);

    expect(truncatedDoc.endsWith("[diff truncated]")).toBe(true);
    expect(Buffer.byteLength(truncatedDoc, "utf8")).toBeLessThanOrEqual(maxBytes);

    // Backward-compatible alias check
    expect(renderDiffDocument(diff, maxBytes)).toBe(truncatedDoc);
  });

  it("complete diffs preserve BOM, CRLF edits and separate missing newline markers", () => {
    for (const [before, after] of [["a\r\n", "a\n"], ["\ufeffa\n", "a\n"], ["old\ntail", "new\ntail"]]) {
      const oldHash = createHash("sha256").update(before!).digest("hex");
      const newHash = createHash("sha256").update(after!).digest("hex");
      const blobs = new Map([[oldHash, Buffer.from(before!)], [newHash, Buffer.from(after!)]]);
      const entry = (hash: string) => ({ path: "text.txt", type: "file" as const, content_hash: hash, executable: false, size: blobs.get(hash)!.length });
      const doc = renderCompleteDiffDocument(diffSnapshots(makeManifest([entry(oldHash)]), makeManifest([entry(newHash)]), h => blobs.get(h) ?? null));
      if (before!.includes("\r")) expect(doc).toContain("-a\r\n+a");
      if (before!.startsWith("\ufeff")) expect(doc).toContain("-\ufeffa\n+a");
      if (!before!.endsWith("\n")) {
        expect(doc.match(/No newline at end of file/g)).toHaveLength(2);
        expect(doc).toContain("-tail\n\\ No newline at end of file");
        expect(doc).toContain("+tail\n\\ No newline at end of file");
      }
    }
  });

  it("renderCompleteDiffDocument with >256KiB changed text: all tails and late files present, exact hash and size", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (bytes: Uint8Array): string => {
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    // Generate ~300KiB across two files
    const largeOld = Buffer.from("line " + "A".repeat(80) + "\n", "utf8");
    const largeNewLines: string[] = [];
    for (let i = 0; i < 3500; i++) {
      largeNewLines.push(`line ${i} ${"B".repeat(80)}`);
    }
    const largeNew = Buffer.from(largeNewLines.join("\n") + "\n", "utf8");
    const lateContent = Buffer.from("final late file content line\n", "utf8");

    const hashOld = registerBlob(largeOld);
    const hashNew = registerBlob(largeNew);
    const hashLate = registerBlob(lateContent);

    const baseline = makeManifest([
      { path: "src/big.txt", type: "file", content_hash: hashOld, executable: false, size: largeOld.byteLength },
    ]);
    const target = makeManifest([
      { path: "src/big.txt", type: "file", content_hash: hashNew, executable: false, size: largeNew.byteLength },
      { path: "tests/z_late.txt", type: "file", content_hash: hashLate, executable: false, size: lateContent.byteLength },
    ]);

    const diff = diffSnapshots(baseline, target, readBlob);
    const completeDoc = renderCompleteDiffDocument(diff);
    const byteSize = Buffer.byteLength(completeDoc, "utf8");

    expect(byteSize).toBeGreaterThan(256 * 1024);
    expect(completeDoc.includes("[diff truncated]")).toBe(false);
    expect(completeDoc).toContain("+++ b/tests/z_late.txt");
    expect(completeDoc).toContain("+final late file content line");
    expect(completeDoc).toContain(`line 3499 ${"B".repeat(80)}`);

    const expectedHash = createHash("sha256").update(Buffer.from(completeDoc, "utf8")).digest("hex");
    expect(createHash("sha256").update(completeDoc).digest("hex")).toBe(expectedHash);
  });

  it("modified source exceeding LCS cell budget uses linear fallback with complete changes", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (contentHash: string): Uint8Array | null => blobs.get(contentHash) ?? null;

    // 2500 lines old, 2500 lines new -> (2501)*(2501) = 6.25M > LCS_CELL_BUDGET (4M)
    const oldLines: string[] = [];
    const newLines: string[] = [];
    for (let i = 0; i < 2500; i++) {
      oldLines.push(`old line ${i}`);
      newLines.push(`new line ${i}`);
    }
    const hashOld = registerBlob(oldLines.join("\n") + "\n");
    const hashNew = registerBlob(newLines.join("\n") + "\n");

    const baseline = makeManifest([
      { path: "huge.txt", type: "file", content_hash: hashOld, executable: false, size: 100 },
    ]);
    const target = makeManifest([
      { path: "huge.txt", type: "file", content_hash: hashNew, executable: false, size: 100 },
    ]);

    const diff = diffSnapshots(baseline, target, readBlob);
    expect(diff.files[0]?.text).not.toBeNull();
    const doc = renderCompleteDiffDocument(diff);
    expect(doc).toContain("-old line 0");
    expect(doc).toContain("-old line 2499");
    expect(doc).toContain("+new line 0");
    expect(doc).toContain("+new line 2499");
  });

  it("missing source blob fails with ARTIFACT_CORRUPT in renderCompleteDiffDocument", () => {
    const readBlob = (): Uint8Array | null => null;
    const baseline = makeManifest([
      { path: "missing.txt", type: "file", content_hash: "0".repeat(64), executable: false, size: 10 },
    ]);
    const target = makeManifest([]);

    const diff = diffSnapshots(baseline, target, readBlob);
    expect(() => renderCompleteDiffDocument(diff)).toThrowError(BrokerError);
    try {
      renderCompleteDiffDocument(diff);
    } catch (e) {
      expect((e as BrokerError).code).toBe("ARTIFACT_CORRUPT");
    }
  });

  it("unsupported binary or invalid UTF-8 fails with INPUT_UNSUPPORTED in renderCompleteDiffDocument", () => {
    const blobs = new Map<string, Uint8Array>();
    const readBlob = (h: string) => blobs.get(h) ?? null;

    // Invalid UTF-8 bytes
    const badUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    const badHash = createHash("sha256").update(badUtf8).digest("hex");
    blobs.set(badHash, badUtf8);

    const baseBad = makeManifest([]);
    const targetBad = makeManifest([
      { path: "bad.bin", type: "file", content_hash: badHash, executable: false, size: 3 },
    ]);

    const diffBad = diffSnapshots(baseBad, targetBad, readBlob);
    expect(diffBad.files[0]?.error).toBe("invalid_utf8");
    expect(() => renderCompleteDiffDocument(diffBad)).toThrowError(BrokerError);
    try {
      renderCompleteDiffDocument(diffBad);
    } catch (e) {
      expect((e as BrokerError).code).toBe("INPUT_UNSUPPORTED");
    }

    // Binary file with NUL byte
    const binBytes = Buffer.from("hello\0world", "utf8");
    const binHash = createHash("sha256").update(binBytes).digest("hex");
    blobs.set(binHash, binBytes);

    const targetBin = makeManifest([
      { path: "app.exe", type: "file", content_hash: binHash, executable: false, size: binBytes.byteLength },
    ]);
    const diffBin = diffSnapshots(baseBad, targetBin, readBlob);
    expect(diffBin.files[0]?.error).toBe("binary");
    expect(() => renderCompleteDiffDocument(diffBin)).toThrowError(BrokerError);
  });

  it("Unicode and no-newline semantics", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const readBlob = (h: string) => blobs.get(h) ?? null;

    // Multibyte Unicode file without trailing newline
    const h1 = registerBlob("константа = \"тест 🚀\""); // no newline
    const h2 = registerBlob("константа = \"тест 🚀\"\nновое = 123"); // no newline

    const baseline = makeManifest([
      { path: "unicode.txt", type: "file", content_hash: h1, executable: false, size: 20 },
    ]);
    const target = makeManifest([
      { path: "unicode.txt", type: "file", content_hash: h2, executable: false, size: 35 },
    ]);

    const diff = diffSnapshots(baseline, target, readBlob);
    const doc = renderCompleteDiffDocument(diff);
    expect(doc).toContain("+новое = 123");
    expect(doc).toContain("\\ No newline at end of file");
  });

  it("diff exceeding finite complete-diff budget throws INPUT_LIMIT", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const h = registerBlob("a".repeat(200));
    const target = makeManifest([
      { path: "a.txt", type: "file", content_hash: h, executable: false, size: 200 },
    ]);
    const diff = diffSnapshots(makeManifest([]), target, (hash) => blobs.get(hash) ?? null);
    // Budget smaller than diff size
    expect(() => renderCompleteDiffDocument(diff, 50)).toThrowError(BrokerError);
    try {
      renderCompleteDiffDocument(diff, 50);
    } catch (e) {
      expect((e as BrokerError).code).toBe("INPUT_LIMIT");
    }
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
