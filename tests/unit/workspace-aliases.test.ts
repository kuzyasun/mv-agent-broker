/**
 * A05 acceptance: real checkout alias exclusion (INV-02 over physical checkouts).
 *
 * One exclusive broker-owned writer per PHYSICAL checkout — across registered
 * workspace aliases, Windows junctions/symlinks and path-casing spellings.
 * Distinct physical directories stay independent within capacity. Legacy
 * workspace_id-scoped leases block physical writers conservatively, including
 * UNKNOWN quarantine retained across restart; live paths are not history.
 * All mock-level, no inference.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHarness, settle, settleTurn, start, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { insertReservation, insertWorkspace } from "../../src/storage/repo.ts";
import { DaemonLifecycle } from "../../src/daemon/lifecycle.ts";

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

/** Register a second workspace name for an existing physical directory. */
function registerAliasWorkspace(h: Harness, workspaceId: string, canonicalPath: string): void {
  insertWorkspace(h.db, {
    workspace_id: workspaceId,
    project_id: h.seed.projectId,
    mode: "current",
    canonical_path: canonicalPath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: h.seed.coverageProfileId,
  });
}

/** Windows junction (no privilege needed) or POSIX directory symlink. */
function tryCreateLink(target: string, linkPath: string): boolean {
  try {
    symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

function removeLink(linkPath: string): void {
  try {
    rmSync(linkPath, { recursive: true, force: true });
  } catch {
    /* best-effort link cleanup; never masks test failures */
  }
}

const ALIAS_LIMITS = { globalUnfinishedTurns: 10, quotaScopeUnfinishedTurns: 10 };

describe("A05: real checkout alias exclusion", () => {
  it("two registry IDs over one physical root conflict across quota scopes; the refused key stays free", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-alias", h.workspaceRoot);
      const s1 = await h.spawnWorkerSession(); // ws-main, quota scope qs-shared
      const s2 = await h.spawnWorkerSession({
        workspace: { mode: "current", workspace_id: "ws-alias" },
        account_profile_id: h.seed.accountMock3OtherQuota, // qs-other: quota can never be the blocker
      });

      const t1 = h.sendTask(s1.session_id, "hold-key");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-root" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      const err = expectBrokerError(() => h.sendTask(s2.session_id, "retry-key"), "WORKSPACE_BUSY");
      expect(err.details?.workspace_id).toBe("ws-alias");
      // Refused BEFORE acceptance: no turn row, session untouched.
      expect(h.core.sessionStatus(h.seed.coordinatorId, s2.session_id).state).toBe("IDLE");
      const turnCount = h.db.raw.prepare("SELECT COUNT(*) AS c FROM turns WHERE session_id = ?").get(s2.session_id) as { c: number };
      expect(turnCount.c).toBe(0);

      h.adapter.releaseBarrier("hold-root");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      // Same key retried after release: the mutable refusal never consumed it.
      const t2 = h.sendTask(s2.session_id, "retry-key");
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("junction/symlink alias of the same checkout is refused (skipped only when the OS refuses creation)", async (ctx) => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    const linkPath = path.join(path.dirname(h.workspaceRoot), "ws-link");
    try {
      if (!tryCreateLink(h.workspaceRoot, linkPath)) {
        ctx.skip();
        return;
      }
      registerAliasWorkspace(h, "ws-link", linkPath);
      const s1 = await h.spawnWorkerSession(); // ws-main
      const s2 = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });

      const t1 = h.sendTask(s1.session_id, "link-1");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-link" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      expectBrokerError(() => h.sendTask(s2.session_id, "link-2"), "WORKSPACE_BUSY");

      h.adapter.releaseBarrier("hold-link");
      await settle(h);
    } finally {
      removeLink(linkPath);
      h.cleanup();
    }
  });

  it("Windows case-folded spelling and dot-segment spelling are the same physical checkout", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      if (process.platform === "win32") {
        // Case-insensitive filesystem: the differently cased spelling resolves
        // to the same checkout via realpath, not lexical folding.
        registerAliasWorkspace(h, "ws-case", h.workspaceRoot.replace(/ws-main$/, "WS-MAIN"));
      }
      // Unnormalized ".." spelling: only FS resolution can equate the paths.
      const baseDir = path.dirname(h.workspaceRoot);
      mkdirSync(path.join(baseDir, "sub"), { recursive: true });
      registerAliasWorkspace(h, "ws-dots", [baseDir, "sub", "..", "ws-main"].join(path.sep));

      const s1 = await h.spawnWorkerSession(); // ws-main
      const aliasIds = process.platform === "win32" ? ["ws-case", "ws-dots"] : ["ws-dots"];
      const aliasSessions: Array<{ session_id: string }> = [];
      for (const id of aliasIds) {
        aliasSessions.push(await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: id } }));
      }

      const t1 = h.sendTask(s1.session_id, "spell-1");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-spell" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);

      for (const [i, s] of aliasSessions.entries()) {
        expectBrokerError(() => h.sendTask(s.session_id, `spell-alias-${i}`), "WORKSPACE_BUSY");
      }

      h.adapter.releaseBarrier("hold-spell");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("a legacy workspace_id-scoped lease denies alias writers AND same-id writers", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-alias", h.workspaceRoot);
      // Pre-upgrade lease row: scope is the workspace id, not a physical identity.
      insertReservation(h.db, {
        reservation_id: "res-legacy-ws-main",
        kind: "workspace_lease",
        scope: "ws-main",
        mode: "exclusive",
        owner_session_id: null,
        owner_turn_id: null,
        created_at: h.clock.now(),
        released_at: null,
      });

      const aliasSession = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-alias" } });
      expectBrokerError(() => h.sendTask(aliasSession.session_id, "legacy-alias"), "WORKSPACE_BUSY");
      const mainSession = await h.spawnWorkerSession(); // same registered id as the legacy scope
      expectBrokerError(() => h.sendTask(mainSession.session_id, "legacy-main"), "WORKSPACE_BUSY");
    } finally {
      h.cleanup();
    }
  });

  it("distinct physical directories run concurrently within capacity", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      const s1 = await h.spawnWorkerSession(); // ws-main
      const s2 = await h.spawnWorkerSession({
        workspace: { mode: "current", workspace_id: "ws-other" },
        account_profile_id: h.seed.accountMock3OtherQuota,
      });

      const t1 = h.sendTask(s1.session_id, "ind-1");
      const t2 = h.sendTask(s2.session_id, "ind-2");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "ind-1" },
        { kind: "complete", outcome: "completed" },
      ]);
      h.adapter.plan(t2.turn_id, [
        { kind: "barrier", name: "ind-2" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1, t2);

      // Both parked simultaneously: independent checkouts never exclude each other.
      expect(h.adapter.pendingBarriers()).toEqual(expect.arrayContaining(["ind-1", "ind-2"]));
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("RUNNING");
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("RUNNING");

      h.adapter.releaseBarrier("ind-1");
      h.adapter.releaseBarrier("ind-2");
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it.each(["missing", "different", "cleared"])("a legacy owner %s path cannot authorize a different alias", async (mode) => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-alias", h.workspaceRoot);
      insertReservation(h.db, {
        reservation_id: "res-legacy-unresolved", kind: "workspace_lease", scope: "ws-main",
        mode: "exclusive", owner_session_id: null, owner_turn_id: null,
        created_at: h.clock.now(), released_at: null,
      });
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-alias" } });
      // The former owner path is unavailable; its native child may still hold
      // the original directory. Resolving only the new alias is insufficient.
      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'")
        .run(mode === "cleared" ? null : mode === "different" ? path.dirname(h.workspaceRoot) : path.join(h.workspaceRoot, "missing-owner-path"));
      expectBrokerError(() => h.sendTask(s.session_id, "legacy-unresolved"), "WORKSPACE_BUSY");
      expect(h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get()).toMatchObject({ c: 0 });
    } finally { h.cleanup(); }
  });

  it.each(["checkout:legacy", "checkout:v1:999:999"])("legacy workspace ID %s still blocks aliases", async (legacyId) => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, legacyId, h.workspaceRoot);
      insertReservation(h.db, {
        reservation_id: "res-prefix-legacy", kind: "workspace_lease", scope: legacyId,
        mode: "exclusive", owner_session_id: null, owner_turn_id: null,
        created_at: h.clock.now(), released_at: null,
      });
      const s = await h.spawnWorkerSession();
      expectBrokerError(() => h.sendTask(s.session_id, "prefix-legacy"), "WORKSPACE_BUSY");
    } finally { h.cleanup(); }
  });

  it("checkout changed after preflight refuses admission and leaves the key reusable", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      const s = await h.spawnWorkerSession();
      const otherRoot = path.join(path.dirname(h.workspaceRoot), "ws-other");
      writeFileSync(path.join(otherRoot, "src", "main.c"), "int main(){return 0;}\n");
      const originalTx = h.db.tx.bind(h.db);
      // Inject the external registry/path change at the admission boundary,
      // after the candidate filesystem preflight, before authoritative reads.
      h.db.tx = <T>(fn: () => T): T => {
        h.db.tx = originalTx;
        h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'").run(otherRoot);
        return originalTx(fn);
      };
      const err = expectBrokerError(() => h.sendTask(s.session_id, "preflight-retarget"), "WORKSPACE_CHANGED");
      expect(err.executionStarted).toBe(false);
      expect(h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get()).toMatchObject({ c: 0 });
      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'").run(h.workspaceRoot);
      const retry = h.sendTask(s.session_id, "preflight-retarget");
      await start(h, retry);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, retry.turn_id).state).toBe("SUCCEEDED");
    } finally { h.cleanup(); }
  });

  it("known native completion cannot seal a different checkout as the final source", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      const s = await h.spawnWorkerSession();
      const t = h.sendTask(s.session_id, "completion-retarget");
      h.adapter.plan(t.turn_id, [{ kind: "barrier", name: "completion-retarget" }, { kind: "complete", outcome: "completed" }]);
      await start(h, t);
      const otherRoot = path.join(path.dirname(h.workspaceRoot), "ws-other");
      writeFileSync(path.join(otherRoot, "src", "main.c"), "int main(){return 0;}\n");
      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'").run(otherRoot);
      h.adapter.releaseBarrier("completion-retarget");
      await settle(h);
      const result = h.core.turnStatus(h.seed.coordinatorId, t.turn_id);
      expect(result.state).toBe("FAILED");
      expect(result.native_outcome).toBe("completed");
      expect(result.execution_started).toBe(true);
      expect(result.error_code).toBe("EVIDENCE_CAPTURE_FAILED");
      expect(result.final_snapshot_id).toBeNull();
    } finally { h.cleanup(); }
  });

  it("alias retargeted between acceptance and dispatch is refused with zero inference", async (ctx) => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    const baseDir = path.dirname(h.workspaceRoot);
    const linkPath = path.join(baseDir, "ws-retarget-link");
    const otherRoot = path.join(baseDir, "ws-other");
    try {
      if (!tryCreateLink(h.workspaceRoot, linkPath)) {
        ctx.skip();
        return;
      }
      registerAliasWorkspace(h, "ws-link", linkPath);
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });
      const t = h.sendTask(s.session_id, "retarget-key");
      expect(t.state).toBe("ACCEPTED"); // not started yet (deferred execution)

      // Make the retarget target CONTENT-IDENTICAL: only the physical identity
      // revalidation can catch this retarget, not the baseline digest check.
      writeFileSync(path.join(otherRoot, "src", "main.c"), "int main(){return 0;}\n", "utf8");
      removeLink(linkPath);
      if (!tryCreateLink(otherRoot, linkPath)) throw new Error("link re-creation failed");

      h.executor.startTurn(t.turn_id);
      await settleTurn(h, t.turn_id);

      const turn = h.core.turnStatus(h.seed.coordinatorId, t.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(t.turn_id)).not.toBe(true);
      expect(h.adapter.executedSteps(t.turn_id)).toEqual([]);
      expect(turn.native_conversation_ref).toBeNull();
    } finally {
      removeLink(linkPath);
      h.cleanup();
    }
  });

  it("operator quarantine on one alias blocks writers through the other alias", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-alias", h.workspaceRoot);
      h.db.raw
        .prepare("UPDATE workspaces SET quarantined = 1, quarantine_reason = 'operator hold' WHERE workspace_id = 'ws-alias'")
        .run();

      const s = await h.spawnWorkerSession(); // ws-main
      const err = expectBrokerError(() => h.sendTask(s.session_id, "quarantined-alias"), "WORKSPACE_BUSY");
      expect(err.details?.quarantined_workspace_id).toBe("ws-alias");
    } finally {
      h.cleanup();
    }
  });

  it.each(["missing", "different", "cleared"])("unbound quarantine remains conservative after %s retarget", async (mode) => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-quarantined", h.workspaceRoot);
      h.db.raw.prepare("UPDATE workspaces SET quarantined = 1, canonical_path = ? WHERE workspace_id = 'ws-quarantined'")
        .run(mode === "cleared" ? null : mode === "different" ? path.dirname(h.workspaceRoot) : path.join(h.workspaceRoot, "missing-quarantine-path"));
      const s = await h.spawnWorkerSession();
      expectBrokerError(() => h.sendTask(s.session_id, "quarantine-retarget"), "WORKSPACE_BUSY");
    } finally { h.cleanup(); }
  });

  it("physical UNKNOWN quarantine stays on its leased checkout after registry retarget; unrelated root remains usable", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      registerAliasWorkspace(h, "ws-original-alias", h.workspaceRoot);
      const s = await h.spawnWorkerSession();
      const blocked = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-original-alias" } });
      const unrelated = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-other" }, account_profile_id: h.seed.accountMock3OtherQuota });
      const t = h.sendTask(s.session_id, "physical-unknown");
      h.adapter.plan(t.turn_id, [{ kind: "barrier", name: "physical-unknown" }, { kind: "complete", outcome: "completed" }]);
      await start(h, t);
      await h.executor.forceUnknownForTest(t.turn_id, new Error("lost owner"));
      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'")
        .run(path.join(path.dirname(h.workspaceRoot), "ws-other"));
      expectBrokerError(() => h.sendTask(blocked.session_id, "original-alias"), "WORKSPACE_BUSY");
      const otherTurn = h.sendTask(unrelated.session_id, "unrelated-after-retarget");
      await start(h, otherTurn);
      await settleTurn(h, otherTurn.turn_id);
      expect(h.core.turnStatus(h.seed.coordinatorId, otherTurn.turn_id).state).toBe("SUCCEEDED");
    } finally { h.cleanup(); }
  });

  it("foreign unbound quarantine blocks conservatively without disclosing its registry identity or reason", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    try {
      h.db.raw.prepare("INSERT INTO projects(project_id,display_name,created_at) VALUES ('foreign-project','foreign',?)").run(h.clock.now());
      insertWorkspace(h.db, {
        workspace_id: "foreign-private-checkout", project_id: "foreign-project", mode: "current",
        canonical_path: null, quarantined: true, quarantine_reason: "foreign-private-reason", coverage_profile_id: null,
      });
      const s = await h.spawnWorkerSession();
      const err = expectBrokerError(() => h.sendTask(s.session_id, "foreign-hold"), "WORKSPACE_BUSY");
      expect(JSON.stringify(err.toJSON())).not.toContain("foreign-private");
    } finally { h.cleanup(); }
  });

  it("UNKNOWN quarantine blocks aliases across restart, even re-scoped as a legacy lease", async () => {
    const h = createHarness({ limits: ALIAS_LIMITS });
    registerAliasWorkspace(h, "ws-alias", h.workspaceRoot);
    let stateDir: string | null = null;
    try {
      const s1 = await h.spawnWorkerSession(); // ws-main
      const t1 = h.sendTask(s1.session_id, "quarantine-key");
      h.adapter.plan(t1.turn_id, [
        { kind: "barrier", name: "hold-unknown" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      await h.executor.forceUnknownForTest(t1.turn_id, new Error("supervisor died in crash window"));
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("UNKNOWN");

      // Simulate a pre-upgrade lease row: scope is the workspace id.
      h.db.raw.prepare("UPDATE reservations SET scope = 'ws-main' WHERE kind = 'workspace_lease' AND released_at IS NULL").run();

      const s2 = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-alias" } });
      expectBrokerError(() => h.sendTask(s2.session_id, "alias-after-unknown"), "WORKSPACE_BUSY");

      // Restart: recovery retains the UNKNOWN quarantine; the alias stays blocked.
      stateDir = await fs.mkdtemp(path.join(tmpdir(), "agent-broker-alias-restart-"));
      const lifecycle = new DaemonLifecycle(h.db, h.clock);
      const report = await lifecycle.start(stateDir);
      expect(report.quarantined_unknown_turns).toContain(t1.turn_id);
      expectBrokerError(() => h.sendTask(s2.session_id, "alias-after-restart"), "WORKSPACE_BUSY");

      // The quarantined operation still replays; nothing was released.
      const replay = h.sendTask(s1.session_id, "quarantine-key");
      expect(replay.replayed_request).toBe(true);
      expect(replay.state).toBe("UNKNOWN");
      await lifecycle.shutdown();
    } finally {
      if (stateDir) rmSync(stateDir, { recursive: true, force: true });
      h.cleanup();
    }
  });
});
