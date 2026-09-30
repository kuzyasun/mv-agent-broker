/**
 * Deterministic mock provider adapter (spec §17 P1). No timers, no sleeps:
 * determinism comes from planned steps, barriers and interrupts.
 *
 * Fault repertoire required by §17 P1: delayed completion (barriers),
 * startup/cancel races (startup_failure + dispatch permission), crash
 * windows (hang + interrupt/UNKNOWN), malformed output, missing native
 * context (resume_failure), failed close (setFailIdleShutdown).
 */
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../runtime/adapter.ts";
import { BrokerError } from "../../shared/errors.ts";

export type MockStep =
  | { kind: "startup_failure"; error: BrokerError }
  | { kind: "report_native_ref"; ref: string }
  | { kind: "progress"; label: string }
  | { kind: "barrier"; name: string }
  | { kind: "workspace_write"; files: Array<{ path: string; content: string }>; deletes?: string[] }
  | { kind: "complete"; outcome: "completed" | "failed"; summary?: string }
  | { kind: "complete_malformed" }
  | { kind: "hang" }
  | { kind: "resume_failure"; error: BrokerError };

interface TurnState {
  steps: MockStep[];
  executed: string[];
  permissionAcquired: boolean | null;
  waiters: Map<string, { reject: (e: Error) => void }>;
  activeReject: ((e: BrokerError) => void) | null;
}

export class MockAdapter implements ProviderAdapter {
  readonly providerId = "mock";
  readonly adapterVersion = "0.1.0";

  private readonly plans = new Map<string, MockStep[]>();
  private readonly turnStates = new Map<string, TurnState>();
  private readonly failIdleShutdown = new Map<string, Error>();

  // ─── test API ──────────────────────────────────────────────────────────────

  plan(turnId: string, steps: MockStep[]): void {
    this.plans.set(turnId, steps);
  }

  releaseBarrier(name: string): boolean {
    const state = this.findTurnByBarrier(name);
    if (!state || !state.waiters.has(name)) return false;
    const waiter = state.waiters.get(name)!;
    state.waiters.delete(name);
    waiter.reject(new BarrierReleased());
    return true;
  }

  pendingBarriers(): string[] {
    const out: string[] = [];
    for (const state of this.turnStates.values()) {
      out.push(...state.waiters.keys());
    }
    return out;
  }

  dispatchPermissionAcquired(turnId: string): boolean | null {
    return this.turnStates.get(turnId)?.permissionAcquired ?? null;
  }

  executedSteps(turnId: string): string[] {
    return [...(this.turnStates.get(turnId)?.executed ?? [])];
  }

  setFailIdleShutdown(sessionId: string, error: Error): void {
    this.failIdleShutdown.set(sessionId, error);
  }

  // ─── ProviderAdapter ───────────────────────────────────────────────────────

  preflight(config: Record<string, unknown>): void {
    const fail = config.failPreflight;
    if (fail instanceof BrokerError) throw fail;
  }

  async executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    const state: TurnState = {
      steps: this.plans.get(req.turn_id) ?? [],
      executed: [],
      permissionAcquired: null,
      waiters: new Map(),
      activeReject: null,
    };
    this.turnStates.set(req.turn_id, state);
    const mark = (step: string) => state.executed.push(step);

    // Pre-dispatch startup failure: permission never acquired, zero inference.
    if (state.steps[0]?.kind === "startup_failure") {
      const step = state.steps[0] as { kind: "startup_failure"; error: BrokerError };
      mark("startup_failure");
      throw step.error;
    }

    try {
      gate.acquireDispatchPermission();
      state.permissionAcquired = true;
    } catch (e) {
      state.permissionAcquired = false;
      mark("dispatch_refused");
      throw e;
    }

    // Resume failure path: explicit native reference exists but resume fails.
    if (req.native_conversation_ref !== null) {
      const resumeFailure = state.steps.find(
        (s): s is { kind: "resume_failure"; error: BrokerError } => s.kind === "resume_failure",
      );
      if (resumeFailure) {
        mark("resume_failure");
        throw resumeFailure.error;
      }
    }

    // Default script: obtain a native ref, then complete successfully.
    const steps = [...state.steps];
    if (steps.length === 0) {
      steps.push(req.native_conversation_ref === null
        ? { kind: "report_native_ref", ref: `mock-native-${req.turn_id}` }
        : { kind: "progress", label: "resumed" });
      steps.push({ kind: "complete", outcome: "completed", summary: "ok" });
    }

    let nativeRef = req.native_conversation_ref;
    const interruptible = new Promise<never>((_resolve, reject) => {
      state.activeReject = (e) => reject(e);
    });

    for (const step of steps) {
      if (step.kind === "barrier") {
        mark(`barrier:${step.name}`);
        onEvent({ type: "barrier", payload: { name: step.name } });
        const gate = new Promise<void>((_resolve, reject) => {
          state.waiters.set(step.name, { reject });
        });
        // The barrier resolves only via releaseBarrier (benign BarrierReleased
        // signal) or the interrupt (BrokerError). Await whichever comes first.
        try {
          await Promise.race([gate, interruptible]);
        } catch (e) {
          state.waiters.delete(step.name);
          if (e instanceof BarrierReleased) continue;
          throw e;
        }
        continue;
      }
      if (step.kind === "report_native_ref") {
        mark("report_native_ref");
        nativeRef = step.ref;
        onEvent({ type: "native_ref_obtained", payload: { ref: step.ref } });
        continue;
      }
      if (step.kind === "progress") {
        mark(`progress:${step.label}`);
        onEvent({ type: "progress", payload: { label: step.label } });
        continue;
      }
      if (step.kind === "workspace_write") {
        mark("workspace_write");
        // Simulates the worker's own writes into its workspace (P2 tests).
        // No-op when the request carries no workspace path.
        if (req.workspace_path) {
          const fs = await import("node:fs");
          const pathMod = await import("node:path");
          const root = req.workspace_path;
          for (const f of step.files) {
            const abs = pathMod.join(root, f.path);
            fs.mkdirSync(pathMod.dirname(abs), { recursive: true });
            fs.writeFileSync(abs, f.content, "utf8");
          }
          for (const rel of step.deletes ?? []) {
            fs.rmSync(pathMod.join(root, rel), { force: true });
          }
        }
        continue;
      }
      if (step.kind === "complete") {
        mark(`complete:${step.outcome}`);
        if (!nativeRef) {
          nativeRef = `mock-native-${req.turn_id}`;
          onEvent({ type: "native_ref_obtained", payload: { ref: nativeRef } });
        }
        if (step.outcome === "failed") {
          throw new BrokerError("PROVIDER_PROTOCOL_ERROR", `mock native failure: ${step.summary ?? "failed"}`, {
            executionStarted: true,
          });
        }
        return {
          native_outcome: "completed",
          native_conversation_ref: nativeRef,
          agent_reported: { summary: step.summary ?? "mock summary", format_status: "structured" },
        };
      }
      if (step.kind === "complete_malformed") {
        mark("complete_malformed");
        return {
          native_outcome: "completed",
          native_conversation_ref: nativeRef ?? `mock-native-${req.turn_id}`,
          agent_reported: { summary: 123 as unknown as string, format_status: "structured" },
          malformed: true,
        };
      }
      if (step.kind === "hang") {
        mark("hang");
        // Simulates a crash window / stuck process: never settles unless
        // interrupted, after which the outcome is a definite failure.
        await interruptible;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "interrupted", { executionStarted: true });
      }
      if (step.kind === "startup_failure" || step.kind === "resume_failure") {
        // Later occurrences of these steps behave as benign no-ops.
        continue;
      }
      step satisfies never;
    }

    // Script exhausted without a terminal step: treat as failure.
    throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "mock script exhausted without completion", {
      executionStarted: true,
    });
  }

  async shutdownIdleRuntime(sessionId: string): Promise<void> {
    const fail = this.failIdleShutdown.get(sessionId);
    if (fail) throw fail;
  }

  inspectRuntime(_sessionId: string): RuntimeObservation | null {
    return null;
  }

  async interruptTurn(turnId: string): Promise<boolean> {
    const state = this.turnStates.get(turnId);
    if (!state) return false;
    const error = new BrokerError("PROVIDER_PROTOCOL_ERROR", "interrupted", { executionStarted: true });
    if (state.activeReject) {
      const reject = state.activeReject;
      state.activeReject = null;
      reject(error);
      return true;
    }
    return false;
  }

  private findTurnByBarrier(name: string): TurnState | null {
    for (const state of this.turnStates.values()) {
      if (state.waiters.has(name)) return state;
    }
    return null;
  }
}

/** Control-flow signal: barrier released by the test, not an error. */
class BarrierReleased extends Error {
  constructor() {
    super("barrier released");
    this.name = "BarrierReleased";
  }
}
