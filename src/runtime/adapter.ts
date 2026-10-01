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

export interface AgentReportedResult {
  summary: string;
  format_status: "structured" | "text_only";
  claimed_checks?: unknown[];
  concerns?: string[];
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

export interface ProviderAdapter {
  readonly providerId: string;
  readonly adapterVersion: string;

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
