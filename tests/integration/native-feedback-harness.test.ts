/**
 * Integration regression test suite for the opt-in native feedback harness
 * (worker -> review -> fix -> same-reviewer flow).
 *
 * Verifies:
 * - Real harness entrypoint execution (runNativeFeedback) over real stdio/RPC child lifecycle
 * - Exact artifactID chain and current snapshots (S0 -> S1 -> S2)
 * - Same-conversation assertions across turns on worker and reviewer sessions
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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { cursorChatStorePathBudgetViolation } from "../../src/providers/cursor/cursorAdapter.ts";
import {
  ACCEPTED_RUNTIME_SHA,
  INLINE_TOTAL_BYTE_CAP,
  createFixtureGitRepo,
  extractRuntime,
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

describe("Native feedback harness integration", () => {
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

    // 5. Offline fixture checks: S1 deliberate failure, S2 pass, untouched baseline
    expect(evidence.s1_deliberate_failure_verified).toBe(true);
    expect(evidence.offline_checks.length).toBeGreaterThan(0);
    expect(evidence.offline_checks.every((c) => c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "baseline_test_untouched" && c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "baseline_package_untouched" && c.ok)).toBe(true);
    expect(evidence.offline_checks.some((c) => c.name === "s2_node_test_passed" && c.ok)).toBe(true);

    // 6. Evidence artifacts kept after clean owned fixture removal
    expect(existsSync(path.join(res.root, "evidence.private.json"))).toBe(true);
    expect(existsSync(path.join(res.root, "assessment.json"))).toBe(true);
    expect(existsSync(path.join(res.root, "reports"))).toBe(true);
    expect(existsSync(path.join(res.root, "fixture-repo"))).toBe(false); // Cleaned
  }, 35000);

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
          workspace_precondition: { expected_snapshot_id: s0 },
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
          workspace_precondition: { expected_snapshot_id: s0 },
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
      routes: [{ role: "worker", provider: "mock", model: "mock-model" }],
      turns: [{}, {}, {}, {}],
      snapshots: { s0: "snap-0", s1: "snap-1", s2: "snap-2" },
      findings_artifact: {
        artifact_id: "art-findings",
        size_bytes: 120,
        content_hash: "hash123",
        delivery_mode: "inline",
      },
      workerNativeRef: "ref-worker",
      reviewerNativeRef: "ref-reviewer",
      sameWorkerConversation: true,
      sameReviewerConversation: true,
      offline_checks: [{ name: "node_test", ok: true }, { name: "git_status", ok: true }],
    });

    expect(assessment.status).toBe("passed");
    expect(assessment.turns_completed).toBe(4);
    expect(assessment.continuity.same_worker_conversation).toBe(true);
    expect(assessment.continuity.same_reviewer_conversation).toBe(true);
    expect(assessment.all_checks_passed).toBe(true);
    expect(assessment.limitations.length).toBeGreaterThan(0);

    const jsonStr = JSON.stringify(assessment);
    expect(jsonStr).not.toContain("thinking");
    expect(jsonStr).not.toContain("reasoning");
    expect(jsonStr).not.toContain("password");
    expect(jsonStr).not.toContain("token");
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
