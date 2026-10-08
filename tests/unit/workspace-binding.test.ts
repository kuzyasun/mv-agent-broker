/**
 * A06 acceptance: durable physical cwd binding.
 *
 * New physical sessions durably bind the FS-resolved physical checkout
 * (realpath + dev/ino scope) of their native cwd at metadata-only provisioning,
 * inside the session-owned provision intent. Turns dispatch that PINNED cwd — never a
 * re-resolved mutable registered alias — so a junction retarget after
 * dispatch cannot move native workspace IO to a checkout the session does not
 * lease. Sessions provisioned without a binding
 * get an explicit pre-dispatch refusal requiring replacement (native context
 * retained); review-slot sessions remain broker-owned.
 * All mock-level, no inference; filesystem fixtures are real temp dirs.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, cpSync } from "node:fs";
import path from "node:path";
import { createHarness, settle, settleTurn, start, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import {
  PHYSICAL_CWD_BINDING_VERSION,
  readSessionPhysicalBinding,
  resolvePhysicalCheckoutIdentity,
} from "../../src/workspaces/identity.ts";
import { insertPolicyProfile, insertWorkspace } from "../../src/storage/repo.ts";
import { TurnExecutor } from "../../src/core/execution.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openInputViewStore } from "../../src/inputs/views.ts";
import { openReviewSlotStore } from "../../src/workspaces/slot.ts";
import type { TurnExecutionRequest, TurnExecutionResult } from "../../src/runtime/adapter.ts";

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

/** Register a workspace name that reaches the checkout through `linkPath`. */
function registerLinkWorkspace(h: Harness, workspaceId: string, linkPath: string): void {
  insertWorkspace(h.db, {
    workspace_id: workspaceId,
    project_id: h.seed.projectId,
    mode: "current",
    canonical_path: linkPath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: null,
  });
}

/** Capture every dispatch request without altering adapter behavior. */
function recordDispatch(h: Harness): { requests: TurnExecutionRequest[] } {
  const requests: TurnExecutionRequest[] = [];
  const original = h.adapter.executeTurn.bind(h.adapter);
  type Exec = typeof original;
  (h.adapter as unknown as { executeTurn: Exec }).executeTurn = (req, gate, onEvent): Promise<TurnExecutionResult> => {
    requests.push(req);
    return original(req, gate, onEvent);
  };
  return { requests };
}

function provisionPayload(h: Harness, sessionId: string): Record<string, unknown> {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=?")
    .get(sessionId) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function rewriteProvisionPayload(h: Harness, sessionId: string, mutate: (p: Record<string, unknown>) => void): void {
  const payload = provisionPayload(h, sessionId);
  mutate(payload);
  h.db.raw
    .prepare("UPDATE intents SET payload=? WHERE kind='provision_session' AND session_id=?")
    .run(JSON.stringify(payload), sessionId);
}

function countRows(h: Harness, table: string): number {
  return (h.db.raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

async function waitBarrier(h: Harness, name: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!h.adapter.pendingBarriers().includes(name)) {
    if (Date.now() > deadline) throw new Error(`barrier ${name} was never reached`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const BINDING_LIMITS = { globalUnfinishedTurns: 10, quotaScopeUnfinishedTurns: 10 };

describe("A06: durable physical cwd binding", () => {
  it("refuses a legacy lease for a physically bound session without dispatching or discarding context", async () => {
    const h = createHarness();
    const { requests } = recordDispatch(h);
    try {
      const session = await h.spawnWorkerSession();
      const first = h.sendTask(session.session_id, "lease-context");
      await start(h, first);
      await settleTurn(h, first.turn_id);
      const before = h.core.sessionStatus(h.seed.coordinatorId, session.session_id);
      const turn = h.sendTask(session.session_id, "legacy-lease");
      h.db.raw.prepare("UPDATE reservations SET scope='ws-main' WHERE kind='workspace_lease' AND owner_turn_id=? AND released_at IS NULL").run(turn.turn_id);
      await start(h, turn);
      await settleTurn(h, turn.turn_id);
      expect(requests).toHaveLength(1);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({ state: "FAILED", execution_started: false });
      expect(h.core.sessionStatus(h.seed.coordinatorId, session.session_id).native_conversation_ref).toBe(before.native_conversation_ref);
    } finally { h.cleanup(); }
  });

  it("refuses dispatch when the persisted physical binding is corrupt", async () => {
    const h = createHarness();
    const { requests } = recordDispatch(h);
    try {
      const session = await h.spawnWorkerSession();
      expect(session.state).toBe("IDLE");
      rewriteProvisionPayload(h, session.session_id, (p) => {
        (p.physical_workspace as Record<string, unknown>).lease_scope = "physical:corrupt";
      });
      const turn = h.sendTask(session.session_id, "corrupt-binding");
      await start(h, turn);
      await settleTurn(h, turn.turn_id);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id)).toMatchObject({
        state: "FAILED",
        execution_started: false,
      });
      expect(requests).toHaveLength(0);
    } finally { h.cleanup(); }
  });

  it("provisioning binds the FS-resolved physical cwd and dev/inode scope of the junction", async (ctx) => {
    const h = createHarness();
    const link = path.join(path.dirname(h.workspaceRoot), "ws-link");
    try {
      if (!tryCreateLink(h.workspaceRoot, link)) {
        ctx.skip();
        return;
      }
      registerLinkWorkspace(h, "ws-link", link);
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });
      expect(s.state).toBe("IDLE");
      const pw = provisionPayload(h, s.session_id).physical_workspace as {
        binding_version: number;
        canonical_cwd: string;
        lease_scope: string;
        bound_at: number;
      };
      expect(pw.binding_version).toBe(PHYSICAL_CWD_BINDING_VERSION);
      // The junction spelling is never bound: the exact resolved target is.
      expect(pw.canonical_cwd).toBe(realpathSync(link));
      expect(pw.canonical_cwd).not.toBe(link);
      expect(pw.lease_scope).toBe(resolvePhysicalCheckoutIdentity(h.workspaceRoot)!.scope);
      expect(readSessionPhysicalBinding(h.db, s.session_id)).toMatchObject({
        kind: "bound",
        binding: { canonical_cwd: pw.canonical_cwd, lease_scope: pw.lease_scope },
      });
    } finally {
      removeLink(link);
      h.cleanup();
    }
  });

  it("dispatch pins the junction's physical target; mid-turn retarget keeps owned writes on A and captures no snapshots", async (ctx) => {
    const h = createHarness({ limits: BINDING_LIMITS });
    const baseDir = path.dirname(h.workspaceRoot);
    const otherRoot = path.join(baseDir, "ws-other");
    const link = path.join(baseDir, "ws-link");
    try {
      if (!tryCreateLink(h.workspaceRoot, link)) {
        ctx.skip();
        return;
      }
      registerLinkWorkspace(h, "ws-link", link);
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });
      const { requests } = recordDispatch(h);
      const t1 = h.sendTask(s.session_id, "pinned-a");
      h.adapter.plan(t1.turn_id, [
        { kind: "report_native_ref", ref: "mock-native-a06" },
        { kind: "barrier", name: "mid-turn" },
        { kind: "workspace_write", files: [{ path: "src/a06-write.c", content: "on A\n" }] },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(h, t1);
      await waitBarrier(h, "mid-turn");

      // The dispatched cwd resolves DIRECTLY to A — not the junction spelling.
      expect(requests).toHaveLength(1);
      const dispatched = requests[0]!.workspace_path!;
      expect(dispatched).not.toBe(link);
      expect(dispatched).toBe(realpathSync(h.workspaceRoot));
      expect(resolvePhysicalCheckoutIdentity(dispatched)?.scope).toBe(
        resolvePhysicalCheckoutIdentity(h.workspaceRoot)?.scope,
      );

      // A separate writer on the distinct checkout B is admitted and finishes
      // while A's lease is still held: different physical leases never overlap.
      const sB = await h.spawnWorkerSession({
        workspace: { mode: "current", workspace_id: "ws-other" },
        account_profile_id: h.seed.accountMock3OtherQuota,
      });
      const tB = h.sendTask(sB.session_id, "b-writer");
      h.adapter.plan(tB.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, tB);
      await settleTurn(h, tB.turn_id);
      expect(h.core.turnStatus(h.seed.coordinatorId, tB.turn_id).state).toBe("SUCCEEDED");
      expect(requests[1]!.workspace_path).toBe(realpathSync(otherRoot));
      expect(h.adapter.pendingBarriers()).toContain("mid-turn");

      // Retarget the junction to B mid-turn; the physical root A is untouched.
      removeLink(link);
      if (!tryCreateLink(otherRoot, link)) throw new Error("junction retarget failed");
      const snapsBefore = countRows(h, "snapshot_records");
      h.adapter.releaseBarrier("mid-turn");
      await settleTurn(h, t1.turn_id);

      // The owned write followed the captured cwd: on A only, B unchanged.
      expect(readFileSync(path.join(h.workspaceRoot, "src", "a06-write.c"), "utf8")).toBe("on A\n");
      expect(existsSync(path.join(otherRoot, "src", "a06-write.c"))).toBe(false);

      // Retargeting after dispatch does not change the pinned cwd or trigger
      // automatic source capture. The owned write remains on A.
      const done = h.core.turnStatus(h.seed.coordinatorId, t1.turn_id);
      expect(done.state).toBe("SUCCEEDED");
      expect(done.native_outcome).toBe("completed");
      expect(done.execution_started).toBe(true);
      expect(done.final_snapshot_id).toBeNull();
      expect(countRows(h, "snapshot_records")).toBe(snapsBefore);
      const sess = h.core.sessionStatus(h.seed.coordinatorId, s.session_id);
      expect(sess.initial_snapshot_id).toBeNull();
      expect(sess.latest_snapshot_id).toBeNull();
      expect(sess.state).toBe("IDLE");
    } finally {
      removeLink(link);
      h.cleanup();
    }
  });

  it("dispatch via a retargeted registry refuses before inference and preserves context", async (ctx) => {
    const h = createHarness({ limits: BINDING_LIMITS });
    const baseDir = path.dirname(h.workspaceRoot);
    const otherRoot = path.join(baseDir, "ws-other");
    const link = path.join(baseDir, "ws-link");
    try {
      if (!tryCreateLink(h.workspaceRoot, link)) {
        ctx.skip();
        return;
      }
      registerLinkWorkspace(h, "ws-link", link);
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });
      const t1 = h.sendTask(s.session_id, "flow-key");
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
      const contextRef = h.core.sessionStatus(h.seed.coordinatorId, s.session_id).native_conversation_ref;

      // Retarget to a content-identical B: only physical identity can refuse.
      cpSync(h.workspaceRoot, otherRoot, { recursive: true });
      removeLink(link);
      if (!tryCreateLink(otherRoot, link)) throw new Error("junction retarget failed");
      const turn = h.sendTask(s.session_id, "retargeted-send");
      await start(h, turn);
      await settleTurn(h, turn.turn_id);
      const refused = h.core.turnStatus(h.seed.coordinatorId, turn.turn_id);
      expect(refused).toMatchObject({ state: "FAILED", error_code: "WORKSPACE_CHANGED", execution_started: false });
      expect(h.adapter.dispatchPermissionAcquired(turn.turn_id)).toBeNull();
      const after = h.core.sessionStatus(h.seed.coordinatorId, s.session_id);
      expect(after.state).toBe("IDLE");
      expect(after.native_conversation_ref).toBe(contextRef); // context retained
      expect(after.context_status).toBe("available");

      // Correcting the registered alias allows a later plain send to resume
      // the same native context from its pinned checkout.
      removeLink(link);
      if (!tryCreateLink(h.workspaceRoot, link)) throw new Error("junction restore failed");
      const t2 = h.sendTask(s.session_id, "flow-corrected");
      expect(t2.state).toBe("ACCEPTED");
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
    } finally {
      removeLink(link);
      h.cleanup();
    }
  });

  it("a byte-identical new root is refused by physical identity, not content", async () => {
    const h = createHarness({ limits: BINDING_LIMITS });
    try {
      const s = await h.spawnWorkerSession();
      const t1 = h.sendTask(s.session_id, "identity-1");
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");

      const copyRoot = path.join(path.dirname(h.workspaceRoot), "ws-copy");
      cpSync(h.workspaceRoot, copyRoot, { recursive: true });
      // The copy is provably content-identical but a different checkout.
      expect(readFileSync(path.join(copyRoot, "src", "main.c"), "utf8")).toBe(
        readFileSync(path.join(h.workspaceRoot, "src", "main.c"), "utf8"),
      );
      expect(resolvePhysicalCheckoutIdentity(copyRoot)!.scope).not.toBe(
        resolvePhysicalCheckoutIdentity(h.workspaceRoot)!.scope,
      );

      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'").run(copyRoot);
      const refused = h.sendTask(s.session_id, "identity-drift");
      await start(h, refused);
      await settleTurn(h, refused.turn_id);
      expect(h.core.turnStatus(h.seed.coordinatorId, refused.turn_id)).toMatchObject({
        state: "FAILED",
        error_code: "WORKSPACE_CHANGED",
        execution_started: false,
      });
      expect(h.adapter.dispatchPermissionAcquired(refused.turn_id)).toBeNull();

      // Restoring the registered alias makes the same key reusable again.
      h.db.raw.prepare("UPDATE workspaces SET canonical_path = ? WHERE workspace_id = 'ws-main'").run(h.workspaceRoot);
      const t2 = h.sendTask(s.session_id, "identity-restored");
      await start(h, t2);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t2.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("the pinned cwd is byte-stable across logical resume and executor restart", async (ctx) => {
    const h = createHarness({ limits: BINDING_LIMITS });
    const link = path.join(path.dirname(h.workspaceRoot), "ws-link");
    try {
      if (!tryCreateLink(h.workspaceRoot, link)) {
        ctx.skip();
        return;
      }
      registerLinkWorkspace(h, "ws-link", link);
      const s = await h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-link" } });
      const { requests } = recordDispatch(h);

      const t1 = h.sendTask(s.session_id, "stable-1"); // new native conversation
      await start(h, t1);
      await settle(h);
      const t2 = h.sendTask(s.session_id, "stable-2"); // logical resume
      await start(h, t2);
      await settle(h);

      // Daemon restart shape: a fresh executor over the same registry DB.
      const restarted = new TurnExecutor({
        db: h.db,
        clock: h.clock,
        limits: h.limits,
        adapters: new Map([["mock", h.adapter]]),
        blobs: openBlobStore(h.blobRoot),
        inputViews: openInputViewStore(h.inputRoot),
        slots: openReviewSlotStore(h.slotsRoot),
      });
      h.executor = restarted;
      h.core.attachExecutor(restarted);
      const t3 = h.sendTask(s.session_id, "stable-3"); // resume after restart
      await start(h, t3);
      await settle(h);

      expect(requests).toHaveLength(3);
      const [p1, p2, p3] = requests.map((r) => r.workspace_path);
      expect(p1).toBe(realpathSync(h.workspaceRoot)); // never the junction spelling
      expect(p2).toBe(p1); // resume: exact same bytes
      expect(p3).toBe(p1); // restart: exact same bytes
      const binding = readSessionPhysicalBinding(h.db, s.session_id);
      expect(binding.kind).toBe("bound");
      if (binding.kind === "bound") expect(binding.binding.canonical_cwd).toBe(p1);
      expect(h.core.turnStatus(h.seed.coordinatorId, t3.turn_id).state).toBe("SUCCEEDED");
    } finally {
      removeLink(link);
      h.cleanup();
    }
  });

  it("a historically unbound physical session refuses explicitly pre-dispatch and keeps its native context", async () => {
    const h = createHarness();
    try {
      const s = await h.spawnWorkerSession();
      const t1 = h.sendTask(s.session_id, "ctx-1");
      await start(h, t1);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t1.turn_id).state).toBe("SUCCEEDED");
      const before = h.core.sessionStatus(h.seed.coordinatorId, s.session_id);
      expect(before.context_status).toBe("available");

      // Simulate a pre-package journal: the physical cwd binding is absent.
      rewriteProvisionPayload(h, s.session_id, (p) => {
        delete p.physical_workspace;
      });
      expect(readSessionPhysicalBinding(h.db, s.session_id).kind).toBe("unbound");

      // The mutable alias cannot be safely reinterpreted: explicit pre-dispatch
      // incompatibility — no dispatch, no fresh-conversation fallback.
      const sent = h.sendTask(s.session_id, "ctx-2");
      expect(sent.state).toBe("ACCEPTED");
      await start(h, sent);
      await settleTurn(h, sent.turn_id);
      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("INVALID_REQUEST");
      expect(turn.execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).not.toBe(true);
      expect(h.adapter.executedSteps(sent.turn_id)).toEqual([]);
      const events = h.core.turnEvents(h.seed.coordinatorId, sent.turn_id, 0, 50);
      const terminal = events.find((e) => e.type === "turn_terminal");
      expect(JSON.stringify(terminal?.payload)).toMatch(/replacement session/);

      // Native context and history are retained; a replacement is required.
      const after = h.core.sessionStatus(h.seed.coordinatorId, s.session_id);
      expect(after.state).toBe("IDLE");
      expect(after.native_conversation_ref).toBe(before.native_conversation_ref);
      expect(after.context_status).toBe("available");
    } finally {
      h.cleanup();
    }
  });

  it("path-less and review-slot sessions keep their contracts (no physical binding)", async () => {
    const h = createHarness();
    try {
      await expect(h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: null } }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", executionStarted: false });

      // Review slots never bind or require a physical checkout; their cwd is
      // the broker-owned slot.
      insertWorkspace(h.db, {
        workspace_id: "ws-review",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: null,
      });
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-readonly",
        version: "1",
        config: JSON.stringify({ access: "read_only" }),
      });
      const reviewer = await h.spawnWorkerSession({
        role: "reviewer",
        workspace: { mode: "review_slot", workspace_id: "ws-review" },
        policy_profile_id: "pol-readonly",
      });
      expect(reviewer.state).toBe("IDLE");
      expect(provisionPayload(h, reviewer.session_id).physical_workspace).toBeUndefined();
    } finally {
      h.cleanup();
    }
  });

  it("rejects a registered checkout with no stable physical identity", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-broken",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: path.join(path.dirname(h.workspaceRoot), "does-not-exist"),
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: null,
      });
      const before = countRows(h, "sessions");
      await expect(h.spawnWorkerSession({ workspace: { mode: "current", workspace_id: "ws-broken" } }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST", executionStarted: false });
      expect(countRows(h, "sessions")).toBe(before);
      expect(countRows(h, "turns")).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});
