import { readFileSync } from "node:fs";
import path from "node:path";
import { sha256Hex } from "../shared/ids.ts";
import type { RegistryDb } from "../storage/db.ts";
import {
  getAccount,
  getCoordinator,
  getCoverageProfile,
  getPolicyProfile,
  getProject,
  getWorkspace,
  insertAccount,
  insertCoordinator,
  insertCoverageProfile,
  insertPolicyProfile,
  insertProject,
  insertWorkspace,
} from "../storage/repo.ts";
import {
  DEFAULT_LIMITS,
  type AccountProfileRecord,
  type CoordinatorProfileRecord,
  type CoverageProfileRecord,
  type PolicyProfileRecord,
  type ProjectRecord,
  type WorkspaceMode,
  type WorkspaceRecord,
  type Limits,
} from "../shared/api-types.ts";
import { coverageContractHash, validateCoverageConfig, type CoverageConfig } from "../workspaces/coverage.ts";
import { MAX_REVIEW_DIFF_BYTES } from "../snapshots/diff.ts";

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
  config: Record<string, unknown>;
}

export interface OperatorCoverageProfile {
  coverage_profile_id: string;
  version?: string;
  config: CoverageConfig;
}

export type NativeSubagents =
  | { mode: "off" | "prefer"; max_agents: number }
  | { mode: "auto" };

export type OperatorLimits = Pick<Limits, "globalUnfinishedTurns" | "quotaScopeUnfinishedTurns" | "hardTurnDeadlineMs" | "maxReviewDiffBytes">;

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
  /** Readable profile name; omitted shows the route ID (UI and discovery). */
  display_name?: string;
  /**
   * Named-profile selection control for NEW spawns; omitted means enabled.
   * Existing bound sessions are unaffected and committed replays still
   * return their accepted sessions; this is not provider/account revocation.
   */
  enabled?: boolean;
  /** Coordinator selection hints; never permissions, model, effort, deadlines. */
  tags?: string[];
}

/** Stored-tag budget; the derived tag may add a 13th effective entry. */
export const MAX_ROUTE_TAGS = 12;

/**
 * Reserved: derived from `native_subagents.mode` (prefer/auto), never stored.
 * The tag does not distinguish prefer/auto — the native_subagents field does.
 */
export const DERIVED_MULTI_AGENT_TAG = "multi-agent";

const ROUTE_TAG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Effective coordinator-visible tags: stored tags plus the derived reserved
 * tag when native delegation is preferred or agent-decided. The derived tag
 * is computed at the boundary (discovery/UI), never persisted.
 */
export function effectiveRouteTags(route: Pick<OperatorRoute, "tags" | "native_subagents">): string[] {
  const mode = route.native_subagents?.mode;
  return [...(route.tags ?? []), ...(mode === "prefer" || mode === "auto" ? [DERIVED_MULTI_AGENT_TAG] : [])];
}

export interface OperatorConfig {
  version?: 1;
  created_at?: number;
  state_dir: string;
  coordinator_id: string;
  native_binary_pins?: Record<string, string>;
  projects: OperatorProject[];
  coordinators: OperatorCoordinator[];
  accounts: OperatorAccount[];
  workspaces: OperatorWorkspace[];
  policy_profiles: OperatorPolicyProfile[];
  coverage_profiles: OperatorCoverageProfile[];
  routes: OperatorRoute[];
  limits?: Partial<OperatorLimits>;
}

export interface AppliedOperatorConfig {
  routes: Map<string, OperatorRoute>;
  coordinator_id: string;
}

function fail(message: string): never {
  throw new Error(`Invalid operator config: ${message}`);
}

function nonEmpty(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function positiveSafeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 1) {
    fail(`${name} must be a positive finite safe integer`);
  }
  return value;
}

export function validateOperatorLimits(value: unknown): OperatorLimits {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    fail("limits must be an object");
  }
  const raw = (value ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== "globalUnfinishedTurns" && key !== "quotaScopeUnfinishedTurns" && key !== "hardTurnDeadlineMs" && key !== "maxReviewDiffBytes") {
      fail(`unknown limits key '${key}'`);
    }
  }
  const deadline = raw.hardTurnDeadlineMs === undefined
    ? DEFAULT_LIMITS.hardTurnDeadlineMs
    : positiveSafeInteger(raw.hardTurnDeadlineMs, "limits.hardTurnDeadlineMs");
  if (deadline < 1_000 || deadline > 86_400_000) fail("limits.hardTurnDeadlineMs must be between 1000 and 86400000");
  const maxReviewDiffBytes = raw.maxReviewDiffBytes === undefined
    ? DEFAULT_LIMITS.maxReviewDiffBytes
    : positiveSafeInteger(raw.maxReviewDiffBytes, "limits.maxReviewDiffBytes");
  if (maxReviewDiffBytes > MAX_REVIEW_DIFF_BYTES) {
    fail(`limits.maxReviewDiffBytes must not exceed ${MAX_REVIEW_DIFF_BYTES} bytes (256 MiB)`);
  }
  return {
    globalUnfinishedTurns: raw.globalUnfinishedTurns === undefined
      ? DEFAULT_LIMITS.globalUnfinishedTurns
      : positiveSafeInteger(raw.globalUnfinishedTurns, "limits.globalUnfinishedTurns"),
    quotaScopeUnfinishedTurns: raw.quotaScopeUnfinishedTurns === undefined
      ? DEFAULT_LIMITS.quotaScopeUnfinishedTurns
      : positiveSafeInteger(raw.quotaScopeUnfinishedTurns, "limits.quotaScopeUnfinishedTurns"),
    hardTurnDeadlineMs: deadline,
    maxReviewDiffBytes,
  };
}

const PROVIDERS = new Set(["mock", "codex", "claude-code", "cursor", "zcode", "antigravity"]);
const PIN_KEYS = new Set(["codex", "claude-code", "claude", "cursor", "zcode", "zcode-bundle", "zcode-node", "zcode-config", "antigravity"]);

function rejectCredentialFields(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(password|secret|token|api[-_]?key|access[-_]?token|refresh[-_]?token|authorization|credentials)$/i.test(key)) {
      fail(`credential field '${key}' is not supported; log in with the provider CLI`);
    }
    rejectCredentialFields(child);
  }
}

function uniqueIds<T extends Record<string, unknown>>(items: T[], field: keyof T, name: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const id = nonEmpty(item[field], `${name}.${String(field)}`);
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(id)) fail(`${name}.${String(field)} must use letters, numbers, dot, underscore, or hyphen`);
    if (seen.has(id)) fail(`duplicate ${name} id '${id}'`);
    seen.add(id);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key =>
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hash the validated, path-normalized settings that affect new sessions.
 * The root timestamp is generated when it is absent and is not a setting.
 */
export function operatorConfigFingerprint(config: OperatorConfig): string {
  const { created_at: _generatedCreatedAt, ...semanticConfig } = config;
  return sha256Hex(stableJson(semanticConfig));
}

function parseInput(input: string): { value: unknown; baseDir: string } {
  const trimmed = input.trim();
  if (trimmed.startsWith("{")) {
    return { value: JSON.parse(trimmed) as unknown, baseDir: process.cwd() };
  }
  const filePath = path.resolve(input);
  return { value: JSON.parse(readFileSync(filePath, "utf8").trim()) as unknown, baseDir: path.dirname(filePath) };
}

function arrayField(raw: Record<string, unknown>, field: string): unknown[] {
  const value = raw[field];
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.some(row => !row || typeof row !== "object" || Array.isArray(row))) fail(`${field} rows must be objects`);
  return value;
}

export function validateOperatorConfig(input: unknown, baseDir = process.cwd()): OperatorConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("root must be an object");
  rejectCredentialFields(input);
  const raw = input as Record<string, unknown>;
  const limits = validateOperatorLimits(raw.limits);
  if (raw.version !== undefined && raw.version !== 1) fail("version must be 1");
  const stateDir = path.resolve(baseDir, nonEmpty(raw.state_dir, "state_dir"));
  const coordinatorId = nonEmpty(raw.coordinator_id, "coordinator_id");
  const projects = arrayField(raw, "projects") as OperatorProject[];
  const coordinators = arrayField(raw, "coordinators") as OperatorCoordinator[];
  const accounts = arrayField(raw, "accounts") as OperatorAccount[];
  const workspaces = arrayField(raw, "workspaces") as OperatorWorkspace[];
  const policies = arrayField(raw, "policy_profiles") as OperatorPolicyProfile[];
  const coverages = arrayField(raw, "coverage_profiles") as OperatorCoverageProfile[];
  const routes = arrayField(raw, "routes") as OperatorRoute[];
  uniqueIds(projects as unknown as Array<Record<string, unknown>>, "project_id", "projects");
  uniqueIds(coordinators as unknown as Array<Record<string, unknown>>, "coordinator_id", "coordinators");
  uniqueIds(accounts as unknown as Array<Record<string, unknown>>, "account_profile_id", "accounts");
  uniqueIds(workspaces as unknown as Array<Record<string, unknown>>, "workspace_id", "workspaces");
  uniqueIds(policies as unknown as Array<Record<string, unknown>>, "policy_profile_id", "policy_profiles");
  uniqueIds(coverages as unknown as Array<Record<string, unknown>>, "coverage_profile_id", "coverage_profiles");
  uniqueIds(routes as unknown as Array<Record<string, unknown>>, "route_id", "routes");

  const projectIds = new Set(projects.map(p => nonEmpty(p.project_id, "projects.project_id")));
  const coordinatorIds = new Set(coordinators.map(c => nonEmpty(c.coordinator_id, "coordinators.coordinator_id")));
  const accountById = new Map(accounts.map(a => [nonEmpty(a.account_profile_id, "accounts.account_profile_id"), a]));
  const policyIds = new Set(policies.map(p => nonEmpty(p.policy_profile_id, "policy_profiles.policy_profile_id")));
  const coverageIds = new Set(coverages.map(c => nonEmpty(c.coverage_profile_id, "coverage_profiles.coverage_profile_id")));

  for (const project of projects) {
    nonEmpty(project.display_name, `project ${project.project_id}.display_name`);
    if (project.session_cap !== undefined && (!Number.isInteger(project.session_cap) || project.session_cap < 1)) {
      fail(`project ${project.project_id}.session_cap must be a positive integer`);
    }
  }
  for (const coordinator of coordinators) {
    nonEmpty(coordinator.display_name, `coordinator ${coordinator.coordinator_id}.display_name`);
    if (!Array.isArray(coordinator.allowed_project_ids)) fail(`coordinator ${coordinator.coordinator_id}.allowed_project_ids must be an array`);
    for (const projectId of coordinator.allowed_project_ids) {
      if (!projectIds.has(projectId)) fail(`coordinator ${coordinator.coordinator_id} references unknown project '${projectId}'`);
    }
  }
  if (!coordinatorIds.has(coordinatorId)) fail(`coordinator_id '${coordinatorId}' is not configured`);
  for (const workspace of workspaces) {
    nonEmpty(workspace.workspace_id, "workspaces.workspace_id");
    if (!projectIds.has(workspace.project_id)) fail(`workspace ${workspace.workspace_id} references unknown project '${workspace.project_id}'`);
    if (!["current", "worktree", "review_slot"].includes(workspace.mode)) fail(`workspace ${workspace.workspace_id} has an invalid mode`);
    if (workspace.canonical_path !== null && typeof workspace.canonical_path !== "string") fail(`workspace ${workspace.workspace_id}.canonical_path must be a string or null`);
    if (workspace.canonical_path) workspace.canonical_path = path.resolve(baseDir, workspace.canonical_path);
    if (workspace.coverage_profile_id !== undefined && workspace.coverage_profile_id !== null && !coverageIds.has(workspace.coverage_profile_id)) {
      fail(`workspace ${workspace.workspace_id} references unknown coverage profile '${workspace.coverage_profile_id}'`);
    }
  }
  for (const profile of policies) {
    if (!profile.config || typeof profile.config !== "object" || Array.isArray(profile.config)) fail(`policy ${profile.policy_profile_id}.config must be an object`);
    profile.version ??= "1";
  }
  for (const profile of coverages) {
    if (!profile.config || typeof profile.config !== "object" || Array.isArray(profile.config)) fail(`coverage ${profile.coverage_profile_id}.config must be an object`);
    if (!Array.isArray(profile.config.source_prefixes) || !Array.isArray(profile.config.non_source_prefixes) || !Array.isArray(profile.config.excluded_prefixes)) {
      fail(`coverage ${profile.coverage_profile_id}.config must declare all prefix arrays`);
    }
    validateCoverageConfig(profile.config);
    profile.version ??= "1";
  }
  for (const account of accounts) {
    nonEmpty(account.provider, `account ${account.account_profile_id}.provider`);
    if (!PROVIDERS.has(account.provider)) fail(`account ${account.account_profile_id} has an unknown provider`);
    nonEmpty(account.quota_scope_id, `account ${account.account_profile_id}.quota_scope_id`);
    nonEmpty(account.auth_mode, `account ${account.account_profile_id}.auth_mode`);
  }
  for (const route of routes) {
    nonEmpty(route.model, `route ${route.route_id}.model`);
    if (!projectIds.has(route.project_id)) fail(`route ${route.route_id} references unknown project '${route.project_id}'`);
    const account = accountById.get(route.account_profile_id);
    if (!account) fail(`route ${route.route_id} references unknown account '${route.account_profile_id}'`);
    if (account.provider !== route.provider) fail(`route ${route.route_id} provider does not match its account`);
    if (!policyIds.has(route.policy_profile_id)) fail(`route ${route.route_id} references unknown policy '${route.policy_profile_id}'`);
    if (!["worker", "reviewer", "researcher"].includes(route.role)) fail(`route ${route.route_id} has an invalid role`);
    if (route.display_name !== undefined) nonEmpty(route.display_name, `route ${route.route_id}.display_name`);
    if (route.enabled !== undefined && typeof route.enabled !== "boolean") fail(`route ${route.route_id}.enabled must be a boolean`);
    if (route.tags !== undefined) {
      if (!Array.isArray(route.tags) || route.tags.some(tag => typeof tag !== "string")) {
        fail(`route ${route.route_id}.tags must be an array of strings`);
      }
      const seen = new Set<string>();
      for (const tag of route.tags) {
        if (!ROUTE_TAG_PATTERN.test(tag)) {
          fail(`route ${route.route_id}.tags entries must be 1-32 lower-case letters, numbers, hyphen, or underscore, beginning with a letter or number`);
        }
        if (tag === DERIVED_MULTI_AGENT_TAG) {
          fail(`route ${route.route_id}.tags must not store the reserved '${DERIVED_MULTI_AGENT_TAG}' tag; set native_subagents mode prefer or auto instead`);
        }
        if (seen.has(tag)) fail(`route ${route.route_id}.tags has duplicate tag '${tag}'`);
        seen.add(tag);
      }
      if (seen.size > MAX_ROUTE_TAGS) {
        fail(`route ${route.route_id}.tags must hold at most ${MAX_ROUTE_TAGS} stored tags (the derived '${DERIVED_MULTI_AGENT_TAG}' tag is additional)`);
      }
    }
    if (route.role !== "worker") {
      const policy = policies.find(p => p.policy_profile_id === route.policy_profile_id);
      const access = policy && policy.config && typeof policy.config === "object" && !Array.isArray(policy.config)
        ? (policy.config as Record<string, unknown>).access
        : undefined;
      if (access !== "read_only") {
        fail(`route ${route.route_id} role '${route.role}' requires a policy profile with access 'read_only'`);
      }
    }
    if (route.effort !== undefined && route.effort !== null) nonEmpty(route.effort, `route ${route.route_id}.effort`);
    if (route.native_subagents !== undefined) {
      const preference = route.native_subagents;
      if (!preference || typeof preference !== "object" || Array.isArray(preference)) {
        fail(`route ${route.route_id}.native_subagents must use mode off|prefer with a positive max_agents, or auto without max_agents`);
      } else if (preference.mode === "auto") {
        if (Object.prototype.hasOwnProperty.call(preference, "max_agents")) {
          fail(`route ${route.route_id}.native_subagents auto mode must be without max_agents`);
        }
      } else if (preference.mode !== "off" && preference.mode !== "prefer") {
        fail(`route ${route.route_id}.native_subagents must use mode off|prefer with a positive max_agents, or auto without max_agents`);
      } else if (!Number.isInteger(preference.max_agents) || preference.max_agents < 1) {
        fail(`route ${route.route_id}.native_subagents must use mode off|prefer and a positive max_agents`);
      }
    }
  }
  const pins = raw.native_binary_pins;
  if (pins !== undefined) {
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) fail("native_binary_pins must be an object");
    for (const [provider, pin] of Object.entries(pins as Record<string, unknown>)) {
      if (!PIN_KEYS.has(provider)) fail(`unknown native binary pin '${provider}'`);
      if (!provider || typeof pin !== "string" || pin.length === 0) fail(`native_binary_pins.${provider} must be a non-empty string`);
    }
  }
  return {
    version: 1,
    created_at: typeof raw.created_at === "number" ? raw.created_at : Date.now(),
    state_dir: stateDir,
    coordinator_id: coordinatorId,
    native_binary_pins: pins === undefined ? undefined : Object.fromEntries(
      Object.entries(pins as Record<string, string>).map(([provider, binary]) => [provider, path.resolve(baseDir, binary)]),
    ),
    projects,
    coordinators,
    accounts,
    workspaces,
    policy_profiles: policies,
    coverage_profiles: coverages,
    routes,
    limits,
  };
}

export function loadOperatorConfig(input: string): OperatorConfig {
  const parsed = parseInput(input);
  return validateOperatorConfig(parsed.value, parsed.baseDir);
}

function hasSessions(db: RegistryDb, column: string, value: string): boolean {
  if (!/^(project_id|owner_coordinator_id|account_profile_id|workspace_id|policy_profile_id|coverage_profile_id)$/.test(column)) {
    throw new Error("invalid registry column");
  }
  const row = db.raw.prepare(`SELECT 1 FROM sessions WHERE ${column} = ? LIMIT 1`).get(value);
  return row !== undefined;
}

function rejectBoundChange(db: RegistryDb, kind: string, id: string, changed: boolean, column: string): void {
  if (changed && hasSessions(db, column, id)) fail(`${kind} '${id}' is bound by an existing session and cannot change`);
}

export function applyOperatorConfig(db: RegistryDb, config: OperatorConfig): AppliedOperatorConfig {
  const normalized = validateOperatorConfig(config, process.cwd());
  const now = normalized.created_at ?? Date.now();
  db.tx(() => {
    for (const project of normalized.projects) {
      const old = getProject(db, project.project_id);
      if (!old) {
        insertProject(db, {
          project_id: project.project_id, display_name: project.display_name,
          configuration_revision: 1, session_cap: project.session_cap ?? 20,
          created_at: project.created_at ?? now,
        });
      } else {
        db.raw.prepare("UPDATE projects SET display_name = ?, session_cap = ?, configuration_revision = ? WHERE project_id = ?")
          .run(project.display_name, project.session_cap ?? old.session_cap, old.configuration_revision + 1, old.project_id);
      }
    }
    for (const coordinator of normalized.coordinators) {
      const old = getCoordinator(db, coordinator.coordinator_id);
      const next: CoordinatorProfileRecord = {
        coordinator_id: coordinator.coordinator_id, display_name: coordinator.display_name,
        allowed_project_ids: coordinator.allowed_project_ids, revoked: coordinator.revoked ?? false,
        config_revision: (old?.config_revision ?? 0) + 1,
      };
      if (!old) insertCoordinator(db, next);
      else {
        // ACL/revocation remain operator-managed; immutable session ownership
        // still refers to this same coordinator ID.
        db.raw.prepare("UPDATE coordinator_profiles SET display_name = ?, allowed_project_ids = ?, revoked = ?, config_revision = ? WHERE coordinator_id = ?")
          .run(next.display_name, JSON.stringify(next.allowed_project_ids), next.revoked ? 1 : 0, next.config_revision, next.coordinator_id);
      }
    }
    for (const account of normalized.accounts) {
      const old = getAccount(db, account.account_profile_id);
      if (!old) insertAccount(db, account);
      else {
        rejectBoundChange(db, "account", account.account_profile_id,
          old.provider !== account.provider || old.quota_scope_id !== account.quota_scope_id || old.auth_mode !== account.auth_mode,
          "account_profile_id");
        db.raw.prepare("UPDATE account_profiles SET provider = ?, quota_scope_id = ?, auth_mode = ? WHERE account_profile_id = ?")
          .run(account.provider, account.quota_scope_id, account.auth_mode, account.account_profile_id);
      }
    }
    for (const profile of normalized.policy_profiles) {
      const version = profile.version ?? "1";
      const serialized = stableJson(profile.config);
      const old = getPolicyProfile(db, profile.policy_profile_id, version);
      if (!old) insertPolicyProfile(db, { policy_profile_id: profile.policy_profile_id, version, config: serialized });
      else {
        rejectBoundChange(db, "policy profile", profile.policy_profile_id, stableJson(JSON.parse(old.config)) !== serialized, "policy_profile_id");
        db.raw.prepare("UPDATE policy_profiles SET config = ? WHERE policy_profile_id = ? AND version = ?").run(serialized, profile.policy_profile_id, version);
      }
    }
    for (const profile of normalized.coverage_profiles) {
      const version = profile.version ?? "1";
      const serialized = stableJson(profile.config);
      const hash = coverageContractHash(profile.config);
      const old = getCoverageProfile(db, profile.coverage_profile_id, version);
      const next: CoverageProfileRecord = { coverage_profile_id: profile.coverage_profile_id, version, config: serialized, contract_hash: hash };
      if (!old) insertCoverageProfile(db, next);
      else {
        rejectBoundChange(db, "coverage profile", profile.coverage_profile_id, stableJson(JSON.parse(old.config)) !== serialized || old.contract_hash !== hash, "coverage_profile_id");
        db.raw.prepare("UPDATE coverage_profiles SET config = ?, contract_hash = ? WHERE coverage_profile_id = ? AND version = ?")
          .run(serialized, hash, profile.coverage_profile_id, version);
      }
    }
    for (const workspace of normalized.workspaces) {
      const old = getWorkspace(db, workspace.workspace_id);
      const next: WorkspaceRecord = {
        workspace_id: workspace.workspace_id, project_id: workspace.project_id, mode: workspace.mode,
        canonical_path: workspace.canonical_path, quarantined: workspace.quarantined ?? false,
        quarantine_reason: workspace.quarantine_reason ?? null, coverage_profile_id: workspace.coverage_profile_id ?? null,
      };
      if (!old) insertWorkspace(db, next);
      else {
        rejectBoundChange(db, "workspace", workspace.workspace_id,
          old.project_id !== next.project_id || old.mode !== next.mode || old.canonical_path !== next.canonical_path ||
          old.coverage_profile_id !== next.coverage_profile_id, "workspace_id");
        db.raw.prepare("UPDATE workspaces SET project_id = ?, mode = ?, canonical_path = ?, coverage_profile_id = ? WHERE workspace_id = ?")
          .run(next.project_id, next.mode, next.canonical_path, next.coverage_profile_id, next.workspace_id);
      }
    }
  });
  return { routes: new Map(normalized.routes.map(route => [route.route_id, route])), coordinator_id: normalized.coordinator_id };
}
