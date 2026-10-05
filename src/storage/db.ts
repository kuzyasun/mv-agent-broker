/**
 * RegistryDb — node:sqlite (DatabaseSync) wrapper with migrations and a
 * synchronous serialized transaction helper (spec §7.2, §14.1, ADR-0001).
 *
 * DatabaseSync is synchronous, so a `tx()` block cannot interleave with other
 * JS in this process — this is the authoritative serialized metadata boundary.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const MIGRATION_V1_SQL = `
-- Agent Broker registry schema, migration v1 (spec §5, §7.2, §14.1).
-- Invariants enforced declaratively:
--   - idempotency namespace uniqueness (§7.3)
--   - at most one nonterminal turn per session, incl. UNKNOWN (INV-01)
--   - at most one exclusive workspace lease (INV-02)

CREATE TABLE IF NOT EXISTS daemon_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  daemon_state TEXT NOT NULL,
  incarnation TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ready_at INTEGER,
  fail_reason TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  project_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  configuration_revision INTEGER NOT NULL DEFAULT 1,
  session_cap INTEGER NOT NULL DEFAULT 20,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS coordinator_profiles (
  coordinator_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  allowed_project_ids TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,
  config_revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS account_profiles (
  account_profile_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  quota_scope_id TEXT NOT NULL,
  auth_mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_profiles (
  policy_profile_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL,
  PRIMARY KEY (policy_profile_id, version)
);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  mode TEXT NOT NULL CHECK (mode IN ('current','worktree','review_slot')),
  canonical_path TEXT,
  quarantined INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  owner_coordinator_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  adapter_version TEXT,
  cli_version TEXT,
  account_profile_id TEXT NOT NULL,
  auth_mode TEXT,
  requested_model TEXT NOT NULL,
  requested_effort TEXT,
  effective_model TEXT,
  effective_effort TEXT,
  role TEXT NOT NULL CHECK (role IN ('worker','reviewer','researcher')),
  instructions_hash TEXT NOT NULL,
  policy_profile_id TEXT NOT NULL,
  policy_profile_version TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(workspace_id),
  workspace_mode TEXT NOT NULL,
  coverage_profile_id TEXT,
  coverage_profile_version TEXT,
  coverage_contract_hash TEXT,
  native_conversation_ref TEXT,
  context_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (context_status IN ('not_started','available','unverified','missing')),
  state TEXT NOT NULL CHECK (state IN ('PROVISIONING','IDLE','ACTIVE','BLOCKED','CLOSED')),
  active_turn_id TEXT,
  block_reason TEXT,
  runtime_id TEXT,
  close_state TEXT NOT NULL DEFAULT 'none'
    CHECK (close_state IN ('none','pending','completed','failed')),
  close_intent_id TEXT,
  initial_snapshot_id TEXT,
  latest_snapshot_id TEXT,
  record_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(session_id),
  project_id TEXT NOT NULL,
  owner_coordinator_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  task_goal_hash TEXT,
  state TEXT NOT NULL CHECK (state IN
    ('ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN',
     'SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','ABANDONED')),
  state_version INTEGER NOT NULL DEFAULT 1,
  execution_started INTEGER,
  native_outcome TEXT CHECK (native_outcome IN ('completed','failed','interrupted','unknown') OR native_outcome IS NULL),
  termination_reason TEXT CHECK (termination_reason IN ('normal','cancelled','deadline','abandoned','startup_failure','input_delivery_failure') OR termination_reason IS NULL),
  finalization_error TEXT,
  terminal_candidate TEXT,
  retry_of_turn_id TEXT,
  deadline_at INTEGER,
  native_conversation_ref TEXT,
  continuation TEXT CHECK (continuation IN ('new_native_conversation','native_resume') OR continuation IS NULL),
  input_manifest_id TEXT,
  baseline_snapshot_id TEXT,
  final_snapshot_id TEXT,
  runtime_id TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  accepted_at INTEGER,
  terminal_at INTEGER,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_unfinished
  ON turns(session_id)
  WHERE state IN ('ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN');

CREATE INDEX IF NOT EXISTS idx_turns_session ON turns(session_id, created_at);

CREATE TABLE IF NOT EXISTS idempotency_records (
  project_id TEXT NOT NULL,
  owner_coordinator_id TEXT NOT NULL,
  operation_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
  resolved_kind TEXT CHECK (resolved_kind IN ('session','turn','artifact') OR resolved_kind IS NULL),
  resolved_id TEXT,
  rejection_code TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, owner_coordinator_id, operation_name, idempotency_key)
);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN
    ('turn_global','turn_quota_scope','turn_session','session_slot','workspace_lease')),
  scope TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'exclusive' CHECK (mode IN ('exclusive','shared_read')),
  owner_session_id TEXT,
  owner_turn_id TEXT,
  created_at INTEGER NOT NULL,
  released_at INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_ws_exclusive
  ON reservations(scope)
  WHERE kind = 'workspace_lease' AND released_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservations_turn_session
  ON reservations(scope)
  WHERE kind = 'turn_session' AND released_at IS NULL;

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id TEXT,
  session_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id, seq);

CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN
    ('provision_session','launch_turn','close_session','capture_snapshot','input_publication')),
  session_id TEXT,
  turn_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','completed','failed')),
  payload TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_intents_pending ON intents(kind, state);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER,
  state TEXT NOT NULL CHECK (state IN ('staging','sealed','expired')),
  created_at INTEGER NOT NULL,
  sealed_at INTEGER,
  expired_at INTEGER
);

CREATE TABLE IF NOT EXISTS artifact_pins (
  pin_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES artifacts(artifact_id),
  root_kind TEXT NOT NULL CHECK (root_kind IN
    ('active_turn','unknown_recovery','pending_intent','session_anchor','reviewer_anchor','operator_hold')),
  owner_session_id TEXT,
  owner_turn_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pins_dedup
  ON artifact_pins(artifact_id, root_kind,
    COALESCE(owner_turn_id,''), COALESCE(owner_session_id,''));
`;

const MIGRATION_V2_SQL = `
-- P2 (spec §8.7, §9, §14.1): coverage profiles, snapshot records, content blobs.
CREATE TABLE IF NOT EXISTS coverage_profiles (
  coverage_profile_id TEXT NOT NULL,
  version TEXT NOT NULL,
  config TEXT NOT NULL,
  contract_hash TEXT NOT NULL,
  PRIMARY KEY (coverage_profile_id, version)
);

ALTER TABLE workspaces ADD COLUMN coverage_profile_id TEXT;

CREATE TABLE IF NOT EXISTS snapshot_records (
  snapshot_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  workspace_id TEXT,
  coverage_profile_id TEXT NOT NULL,
  coverage_profile_version TEXT NOT NULL,
  coverage_contract_hash TEXT NOT NULL,
  source_digest TEXT NOT NULL,
  manifest_artifact_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('CAPTURING','SEALED','FAILED')),
  fail_reason TEXT,
  git_head TEXT,
  git_dirty INTEGER,
  captured_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_snapshots_workspace
  ON snapshot_records(project_id, workspace_id, captured_at);

CREATE TABLE IF NOT EXISTS blobs (
  project_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, content_hash)
);
`;


const MIGRATION_V3_SQL = `
-- P2-2: required task artifacts stored on the turn (spec 5.6, 7.1.1).
ALTER TABLE turns ADD COLUMN task_artifact_refs TEXT;
ALTER TABLE turns ADD COLUMN review_target_snapshot_id TEXT;
`;

const MIGRATION_V4_SQL = `
-- A19 durable completion evidence journaling (spec §14.3, §18).
CREATE TABLE IF NOT EXISTS turn_outcome_evidence (
  turn_id TEXT PRIMARY KEY,
  native_outcome TEXT NOT NULL CHECK (native_outcome IN ('completed','failed')),
  termination_hint TEXT,            -- 'normal' | 'cancelled' | 'deadline' | null
  candidate TEXT NOT NULL,          -- 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT'
  execution_started INTEGER NOT NULL,
  native_conversation_ref TEXT,
  recorded_at INTEGER NOT NULL,
  incarnation TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0
);
`;

const MIGRATION_V5_SQL = `
-- Shared quota-scope cooldown learned from definitive provider quota
-- exhaustion (one row per scope; an active pause blocks new dispatch).
CREATE TABLE IF NOT EXISTS quota_scope_cooldowns (
  quota_scope_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  until_ms INTEGER NOT NULL,
  retry_after_ms INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('vendor_reset_suffix','conservative_policy')),
  recorded_at INTEGER NOT NULL,
  recorded_by_turn_id TEXT NOT NULL
);
`;

const MIGRATION_V6_SQL = `
-- Git-native review binding: exact full-hex commits a read-only reviewer
-- turn was admitted against (null for snapshot/writer turns).
ALTER TABLE turns ADD COLUMN git_base_commit TEXT;
ALTER TABLE turns ADD COLUMN git_target_commit TEXT;
`;

const MIGRATION_V7_SQL = `
-- Fingerprint bound to a Git-native review of uncommitted work.
ALTER TABLE turns ADD COLUMN git_working_tree_digest TEXT;
`;

export type Migration = { version: number; sql: string };

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: MIGRATION_V1_SQL },
  { version: 2, sql: MIGRATION_V2_SQL },
  { version: 3, sql: MIGRATION_V3_SQL },
  { version: 4, sql: MIGRATION_V4_SQL },
  { version: 5, sql: MIGRATION_V5_SQL },
  { version: 6, sql: MIGRATION_V6_SQL },
  { version: 7, sql: MIGRATION_V7_SQL },
];

export class RegistryDb {
  readonly raw: DatabaseSync;
  private txDepth = 0;
  private migrationTableReady = false;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(path.dirname(filePath), { recursive: true });
    }
    this.raw = new DatabaseSync(filePath);
    this.raw.exec("PRAGMA journal_mode = WAL;");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    this.raw.exec("PRAGMA busy_timeout = 5000;");
    this.raw.exec("PRAGMA synchronous = NORMAL;");
    this.migrate();
  }

  private migrate(): void {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);",
    );
    this.migrationTableReady = true;
    const applied = new Set(
      (this.raw.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
        (r) => r.version,
      ),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.tx(() => {
        this.raw.exec(migration.sql);
        this.raw
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, Date.now());
      });
    }
  }

  get isMigrationReady(): boolean {
    return this.migrationTableReady;
  }

  /**
   * Serialized transaction (§7.2 "authoritative serialized metadata
   * boundary"). BEGIN IMMEDIATE grabs the write lock up front. Nested calls
   * throw — composition happens at the service layer.
   */
  tx<T>(fn: () => T): T {
    if (this.txDepth > 0) throw new Error("nested-transaction-not-supported");
    this.txDepth++;
    this.raw.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.raw.exec("COMMIT;");
      return result;
    } catch (e) {
      try {
        this.raw.exec("ROLLBACK;");
      } catch {
        /* connection already rolled back */
      }
      throw e;
    } finally {
      this.txDepth--;
    }
  }

  close(): void {
    this.raw.close();
  }
}

export function openRegistryDb(filePath: string): RegistryDb {
  return new RegistryDb(filePath);
}
