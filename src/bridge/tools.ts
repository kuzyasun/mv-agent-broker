/**
 * MCP tool registry — the 13 advertised tools of API 0.2 (spec §10.1).
 *
 * The bridge is presentation + bounded RPC only (§4.1): every tool maps to
 * one BrokerCore call, validates its arguments (additionalProperties=false)
 * and shapes the response DTO. Business decisions never live here.
 */
import { requiredSendBinding, type BrokerCore } from "../core/broker.ts";
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
      description: "Check broker and bridge readiness first. Require daemon_state=READY before discovery or work; returns API/resource state and allowed project IDs, without credentials (§10.1.2).",
      inputSchema: { type: "object", properties: { limit: int(1, 100) }, additionalProperties: false },
    },
    {
      name: "agents_list",
      description: "Discover enabled profiles and healthy workspaces for one project; follow every next_cursor. Choose an exact route_id and compatible_workspace_id. Profile access is read-only or write all project. Multiple agents may run in separate checkouts, subject to concurrency and shared provider quotas.",
      inputSchema: {
        type: "object",
        properties: { project_id: str, cursor: str, limit: int(1, 100) },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_spawn",
      description: "Create a reusable session without inference. Select the discovered project, route and current/worktree workspace; access=read_only can narrow a write profile for an audit. Omit access to use the profile setting. Reviewers and researchers inspect the same checkout using files and Git. No snapshot is needed. Use separate worktrees for parallel writers. A session can be closed and recreated on the same route when needed.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: str, idempotency_key: str,
          route_id: { ...str, description: "Configured route from agents_list. Omit provider, account_profile_id, model, effort, role and policy_profile_id when using this field." },
          provider: { ...str, description: "Raw binding only, without route_id. Requires account_profile_id, model, role and policy_profile_id." }, account_profile_id: str,
          model: str, effort: str, role: { type: "string", enum: ["worker", "reviewer", "researcher"] },
          instructions: str,
          workspace: {
            type: "object",
            properties: {
              mode: { type: "string", enum: ["current", "worktree", "review_slot"], description: "current/worktree bind a registered physical workspace; review_slot selects snapshot review." },
              workspace_id: { ...str, description: "Currently selectable workspace ID from discovery; choose from the route's compatible_workspace_ids for its default policy. Historical session workspace IDs are not necessarily selectable." },
              // §8.3 additive: registered source repository reference and the
              // explicit full-hex base commit for a broker-created worktree.
              repository_workspace_id: { ...str, description: "Registered source repository ID used to create a detached worktree." },
              base_commit: { ...str, description: "Full hexadecimal Git commit ID to use as the detached worktree base." },
            },
            required: ["mode"],
            additionalProperties: false,
          },
          policy_profile_id: str,
          access: { type: "string", enum: ["read_only", "workspace_write"], description: "Omit for profile access; read_only narrows a write profile. No file allowlists." },
        },
        required: ["project_id", "idempotency_key", "instructions", "workspace"],
        // Keep fields visible to MCP clients that flatten root unions into opaque
        // argument maps. BrokerCore validates route/raw exclusivity and required
        // binding fields before accepting a session.
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: "agent_workspace_snapshot",
      description: "Optional manual local snapshot for diagnostics or explicit review_slot snapshot comparison. Reads files into local broker storage; launches no inference. Ordinary current/worktree tasks and Git reviews do not need snapshots. Snapshot IDs are not artifact IDs.",
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
      description: "List this coordinator's sessions for one project, including role, workspace and required_send_binding metadata. Follow every next_cursor; inspect status for full state and effective_policy before continuing (§10.1).",
      inputSchema: {
        type: "object",
        properties: { project_id: str, cursor: str, limit: int(1, 100) },
        required: ["project_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_status",
      description: "Inspect state, active turn and captured profile access. required_send_binding=none for ordinary current/worktree sessions; only an explicit snapshot review_slot requires review_binding. CLI or catalogue updates do not invalidate the session.",
      inputSchema: { type: "object", properties: { session_id: str }, required: ["session_id"], additionalProperties: false },
    },
    {
      name: "agent_session_send",
      description: "Run a task in the session checkout. For current/worktree, send only session_id, idempotency_key and task with a goal; no snapshot or review binding. Review instructions can name Git commits or uncommitted changes. relevant_paths are guidance, not permissions. artifact_refs is optional and accepts only art IDs. Only explicit review_slot requires baseline/target review_binding. Returns turn_id; wait for terminal events then read the result. If a response is unknown, inspect the same turn and reuse the original key before creating another paid run.",
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
              artifact_refs: { type: "array", items: str, description: "Optional artifact IDs from this project (art-...). Omit when none; file paths belong in relevant_paths." },
              checks: { type: "array", items: str },
            },
            required: ["goal"],
            additionalProperties: false,
          },
          review_binding: {
            type: "object",
            description: "Required only for an explicit manual snapshot review_slot; omit for current/worktree.",
            properties: {
              baseline_snapshot_id: { ...str, description: "Baseline broker snapshot ID (snap-...)." },
              target_snapshot_id: { ...str, description: "Target broker snapshot ID (snap-...)." },
            },
            required: ["baseline_snapshot_id", "target_snapshot_id"],
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
      description: "Check turn state, deadline and execution_started after a send; inspect the known turn before any recovery or retry (§10.1).",
      inputSchema: { type: "object", properties: { turn_id: str }, required: ["turn_id"], additionalProperties: false },
    },
    {
      name: "agent_turn_result",
      description: "Read the terminal execution result and retained report after events/status show a terminal turn. SUCCEEDED means the native run completed; quality_status=unreviewed means the coordinator still decides whether to accept the work. No automatic workspace snapshot or file-change attribution is performed.",
      inputSchema: { type: "object", properties: { turn_id: str }, required: ["turn_id"], additionalProperties: false },
    },
    {
      name: "agent_turn_events",
      description: "Read bounded event deltas after the last consumed numeric cursor; use wait_ms for one bounded wait, advance the cursor from returned rows, and repeat until terminal before reading the result (§10.5).",
      inputSchema: {
        type: "object",
        properties: { turn_id: str, after_cursor: int(0, Number.MAX_SAFE_INTEGER), limit: int(1, 200), wait_ms: int(0, 20000) },
        required: ["turn_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_artifact_read",
      description: "Read an authorized bounded page of a retained textual artifact by art ID; follow returned offsets for more text. Binary artifacts return metadata only (§10.1).",
      inputSchema: {
        type: "object",
        properties: { artifact_id: str, offset: int(0, Number.MAX_SAFE_INTEGER), max_bytes: int(1, 65536) },
        required: ["artifact_id"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_turn_cancel",
      description: "Request cancellation of a known turn that should stop executing; this does not close its session. Idempotent; terminal turns are returned unchanged. Inspect status/events/result afterward, and resolve unknown outcomes using the same turn and key (§14.6).",
      inputSchema: {
        type: "object",
        properties: { turn_id: str, idempotency_key: str, reason: str },
        required: ["turn_id", "idempotency_key"],
        additionalProperties: false,
      },
    },
    {
      name: "agent_session_stop",
      description: "Close an idle or blocked session when no more turns should use it; this is session lifecycle cleanup, not turn cancellation, and preserves native history/worktree. Use agent_turn_cancel for active execution (§6.4).",
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
    required_send_binding: requiredSendBinding(s),
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
        "role", "instructions", "workspace", "policy_profile_id", "access",
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
        ...(rawArgs.access !== undefined ? { access: requireString(rawArgs, "access") as "read_only" | "workspace_write" } : {}),
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
      rejectUnknownKeys(rawArgs, ["session_id", "idempotency_key", "task", "review_binding", "deadline_ms", "retry_of_turn_id"]);
      const task = rawArgs.task as Record<string, unknown> | undefined;
      if (!task || typeof task !== "object" || Array.isArray(task)) throw new BrokerError("INVALID_REQUEST", "Argument 'task' must be an object.");
      rejectUnknownKeys(task, ["goal", "acceptance_criteria", "relevant_paths", "context", "artifact_refs", "checks"]);
      let reviewBinding: { baseline_snapshot_id: string; target_snapshot_id: string } | undefined;
      if (rawArgs.review_binding !== undefined) {
        const binding = rawArgs.review_binding;
        if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new BrokerError("INVALID_REQUEST", "review_binding must be an object.");
        const record = binding as Record<string, unknown>;
        rejectUnknownKeys(record, ["baseline_snapshot_id", "target_snapshot_id"]);
        reviewBinding = { baseline_snapshot_id: requireString(record, "baseline_snapshot_id"), target_snapshot_id: requireString(record, "target_snapshot_id") };
      }
      return core.send(ctx.coordinatorId, {
        session_id: requireString(rawArgs, "session_id"),
        idempotency_key: requireString(rawArgs, "idempotency_key"),
        task: {
          goal: requireString(task, "goal"),
          acceptance_criteria: optionalStringArray(task, "acceptance_criteria"),
          relevant_paths: optionalStringArray(task, "relevant_paths"),
          context: optionalString(task, "context"),
          artifact_refs: optionalStringArray(task, "artifact_refs") ?? [],
          checks: optionalStringArray(task, "checks"),
        },
        ...(reviewBinding ? { review_binding: reviewBinding } : {}),
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
