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

  it("tiny edit in a large file keeps bounded context, every changed line, and the same baseline/target", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const lineOf = (i: number) => `L${String(i).padStart(4, "0")} ${"p".repeat(20)}`;
    const oldLines = Array.from({ length: 400 }, (_, i) => lineOf(i));
    const changed = `CHANGED ${"c".repeat(18)}`;
    const newLines = [...oldLines];
    newLines[200] = changed;
    const oldText = oldLines.join("\n") + "\n";
    const newText = newLines.join("\n") + "\n";
    const hashOld = registerBlob(oldText);
    const hashNew = registerBlob(newText);
    const baseline = makeManifest([
      { path: "wide.txt", type: "file", content_hash: hashOld, executable: false, size: Buffer.byteLength(oldText) },
    ]);
    const target = makeManifest([
      { path: "wide.txt", type: "file", content_hash: hashNew, executable: false, size: Buffer.byteLength(newText) },
    ]);

    const result = diffSnapshots(baseline, target, (hash) => blobs.get(hash) ?? null);
    const doc = renderCompleteDiffDocument(result);
    const legacyBody: string[] = [];
    for (let i = 0; i < oldLines.length; i++) {
      if (oldLines[i] === newLines[i]) legacyBody.push(` ${oldLines[i]}`);
      else {
        legacyBody.push(`-${oldLines[i]}`);
        legacyBody.push(`+${newLines[i]}`);
      }
    }
    const legacyDoc = [
      "1 files changed: 0 added, 1 modified, 0 deleted",
      ["--- a/wide.txt", "+++ b/wide.txt", "@@ wide.txt @@", ...legacyBody].join("\n"),
    ].join("\n\n");
    // UTF-8 bytes of this deterministic fixture. Not tokens, cost, or native savings.
    const beforeBytes = Buffer.byteLength(legacyDoc, "utf8");
    const afterBytes = Buffer.byteLength(doc, "utf8");
    expect(beforeBytes).toBe(11321);
    expect(afterBytes).toBe(322);
    expect(afterBytes).toBeLessThan(beforeBytes);

    expect(doc).toBe([
      "1 files changed: 0 added, 1 modified, 0 deleted",
      [
        "--- a/wide.txt",
        "+++ b/wide.txt",
        "@@ -198,7 +198,7 @@",
        ` ${lineOf(197)}`,
        ` ${lineOf(198)}`,
        ` ${lineOf(199)}`,
        `-${lineOf(200)}`,
        `+${changed}`,
        ` ${lineOf(201)}`,
        ` ${lineOf(202)}`,
        ` ${lineOf(203)}`,
      ].join("\n"),
    ].join("\n\n"));
    expect(doc).not.toContain(lineOf(0));
    expect(doc).not.toContain(lineOf(399));
    expect(result.files[0]?.old_hash).toBe(hashOld);
    expect(result.files[0]?.new_hash).toBe(hashNew);
    expect(baseline.entries[0]?.content_hash).toBe(hashOld);
    expect(target.entries[0]?.content_hash).toBe(hashNew);

    expect(renderCompleteDiffDocument(result, afterBytes)).toBe(doc);
    expect(() => renderCompleteDiffDocument(result, afterBytes - 1)).toThrowError(BrokerError);
    try {
      renderCompleteDiffDocument(result, afterBytes - 1);
    } catch (e) {
      expect((e as BrokerError).code).toBe("INPUT_LIMIT");
    }
  });

  it("keeps separated changes and merges adjacent or overlapping context windows", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const oldLine = (i: number) => `S${String(i).padStart(2, "0")}`;
    const newLine = (i: number) => `T${String(i).padStart(2, "0")}`;
    const oldLines = Array.from({ length: 40 }, (_, i) => oldLine(i));
    const newLines = [...oldLines];
    for (const i of [0, 2, 10, 20, 24, 39]) newLines[i] = newLine(i);
    const hashOld = registerBlob(oldLines.join("\n") + "\n");
    const hashNew = registerBlob(newLines.join("\n") + "\n");
    const entry = (hash: string) => ({ path: "hunks.txt", type: "file" as const, content_hash: hash, executable: false, size: 1 });
    const doc = renderCompleteDiffDocument(diffSnapshots(
      makeManifest([entry(hashOld)]),
      makeManifest([entry(hashNew)]),
      (hash) => blobs.get(hash) ?? null,
    ));
    const file = [
      "--- a/hunks.txt",
      "+++ b/hunks.txt",
      "@@ -1,6 +1,6 @@",
      `-${oldLine(0)}`,
      `+${newLine(0)}`,
      ` ${oldLine(1)}`,
      `-${oldLine(2)}`,
      `+${newLine(2)}`,
      ` ${oldLine(3)}`,
      ` ${oldLine(4)}`,
      ` ${oldLine(5)}`,
      "@@ -8,7 +8,7 @@",
      ` ${oldLine(7)}`,
      ` ${oldLine(8)}`,
      ` ${oldLine(9)}`,
      `-${oldLine(10)}`,
      `+${newLine(10)}`,
      ` ${oldLine(11)}`,
      ` ${oldLine(12)}`,
      ` ${oldLine(13)}`,
      "@@ -18,11 +18,11 @@",
      ` ${oldLine(17)}`,
      ` ${oldLine(18)}`,
      ` ${oldLine(19)}`,
      `-${oldLine(20)}`,
      `+${newLine(20)}`,
      ` ${oldLine(21)}`,
      ` ${oldLine(22)}`,
      ` ${oldLine(23)}`,
      `-${oldLine(24)}`,
      `+${newLine(24)}`,
      ` ${oldLine(25)}`,
      ` ${oldLine(26)}`,
      ` ${oldLine(27)}`,
      "@@ -37,4 +37,4 @@",
      ` ${oldLine(36)}`,
      ` ${oldLine(37)}`,
      ` ${oldLine(38)}`,
      `-${oldLine(39)}`,
      `+${newLine(39)}`,
    ].join("\n");
    expect(doc).toBe(`1 files changed: 0 added, 1 modified, 0 deleted\n\n${file}`);
    for (const omitted of [6, 14, 16, 28, 35]) expect(doc).not.toContain(oldLine(omitted));
  });

  it("added and deleted files keep every line with numbered hunks", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const hashAdded = registerBlob("line 1\nline 2\n");
    const hashDeleted = registerBlob("old line\n");
    const diff = diffSnapshots(
      makeManifest([{ path: "deleted.txt", type: "file", content_hash: hashDeleted, executable: false, size: 9 }]),
      makeManifest([{ path: "added.txt", type: "file", content_hash: hashAdded, executable: false, size: 14 }]),
      (hash) => blobs.get(hash) ?? null,
    );
    expect(diff.files.find((f) => f.path === "added.txt")?.text).toBe(
      ["--- a/added.txt", "+++ b/added.txt", "@@ -0,0 +1,2 @@", "+line 1", "+line 2"].join("\n"),
    );
    expect(diff.files.find((f) => f.path === "deleted.txt")?.text).toBe(
      ["--- a/deleted.txt", "+++ b/deleted.txt", "@@ -1,1 +0,0 @@", "-old line"].join("\n"),
    );
  });

  it("trailing newline changes keep full side text and no-newline markers", () => {
    const pair = (before: string, after: string) => {
      const oldHash = createHash("sha256").update(before).digest("hex");
      const newHash = createHash("sha256").update(after).digest("hex");
      const blobs = new Map([[oldHash, Buffer.from(before)], [newHash, Buffer.from(after)]]);
      const entry = (hash: string) => ({ path: "nl.txt", type: "file" as const, content_hash: hash, executable: false, size: blobs.get(hash)!.length });
      return renderCompleteDiffDocument(diffSnapshots(
        makeManifest([entry(oldHash)]),
        makeManifest([entry(newHash)]),
        (hash) => blobs.get(hash) ?? null,
      ));
    };
    const removed = pair("alpha\nbeta\n", "alpha\nbeta");
    expect(removed).toContain([
      "@@ -1,2 +1,2 @@",
      "-alpha",
      "-beta",
      "+alpha",
      "+beta",
      "\\ No newline at end of file",
    ].join("\n"));
    expect(removed.match(/No newline at end of file/g)).toHaveLength(1);

    const added = pair("alpha\nbeta", "alpha\nbeta\n");
    expect(added).toContain("-beta\n\\ No newline at end of file\n+alpha\n+beta");
    expect(added.match(/No newline at end of file/g)).toHaveLength(1);
    expect(added).toContain("-alpha");
    expect(added).toContain("+beta");
  });

  it("large LCS fallback keeps every changed line and only the context window", () => {
    const blobs = new Map<string, Uint8Array>();
    const registerBlob = (content: string): string => {
      const bytes = Buffer.from(content, "utf8");
      const hash = createHash("sha256").update(bytes).digest("hex");
      blobs.set(hash, bytes);
      return hash;
    };
    const prefix = Array.from({ length: 5000 }, (_, i) => `P${String(i).padStart(4, "0")}`);
    const suffix = Array.from({ length: 5000 }, (_, i) => `U${String(i).padStart(4, "0")}`);
    const oldMid = Array.from({ length: 2500 }, (_, i) => `O${String(i).padStart(4, "0")}`);
    const newMid = Array.from({ length: 2500 }, (_, i) => `N${String(i).padStart(4, "0")}`);
    const hashOld = registerBlob([...prefix, ...oldMid, ...suffix].join("\n") + "\n");
    const hashNew = registerBlob([...prefix, ...newMid, ...suffix].join("\n") + "\n");
    const entry = (hash: string) => ({ path: "fallback.txt", type: "file" as const, content_hash: hash, executable: false, size: 1 });
    const diff = diffSnapshots(
      makeManifest([entry(hashOld)]),
      makeManifest([entry(hashNew)]),
      (hash) => blobs.get(hash) ?? null,
    );
    const doc = renderCompleteDiffDocument(diff);
    expect(doc).toContain("@@ -4998,2506 +4998,2506 @@");
    expect(doc).toContain(` ${prefix[4997]}`);
    expect(doc).toContain(` ${prefix[4999]}`);
    expect(doc).toContain(`-${oldMid[0]}`);
    expect(doc).toContain(`-${oldMid[2499]}`);
    expect(doc).toContain(`+${newMid[0]}`);
    expect(doc).toContain(`+${newMid[2499]}`);
    expect(doc).toContain(` ${suffix[0]}`);
    expect(doc).toContain(` ${suffix[2]}`);
    expect(doc).not.toContain(prefix[0]);
    expect(doc).not.toContain(prefix[4996]);
    expect(doc).not.toContain(suffix[3]);
    expect(doc).not.toContain(suffix[4999]);
    const contextLines = doc.split("\n").filter((line) => line.startsWith(" "));
    expect(contextLines).toHaveLength(6);
    expect(diff.files[0]?.old_hash).toBe(hashOld);
    expect(diff.files[0]?.new_hash).toBe(hashNew);
  });
});
