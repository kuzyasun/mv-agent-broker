import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRegistryDb } from "../../src/storage/db.ts";
import {
  appendEvent,
  insertAccount,
  insertCoordinator,
  insertIntent,
  insertPolicyProfile,
  insertProject,
  insertSession,
  insertWorkspace,
  getSession,
  type AppendEventArgs,
} from "../../src/storage/repo.ts";
import { checkWorkspaceLeaseAvailable, workspaceLeaseTarget } from "../../src/core/capacity.ts";
import { inspectQuarantine, reconcileWorkspace } from "../../src/operator/recovery.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { computeManagedWorktreePath } from "../../src/workspaces/worktree.ts";
import { DatabaseSync } from "node:sqlite";

const roots: string[] = [];

interface Fixture {
  root: string;
  stateDir: string;
  sourcePath: string;
  allocationPath: string;
  workspaceId: string;
  sessionId: string;
  provisionIntentId: string;
  closeIntentId: string;
  sourceCommonDir: string;
  cleanup(): void;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeFixture(withGitLaunch = false): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-operator-recovery-"));
  roots.push(root);
  const stateDir = path.join(root, "state");
  const sourcePath = path.join(root, "source");
  const managedRoot = path.join(stateDir, "worktrees");
  mkdirSync(sourcePath, { recursive: true });
  mkdirSync(managedRoot, { recursive: true });
  git(sourcePath, ["init", "-q"]);
  git(sourcePath, ["config", "user.name", "Broker Test"]);
  git(sourcePath, ["config", "user.email", "broker-test@example.invalid"]);
  writeFileSync(path.join(sourcePath, "README.md"), "fixture\n", "utf8");
  git(sourcePath, ["add", "README.md"]);
  git(sourcePath, ["commit", "-qm", "fixture"]);
  const sourceCommonDir = realpathSync(git(sourcePath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  const baseCommit = git(sourcePath, ["rev-parse", "HEAD"]);
  const workspaceId = "ws-failed-worktree";
  const sessionId = "session-failed-worktree";
  const allocationPath = computeManagedWorktreePath(managedRoot, sessionId);
  const provisionIntentId = "intent-provision-failed";
  const closeIntentId = "intent-close-completed";
  const db = openRegistryDb(path.join(stateDir, "registry.sqlite"));
  const now = Date.now();
  insertProject(db, { project_id: "project-recovery", display_name: "Recovery", configuration_revision: 1, session_cap: 20, created_at: now });
  insertCoordinator(db, { coordinator_id: "operator", display_name: "Operator", allowed_project_ids: ["project-recovery"], revoked: false, config_revision: 1 });
  insertAccount(db, { account_profile_id: "account-recovery", provider: "mock", quota_scope_id: "quota-recovery", auth_mode: "native" });
  insertPolicyProfile(db, { policy_profile_id: "policy-recovery", version: "1", config: "{}" });
  insertWorkspace(db, {
    workspace_id: "ws-source",
    project_id: "project-recovery",
    mode: "current",
    canonical_path: sourcePath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: null,
  });
  insertWorkspace(db, {
    workspace_id: workspaceId,
    project_id: "project-recovery",
    mode: "worktree",
    canonical_path: allocationPath,
    quarantined: true,
    quarantine_reason: "worktree-provisioning: git-add-failed",
    coverage_profile_id: null,
  });
  insertSession(db, {
    session_id: sessionId,
    project_id: "project-recovery",
    owner_coordinator_id: "operator",
    provider: "mock",
    adapter_version: "mock-1",
    cli_version: null,
    account_profile_id: "account-recovery",
    auth_mode: "native",
    requested_model: "mock",
    requested_effort: null,
    effective_model: null,
    effective_effort: null,
    role: "worker",
    instructions_hash: "instructions",
    policy_profile_id: "policy-recovery",
    policy_profile_version: "1",
    workspace_id: workspaceId,
    workspace_mode: "worktree",
    coverage_profile_id: null,
    coverage_profile_version: null,
    coverage_contract_hash: null,
    native_conversation_ref: null,
    context_status: "not_started",
    state: "CLOSED",
    active_turn_id: null,
    block_reason: "provisioning-failed: git-worktree-add-failed: git-add-failed",
    runtime_id: null,
    close_state: "completed",
    close_intent_id: closeIntentId,
    initial_snapshot_id: null,
    latest_snapshot_id: null,
    record_version: 2,
    created_at: now,
    updated_at: now,
  });
  insertIntent(db, {
    intent_id: provisionIntentId,
    kind: "provision_session",
    session_id: sessionId,
    turn_id: null,
    state: "failed",
    payload: JSON.stringify({
      request_hash: "request",
      worktree_provisioning: {
        binding_version: 1,
        source_workspace_id: "ws-source",
        source_common_dir: sourceCommonDir,
        base_commit: baseCommit,
        workspace_id: workspaceId,
        worktree_path: allocationPath,
        managed_root: managedRoot,
        stage: "adding",
        lock: null,
        launch: withGitLaunch ? {
          nonce: "observed-failed-add",
          launch_uuid: "00000000-0000-4000-8000-000000000000",
          named_job: "Local\\observed-failed-add",
          root_pid: 2_000_000_001,
          root_creation_time: "133000000000000000",
          owner_pid: 2_000_000_002,
          owner_creation_time: "133000000000000000",
          helper_pid: 2_000_000_003,
        } : null,
        completion: null,
        current_checkout_changes_copied: false,
      },
    }),
    created_at: now,
    updated_at: now,
  });
  insertIntent(db, {
    intent_id: closeIntentId,
    kind: "close_session",
    session_id: sessionId,
    turn_id: null,
    state: "completed",
    payload: "{}",
    created_at: now + 1,
    updated_at: now + 1,
  });
  const event: AppendEventArgs = {
    turn_id: null,
    session_id: sessionId,
    type: "session_provisioning_failed",
    payload: { reason: "git-add-failed" },
    created_at: now + 2,
  };
  appendEvent(db, event);
  // Idle logical sessions do not imply running execution and need not be closed.
  insertSession(db, { ...getSession(db, sessionId)!, session_id: "session-unrelated-idle",
    workspace_id: "ws-source", workspace_mode: "current", state: "IDLE", close_state: "none",
    close_intent_id: null, block_reason: null });
  db.raw.prepare("INSERT INTO reservations (reservation_id, kind, scope, mode, owner_session_id, owner_turn_id, created_at, released_at) VALUES ('idle-session-slot', 'session_slot', 'project-recovery', 'exclusive', 'session-unrelated-idle', NULL, ?, NULL)")
    .run(now);
  db.close();
  return {
    root,
    stateDir,
    sourcePath,
    allocationPath,
    workspaceId,
    sessionId,
    provisionIntentId,
    closeIntentId,
    sourceCommonDir,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function rows(dbPath: string, table: string): unknown[] {
  const db = openRegistryDb(dbPath);
  try {
    return db.raw.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as unknown[];
  } finally {
    db.close();
  }
}

function retainedHistory(dbPath: string): Record<string, unknown[]> {
  const db = new DatabaseSync(dbPath, {readOnly: true});
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT IN ('workspaces', 'events', 'sqlite_sequence') ORDER BY name")
      .all() as Array<{name: string}>;
    return Object.fromEntries(tables.map(({name}) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]));
  } finally { db.close(); }
}

function expectBusy(fn: () => void): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe("WORKSPACE_BUSY");
    return;
  }
  throw new Error("expected WORKSPACE_BUSY");
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("offline operator workspace recovery", () => {
  it("inspects read-only, reconciles one failed allocation, and preserves registry history", async () => {
    const f = makeFixture();
    try {
      const beforeSessions = rows(path.join(f.stateDir, "registry.sqlite"), "sessions");
      const beforeIntents = rows(path.join(f.stateDir, "registry.sqlite"), "intents");
      const beforeProjects = rows(path.join(f.stateDir, "registry.sqlite"), "projects");
      const beforeEvents = rows(path.join(f.stateDir, "registry.sqlite"), "events");
      const allHistoryBefore = retainedHistory(path.join(f.stateDir, "registry.sqlite"));
      const freshPath = path.join(f.root, "fresh-worktree");
      git(f.sourcePath, ["worktree", "add", "--detach", freshPath, "HEAD"]);
      const physicalTargets = [f.sourcePath, freshPath].map((canonical_path, index) => ({
        workspace_id: `physical-${index}`, project_id: "project-recovery", mode: "current" as const,
        canonical_path, quarantined: false, quarantine_reason: null, coverage_profile_id: null,
      }));
      for (const target of physicalTargets) {
        const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
        try { expectBusy(() => checkWorkspaceLeaseAvailable(db, workspaceLeaseTarget(target))); }
        finally { db.close(); }
      }
      const inspected = inspectQuarantine(f.stateDir, f.workspaceId);
      expect(inspected.ready_is_not_admission_proof).toBe(true);
      expect((inspected.workspaces as Array<Record<string, unknown>>)[0]?.workspace).toMatchObject({
        workspace_id: f.workspaceId,
        quarantine_reason: "worktree-provisioning: git-add-failed",
      });
      expectBusy(() => {
        const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
        try { checkWorkspaceLeaseAvailable(db, workspaceLeaseTarget({
          workspace_id: f.workspaceId,
          project_id: "project-recovery",
          mode: "worktree",
          canonical_path: f.allocationPath,
          quarantined: true,
          quarantine_reason: "worktree-provisioning: git-add-failed",
          coverage_profile_id: null,
        })); } finally { db.close(); }
      });

      const result = await reconcileWorkspace({
        stateDir: f.stateDir,
        workspaceId: f.workspaceId,
        note: "Confirmed failed add was never dispatched; release the stale quarantine.",
      });
      expect(result.status).toBe("reconciled");
      expect(existsSync(String(result.backup_path))).toBe(true);
      expect(existsSync(String(result.receipt_path))).toBe(true);
      const receipt = JSON.parse(readFileSync(String(result.receipt_path), "utf8")) as Record<string, unknown>;
      expect(receipt.mutation).toBe("committed");
      expect(receipt.no_dispatch_evidence).toMatchObject({ stage: "adding", native_inference_started: false, git_launch_receipt: null });
      const backedUp = openRegistryDb(String(result.backup_path));
      try {
        expect((backedUp.raw.prepare("SELECT quarantined, quarantine_reason FROM workspaces WHERE workspace_id = ?").get(f.workspaceId) as Record<string, unknown>)).toMatchObject({
          quarantined: 1,
          quarantine_reason: "worktree-provisioning: git-add-failed",
        });
      } finally { backedUp.close(); }

      const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
      try {
        const workspace = db.raw.prepare("SELECT quarantined, quarantine_reason FROM workspaces WHERE workspace_id = ?").get(f.workspaceId) as Record<string, unknown>;
        expect(workspace).toEqual({ quarantined: 0, quarantine_reason: null });
        expect(() => checkWorkspaceLeaseAvailable(db, workspaceLeaseTarget({
          workspace_id: f.workspaceId,
          project_id: "project-recovery",
          mode: "worktree",
          canonical_path: f.allocationPath,
          quarantined: false,
          quarantine_reason: null,
          coverage_profile_id: null,
        }))).not.toThrow();
        for (const target of physicalTargets) {
          expect(() => checkWorkspaceLeaseAvailable(db, workspaceLeaseTarget(target))).not.toThrow();
        }
        expect(() => checkWorkspaceLeaseAvailable(db, workspaceLeaseTarget({
          workspace_id: "ws-source",
          project_id: "project-recovery",
          mode: "current",
          canonical_path: f.sourcePath,
          quarantined: false,
          quarantine_reason: null,
          coverage_profile_id: null,
        }))).not.toThrow();
        const audit = db.raw.prepare("SELECT type, payload FROM events WHERE type = 'operator_workspace_quarantine_reconciled'").get() as { type: string; payload: string };
        expect(audit.type).toBe("operator_workspace_quarantine_reconciled");
        expect(JSON.parse(audit.payload)).toMatchObject({
          previous_reason: "worktree-provisioning: git-add-failed",
          note: "Confirmed failed add was never dispatched; release the stale quarantine.",
          disk_disposition: { allocation_exists: false, git_worktree_registered: false, preserved: true },
        });
      } finally { db.close(); }
      expect(rows(path.join(f.stateDir, "registry.sqlite"), "sessions")).toEqual(beforeSessions);
      expect(rows(path.join(f.stateDir, "registry.sqlite"), "intents")).toEqual(beforeIntents);
      expect(rows(path.join(f.stateDir, "registry.sqlite"), "projects")).toEqual(beforeProjects);
      expect(rows(path.join(f.stateDir, "registry.sqlite"), "events")).toHaveLength(beforeEvents.length + 1);
      expect(rows(path.join(f.stateDir, "registry.sqlite"), "events")).toEqual([...beforeEvents, expect.objectContaining({type:"operator_workspace_quarantine_reconciled"})]);
      expect(retainedHistory(path.join(f.stateDir, "registry.sqlite"))).toEqual(allHistoryBefore);
      expect(existsSync(f.allocationPath)).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it.skipIf(process.platform !== "win32")("releases the observed launched Git failure after all old PIDs are absent, with no inference", async () => {
    const f = makeFixture(true);
    const beforeIntents = rows(path.join(f.stateDir, "registry.sqlite"), "intents");
    const result = await reconcileWorkspace({ stateDir: f.stateDir, workspaceId: f.workspaceId,
      note: "Git failed, absent allocation and old processes, no inference." });
    expect(result.no_dispatch_evidence).toMatchObject({native_inference_started: false,
      process_probe: "absent", recorded_pids: [2_000_000_001, 2_000_000_002, 2_000_000_003]});
    expect(rows(path.join(f.stateDir, "registry.sqlite"), "intents")).toEqual(beforeIntents);
    expect(existsSync(f.allocationPath)).toBe(false);
  }, 15_000);

  it("refuses an owned state lock, open sessions, active reservations, occupied paths, and dispatched PIDs unchanged", async () => {
    let ownedLock: DatabaseSync | undefined;
    const cases = [
      {
        name: "UNKNOWN turn",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try {
            db.raw.prepare("INSERT INTO turns (turn_id,session_id,project_id,owner_coordinator_id,idempotency_key,request_hash,state,execution_started,created_at,updated_at) VALUES ('unknown-turn', 'session-unrelated-idle', 'project-recovery', 'operator', 'unknown-key', 'unknown-request', 'UNKNOWN', 1, ?, ?)")
              .run(Date.now(), Date.now());
          } finally { db.close(); }
        },
        expected: /Nonterminal or UNKNOWN/,
      },
      {
        name: "pending lifecycle intent",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try { insertIntent(db, {intent_id:"pending-close",kind:"close_session",session_id:"session-unrelated-idle",turn_id:null,state:"pending",payload:"{}",created_at:Date.now(),updated_at:Date.now()}); }
          finally { db.close(); }
        },
        expected: /Pending lifecycle/,
      },
      {
        name: "wrong generated allocation",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try {
            const row = db.raw.prepare("SELECT payload FROM intents WHERE intent_id = ?").get(f.provisionIntentId) as {payload:string};
            const payload = JSON.parse(row.payload);
            payload.worktree_provisioning.worktree_path = path.join(f.stateDir, "worktrees", "not-generated");
            db.raw.prepare("UPDATE intents SET payload = ? WHERE intent_id = ?").run(JSON.stringify(payload), f.provisionIntentId);
            db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = ?").run(payload.worktree_provisioning.worktree_path, f.workspaceId);
          } finally { db.close(); }
        },
        expected: /generated allocation/,
      },
      {
        name: "owned state lock",
        setup: (f: Fixture) => {
          ownedLock = new DatabaseSync(path.join(f.stateDir, "daemon-ownership.sqlite"));
          ownedLock.exec("BEGIN EXCLUSIVE");
        },
        expected: /Another daemon owns this state directory/,
        cleanup: () => { ownedLock?.close(); ownedLock = undefined; },
      },
      {
        name: "open target session",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try { db.raw.prepare("UPDATE sessions SET state = 'IDLE', close_state = 'none', close_intent_id = NULL WHERE session_id = ?").run(f.sessionId); } finally { db.close(); }
        },
        expected: /Every session bound/,
      },
      {
        name: "active reservation",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try {
            db.raw.prepare("INSERT INTO reservations (reservation_id, kind, scope, mode, owner_session_id, owner_turn_id, created_at, released_at) VALUES (?, 'workspace_lease', 'checkout:v1:1:1', 'exclusive', NULL, NULL, ?, NULL)").run("active-recovery-reservation", Date.now());
          } finally { db.close(); }
        },
        expected: /Active execution/,
      },
      {
        name: "occupied allocation",
        setup: (f: Fixture) => mkdirSync(f.allocationPath, { recursive: true }),
        expected: /worktree path exists/,
        cleanup: (f: Fixture) => rmSync(f.allocationPath, { recursive: true, force: true }),
      },
      {
        name: "live recorded PID",
        setup: (f: Fixture) => {
          const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
          try {
            const row = db.raw.prepare("SELECT payload FROM intents WHERE intent_id = ?").get(f.provisionIntentId) as { payload: string };
            const payload = JSON.parse(row.payload) as { worktree_provisioning: Record<string, unknown> };
            payload.worktree_provisioning.launch = {
              nonce: "live-pid",
              launch_uuid: "00000000-0000-4000-8000-000000000000",
              named_job: "Local\\live-pid",
              root_pid: process.pid,
              root_creation_time: "133000000000000000",
              owner_pid: process.pid,
              owner_creation_time: "133000000000000000",
              helper_pid: process.pid,
            };
            db.raw.prepare("UPDATE intents SET payload = ? WHERE intent_id = ?").run(JSON.stringify(payload), f.provisionIntentId);
          } finally { db.close(); }
        },
        expected: process.platform === "win32" ? /recorded provisioning process/ : /unavailable on this platform/,
      },
    ] as const;
    for (const testCase of cases) {
      const f = makeFixture();
      try {
        testCase.setup(f);
        const before = JSON.stringify(rows(path.join(f.stateDir, "registry.sqlite"), "workspaces"));
        await expect(reconcileWorkspace({
          stateDir: f.stateDir,
          workspaceId: f.workspaceId,
          note: testCase.name,
        })).rejects.toThrow(testCase.expected);
        expect(JSON.stringify(rows(path.join(f.stateDir, "registry.sqlite"), "workspaces"))).toBe(before);
      } finally {
        testCase.cleanup?.(f);
        f.cleanup();
      }
    }
  });

  it("refuses a mismatched journal without deleting or adopting anything", async () => {
    const f = makeFixture();
    try {
      const db = openRegistryDb(path.join(f.stateDir, "registry.sqlite"));
      try {
        const row = db.raw.prepare("SELECT payload FROM intents WHERE intent_id = ?").get(f.provisionIntentId) as { payload: string };
        const payload = JSON.parse(row.payload) as { worktree_provisioning: Record<string, unknown> };
        payload.worktree_provisioning.source_common_dir = path.join(f.root, "other-common-dir");
        db.raw.prepare("UPDATE intents SET payload = ? WHERE intent_id = ?").run(JSON.stringify(payload), f.provisionIntentId);
      } finally { db.close(); }
      await expect(reconcileWorkspace({ stateDir: f.stateDir, workspaceId: f.workspaceId, note: "mismatched journal" }))
        .rejects.toThrow(/source common directory/);
      expect(existsSync(f.allocationPath)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
