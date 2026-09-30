/**
 * Error contract per spec §10.4 (API 0.2).
 * `execution_started` semantics: true | false | null(unknown); `false` is only
 * allowed when journal/evidence exclude dispatch of this task.
 */
export const ERROR_CODES = [
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "SESSION_NOT_READY",
  "SESSION_BUSY",
  "SESSION_CLOSED",
  "SESSION_BLOCKED",
  "IDEMPOTENCY_CONFLICT",
  "RESOURCE_BUSY",
  "WORKSPACE_BUSY",
  "WORKSPACE_CHANGED",
  "SCOPE_VIOLATION",
  "POLICY_UNSUPPORTED",
  "CAPABILITY_UNSUPPORTED",
  "PROVIDER_INCOMPATIBLE",
  "MODEL_UNAVAILABLE",
  "AUTH_REQUIRED",
  "INTERACTION_REQUIRED",
  "QUOTA_EXHAUSTED",
  "RATE_LIMITED",
  "PROVIDER_PROTOCOL_ERROR",
  "SESSION_NOT_RESUMABLE",
  "EXECUTION_UNKNOWN",
  "SNAPSHOT_UNSUPPORTED",
  "SNAPSHOT_UNSTABLE",
  "EVIDENCE_CAPTURE_FAILED",
  "STORAGE_LIMIT",
  "RESULT_NOT_READY",
  "ARTIFACT_NOT_READY",
  "ARTIFACT_EXPIRED",
  "EVENTS_EXPIRED",
  "ACTIVE_TURN",
  "SESSION_CLOSING",
  "DAEMON_ALREADY_RUNNING",
  "DAEMON_NOT_READY",
  "DISCOVERY_CHANGED",
  "INPUT_UNSUPPORTED",
  "INPUT_LIMIT",
  "INPUT_DELIVERY_FAILED",
  "ARTIFACT_CORRUPT",
  "SNAPSHOT_COVERAGE_MISMATCH",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class BrokerError extends Error {
  readonly code: ErrorCode;
  readonly phase?: string;
  readonly retryGuidance?: string;
  readonly executionStarted: boolean | null;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      phase?: string;
      retryGuidance?: string;
      executionStarted?: boolean | null;
      details?: Record<string, unknown>;
    } = {},
  ) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.phase = opts.phase;
    this.retryGuidance = opts.retryGuidance ?? (code === "UNAUTHORIZED" ? "operator_action_required" : undefined);
    this.executionStarted = opts.executionStarted ?? null;
    this.details = opts.details;
  }

  toJSON() {
    return {
      ok: false as const,
      error: {
        code: this.code,
        message: this.message,
        phase: this.phase ?? null,
        retry_guidance: this.retryGuidance ?? null,
        execution_started: this.executionStarted,
        details: this.details ?? {},
      },
    };
  }
}
