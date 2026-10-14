/** Offline regression coverage: definitive FAILED results retain native reports. */
import { describe, expect, it, vi } from "vitest";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { callBridgeTool } from "../../src/bridge/tools.ts";
import { boundAgentReport, type ProviderFailure, type TurnExecutionResult } from "../../src/runtime/adapter.ts";
import { activeQuotaCooldown } from "../../src/core/quotaCooldown.ts";
import { getTurnEventPayload } from "../../src/storage/repo.ts";

const quota: ProviderFailure = { code: "QUOTA_EXHAUSTED", message: "Provider quota exhausted.", retry_after_ms: 12_345 };
type Harness = ReturnType<typeof createHarness>;

function bridge(h: Harness) {
  return { core: h.core, coordinatorId: h.seed.coordinatorId, daemonState: null, incarnation: "test" };
}

function failedResult(report?: string, failure: ProviderFailure = quota): TurnExecutionResult {
  return {
    native_outcome: "failed", native_conversation_ref: "mock-failed-native", failure,
    ...(report !== undefined ? { agent_reported: boundAgentReport(report) } : {}),
  };
}

/** Keep the real mock gate/ref prologue; replace only its terminal result. */
function returnFailed(h: Harness, result: TurnExecutionResult) {
  const execute = h.adapter.executeTurn.bind(h.adapter);
  vi.spyOn(h.adapter, "executeTurn").mockImplementation(async (...args) => {
    await execute(...args);
    return result;
  });
}

describe("failed native result retention", () => {
  it("returns a bounded failed report and its complete artifact through the bridge", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      const report = "Partial work. ".repeat(400) + "TAIL-PRESERVED";
      returnFailed(h, failedResult(report));
      const turn = h.sendTask(session.session_id, "failed-report");
      await start(h, turn);
      await settle(h);
      const result = await callBridgeTool(bridge(h), "agent_turn_result", { turn_id: turn.turn_id }) as {
        execution_status: string; broker_observed: { error_code: string }; quality_status: string; summary_truncated: boolean;
        agent_reported: { summary: string }; full_message_artifact_id: string;
      };
      expect(result).toMatchObject({ execution_status: "FAILED", broker_observed: { error_code: "QUOTA_EXHAUSTED" }, quality_status: "unreviewed", summary_truncated: true });
      expect(result.agent_reported.summary).toBe(report.slice(0, 4000));
      const artifact = await callBridgeTool(bridge(h), "agent_artifact_read", {
        artifact_id: result.full_message_artifact_id, max_bytes: 8000,
      }) as { data: string };
      expect(artifact.data).toBe(report);
      expect(getTurnEventPayload(h.db, turn.turn_id, "turn_terminal")?.message).toBe(quota.message);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toMatchObject({
        retry_after_ms: 12_345, source: "provider_retry_after", recorded_by_turn_id: turn.turn_id,
      });
    } finally { h.cleanup(); }
  });

  it.each([undefined, ""])("does not invent report prose for empty/absent report %s", async (report) => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      returnFailed(h, failedResult(report, { code: "PROVIDER_EXECUTION_ERROR", message: "Provider execution failed." }));
      const turn = h.sendTask(session.session_id, "empty-report");
      await start(h, turn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({ state: "FAILED", error_code: "PROVIDER_EXECUTION_ERROR" });
      const reported = getTurnEventPayload(h.db, turn.turn_id, "agent_reported");
      if (report === undefined) expect(reported).toBeNull();
      else expect(reported?.summary).toBe("");
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();
    } finally { h.cleanup(); }
  });

  it("retains native failure and quota pause when report publication fails", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      returnFailed(h, failedResult("Partial report."));
      const turn = h.sendTask(session.session_id, "publication-failure");
      h.executor.failReportPublicationForTest(turn.turn_id);
      await start(h, turn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({ state: "FAILED", native_outcome: "failed", error_code: quota.code });
      const row = h.db.raw.prepare("SELECT finalization_error FROM turns WHERE turn_id = ?").get(turn.turn_id) as { finalization_error: string };
      expect(row.finalization_error).toContain("EVIDENCE_CAPTURE_FAILED");
      expect(getTurnEventPayload(h.db, turn.turn_id, "turn_terminal")?.message).toBe(quota.message);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())?.retry_after_ms).toBe(12_345);
    } finally { h.cleanup(); }
  });

  it.each(["before_blob", "before_seal", "before_terminal"])("recovers failure metadata and quota pause at %s without new execution", async (window) => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      const spy = vi.spyOn(h.adapter, "preflight");
      returnFailed(h, failedResult("Durable partial report."));
      const turn = h.sendTask(session.session_id, "crash-recovery");
      if (window === "before_blob") h.executor.skipReportBlobForTest(turn.turn_id);
      else if (window === "before_seal") h.executor.skipReportSealForTest(turn.turn_id);
      else h.executor.skipCommitForTest(turn.turn_id);
      await start(h, turn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe("RUNNING");
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();
      const calls = spy.mock.calls.length;
      const recordedAt = h.clock.now();
      h.clock.advance(1000);
      await h.executor.reconcileJournaledOutcomes();
      expect(spy.mock.calls.length).toBe(calls);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({ state: "FAILED", native_outcome: "failed", error_code: quota.code });
      expect(getTurnEventPayload(h.db, turn.turn_id, "turn_terminal")?.message).toBe(quota.message);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())?.retry_after_ms).toBe(12_345);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())?.until_ms).toBe(recordedAt + 12_345);
      expect(getTurnEventPayload(h.db, turn.turn_id, "agent_reported")?.summary ?? null)
        .toBe(window === "before_blob" ? null : "Durable partial report.");
      await h.executor.reconcileJournaledOutcomes();
      expect(h.core.turnEvents(h.seed.coordinatorId, turn.turn_id, 0, 200).filter(e => e.type === "quota_pause_recorded")).toHaveLength(1);
    } finally { h.cleanup(); }
  });

  it("retains a throwing adapter's native failure through terminal-commit recovery", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      const turn = h.sendTask(session.session_id, "throwing-failure");
      h.adapter.plan(turn.turn_id, [{ kind: "complete", outcome: "failed", summary: "native refusal" }]);
      h.executor.skipCommitForTest(turn.turn_id);
      await start(h, turn);
      await settle(h);
      await h.executor.reconcileJournaledOutcomes();
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({ state: "FAILED", error_code: "PROVIDER_PROTOCOL_ERROR" });
      expect(getTurnEventPayload(h.db, turn.turn_id, "turn_terminal")?.message).toBe("mock native failure: native refusal");
      expect(getTurnEventPayload(h.db, turn.turn_id, "agent_reported")).toBeNull();
    } finally { h.cleanup(); }
  });

  it.each(["cancel", "deadline", "unknown"])("keeps %s precedence over a late quota result without fabricating report/cooldown", async (kind) => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      let resolve!: (value: TurnExecutionResult) => void;
      vi.spyOn(h.adapter, "executeTurn").mockImplementation(async (_req, gate) => {
        gate.acquireDispatchPermission();
        return await new Promise<TurnExecutionResult>(done => { resolve = done; });
      });
      const turn = h.sendTask(session.session_id, "late-failure", "Work.", { deadline_ms: 1000 });
      await start(h, turn);
      if (kind === "cancel") h.core.cancel(h.seed.coordinatorId, { turn_id: turn.turn_id, idempotency_key: "cancel", reason: "stop" });
      else if (kind === "deadline") { h.clock.advance(1500); h.executor.scanDeadlines(); }
      else h.db.raw.prepare("UPDATE turns SET state = 'UNKNOWN', native_outcome = 'unknown', state_version = state_version + 1 WHERE turn_id = ?").run(turn.turn_id);
      resolve(failedResult(kind === "unknown" ? "Late partial report." : undefined));
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe(kind === "cancel" ? "CANCELLED" : kind === "deadline" ? "TIMED_OUT" : "UNKNOWN");
      expect(getTurnEventPayload(h.db, turn.turn_id, "agent_reported")).toBeNull();
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();
      if (kind !== "unknown") {
        expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).error_code).toBeNull();
      }
    } finally { h.cleanup(); }
  });

  it.each([
    ["cancel", "publication_failure"], ["deadline", "publication_failure"],
    ["cancel", "before_blob"], ["deadline", "before_blob"],
  ])("keeps %s precedence after report %s and records evidence failure separately", async (kind, window) => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();
      let resolve!: (value: TurnExecutionResult) => void;
      vi.spyOn(h.adapter, "executeTurn").mockImplementation(async (_req, gate) => {
        gate.acquireDispatchPermission();
        return await new Promise<TurnExecutionResult>(done => { resolve = done; });
      });
      const turn = h.sendTask(session.session_id, "interrupted-publication", "Work.", { deadline_ms: 1000 });
      if (window === "before_blob") h.executor.skipReportBlobForTest(turn.turn_id);
      else h.executor.failReportPublicationForTest(turn.turn_id);
      await start(h, turn);
      if (kind === "cancel") h.core.cancel(h.seed.coordinatorId, { turn_id: turn.turn_id, idempotency_key: "cancel", reason: "stop" });
      else { h.clock.advance(1500); h.executor.scanDeadlines(); }
      resolve(failedResult("Partial interrupted report."));
      await settle(h);
      if (window === "before_blob") await h.executor.reconcileJournaledOutcomes();
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({
        state: kind === "cancel" ? "CANCELLED" : "TIMED_OUT", error_code: null,
      });
      const row = h.db.raw.prepare("SELECT finalization_error FROM turns WHERE turn_id = ?").get(turn.turn_id) as { finalization_error: string };
      expect(row.finalization_error).toContain("EVIDENCE_CAPTURE_FAILED");
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();
    } finally { h.cleanup(); }
  });
});
