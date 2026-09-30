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
import type { BrokerError } from "../shared/errors.ts";

export interface AdapterEvent {
  type: string;
  payload?: Record<string, unknown>;
}

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
   * Throws BrokerError (e.g. PROVIDER_INCOMPATIBLE, AUTH_REQUIRED) on failure.
   * Never performs inference.
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
  return e instanceof Error && e.name === "BrokerError";
}
