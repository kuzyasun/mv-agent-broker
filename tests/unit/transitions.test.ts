/**
 * Spec §6.5 conformance of the machine-readable transition tables:
 * no duplicate deterministic edges, all five terminal targets reachable.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_TERMINAL_TARGETS,
  assertSessionTransition,
  assertTurnTransition,
  isTerminalTurnState,
  resolveSessionTransition,
  resolveTurnTransition,
  transitionSelfCheck,
} from "../../src/core/transitions.ts";
import { IllegalTransitionError } from "../../src/core/transitions.ts";

describe("transition tables (§6.5)", () => {
  it("self-check: no duplicate (from,trigger) pairs", () => {
    const report = transitionSelfCheck();
    expect(report.duplicates).toEqual([]);
    expect(report.sessionRules).toBeGreaterThan(10);
    expect(report.turnRules).toBeGreaterThan(15);
  });

  it("unspecified transitions are rejected", () => {
    expect(() => assertSessionTransition("CLOSED", "send_accepted")).toThrow(IllegalTransitionError);
    expect(() => assertSessionTransition("PROVISIONING", "close_completed")).toThrow(IllegalTransitionError);
    expect(() => assertTurnTransition("SUCCEEDED", "startup_begin")).toThrow(IllegalTransitionError);
    expect(() => assertTurnTransition("UNKNOWN", "cancel_or_deadline")).toThrow(IllegalTransitionError);
  });

  it("FINALIZING can reach exactly the five terminal states", () => {
    expect(ALLOWED_TERMINAL_TARGETS).toHaveLength(5);
    const rule = resolveTurnTransition("FINALIZING", "finalization_checks_done");
    expect(rule).not.toBeNull();
    for (const target of ALLOWED_TERMINAL_TARGETS) expect(isTerminalTurnState(target)).toBe(true);
  });

  it("close rows keep the session state until outcome (to === from)", () => {
    expect(resolveSessionTransition("IDLE", "close_intent_accepted")?.to).toBe("IDLE");
    expect(resolveSessionTransition("BLOCKED", "close_intent_accepted")?.to).toBe("BLOCKED");
    expect(resolveSessionTransition("IDLE", "close_completed")?.to).toBe("CLOSED");
    expect(resolveSessionTransition("BLOCKED", "close_completed")?.to).toBe("CLOSED");
  });

  it("execution_unknown is legal from every nonterminal state except UNKNOWN", () => {
    for (const from of ["ACCEPTED", "STARTING", "RUNNING", "CANCELLING", "FINALIZ"] as const) {
      const state = from === "FINALIZ" ? "FINALIZING" : from;
      expect(resolveTurnTransition(state, "execution_unknown")?.to).toBe("UNKNOWN");
    }
    expect(resolveTurnTransition("UNKNOWN", "execution_unknown")).toBeNull();
  });
});
