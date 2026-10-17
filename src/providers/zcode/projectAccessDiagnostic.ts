/** Fixed native project-access metadata. Never includes response bodies or IDs. */
import { BrokerError } from "../../shared/errors.ts";
import { classifyZcodeError } from "./resultParser.ts";

export const ZCODE_PROJECT_ACCESS_PREFIX = "agent-broker:zcode-project-access:";
export interface ZcodeProjectAccessDiagnostic {
  stage: "customer_info" | "key_list" | "key_create" | "pat_issue";
  kind: "http" | "timeout" | "network_error" | "request_error" | "invalid_json" | "provider_error";
  status?: number;
  vendor_code?: number;
}
const stages = new Set(["customer_info", "key_list", "key_create", "pat_issue"]);
const kinds = new Set(["http", "timeout", "network_error", "request_error", "invalid_json", "provider_error"]);

export function parseZcodeProjectAccessDiagnostic(line: string): ZcodeProjectAccessDiagnostic | null {
  if (!line.startsWith(ZCODE_PROJECT_ACCESS_PREFIX) || line.length > 256) return null;
  try {
    const value = JSON.parse(line.slice(ZCODE_PROJECT_ACCESS_PREFIX.length));
    if (!value || !stages.has(value.stage) || !kinds.has(value.kind)) return null;
    const status = Number.isInteger(value.status) && value.status >= 100 && value.status <= 599 ? value.status : undefined;
    const vendorCode = Number.isSafeInteger(value.vendor_code) && value.vendor_code >= 0 ? value.vendor_code : undefined;
    if ((value.kind === "http" || value.kind === "provider_error") && status === undefined) return null;
    if (value.kind === "http" && status! >= 200 && status! < 300) return null;
    if (value.kind === "provider_error" && vendorCode === undefined) return null;
    return { stage: value.stage, kind: value.kind, ...(status === undefined ? {} : { status }), ...(vendorCode === undefined ? {} : { vendor_code: vendorCode }) };
  } catch { return null; }
}

/** Called only for failed native execution, after cancellation/quota precedence. */
export function zcodeProjectAccessError(diagnostic: ZcodeProjectAccessDiagnostic): BrokerError {
  const { stage, kind, status, vendor_code: vendorCode } = diagnostic;
  const details = { stage, kind, ...(status === undefined ? {} : { status_code: status }), ...(vendorCode === undefined ? {} : { vendor_code: vendorCode }) };
  const quota = vendorCode === undefined ? null : classifyZcodeError({ error: { providerErrorCode: vendorCode, statusCode: status } });
  if (quota) return new BrokerError(quota.errorCode, quota.safeMessage, { executionStarted: true, details });
  if (kind === "http" && status === 401) {
    return new BrokerError("AUTH_REQUIRED", `ZCode rejected the Desktop credentials (HTTP 401 at ${stage}). Sign in to ZCode Desktop again, then explicitly retry the task.`, { executionStarted: true, details });
  }
  if (kind === "timeout" || kind === "network_error") {
    return new BrokerError("PROVIDER_NETWORK_ERROR", `ZCode project access failed at ${stage}: ${kind}.`, { executionStarted: true, details });
  }
  const code = kind === "http" && status === 429 ? "RATE_LIMITED"
    : kind === "http" && status! >= 500 ? "PROVIDER_UNAVAILABLE"
    : kind === "http" || kind === "provider_error" ? "PROVIDER_EXECUTION_ERROR" : "PROVIDER_PROTOCOL_ERROR";
  const reason = kind === "http" ? `HTTP ${status}` : kind === "provider_error" ? `provider code ${vendorCode} (HTTP ${status})` : kind;
  return new BrokerError(code, `ZCode project access failed at ${stage}: ${reason}.`, { executionStarted: true, details });
}
