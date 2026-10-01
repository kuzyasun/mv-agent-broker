/** Native --json result is transport metadata; response remains agent prose. */

export interface ZcodeLastError {
  code?: string;
  message?: string;
  recoverable?: boolean;
  source?: string;
  attribution?: {
    statusCode?: number;
    providerErrorCode?: string | number;
    retryable?: boolean;
  };
  providerErrorCode?: string | number;
  statusCode?: number;
}

export interface ZcodeApiRetry {
  attempt?: number;
  maxAttempts?: number;
  reasonCode?: string;
}

export interface ZcodeProjection {
  status: string;
  lastError?: ZcodeLastError | null;
  apiRetry?: ZcodeApiRetry | null;
}

export interface ZcodeJsonResult {
  sessionId: string;
  response: string;
  projection?: ZcodeProjection;
}

export type ZcodeErrorKind = "quota_exhausted" | "rate_limited";

export interface ZcodeClassifiedError {
  kind: ZcodeErrorKind;
  errorCode: "QUOTA_EXHAUSTED" | "RATE_LIMITED";
  safeMessage: string;
  vendorCode?: number;
  statusCode?: number;
}

export function parseZcodeResult(text: string): ZcodeJsonResult | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.sessionId !== "string" || !/^sess_[a-zA-Z0-9_-]+$/.test(result.sessionId) || typeof result.response !== "string") return null;
  if (result.projection !== undefined) {
    if (result.projection === null || typeof result.projection !== "object" || Array.isArray(result.projection)) return null;
    const projection = result.projection as Record<string, unknown>;
    if (typeof projection.status !== "string") return null;
    const outProjection: ZcodeProjection = { status: projection.status };
    if (projection.lastError && typeof projection.lastError === "object" && !Array.isArray(projection.lastError)) {
      outProjection.lastError = projection.lastError as ZcodeLastError;
    }
    if (projection.apiRetry && typeof projection.apiRetry === "object" && !Array.isArray(projection.apiRetry)) {
      outProjection.apiRetry = projection.apiRetry as ZcodeApiRetry;
    }
    return { sessionId: result.sessionId, response: result.response, projection: outProjection };
  }
  return { sessionId: result.sessionId, response: result.response };
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numericCode(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^\d{1,8}$/.test(value)) return Number(value);
  return undefined;
}

/** Only explicit error fields: never inspect response, tool data or message prose. */
export function classifyZcodeError(candidate: unknown): ZcodeClassifiedError | null {
  const root = object(candidate);
  if (!root) return null;
  const projection = object(root.projection);
  // A completed projection can retain a historical error after recovery/resume.
  const error = object(root.error) ?? (projection && projection.status !== "idle" && typeof projection.status === "string" ? object(projection.lastError) : null);
  if (!error) return null;
  const attribution = object(error.attribution);
  const vendorCode = numericCode(attribution?.providerErrorCode ?? error.providerErrorCode ?? error.code);
  const observedStatus = numericCode(attribution?.statusCode ?? error.statusCode);
  const statusCode = observedStatus !== undefined && observedStatus >= 100 && observedStatus <= 599 ? observedStatus : undefined;
  let errorCode: "QUOTA_EXHAUSTED" | "RATE_LIMITED";
  if (vendorCode !== undefined && [1308, 1310, 1316, 1317, 1318, 1319, 1320, 1321].includes(vendorCode)) {
    errorCode = "QUOTA_EXHAUSTED";
  } else if (vendorCode !== undefined && [1302, 1305, 3008, 3009, 3010].includes(vendorCode)) {
    errorCode = "RATE_LIMITED";
  } else if (vendorCode === undefined && error.code === "model_rate_limited") {
    errorCode = "RATE_LIMITED";
  } else return null;
  return {
    kind: errorCode === "QUOTA_EXHAUSTED" ? "quota_exhausted" : "rate_limited",
    errorCode,
    safeMessage: errorCode === "QUOTA_EXHAUSTED" ? "ZCode provider quota exhausted." : "ZCode rate limit exceeded.",
    ...(vendorCode !== undefined ? {vendorCode} : {}),
    ...(statusCode !== undefined ? {statusCode} : {}),
  };
}

/** JSON error envelopes only. The installed CLI's plain error.message catch
 * does not preserve attribution; prefixes and numeric tokens are insufficient. */
export function classifyZcodeStderrLine(line: string): ZcodeClassifiedError | null {
  if (line.length > 65_536) return null;
  try {
    const root = object(JSON.parse(line));
    if (!root) return null;
    // The SDK runtime error shape is also accepted on the error channel.
    return classifyZcodeError(root) ?? (root.code === "model_rate_limited" ? classifyZcodeError({error: root}) : null);
  } catch { return null; }
}

export function classifyZcodeText(text: string): ZcodeClassifiedError | null {
  try { return classifyZcodeError(JSON.parse(text)); } catch { return null; }
}
