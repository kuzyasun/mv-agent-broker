export interface OperatorProject {
  project_id: string;
  display_name: string;
  session_cap?: number;
  created_at?: number;
}

export interface OperatorCoordinator {
  coordinator_id: string;
  display_name: string;
  allowed_project_ids: string[];
  revoked?: boolean;
  config_revision?: number;
}

export interface OperatorAccount {
  account_profile_id: string;
  provider: string;
  quota_scope_id: string;
  auth_mode: string;
}

export type WorkspaceMode = "current" | "branch" | "share" | "review_slot";

export interface OperatorWorkspace {
  workspace_id: string;
  project_id: string;
  mode: WorkspaceMode;
  canonical_path: string | null;
  coverage_profile_id?: string | null;
  quarantined?: boolean;
  quarantine_reason?: string | null;
}

export interface OperatorPolicyProfile {
  policy_profile_id: string;
  version?: string;
  config: {
    access?: "read_only" | "workspace_write";
    write_scope?: string[];
    [key: string]: unknown;
  };
}

export interface CoverageConfig {
  source_prefixes: string[];
  non_source_prefixes: string[];
  excluded_prefixes: string[];
}

export interface OperatorCoverageProfile {
  coverage_profile_id: string;
  version?: string;
  config: CoverageConfig;
}

export type NativeSubagents =
  | { mode: "off" | "prefer"; max_agents: number }
  | { mode: "auto" };

export interface OperatorLimits {
  globalUnfinishedTurns?: number;
  quotaScopeUnfinishedTurns?: number;
  hardTurnDeadlineMs?: number;
  maxReviewDiffBytes?: number;
}

export interface OperatorRoute {
  route_id: string;
  project_id: string;
  provider: string;
  account_profile_id: string;
  model: string;
  effort?: string | null;
  role: "worker" | "reviewer" | "researcher";
  policy_profile_id: string;
  native_subagents?: NativeSubagents;
  display_name?: string;
  enabled?: boolean;
  tags?: string[];
}

export interface OperatorConfig {
  version?: 1;
  created_at?: number;
  state_dir: string;
  coordinator_id: string;
  limits?: OperatorLimits;
  native_binary_pins?: Record<string, string>;
  projects: OperatorProject[];
  coordinators: OperatorCoordinator[];
  accounts: OperatorAccount[];
  workspaces: OperatorWorkspace[];
  policy_profiles: OperatorPolicyProfile[];
  coverage_profiles: OperatorCoverageProfile[];
  routes: OperatorRoute[];
}

export interface HostDisplayPreferences {
  locale: string;
  timeZone: string;
  hourCycle: string | null;
}

export interface ConnectionSnippets {
  json: string;
  toml: string;
}

export interface BootstrapData {
  token: string;
  port: number;
  configPath: string;
  snippets: ConnectionSnippets;
  display: HostDisplayPreferences;
}

export interface QuotaPause {
  provider: string;
  quota_scope_id: string;
  retry_after: number | null;
  detail?: string | null;
}

export interface TurnErrorItem {
  turn_id: string;
  task_id?: string;
  session_id?: string;
  project_id?: string;
  created_at?: number;
  failed_at?: number;
  error_code?: string;
  error_message?: string;
  [key: string]: unknown;
}

export interface ActiveTurnItem {
  turn_id: string;
  task_id?: string;
  session_id?: string;
  project_id?: string;
  started_at?: number;
  provider?: string;
  model?: string;
  role?: string;
  [key: string]: unknown;
}

export interface OperatorStatus {
  status: "ready" | "stopped" | "unavailable";
  readiness: string;
  runtime_observation: "observed-running" | "last-known" | "unknown";
  settings_state: "applied" | "restart_required" | "unknown";
  saved_config_fingerprint: string;
  applied_config_fingerprint: string | null;
  runtime_commit: string | null;
  runtime_version: string | null;
  runtime_origin: unknown;
  runtime_identity: string | null;
  runtime_path: string | null;
  daemon_pid: number | null;
  active_turn_count: number | null;
  active_turns: ActiveTurnItem[] | null;
  active_turns_truncated?: boolean | null;
  error_turn_count: number | null;
  error_turns: TurnErrorItem[] | null;
  error_turns_truncated?: boolean | null;
  quota_pauses?: QuotaPause[];
  pending_intents?: unknown[] | null;
  state_dir: string;
  [key: string]: unknown;
}

export interface TurnErrorDetail {
  turn_id: string;
  error: Record<string, unknown>;
  [key: string]: unknown;
}

export interface CatalogObservation {
  provider: string;
  models: string[];
  observed_at: number;
  source: "cli_metadata_probe" | "config_catalog";
  detail: string | null;
}

export interface ModelOption {
  model: string;
  efforts: string[];
}

export interface CatalogRefreshResult {
  observation: CatalogObservation;
  options: ModelOption[];
}

export interface StoragePreview {
  preview_token: string;
  project_id: string;
  retention_days?: number;
  cutoff_timestamp?: number;
  registered_blob_bytes: number;
  registered_blob_count: number;
  eligible_artifact_count: number;
  protected_artifact_count: number;
  retained_recent_count: number;
}

export interface FolderEntry {
  path: string;
  parent: string | null;
  folders: Array<{ name: string; path: string }>;
}
