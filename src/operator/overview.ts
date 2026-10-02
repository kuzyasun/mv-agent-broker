import { BrokerError } from "../shared/errors.ts";
import { boundedSanitizedDetail } from "../providers/common/readiness.ts";
import type { RegistryDb } from "../storage/db.ts";

const ACTIVE_TURN_STATES = "'ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN'";
const ACTIVE_TURN_LIMIT = 30;
const ERROR_TURN_LIMIT = 10;

export interface OperatorTurnSummary {
  turn_id: string;
  session_id: string;
  project_id: string;
  provider: string;
  model: string;
  effort: string | null;
  state: string;
  timestamp: number;
}

export interface OperatorErrorSummary extends OperatorTurnSummary {
  error_code: string;
}

export interface OperatorOverview {
  active_turn_count: number;
  active_turns: OperatorTurnSummary[];
  active_turns_truncated: boolean;
  error_turn_count: number;
  error_turns: OperatorErrorSummary[];
  error_turns_truncated: boolean;
}

function summary(row: Record<string, unknown>): OperatorTurnSummary {
  return {
    turn_id: String(row.turn_id),
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    provider: String(row.provider),
    model: String(row.model),
    effort: row.effort === null ? null : String(row.effort),
    state: String(row.state),
    timestamp: Number(row.timestamp),
  };
}

function count(db: RegistryDb, where: string): number {
  const row = db.raw.prepare(`SELECT COUNT(*) AS count FROM turns WHERE ${where}`).get() as { count: number };
  return Number(row.count);
}

function selectFields(extra = "", timestamp = "t.updated_at AS timestamp"): string {
  return `
    SELECT
      t.turn_id,
      t.session_id,
      t.project_id,
      s.provider,
      s.requested_model AS model,
      s.requested_effort AS effort,
      t.state,
      ${timestamp}${extra}
    FROM turns t
    JOIN sessions s ON s.session_id = t.session_id
  `;
}

export function projectOperatorOverview(db: RegistryDb): OperatorOverview {
  const activeTurnCount = count(db, `state IN (${ACTIVE_TURN_STATES})`);
  const activeRows = db.raw
    .prepare(`${selectFields()} WHERE t.state IN (${ACTIVE_TURN_STATES}) ORDER BY t.updated_at DESC, t.turn_id DESC LIMIT ?`)
    .all(ACTIVE_TURN_LIMIT) as Array<Record<string, unknown>>;

  const errorTurnCount = count(db, "error_code IS NOT NULL");
  const errorRows = db.raw
    .prepare(`
      ${selectFields(", t.error_code", "COALESCE(t.terminal_at, t.updated_at) AS timestamp").trim()}
      WHERE t.error_code IS NOT NULL
      ORDER BY COALESCE(t.terminal_at, t.updated_at) DESC, t.turn_id DESC
      LIMIT ?
    `)
    .all(ERROR_TURN_LIMIT) as Array<Record<string, unknown>>;

  return {
    active_turn_count: activeTurnCount,
    active_turns: activeRows.map(summary),
    active_turns_truncated: activeTurnCount > activeRows.length,
    error_turn_count: errorTurnCount,
    error_turns: errorRows.map(row => ({
      ...summary(row),
      error_code: String(row.error_code),
    })),
    error_turns_truncated: errorTurnCount > errorRows.length,
  };
}

const FAILURE_EVENT_TYPES = ["turn_terminal", "turn_unknown"] as const;

export interface OperatorTurnErrorDetail {
  turn_id: string;
  session_id: string;
  project_id: string;
  provider: string;
  model: string;
  effort: string | null;
  state: string;
  error_code: string | null;
  recorded_failure_message: string | null;
  recorded_failure_availability: "recorded" | "unavailable";
  native_outcome: string | null;
  termination_reason: string | null;
  finalization_error: string | null;
  execution_started: boolean | null;
  timestamps: {
    created_at: number;
    accepted_at: number | null;
    terminal_at: number | null;
    updated_at: number;
    failure_event_at: number | null;
  };
  session_state: string;
  context_status: string;
  close_state: string;
  workspace_id: string | null;
  workspace_quarantine_availability: "observed" | "unavailable" | "none";
  workspace_quarantined: boolean | null;
  quarantine_reason: string | null;
  snapshots: {
    baseline_snapshot_id: string | null;
    final_snapshot_id: string | null;
    review_target_snapshot_id: string | null;
    initial_snapshot_id: string | null;
    latest_snapshot_id: string | null;
  };
  failure_event_type: string | null;
  guidance: {
    kind: "guidance";
    explanation: string;
    next_step: string;
  };
}

function sanitizeOperatorText(value: string, max = 512): string | null {
  const masked = value
    .replace(/\b(?:set-cookie|cookie|authorization)\s*:\s*[^\r\n]*/gi, "[redacted]")
    .replace(/\bBearer\s+\S+|\bsk-[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/["']?\b(?:api[_-]?key|access[_-]?token|token|secret|password)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "[redacted]");
  const sanitized = boundedSanitizedDetail(masked, max);
  return sanitized.length > 0 ? sanitized : null;
}

function nullableText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return sanitizeOperatorText(String(value));
}

function nullableId(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function recordedFailure(type: string, payload: string | null): { availability: "recorded" | "unavailable"; message: string | null } {
  if (payload === null) return { availability: "unavailable", message: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return { availability: "unavailable", message: null };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { availability: "unavailable", message: null };
  }
  const record = parsed as Record<string, unknown>;
  const raw = type === "turn_unknown" ? record.cause : type === "turn_terminal" ? record.message : undefined;
  if (typeof raw !== "string") return { availability: "unavailable", message: null };
  const message = sanitizeOperatorText(raw);
  return message === null
    ? { availability: "unavailable", message: null }
    : { availability: "recorded", message };
}

function guidanceFor(input: {
  state: string;
  errorCode: string | null;
  executionStarted: boolean | null;
  quarantined: boolean | null;
}): OperatorTurnErrorDetail["guidance"] {
  if (input.state === "UNKNOWN" || input.executionStarted === null || input.quarantined === true) {
    return {
      kind: "guidance",
      explanation: "Execution is unknown or the workspace is quarantined.",
      next_step: "Use coordinator or operator recovery before any new paid work. Do not start an immediate paid replay.",
    };
  }
  switch (input.errorCode) {
    case "INPUT_LIMIT":
    case "INPUT_DELIVERY_FAILED":
    case "INPUT_UNSUPPORTED":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with input size or input delivery.",
        next_step: "Adjust the input and start a new turn only after the recorded cause is understood.",
      };
    case "QUOTA_EXHAUSTED":
    case "RATE_LIMITED":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with provider quota or rate limiting.",
        next_step: "Wait for the provider limit to clear, then start a new turn if the work is still needed.",
      };
    case "AUTH_REQUIRED":
    case "UNAUTHORIZED":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with provider authentication.",
        next_step: "Sign in with the provider CLI. Do not paste credentials into the broker.",
      };
    case "PROVIDER_INCOMPATIBLE":
    case "MODEL_UNAVAILABLE":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with an incompatible provider or unavailable model.",
        next_step: "Select an available model in the saved settings and restart the idle daemon before a new session.",
      };
    case "SCOPE_VIOLATION":
    case "EVIDENCE_CAPTURE_FAILED":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with scope or evidence capture.",
        next_step: "Inspect the recorded message and snapshot IDs before starting another turn.",
      };
    case "WORKSPACE_BUSY":
    case "EXECUTION_UNKNOWN":
      return {
        kind: "guidance",
        explanation: "The recorded code is associated with a busy or unknown workspace.",
        next_step: "Use coordinator or operator recovery before any new paid work. Do not start an immediate paid replay.",
      };
    default:
      return {
        kind: "guidance",
        explanation: "No specific next step is recorded for this code.",
        next_step: "Use the recorded message when it is available. Missing history stays unavailable.",
      };
  }
}

export function projectOperatorTurnError(db: RegistryDb, turnId: string): OperatorTurnErrorDetail | null {
  const row = db.raw.prepare(`
    SELECT
      t.turn_id,
      t.session_id,
      t.project_id,
      t.state,
      t.error_code,
      t.native_outcome,
      t.termination_reason,
      t.finalization_error,
      t.execution_started,
      t.created_at,
      t.accepted_at,
      t.terminal_at,
      t.updated_at,
      t.baseline_snapshot_id,
      t.final_snapshot_id,
      t.review_target_snapshot_id,
      s.provider,
      s.requested_model AS model,
      s.requested_effort AS effort,
      s.state AS session_state,
      s.context_status,
      s.close_state,
      s.workspace_id,
      s.initial_snapshot_id,
      s.latest_snapshot_id,
      w.quarantined AS workspace_quarantined,
      w.quarantine_reason
    FROM turns t
    JOIN sessions s ON s.session_id = t.session_id
    LEFT JOIN workspaces w ON w.workspace_id = s.workspace_id
    WHERE t.turn_id = ?
  `).get(turnId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const event = db.raw.prepare(`
    SELECT type, payload, created_at
    FROM events
    WHERE turn_id = ? AND type IN (${FAILURE_EVENT_TYPES.map(() => "?").join(", ")})
    ORDER BY seq DESC
    LIMIT 1
  `).get(turnId, ...FAILURE_EVENT_TYPES) as { type: string; payload: string | null; created_at: number } | undefined;
  const recorded = event ? recordedFailure(event.type, event.payload) : { availability: "unavailable" as const, message: null };
  const workspaceId = nullableId(row.workspace_id);
  const quarantineObserved = workspaceId !== null && row.workspace_quarantined !== null && row.workspace_quarantined !== undefined;
  const workspaceQuarantined = quarantineObserved ? Number(row.workspace_quarantined) === 1 : null;
  const executionStarted = row.execution_started === null || row.execution_started === undefined
    ? null
    : Number(row.execution_started) === 1;
  const errorCode = nullableId(row.error_code);

  return {
    turn_id: String(row.turn_id),
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    provider: String(row.provider),
    model: String(row.model),
    effort: row.effort === null || row.effort === undefined ? null : String(row.effort),
    state: String(row.state),
    error_code: errorCode,
    recorded_failure_message: recorded.message,
    recorded_failure_availability: recorded.availability,
    native_outcome: nullableId(row.native_outcome),
    termination_reason: nullableId(row.termination_reason),
    finalization_error: nullableText(row.finalization_error),
    execution_started: executionStarted,
    timestamps: {
      created_at: Number(row.created_at),
      accepted_at: row.accepted_at === null || row.accepted_at === undefined ? null : Number(row.accepted_at),
      terminal_at: row.terminal_at === null || row.terminal_at === undefined ? null : Number(row.terminal_at),
      updated_at: Number(row.updated_at),
      failure_event_at: event ? Number(event.created_at) : null,
    },
    session_state: String(row.session_state),
    context_status: String(row.context_status),
    close_state: String(row.close_state),
    workspace_id: workspaceId,
    workspace_quarantine_availability: workspaceId === null ? "none" : quarantineObserved ? "observed" : "unavailable",
    workspace_quarantined: workspaceQuarantined,
    quarantine_reason: quarantineObserved ? nullableText(row.quarantine_reason) : null,
    snapshots: {
      baseline_snapshot_id: nullableId(row.baseline_snapshot_id),
      final_snapshot_id: nullableId(row.final_snapshot_id),
      review_target_snapshot_id: nullableId(row.review_target_snapshot_id),
      initial_snapshot_id: nullableId(row.initial_snapshot_id),
      latest_snapshot_id: nullableId(row.latest_snapshot_id),
    },
    failure_event_type: event ? event.type : null,
    guidance: guidanceFor({
      state: String(row.state),
      errorCode,
      executionStarted,
      quarantined: workspaceQuarantined,
    }),
  };
}

export function operatorTurnErrorResult(db: RegistryDb, params: Record<string, unknown>): Record<string, unknown> {
  const turnId = params.turn_id;
  if (typeof turnId !== "string" || turnId.length === 0) {
    throw new BrokerError("INVALID_REQUEST", "turn_id is required");
  }
  const detail = projectOperatorTurnError(db, turnId);
  if (!detail) throw new BrokerError("INVALID_REQUEST", "Turn error detail is unavailable.");
  return { ...detail };
}
