/**
 * P1 acceptance subset (spec §18): A01–A04, A40–A42, A44–A45 subset, INV-01..03.
 * All mock-level, no inference.
 */
import { describe, expect, it } from "vitest";
import { createHarness, settle, settleTurn, start } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { canonicalize, canonicalRequestHash } from "../../src/shared/canonicalize.ts";

function expectBrokerError(fn: () => unknown, code: string): BrokerError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

async function expectBrokerErrorAsync(fn: () => Promise<unknown>, code: string): Promise<BrokerError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

// ─── canonicalization (§7.3) ─────────────────────────────────────────────────

describe("canonical request hash", () => {
  it("key order does not matter, array order does", () => {
    const a = canonicalRequestHash({ task: { goal: "g", refs: ["x", "y"] }, session: "s" });
    const b = canonicalRequestHash({ session: "s", task: { refs: ["x", "y"], goal: "g" } });
    expect(a).toBe(b);
    const c = canonicalRequestHash({ session: "s", task: { refs: ["y", "x"], goal: "g" } });
    expect(a).not.toBe(c);
  });

  it("undefined properties are dropped, null preserved", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe(canonicalize({ b: null }));
    expect(canonicalize({ a: 1 })).not.toBe(canonicalize({ a: null }));
  });

  it("byte-exact strings: whitespace matters", () => {
    expect(canonicalRequestHash({ goal: "abc" })).not.toBe(canonicalRequestHash({ goal: "abc " }));
  });
});

// ─── spawn idempotency (A01) ─────────────────────────────────────────────────

describe("A01: spawn replay after lost response", () => {
  it("returns one session ID and does not duplicate provisioning", () => {
    const h = createHarness();
    const req = {
      project_id: h.seed.projectId,
      idempotency_key: "create-worker-001",
      provider: "mock",
      account_profile_id: h.seed.accountMock1,
      model: "mock-model-1",
      effort: null,
      role: "worker" as const,
      instructions: "Implement bounded tasks.",
      workspace: { mode: "current" as const, workspace_id: h.seed.workspaceMain },
      policy_profile_id: "pol-writer",
    };
    const first = h.core.spawn(h.seed.coordinatorId, req);
    const second = h.core.spawn(h.seed.coordinatorId, req);
    expect(second.session_id).toBe(first.session_id);
    expect(second.replayed_request).toBe(true);
    expect(second.state).toBe("IDLE");
    expect(second.initial_snapshot_id).toBeNull();

    const sessions = h.core.sessionsList(h.seed.coordinatorId, h.seed.projectId);
    expect(sessions).toHaveLength(1);
    const events = h.db.raw.prepare("SELECT COUNT(*) c FROM events WHERE type='session_provisioned'").get() as { c: number };
    expect(events.c).toBe(1);
  });
});

// ─── send idempotency + lifecycle (A02–A04) ─────────────────────────────────

describe("send admission and lifecycle", () => {
  it("A02: same key replay after mutable state change returns the same turn", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const turn1 = h.sendTask(spawn.session_id, "impl-001");
    h.adapter.plan(turn1.turn_id, [
      { kind: "barrier", name: "hold-1" },
      { kind: "complete", outcome: "completed", summary: "done" },
    ]);
    await start(h, turn1);
    // Mutable state changed (turn RUNNING, session ACTIVE) — replay must not
    // be masked by SESSION_BUSY (§7.2 step 4).
    const replay = h.sendTask(spawn.session_id, "impl-001");
    expect(replay.turn_id).toBe(turn1.turn_id);
    expect(replay.replayed_request).toBe(true);

    h.adapter.releaseBarrier("hold-1");
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, turn1.turn_id).state).toBe("SUCCEEDED");
  });

  it("A03: same key with different goal → IDEMPOTENCY_CONFLICT, no execution", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const turn1 = h.sendTask(spawn.session_id, "impl-001", "Goal A");
    await start(h, turn1);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, turn1.turn_id).state).toBe("SUCCEEDED");

    expectBrokerError(() => h.sendTask(spawn.session_id, "impl-001", "Goal B"), "IDEMPOTENCY_CONFLICT");
    const turns = h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
    expect(turns.c).toBe(1);
  });

  it("A04: two different keys on one session → one turn, second SESSION_BUSY", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const turn1 = h.sendTask(spawn.session_id, "impl-001");
    h.adapter.plan(turn1.turn_id, [
      { kind: "progress", label: "resumed" },
      { kind: "barrier", name: "hold-1" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, turn1);
    expect(h.core.turnStatus(h.seed.coordinatorId, turn1.turn_id).state).toBe("RUNNING");

    expectBrokerError(() => h.sendTask(spawn.session_id, "impl-002"), "SESSION_BUSY");
    h.adapter.releaseBarrier("hold-1");
    await settle(h);
  });

  it("happy path: two turns continue the same native conversation", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();

    const t1 = h.sendTask(spawn.session_id, "t1");
    await start(h, t1);
    await settle(h);
    const turn1 = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn1.state).toBe("SUCCEEDED");
    expect(turn1.continuation).toBe("new_native_conversation");
    expect(turn1.native_conversation_ref).toBeTruthy();
    expect(turn1.execution_started).toBe(true);

    const t2 = h.sendTask(spawn.session_id, "t2");
    await start(h, t2);
    await settle(h);
    const turn2 = h.core.turnStatus(h.seed.coordinatorId, t2.turn_id);
    expect(turn2.state).toBe("SUCCEEDED");
    expect(turn2.continuation).toBe("native_resume");
    expect(turn2.native_conversation_ref).toBe(turn1.native_conversation_ref);

    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("IDLE");
    expect(session.context_status).toBe("available");
  });

  it("INV-01: DB forbids a second nonterminal turn per session", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "hold" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, t1);
    expect(() =>
      h.db.raw
        .prepare(
          `INSERT INTO turns (turn_id, session_id, project_id, owner_coordinator_id, idempotency_key,
           request_hash, state, state_version, created_at, updated_at)
           VALUES ('turn-x2', ?, ?, 'coord-1', 'k2', 'h2', 'ACCEPTED', 1, 1, 1)`,
        )
        .run(spawn.session_id, h.seed.projectId),
    ).toThrow(/UNIQUE/);
    h.adapter.releaseBarrier("hold");
    await settle(h);
  });
});

// ─── concurrency: A40/A41 ────────────────────────────────────────────────────

describe("A40/A41: concurrent same-key sends", () => {
  it("A40: 50 same-key/same-payload sends converge to one turn", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const results = Array.from({ length: 50 }, () => h.sendTask(spawn.session_id, "concurrent-key"));
    const ids = new Set(results.map((r) => r.turn_id));
    expect(ids.size).toBe(1);
    const replays = results.filter((r) => r.replayed_request);
    expect(replays.length).toBe(49);
    await start(h, results[0]!);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, results[0]!.turn_id).state).toBe("SUCCEEDED");
    expect(h.adapter.dispatchPermissionAcquired(results[0]!.turn_id)).toBe(true);
  });

  it("A41: same key with different payloads → conflict, one accepted", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const winner = h.sendTask(spawn.session_id, "race-key", "Goal A");
    const conflicts = Array.from({ length: 10 }, () => {
      try {
        h.sendTask(spawn.session_id, "race-key", "Goal B");
        return false;
      } catch {
        return true;
      }
    });
    expect(conflicts.every(Boolean)).toBe(true);
    await start(h, winner);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, winner.turn_id).state).toBe("SUCCEEDED");
    const turns = h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number };
    expect(turns.c).toBe(1);
  });
});

// ─── ACL (A29, A42) ──────────────────────────────────────────────────────────

describe("authorization", () => {
  it("A29: foreign coordinator gets UNAUTHORIZED without disclosure", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    expectBrokerError(() => h.core.sessionStatus(h.seed.outsiderId, spawn.session_id), "UNAUTHORIZED");
    expectBrokerError(
      () =>
        h.core.send(h.seed.outsiderId, {
          session_id: spawn.session_id,
          idempotency_key: "x",
          task: { goal: "g", artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: "s" },
        }),
      "UNAUTHORIZED",
    );
    expectBrokerError(
      () =>
        h.core.spawn(h.seed.outsiderId, {
          project_id: h.seed.projectId,
          idempotency_key: "y",
          provider: "mock",
          account_profile_id: h.seed.accountMock1,
          model: "m",
          effort: null,
          role: "worker",
          instructions: "i",
          workspace: { mode: "current", workspace_id: null },
          policy_profile_id: "pol-writer",
        }),
      "UNAUTHORIZED",
    );
  });

  it("A42: revoked coordinator cannot replay an accepted operation", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    await start(h, t1);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

    h.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = ?").run(h.seed.coordinatorId);
    expectBrokerError(() => h.sendTask(spawn.session_id, "t1"), "UNAUTHORIZED");
    expectBrokerError(() => h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id), "UNAUTHORIZED");
  });
});

// ─── capacity / workspace leases (A05 subset, A23 subset, §15.1) ─────────────

describe("capacity admission", () => {
  it("A23: two accounts sharing a quota scope share capacity", async () => {
    const h = createHarness({ limits: { globalUnfinishedTurns: 10 } });
    const s1 = await h.spawnWorkerSession();
    const s2 = await h.spawnWorkerSession({ account_profile_id: h.seed.accountMock2SameQuota });

    const t1 = h.sendTask(s1.session_id, "a");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "hold-quota" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, t1);

    // Same quota scope (cap 1) → RESOURCE_BUSY even for another account alias.
    expectBrokerError(() => h.sendTask(s2.session_id, "b"), "RESOURCE_BUSY");
    // A different quota scope (and a different workspace) is fine.
    const s3 = await h.spawnWorkerSession({
      account_profile_id: h.seed.accountMock3OtherQuota,
      workspace: { mode: "current", workspace_id: "ws-other" },
    });
    const t3 = h.sendTask(s3.session_id, "c");
    await start(h, t3);
    await settleTurn(h, t3.turn_id);
    expect(h.core.turnStatus(h.seed.coordinatorId, t3.turn_id).state).toBe("SUCCEEDED");

    h.adapter.releaseBarrier("hold-quota");
    await settle(h);
  });

  it("A05: second writer on the same workspace → WORKSPACE_BUSY", async () => {
    const h = createHarness({ limits: { globalUnfinishedTurns: 10, quotaScopeUnfinishedTurns: 10 } });
    const s1 = await h.spawnWorkerSession();
    const s2 = await h.spawnWorkerSession();
    const t1 = h.sendTask(s1.session_id, "a");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "hold-ws" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, t1);
    expectBrokerError(() => h.sendTask(s2.session_id, "b"), "WORKSPACE_BUSY");
    h.adapter.releaseBarrier("hold-ws");
    await settle(h);
    // After quiescence the lease is released and the second writer proceeds.
    const t2 = h.sendTask(s2.session_id, "b2");
    await start(h, t2);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
  });

  it("session slot cap counts open sessions and is freed by close", async () => {
    const h = createHarness({ sessionCap: 2 });
    const s1 = await h.spawnWorkerSession();
    const s2 = await h.spawnWorkerSession();
    await expectBrokerErrorAsync(async () => h.spawnWorkerSession(), "RESOURCE_BUSY");

    h.core.stop(h.seed.coordinatorId, { session_id: s1.session_id, idempotency_key: "stop-1" });
    await settle(h);
    expect(h.core.sessionStatus(h.seed.coordinatorId, s1.session_id).state).toBe("CLOSED");

    const s3 = await h.spawnWorkerSession();
    expect(s3.state).toBe("IDLE");
    void s2;
  });
});

// ─── guarded close (A43, A44, A52 subset) ────────────────────────────────────

describe("guarded close", () => {
  it("A43: IDLE session closes safely; cap released exactly once", async () => {
    const h = createHarness({ sessionCap: 1 });
    const spawn = await h.spawnWorkerSession();
    const stop = h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" });
    expect(stop.close_state).toBe("pending");
    await settle(h);

    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("CLOSED");
    expect(session.close_state).toBe("completed");

    expectBrokerError(() => h.sendTask(spawn.session_id, "after-close"), "SESSION_CLOSED");

    const replay = h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" });
    expect(replay.replayed_request).toBe(true);
    expect(replay.state).toBe("CLOSED");

    const next = await h.spawnWorkerSession();
    expect(next.state).toBe("IDLE");
  });

  it("A44: stop with an active turn → ACTIVE_TURN; resources retained", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "hold-close" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, t1);

    expectBrokerError(
      () => h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" }),
      "ACTIVE_TURN",
    );
    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("ACTIVE");
    expect(session.close_state).toBe("none");

    h.adapter.releaseBarrier("hold-close");
    await settle(h);
  });

  it("A44: stop on UNKNOWN turn → EXECUTION_UNKNOWN, no close", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "pre-crash" },
      { kind: "hang" },
    ]);
    await start(h, t1);
    h.adapter.releaseBarrier("pre-crash");
    await h.executor.forceUnknownForTest(t1.turn_id, new Error("simulated crash window"));
    const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn.state).toBe("UNKNOWN");

    expectBrokerError(
      () => h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" }),
      "EXECUTION_UNKNOWN",
    );
    expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("BLOCKED");
  });

  it("A52: close intent bans send; concurrent send either wins atomically", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" });
    expectBrokerError(() => h.sendTask(spawn.session_id, "during-close"), "SESSION_CLOSING");
    expectBrokerError(
      () => h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-2" }),
      "SESSION_CLOSING",
    );
    const replay = h.core.stop(h.seed.coordinatorId, { session_id: spawn.session_id, idempotency_key: "stop-1" });
    expect(replay.replayed_request).toBe(true);
    await settle(h);
    expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("CLOSED");
  });
});

// ─── cancellation / crash windows (A45 subset, A17-style, A20) ───────────────

describe("cancel and unknown execution", () => {
  it("A45: cancel before dispatch permission → CANCELLED with zero inference", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [{ kind: "complete", outcome: "completed" }]);
    const cancel = h.core.cancel(h.seed.coordinatorId, { turn_id: t1.turn_id, idempotency_key: "cancel-1", reason: "too slow" });
    expect(cancel.state).toBe("CANCELLING");
    await start(h, t1);

    const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn.state).toBe("CANCELLED");
    expect(turn.execution_started).toBe(false);
    expect(turn.termination_reason).toBe("cancelled");
    // Zero inference: the adapter never acquired dispatch permission.
    expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBeFalsy();

    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("IDLE"); // not_started context is reusable (§6.5.1)
  });

  it("A20: cancel after definite completion stands; history unchanged", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    await start(h, t1);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

    const late = h.core.cancel(h.seed.coordinatorId, { turn_id: t1.turn_id, idempotency_key: "late-cancel" });
    expect(late.state).toBe("SUCCEEDED"); // terminal result returned unchanged
    expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
  });

  it("A17-style: undefined execution (crash window) → UNKNOWN + BLOCKED, no auto-retry", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "barrier", name: "pre-crash-2" },
      { kind: "hang" },
    ]);
    await start(h, t1);
    h.adapter.releaseBarrier("pre-crash-2");
    await h.executor.forceUnknownForTest(t1.turn_id, new Error("crash after launch intent"));

    const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn.state).toBe("UNKNOWN");
    expect(turn.native_outcome).toBe("unknown");

    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("BLOCKED");
    expect(session.block_reason).toContain("unknown");

    // Same-key replay returns the same UNKNOWN turn — no auto-retry.
    const replay = h.sendTask(spawn.session_id, "t1");
    expect(replay.turn_id).toBe(t1.turn_id);
    expect(replay.state).toBe("UNKNOWN");
    // New key on a BLOCKED session is refused.
    expectBrokerError(() => h.sendTask(spawn.session_id, "t1-new"), "SESSION_BLOCKED");
  });

  it("startup failure before dispatch → FAILED with execution_started=false", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "startup_failure", error: new BrokerError("AUTH_REQUIRED", "native auth missing", { executionStarted: false }) },
    ]);
    await start(h, t1);
    await settle(h);
    const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn.state).toBe("FAILED");
    expect(turn.execution_started).toBe(false);
    expect(turn.error_code).toBe("AUTH_REQUIRED");
    expect(h.adapter.dispatchPermissionAcquired(t1.turn_id)).toBeFalsy();
    // not_started context survives a pre-dispatch failure (§6.1).
    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.state).toBe("IDLE");
    expect(session.context_status).toBe("not_started");
  });

  it("A11: missing native history on resume → SESSION_NOT_RESUMABLE, no new conversation", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    await start(h, t1);
    await settle(h);
    const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session.context_status).toBe("available");

    // Second turn must resume; the mock is told resume fails.
    const t2 = h.sendTask(spawn.session_id, "t2");
    h.adapter.plan(t2.turn_id, [
      { kind: "startup_failure", error: new BrokerError("SESSION_NOT_RESUMABLE", "history missing", { executionStarted: false }) },
    ]);
    await start(h, t2);
    await settle(h);

    const turn2 = h.core.turnStatus(h.seed.coordinatorId, t2.turn_id);
    expect(turn2.state).toBe("FAILED");
    expect(turn2.error_code).toBe("SESSION_NOT_RESUMABLE");
    // The failed resume must not fabricate a new conversation reference.
    const session2 = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session2.native_conversation_ref).toBe(session.native_conversation_ref);
    // Context unusable after failed resume: session is BLOCKED, no silent
    // fresh-conversation fallback (INV-05, §14.2).
    expect(session2.state).toBe("BLOCKED");
    expect(session2.context_status).toBe("unverified");
    expect(session2.block_reason).toBe("session-not-resumable");
    expectBrokerError(() => h.sendTask(spawn.session_id, "t3"), "SESSION_BLOCKED");
  });
});

// ─── daemon singleton (A46) ──────────────────────────────────────────────────

describe("A46: singleton ownership", () => {
  it("second daemon start on the same state directory → DAEMON_ALREADY_RUNNING", async () => {
    const { acquireStateDirectoryOwnership } = await import("../../src/daemon/lifecycle.ts");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("agent-broker-test-");
    const first = await acquireStateDirectoryOwnership(dir);
    await expectBrokerErrorAsync(async () => acquireStateDirectoryOwnership(dir), "DAEMON_ALREADY_RUNNING");
    // Clean shutdown releases ownership fully: a restart must succeed (§14.2).
    await first.release();
    const second = await acquireStateDirectoryOwnership(dir);
    await expectBrokerErrorAsync(async () => acquireStateDirectoryOwnership(dir), "DAEMON_ALREADY_RUNNING");
    await second.release();
    await fs.rm(dir, { recursive: true, force: true });
  });
});

// ─── review regression tests ────────────────────────────────────────────────

describe("review regressions", () => {
  it("pre-dispatch cancel on a session with available context keeps it reusable (IDLE)", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    await start(h, t1);
    await settle(h);
    expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
    const session1 = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session1.context_status).toBe("available");

    // Turn 2 accepted, then cancelled before the executor starts: the
    // established native conversation must survive (§6.5.1 context usable).
    const t2 = h.sendTask(spawn.session_id, "t2");
    h.core.cancel(h.seed.coordinatorId, { turn_id: t2.turn_id, idempotency_key: "c2", reason: "changed plan" });
    await start(h, t2);
    await settle(h);
    const turn2 = h.core.turnStatus(h.seed.coordinatorId, t2.turn_id);
    expect(turn2.state).toBe("CANCELLED");
    const session2 = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
    expect(session2.state).toBe("IDLE");
    expect(session2.native_conversation_ref).toBe(session1.native_conversation_ref);
  });

  it("A47-style: daemon restart conservatively quarantines a running turn as UNKNOWN", async () => {
    const h = createHarness();
    const spawn = await h.spawnWorkerSession();
    const t1 = h.sendTask(spawn.session_id, "t1");
    h.adapter.plan(t1.turn_id, [
      { kind: "progress", label: "resumed" },
      { kind: "barrier", name: "hold-restart" },
      { kind: "complete", outcome: "completed" },
    ]);
    await start(h, t1);
    expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("RUNNING");

    // Simulate daemon crash + restart on the same registry.
    const { DaemonLifecycle } = await import("../../src/daemon/lifecycle.ts");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp("agent-broker-recovery-");
    const lifecycle = new DaemonLifecycle(h.db, h.clock);
    const report = await lifecycle.start(dir);
    expect(report.quarantined_unknown_turns).toContain(t1.turn_id);
    expect(lifecycle.currentState).toBe("READY");
    await lifecycle.shutdown();
    await fs.rm(dir, { recursive: true, force: true });

    const turn = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
    expect(turn.state).toBe("UNKNOWN"); // never fabricated as failed (§14.3)
    expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id).state).toBe("BLOCKED");
    expectBrokerError(() => h.sendTask(spawn.session_id, "t2"), "SESSION_BLOCKED");
  });
});
