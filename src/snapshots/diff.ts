import type { SnapshotManifest } from "../shared/api-types.ts";

export interface ManifestFileDiff {
  path: string;
  kind: "added" | "modified" | "deleted";
  old_hash: string | null;
  new_hash: string | null;
  /** Unified-diff-style text for added/modified/deleted file content (null when content unavailable). */
  text: string | null;
}

/** Split string into lines; strips trailing newline if present. */
function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/** LCS cell budget: larger modified files fall back to a null text diff
 * (ManifestFileDiff.text contract) instead of OOM-ing the daemon. */
const LCS_CELL_BUDGET = 4 * 1024 * 1024;

/** Compute LCS-based line differences for modified files; null when the DP exceeds the cell budget. */
function diffLines(oldLines: string[], newLines: string[]): string[] | null {
  const n = oldLines.length;
  const m = newLines.length;

  if ((n + 1) * (m + 1) > LCS_CELL_BUDGET) {
    return null;
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = 0; i < n; i++) {
    const oldLine = oldLines[i]!;
    const dpI = dp[i]!;
    const dpNext = dp[i + 1]!;
    for (let j = 0; j < m; j++) {
      if (oldLine === newLines[j]!) {
        dpNext[j + 1] = dpI[j]! + 1;
      } else {
        const top = dpI[j + 1]!;
        const left = dpNext[j]!;
        dpNext[j + 1] = top > left ? top : left;
      }
    }
  }

  const result: string[] = [];
  let i = n;
  let j = m;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1]! === newLines[j - 1]!) {
      result.push(` ${oldLines[i - 1]!}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push(`+${newLines[j - 1]!}`);
      j--;
    } else if (i > 0) {
      result.push(`-${oldLines[i - 1]!}`);
      i--;
    }
  }

  return result.reverse();
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
  const decoder = new TextDecoder("utf-8");

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
      if (newHash !== null) {
        const bytes = readBlob(newHash);
        if (bytes !== null) {
          const content = decoder.decode(bytes);
          const lines = splitLines(content);
          text = formatUnifiedDiff(path, lines.map((line) => `+${line}`));
        }
      }
      files.push({
        path,
        kind: "added",
        old_hash: null,
        new_hash: newHash,
        text,
      });
    } else if (inBaseline && !inTarget) {
      deletedCount++;
      const oldHash = baselineFiles.get(path) ?? null;
      let text: string | null = null;
      if (oldHash !== null) {
        const bytes = readBlob(oldHash);
        if (bytes !== null) {
          const content = decoder.decode(bytes);
          const lines = splitLines(content);
          text = formatUnifiedDiff(path, lines.map((line) => `-${line}`));
        }
      }
      files.push({
        path,
        kind: "deleted",
        old_hash: oldHash,
        new_hash: null,
        text,
      });
    } else if (inBaseline && inTarget) {
      const oldHash = baselineFiles.get(path) ?? null;
      const newHash = targetFiles.get(path) ?? null;
      if (oldHash !== newHash) {
        modifiedCount++;
        let text: string | null = null;
        if (oldHash !== null && newHash !== null) {
          const oldBytes = readBlob(oldHash);
          const newBytes = readBlob(newHash);
          if (oldBytes !== null && newBytes !== null) {
            const oldContent = decoder.decode(oldBytes);
            const newContent = decoder.decode(newBytes);
            const oldLines = splitLines(oldContent);
            const newLines = splitLines(newContent);
            const diffBody = diffLines(oldLines, newLines);
            text = diffBody === null ? null : formatUnifiedDiff(path, diffBody);
          }
        }
        files.push({
          path,
          kind: "modified",
          old_hash: oldHash,
          new_hash: newHash,
          text,
        });
      }
    }
  }

  const summary = `${files.length} files changed: ${addedCount} added, ${modifiedCount} modified, ${deletedCount} deleted`;

  return { files, summary };
}

/** Render the whole diff as one bounded text document (reviewer-facing). maxBytes caps the output; a trailing notice "[diff truncated]" is appended when exceeded. */
export function renderDiffDocument(
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
