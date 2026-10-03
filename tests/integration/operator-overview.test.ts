import { afterEach, describe, expect, it } from "vitest";
import { openRegistryDb, type RegistryDb } from "../../src/storage/db.ts";
import { appendEvent, insertProject, insertSession, insertTurn } from "../../src/storage/repo.ts";
import type { SessionRecord, TurnRecord } from "../../src/shared/api-types.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import {
  clearQuotaPauseResult,
  projectOperatorOverview,
  projectOperatorQuotaPauses,
  projectOperatorTurnError,
} from "../../src/operator/overview.ts";
import { recordQuotaCooldown } from "../../src/core/quotaCooldown.ts";

let db: RegistryDb | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
});

function session(sessionId: string, index: number): SessionRecord {
  return {
    session_id: sessionId,
    project_id: "project-main",
    owner_coordinator_id: "operator",
    provider: "mock",
    adapter_version: null,
    cli_version: null,
    account_profile_id: "account-main",
    auth_mode: "cli-owned",
    requested_model: `model-${index}`,
    requested_effort: index % 2 === 0 ? "high" : null,
    effective_model: null,
    effective_effort: null,
    role: "worker",
    instructions_hash: `instructions-${index}`,
    policy_profile_id: "policy-main",
    policy_profile_version: "1",
    workspace_id: null,
    workspace_mode: "current",
    coverage_profile_id: null,
    coverage_profile_version: null,
    coverage_contract_hash: null,
    native_conversation_ref: null,
    context_status: "not_started",
    state: "ACTIVE",
    active_turn_id: null,
    block_reason: null,
    runtime_id: null,
    close_state: "none",
    close_intent_id: null,
    initial_snapshot_id: null,
    latest_snapshot_id: null,
    record_version: 1,
    created_at: 1_000 + index,
    updated_at: 1_000 + index,
  };
}

function turn(
  turnId: string,
  sessionId: string,
  index: number,
  state: TurnRecord["state"],
  errorCode: string | null = null,
): TurnRecord {
  const timestamp = 10_000 + index;
  return {
    turn_id: turnId,
    session_id: sessionId,
    project_id: "project-main",
    owner_coordinator_id: "operator",
    idempotency_key: `idempotency-${turnId}`,
    request_hash: `request-${turnId}`,
    task_goal_hash: `private-goal-${turnId}`,
    state,
    state_version: 1,
    execution_started: state === "RUNNING",
    native_outcome: errorCode ? "failed" : null,
    termination_reason: errorCode ? "startup_failure" : null,
    finalization_error: errorCode ? "private-finalization-error" : null,
    terminal_candidate: null,
    retry_of_turn_id: null,
    deadline_at: null,
    native_conversation_ref: "private-native-ref",
    continuation: null,
    input_manifest_id: null,
    task_artifact_refs: ["private-artifact"],
    baseline_snapshot_id: null,
    review_target_snapshot_id: null,
    final_snapshot_id: null,
    runtime_id: null,
    error_code: errorCode,
    created_at: timestamp - 1,
    accepted_at: timestamp - 1,
    terminal_at: errorCode ? timestamp : null,
    updated_at: errorCode ? timestamp + 1_000 : timestamp,
  };
}

describe("operator overview projection", () => {
  it("projects bounded newest active jobs and error codes from immutable session bindings", () => {
    db = openRegistryDb(":memory:");
    insertProject(db, {
      project_id: "project-main",
      display_name: "Main",
      configuration_revision: 1,
      session_cap: 100,
      created_at: 1,
    });

    for (let index = 0; index < 32; index += 1) {
      const sessionId = `active-session-${index}`;
      insertSession(db, session(sessionId, index));
      insertTurn(db, turn(`active-turn-${index}`, sessionId, index, "RUNNING"));
    }
    for (let index = 0; index < 12; index += 1) {
      const sessionId = `error-session-${index}`;
      insertSession(db, { ...session(sessionId, 100 + index), state: "IDLE" });
      insertTurn(db, turn(`error-turn-${index}`, sessionId, 100 + index, "FAILED", `E${index}`));
    }

    const overview = projectOperatorOverview(db);

    expect(overview).toMatchObject({
      active_turn_count: 32,
      active_turns_truncated: true,
      error_turn_count: 12,
      error_turns_truncated: true,
    });
    expect(overview.active_turns).toHaveLength(30);
    expect(overview.active_turns[0]).toMatchObject({ last_activity_at: null, deadline_at: null, execution_started: true });
    expect(overview.error_turns).toHaveLength(10);
    expect(overview.active_turns[0]).toEqual({
      turn_id: "active-turn-31",
      session_id: "active-session-31",
      project_id: "project-main",
      provider: "mock",
      model: "model-31",
      effort: null,
      state: "RUNNING",
      timestamp: 10_031,
      accepted_at: 10_030,
      deadline_at: null,
      execution_started: true,
      last_activity_at: null,
    });
    expect(overview.error_turns[0]).toMatchObject({
      turn_id: "error-turn-11",
      session_id: "error-session-11",
      project_id: "project-main",
      provider: "mock",
      model: "model-111",
      effort: null,
      state: "FAILED",
      error_code: "E11",
      timestamp: 10_111,
    });
    expect(JSON.stringify(overview)).not.toContain("private-goal");
    expect(JSON.stringify(overview)).not.toContain("private-finalization-error");
    expect(JSON.stringify(overview)).not.toContain("private-native-ref");
    expect(JSON.stringify(overview)).not.toContain("private-artifact");
  });

  it("tracks retained provider activity separately from lifecycle and ownership updates", () => {
    db = openRegistryDb(":memory:");
    insertProject(db, { project_id: "project-main", display_name: "Main", configuration_revision: 1, session_cap: 5, created_at: 1 });
    insertSession(db, session("active", 1));
    insertTurn(db, { ...turn("running", "active", 1, "STARTING"), execution_started: true, deadline_at: 3_600_000 });
    appendEvent(db, { turn_id: "running", session_id: "active", type: "adapter:owned_launch", created_at: 20_000, payload: {} });
    expect(projectOperatorOverview(db).active_turns[0]).toMatchObject({ last_activity_at: null, execution_started: true });
    appendEvent(db, { turn_id: "running", session_id: "active", type: "adapter:progress", created_at: 30_000, payload: { label: "private-payload" } });
    appendEvent(db, { turn_id: "running", session_id: "active", type: "adapter:owned_quiescence", created_at: 40_000, payload: {} });
    const overview = projectOperatorOverview(db);
    expect(overview.active_turns[0]).toMatchObject({ last_activity_at: 30_000, deadline_at: 3_600_000, timestamp: 10_001 });
    expect(JSON.stringify(overview)).not.toContain("private-payload");
    db.raw.prepare("UPDATE turns SET execution_started = NULL, state = 'UNKNOWN' WHERE turn_id = 'running'").run();
    expect(projectOperatorOverview(db).active_turns[0]).toMatchObject({ execution_started: null, state: "UNKNOWN" });
  });

  it("shows deadline failures even when the adapter supplied no error code", () => {
    db = openRegistryDb(":memory:");
    insertProject(db, { project_id: "project-main", display_name: "Main", configuration_revision: 1, session_cap: 5, created_at: 1 });
    insertSession(db, session("timed-out", 1));
    insertTurn(db, turn("timeout", "timed-out", 1, "TIMED_OUT"));
    expect(projectOperatorOverview(db)).toMatchObject({ active_turn_count: 0, error_turn_count: 1,
      error_turns: [{ turn_id: "timeout", state: "TIMED_OUT", error_code: null }] });
    expect(projectOperatorTurnError(db, "timeout")?.guidance.explanation).toBe("The turn reached its deadline.");
  });

  it("projects safe quota pause metadata and clears one scope with an audit event", () => {
    db = openRegistryDb(":memory:");
    const now = Date.now();
    recordQuotaCooldown(db, {
      quotaScopeId: "qs-shared", provider: "antigravity", turnId: "turn-quota",
      detail: "Individual quota reached. Resets in 54m59s.", now,
    });
    recordQuotaCooldown(db, {
      quotaScopeId: "qs-expired", provider: "mock", turnId: "turn-old",
      detail: null, now: now - 16 * 60_000,
    });

    expect(projectOperatorQuotaPauses(db, now + 500)).toEqual([{
      quota_scope_id: "qs-shared",
      provider: "antigravity",
      until_ms: now + 3_299_000,
      retry_after_ms: 3_299_000 - 500,
      source: "vendor_reset_suffix",
      recorded_at: now,
    }]);

    const result = clearQuotaPauseResult(db, { quota_scope_id: "qs-shared" });
    expect(result).toEqual({ cleared: true, quota_scope_id: "qs-shared" });
    expect(projectOperatorQuotaPauses(db, now + 500)).toEqual([]);
    const audit = db.raw
      .prepare("SELECT type, payload FROM events WHERE type = 'quota_pause_cleared' ORDER BY seq DESC")
      .all() as Array<{ type: string; payload: string }>;
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.payload)).toMatchObject({ quota_scope_id: "qs-shared", cleared: true });

    // Clearing an already-expired scope reports honestly and still audits.
    expect(clearQuotaPauseResult(db, { quota_scope_id: "qs-expired" })).toEqual({ cleared: false, quota_scope_id: "qs-expired" });

    let invalid: unknown;
    try { clearQuotaPauseResult(db, {}); } catch (error) { invalid = error; }
    expect(invalid).toBeInstanceOf(BrokerError);
    expect((invalid as BrokerError).code).toBe("INVALID_REQUEST");
  });
});
