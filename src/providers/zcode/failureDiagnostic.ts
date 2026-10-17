/** Keep a small error detail in the broker journal before temporary logs vanish. */
import { closeSync, fstatSync, openSync, readSync, readdirSync } from "node:fs";
import path from "node:path";
import { boundedSanitizedDetail } from "../common/readiness.ts";

function sanitize(text: string): string {
  return boundedSanitizedDetail(text
    .replace(/["']?\b(?:set-cookie|cookie|authorization)["']?\s*:\s*(?:"[^"]*"|'[^']*'|[^\r\n]*)/gi, "[redacted]")
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gi, "[redacted]")
    .replace(/["']?\b[\w.-]*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|credential|token|secret|password)[\w.-]*["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "[redacted]"));
}

function errorMessage(row: unknown): unknown {
  if (!row || typeof row !== "object") return null;
  type NativeError = { message?: unknown; underlyingErrorMessage?: unknown; cause?: { message?: unknown } };
  const record = row as { error?: NativeError; context?: { error?: NativeError }; message?: unknown };
  const error = record.error ?? record.context?.error;
  // Native runtime error payloads retain the cause alongside their generic wrapper.
  return error?.underlyingErrorMessage ?? error?.cause?.message ?? error?.message ?? record.message;
}

function readTail(file: string): string {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const bytes = Buffer.alloc(Math.min(size, 64 * 1024));
    const length = readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
    return bytes.subarray(0, length).toString("utf8");
  } finally { closeSync(fd); }
}

/** Error records only: never retain request/response bodies or the whole log. */
export function zcodeFailureDiagnostic(stderr: string, logDir: string): string | null {
  try {
    const files = readdirSync(logDir, { withFileTypes: true })
      .filter(file => file.isFile() && file.name.endsWith(".jsonl"))
      .map(file => file.name).sort().slice(-3).reverse();
    for (const file of files) {
      for (const line of readTail(path.join(logDir, file)).split(/\r?\n/).reverse()) {
        try {
          const row = JSON.parse(line);
          if (typeof row?.level !== "string" || row.level.toLowerCase() !== "error") continue;
          const message = errorMessage(row);
          if (typeof message === "string" && message.trim()) return sanitize(message) || null;
        } catch { /* A truncated or malformed log line is not a diagnostic. */ }
      }
    }
  } catch { /* Missing/unreadable optional logs must not hide the native failure. */ }
  const lines = stderr.split(/\r?\n/).map(line => {
    try {
      const message = errorMessage(JSON.parse(line));
      return typeof message === "string" ? message : "";
    } catch { return line; }
  });
  return sanitize(lines.join("\n")) || null;
}
