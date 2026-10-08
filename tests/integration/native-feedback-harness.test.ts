/**
 * Integration regression test suite for the opt-in native feedback harness
 * (worker -> review -> fix -> same-reviewer flow).
 *
 * Verifies:
 * - Real harness entrypoint execution (runNativeFeedback) over real stdio/RPC child lifecycle
 * - Exact artifactID chain and current snapshots (S0 -> S1 -> S2)
 * - Same-conversation assertions across turns on worker and reviewer sessions (persistent mode)
 * - fresh/handoff feedback modes prove distinct session IDs and distinct observed native refs
 *   for replacement FIX/R2 sessions after confirmed CLOSED receipts, on the same fixture/S1 and
 *   the same review slot/S1->S2
 * - handoff mode delivers a bounded coordinator task.context carrying the findings artifact ID
 *   (never reviewer prose) to the replacement FIX session
 * - Bounded measurement evidence: tools/call counts (including failures), UTF-8 JSON result
 *   byte bodies, per-turn elapsed_ms, chain elapsed, and broker usage copied verbatim
 * - Invalid feedback_mode rejected before any root allocation
 * - Large findings (>16 KiB) read_only_path transport and manifest ACL
 * - Failed review stops with explicit failed evidence; no automatic fallback and retains fixture
 * - Stale/missing/expired artifact references reject admission (no false pass)
 * - UNKNOWN turn state retains fixture directory for offline forensics and never converts to failed
 * - Graceful disconnect/reconnect during admitted ACTIVE turn retains turn and monotonic events
 * - Cancellation scenario verifies actual terminal outcome and trusted owned quiescence receipt
 * - Explicit daemon restart option recovers exact persisted identity without fresh fallback
 * - Scripts route validation rejects Claude/Codex and requires explicit models/effort in production
 * - Root anti-adoption rejects arbitrary caller paths, preexisting roots, and symlink ancestors
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { cursorChatStorePathBudgetViolation } from "../../src/providers/cursor/cursorAdapter.ts";
import {
  ACCEPTED_RUNTIME_SHA,
  FEEDBACK_MODES,
  HANDOFF_CONTEXT_MAX_CHARS,
  INLINE_TOTAL_BYTE_CAP,
  REVIEWER_SESSION_INSTRUCTIONS,
  WORKER_SESSION_INSTRUCTIONS,
  buildHandoffContext,
  createFixtureGitRepo,
  extractRuntime,
  validateFeedbackMode,
  validateRouteConfig,
  validateProductionConfig,
  resolveAndValidateHarnessRoot,
  validateExclusiveRootForCleanup,
  buildPrivacySafeAssessment,
  runOfflineChecks,
  runNativeFeedback,
  readFullArtifact,
  canPerformCleanup,
} from "../../scripts/native-feedback.mjs";

/** Metrics counter consistency: by-method aggregates must equal the totals. */
function expectMetricsConsistent(metrics: {
  calls_total: number;
  calls_failed: number;
  result_bytes_total: number;
  calls_by_method: Record<string, { count: number; failed: number; result_bytes: number }>;
}) {
  expect(metrics.calls_total).toBeGreaterThan(0);
  expect(metrics.result_bytes_total).toBeGreaterThan(0);
  const sums = Object.values(metrics.calls_by_method).reduce(
    (acc, m) => ({ count: acc.count + m.count, failed: acc.failed + m.failed, bytes: acc.bytes + m.result_bytes }),
    { count: 0, failed: 0, bytes: 0 },
  );
  expect(sums.count).toBe(metrics.calls_total);
  expect(sums.failed).toBe(metrics.calls_failed);
  expect(sums.bytes).toBe(metrics.result_bytes_total);
}

describe("Native feedback harness integration", () => {
  it("builds the same baseline Git commit in independent mode fixtures", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ab-fixture-compare-"));
    try {
      const first = createFixtureGitRepo(path.join(root, "first"));
      const second = createFixtureGitRepo(path.join(root, "second"));
      expect(second.baselineHead).toBe(first.baselineHead);
      expect(second.baselineIndex).toBe(first.baselineIndex);
      expect(second.baselineTestHash).toBe(first.baselineTestHash);
      expect(second.baselinePackageHash).toBe(first.baselinePackageHash);
    } finally {
      expect(root.startsWith(path.join(tmpdir(), "ab-fixture-compare-"))).toBe(true);
      rmSync(root, {recursive:true,force:true});
    }
  });

  it("uses a fresh owned short temporary root that fits the installed Cursor store budget", () => {
    const { root, approvedBase, ownerToken } = resolveAndValidateHarnessRoot({});
    try {
      expect(approvedBase).toBe(path.resolve(tmpdir(), "ab-feedback"));
      expect(path.dirname(root)).toBe(approvedBase);
      expect(() => resolveAndValidateHarnessRoot({ root })).toThrow(/preexisting root/i);
      const configDir = path.join(root, "state", "providers", "cursor", "sessions", "a".repeat(64), "config");
      expect(cursorChatStorePathBudgetViolation(configDir, path.join(root, "fixture-repo"), null)).toBeNull();
      validateExclusiveRootForCleanup(root, approvedBase, ownerToken);
    } finally {
      validateExclusiveRootForCleanup(root, approvedBase, ownerToken);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the native serve process alive through READY and closes on stdin EOF without inference", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ab-native-serve-"));
    const runtime = path.join(root, "runtime");
    const state = path.join(root, "state");
    extractRuntime(process.cwd(), runtime, ACCEPTED_RUNTIME_SHA);
    const env: NodeJS.ProcessEnv = { ...process.env, AB_ROLE: "daemon", AB_STATE_DIR: state, AB_COORDINATOR_ID: "startup-only" };
    delete env.AB_MOCK_FEEDBACK;
    const child = spawn(process.execPath, ["--experimental-transform-types", path.resolve("scripts/native-feedback.mjs"), "--serve", runtime], { cwd: runtime, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const closed = once(child, "close");
    let ready = false;
    child.stderr.on("data", chunk => { ready ||= String(chunk).includes("daemon listening"); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const until = Date.now() + 10000;
      while (!ready && child.exitCode === null && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 50));
      expect(ready).toBe(true);
      expect(child.exitCode).toBeNull();
      child.stdin.end();
      const result = await Promise.race([closed, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
      expect(result).not.toBe(false);
      expect(child.exitCode).toBe(0);
      const db = new DatabaseSync(path.join(state, "registry.sqlite"), {readOnly:true});
      try { expect(db.prepare("SELECT count(*) AS n FROM turns").get()?.n).toBe(0); }
      finally { db.close(); }
    } finally {
      if (timer) clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.stdin.end(); child.kill(); await closed; }
      expect(root.startsWith(path.join(tmpdir(), "ab-native-serve-"))).toBe(true);
      rmSync(root, {recursive:true,force:true});
    }
  }, 20000);

  it("executes the normative worker -> review -> fix -> same-reviewer flow with exact artifactID chain and current snapshots via real harness entrypoint", async () => {
    const res = await runNativeFeedback({
      mock: true,
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    expect(res.evidence.r2_slot_s2_verified).toBe(true);
    expect(res.evidence.findings_acl_denial_verified).toBe(true);
    const evidence = res.evidence;

    // 0. Default continuity mode is persistent; per-turn identity recorded
    expect(evidence.feedback_mode).toBe("persistent");
    expect(evidence.turns.map((t: { phase: string }) => t.phase)).toEqual([
      "worker_initial", "reviewer_r1", "worker_fix", "reviewer_r2",
    ]);

    // 1. Assert 4-turn exact lifecycle completed
    expect(evidence.turns.length).toBe(4);
    expect(evidence.turns.every((t) => t.status?.state === "SUCCEEDED")).toBe(true);

    // 2. Snapshot chain S0 -> S1 -> S2 distinct bindings
    const s0 = evidence.snapshots.s0;
    const s1 = evidence.snapshots.s1;
    const s2 = evidence.snapshots.s2;
    expect(s0).toBeTruthy();
    expect(s1).toBeTruthy();
    expect(s2).toBeTruthy();
    expect(s1).not.toBe(s0);
    expect(s2).not.toBe(s1);
    expect(s2).not.toBe(s0);

    // 3. Exact findings artifact ID and content hash
    expect(evidence.findings_artifact).toBeTruthy();
    expect(evidence.findings_artifact.artifact_id).toBeTruthy();
    expect(evidence.findings_artifact.size_bytes).toBeGreaterThan(0);
    expect(evidence.findings_artifact.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.findings_artifact.delivery_mode).toBe("inline");

    // 4. Same worker and same reviewer native conversation continuity
    expect(evidence.workerNativeRef).toBe("mock-native-worker-ref");
    expect(evidence.reviewerNativeRef).toBe("mock-native-reviewer-ref");
    expect(evidence.sameWorkerConversation).toBe(true);
    expect(evidence.sameReviewerConversation).toBe(true);

    // 4b. Observed native refs per turn: FIX and R2 reuse the exact turn-1/R1 refs
    expect(evidence.turns[0].native_ref_observed).toBe("mock-native-worker-ref");
    expect(evidence.turns[1].native_ref_observed).toBe("mock-native-reviewer-ref");
    expect(evidence.turns[2].native_ref_observed).toBe("mock-native-worker-ref");
    expect(evidence.turns[3].native_ref_observed).toBe("mock-native-reviewer-ref");
    expect(evidence.turns[2].session_id).toBe(evidence.turns[0].session_id);
    expect(evidence.turns[3].session_id).toBe(evidence.turns[1].session_id);
    expect(evidence.turns[2].result.broker_observed.baseline_snapshot_id).toBeNull();

    // 5. Offline fixture checks: S1 deliberate failure, S2 pass, untouched baseline
    expect(evidence.s1_deliberate_failure_verified).toBe(true);
    expect(evidence.offline_checks.length).toBeGreaterThan(0);
    expect(evidence.offline_checks.every((c) => c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "baseline_test_untouched" && c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "baseline_package_untouched" && c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "s2_node_test_passed" && c.ok)).toBe(true);

    // 6. Bounded measurement evidence: call counts, UTF-8 JSON result bytes,
    //    per-turn elapsed, chain elapsed, usage verbatim from the broker.
    expectMetricsConsistent(evidence.metrics);
    expect(evidence.metrics.failed_calls.some((c) => c.name === "agent_artifact_read" && c.code === "UNAUTHORIZED")).toBe(true);
    expect(evidence.metrics.turn_counts).toEqual({ admitted: 4, terminal: 4, succeeded: 4 });
    expect(evidence.metrics.elapsed_ms_chain).toBeGreaterThan(0);
    for (const turn of evidence.turns) {
      expect(typeof turn.elapsed_ms).toBe("number");
      expect(turn.elapsed_ms).toBeGreaterThanOrEqual(0);
      // Broker reports usage.availability unknown; harness must copy it verbatim.
      expect(turn.usage).toEqual({ availability: "unknown", billing_basis: "unknown", measurements: [] });
    }

    // 7. Evidence artifacts kept after clean owned fixture removal
    expect(existsSync(path.join(res.root, "evidence.private.json"))).toBe(true);
    expect(existsSync(path.join(res.root, "assessment.json"))).toBe(true);
    expect(existsSync(path.join(res.root, "reports"))).toBe(true);
    expect(existsSync(path.join(res.root, "fixture-repo"))).toBe(false); // Cleaned
  }, 35000);

  it("fresh mode closes old sessions to confirmed CLOSED and proves distinct session IDs and native refs on the same fixture/S1 and review slot/S1->S2", async () => {
    const res = await runNativeFeedback({
      mock: true,
      feedback_mode: "fresh",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    const evidence = res.evidence;
    expect(evidence.feedback_mode).toBe("fresh");
    expect(evidence.turns.length).toBe(4);
    expect(evidence.turns.every((t) => t.status?.state === "SUCCEEDED")).toBe(true);

    // Old worker/reviewer sessions closed with a confirmed completed receipt
    expect(evidence.fresh_worker.closed_session_id).toBe(evidence.turns[0].session_id);
    expect(evidence.fresh_worker.closed_state).toBe("CLOSED");
    expect(evidence.fresh_worker.closed_close_state).toBe("completed");
    expect(evidence.fresh_reviewer.closed_session_id).toBe(evidence.turns[1].session_id);
    expect(evidence.fresh_reviewer.closed_close_state).toBe("completed");

    // Distinct replacement session IDs for FIX and R2
    expect(evidence.fresh_worker.session_id).not.toBe(evidence.turns[0].session_id);
    expect(evidence.fresh_reviewer.session_id).not.toBe(evidence.turns[1].session_id);
    expect(evidence.turns[2].session_id).toBe(evidence.fresh_worker.session_id);
    expect(evidence.turns[3].session_id).toBe(evidence.fresh_reviewer.session_id);

    // Distinct observed native refs: replacements did NOT resume old conversations
    expect(evidence.workerNativeRef).toBe("mock-native-worker-ref");
    expect(evidence.reviewerNativeRef).toBe("mock-native-reviewer-ref");
    expect(evidence.fresh_worker.native_ref_observed).toBe("mock-native-worker-ref-2");
    expect(evidence.fresh_reviewer.native_ref_observed).toBe("mock-native-reviewer-ref-2");
    expect(evidence.turns[2].native_ref_observed).toBe(evidence.fresh_worker.native_ref_observed);
    expect(evidence.turns[3].native_ref_observed).toBe(evidence.fresh_reviewer.native_ref_observed);
    expect(evidence.sameWorkerConversation).toBeFalsy();
    expect(evidence.sameReviewerConversation).toBeFalsy();

    // FIX uses the current checkout; explicit snapshot R2 binds S1 -> S2.
    expect(evidence.turns[2].result.broker_observed.baseline_snapshot_id).toBeNull();
    expect(evidence.turns[3].result.broker_observed.baseline_snapshot_id).toBe(evidence.snapshots.s1);
    expect(evidence.r2_slot_s2_verified).toBe(true);
    expect(evidence.s1_deliberate_failure_verified).toBe(true);
    expect(evidence.offline_checks.every((c) => c.ok)).toBe(true);

    // Same fixture integrity checks as persistent: findings ACL, delivery, metrics
    expect(evidence.findings_acl_denial_verified).toBe(true);
    expect(evidence.findings_artifact.delivery_mode).toBe("inline");
    expectMetricsConsistent(evidence.metrics);
    expect(evidence.metrics.turn_counts).toEqual({ admitted: 4, terminal: 4, succeeded: 4 });
  }, 35000);

  it("handoff mode adds a bounded coordinator task.context with the findings artifact ID and no reviewer prose", async () => {
    const res = await runNativeFeedback({
      mock: true,
      feedback_mode: "handoff",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    const evidence = res.evidence;
    expect(evidence.feedback_mode).toBe("handoff");

    // Bounded English coordinator summary recorded for the FIX handoff
    const context = evidence.handoff_context;
    expect(typeof context).toBe("string");
    expect(context.length).toBeGreaterThan(0);
    expect(context.length).toBeLessThanOrEqual(HANDOFF_CONTEXT_MAX_CHARS);
    expect(context).toContain(evidence.snapshots.s1);
    expect(context).toContain(`findings artifact ${evidence.findings_artifact.artifact_id}`);
    expect(context).toContain("divide");
    // Never copied reviewer prose
    expect(context).not.toContain("FINDINGS:");
    // Never paths from expired input views
    expect(context).not.toContain("inputs");

    // Same fresh-mode distinct identity proofs apply
    expect(evidence.fresh_worker.session_id).not.toBe(evidence.turns[0].session_id);
    expect(evidence.fresh_worker.native_ref_observed).not.toBe(evidence.workerNativeRef);
    expect(evidence.fresh_reviewer.native_ref_observed).not.toBe(evidence.reviewerNativeRef);
    expect(evidence.turns[2].result.broker_observed.baseline_snapshot_id).toBeNull();

    // Public assessment carries the handoff artifact ID and mode honestly
    const assessment = JSON.parse(readFileSync(path.join(res.root, "assessment.json"), "utf8"));
    expect(assessment.feedback_mode).toBe("handoff");
    expect(assessment.artifact_chain.handoff_artifact_id).toBe(evidence.findings_artifact.artifact_id);
    expect(assessment.continuity.same_worker_conversation).toBe(false);
    expectMetricsConsistent(evidence.metrics);
  }, 35000);

  it("retains a failed fresh chain when a successful FIX reports no native identity", async () => {
    const res = await runNativeFeedback({ mock: true, feedback_mode: "fresh", mock_fault: "missing_fresh_ref", cleanup: true, runtime_sha: ACCEPTED_RUNTIME_SHA });
    expect(res.status).toBe("failed");
    expect(res.evidence.error).toContain("FIX did not report a native conversation ref");
    expect(res.evidence.turns).toHaveLength(3);
    expect(res.evidence.turns[2].status.state).toBe("SUCCEEDED");
    expect(res.evidence.fresh_worker.native_ref_observed).toBeUndefined();
    expect(existsSync(path.join(res.root, "fixture-repo"))).toBe(true);
    expect(res.evidence.sessionsClosed).toBe(true);
  }, 35000);

  it("rejects invalid feedback_mode before any allocation and validates the handoff context builder", async () => {
    // 1. Mode list and validation function
    expect(FEEDBACK_MODES).toEqual(["persistent", "fresh", "handoff"]);
    expect(validateFeedbackMode({})).toBe("persistent");
    for (const mode of FEEDBACK_MODES) expect(validateFeedbackMode({ feedback_mode: mode })).toBe(mode);
    expect(() => validateFeedbackMode({ feedback_mode: "resume" })).toThrow(/Invalid feedback_mode 'resume'/);
    expect(() => validateFeedbackMode({ feedback_mode: "" })).toThrow(/Invalid feedback_mode ''/);
    expect(() => validateFeedbackMode({ feedback_mode: 7 as unknown as string })).toThrow(/Invalid feedback_mode/);

    // 2. runNativeFeedback rejects before creating any harness root
    const approvedBase = path.join(tmpdir(), "ab-feedback");
    mkdirSync(approvedBase, { recursive: true });
    const before = new Set(readdirSync(approvedBase));
    await expect(
      runNativeFeedback({ mock: true, feedback_mode: "resume", runtime_sha: ACCEPTED_RUNTIME_SHA }),
    ).rejects.toThrow(/Invalid feedback_mode 'resume'/);
    const after = new Set(readdirSync(approvedBase));
    expect([...after].filter((entry) => !before.has(entry))).toEqual([]);

    // 3. Handoff context builder bounds and required content
    const ctx = buildHandoffContext({ baselineSnapshotId: "snap-0", currentSnapshotId: "snap-1", findingsArtifactId: "art-abc" });
    expect(ctx.length).toBeLessThanOrEqual(HANDOFF_CONTEXT_MAX_CHARS);
    expect(ctx).toContain("snap-1");
    expect(ctx).toContain("findings artifact art-abc");
    expect(ctx).toContain("divide");
    expect(ctx).not.toContain("FINDINGS:");
    expect(() => buildHandoffContext({ baselineSnapshotId: "snap-0", currentSnapshotId: "", findingsArtifactId: "art-abc" })).toThrow(/requires baseline/);
    expect(() => buildHandoffContext({ baselineSnapshotId: "snap-0", currentSnapshotId: "snap-1", findingsArtifactId: "art-" + "a".repeat(2000) })).toThrow(/must not be truncated/);
    expect(buildPrivacySafeAssessment({ turns: [{ status: {state:"RUNNING"} }] }).turns_completed).toBe(0);
  });

  it("handles large findings (>16 KiB) via read_only_path transport and enforces manifest ACL in real harness", async () => {
    const res = await runNativeFeedback({
      mock: true,
      large_findings: true,
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    const evidence = res.evidence;

    // Delivery mode MUST be authoritatively granted as read_only_path from sealed input manifest
    expect(evidence.findings_artifact.size_bytes).toBeGreaterThan(INLINE_TOTAL_BYTE_CAP);
    expect(evidence.findings_artifact.delivery_mode).toBe("read_only_path");
    expect(evidence.findings_artifact.content_hash).toMatch(/^[0-9a-f]{64}$/);

    // Actual foreign bridge queried this exact sealed findings ID.
    expect(evidence.findings_acl_denial_verified).toBe(true);
    expect(evidence.r2_slot_s2_verified).toBe(true);
  }, 35000);

  it("mock fault injection: R1 failed halts flow, records failed evidence and retains fixture", async () => {
    const res = await runNativeFeedback({
      mock: true,
      mock_fault: "r1_failed",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("failed");
    // Only 2 turns admitted: halted immediately after R1 failure, no Turn 3 or 4
    expect(res.evidence.turns.length).toBe(2);
    expect(res.evidence.turns[1]?.status?.state).toBe("FAILED");

    // Metrics stay honest on failure: admitted vs terminal vs succeeded counts
    expect(res.evidence.metrics.turn_counts).toEqual({ admitted: 2, terminal: 2, succeeded: 1 });
    expectMetricsConsistent(res.evidence.metrics);
    expect(res.evidence.metrics.elapsed_ms_chain).toBeGreaterThan(0);
    expect(res.evidence.turns[1].usage).toEqual({ availability: "unknown", billing_basis: "unknown", measurements: [] });

    // Fixture repo and evidence MUST be retained on disk despite cleanup: true
    expect(existsSync(path.join(res.root, "fixture-repo"))).toBe(true);
    expect(existsSync(path.join(res.root, "evidence.private.json"))).toBe(true);
  }, 35000);

  it("mock fault injection: UNKNOWN state retains fixture root without cleanup and never converts to failed", async () => {
    const res = await runNativeFeedback({
      mock: true,
      mock_fault: "turn_unknown",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    // Evidence status must remain 'unknown', NEVER converted to 'failed'
    expect(res.status).toBe("unknown");
    expect(res.evidence.status).toBe("unknown");

    // Fixture directory is strictly retained on disk
    expect(existsSync(path.join(res.root, "fixture-repo"))).toBe(true);
    expect(existsSync(path.join(res.root, "evidence.private.json"))).toBe(true);
  }, 35000);

  it("mock fault injection: detects and rejects native resume mismatch in real harness", async () => {
    const res = await runNativeFeedback({
      mock: true,
      mock_fault: "bad_resumed_id",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("failed");
    expect(res.evidence.error).toContain("Worker native conversation ref mismatch");
  }, 35000);

  it("mock fault injection: rejects wrong, missing, or invalid reports early", async () => {
    // 1. Missing report
    const resMissing = await runNativeFeedback({
      mock: true,
      mock_fault: "missing_report",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });
    expect(resMissing.status).toBe("failed");
    expect(resMissing.evidence.error).toContain("empty or missing text");

    // 2. Invalid report
    const resInvalid = await runNativeFeedback({
      mock: true,
      mock_fault: "invalid_report",
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });
    expect(resInvalid.status).toBe("failed");
    expect(resInvalid.evidence.error).toContain("invalid or incomplete findings content");
  }, 45000);

  it("graceful disconnect/reconnect during admitted ACTIVE turn retains turn and monotonic events", async () => {
    const res = await runNativeFeedback({
      mock: true,
      mock_fault: "active_disconnect",
      test_active_disconnect: true,
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    expect(res.evidence.active_disconnect_verified).toBe(true);
  }, 35000);

  it("cancellation scenario honestly validates quiescence receipt and terminal outcome", async () => {
    const res = await runNativeFeedback({
      mock: true,
      cancellation_scenario: true,
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    expect(res.evidence.cancellation_quiescence_verified).toBe(false);
    expect(res.evidence.cancellation_mock_terminal_verified).toBe(true);
    expect(res.evidence.cancellation_status).toBe("CANCELLED");
  }, 35000);

  it("explicit daemon restart recovers exact persisted identity without fresh fallback", async () => {
    const res = await runNativeFeedback({
      mock: true,
      test_restart: true,
      cleanup: true,
      runtime_sha: ACCEPTED_RUNTIME_SHA,
    });

    expect(res.status).toBe("passed");
    expect(res.evidence.daemon_restart_verified).toBe(true);
  }, 35000);

  it("stale, missing, or expired artifact references fail admission honestly", async () => {
    const h = createHarness();
    try {
      const worker = await h.spawnWorkerSession();
      const s0 = worker.initial_snapshot_id!;

      // 1. Unknown artifact reference fails admission
      expect(() => {
        h.core.send(h.seed.coordinatorId, {
          session_id: worker.session_id,
          idempotency_key: "send-unknown-art",
          task: { goal: "Task", artifact_refs: ["art-does-not-exist"] },
        });
      }).toThrow();

      // 2. Expired artifact fails admission with ARTIFACT_EXPIRED
      const published = h.publishArtifact("temporary content");
      h.db.raw.prepare("UPDATE artifacts SET state = 'expired', expired_at = 1 WHERE artifact_id = ?").run(published.artifact_id);

      try {
        h.core.send(h.seed.coordinatorId, {
          session_id: worker.session_id,
          idempotency_key: "send-expired-art",
          task: { goal: "Task with expired", artifact_refs: [published.artifact_id] },
        });
        expect.unreachable("expected ARTIFACT_EXPIRED");
      } catch (err: unknown) {
        expect((err as BrokerError).code).toBe("ARTIFACT_EXPIRED");
      }
    } finally {
      h.cleanup();
    }
  });

  it("scripts/native-feedback.mjs exports, route validation, root anti-adoption, and privacy-safe assessment", () => {
    // 1. Allowed routes in mock/development mode
    expect(() => validateRouteConfig({ provider: "mock", model: "mock-model" }, "worker")).not.toThrow();
    expect(() => validateRouteConfig({ provider: "zcode", model: "GLM-5.3-Flash", effort: "high" }, "worker")).not.toThrow();
    expect(() => validateRouteConfig({ provider: "antigravity", model: "gemini-3.8-flash", effort: "high" }, "worker")).not.toThrow();
    expect(() => validateRouteConfig({ provider: "cursor", model: "claude-3-7-sonnet" }, "worker")).not.toThrow();

    // 2. Forbidden routes: Claude and Codex
    expect(() => validateRouteConfig({ provider: "claude", model: "claude-3" }, "worker")).toThrow(/disallowed/i);
    expect(() => validateRouteConfig({ provider: "codex", model: "o3" }, "worker")).toThrow(/disallowed/i);

    // 3. Unauthorized routes
    expect(() => validateRouteConfig({ provider: "openai", model: "gpt-4" }, "worker")).toThrow(/unauthorized/i);

    // 4. Missing explicit model/effort in production
    expect(() => validateRouteConfig({ provider: "zcode" }, "worker")).toThrow(/explicit model/i);
    expect(() => validateRouteConfig({ provider: "zcode", model: "m" }, "worker", true)).toThrow(/explicit effort/i);

    // 5. Production config requires accepted SHA (rejects HEAD or missing)
    expect(() => validateProductionConfig({ mock: false, provider: "zcode", model: "m", effort: "high" })).toThrow(/explicit full 40 or 64 hex/i);
    expect(() => validateProductionConfig({ mock: false, runtime_sha: "HEAD", provider: "zcode", model: "m", effort: "high" })).toThrow(/explicit full 40 or 64 hex/i);
    expect(() => validateProductionConfig({ mock: false, runtime_sha: "a".repeat(40), provider: "zcode", model: "m", effort: "high" })).toThrow(/does not match accepted SHA/i);

    // 6. Root anti-adoption: caller arbitrary root cannot be adopted
    expect(() => validateProductionConfig({ mock: false, runtime_sha: ACCEPTED_RUNTIME_SHA, root: "C:\\arbitrary" })).toThrow(/refusing custom root/i);

    // 7. Privacy-safe assessment contains limitations and no reasoning/thinking/credentials
    const assessment = buildPrivacySafeAssessment({
      name: "test-assessment",
      status: "passed",
      startedAt: "2026-10-01T00:00:00Z",
      finishedAt: "2026-10-01T00:01:00Z",
      feedback_mode: "handoff",
      routes: [{ role: "worker", provider: "mock", model: "mock-model" }],
      turns: Array.from({ length: 4 }, () => ({ status: {state:"SUCCEEDED"} })),
      snapshots: { s0: "snap-0", s1: "snap-1", s2: "snap-2" },
      findings_artifact: {
        artifact_id: "art-findings",
        size_bytes: 120,
        content_hash: "hash123",
        delivery_mode: "inline",
      },
      handoff_context: `Coordinator handoff for a fresh continuation session. Required input is findings artifact art-findings delivered by the broker.`,
      fresh_worker: { session_id: "session-b", native_ref_observed: "ref-worker-2" },
      workerNativeRef: "ref-worker",
      reviewerNativeRef: "ref-reviewer",
      sameWorkerConversation: true,
      sameReviewerConversation: true,
      metrics: {
        calls_total: 30,
        calls_failed: 1,
        result_bytes_total: 24000,
        turn_counts: { admitted: 4, terminal: 4, succeeded: 4 },
        elapsed_ms_chain: 60000,
      },
      offline_checks: [{ name: "node_test", ok: true }, { name: "git_status", ok: true }],
    });

    expect(assessment.status).toBe("passed");
    expect(assessment.turns_completed).toBe(4);
    expect(assessment.feedback_mode).toBe("handoff");
    expect(assessment.artifact_chain.handoff_artifact_id).toBe("art-findings");
    expect(assessment.continuity.same_worker_conversation).toBe(true);
    expect(assessment.continuity.fresh_worker_conversation).toBe(true);
    expect(assessment.metrics).toEqual({
      calls_total: 30,
      calls_failed: 1,
      result_bytes_total: 24000,
      turn_counts: { admitted: 4, terminal: 4, succeeded: 4 },
      elapsed_ms_chain: 60000,
    });
    expect(assessment.all_checks_passed).toBe(true);
    expect(assessment.limitations.length).toBeGreaterThan(0);
    expect(assessment.limitations.some((l: string) => l.includes("cannot establish relative savings"))).toBe(true);

    const jsonStr = JSON.stringify(assessment);
    expect(jsonStr).not.toContain("thinking");
    expect(jsonStr).not.toContain("reasoning");
    expect(jsonStr).not.toContain("password");
    expect(jsonStr).not.toContain("token");

    // 8. Role instructions are mode-invariant: no initial-only fixture steps,
    //    so a fresh FIX session receives persistent FIX instruction semantics.
    expect(WORKER_SESSION_INSTRUCTIONS).not.toContain("obsolete");
    expect(WORKER_SESSION_INSTRUCTIONS).not.toContain("deliberately");
    expect(WORKER_SESSION_INSTRUCTIONS).toContain("coordinator-owned controls");
    expect(REVIEWER_SESSION_INSTRUCTIONS).toContain("Independent read-only review");
  });
});


describe("Feedback evidence defensive bounds", () => {
  const page = (text: string) => ({artifact_id:"art-x",content_type:"text",kind:"findings",state:"active",size_bytes:Buffer.byteLength(text),offset:0,bytes_read:Buffer.byteLength(text),next_offset:Buffer.byteLength(text),truncated:false,data:text});
  it("requires complete consistent artifact delivery and preserves UTF8 hash", async () => {
    const text="\u0417\u0432\u0456\u0442 \ud83d\ude80";
    const result=await readFullArtifact(async()=>page(text),"art-x");
    expect(result.text).toBe(text);
    expect(result.size_bytes).toBe(Buffer.byteLength(text));
    for (const change of [{artifact_id:"wrong"},{size_bytes:999},{bytes_read:1},{next_offset:1},{truncated:true},{content_type:"binary"},{data:null}]) {
      await expect(readFullArtifact(async()=>({...page(text),...change}),"art-x")).rejects.toThrow();
    }
    await expect(readFullArtifact(async()=>page("<thinking>private</thinking>"),"art-x")).rejects.toThrow(/withheld/);
  });
  it("refuses metadata changes and no-progress pages", async () => {
    let calls=0;
    await expect(readFullArtifact(async()=> (++calls===1 ? {...page("a"),size_bytes:2,truncated:true} : {...page("b"),size_bytes:3,offset:1,next_offset:2,truncated:true}),"art-x")).rejects.toThrow(/changed/);
    await expect(readFullArtifact(async()=>({...page(""),size_bytes:2,truncated:true}),"art-x")).rejects.toThrow(/no progress/);
  });
  it("close failures and unresolved children prevent fixture cleanup", () => {
    const evidence={status:"passed",turns:[{status:{state:"SUCCEEDED"}}],sessionsClosed:true,daemonCompleted:true,bridgeCompleted:true,offline_checks:[{ok:true}]};
    expect(canPerformCleanup(evidence,{cleanup:true})).toBe(true);
    expect(canPerformCleanup({...evidence,closeError:"denied"},{cleanup:true})).toBe(false);
    expect(canPerformCleanup({...evidence,unresolvedChildren:true},{cleanup:true})).toBe(false);
  });
});


it("mock mode rejects mixed native routes before any runtime/fixture allocation", async () => {
  expect(()=>validateProductionConfig({mock:true,provider:"cursor",model:"auto"})).toThrow(/Mock mode forbids native/);
  expect(()=>validateProductionConfig({mock:true,provider:"mock",reviewer_provider:"zcode"})).toThrow(/Mock mode forbids native/);
  await expect(runNativeFeedback({mock:true,provider:"antigravity",model:"gemini-3.8-flash-high"})).rejects.toThrow(/Mock mode forbids native/);
  expect(()=>validateProductionConfig({mock:true,deadline_ms:Infinity})).toThrow(/deadline/);
});
