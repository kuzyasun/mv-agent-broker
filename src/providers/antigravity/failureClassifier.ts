import type { ProviderFailure } from "../../runtime/adapter.ts";
import { parseVendorResetMs } from "../../core/quotaCooldown.ts";
import { boundedSanitizedDetail } from "../common/readiness.ts";

const GENERIC_FAILURE = "Antigravity execution failed.";
const DETAIL_LIMIT = 512;

/**
 * Classify only a native error explicitly associated with the current turn.
 * Callers must not pass response text, stderr, logs, or historical diagnostics.
 */
export function classifyAntigravityFailure(message: string | null): ProviderFailure {
  if (message === null) {
    return { code: "PROVIDER_EXECUTION_ERROR", message: GENERIC_FAILURE };
  }

  const detail = boundedSanitizedDetail(message, DETAIL_LIMIT) || GENERIC_FAILURE;
  const quota = /^\s*Individual quota reached\./i.test(message);
  if (quota) {
    const retryAfterMs = parseVendorResetMs(message);
    return {
      code: "QUOTA_EXHAUSTED",
      message: detail,
      ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}),
    };
  }

  if (/^The stream was interrupted\. Please continue the task you were working on\.$/.test(message)) {
    return { code: "PROVIDER_STREAM_INTERRUPTED", message: detail };
  }

  if (/^Your previous response was cut off because it exceeded the output token limit(?:\.| .*)$/.test(message)) {
    return { code: "PROVIDER_OUTPUT_LIMIT", message: detail };
  }

  if (/^API error \(attempt \d+\): INTERNAL \(code 500\): Internal error encountered\.$/.test(message) ||
      /^API error \(attempt \d+\): UNAVAILABLE \(code 503\): The service is currently unavailable\.$/.test(message)) {
    return { code: "PROVIDER_UNAVAILABLE", message: detail };
  }

  if (/^API error \(attempt \d+\): RESOURCE_EXHAUSTED \(code 429\): .+\S$/.test(message)) {
    return { code: "RATE_LIMITED", message: detail };
  }

  // Antigravity's explicit login diagnostic is observed verbatim. Also accept
  // its structured API authentication envelope; a bare 401 is not enough.
  if (message === "You are not logged into Antigravity." ||
      /^API error \(attempt \d+\): UNAUTHENTICATED \(code 401\): .+\S$/.test(message)) {
    return { code: "AUTH_REQUIRED", message: detail };
  }

  if (/^API error \(attempt \d+\): request failed: Post "https:\/\/[^"\s]+": read tcp .+: wsarecv: (?:.*(?:connection reset|EOF|timeout)[).]?|A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond\.)$/i.test(message)) {
    return { code: "PROVIDER_NETWORK_ERROR", message: detail };
  }

  return { code: "PROVIDER_EXECUTION_ERROR", message: detail };
}
