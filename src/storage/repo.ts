/**
 * Typed data mappers over the registry schema (spec §5).
 * Boundary conversions: booleans ⇄ 0/1, arrays ⇄ JSON strings.
 * Unique-constraint failures surface as SqliteConstraintError so admission
 * can converge them to replay/conflict (§7.2) instead of a generic DB error.
 */
import type { RegistryDb } from "./db.ts";
import type {
  AccountProfileRecord,
  ArtifactKind,
  ArtifactPinRecord,
  ArtifactRecord,
  ArtifactState,
  BlobRecord,
  CloseState,
  ContextStatus,
  CoordinatorProfileRecord,
  CoverageProfileRecord,
  EventRecord,
  IdempotencyRecord,
  IntentKind,
  IntentRecord,
  IntentState,
  OperationName,
  PinRootKind,
  PolicyProfileRecord,
  ProjectRecord,
  ReservationKind,
  ReservationRecord,
  SessionRecord,
  SessionState,
  SnapshotRecord,
  TurnRecord,
  TurnState,
  WorkspaceMode,
  WorkspaceRecord,
} from "../shared/api-types.ts";

export class SqliteConstraintError extends Error {
  override readonly cause: unknown;
  constructor(cause: unknown) {
    super("sqlite-constraint-violation");
    this.name = "SqliteConstraintError";
    this.cause = cause;
  }
}

export function asConstraintError(e: unknown): SqliteConstraintError | null {
  if (e instanceof SqliteConstraintError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string } | null)?.code;
  if (code?.startsWith("SQLITE_CONSTRAINT") || /UNIQUE|PRIMARY KEY|CONSTRAINT/.test(msg)) {
    return new SqliteConstraintError(e);
  }
  return null;
}

type SqlValue = null | number | bigint | string | Uint8Array;

/** Coerce record field values to SQLite-bound values (booleans/arrays/undefined). */
function sqlValues(values: unknown[]): SqlValue[] {
  return values.map((v): SqlValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (Array.isArray(v)) return JSON.stringify(v);
    if (typeof v === "number" || typeof v === "bigint" || typeof v === "string" || v instanceof Uint8Array) return v;
    return String(v);
  });
}

function jsonParseArray(v: unknown): string[] {
  if (typeof v !== "string") return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function intToBool(v: unknown): boolean {
  return v === 1 || v === true;
}

// ─── daemon state ───────────────────────────────────────────────────────────

export interface DaemonStateRow {
  daemon_state: string;
  incarnation: string;
  started_at: number;
  ready_at: number | null;
  fail_reason: string | null;
}

export function getDaemonState(db: RegistryDb): DaemonStateRow | null {
  const row = db.raw.prepare("SELECT * FROM daemon_state WHERE id = 1").get() as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    daemon_state: String(row.daemon_state),
    incarnation: String(row.incarnation),
    started_at: Number(row.started_at),
    ready_at: row.ready_at === null ? null : Number(row.ready_at),
    fail_reason: row.fail_reason === null ? null : String(row.fail_reason),
  };
}

export function setDaemonState(db: RegistryDb, row: DaemonStateRow): void {
  db.raw
    .prepare(
      `INSERT INTO daemon_state (id, daemon_state, incarnation, started_at, ready_at, fail_reason)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET daemon_state=excluded.daemon_state,
         incarnation=excluded.incarnation, started_at=excluded.started_at,
         ready_at=excluded.ready_at, fail_reason=excluded.fail_reason`,
    )
    .run(row.daemon_state, row.incarnation, row.started_at, row.ready_at, row.fail_reason);
}

// ─── registry entities ──────────────────────────────────────────────────────

export function insertProject(db: RegistryDb, rec: ProjectRecord): void {
  db.raw
    .prepare(
      "INSERT INTO projects (project_id, display_name, configuration_revision, session_cap, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(rec.project_id, rec.display_name, rec.configuration_revision, rec.session_cap, rec.created_at);
}

export function getProject(db: RegistryDb, projectId: string): ProjectRecord | null {
  const row = db.raw.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    project_id: String(row.project_id),
    display_name: String(row.display_name),
    configuration_revision: Number(row.configuration_revision),
    session_cap: Number(row.session_cap),
    created_at: Number(row.created_at),
  };
}

export function insertCoordinator(db: RegistryDb, rec: CoordinatorProfileRecord): void {
  db.raw
    .prepare(
      "INSERT INTO coordinator_profiles (coordinator_id, display_name, allowed_project_ids, revoked, config_revision) VALUES (?, ?, ?, ?, ?)",
    )
    .run(rec.coordinator_id, rec.display_name, JSON.stringify(rec.allowed_project_ids), rec.revoked ? 1 : 0, rec.config_revision);
}

export function getCoordinator(db: RegistryDb, coordinatorId: string): CoordinatorProfileRecord | null {
  const row = db.raw.prepare("SELECT * FROM coordinator_profiles WHERE coordinator_id = ?").get(coordinatorId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    coordinator_id: String(row.coordinator_id),
    display_name: String(row.display_name),
    allowed_project_ids: jsonParseArray(row.allowed_project_ids),
    revoked: intToBool(row.revoked),
    config_revision: Number(row.config_revision),
  };
}

export function insertAccount(db: RegistryDb, rec: AccountProfileRecord): void {
  db.raw
    .prepare("INSERT INTO account_profiles (account_profile_id, provider, quota_scope_id, auth_mode) VALUES (?, ?, ?, ?)")
    .run(rec.account_profile_id, rec.provider, rec.quota_scope_id, rec.auth_mode);
}

export function getAccount(db: RegistryDb, accountProfileId: string): AccountProfileRecord | null {
  const row = db.raw.prepare("SELECT * FROM account_profiles WHERE account_profile_id = ?").get(accountProfileId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    account_profile_id: String(row.account_profile_id),
    provider: String(row.provider),
    quota_scope_id: String(row.quota_scope_id),
    auth_mode: String(row.auth_mode),
  };
}

export function insertPolicyProfile(db: RegistryDb, rec: PolicyProfileRecord): void {
  db.raw
    .prepare("INSERT INTO policy_profiles (policy_profile_id, version, config) VALUES (?, ?, ?)")
    .run(rec.policy_profile_id, rec.version, rec.config);
}

export function getPolicyProfile(db: RegistryDb, id: string, version: string): PolicyProfileRecord | null {
  const row = db.raw
    .prepare("SELECT * FROM policy_profiles WHERE policy_profile_id = ? AND version = ?")
    .get(id, version) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    policy_profile_id: String(row.policy_profile_id),
    version: String(row.version),
    config: String(row.config),
  };
}

export function insertWorkspace(db: RegistryDb, rec: WorkspaceRecord): void {
  db.raw
    .prepare(
      "INSERT INTO workspaces (workspace_id, project_id, mode, canonical_path, quarantined, quarantine_reason, coverage_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(rec.workspace_id, rec.project_id, rec.mode, rec.canonical_path, rec.quarantined ? 1 : 0, rec.quarantine_reason, rec.coverage_profile_id);
}

export function getWorkspace(db: RegistryDb, workspaceId: string): WorkspaceRecord | null {
  const row = db.raw.prepare("SELECT * FROM workspaces WHERE workspace_id = ?").get(workspaceId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    workspace_id: String(row.workspace_id),
    project_id: String(row.project_id),
    mode: String(row.mode) as WorkspaceMode,
    canonical_path: row.canonical_path === null ? null : String(row.canonical_path),
    quarantined: intToBool(row.quarantined),
    quarantine_reason: row.quarantine_reason === null ? null : String(row.quarantine_reason),
    coverage_profile_id: row.coverage_profile_id === null ? null : String(row.coverage_profile_id),
  };
}

// ─── coverage profiles (§8.7, §9.1) ────────────────────────────────────────

export function insertCoverageProfile(db: RegistryDb, rec: CoverageProfileRecord): void {
  db.raw
    .prepare("INSERT INTO coverage_profiles (coverage_profile_id, version, config, contract_hash) VALUES (?, ?, ?, ?)")
    .run(rec.coverage_profile_id, rec.version, rec.config, rec.contract_hash);
}

export function getCoverageProfile(db: RegistryDb, id: string, version: string): CoverageProfileRecord | null {
  const row = db.raw
    .prepare("SELECT * FROM coverage_profiles WHERE coverage_profile_id = ? AND version = ?")
    .get(id, version) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    coverage_profile_id: String(row.coverage_profile_id),
    version: String(row.version),
    config: String(row.config),
    contract_hash: String(row.contract_hash),
  };
}

export function latestCoverageProfileVersion(db: RegistryDb, id: string): string | null {
  const row = db.raw
    .prepare("SELECT version FROM coverage_profiles WHERE coverage_profile_id = ? ORDER BY LENGTH(version) DESC, version DESC LIMIT 1")
    .get(id) as { version: string } | undefined;
  return row ? row.version : null;
}

// ─── snapshot records (§5.4, §9) ───────────────────────────────────────────

function mapSnapshotRow(row: Record<string, unknown>): SnapshotRecord {
  return {
    snapshot_id: String(row.snapshot_id),
    project_id: String(row.project_id),
    workspace_id: row.workspace_id === null ? null : String(row.workspace_id),
    coverage_profile_id: String(row.coverage_profile_id),
    coverage_profile_version: String(row.coverage_profile_version),
    coverage_contract_hash: String(row.coverage_contract_hash),
    source_digest: String(row.source_digest),
    manifest_artifact_id: String(row.manifest_artifact_id),
    state: String(row.state) as SnapshotRecord["state"],
    fail_reason: row.fail_reason === null ? null : String(row.fail_reason),
    git_head: row.git_head === null ? null : String(row.git_head),
    git_dirty: row.git_dirty === null ? null : intToBool(row.git_dirty),
    captured_at: Number(row.captured_at),
  };
}

export function insertSnapshotRecord(db: RegistryDb, rec: SnapshotRecord): void {
  db.raw
    .prepare(
      `INSERT INTO snapshot_records (snapshot_id, project_id, workspace_id, coverage_profile_id,
       coverage_profile_version, coverage_contract_hash, source_digest, manifest_artifact_id,
       state, fail_reason, git_head, git_dirty, captured_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      rec.snapshot_id,
      rec.project_id,
      rec.workspace_id,
      rec.coverage_profile_id,
      rec.coverage_profile_version,
      rec.coverage_contract_hash,
      rec.source_digest,
      rec.manifest_artifact_id,
      rec.state,
      rec.fail_reason,
      rec.git_head,
      rec.git_dirty === null ? null : rec.git_dirty ? 1 : 0,
      rec.captured_at,
    );
}

export function getSnapshotRecord(db: RegistryDb, snapshotId: string): SnapshotRecord | null {
  const row = db.raw.prepare("SELECT * FROM snapshot_records WHERE snapshot_id = ?").get(snapshotId) as Record<string, unknown> | undefined;
  return row ? mapSnapshotRow(row) : null;
}

export function updateSnapshotState(db: RegistryDb, snapshotId: string, state: SnapshotRecord["state"], failReason: string | null): void {
  db.raw
    .prepare("UPDATE snapshot_records SET state = ?, fail_reason = ? WHERE snapshot_id = ?")
    .run(state, failReason, snapshotId);
}

export function listSealedSnapshotsByWorkspace(db: RegistryDb, projectId: string, workspaceId: string): SnapshotRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM snapshot_records WHERE project_id = ? AND workspace_id = ? AND state = 'SEALED' ORDER BY captured_at")
    .all(projectId, workspaceId) as Array<Record<string, unknown>>;
  return rows.map(mapSnapshotRow);
}

// ─── blobs (§14.1) ─────────────────────────────────────────────────────────

export function insertBlobRecord(db: RegistryDb, rec: BlobRecord): void {
  db.raw
    .prepare("INSERT OR IGNORE INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
    .run(rec.project_id, rec.content_hash, rec.size_bytes, rec.created_at);
}

export function getBlobRecord(db: RegistryDb, projectId: string, contentHash: string): BlobRecord | null {
  const row = db.raw
    .prepare("SELECT * FROM blobs WHERE project_id = ? AND content_hash = ?")
    .get(projectId, contentHash) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    project_id: String(row.project_id),
    content_hash: String(row.content_hash),
    size_bytes: Number(row.size_bytes),
    created_at: Number(row.created_at),
  };
}

export function totalBlobBytes(db: RegistryDb, projectId?: string): number {
  const row = projectId
    ? (db.raw.prepare("SELECT COALESCE(SUM(size_bytes),0) s FROM blobs WHERE project_id = ?").get(projectId) as { s: number })
    : (db.raw.prepare("SELECT COALESCE(SUM(size_bytes),0) s FROM blobs").get() as { s: number });
  return row.s;
}

export function updateWorkspaceQuarantine(
  db: RegistryDb,
  workspaceId: string,
  quarantined: boolean,
  reason: string | null,
): void {
  db.raw
    .prepare("UPDATE workspaces SET quarantined = ?, quarantine_reason = ? WHERE workspace_id = ?")
    .run(quarantined ? 1 : 0, reason, workspaceId);
}

// ─── sessions ───────────────────────────────────────────────────────────────

const SESSION_COLUMNS: ReadonlyArray<keyof SessionRecord> = [
  "session_id", "project_id", "owner_coordinator_id", "provider", "adapter_version", "cli_version",
  "account_profile_id", "auth_mode", "requested_model", "requested_effort", "effective_model",
  "effective_effort", "role", "instructions_hash", "policy_profile_id", "policy_profile_version",
  "workspace_id", "workspace_mode", "coverage_profile_id", "coverage_profile_version",
  "coverage_contract_hash", "native_conversation_ref", "context_status", "state", "active_turn_id",
  "block_reason", "runtime_id", "close_state", "close_intent_id", "initial_snapshot_id",
  "latest_snapshot_id", "record_version", "created_at", "updated_at",
];

function snake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

function mapSessionRow(row: Record<string, unknown>): SessionRecord {
  return {
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    owner_coordinator_id: String(row.owner_coordinator_id),
    provider: String(row.provider),
    adapter_version: row.adapter_version === null ? null : String(row.adapter_version),
    cli_version: row.cli_version === null ? null : String(row.cli_version),
    account_profile_id: String(row.account_profile_id),
    auth_mode: row.auth_mode === null ? null : String(row.auth_mode),
    requested_model: String(row.requested_model),
    requested_effort: row.requested_effort === null ? null : String(row.requested_effort),
    effective_model: row.effective_model === null ? null : String(row.effective_model),
    effective_effort: row.effective_effort === null ? null : String(row.effective_effort),
    role: String(row.role) as SessionRecord["role"],
    instructions_hash: String(row.instructions_hash),
    policy_profile_id: String(row.policy_profile_id),
    policy_profile_version: String(row.policy_profile_version),
    workspace_id: row.workspace_id === null ? null : String(row.workspace_id),
    workspace_mode: String(row.workspace_mode) as WorkspaceMode,
    coverage_profile_id: row.coverage_profile_id === null ? null : String(row.coverage_profile_id),
    coverage_profile_version: row.coverage_profile_version === null ? null : String(row.coverage_profile_version),
    coverage_contract_hash: row.coverage_contract_hash === null ? null : String(row.coverage_contract_hash),
    native_conversation_ref: row.native_conversation_ref === null ? null : String(row.native_conversation_ref),
    context_status: String(row.context_status) as ContextStatus,
    state: String(row.state) as SessionState,
    active_turn_id: row.active_turn_id === null ? null : String(row.active_turn_id),
    block_reason: row.block_reason === null ? null : String(row.block_reason),
    runtime_id: row.runtime_id === null ? null : String(row.runtime_id),
    close_state: String(row.close_state) as CloseState,
    close_intent_id: row.close_intent_id === null ? null : String(row.close_intent_id),
    initial_snapshot_id: row.initial_snapshot_id === null ? null : String(row.initial_snapshot_id),
    latest_snapshot_id: row.latest_snapshot_id === null ? null : String(row.latest_snapshot_id),
    record_version: Number(row.record_version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function insertSession(db: RegistryDb, rec: SessionRecord): void {
  const cols = SESSION_COLUMNS.map(snake).join(", ");
  const placeholders = SESSION_COLUMNS.map(() => "?").join(", ");
  const values = SESSION_COLUMNS.map((k) => {
    const v = rec[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
  db.raw.prepare(`INSERT INTO sessions (${cols}) VALUES (${placeholders})`).run(...sqlValues(values));
}

export function getSession(db: RegistryDb, sessionId: string): SessionRecord | null {
  const row = db.raw.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
  return row ? mapSessionRow(row) : null;
}

/**
 * Optimistic-concurrency field update: bumps record_version/updated_at.
 * Throws Error("CONCURRENT_UPDATE") when the expected version is stale.
 */
export function updateSessionFields(
  db: RegistryDb,
  sessionId: string,
  fields: Partial<SessionRecord>,
  expectedRecordVersion: number,
  now: number,
): void {
  const keys = (Object.keys(fields) as Array<keyof SessionRecord>).filter((k) => k !== "session_id" && k !== "record_version");
  if (keys.length === 0) {
    // Still claim the version bump for serialization correctness.
    db.raw
      .prepare("UPDATE sessions SET record_version = record_version + 1, updated_at = ? WHERE session_id = ? AND record_version = ?")
      .run(now, sessionId, expectedRecordVersion);
    return;
  }
  const sets = keys.map((k) => `${snake(k)} = ?`).join(", ");
  const values = keys.map((k) => {
    const v = fields[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
  const result = db.raw
    .prepare(`UPDATE sessions SET ${sets}, record_version = record_version + 1, updated_at = ? WHERE session_id = ? AND record_version = ?`)
    .run(...sqlValues([...values, now, sessionId, expectedRecordVersion]));
  if (result.changes === 0) throw new Error("CONCURRENT_UPDATE");
}

export function countOpenSessionsByProject(db: RegistryDb, projectId: string): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) c FROM sessions WHERE project_id = ? AND state != 'CLOSED'")
    .get(projectId) as { c: number };
  return row.c;
}

export function listSessionsByOwner(db: RegistryDb, projectId: string, coordinatorId: string): SessionRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM sessions WHERE project_id = ? AND owner_coordinator_id = ? ORDER BY created_at")
    .all(projectId, coordinatorId) as Array<Record<string, unknown>>;
  return rows.map(mapSessionRow);
}

// ─── turns ──────────────────────────────────────────────────────────────────

const TURN_COLUMNS: ReadonlyArray<keyof TurnRecord> = [
  "turn_id", "session_id", "project_id", "owner_coordinator_id", "idempotency_key", "request_hash",
  "task_goal_hash", "state", "state_version", "execution_started", "native_outcome",
  "termination_reason", "finalization_error", "terminal_candidate", "retry_of_turn_id",
  "deadline_at", "native_conversation_ref", "continuation", "input_manifest_id",
  "task_artifact_refs", "baseline_snapshot_id", "review_target_snapshot_id",
  "git_base_commit", "git_target_commit", "git_working_tree_digest", "final_snapshot_id", "runtime_id", "error_code",
  "created_at", "accepted_at", "terminal_at", "updated_at",
];

function mapTurnRow(row: Record<string, unknown>): TurnRecord {
  return {
    turn_id: String(row.turn_id),
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    owner_coordinator_id: String(row.owner_coordinator_id),
    idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash),
    task_goal_hash: row.task_goal_hash === null ? null : String(row.task_goal_hash),
    state: String(row.state) as TurnState,
    state_version: Number(row.state_version),
    execution_started: row.execution_started === null ? null : intToBool(row.execution_started),
    native_outcome: (row.native_outcome === null ? null : String(row.native_outcome)) as TurnRecord["native_outcome"],
    termination_reason: (row.termination_reason === null ? null : String(row.termination_reason)) as TurnRecord["termination_reason"],
    finalization_error: row.finalization_error === null ? null : String(row.finalization_error),
    terminal_candidate: (row.terminal_candidate === null ? null : String(row.terminal_candidate)) as TurnRecord["terminal_candidate"],
    retry_of_turn_id: row.retry_of_turn_id === null ? null : String(row.retry_of_turn_id),
    deadline_at: row.deadline_at === null ? null : Number(row.deadline_at),
    native_conversation_ref: row.native_conversation_ref === null ? null : String(row.native_conversation_ref),
    continuation: (row.continuation === null ? null : String(row.continuation)) as TurnRecord["continuation"],
    input_manifest_id: row.input_manifest_id === null ? null : String(row.input_manifest_id),
    task_artifact_refs: jsonParseArray(row.task_artifact_refs),
    baseline_snapshot_id: row.baseline_snapshot_id === null ? null : String(row.baseline_snapshot_id),
    review_target_snapshot_id: row.review_target_snapshot_id === null ? null : String(row.review_target_snapshot_id),
    git_base_commit: row.git_base_commit === null || row.git_base_commit === undefined ? null : String(row.git_base_commit),
    git_target_commit: row.git_target_commit === null || row.git_target_commit === undefined ? null : String(row.git_target_commit),
    git_working_tree_digest: row.git_working_tree_digest === null || row.git_working_tree_digest === undefined ? null : String(row.git_working_tree_digest),
    final_snapshot_id: row.final_snapshot_id === null ? null : String(row.final_snapshot_id),
    runtime_id: row.runtime_id === null ? null : String(row.runtime_id),
    error_code: row.error_code === null ? null : String(row.error_code),
    created_at: Number(row.created_at),
    accepted_at: row.accepted_at === null ? null : Number(row.accepted_at),
    terminal_at: row.terminal_at === null ? null : Number(row.terminal_at),
    updated_at: Number(row.updated_at),
  };
}

export function insertTurn(db: RegistryDb, rec: TurnRecord): void {
  const cols = TURN_COLUMNS.map(snake).join(", ");
  const placeholders = TURN_COLUMNS.map(() => "?").join(", ");
  const values = TURN_COLUMNS.map((k) => {
    const v = rec[k];
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
  db.raw.prepare(`INSERT INTO turns (${cols}) VALUES (${placeholders})`).run(...sqlValues(values));
}

export function getTurn(db: RegistryDb, turnId: string): TurnRecord | null {
  const row = db.raw.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as Record<string, unknown> | undefined;
  return row ? mapTurnRow(row) : null;
}

/** Optimistic-concurrency update over state_version. */
export function updateTurnFields(
  db: RegistryDb,
  turnId: string,
  fields: Partial<TurnRecord>,
  expectedStateVersion: number,
  now: number,
): void {
  const keys = (Object.keys(fields) as Array<keyof TurnRecord>).filter((k) => k !== "turn_id" && k !== "state_version");
  const toBoolInt = (k: keyof TurnRecord, v: unknown): unknown =>
    k === "execution_started" ? (v === null ? null : v ? 1 : 0) : v;
  if (keys.length === 0) {
    db.raw
      .prepare("UPDATE turns SET state_version = state_version + 1, updated_at = ? WHERE turn_id = ? AND state_version = ?")
      .run(now, turnId, expectedStateVersion);
    return;
  }
  const sets = keys.map((k) => `${snake(k)} = ?`).join(", ");
  const values = keys.map((k) => toBoolInt(k, fields[k]));
  const result = db.raw
    .prepare(`UPDATE turns SET ${sets}, state_version = state_version + 1, updated_at = ? WHERE turn_id = ? AND state_version = ?`)
    .run(...sqlValues([...values, now, turnId, expectedStateVersion]));
  if (result.changes === 0) throw new Error("CONCURRENT_UPDATE");
}

export function listNonterminalTurns(db: RegistryDb): TurnRecord[] {
  const rows = db.raw
    .prepare(
      "SELECT * FROM turns WHERE state IN ('ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN')",
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map(mapTurnRow);
}

// ─── idempotency ledger (§7.3) ──────────────────────────────────────────────

export interface IdempotencyNamespace {
  project_id: string;
  owner_coordinator_id: string;
  operation_name: OperationName;
  idempotency_key: string;
}

export type IdempotencyRow = IdempotencyRecord;

export function insertIdempotencyRecord(db: RegistryDb, rec: IdempotencyRecord): void {
  try {
    db.raw
      .prepare(
        `INSERT INTO idempotency_records (project_id, owner_coordinator_id, operation_name, idempotency_key,
         request_hash, outcome, resolved_kind, resolved_id, rejection_code, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.project_id,
        rec.owner_coordinator_id,
        rec.operation_name,
        rec.idempotency_key,
        rec.request_hash,
        rec.outcome,
        rec.resolved_kind,
        rec.resolved_id,
        rec.rejection_code,
        rec.created_at,
      );
  } catch (e) {
    const constraint = asConstraintError(e);
    if (constraint) throw constraint;
    throw e;
  }
}

export function getIdempotencyRecord(db: RegistryDb, ns: IdempotencyNamespace): IdempotencyRow | null {
  const row = db.raw
    .prepare("SELECT * FROM idempotency_records WHERE project_id = ? AND owner_coordinator_id = ? AND operation_name = ? AND idempotency_key = ?")
    .get(ns.project_id, ns.owner_coordinator_id, ns.operation_name, ns.idempotency_key) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    project_id: String(row.project_id),
    owner_coordinator_id: String(row.owner_coordinator_id),
    operation_name: String(row.operation_name) as OperationName,
    idempotency_key: String(row.idempotency_key),
    request_hash: String(row.request_hash),
    outcome: String(row.outcome) as "accepted" | "rejected",
    resolved_kind: (row.resolved_kind === null ? null : String(row.resolved_kind)) as IdempotencyRecord["resolved_kind"],
    resolved_id: row.resolved_id === null ? null : String(row.resolved_id),
    rejection_code: row.rejection_code === null ? null : String(row.rejection_code),
    created_at: Number(row.created_at),
  };
}

// ─── reservations ───────────────────────────────────────────────────────────

export function insertReservation(db: RegistryDb, rec: ReservationRecord): void {
  try {
    db.raw
      .prepare(
        `INSERT INTO reservations (reservation_id, kind, scope, mode, owner_session_id, owner_turn_id, created_at, released_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(rec.reservation_id, rec.kind, rec.scope, rec.mode, rec.owner_session_id, rec.owner_turn_id, rec.created_at, rec.released_at);
  } catch (e) {
    const constraint = asConstraintError(e);
    if (constraint) throw constraint;
    throw e;
  }
}

export function countActiveReservations(db: RegistryDb, kind: ReservationKind, scope: string): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) c FROM reservations WHERE kind = ? AND scope = ? AND released_at IS NULL")
    .get(kind, scope) as { c: number };
  return row.c;
}

export function releaseReservation(db: RegistryDb, reservationId: string, now: number): void {
  db.raw
    .prepare("UPDATE reservations SET released_at = ? WHERE reservation_id = ? AND released_at IS NULL")
    .run(now, reservationId);
}

/** Active reservations owned by a turn or session (first match wins per row). */
export function listActiveReservationsByOwner(db: RegistryDb, ownerId: string): ReservationRecord[] {
  const rows = db.raw
    .prepare(
      `SELECT * FROM reservations WHERE released_at IS NULL AND (owner_turn_id = ? OR owner_session_id = ?)`,
    )
    .all(ownerId, ownerId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    reservation_id: String(row.reservation_id),
    kind: String(row.kind) as ReservationKind,
    scope: String(row.scope),
    mode: String(row.mode) as "exclusive" | "shared_read",
    owner_session_id: row.owner_session_id === null ? null : String(row.owner_session_id),
    owner_turn_id: row.owner_turn_id === null ? null : String(row.owner_turn_id),
    created_at: Number(row.created_at),
    released_at: row.released_at === null ? null : Number(row.released_at),
  }));
}

export function listActiveReservations(db: RegistryDb, kind?: ReservationKind): ReservationRecord[] {
  const rows = (kind
    ? db.raw.prepare("SELECT * FROM reservations WHERE released_at IS NULL AND kind = ?").all(kind)
    : db.raw.prepare("SELECT * FROM reservations WHERE released_at IS NULL").all()
  ) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    reservation_id: String(row.reservation_id),
    kind: String(row.kind) as ReservationKind,
    scope: String(row.scope),
    mode: String(row.mode) as "exclusive" | "shared_read",
    owner_session_id: row.owner_session_id === null ? null : String(row.owner_session_id),
    owner_turn_id: row.owner_turn_id === null ? null : String(row.owner_turn_id),
    created_at: Number(row.created_at),
    released_at: row.released_at === null ? null : Number(row.released_at),
  }));
}

// ─── events ─────────────────────────────────────────────────────────────────

export interface AppendEventArgs {
  turn_id: string | null;
  session_id: string | null;
  type: string;
  payload: Record<string, unknown> | string | null;
  created_at: number;
}

export function appendEvent(db: RegistryDb, args: AppendEventArgs): number {
  const payload = args.payload === null ? null : typeof args.payload === "string" ? args.payload : JSON.stringify(args.payload);
  const result = db.raw
    .prepare("INSERT INTO events (turn_id, session_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(args.turn_id, args.session_id, args.type, payload, args.created_at);
  return Number(result.lastInsertRowid);
}

function mapEventRow(row: Record<string, unknown>): EventRecord {
  return {
    seq: Number(row.seq),
    turn_id: row.turn_id === null ? null : String(row.turn_id),
    session_id: row.session_id === null ? null : String(row.session_id),
    type: String(row.type),
    payload: row.payload === null ? null : String(row.payload),
    created_at: Number(row.created_at),
  };
}

export function listEventsAfterSeq(db: RegistryDb, afterSeq: number, limit: number): EventRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
    .all(afterSeq, limit) as Array<Record<string, unknown>>;
  return rows.map(mapEventRow);
}

export function listEventsByTurn(db: RegistryDb, turnId: string, afterSeq: number, limit: number): EventRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM events WHERE turn_id = ? AND seq > ? ORDER BY seq LIMIT ?")
    .all(turnId, afterSeq, limit) as Array<Record<string, unknown>>;
  return rows.map(mapEventRow);
}

/** Persisted contract/result payloads in the existing journal; no schema migration. */
export function getTurnEventPayload(db: RegistryDb, turnId: string, type: string): Record<string, unknown> | null {
  const row = db.raw.prepare("SELECT payload FROM events WHERE turn_id = ? AND type = ? ORDER BY seq DESC LIMIT 1")
    .get(turnId, type) as { payload: string | null } | undefined;
  if (!row?.payload) return null;
  return JSON.parse(row.payload) as Record<string, unknown>;
}

export function getSessionInstructions(db: RegistryDb, sessionId: string): string | null {
  const row = db.raw.prepare("SELECT payload FROM intents WHERE session_id = ? AND kind = 'provision_session' ORDER BY created_at LIMIT 1")
    .get(sessionId) as { payload: string | null } | undefined;
  if (!row?.payload) return null;
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  return typeof payload.instructions === "string" ? payload.instructions : null;
}

// ─── intents ────────────────────────────────────────────────────────────────

function mapIntentRow(row: Record<string, unknown>): IntentRecord {
  return {
    intent_id: String(row.intent_id),
    kind: String(row.kind) as IntentKind,
    session_id: row.session_id === null ? null : String(row.session_id),
    turn_id: row.turn_id === null ? null : String(row.turn_id),
    state: String(row.state) as IntentState,
    payload: row.payload === null ? null : String(row.payload),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function insertIntent(db: RegistryDb, rec: IntentRecord): void {
  db.raw
    .prepare(
      "INSERT INTO intents (intent_id, kind, session_id, turn_id, state, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(rec.intent_id, rec.kind, rec.session_id, rec.turn_id, rec.state, rec.payload, rec.created_at, rec.updated_at);
}

export function getIntent(db: RegistryDb, intentId: string): IntentRecord | null {
  const row = db.raw.prepare("SELECT * FROM intents WHERE intent_id = ?").get(intentId) as Record<string, unknown> | undefined;
  return row ? mapIntentRow(row) : null;
}

export function updateIntentState(db: RegistryDb, intentId: string, state: IntentState, now: number): void {
  db.raw.prepare("UPDATE intents SET state = ?, updated_at = ? WHERE intent_id = ?").run(state, now, intentId);
}

export function listPendingIntents(db: RegistryDb, kind?: IntentKind): IntentRecord[] {
  const rows = (kind
    ? db.raw.prepare("SELECT * FROM intents WHERE state = 'pending' AND kind = ?").all(kind)
    : db.raw.prepare("SELECT * FROM intents WHERE state = 'pending'").all()
  ) as Array<Record<string, unknown>>;
  return rows.map(mapIntentRow);
}

// ─── artifacts & pins ───────────────────────────────────────────────────────

export function insertArtifact(db: RegistryDb, rec: ArtifactRecord): void {
  db.raw
    .prepare(
      "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at, expired_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(rec.artifact_id, rec.project_id, rec.kind, rec.content_hash, rec.size_bytes, rec.state, rec.created_at, rec.sealed_at, rec.expired_at);
}

export function getArtifact(db: RegistryDb, artifactId: string): ArtifactRecord | null {
  const row = db.raw.prepare("SELECT * FROM artifacts WHERE artifact_id = ?").get(artifactId) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    artifact_id: String(row.artifact_id),
    project_id: String(row.project_id),
    kind: String(row.kind) as ArtifactKind,
    content_hash: row.content_hash === null ? null : String(row.content_hash),
    size_bytes: row.size_bytes === null ? null : Number(row.size_bytes),
    state: String(row.state) as ArtifactState,
    created_at: Number(row.created_at),
    sealed_at: row.sealed_at === null ? null : Number(row.sealed_at),
    expired_at: row.expired_at === null ? null : Number(row.expired_at),
  };
}

export function sealArtifact(db: RegistryDb, artifactId: string, contentHash: string, sizeBytes: number, now: number): void {
  db.raw
    .prepare("UPDATE artifacts SET state = 'sealed', content_hash = ?, size_bytes = ?, sealed_at = ? WHERE artifact_id = ?")
    .run(contentHash, sizeBytes, now, artifactId);
}

export function expireArtifact(db: RegistryDb, artifactId: string, now: number): void {
  db.raw.prepare("UPDATE artifacts SET state = 'expired', expired_at = ? WHERE artifact_id = ?").run(now, artifactId);
}

export function insertPin(db: RegistryDb, rec: ArtifactPinRecord): void {
  // Identical (artifact, root, owner) tuples are idempotent: an accepted
  // input may already carry the same active_turn pin via its snapshot binding.
  try {
    db.raw
      .prepare(
        "INSERT INTO artifact_pins (pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(rec.pin_id, rec.artifact_id, rec.root_kind, rec.owner_session_id, rec.owner_turn_id, rec.created_at);
  } catch (e) {
    const constraint = asConstraintError(e);
    if (constraint) {
      const existing = db.raw
        .prepare(
          "SELECT pin_id FROM artifact_pins WHERE artifact_id = ? AND root_kind = ? AND COALESCE(owner_turn_id,'') = COALESCE(?, '') AND COALESCE(owner_session_id,'') = COALESCE(?, '')"
        )
        .get(rec.artifact_id, rec.root_kind, rec.owner_turn_id, rec.owner_session_id);
      if (existing) return; // identical pin already present — not an error
      throw constraint;
    }
    throw e;
  }
}

export function countPinsByArtifact(db: RegistryDb, artifactId: string): number {
  const row = db.raw.prepare("SELECT COUNT(*) c FROM artifact_pins WHERE artifact_id = ?").get(artifactId) as { c: number };
  return row.c;
}

/** Pins owned by a turn or session. */
export function listPinsByOwner(db: RegistryDb, ownerId: string): ArtifactPinRecord[] {
  const rows = db.raw
    .prepare("SELECT * FROM artifact_pins WHERE owner_turn_id = ? OR owner_session_id = ?")
    .all(ownerId, ownerId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    pin_id: String(row.pin_id),
    artifact_id: String(row.artifact_id),
    root_kind: String(row.root_kind) as PinRootKind,
    owner_session_id: row.owner_session_id === null ? null : String(row.owner_session_id),
    owner_turn_id: row.owner_turn_id === null ? null : String(row.owner_turn_id),
    created_at: Number(row.created_at),
  }));
}

export function releasePin(db: RegistryDb, pinId: string): void {
  db.raw.prepare("DELETE FROM artifact_pins WHERE pin_id = ?").run(pinId);
}
