/**
 * Machine-readable transcription of spec §6.5.1/§6.5.2 (normative session
 * and turn transition tables). Changing these tables requires a spec change.
 * An unspecified transition is forbidden (§6.5: "Невказаний перехід заборонений").
 */
import type { SessionState, TurnState } from "../shared/api-types.ts";

export type SessionTrigger =
  | "spawn_accepted"
  | "provisioning_completed"
  | "provisioning_failed"
  | "send_accepted"
  | "blocked_context_detected"
  | "turn_unknown"
  | "terminal_turn_committed_reusable"
  | "terminal_turn_committed_unsafe"
  | "unknown_turn_finalizing"
  | "operator_recovery"
  | "close_intent_accepted"
  | "close_completed"
  | "close_failed"
  | "repeat_stop";

export type TurnTrigger =
  | "final_admission"
  | "startup_begin"
  | "prestart_failure_known"
  | "cancel_or_deadline"
  | "dispatch_confirmed"
  | "startup_failure_or_fast_completion"
  | "native_outcome_established"
  | "shutdown_confirmed"
  | "execution_unknown"
  | "reconciliation_outcome"
  | "operator_abandon"
  | "finalization_checks_done"
  | "late_event_replay";

export interface SessionTransitionRule {
  from: SessionState | null; // null = ∅ (no record yet)
  trigger: SessionTrigger;
  to: SessionState;
  guards: readonly string[];
}

export interface TurnTransitionRule {
  from: TurnState | null;
  trigger: TurnTrigger;
  to: TurnState;
  guards: readonly string[];
}

export const SESSION_TRANSITIONS: readonly SessionTransitionRule[] = [
  { from: null, trigger: "spawn_accepted", to: "PROVISIONING", guards: ["acl-policy-session-cap-idempotency"] },
  { from: "PROVISIONING", trigger: "provisioning_completed", to: "IDLE", guards: ["workspace-ready", "initial-snapshot-sealed", "review-slot-may-be-empty"] },
  { from: "PROVISIONING", trigger: "provisioning_failed", to: "BLOCKED", guards: ["known-unknown-side-effects-recorded", "reservations-quarantine-retained"] },
  { from: "IDLE", trigger: "send_accepted", to: "ACTIVE", guards: ["admission-7-2", "no-pending-close"] },
  { from: "IDLE", trigger: "blocked_context_detected", to: "BLOCKED", guards: ["blocking-evidence", "resource-protection"] },
  { from: "ACTIVE", trigger: "turn_unknown", to: "BLOCKED", guards: ["outcome-or-quiescence-unestablished", "quarantine-reservations"] },
  { from: "ACTIVE", trigger: "terminal_turn_committed_reusable", to: "IDLE", guards: ["context-usable", "workspace-ready", "no-unresolved-issue"] },
  { from: "ACTIVE", trigger: "terminal_turn_committed_unsafe", to: "BLOCKED", guards: ["context-or-workspace-or-policy-not-ready", "candidate-abandoned-possible"] },
  { from: "BLOCKED", trigger: "unknown_turn_finalizing", to: "ACTIVE", guards: ["reconciliation-confirmed-quiescence", "no-new-dispatch"] },
  { from: "BLOCKED", trigger: "operator_recovery", to: "IDLE", guards: ["context-usable-or-verifiably-not-started", "baseline-policy-ready", "intents-reconciled", "close-not-pending"] },
  // "Стан не змінюється до close outcome": to === from.
  { from: "IDLE", trigger: "close_intent_accepted", to: "IDLE", guards: ["close-guards-6-4", "send-ban", "cap-still-held"] },
  { from: "BLOCKED", trigger: "close_intent_accepted", to: "BLOCKED", guards: ["close-guards-6-4", "send-ban", "cap-still-held"] },
  { from: "IDLE", trigger: "close_completed", to: "CLOSED", guards: ["close-guards-6-4", "idle-runtime-shutdown-confirmed"] },
  { from: "BLOCKED", trigger: "close_completed", to: "CLOSED", guards: ["close-guards-6-4", "idle-runtime-shutdown-confirmed"] },
  { from: "IDLE", trigger: "close_failed", to: "BLOCKED", guards: ["intent-exists", "guard-completion-unconfirmed"] },
  { from: "BLOCKED", trigger: "close_failed", to: "BLOCKED", guards: ["intent-exists", "guard-completion-unconfirmed"] },
  { from: "CLOSED", trigger: "repeat_stop", to: "CLOSED", guards: ["valid-authorization", "no-execution-effects"] },
];

/** Spec §6.5.2 covers every nonterminal state except UNKNOWN for this edge. */
const NONTERMINAL_EXCEPT_UNKNOWN: readonly TurnState[] = [
  "ACCEPTED", "STARTING", "RUNNING", "CANCELLING", "FINALIZING",
];

const TERMINAL_STATES: readonly TurnState[] = ["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ABANDONED"];

const TURN_BASE: readonly TurnTransitionRule[] = [
  { from: null, trigger: "final_admission", to: "ACCEPTED", guards: ["admission-7-2"] },
  { from: "ACCEPTED", trigger: "startup_begin", to: "STARTING", guards: ["readiness-ownership-valid", "no-earlier-cancel", "task-not-dispatched-yet"] },
  { from: "ACCEPTED", trigger: "prestart_failure_known", to: "FINALIZING", guards: ["no-dispatch-evidence", "managed-quiescence", "candidate-failed-execution-started-false"] },
  { from: "ACCEPTED", trigger: "cancel_or_deadline", to: "CANCELLING", guards: ["no-established-final-outcome", "intent-serialized-with-dispatch-permission"] },
  { from: "STARTING", trigger: "cancel_or_deadline", to: "CANCELLING", guards: ["no-established-final-outcome", "intent-serialized-with-dispatch-permission"] },
  { from: "RUNNING", trigger: "cancel_or_deadline", to: "CANCELLING", guards: ["no-established-final-outcome", "intent-serialized-with-dispatch-permission"] },
  { from: "STARTING", trigger: "dispatch_confirmed", to: "RUNNING", guards: ["required-inputs-baseline-policy-verified", "launch-journal-exists", "execution-started-true"] },
  { from: "STARTING", trigger: "startup_failure_or_fast_completion", to: "FINALIZING", guards: ["outcome-known", "quiescence-confirmed", "no-fabricated-running"] },
  { from: "RUNNING", trigger: "native_outcome_established", to: "FINALIZING", guards: ["managed-quiescence-confirmed", "final-capture-intent"] },
  { from: "CANCELLING", trigger: "shutdown_confirmed", to: "FINALIZING", guards: ["managed-quiescence", "outcome-reason-known", "candidate-per-14-6", "no-rollback"] },
  { from: "UNKNOWN", trigger: "reconciliation_outcome", to: "FINALIZING", guards: ["quiescence-confirmed", "authoritative-outcome-evidence", "no-new-prompt"] },
  { from: "UNKNOWN", trigger: "operator_abandon", to: "FINALIZING", guards: ["quiescence-confirmed", "outcome-still-unknown", "workspace-inspected-or-capture-failed-recorded"] },
];

export const TURN_TRANSITIONS: readonly TurnTransitionRule[] = [
  ...TURN_BASE,
  // "Будь-який nonterminal, крім UNKNOWN" → execution_unknown.
  ...NONTERMINAL_EXCEPT_UNKNOWN.map<TurnTransitionRule>((from) => ({
    from,
    trigger: "execution_unknown",
    to: "UNKNOWN",
    guards: ["insufficient-reliable-evidence", "session-block", "resources-quarantine-retained"],
  })),
  // FINALIZING → one of the five terminal states (representative rule: the
  // target is chosen by the terminal commit, see ALLOWED_TERMINAL_TARGETS).
  { from: "FINALIZING", trigger: "finalization_checks_done", to: "SUCCEEDED", guards: ["evidence-checks-6-2-6-5-3", "quiescence-confirmed", "minimal-result-durable"] },
  // Any terminal + late cancel/event/replay → stays terminal (audit only).
  ...TERMINAL_STATES.map<TurnTransitionRule>((from) => ({
    from,
    trigger: "late_event_replay",
    to: from,
    guards: ["valid-acl", "incarnation-revision-checks", "audit-diagnostics-only"],
  })),
];

/** Terminal targets legal from FINALIZING via finalization_checks_done (§6.2). */
export const ALLOWED_TERMINAL_TARGETS: readonly TurnState[] = TERMINAL_STATES;

function ruleKey(entity: "session" | "turn", from: string | null, trigger: string): string {
  return `${entity}:${from ?? "∅"}:${trigger}`;
}

export function resolveSessionTransition(
  from: SessionState | null,
  trigger: SessionTrigger,
): SessionTransitionRule | null {
  for (const rule of SESSION_TRANSITIONS) {
    if (rule.from === from && rule.trigger === trigger) return rule;
  }
  return null;
}

export function resolveTurnTransition(
  from: TurnState | null,
  trigger: TurnTrigger,
): TurnTransitionRule | null {
  for (const rule of TURN_TRANSITIONS) {
    if (rule.from === from && rule.trigger === trigger) return rule;
  }
  return null;
}

export class IllegalTransitionError extends Error {
  constructor(entity: "session" | "turn", from: string | null, trigger: string) {
    super(`Illegal ${entity} transition: ${from ?? "∅"} --${trigger}--> (unspecified in §6.5)`);
    this.name = "IllegalTransitionError";
  }
}

export function assertSessionTransition(from: SessionState | null, trigger: SessionTrigger): SessionTransitionRule {
  const rule = resolveSessionTransition(from, trigger);
  if (!rule) throw new IllegalTransitionError("session", from, trigger);
  return rule;
}

export function assertTurnTransition(from: TurnState | null, trigger: TurnTrigger): TurnTransitionRule {
  const rule = resolveTurnTransition(from, trigger);
  if (!rule) throw new IllegalTransitionError("turn", from, trigger);
  return rule;
}

export function isTerminalTurnState(s: TurnState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}

export function isNonterminalTurnState(s: TurnState): boolean {
  return !isTerminalTurnState(s);
}

export function sessionSendAllowed(s: SessionState): boolean {
  return s === "IDLE";
}

/**
 * Completeness self-check for tests: no duplicate deterministic (from,trigger)
 * pairs. Representative multi-target rules (finalization_checks_done,
 * late_event_replay families) are expanded per-state and therefore unique.
 */
export function transitionSelfCheck(): { sessionRules: number; turnRules: number; duplicates: string[] } {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const r of SESSION_TRANSITIONS) {
    const key = ruleKey("session", r.from, r.trigger);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  for (const r of TURN_TRANSITIONS) {
    const key = ruleKey("turn", r.from, r.trigger);
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  return { sessionRules: SESSION_TRANSITIONS.length, turnRules: TURN_TRANSITIONS.length, duplicates };
}
