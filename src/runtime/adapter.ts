/**
 * Provider adapter contract (spec §13.2).
 *
 * The core knows nothing about vendor flags or output schemas. The adapter
 * executes exactly one broker turn per call, must obtain explicit dispatch
 * permission before handing the task to native execution, and must surface
 * the native conversation reference as soon as it is known (§13.2, §14.3).
 */
import type { AgentRole, WorkspaceMode } from "../shared/api-types.ts";
import type { Clock } from "../shared/clock.ts";
import { BrokerError } from "../shared/errors.ts";
import type { EffectiveWritePolicy } from "../core/policy.ts";

export interface AdapterEvent {
  type: string;
  payload?: Record<string, unknown>;
}

/**
 * Optional Windows managed-execution events adapters may forward via onEvent
 * (no global observers): owned_launch (pre-resume ownership bind),
 * owned_resumed, owned_root_exit, owned_quiescence, owned_unproven,
 * owned_zero_resume (journaled proof correcting the earlier permission phase).
 * Core persists owned_launch into launch_turn intent + runtime_id before ACK.
 */

export type NativeOutcome = "completed" | "failed";

/** Character bound for the compact public/agent_reported summary (not full prose). */
export const AGENT_SUMMARY_CHAR_LIMIT = 4000;

/**
 * UTF-8 byte bound for the full declared native final sealed as a report/
 * findings artifact (default 8 MiB). Oversized finals are rejected BEFORE any
 * blob allocation; the known native outcome is preserved separately.
 */
export const DEFAULT_MAX_REPORT_BYTES = 8 * 1024 * 1024;

/** Bounded provenance/concern metadata carried in schema-only event payloads. */
export const AGENT_PROVENANCE_CHAR_LIMIT = 1024;
export const AGENT_CONCERN_CHAR_LIMIT = 1024;
export const AGENT_LIST_METADATA_LIMIT = 32;

export interface AgentReportedResult {
  summary: string;
  format_status: "structured" | "text_only";
  claimed_checks?: unknown[];
  concerns?: string[];
  /**
   * Full bounded permitted provider response for artifact sealing.
   * Never persisted as event prose — core strips this before journaling.
   */
  full_text?: string;
  /** True when summary was truncated from the observed full text length. */
  truncated?: boolean;
  /**
   * Honest provenance when the native final is a partial projection / wrapper
   * (e.g. Antigravity task wrappers). Never reinterpreted as test proof.
   */
  provenance?: string;
}

/** Build a bounded summary + optional full_text from the declared native final. */
export function boundAgentReport(
  fullText: string,
  opts: {
    format_status?: "structured" | "text_only";
    provenance?: string;
    claimed_checks?: unknown[];
    concerns?: string[];
  } = {},
): AgentReportedResult {
  const truncated = fullText.length > AGENT_SUMMARY_CHAR_LIMIT;
  const summary = truncated ? fullText.slice(0, AGENT_SUMMARY_CHAR_LIMIT) : fullText;
  return {
    summary,
    format_status: opts.format_status ?? "text_only",
    // Omit additive fields when unused so short declared finals keep prior DTO shape.
    ...(truncated ? { truncated: true, full_text: fullText } : {}),
    ...(opts.provenance !== undefined ? { provenance: opts.provenance } : {}),
    ...(opts.claimed_checks !== undefined ? { claimed_checks: opts.claimed_checks } : {}),
    ...(opts.concerns !== undefined ? { concerns: opts.concerns } : {}),
  };
}

/**
 * Fixed operational labels only; provider-supplied tokens are never prose.
 */
export function isAllowedProgressLabel(label: unknown): label is string {
  return typeof label === "string" &&
    /^(?:resumed|json-run-complete|status:(?:assistant_text|text_delta|result|message|running)|tool_call(?::(?:started|completed|read|Read|grep|glob|ls|shell|mcp|edit|write|delete|task|web_search|web_fetch|unknown))?)$/.test(label);
}

/**
 * Adapter events are persisted only for the project's known event schema.
 * Returns a sanitized {type, payload} with exactly the schema keys for the
 * event type, or null when the event must be discarded before persistence
 * (thinking/reasoning, unknown types, unparseable payloads). Owned Windows
 * control receipts pass through unchanged — core re-validates them strictly.
 */
export function sanitizeAdapterEvent(
  ev: { type: string; payload?: Record<string, unknown> },
): { type: string; payload: Record<string, unknown> } | null {
  const type = ev.type;
  if (type === "thinking" || type === "reasoning") return null;
  const payload = ev.payload ?? {};

  const boundedString = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
  const receipt = (): Record<string, unknown> => {
    const tools = ["read", "grep", "glob", "ls", "shell", "mcp", "edit", "write", "delete", "task", "web_search", "web_fetch", "unknown"];
    const statuses = ["permissionDenied", "rejected", "error", "success", "unknown", "oversized_input", "invalid_utf8",
      "empty_input", "input_read_failed", "malformed_json", "policy_unreadable", "invalid_policy", "tool_not_allowed",
      "unknown_inputshape", "missing_path", "invalid_path_type", "path_resolution_failed", "symlink_rejected",
      "invalid_file_type", "forbidden_store_access", "boundary_violation"];
    const out: Record<string, unknown> = {};
    for (const [key, allowed] of [["toolkind", tools], ["status", statuses], ["decision", ["allow", "deny", "error", "unknown"]]] as const) {
      if (key in payload) out[key] = typeof payload[key] === "string" && (allowed as readonly string[]).includes(payload[key] as string) ? payload[key] : "unknown";
    }
    for (const key of ["pathhash", "callid"] as const) {
      if (!(key in payload)) continue;
      const value = payload[key];
      out[key] = value === null ? null : typeof value === "string" && /^(?:[0-9a-f]{32}|[0-9a-f]{64}|unknown)$/.test(value) ? value : "unknown";
    }
    return out;
  };

  switch (type) {
    case "progress": {
      if (!isAllowedProgressLabel(payload.label)) return null;
      return { type, payload: { label: payload.label } };
    }
    case "native_ref_obtained": {
      const ref = boundedString(payload.ref, 512);
      return ref === null ? null : { type, payload: { ref } };
    }
    case "barrier": {
      const name = boundedString(payload.name, 128);
      return name === null ? null : { type, payload: { name } };
    }
    case "tool_receipt":
    case "denial": {
      const out = receipt();
      if (type === "denial") {
        if (payload.source === "native" || payload.source === "hook") out.source = payload.source;
      }
      return Object.keys(out).length > 0 ? { type, payload: out } : null;
    }
    case "hook_audit": {
      const out = receipt();
      const ts = payload.timestamp_ms;
      if (typeof ts === "number" && Number.isSafeInteger(ts) && ts >= 0) out.timestamp_ms = ts;
      if (payload.source === "native" || payload.source === "hook") out.source = payload.source;
      return Object.keys(out).length > 0 ? { type, payload: out } : null;
    }
    case "owned_launch":
    case "owned_resumed":
    case "owned_root_exit":
    case "owned_quiescence":
    case "owned_unproven":
    case "owned_zero_resume":
    case "owned_output_limit": {
      const out: Record<string, unknown> = Object.fromEntries(Object.entries(payload).filter(([key, value]) =>
        ["launch_uuid", "named_job", "root_pid", "root_creation_time", "helper_pid", "owner_pid", "owner_creation_time",
         "op", "exit_code", "root_exit_code", "active", "drained", "reason", "quiesced", "resumed", "killed"].includes(key) &&
        (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value) ||
         typeof value === "string" && value.length <= 256)));
      if (type === "owned_zero_resume" && "ownership" in payload) {
        const raw = payload.ownership;
        out.ownership = raw === null ? null :
          typeof raw === "object" && raw !== null && !Array.isArray(raw)
            ? Object.fromEntries(Object.entries(raw).filter(([key, value]) =>
                ["launch_uuid", "named_job", "root_pid", "root_creation_time", "helper_pid", "owner_pid", "owner_creation_time"].includes(key) &&
                (typeof value === "number" && Number.isFinite(value) || typeof value === "string" && value.length <= 256)))
            : {};
      }
      return { type, payload: out };
    }
    default:
      // Unknown adapter event types are never persisted.
      return null;
  }
}

export interface TurnExecutionResult {
  native_outcome: NativeOutcome;
  /** Empty string = the provider exposes no session identity (print-first CLIs): the broker records NO native conversation and never claims native_resume. */
  native_conversation_ref: string;
  agent_reported?: AgentReportedResult;
  malformed?: boolean;
}

export interface TurnExecutionRequest {
  turn_id: string;
  session_id: string;
  role: AgentRole;
  provider: string;
  account_profile_id: string;
  requested_model: string;
  requested_effort: string | null;
  instructions_hash: string;
  /** null → create a new native conversation; non-null → explicit resume. */
  native_conversation_ref: string | null;
  /** Full bounded context envelope text (P1: mock; P2+: real envelope). */
  task_envelope: string;
  workspace_mode: WorkspaceMode;
  workspace_path: string | null;
  deadline_at: number;
  clock: Clock;
  /**
   * §12.1 durable immutable effective write policy bound at spawn and
   * revalidated before dispatch. The core ALWAYS supplies a validated,
   * defensively frozen binding; direct adapter callers/tests may omit it.
   */
  effective_policy?: EffectiveWritePolicy;
  /**
   * §7.1.1 read-only input locations, copied from the sealed TurnInputManifest:
   * exact broker-generated materialized bindings only — never paths derived
   * from goal/artifact text. Frozen; adapters must not treat them as writable.
   */
  read_only_input_paths?: readonly string[];
}

/**
 * Broker-supplied preflight context (§13.2): everything an adapter needs to
 * decide readiness WITHOUT any inference — request shape, registered account
 * binding, and the session's immutable effective write policy. The broker
 * passes this as the `preflight(config)` record; the type alias (not an
 * interface) keeps it assignable to the `Record<string, unknown>` signature
 * that existing adapters implement.
 */
export type AdapterPreflightContext = {
  provider: string;
  model: string;
  effort: string | null;
  role: AgentRole;
  workspace_mode: WorkspaceMode;
  account: {
    account_profile_id: string;
    auth_mode: string;
    quota_scope_id: string;
  };
  effective_policy: EffectiveWritePolicy;
};

/**
 * Defensive copy of an effective write policy with frozen arrays/objects:
 * adapters receive the durable grant's content but cannot mutate it (the
 * spawn-time binding and the gate's fresh DB reads stay authoritative).
 */
export function cloneFrozenPolicy(policy: EffectiveWritePolicy): EffectiveWritePolicy {
  const clone = structuredClone(policy);
  const freeze = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(clone);
  return clone;
}

/**
 * Serialization point between dispatch permission and cancellation intent
 * (§14.6). The adapter MUST call `acquireDispatchPermission()` exactly once,
 * immediately before the task would be handed to native execution. If a
 * cancellation was accepted first, it throws and the task MUST NOT be
 * dispatched (zero inference for early cancel).
 */
export interface DispatchGate {
  acquireDispatchPermission(): void;
  /** Returns a cancellation reason if a cancel intent was accepted. */
  cancellationRequested(): string | null;
}

export interface RuntimeObservation {
  runtime_id: string;
  alive: boolean;
  /** True when no active native turn / owned tool activity may mutate the workspace (§14.4). */
  quiescent: boolean;
  observation: string;
}

export interface TransportEnvelopeLimit {
  maxChars?: number;
  maxBytes?: number;
}

export interface ProviderAdapter {
  readonly providerId: string;
  readonly adapterVersion: string;
  /**
   * Optional internal transport envelope limit descriptor (spec §13.2, §15.1).
   * Known configured constant for the provider CLI transport (e.g. argv char limit).
   * When specified, the broker bounds deterministic envelope planning to this limit.
   */
  readonly transportEnvelopeLimit?: TransportEnvelopeLimit | number;

  /**
   * Inspection/preflight: verify CLI presence/version/config compatibility.
   * Receives an AdapterPreflightContext record from the broker (model, effort,
   * role, workspace_mode, registered account binding, immutable effective
   * policy). Throws BrokerError (e.g. PROVIDER_INCOMPATIBLE, AUTH_REQUIRED) on
   * failure. Never performs inference and never runs inside a broker
   * transaction.
   */
  preflight(config: Record<string, unknown>): void;

  /**
   * Execute one broker turn. Must:
   * 1. call gate.acquireDispatchPermission() before native dispatch,
   * 2. emit "native_ref_obtained" via onEvent as soon as the native
   *    conversation reference is known (durable record ASAP, §14.3),
   * 3. resolve with a TurnExecutionResult, or reject with BrokerError.
   * Rejection AFTER dispatch permission must still be a definite outcome
   * (failed native execution), not an ambiguous one.
   */
  executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult>;

  /** Controlled shutdown of an idle runtime (no active turn). */
  shutdownIdleRuntime(sessionId: string): Promise<void>;

  inspectRuntime(sessionId: string): RuntimeObservation | null;

  /**
   * Request interrupt of a running native execution (cancel/deadline, §14.6).
   * Returns true when an interrupt was delivered; the pending executeTurn()
   * promise must then still settle with a definite (failed/interrupted)
   * outcome before managed quiescence can be claimed. Returns false when the
   * turn is unknown to the runtime or cannot be interrupted.
   */
  interruptTurn(turnId: string): Promise<boolean>;
}

export function isBrokerError(e: unknown): e is BrokerError {
  return e instanceof BrokerError;
}
