/**
 * Shared quota-scope cooldown: learned ONLY from a definitive native
 * QUOTA_EXHAUSTED report, shared across sessions/projects bound to one quota
 * scope, enforced at send admission and re-checked immediately before
 * dispatch, persistent across restart, clearable by the operator.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEFAULT_QUOTA_COOLDOWN_MS,
  MAX_VENDOR_RESET_MS,
  activeQuotaCooldown,
  clearQuotaCooldown,
  listActiveQuotaCooldowns,
  parseVendorResetMs,
  recordQuotaCooldown,
} from "../../src/core/quotaCooldown.ts";
import { openRegistryDb } from "../../src/storage/db.ts";
import { insertProject, insertWorkspace } from "../../src/storage/repo.ts";
import { BrokerError, createHarness, settle, start } from "../helpers/harness.ts";

const QUOTA_MESSAGE = "Individual quota reached. Please upgrade your subscription to Gemini Code Assist to continue. Resets in 54m59s.";

describe("vendor reset suffix parsing", () => {
  it("parses strict h/m/s suffixes into bounded retry_after_ms", () => {
    expect(parseVendorResetMs(QUOTA_MESSAGE)).toBe(54 * 60_000 + 59_000);
    expect(parseVendorResetMs("quota reached. Resets in 1h2m3s.")).toBe(3_723_000);
    expect(parseVendorResetMs("Resets in 45s.")).toBe(45_000);
    expect(parseVendorResetMs("Resets in 24h.")).toBe(MAX_VENDOR_RESET_MS);
    expect(parseVendorResetMs("resets in 10m30s.")).toBe(630_000);
  });

  it("rejects absent, malformed, non-positive, or oversized durations", () => {
    expect(parseVendorResetMs(undefined)).toBeNull();
    expect(parseVendorResetMs(null)).toBeNull();
    expect(parseVendorResetMs("Individual quota reached. Please upgrade your subscription.")).toBeNull();
    expect(parseVendorResetMs("quota exhausted, please wait")).toBeNull();
    expect(parseVendorResetMs("Resets in 90.")).toBeNull();
    expect(parseVendorResetMs("Resets in 0s.")).toBeNull();
    expect(parseVendorResetMs("Resets in 25h.")).toBeNull();
    expect(parseVendorResetMs("Resets soon")).toBeNull();
    expect(parseVendorResetMs("Resets in 1h 2m.")).toBeNull();
    expect(parseVendorResetMs("Resets in 10m nonsense.")).toBeNull();
  });
});

describe("cooldown storage", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records the conservative 15-minute policy when no vendor suffix parses", () => {
    const db = openRegistryDb(":memory:");
    try {
      const pause = recordQuotaCooldown(db, {
        quotaScopeId: "qs-a", provider: "antigravity", turnId: "turn-1",
        detail: "Individual quota reached. Please upgrade your subscription.", now: 1_000_000,
      });
      expect(pause.retry_after_ms).toBe(DEFAULT_QUOTA_COOLDOWN_MS);
      expect(pause.source).toBe("conservative_policy");
      expect(pause.until_ms).toBe(1_000_000 + DEFAULT_QUOTA_COOLDOWN_MS);
      expect(activeQuotaCooldown(db, "qs-a", 1_000_001)).toMatchObject({ quota_scope_id: "qs-a" });
      expect(activeQuotaCooldown(db, "qs-a", pause.until_ms)).toBeNull();
      expect(activeQuotaCooldown(db, "qs-other", 1_000_001)).toBeNull();
    } finally { db.close(); }
  });

  it("prefers a valid vendor suffix, extends a longer active pause, and never shortens one", () => {
    const db = openRegistryDb(":memory:");
    try {
      const vendor = recordQuotaCooldown(db, {
        quotaScopeId: "qs-a", provider: "antigravity", turnId: "turn-1",
        detail: QUOTA_MESSAGE, now: 1_000_000,
      });
      expect(vendor.source).toBe("vendor_reset_suffix");
      expect(vendor.retry_after_ms).toBe(3_299_000);

      // A shorter later estimate never shortens the active pause.
      const shortened = recordQuotaCooldown(db, {
        quotaScopeId: "qs-a", provider: "antigravity", turnId: "turn-2",
        detail: "Resets in 1m.", now: 1_000_500,
      });
      expect(shortened.until_ms).toBe(vendor.until_ms);
      expect(activeQuotaCooldown(db, "qs-a", 1_000_500)).toMatchObject({ recorded_by_turn_id: "turn-1" });

      // A longer estimate extends the pause.
      const extended = recordQuotaCooldown(db, {
        quotaScopeId: "qs-a", provider: "antigravity", turnId: "turn-3",
        detail: "Resets in 2h.", now: 1_000_600,
      });
      expect(extended.until_ms).toBe(1_000_600 + 7_200_000);
      expect(listActiveQuotaCooldowns(db, 1_000_600)).toHaveLength(1);
    } finally { db.close(); }
  });

  it("persists across a close/reopen (daemon restart) and clears explicitly", () => {
    const root = mkdtempSync(path.join(tmpdir(), "broker-quota-cooldown-"));
    roots.push(root);
    const dbPath = path.join(root, "registry.sqlite");
    const first = openRegistryDb(dbPath);
    recordQuotaCooldown(first, {
      quotaScopeId: "qs-shared", provider: "mock", turnId: "turn-1",
      detail: QUOTA_MESSAGE, now: 5_000,
    });
    first.close();

    const second = openRegistryDb(dbPath);
    try {
      const pause = activeQuotaCooldown(second, "qs-shared", 6_000);
      expect(pause).not.toBeNull();
      expect(pause?.until_ms).toBe(5_000 + 3_299_000);
      expect(clearQuotaCooldown(second, "qs-shared", 6_000)).toBe(true);
      expect(clearQuotaCooldown(second, "qs-shared", 6_000)).toBe(false);
      expect(activeQuotaCooldown(second, "qs-shared", 6_000)).toBeNull();
    } finally { second.close(); }
  });
});

describe("shared quota-scope pause enforcement (fake quota event)", () => {
  it("pauses the scope after a definitive QUOTA_EXHAUSTED: zero dispatch across sessions and projects, replay wins, rejected keys reuse after expiry", async () => {
    const h = createHarness();
    const secondRoot = mkdtempSync(path.join(tmpdir(), "broker-quota-ws-"));
    try {
      // A second project whose session shares the SAME quota scope via
      // acct-mock-2, plus a session on an unrelated scope in that project.
      insertProject(h.db, {
        project_id: "project-second", display_name: "Second",
        configuration_revision: 1, session_cap: 20, created_at: h.clock.now(),
      });
      const secondWorkspace = path.join(secondRoot, "ws-second");
      mkdirSync(path.join(secondWorkspace, "src"), { recursive: true });
      writeFileSync(path.join(secondWorkspace, "src", "main.c"), "int main(){return 0;}\n", "utf8");
      insertWorkspace(h.db, {
        workspace_id: "ws-second", project_id: "project-second", mode: "current",
        canonical_path: secondWorkspace, quarantined: false, quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      h.db.raw.prepare("UPDATE coordinator_profiles SET allowed_project_ids = ? WHERE coordinator_id = ?")
        .run(JSON.stringify([h.seed.projectId, "project-second"]), h.seed.coordinatorId);

      const accountA = await h.spawnWorkerSession({ account_profile_id: h.seed.accountMock1 });
      const accountB = await h.spawnWorkerSession({ account_profile_id: h.seed.accountMock2SameQuota });
      const otherScope = await h.spawnWorkerSession({
        account_profile_id: h.seed.accountMock3OtherQuota,
        project_id: "project-second",
        workspace: { mode: "current", workspace_id: "ws-second" },
      });

      // Turn 1 completes so session A carries a native ref (resume path).
      const first = h.sendTask(accountA.session_id, "a1");
      await start(h, first);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, first.turn_id).state).toBe("SUCCEEDED");

      // Turn 2: the provider definitively reports individual quota exhaustion
      // after dispatch (resume failure post-permission) with a vendor reset.
      const quotaTurn = h.sendTask(accountA.session_id, "a2");
      h.adapter.plan(quotaTurn.turn_id, [{
        kind: "resume_failure",
        error: new BrokerError("QUOTA_EXHAUSTED", QUOTA_MESSAGE, { executionStarted: true }),
      }]);
      await start(h, quotaTurn);
      await settle(h);

      const failed = h.core.turnStatus(h.seed.coordinatorId, quotaTurn.turn_id);
      expect(failed.state).toBe("FAILED");
      expect(failed.error_code).toBe("QUOTA_EXHAUSTED");
      expect(failed.execution_started).toBe(true);

      const pause = activeQuotaCooldown(h.db, "qs-shared", h.clock.now());
      expect(pause).not.toBeNull();
      expect(pause?.retry_after_ms).toBe(3_299_000);
      expect(pause?.source).toBe("vendor_reset_suffix");
      expect(pause?.recorded_by_turn_id).toBe(quotaTurn.turn_id);

      // A same-key replay of the earlier SUCCESSFUL send still wins over the pause.
      const replay = h.sendTask(accountA.session_id, "a1");
      expect(replay.turn_id).toBe(first.turn_id);
      expect(replay.replayed_request).toBe(true);

      // The unrelated quota scope keeps working across projects.
      const otherTurn = h.sendTask(otherScope.session_id, "c1");
      expect(otherTurn.state).toBe("ACCEPTED");
      h.adapter.plan(otherTurn.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, otherTurn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, otherTurn.turn_id).state).toBe("SUCCEEDED");

      // A NEW send in the paused scope is rejected before any turn exists.
      let rejected: unknown;
      try { h.sendTask(accountB.session_id, "b1"); } catch (error) { rejected = error; }
      expect(rejected).toBeInstanceOf(BrokerError);
      const brokerRejected = rejected as BrokerError;
      expect(brokerRejected.code).toBe("QUOTA_EXHAUSTED");
      expect(brokerRejected.executionStarted).toBe(false);
      expect(brokerRejected.details).toMatchObject({
        quota_scope_id: "qs-shared",
        source: "vendor_reset_suffix",
      });
      expect(h.db.raw.prepare("SELECT COUNT(*) AS c FROM turns WHERE idempotency_key = 'b1'").get())
        .toMatchObject({ c: 0 });

      // The failed turn's own key replays the recorded FAILED turn — expiry
      // permits new EXPLICIT tasks, never an automatic replay.
      const failedReplay = h.sendTask(accountA.session_id, "a2");
      expect(failedReplay.turn_id).toBe(quotaTurn.turn_id);
      expect(failedReplay.replayed_request).toBe(true);

      // After expiry the rejected key is reusable and work flows again.
      h.clock.advance(3_300_000);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();
      const reused = h.sendTask(accountB.session_id, "b1");
      expect(reused.state).toBe("ACCEPTED");
      h.adapter.plan(reused.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, reused);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, reused.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("re-checks the pause immediately before dispatch so already accepted work cannot bypass it", async () => {
    const h = createHarness();
    try {
      const accountB = await h.spawnWorkerSession({ account_profile_id: h.seed.accountMock2SameQuota });
      // Accepted while the scope is clean.
      const accepted = h.sendTask(accountB.session_id, "bg");
      expect(accepted.state).toBe("ACCEPTED");
      h.adapter.plan(accepted.turn_id, [{ kind: "complete", outcome: "completed" }]);

      // A pause is learned elsewhere in the same scope BEFORE dispatch starts.
      recordQuotaCooldown(h.db, {
        quotaScopeId: "qs-shared", provider: "mock", turnId: "turn-external",
        detail: "Individual quota reached. Resets in 30m.", now: h.clock.now(),
      });

      await start(h, accepted);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("QUOTA_EXHAUSTED");
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(accepted.turn_id)).not.toBe(true);
      expect(h.adapter.executedSteps(accepted.turn_id)).toContain("dispatch_refused");

      // The pre-dispatch refusal must NOT re-record or extend the pause.
      const pause = activeQuotaCooldown(h.db, "qs-shared", h.clock.now());
      expect(pause?.recorded_by_turn_id).toBe("turn-external");
    } finally { h.cleanup(); }
  });

  it("never records a pause for plain timeouts, cancellations, or pre-dispatch quota errors", async () => {
    const h = createHarness();
    try {
      const session = await h.spawnWorkerSession();

      // Plain timeout: deadline supervision wins, no quota pause.
      const timedOut = h.sendTask(session.session_id, "t1", "Slow work.", { deadline_ms: 1_000 });
      h.adapter.plan(timedOut.turn_id, [
        { kind: "report_native_ref", ref: "mock-native-timeout" },
        { kind: "barrier", name: "hold-timeout" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, timedOut);
      h.clock.advance(1_500);
      h.executor.scanDeadlines();
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, timedOut.turn_id).state).toBe("TIMED_OUT");
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();

      // Pre-dispatch startup refusal carrying a quota code: execution never
      // started, so nothing definitive was observed — no pause.
      const startup = h.sendTask(session.session_id, "t2", "Again.", { deadline_ms: 3_600_000 });
      h.adapter.plan(startup.turn_id, [{
        kind: "startup_failure",
        error: new BrokerError("QUOTA_EXHAUSTED", "Individual quota reached. Resets in 5m.", { executionStarted: false }),
      }]);
      await start(h, startup);
      await settle(h);
      const startupTurn = h.core.turnStatus(h.seed.coordinatorId, startup.turn_id);
      expect(startupTurn.state).toBe("FAILED");
      expect(startupTurn.termination_reason).toBe("startup_failure");
      expect(startupTurn.execution_started).toBe(false);
      expect(activeQuotaCooldown(h.db, "qs-shared", h.clock.now())).toBeNull();

      // A quota-scope pause stays scoped: the unrelated scope never blocks.
      expect(activeQuotaCooldown(h.db, "qs-other", h.clock.now())).toBeNull();
      expect(listActiveQuotaCooldowns(h.db, h.clock.now())).toHaveLength(0);
    } finally { h.cleanup(); }
  });
});
