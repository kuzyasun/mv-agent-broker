import type { SnapshotManifest } from "../shared/api-types.ts";
import { BrokerError } from "../shared/errors.ts";

export interface ManifestFileDiff {
  path: string;
  kind: "added" | "modified" | "deleted";
  old_hash: string | null;
  new_hash: string | null;
  /** Unified-diff-style text for added/modified/deleted file content (null when content unavailable). */
  text: string | null;
  error?: "missing_blob" | "invalid_utf8" | "binary";
}

/** Documented finite complete-diff budget: default 32 MiB, configurable via limits.maxReviewDiffBytes. */
export const DEFAULT_MAX_DIFF_BYTES = 32 * 1024 * 1024;

/** Hard upper bound for the configured complete-diff budget. */
export const MAX_REVIEW_DIFF_BYTES = 256 * 1024 * 1024;

/** Safely decode UTF-8 bytes and check for binary / invalid UTF-8. */
function safeDecodeBlob(bytes: Uint8Array | null): {
  ok: true;
  content: string;
  hasTrailingNewline: boolean;
} | {
  ok: false;
  error: "missing_blob" | "invalid_utf8" | "binary";
} {
  if (bytes === null) {
    return { ok: false, error: "missing_blob" };
  }
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const content = decoder.decode(bytes);
    if (content.includes("\0")) {
      return { ok: false, error: "binary" };
    }
    const hasTrailingNewline = content.endsWith("\n") || content.endsWith("\r\n");
    return { ok: true, content, hasTrailingNewline };
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
}

/** Split string into lines; strips trailing newline if present. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  // Keep CR bytes: normalizing line endings silently hides CRLF/LF edits.
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** LCS cell budget: larger modified files fall back to deterministic linear fallback
 * instead of OOM-ing the daemon or omitting changed files. */
const LCS_CELL_BUDGET = 4 * 1024 * 1024;

/** Compute LCS-based line differences for modified files; falls back to compact complete hunks / deterministic linear remove/add when DP exceeds budget. */
function diffLines(
  oldLines: string[],
  newLines: string[],
  oldHasNewline: boolean = true,
  newHasNewline: boolean = true,
): string[] {
  if (!oldHasNewline || !newHasNewline) {
    // A full replacement is unambiguous even with common suffix lines:
    // each missing newline marker belongs to its own side's last line.
    const removed = oldLines.map(line => `-${line}`);
    const added = newLines.map(line => `+${line}`);
    if (oldLines.length && !oldHasNewline) removed.push("\\ No newline at end of file");
    if (newLines.length && !newHasNewline) added.push("\\ No newline at end of file");
    return [...removed, ...added];
  }
  if (
    oldLines.length > 0 &&
    oldLines.length === newLines.length &&
    oldLines.every((l, idx) => l === newLines[idx])
  ) {
    return oldLines.map(line => ` ${line}`);
  }

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }
  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const prefix = oldLines.slice(0, start).map((l) => ` ${l}`);
  const suffix = oldLines.slice(oldEnd + 1).map((l) => ` ${l}`);
  const midOld = oldLines.slice(start, oldEnd + 1);
  const midNew = newLines.slice(start, newEnd + 1);

  const n = midOld.length;
  const m = midNew.length;

  let midResult: string[];
  if ((n + 1) * (m + 1) > LCS_CELL_BUDGET) {
    // Deterministic linear fallback: all old removed, all new added
    midResult = [
      ...midOld.map((l) => `-${l}`),
      ...midNew.map((l) => `+${l}`),
    ];
  } else {
    const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = 0; i < n; i++) {
      const oldLine = midOld[i]!;
      const dpI = dp[i]!;
      const dpNext = dp[i + 1]!;
      for (let j = 0; j < m; j++) {
        if (oldLine === midNew[j]!) {
          dpNext[j + 1] = dpI[j]! + 1;
        } else {
          const top = dpI[j + 1]!;
          const left = dpNext[j]!;
          dpNext[j + 1] = top > left ? top : left;
        }
      }
    }

    const res: string[] = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && midOld[i - 1]! === midNew[j - 1]!) {
        res.push(` ${midOld[i - 1]!}`);
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
        res.push(`+${midNew[j - 1]!}`);
        j--;
      } else if (i > 0) {
        res.push(`-${midOld[i - 1]!}`);
        i--;
      }
    }
    midResult = res.reverse();
  }

  return [...prefix, ...midResult, ...suffix];
}

/** Format file unified-diff text given body lines. */
function formatUnifiedDiff(path: string, body: string[]): string {
  const header = [`--- a/${path}`, `+++ b/${path}`, `@@ ${path} @@`];
  return [...header, ...body].join("\n");
}

/** Compute file-level differences + a textual patch. readBlob returns file bytes by content hash or null. Identical coverage binding is the caller's responsibility (§9.5). */
export function diffSnapshots(
  baseline: SnapshotManifest,
  target: SnapshotManifest,
  readBlob: (contentHash: string) => Uint8Array | null,
): { files: ManifestFileDiff[]; summary: string } {
  const baselineFiles = new Map<string, string | null>();
  for (const entry of baseline.entries) {
    if (entry.type === "file") {
      baselineFiles.set(entry.path, entry.content_hash);
    }
  }

  const targetFiles = new Map<string, string | null>();
  for (const entry of target.entries) {
    if (entry.type === "file") {
      targetFiles.set(entry.path, entry.content_hash);
    }
  }

  const allPaths = new Set<string>([...baselineFiles.keys(), ...targetFiles.keys()]);
  const sortedPaths = Array.from(allPaths).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const files: ManifestFileDiff[] = [];
  let addedCount = 0;
  let modifiedCount = 0;
  let deletedCount = 0;

  for (const path of sortedPaths) {
    const inBaseline = baselineFiles.has(path);
    const inTarget = targetFiles.has(path);

    if (inTarget && !inBaseline) {
      addedCount++;
      const newHash = targetFiles.get(path) ?? null;
      let text: string | null = null;
      let error: "missing_blob" | "invalid_utf8" | "binary" | undefined;
      if (newHash !== null) {
        const bytes = readBlob(newHash);
        const decoded = safeDecodeBlob(bytes);
        if (decoded.ok) {
          const lines = splitLines(decoded.content);
          const body = lines.map((line) => `+${line}`);
          if (!decoded.hasTrailingNewline && lines.length > 0) {
            body.push("\\ No newline at end of file");
          }
          text = formatUnifiedDiff(path, body);
        } else {
          error = decoded.error;
        }
      }
      files.push({
        path,
        kind: "added",
        old_hash: null,
        new_hash: newHash,
        text,
        ...(error ? { error } : {}),
      });
    } else if (inBaseline && !inTarget) {
      deletedCount++;
      const oldHash = baselineFiles.get(path) ?? null;
      let text: string | null = null;
      let error: "missing_blob" | "invalid_utf8" | "binary" | undefined;
      if (oldHash !== null) {
        const bytes = readBlob(oldHash);
        const decoded = safeDecodeBlob(bytes);
        if (decoded.ok) {
          const lines = splitLines(decoded.content);
          const body = lines.map((line) => `-${line}`);
          if (!decoded.hasTrailingNewline && lines.length > 0) {
            body.push("\\ No newline at end of file");
          }
          text = formatUnifiedDiff(path, body);
        } else {
          error = decoded.error;
        }
      }
      files.push({
        path,
        kind: "deleted",
        old_hash: oldHash,
        new_hash: null,
        text,
        ...(error ? { error } : {}),
      });
    } else if (inBaseline && inTarget) {
      const oldHash = baselineFiles.get(path) ?? null;
      const newHash = targetFiles.get(path) ?? null;
      if (oldHash !== newHash) {
        modifiedCount++;
        let text: string | null = null;
        let error: "missing_blob" | "invalid_utf8" | "binary" | undefined;
        if (oldHash !== null && newHash !== null) {
          const oldBytes = readBlob(oldHash);
          const newBytes = readBlob(newHash);
          const oldDecoded = safeDecodeBlob(oldBytes);
          const newDecoded = safeDecodeBlob(newBytes);
          if (!oldDecoded.ok) {
            error = oldDecoded.error;
          } else if (!newDecoded.ok) {
            error = newDecoded.error;
          } else {
            const oldLines = splitLines(oldDecoded.content);
            const newLines = splitLines(newDecoded.content);
            const diffBody = diffLines(oldLines, newLines, oldDecoded.hasTrailingNewline, newDecoded.hasTrailingNewline);
            text = formatUnifiedDiff(path, diffBody);
          }
        }
        files.push({
          path,
          kind: "modified",
          old_hash: oldHash,
          new_hash: newHash,
          text,
          ...(error ? { error } : {}),
        });
      }
    }
  }

  const summary = `${files.length} files changed: ${addedCount} added, ${modifiedCount} modified, ${deletedCount} deleted`;

  return { files, summary };
}

/**
 * Render complete diff document without truncation (§7.1.1, §9.4).
 * Every changed file must have complete diff text; if any file cannot be diffed
 * (missing blob, invalid UTF-8, binary) or total size exceeds maxBytes, throws
 * explicit BrokerError so inference never starts with a partial diff.
 */
export function renderCompleteDiffDocument(
  diff: { files: ManifestFileDiff[]; summary: string },
  maxBytes: number = DEFAULT_MAX_DIFF_BYTES,
): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new BrokerError("INPUT_LIMIT", "Diff document byte limit must be positive.", { executionStarted: false });
  }

  const sections: string[] = [diff.summary];
  for (const file of diff.files) {
    if (file.text === null) {
      if (file.error === "missing_blob" ||
          (file.kind !== "added" && !file.old_hash) || (file.kind !== "deleted" && !file.new_hash)) {
        throw new BrokerError("ARTIFACT_CORRUPT", `Review diff cannot be generated: blob for ${file.path} is unavailable or corrupt.`, { executionStarted: false });
      }
      if (file.error === "invalid_utf8" || file.error === "binary") {
        throw new BrokerError("INPUT_UNSUPPORTED", `Review diff cannot be generated: file ${file.path} is binary or invalid UTF-8.`, { executionStarted: false });
      }
      throw new BrokerError("INPUT_DELIVERY_FAILED", `Review diff cannot be generated for ${file.path}: diff text is unavailable.`, { executionStarted: false });
    }
    sections.push(file.text);
  }

  const fullText = sections.join("\n\n");
  const byteLength = Buffer.byteLength(fullText, "utf8");
  if (byteLength > maxBytes) {
    throw new BrokerError("INPUT_LIMIT", `Complete review diff exceeds delivery limit (${byteLength} > ${maxBytes} bytes).`, { executionStarted: false });
  }

  return fullText;
}

/** Explicit preview-only renderer: truncates at maxBytes with a trailing notice. */
export function renderDiffDocumentPreview(
  diff: { files: ManifestFileDiff[]; summary: string },
  maxBytes: number,
): string {
  if (maxBytes <= 0) {
    return "";
  }

  const sections: string[] = [diff.summary];
  for (const file of diff.files) {
    if (file.text !== null) {
      sections.push(file.text);
    }
  }

  const fullText = sections.join("\n\n");
  if (Buffer.byteLength(fullText, "utf8") <= maxBytes) {
    return fullText;
  }

  const notice = "\n[diff truncated]";
  const noticeBytes = Buffer.byteLength(notice, "utf8");

  const lines = fullText.split("\n");
  let accumulatedBytes = 0;
  let bestK = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i]!, "utf8");
    const totalBytes = accumulatedBytes + lineBytes + i + noticeBytes;
    if (totalBytes <= maxBytes) {
      accumulatedBytes += lineBytes;
      bestK = i + 1;
    } else {
      break;
    }
  }

  if (bestK > 0) {
    return lines.slice(0, bestK).join("\n") + notice;
  }

  if (maxBytes >= noticeBytes) {
    return notice;
  }

  if (maxBytes >= 16) {
    return "[diff truncated]";
  }

  return "";
}

/** @deprecated Use renderDiffDocumentPreview for bounded preview or renderCompleteDiffDocument for execution. */
export const renderDiffDocument = renderDiffDocumentPreview;
