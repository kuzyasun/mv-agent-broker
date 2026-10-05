/**
 * Core domain types, API 0.2 (spec §5, §6, §10).
 * These types are the single source shared by daemon core, adapters and tests.
 */

export const API_VERSION = "0.2";

// ─── Session (§6.1) ─────────────────────────────────────────────────────────

export const SESSION_STATES = [
  "PROVISIONING",
  "IDLE",
  "ACTIVE",
  "BLOCKED",
  "CLOSED",
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const CONTEXT_STATUSES = ["not_started", "available", "unverified", "missing"] as const;
export type ContextStatus = (typeof CONTEXT_STATUSES)[number];

export const CLOSE_STATES = ["none", "pending", "completed", "failed"] as const;
export type CloseState = (typeof CLOSE_STATES)[number];

export type ContinuationKind = "new_native_conversation" | "native_resume";

export interface SessionRecord {
  session_id: string;
  project_id: string;
  owner_coordinator_id: string;
  provider: string;
  adapter_version: string | null;
  cli_version: string | null;
  account_profile_id: string;
  auth_mode: string | null;
  requested_model: string;
  requested_effort: string | null;
  effective_model: string | null;
  effective_effort: string | null;
  role: AgentRole;
  instructions_hash: string;
  policy_profile_id: string;
  policy_profile_version: string;
  workspace_id: string | null;
  workspace_mode: WorkspaceMode;
  coverage_profile_id: string | null;
  coverage_profile_version: string | null;
  coverage_contract_hash: string | null;
  native_conversation_ref: string | null;
  context_status: ContextStatus;
  state: SessionState;
  active_turn_id: string | null;
  block_reason: string | null;
  runtime_id: string | null;
  close_state: CloseState;
  close_intent_id: string | null;
  initial_snapshot_id: string | null;
  latest_snapshot_id: string | null;
  record_version: number;
  created_at: number;
  updated_at: number;
}

// ─── Turn (§6.2) ────────────────────────────────────────────────────────────

export const TURN_STATES = [
  "ACCEPTED",
  "STARTING",
  "RUNNING",
  "CANCELLING",
  "FINALIZING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "ABANDONED",
  "UNKNOWN",
] as const;
export type TurnState = (typeof TURN_STATES)[number];

export const TURN_TERMINAL_STATES: readonly TurnState[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "TIMED_OUT",
  "ABANDONED",
];

/** Separate from state: failed evidence capture must not erase facts (§5.3). */
export type NativeOutcome = "completed" | "failed" | "interrupted" | "unknown" | null;
export type TerminationReason = "normal" | "cancelled" | "deadline" | "abandoned" | "startup_failure" | "input_delivery_failure" | null;
export type TerminalCandidate = Exclude<TurnState, "UNKNOWN"> | null;

export interface TurnRecord {
  turn_id: string;
  session_id: string;
  project_id: string;
  owner_coordinator_id: string;
  idempotency_key: string;
  request_hash: string;
  task_goal_hash: string | null;
  state: TurnState;
  state_version: number;
  execution_started: boolean | null;
  native_outcome: NativeOutcome;
  termination_reason: TerminationReason;
  finalization_error: string | null;
  terminal_candidate: TerminalCandidate;
  retry_of_turn_id: string | null;
  deadline_at: number | null;
  native_conversation_ref: string | null;
  continuation: ContinuationKind | null;
  input_manifest_id: string | null;
  task_artifact_refs: string[];
  baseline_snapshot_id: string | null;
  review_target_snapshot_id: string | null;
  /** Git-native review binding: exact reviewed commits (full hex), null for non-Git-review turns. */
  git_base_commit: string | null;
  git_target_commit: string | null;
  /** Fingerprint of an admitted uncommitted Git checkout, null for clean reviews. */
  git_working_tree_digest: string | null;
  final_snapshot_id: string | null;
  runtime_id: string | null;
  error_code: string | null;
  created_at: number;
  accepted_at: number | null;
  terminal_at: number | null;
  updated_at: number;
}

// ─── Idempotency ledger (§7.3) ──────────────────────────────────────────────

/** Namespace: (project_id, owner_coordinator_id, operation_name, key) (§7.3). */
export type OperationName = "agent_session_spawn" | "agent_session_send" | "agent_turn_cancel" | "agent_session_stop" | "agent_workspace_snapshot";

export type IdempotencyOutcome = "accepted" | "rejected";

export interface IdempotencyRecord {
  project_id: string;
  owner_coordinator_id: string;
  operation_name: OperationName;
  idempotency_key: string;
  request_hash: string;
  outcome: IdempotencyOutcome;
  resolved_kind: "session" | "turn" | "artifact" | null;
  resolved_id: string | null;
  rejection_code: string | null;
  created_at: number;
}

// ─── Reservations / leases (§6.5.3, §8.4, §15.1) ────────────────────────────

export const RESERVATION_KINDS = [
  "turn_global", // global concurrent inference turns (default cap 3)
  "turn_quota_scope", // per quota scope (default cap 1)
  "turn_session", // one unfinished turn per session (INV-01)
  "session_slot", // open logical sessions per project (default cap 20)
  "workspace_lease", // writer-exclusive (INV-02) / reader-shared
] as const;
export type ReservationKind = (typeof RESERVATION_KINDS)[number];

export interface ReservationRecord {
  reservation_id: string;
  kind: ReservationKind;
  scope: string; // global | <quota_scope_id> | <session_id> | <project_id> | <workspace_id>
  mode: "exclusive" | "shared_read";
  owner_session_id: string | null;
  owner_turn_id: string | null;
  created_at: number;
  released_at: number | null;
}

// ─── Events (§10.5) ─────────────────────────────────────────────────────────

export interface EventRecord {
  seq: number;
  turn_id: string | null;
  session_id: string | null;
  type: string;
  payload: string | null; // JSON string, bounded
  created_at: number;
}

// ─── Intents (§14.3, §14.7) ─────────────────────────────────────────────────

export const INTENT_KINDS = [
  "provision_session",
  "launch_turn",
  "close_session",
  "capture_snapshot",
  "input_publication",
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export const INTENT_STATES = ["pending", "completed", "failed"] as const;
export type IntentState = (typeof INTENT_STATES)[number];

export interface IntentRecord {
  intent_id: string;
  kind: IntentKind;
  session_id: string | null;
  turn_id: string | null;
  state: IntentState;
  payload: string | null;
  created_at: number;
  updated_at: number;
}

// ─── Artifacts & pins (§5.4, §5.7, §15.3) ──────────────────────────────────

export const ARTIFACT_STATES = ["staging", "sealed", "expired"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const ARTIFACT_KINDS = [
  "snapshot_manifest",
  "snapshot_content",
  "patch",
  "findings",
  "report",
  "normalized_events",
  "input_manifest",
  "source_inventory",
  "result_capsule",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactRecord {
  artifact_id: string;
  project_id: string;
  kind: ArtifactKind;
  content_hash: string | null;
  size_bytes: number | null;
  state: ArtifactState;
  created_at: number;
  sealed_at: number | null;
  expired_at: number | null;
}

export const PIN_ROOT_KINDS = [
  "active_turn", // accepted/nonterminal turn
  "unknown_recovery", // UNKNOWN / unresolved recovery
  "pending_intent", // unfinished provisioning/close/capture
  "session_anchor", // open worker/researcher session anchors
  "reviewer_anchor", // open reviewer session anchors
  "operator_hold", // explicit operator hold
] as const;
export type PinRootKind = (typeof PIN_ROOT_KINDS)[number];

export interface ArtifactPinRecord {
  pin_id: string;
  artifact_id: string;
  root_kind: PinRootKind;
  owner_session_id: string | null;
  owner_turn_id: string | null;
  created_at: number;
}

// ─── Workspace / policy (§8) ────────────────────────────────────────────────

export const WORKSPACE_MODES = ["current", "worktree", "review_slot"] as const;
export type WorkspaceMode = (typeof WORKSPACE_MODES)[number];

export const AGENT_ROLES = ["worker", "reviewer", "researcher"] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

// ─── Daemon (§4.1.1) ────────────────────────────────────────────────────────

export const DAEMON_STATES = ["RECOVERING", "READY", "FAILED", "STOPPING"] as const;
export type DaemonState = (typeof DAEMON_STATES)[number];

// ─── Registry entities (§4.3, §5.5) ─────────────────────────────────────────

export interface ProjectRecord {
  project_id: string;
  display_name: string;
  configuration_revision: number;
  session_cap: number;
  created_at: number;
}

export interface CoordinatorProfileRecord {
  coordinator_id: string;
  display_name: string;
  allowed_project_ids: string[]; // JSON array in storage
  revoked: boolean;
  config_revision: number;
}

export interface AccountProfileRecord {
  account_profile_id: string;
  provider: string;
  quota_scope_id: string;
  auth_mode: string;
}

export interface PolicyProfileRecord {
  policy_profile_id: string;
  version: string;
  config: string; // JSON blob of the versioned policy profile
}

export interface WorkspaceRecord {
  workspace_id: string;
  project_id: string;
  mode: WorkspaceMode;
  canonical_path: string | null;
  quarantined: boolean;
  quarantine_reason: string | null;
  /** Coverage binding resolved at spawn (§5.2); null = no capture contract. */
  coverage_profile_id: string | null;
}

/** Versioned source-classification contract (spec §8.7, §9.1). */
export interface CoverageProfileRecord {
  coverage_profile_id: string;
  version: string;
  config: string; // JSON CoverageConfig
  contract_hash: string;
}

export type SnapshotState = "CAPTURING" | "SEALED" | "FAILED";

/**
 * Immutable capture of the admitted source set under one coverage binding
 * (spec §5.4, §9.1). Identity is the capture; equality of workspace state is
 * compared via source_digest, not snapshot_id equality.
 */
export interface SnapshotRecord {
  snapshot_id: string;
  project_id: string;
  workspace_id: string | null;
  coverage_profile_id: string;
  coverage_profile_version: string;
  coverage_contract_hash: string;
  source_digest: string;
  manifest_artifact_id: string;
  state: SnapshotState;
  fail_reason: string | null;
  git_head: string | null;
  git_dirty: boolean | null;
  captured_at: number;
}

export interface BlobRecord {
  project_id: string;
  content_hash: string;
  size_bytes: number;
  created_at: number;
}

/** One entry of a snapshot manifest (§9.1). */
export interface SnapshotManifestEntry {
  path: string; // POSIX-style relative path
  type: "file" | "dir";
  content_hash: string | null; // files only
  executable: boolean;
  size: number | null;
}

export interface SnapshotManifest {
  snapshot_id: string;
  project_id: string;
  workspace_id: string | null;
  coverage: { profile_id: string; version: string; contract_hash: string };
  entries: SnapshotManifestEntry[];
  source_digest: string;
  non_source_observed: string[];
  protected_observed: string[];
  excluded_observed: string[];
  capture_consistency: "broker_exclusive";
  git_provenance: { head: string | null; dirty: boolean | null } | null;
  captured_at: number;
}

// ─── Limits (§15.1 defaults) ────────────────────────────────────────────────

export interface Limits {
  globalUnfinishedTurns: number;
  quotaScopeUnfinishedTurns: number;
  // perSessionUnfinishedTurns is not configurable: INV-01 (one unfinished
  // turn per session) is enforced by the state machine + idx_turns_one_unfinished.
  openSessionsPerProject: number;
  hardTurnDeadlineMs: number;
  /** Complete review-diff delivery budget in bytes (default 32 MiB, max 256 MiB). */
  maxReviewDiffBytes: number;
}

export const DEFAULT_LIMITS: Limits = {
  globalUnfinishedTurns: 3,
  quotaScopeUnfinishedTurns: 1,
  openSessionsPerProject: 20,
  hardTurnDeadlineMs: 3_600_000,
  maxReviewDiffBytes: 32 * 1024 * 1024,
};
