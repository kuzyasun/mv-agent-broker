/**
 * MCP tool registry — the 13 advertised tools of API 0.2 (spec §10.1).
 *
 * The bridge is presentation + bounded RPC only (§4.1): every tool maps to
 * one BrokerCore call, validates its arguments (additionalProperties=false)
 * and shapes the response DTO. Business decisions never live here.
 */
import type { BrokerCore } from "../core/broker.ts";
import { BrokerError } from "../shared/errors.ts";
import type { McpToolDef } from "./server.ts";
import type { SessionRecord, TurnRecord } from "../shared/api-types.ts";

export interface BridgeContext {
  coordinatorId: string;
  core: BrokerCore;
  /** Cancellation for a read-only event wait when its transport disconnects. */
  signal?: AbortSignal;
  /** Daemon readiness/incarnation surfaced by the bootstrap layer (§10.1.2). */
  daemonState?: string;
  incarnation?: string;
}

// ─── argument validation helpers ────────────────────────────────────────────

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new BrokerError("INVALID_REQUEST", `Argument '${key}' must be a non-empty string.`);
  }
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BrokerError("INVALID_REQUEST", `Argument '${key}' must be a string.`);
  return v;
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new BrokerError("INVALID_REQUEST", `Argument '${key}' must be an integer in [${min}, ${max}].`);
  }
  return v;
}

function optionalStringArray(args: Record<string, unknown>, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new BrokerError("INVALID_REQUEST", `Argument ${key} must be an array of strings.`);
  }
  return v as string[];
}

function rejectUnknownKeys(args: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(args)) {
    if (!allowed.includes(key)) {
      throw new BrokerError("INVALID_REQUEST", `Unknown argument '${key}'.`);
    }
  }
}

const str = { type: "string" } as const;
const int = (min: number, max: number) => ({ type: "integer", minimum: min, maximum: max });

// ─── tool definitions (§10.1) ───────────────────────────────────────────────

export function bridgeToolDefs(): McpToolDef[] {
  return [
    {
      name: "broker_status",
      description: "Daemon readiness, API version, resource summary and the project IDs this bridge may access (§10.1.2). No credentials.",
      inputSchema: { type: "object", properties: { limit: int(1, 100) }, additionalProperties: false },
    },
    {
      name: "agents_list",
      description: "Project bootstrap discovery: adapters, account/workspace/policy IDs, coverage bindings, configuration revision (§10.1.2).",
      inputSchema: {
        type: "object",
        properties: { project_id: str, cursor: str, limit: int(1, 100) },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_spawn",
      description: "Create a durable logical session (PROVISIONING→IDLE) without inference — launches no provider run (§6.1). Idempotent. For a configured route, supply project_id, idempotency_key, route_id, instructions and workspace; do not call with {} to inspect the schema. Task instructions such as 'read-only' do not set session policy. Use policy_restrictions.access='read_only' for an audit. Narrow policy_restrictions.write_scope only when the operator explicitly requests it; task paths never imply a file allowlist. A workspace_write profile without an explicit scope grants the whole project. After spawn, check agent_session_status.effective_policy to confirm the durable binding. mode=worktree with repository_workspace_id+base_commit requests a broker-created detached Git worktree (§8.3). role=reviewer with a registered current/worktree workspace is a Git-native read-only reviewer; role=reviewer with review_slot is the explicit snapshot-review alternative.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: str, idempotency_key: str, route_id: str, provider: str, account_profile_id: str,
          model: str, effort: str, role: { type: "string", enum: ["worker", "reviewer", "researcher"] },
          instructions: str,
          workspace: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["current", "worktree", "review_slot"] },
              workspace_id: str,
              // §8.3 additive: registered source repository reference and the
              // explicit full-hex base commit for a broker-created worktree.
              repository_workspace_id: str,
              base_commit: str,
            },
            required: ["mode"],
            additionalProperties: false,
          },
          policy_profile_id: str,
          policy_restrictions: { type: "object", additionalProperties: true },
        },
        required: ["project_id", "idempotency_key", "instructions", "workspace"],
        oneOf: [
          { required: ["route_id"], not: { anyOf: ["provider", "account_profile_id", "model", "effort", "role", "policy_profile_id"].map(key => ({ required: [key] })) } },
          { required: ["provider", "account_profile_id", "model", "role", "policy_profile_id"], not: { required: ["route_id"] } },
        ],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "agent_workspace_snapshot",
      description: "Capture a registered workspace's source into LOCAL broker snapshot storage under a read admission (no writer, no quarantine). Reads project files and stores them locally; launches no provider run and sends nothing to any vendor. Idempotent (§10.1.1).",
      inputSchema: {
        type: "object",
        properties: { project_id: str, workspace_id: str, idempotency_key: str },
        required: ["project_id", "workspace_id", "idempotency_key"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "agent_sessions_list",
      description: "Sessions owned by this coordinator in a project, compact metadata (§10.1).",
      inputSchema: {
        type: "object",
        properties: { project_id: str, cursor: str, limit: int(1, 100) },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_status",
      description: "Session/context/runtime states, active turn, snapshots, block/close state, coverage binding, and effective_policy {access, write_scope} from the immutable spawn-time policy binding (§10.1). effective_policy is null when the binding is absent or malformed. Check it after spawn; task instructions do not determine policy.",
      inputSchema: { type: "object", properties: { session_id: str }, required: ["session_id"], additionalProperties: false },
    },
    {
      name: "agent_session_send",
      description: "Submit a task turn and LAUNCH one provider inference run; returns turn_id without waiting. Supply exactly one binding: workspace_precondition for workers, review_binding for snapshot review_slot turns, or git_review_binding for read-only Git review in current/worktree (include_working_tree=true for uncommitted changes). Never combine bindings (§7.2).",
      inputSchema: {
        type: "object",
        properties: {
          session_id: str, idempotency_key: str, deadline_ms: int(1000, 86400000), retry_of_turn_id: str,
          task: {
            type: "object",
            properties: {
              goal: str,
              acceptance_criteria: { type: "array", items: str },
              relevant_paths: { type: "array", items: str },
              context: str,
              artifact_refs: { type: "array", items: str },
              checks: { type: "array", items: str },
            },
            required: ["goal", "artifact_refs"],
            additionalProperties: false,
          },
          workspace_precondition: {
            type: "object",
            description: "Physical worker workspace only. Omit when supplying another binding.",
            properties: { expected_snapshot_id: str },
            required: ["expected_snapshot_id"],
            additionalProperties: false,
          },
          review_binding: {
            type: "object",
            description: "Snapshot review_slot turns only. Explicit dirty-workspace alternative to Git review.",
            properties: { baseline_snapshot_id: str, target_snapshot_id: str },
            required: ["baseline_snapshot_id", "target_snapshot_id"],
            additionalProperties: false,
          },
          git_review_binding: {
            type: "object",
            description: "Read-only Git reviewer turns only: full-hex base_commit and target_commit. By default requires a clean checkout; include_working_tree=true binds an uncommitted checkout digest. The broker delivers no snapshots or diff bytes.",
            properties: { base_commit: str, target_commit: str, include_working_tree: { type: "boolean" } },
            required: ["base_commit", "target_commit"],
            additionalProperties: false,
          },
        },
        required: ["session_id", "idempotency_key", "task"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    {
      name: "agent_turn_status",
      description: "Turn state/version, deadline, execution flags (§10.1).",
      inputSchema: { type: "object", properties: { turn_id: str }, required: ["turn_id"], additionalProperties: false },
    },
    {
      name: "agent_turn_result",
      description: "Bounded result manifest or RESULT_NOT_READY for nonterminal turns; honest evidence attribution (§11).",
      inputSchema: { type: "object", properties: { turn_id: str }, required: ["turn_id"], additionalProperties: false },
    },
    {
      name: "agent_turn_events",
      description: "Durable bounded event page with monotonic cursor (§10.5). wait_ms waits for new events, terminal state, or timeout.",
      inputSchema: {
        type: "object",
        properties: { turn_id: str, after_cursor: int(0, Number.MAX_SAFE_INTEGER), limit: int(1, 200), wait_ms: int(0, 20000) },
        required: ["turn_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_artifact_read",
      description: "Authorized bounded page of a textual artifact; binary artifacts return metadata only (§10.1).",
      inputSchema: {
        type: "object",
        properties: { artifact_id: str, offset: int(0, Number.MAX_SAFE_INTEGER), max_bytes: int(1, 65536) },
        required: ["artifact_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_turn_cancel",
      description: "Idempotent cancellation request; a terminal result is returned unchanged (§14.6).",
      inputSchema: {
        type: "object",
        properties: { turn_id: str, idempotency_key: str, reason: str },
        required: ["turn_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_stop",
      description: "Guarded close of an IDLE/BLOCKED session; native history and worktree are not deleted (§6.4).",
      inputSchema: {
        type: "object",
        properties: { session_id: str, idempotency_key: str },
        required: ["session_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
  ];
}

// ─── DTO shapers ────────────────────────────────────────────────────────────

function sessionDto(s: SessionRecord) {
  return {
    session_id: s.session_id,
    project_id: s.project_id,
    provider: s.provider,
    model: s.requested_model,
    role: s.role,
    workspace_id: s.workspace_id,
    workspace_mode: s.workspace_mode,
    state: s.state,
    context_status: s.context_status,
    native_conversation_ref: s.native_conversation_ref,
    active_turn_id: s.active_turn_id,
    block_reason: s.block_reason,
    close_state: s.close_state,
    initial_snapshot_id: s.initial_snapshot_id,
    latest_snapshot_id: s.latest_snapshot_id,
    coverage_profile_id: s.coverage_profile_id,
    policy_profile_id: s.policy_profile_id,
    // Additive binding metadata: the REGISTERED auth mode stays distinct from
    // observed readiness, cli_version is only ever an OBSERVED value, and
    // effective model/effort stay null until native execution evidence.
    auth_mode: s.auth_mode,
    cli_version: s.cli_version,
    effective_model: s.effective_model,
    effective_effort: s.effective_effort,
    created_at: s.created_at,
    updated_at: s.updated_at,
  };
}

function turnDto(t: TurnRecord) {
  return {
    turn_id: t.turn_id,
    session_id: t.session_id,
    state: t.state,
    state_version: t.state_version,
    execution_started: t.execution_started,
    native_outcome: t.native_outcome,
    termination_reason: t.termination_reason,
    error_code: t.error_code,
    deadline_at: t.deadline_at,
    input_manifest_id: t.input_manifest_id,
    baseline_snapshot_id: t.baseline_snapshot_id,
    review_target_snapshot_id: t.review_target_snapshot_id,
    git_base_commit: t.git_base_commit,
    git_target_commit: t.git_target_commit,
    git_working_tree_digest: t.git_working_tree_digest,
    final_snapshot_id: t.final_snapshot_id,
    continuation: t.continuation,
    created_at: t.created_at,
    terminal_at: t.terminal_at,
  };
}

const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ABANDONED"]);

function turnResultDto(core: BrokerCore, coordinatorId: string, turn: TurnRecord) {
  if (!TERMINAL_STATES.has(turn.state)) {
    throw new BrokerError("RESULT_NOT_READY", `Turn is ${turn.state}; not terminal yet.`, {
      details: { turn_id: turn.turn_id, state: turn.state },
    });
  }
  const session = core.sessionStatus(coordinatorId, turn.session_id);
  const agentReported = core.turnAgentReported(coordinatorId, turn.turn_id);
  const truncated = agentReported?.truncated === true;
  const fullMessageArtifactId =
    typeof agentReported?.full_message_artifact_id === "string"
      ? agentReported.full_message_artifact_id
      : null;
  const reportMeta = core.turnReportArtifact(coordinatorId, turn.turn_id);
  const artifacts: Array<{ artifact_id: string; kind: string }> = [];
  if (fullMessageArtifactId) {
    artifacts.push({
      artifact_id: fullMessageArtifactId,
      kind: reportMeta?.kind ?? (session.role === "reviewer" ? "findings" : "report"),
    });
  }
  return {
    api_version: "0.2",
    session_id: turn.session_id,
    turn_id: turn.turn_id,
    execution_status: turn.state,
    quality_status: "unreviewed",
    context: {
      continuation: turn.continuation,
      native_conversation_ref: session.native_conversation_ref,
      status: session.context_status,
    },
    agent_reported: agentReported,
    summary_truncated: truncated,
    full_message_artifact_id: fullMessageArtifactId,
    broker_observed: {
      native_outcome: turn.native_outcome,
      termination_reason: turn.termination_reason,
      finalization_error: turn.finalization_error,
      execution_started: turn.execution_started,
      input_manifest_id: turn.input_manifest_id,
      baseline_snapshot_id: turn.baseline_snapshot_id,
      review_target_snapshot_id: turn.review_target_snapshot_id,
      git_base_commit: turn.git_base_commit,
      git_target_commit: turn.git_target_commit,
      git_working_tree_digest: turn.git_working_tree_digest,
      final_snapshot_id: turn.final_snapshot_id,
      error_code: turn.error_code,
    },
    usage: { availability: "unknown", billing_basis: "unknown", measurements: [] },
    artifacts,
    warnings: [],
  };
}

// ─── dispatcher ─────────────────────────────────────────────────────────────

export async function callBridgeTool(ctx: BridgeContext, name: string, rawArgs: Record<string, unknown>): Promise<unknown> {
  const core = ctx.core;
  switch (name) {
    case "broker_status": {
      rejectUnknownKeys(rawArgs, ["limit"]);
      return core.statusOverview(ctx.coordinatorId, {
        limit: optionalInt(rawArgs, "limit", 1, 100) ?? 50,
        daemonState: ctx.daemonState,
        incarnation: ctx.incarnation,
      });
    }
    case "agents_list": {
      rejectUnknownKeys(rawArgs, ["project_id", "cursor", "limit"]);
      return core.discovery(
        ctx.coordinatorId,
        requireString(rawArgs, "project_id"),
        optionalString(rawArgs, "cursor") ?? null,
        optionalInt(rawArgs, "limit", 1, 100) ?? 50,
      );
    }
    case "agent_session_spawn": {
      rejectUnknownKeys(rawArgs, [
        "project_id", "idempotency_key", "route_id", "provider", "account_profile_id", "model", "effort",
        "role", "instructions", "workspace", "policy_profile_id", "policy_restrictions",
      ]);
      const rawRole = optionalString(rawArgs, "role");
      if (rawRole !== undefined && rawRole !== "worker" && rawRole !== "reviewer" && rawRole !== "researcher") {
        throw new BrokerError("INVALID_REQUEST", "role must be worker|reviewer|researcher.");
      }
      const workspace = rawArgs.workspace as Record<string, unknown> | undefined;
      if (!workspace || (workspace.mode !== "current" && workspace.mode !== "worktree" && workspace.mode !== "review_slot")) {
        throw new BrokerError("INVALID_REQUEST", "workspace.mode must be current|worktree|review_slot.");
      }
      // §8.3 additive workspace fields: type-checked here, business rules
      // (contradictions, registration, commit existence) stay in the core.
      rejectUnknownKeys(workspace, ["mode", "workspace_id", "repository_workspace_id", "base_commit"]);
      const repositoryWorkspaceId = optionalString(workspace, "repository_workspace_id");
      const baseCommit = optionalString(workspace, "base_commit");
      const routeId = optionalString(rawArgs, "route_id");
      const provider = optionalString(rawArgs, "provider");
      const accountProfileId = optionalString(rawArgs, "account_profile_id");
      const model = optionalString(rawArgs, "model");
      const effort = optionalString(rawArgs, "effort");
      const policyProfileId = optionalString(rawArgs, "policy_profile_id");
      return core.spawn(ctx.coordinatorId, {
        project_id: requireString(rawArgs, "project_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
        instructions: requireString(rawArgs, "instructions"),
        workspace: {
          mode: workspace.mode,
          workspace_id: typeof workspace.workspace_id === "string" ? workspace.workspace_id : null,
          ...(repositoryWorkspaceId !== undefined ? { repository_workspace_id: repositoryWorkspaceId } : {}),
          ...(baseCommit !== undefined ? { base_commit: baseCommit } : {}),
        },
        ...(routeId !== undefined ? { route_id: routeId } : {}),
        ...(provider !== undefined ? { provider } : {}),
        ...(accountProfileId !== undefined ? { account_profile_id: accountProfileId } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(rawRole !== undefined ? { role: rawRole } : {}),
        ...(policyProfileId !== undefined ? { policy_profile_id: policyProfileId } : {}),
        ...(rawArgs.policy_restrictions !== undefined
          ? { policy_restrictions: rawArgs.policy_restrictions as Record<string, unknown> }
          : {}),
      });
    }
    case "agent_workspace_snapshot": {
      rejectUnknownKeys(rawArgs, ["project_id", "workspace_id", "idempotency_key"]);
      return core.snapshot(ctx.coordinatorId, {
        project_id: requireString(rawArgs, "project_id"),
        workspace_id: requireString(rawArgs, "workspace_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
      });
    }
    case "agent_sessions_list": {
      rejectUnknownKeys(rawArgs, ["project_id", "cursor", "limit"]);
      const sessions = core.sessionsList(ctx.coordinatorId, requireString(rawArgs, "project_id"));
      const limit = optionalInt(rawArgs, "limit", 1, 100) ?? 50;
      const cursor = rawArgs.cursor !== undefined ? Number(requireString(rawArgs, "cursor")) || 0 : 0;
      const page = sessions.slice(cursor, cursor + limit).map(sessionDto);
      return {
        sessions: page,
        next_cursor: cursor + limit < sessions.length ? String(cursor + limit) : null,
      };
    }
    case "agent_session_status": {
      rejectUnknownKeys(rawArgs, ["session_id"]);
      const session = core.sessionStatus(ctx.coordinatorId, requireString(rawArgs, "session_id"));
      // Additive binding/readiness metadata (§10.1): durable provider binding
      // and observed readiness evidence — no credentials, unknown stays null.
      return {
        ...sessionDto(session),
        effective_policy: core.sessionEffectivePolicy(ctx.coordinatorId, session.session_id),
        provider_binding: core.sessionProviderBinding(ctx.coordinatorId, session.session_id),
      };
    }
    case "agent_session_send": {
      rejectUnknownKeys(rawArgs, [
        "session_id", "idempotency_key", "task", "workspace_precondition", "review_binding",
        "git_review_binding", "deadline_ms", "retry_of_turn_id",
      ]);
      const task = rawArgs.task as Record<string, unknown> | undefined;
      if (!task) throw new BrokerError("INVALID_REQUEST", "Argument 'task' is required.");
      if (!Array.isArray(task.artifact_refs)) {
        throw new BrokerError("INVALID_REQUEST", "task.artifact_refs must be an array.");
      }
      const bindingNames = ["workspace_precondition", "review_binding", "git_review_binding"] as const;
      const presentBindings = bindingNames.filter((name) => rawArgs[name] !== undefined);
      if (presentBindings.length !== 1) {
        throw new BrokerError("INVALID_REQUEST", "Exactly one of workspace_precondition / review_binding / git_review_binding is required. Physical worker turns send workspace_precondition only; review_slot turns send review_binding only; Git reviewer turns send git_review_binding only.");
      }
      const bindingName = presentBindings[0]!;
      const binding = rawArgs[bindingName];
      if (binding === null || typeof binding !== "object" || Array.isArray(binding)) {
        throw new BrokerError("INVALID_REQUEST", `${bindingName} must be an object.`);
      }
      const bindingRecord = binding as Record<string, unknown>;
      rejectUnknownKeys(bindingRecord, bindingName === "git_review_binding"
        ? ["base_commit", "target_commit", "include_working_tree"]
        : bindingName === "review_binding"
          ? ["baseline_snapshot_id", "target_snapshot_id"]
          : ["expected_snapshot_id"]);
      if (bindingName === "git_review_binding" && bindingRecord.include_working_tree !== undefined && typeof bindingRecord.include_working_tree !== "boolean") {
        throw new BrokerError("INVALID_REQUEST", "Argument 'include_working_tree' must be a boolean.");
      }
      const requireBindingString = (name: string): string => requireString(binding as Record<string, unknown>, name);
      return core.send(ctx.coordinatorId, {
        session_id: requireString(rawArgs, "session_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
        task: {
          goal: requireString(task, "goal"),
          acceptance_criteria: optionalStringArray(task, "acceptance_criteria"),
          relevant_paths: optionalStringArray(task, "relevant_paths"),
          context: optionalString(task, "context"),
          artifact_refs: task.artifact_refs as string[],
          checks: optionalStringArray(task, "checks"),
        },
        ...(bindingName === "workspace_precondition"
          ? { workspace_precondition: { expected_snapshot_id: requireBindingString("expected_snapshot_id") } }
          : bindingName === "review_binding"
            ? {
                review_binding: {
                  baseline_snapshot_id: requireBindingString("baseline_snapshot_id"),
                  target_snapshot_id: requireBindingString("target_snapshot_id"),
                },
              }
            : {
                git_review_binding: {
                  base_commit: requireBindingString("base_commit"),
                  target_commit: requireBindingString("target_commit"),
                  ...(typeof (binding as Record<string, unknown>).include_working_tree === "boolean"
                    ? { include_working_tree: (binding as Record<string, unknown>).include_working_tree as boolean }
                    : {}),
                },
              }),
        ...(optionalInt(rawArgs, "deadline_ms", 1000, 86_400_000) !== undefined
          ? { deadline_ms: optionalInt(rawArgs, "deadline_ms", 1000, 86_400_000) }
          : {}),
        ...(optionalString(rawArgs, "retry_of_turn_id") !== undefined
          ? { retry_of_turn_id: optionalString(rawArgs, "retry_of_turn_id") }
          : {}),
      } as Parameters<BrokerCore["send"]>[1]);
    }
    case "agent_turn_status": {
      rejectUnknownKeys(rawArgs, ["turn_id"]);
      return turnDto(core.turnStatus(ctx.coordinatorId, requireString(rawArgs, "turn_id")));
    }
    case "agent_turn_result": {
      rejectUnknownKeys(rawArgs, ["turn_id"]);
      const turn = core.turnStatus(ctx.coordinatorId, requireString(rawArgs, "turn_id"));
      return turnResultDto(core, ctx.coordinatorId, turn);
    }
    case "agent_turn_events": {
      rejectUnknownKeys(rawArgs, ["turn_id", "after_cursor", "limit", "wait_ms"]);
      const limit = optionalInt(rawArgs, "limit", 1, 200) ?? 50;
      const after = optionalInt(rawArgs, "after_cursor", 0, Number.MAX_SAFE_INTEGER) ?? 0;
      const waitMs = optionalInt(rawArgs, "wait_ms", 0, 20_000) ?? 0;
      const rows = await core.waitForTurnEvents(
        ctx.coordinatorId,
        requireString(rawArgs, "turn_id"),
        after,
        limit,
        waitMs,
        ctx.signal,
      );
      return {
        events: rows.map((e) => ({
          cursor: e.seq,
          type: e.type,
          payload: e.payload === null ? null : JSON.parse(e.payload),
          created_at: e.created_at,
        })),
        next_cursor: rows.length === limit ? String(rows[rows.length - 1]!.seq) : null,
      };
    }
    case "agent_artifact_read": {
      rejectUnknownKeys(rawArgs, ["artifact_id", "offset", "max_bytes"]);
      const offset = optionalInt(rawArgs, "offset", 0, Number.MAX_SAFE_INTEGER);
      const maxBytes = optionalInt(rawArgs, "max_bytes", 1, 65536);
      return core.artifactRead(ctx.coordinatorId, requireString(rawArgs, "artifact_id"), {
        ...(offset !== undefined ? { offset } : {}),
        ...(maxBytes !== undefined ? { max_bytes: maxBytes } : {}),
      });
    }
    case "agent_turn_cancel": {
      rejectUnknownKeys(rawArgs, ["turn_id", "idempotency_key", "reason"]);
      return core.cancel(ctx.coordinatorId, {
        turn_id: requireString(rawArgs, "turn_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
        ...(optionalString(rawArgs, "reason") !== undefined ? { reason: optionalString(rawArgs, "reason") } : {}),
      });
    }
    case "agent_session_stop": {
      rejectUnknownKeys(rawArgs, ["session_id", "idempotency_key"]);
      return core.stop(ctx.coordinatorId, {
        session_id: requireString(rawArgs, "session_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
      });
    }
    default:
      throw new BrokerError("INVALID_REQUEST", `Unknown tool '${name}'.`);
  }
}
