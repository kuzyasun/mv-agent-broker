import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { daemonEnvFromProcess } from "../../src/daemon/bootstrap.ts";
import { insertAccount, insertProject, insertWorkspace } from "../../src/storage/repo.ts";
import { createHarness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";

function expectResourceBusy(fn: () => unknown, message: RegExp): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe("RESOURCE_BUSY");
    expect((error as Error).message).toMatch(message);
    return;
  }
  throw new Error("expected RESOURCE_BUSY");
}

describe("operator concurrency limits", () => {
  it("reads only the raw unfinished-turn environment overrides", () => {
    expect(daemonEnvFromProcess({
      AB_STATE_DIR: "./state",
      AB_COORDINATOR_ID: "coord",
      AB_GLOBAL_UNFINISHED_TURNS: "6",
      AB_QUOTA_SCOPE_UNFINISHED_TURNS: "2",
      AB_OPEN_SESSIONS: "ignored",
    }).limits).toEqual({
      globalUnfinishedTurns: 6,
      quotaScopeUnfinishedTurns: 2,
      hardTurnDeadlineMs: 3_600_000,
      maxReviewDiffBytes: 33_554_432,
    });
    expect(daemonEnvFromProcess({}).limits).toBeUndefined();
    expect(daemonEnvFromProcess({ AB_TURN_DEADLINE_MS: "7200000" }).limits?.hardTurnDeadlineMs).toBe(7_200_000);
    for (const value of ["0", "-1", "1.5", "NaN", "Infinity"]) {
      expect(() => daemonEnvFromProcess({ AB_GLOBAL_UNFINISHED_TURNS: value })).toThrow();
    }
  });

  it.each([undefined, 7_200_000])("uses the default or configured deadline while allowing a per-turn override: %s", async configured => {
    const h = createHarness({ limits: configured === undefined ? {} : { hardTurnDeadlineMs: configured } });
    try {
      const session = await h.spawnWorkerSession();
      const accepted = h.sendTask(session.session_id, "deadline-default");
      expect(h.core.turnStatus(h.seed.coordinatorId, accepted.turn_id).deadline_at)
        .toBe(h.clock.now() + (configured ?? 3_600_000));
      const other = await h.spawnWorkerSession({ account_profile_id: h.seed.accountMock3OtherQuota,
        workspace: { mode: "current", workspace_id: h.seed.workspaceOther } });
      const overridden = h.sendTask(other.session_id, "deadline-override", "Short task", { deadline_ms: 1_800_000 });
      expect(h.core.turnStatus(h.seed.coordinatorId, overridden.turn_id).deadline_at).toBe(h.clock.now() + 1_800_000);
    } finally { h.cleanup(); }
  });

  it("admits two independent same-quota turns and refuses a third", async () => {
    const h = createHarness({ limits: { globalUnfinishedTurns: 6, quotaScopeUnfinishedTurns: 2 } });
    const secondRoot = mkdtempSync(path.join(tmpdir(), "operator-limit-second-"));
    try {
      mkdirSync(path.join(secondRoot, "src"));
      writeFileSync(path.join(secondRoot, "src", "main.c"), "int main(){return 0;}\n");
      insertProject(h.db, {
        project_id: "project-second",
        display_name: "Second project",
        configuration_revision: 1,
        session_cap: 20,
        created_at: h.clock.now(),
      });
      h.db.raw.prepare("UPDATE coordinator_profiles SET allowed_project_ids = ? WHERE coordinator_id = ?")
        .run(JSON.stringify([h.seed.projectId, "project-second"]), h.seed.coordinatorId);
      insertWorkspace(h.db, {
        workspace_id: "ws-second",
        project_id: "project-second",
        mode: "current",
        canonical_path: secondRoot,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const first = await h.spawnWorkerSession();
      const second = await h.spawnWorkerSession({
        project_id: "project-second",
        account_profile_id: h.seed.accountMock2SameQuota,
        workspace: { mode: "current", workspace_id: "ws-second" },
      });
      h.sendTask(first.session_id, "same-quota-1");
      h.sendTask(second.session_id, "same-quota-2");

      const third = await h.spawnWorkerSession({
        account_profile_id: h.seed.accountMock1,
        workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
      });
      expectResourceBusy(() => h.sendTask(third.session_id, "same-quota-3"), /Quota-scope unfinished-turn capacity/);
    } finally {
      h.cleanup();
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });

  it("admits six different quota scopes and refuses the seventh globally", async () => {
    const h = createHarness({ limits: { globalUnfinishedTurns: 6, quotaScopeUnfinishedTurns: 2 } });
    const workspaceRoots: string[] = [];
    try {
      const sessions = [];
      for (let index = 0; index < 6; index += 1) {
        const accountId = `acct-global-${index}`;
        const workspaceId = `ws-global-${index}`;
        const workspaceRoot = mkdtempSync(path.join(tmpdir(), "operator-limit-ws-"));
        workspaceRoots.push(workspaceRoot);
        mkdirSync(path.join(workspaceRoot, "src"));
        writeFileSync(path.join(workspaceRoot, "src", "main.c"), "int main(){return 0;}\n");
        insertAccount(h.db, {
          account_profile_id: accountId,
          provider: "mock",
          quota_scope_id: `qs-global-${index}`,
          auth_mode: "native",
        });
        insertWorkspace(h.db, {
          workspace_id: workspaceId,
          project_id: h.seed.projectId,
          mode: "current",
          canonical_path: workspaceRoot,
          quarantined: false,
          quarantine_reason: null,
          coverage_profile_id: h.seed.coverageProfileId,
        });
        const session = await h.spawnWorkerSession({
          account_profile_id: accountId,
          workspace: { mode: "current", workspace_id: workspaceId },
        });
        h.sendTask(session.session_id, `global-${index}`);
        sessions.push(session);
      }
      const seventh = await h.spawnWorkerSession({
        account_profile_id: "acct-global-0",
        workspace: { mode: "current", workspace_id: "ws-global-0" },
      });
      expectResourceBusy(() => h.sendTask(seventh.session_id, "global-7"), /Global unfinished-turn capacity/);
      expect(sessions).toHaveLength(6);
    } finally {
      h.cleanup();
      for (const workspaceRoot of workspaceRoots) rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
