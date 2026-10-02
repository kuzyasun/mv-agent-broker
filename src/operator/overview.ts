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
