/**
 * Spec §8.3 acceptance: broker-created detached Git worktrees.
 *
 * Real disposable temp Git repositories with own commits (normal installed
 * Git, plain argument form) — never the project repository. Covers: additive
 * public workspace fields (repository_workspace_id, base_commit) validated
 * before admission; detached worktree creation under the broker-managed root
 * at a hash-of-session path; dirty/untracked source content NOT copied;
 * idempotent same-key provisions incl. crash windows; repository-level
 * mutation serialization keyed by the shared Git common dir (aliases cannot
 * bypass it); injected Git failures and foreign paths preserving data; stop
 * preserving the dirty worktree; capture/coverage behavior; discovery
 * exposing eligible registered references. No inference anywhere (mock).
 */
import { describe, expect, it, vi } from "vitest";
import * as managedJob from "../../src/providers/common/windowsJob.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHarness, settle, start, COVERAGE_CONFIG, type Harness } from "../helpers/harness.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { BrokerCore } from "../../src/core/broker.ts";
import type { SpawnRequest } from "../../src/core/broker.ts";
import { insertProject, insertWorkspace } from "../../src/storage/repo.ts";
import { readSessionPhysicalBinding } from "../../src/workspaces/identity.ts";
import { computeSourceDigest, takeInventory } from "../../src/workspaces/inventory.ts";
import {
  createRealWorktreeGitRunner,
  WorktreeGitRunError,
  type WorktreeGitRunner,
  type WorktreeGitRun,
  type WorktreeCompletionReceipt,
} from "../../src/workspaces/worktree.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";
import { callBridgeTool, bridgeToolDefs } from "../../src/bridge/tools.ts";

// ─── disposable Git fixtures (offline, plain git args, own temp dirs) ───────

/** Runs one plain Git command in a disposable fixture repo (never the project). */
function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

function createRepo(baseDir: string, name: string, objectFormat?: "sha256"): { repoPath: string; head: string } {
  const repoPath = path.join(baseDir, name);
  mkdirSync(path.join(repoPath, "src"), { recursive: true });
  git(repoPath, objectFormat ? ["init", `--object-format=${objectFormat}`] : ["init"]);
  git(repoPath, ["config", "user.email", "broker-test@example.invalid"]);
  git(repoPath, ["config", "user.name", "Broker Test"]);
  writeFileSync(path.join(repoPath, "src", "main.c"), "int main(){return 0;}\n", "utf8");
  writeFileSync(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  return { repoPath, head: git(repoPath, ["rev-parse", "HEAD"]) };
}

/** Real runner wrapped with recording + test-owned fault/delay/park hooks. */
class RecordingRunner implements WorktreeGitRunner {
  readonly calls: Array<{ kind: string; args: string[] }> = [];
  readonly mutations: Array<{ start: number; end: number }> = [];
  failNextMutate: Error | null = null;
  postMutateDelayMs = 0;
  lastCompletion: WorktreeCompletionReceipt | null = null;
  /** When set, the next mutation awaits this forever BEFORE dispatch (never started). */
  parkNextDispatch: Promise<void> | null = null;
  /** When set, EVERY runner call awaits this gate before running (deterministic staging). */
  gate: Promise<void> | null = null;
  private inner = createRealWorktreeGitRunner();

  async run(args: WorktreeGitRun): Promise<{ stdout: string; completion?: WorktreeCompletionReceipt }> {
    if (this.gate) await this.gate;
    if (args.kind === "mutate") {
      if (this.parkNextDispatch) {
        await this.parkNextDispatch; // never resolves: process died pre-dispatch
      }
      this.calls.push({ kind: args.kind, args: args.gitArgs });
      if (this.failNextMutate) {
        const e = this.failNextMutate;
        this.failNextMutate = null;
        throw e;
      }
      const startMs = Date.now();
      const res = await this.inner.run(args);
      this.lastCompletion = res.completion ?? null;
      if (this.postMutateDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.postMutateDelayMs));
      }
      this.mutations.push({ start: startMs, end: Date.now() });
      return res;
    }
    this.calls.push({ kind: args.kind, args: args.gitArgs });
    return this.inner.run(args);
  }

  addCalls(): Array<{ args: string[] }> {
    return this.calls.filter((c) => c.args[0] === "worktree");
  }
}

/** Registered repository workspace + worktree-enabled broker core fixture. */
interface WorktreeFixture {
  h: Harness;
  core: BrokerCore;
  worktreesRoot: string;
  repoPath: string;
  head: string;
  runner: RecordingRunner;
  junctionOk: boolean;
  worktreeSpawn(key: string, overrides?: Partial<SpawnRequest>): ReturnType<BrokerCore["spawn"]>;
  spawnRequest(key: string, overrides?: Partial<SpawnRequest>): SpawnRequest;
  drain(): Promise<void>;
  journalPath(sessionId: string): string;
  cleanup(): void;
}

function makeFixture(opts: { withJunctionAlias?: boolean } = {}): WorktreeFixture {
  const h = createHarness();
  const rawBaseDir = mkdtempSync(path.join(tmpdir(), "agent-broker-wt-"));
  const baseDir =
    process.platform === "win32" && typeof realpathSync.native === "function"
      ? realpathSync.native(rawBaseDir)
      : realpathSync(rawBaseDir);
  const worktreesRoot = path.join(baseDir, "managed-worktrees");
  mkdirSync(worktreesRoot, { recursive: true });
  const { repoPath, head } = createRepo(baseDir, "source-repo");

  insertWorkspace(h.db, {
    workspace_id: "ws-repo",
    project_id: h.seed.projectId,
    mode: "current",
    canonical_path: repoPath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: h.seed.coverageProfileId,
  });
  let junctionOk = true;
  if (opts.withJunctionAlias) {
    const aliasPath = path.join(baseDir, "repo-alias");
    try {
      symlinkSync(repoPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
      insertWorkspace(h.db, {
        workspace_id: "ws-repo-alias",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: aliasPath,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
    } catch {
      junctionOk = false;
    }
  }
  const runner = new RecordingRunner();
  const core = new BrokerCore({
    db: h.db,
    clock: h.clock,
    adapters: new Map([["mock", h.adapter]]),
    limits: h.limits,
    deferExecution: true,
    blobStore: h.core.blobStore,
    worktreesRoot,
    worktreeGitRunner: runner,
  });
  core.attachExecutor(h.executor);

  const spawnRequest = (key: string, overrides: Partial<SpawnRequest> = {}): SpawnRequest => ({
    project_id: h.seed.projectId,
    idempotency_key: key,
    provider: "mock",
    account_profile_id: h.seed.accountMock1,
    model: "mock-model-1",
    effort: null,
    role: "worker",
    instructions: "Worktree task.",
    workspace: {
      mode: "worktree",
      workspace_id: null,
      repository_workspace_id: "ws-repo",
      base_commit: head,
    },
    policy_profile_id: "pol-writer",
    ...overrides,
  });
  return {
    h,
    core,
    worktreesRoot,
    repoPath,
    head,
    runner,
    junctionOk,
    worktreeSpawn: (key, overrides = {}) => core.spawn(h.seed.coordinatorId, spawnRequest(key, overrides)),
    spawnRequest,
    async drain() {
      await core.drain();
      await h.executor.drain();
    },
    journalPath(sessionId) {
      const row = h.db.raw
        .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
        .get(sessionId) as { payload: string };
      return (JSON.parse(row.payload) as { worktree_provisioning: { worktree_path: string } }).worktree_provisioning.worktree_path;
    },
    cleanup() {
      rmSyncRetry(baseDir);
      h.cleanup();
    },
  };
}

/** Windows can transiently EPERM while AV/indexer handles settle: small retry. */
function rmSyncRetry(dir: string, attempts = 5): void {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      if (i >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (i + 1));
    }
  }
}

function workspaceCount(f: WorktreeFixture): number {
  return (f.h.db.raw.prepare("SELECT COUNT(*) c FROM workspaces").get() as { c: number }).c;
}

function sessionCount(f: WorktreeFixture): number {
  return (f.h.db.raw.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c;
}

interface RawJournal {
  stage: string;
  launch: Record<string, unknown> | null;
  completion?: Record<string, unknown> | null;
  lock: Record<string, unknown> | null;
  worktree_path: string;
  source_common_dir: string;
  workspace_id: string;
  base_commit: string;
}

function rawJournal(f: WorktreeFixture, sessionId: string): RawJournal {
  const row = f.h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
    .get(sessionId) as { payload: string };
  return (JSON.parse(row.payload) as { worktree_provisioning: RawJournal }).worktree_provisioning;
}

function intentState(f: WorktreeFixture, sessionId: string): string {
  return (
    f.h.db.raw
      .prepare("SELECT state FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
      .get(sessionId) as { state: string }
  ).state;
}

/** Overwrite the durable journal the way a killed process would have left it. */
function craftJournal(f: WorktreeFixture, sessionId: string, patch: Partial<RawJournal>): void {
  const row = f.h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
    .get(sessionId) as { payload: string; };
  const payload = JSON.parse(row.payload) as { worktree_provisioning: RawJournal };
  payload.worktree_provisioning = { ...payload.worktree_provisioning, ...patch };
  f.h.db.raw
    .prepare("UPDATE intents SET payload = ? WHERE kind='provision_session' AND session_id=?")
    .run(JSON.stringify(payload), sessionId);
}

/** Fake-but-well-formed owned launch receipt (never produced by the job protocol). */
function fakeLaunch(): Record<string, unknown> {
  return {
    nonce: "crafted-nonce",
    launch_uuid: "00000000-0000-4000-8000-000000000000",
    named_job: "Local\\agent-broker-job-crafted",
    root_pid: 4194304,
    root_creation_time: "133000000000000000",
    owner_pid: 12345,
    owner_creation_time: "132999999999999999",
    helper_pid: 67890,
  };
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A fresh broker core over the same registry (daemon restart simulation). */
function restartedCore(f: WorktreeFixture, runner: WorktreeGitRunner): BrokerCore {
  const core = new BrokerCore({
    db: f.h.db,
    clock: f.h.clock,
    adapters: new Map([["mock", f.h.adapter]]),
    limits: f.h.limits,
    deferExecution: true,
    blobStore: f.h.core.blobStore,
    worktreesRoot: f.worktreesRoot,
    worktreeGitRunner: runner,
  });
  core.attachExecutor(f.h.executor);
  return core;
}

/** Registers a second, independent repository workspace (distinct common dir). */
function registerOtherRepo(f: WorktreeFixture, id: string): { repoPath: string; head: string } {
  const { repoPath, head } = createRepo(path.dirname(f.repoPath), id);
  insertWorkspace(f.h.db, {
    workspace_id: `ws-${id}`,
    project_id: f.h.seed.projectId,
    mode: "current",
    canonical_path: repoPath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: f.h.seed.coverageProfileId,
  });
  return { repoPath, head };
}

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

// ─── tests ──────────────────────────────────────────────────────────────────

describe("§8.3 broker-created detached worktrees", () => {
  it("provisions a detached worktree at the explicit base commit and reports the additive fields", async () => {
    const f = makeFixture();
    try {
      const branchesBefore = git(f.repoPath, ["branch", "--list"]);
      const resp = f.worktreeSpawn("wt-happy");
      expect(resp.replayed_request).toBe(false);
      expect(resp.worktree).toMatchObject({
        base_commit: f.head,
        current_checkout_changes_copied: false,
      });
      expect(resp.worktree?.workspace_id).toMatch(/^ws-/);
      await f.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      expect(session.workspace_id).toBe(resp.worktree!.workspace_id);
      expect(session.workspace_mode).toBe("worktree");
      expect(session.initial_snapshot_id).toBeTruthy();

      // Generated workspace row: registered worktree mode, hashed managed path.
      const row = f.h.db.raw.prepare("SELECT * FROM workspaces WHERE workspace_id=?").get(resp.worktree!.workspace_id) as Record<string, unknown>;
      expect(row.mode).toBe("worktree");
      expect(row.project_id).toBe(f.h.seed.projectId);
      expect(String(row.coverage_profile_id)).toBe(f.h.seed.coverageProfileId);
      const wtPath = String(row.canonical_path);
      expect(wtPath.startsWith(realpathSync(f.worktreesRoot))).toBe(true);
      expect(path.basename(wtPath)).toBe(`wt-${sha256Hex(resp.session_id)}`);
      expect(existsSync(wtPath)).toBe(true);

      // Detached at the exact base commit; no branch was created or guessed.
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      const symbolic = spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: wtPath, encoding: "utf8", windowsHide: true });
      expect(symbolic.status).not.toBe(0); // detached: no branch ref
      expect(git(f.repoPath, ["branch", "--list"])).toBe(branchesBefore); // unchanged
      expect(git(f.repoPath, ["rev-parse", "HEAD"])).toBe(f.head); // source untouched
      const porcelain = git(f.repoPath, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/");
      expect(porcelain.toLowerCase()).toContain(wtPath.replace(/\\/g, "/").toLowerCase());

      // Initial snapshot captures exactly the new worktree.
      const snap = f.h.db.raw.prepare("SELECT * FROM snapshot_records WHERE snapshot_id=?").get(session.initial_snapshot_id) as Record<string, unknown>;
      expect(snap.state).toBe("SEALED");
      expect(snap.workspace_id).toBe(resp.worktree!.workspace_id);
      expect(snap.git_head).toBe(f.head);

      // Dispatch binding pins the physical worktree cwd.
      const binding = readSessionPhysicalBinding(f.h.db, resp.session_id);
      expect(binding.kind).toBe("bound");
      if (binding.kind === "bound") {
        expect(binding.binding.canonical_cwd).toBe(realpathSync(wtPath));
      }

      // Exactly one mutation against the source repository.
      expect(f.runner.addCalls()).toHaveLength(1);

      // Discovery exposes the eligible registered repository reference.
      const discovery = f.core.discovery(f.h.seed.coordinatorId, f.h.seed.projectId, null, 100);
      const entries = discovery.entries.filter((e) => e.kind === "workspace") as Array<Record<string, unknown>>;
      const sourceEntry = entries.find((e) => e.id === "ws-repo")!;
      expect(sourceEntry.eligible_worktree_source).toBe(true);
      const generatedEntry = entries.find((e) => e.id === resp.worktree!.workspace_id)!;
      expect(generatedEntry.mode).toBe("worktree");
      expect(generatedEntry.eligible_worktree_source).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("never copies the source checkout's dirty and untracked content", async () => {
    const f = makeFixture();
    try {
      writeFileSync(path.join(f.repoPath, "src", "main.c"), "int main(){return 1;}\n", "utf8"); // dirty
      writeFileSync(path.join(f.repoPath, "src", "untracked.txt"), "local only\n", "utf8"); // untracked
      const resp = f.worktreeSpawn("wt-dirty-source");
      await f.drain();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      const wtPath = f.journalPath(resp.session_id);
      // Git may convert line endings on checkout (core.autocrlf on Windows).
      expect(readFileSync(path.join(wtPath, "src", "main.c"), "utf8").replace(/\r\n/g, "\n")).toBe("int main(){return 0;}\n");
      expect(existsSync(path.join(wtPath, "src", "untracked.txt"))).toBe(false);
      expect(resp.worktree).toMatchObject({ current_checkout_changes_copied: false });

      // The sealed initial snapshot describes the committed tree only.
      const expected = computeSourceDigest(takeInventory(wtPath, COVERAGE_CONFIG).entries, {
        profile_id: f.h.seed.coverageProfileId,
        version: "1",
        contract_hash: coverageContractHash(COVERAGE_CONFIG),
      });
      const snap = f.h.db.raw.prepare("SELECT source_digest FROM snapshot_records WHERE snapshot_id=?").get(session.initial_snapshot_id) as { source_digest: string };
      expect(snap.source_digest).toBe(expected);
    } finally {
      f.cleanup();
    }
  });

  it("returns the same session and workspace for a repeated accepted key with no duplicate add", async () => {
    const f = makeFixture();
    try {
      const first = f.worktreeSpawn("wt-lost-response");
      const second = f.worktreeSpawn("wt-lost-response");
      expect(second.replayed_request).toBe(true);
      expect(second.session_id).toBe(first.session_id);
      expect(second.worktree).toEqual(first.worktree);
      await f.drain();
      expect(f.runner.addCalls()).toHaveLength(1);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, first.session_id).state).toBe("IDLE");
      const listed = git(f.repoPath, ["worktree", "list", "--porcelain"]);
      expect(listed.match(/^worktree /gm)).toHaveLength(2); // main + one worktree
    } finally {
      f.cleanup();
    }
  });

  it("re-dispatches a crash that provably never executed the mutation (no receipt, no duplicate)", async () => {
    const f = makeFixture();
    try {
      // Park the next dispatch BEFORE the owned root is ever created: the
      // journal shows stage "adding" with NO launch receipt — positive proof
      // the mutation never resumed, so a restart may start a fresh one.
      f.runner.parkNextDispatch = new Promise<never>(() => undefined);
      const resp = f.worktreeSpawn("wt-crash-pre-dispatch");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("stage adding without receipt", () => {
        const j = rawJournal(f, resp.session_id);
        return j.stage === "adding" && j.launch === null;
      });
      expect(existsSync(wtPath)).toBe(false); // paused before target exists

      // Daemon death + restart over the same registry.
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([resp.session_id]);
      await restarted.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      expect(runner2.addCalls()).toHaveLength(1); // exactly one real add ever
      expect(f.runner.addCalls()).toHaveLength(0); // the parked one never dispatched
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(session.initial_snapshot_id).toBeTruthy();
      const j = rawJournal(f, resp.session_id);
      expect(j.stage).toBe("ready");
      expect(j.launch).not.toBeNull(); // the NEW dispatch recorded its receipt
      // The lost response still converges to the same session and workspace.
      const replay = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-crash-pre-dispatch"));
      expect(replay).toMatchObject({ session_id: resp.session_id, replayed_request: true, state: "IDLE" });
      expect(replay.worktree).toEqual(resp.worktree);
    } finally {
      f.cleanup();
    }
  });

  it("retains an uncertain owned operation after restart, quarantines, and fences the repository", async () => {
    const f = makeFixture();
    try {
      // Park AFTER the owned quiescence proof: the receipt is durable but the
      // core never got to record the completion stage — a mid-flight death.
      f.runner.postMutateDelayMs = 4_000;
      const resp = f.worktreeSpawn("wt-crash-mid-flight");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("worktree path exists", () => existsSync(wtPath));
      expect(rawJournal(f, resp.session_id).stage).toBe("adding");
      expect(rawJournal(f, resp.session_id).launch).not.toBeNull();
      expect(existsSync(wtPath)).toBe(true); // the add itself did complete

      // Restart: the operation MAY have been alive — the journal (not the
      // files) decides. Retained, quarantined, fenced; never re-added.
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([resp.session_id]);
      await restarted.drain();

      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id).state).toBe("PROVISIONING");
      expect(intentState(f, resp.session_id)).toBe("pending");
      const retained = rawJournal(f, resp.session_id);
      expect(retained.stage).toBe("adding");
      expect(retained.launch).not.toBeNull(); // journal kept verbatim
      expect(runner2.addCalls()).toHaveLength(0); // no duplicate mutation
      const generated = f.h.db.raw.prepare("SELECT quarantined FROM workspaces WHERE workspace_id=?").get(retained.workspace_id) as { quarantined: number };
      expect(generated.quarantined).toBe(1);

      // The durable fence blocks a NEW provision of the SAME repository…
      const fenced = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-fenced-same-repo"));
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, fenced.session_id).state).toBe("PROVISIONING");
      expect(runner2.addCalls()).toHaveLength(0);
      // …while an UNRELATED repository proceeds normally.
      const other = registerOtherRepo(f, "unrelated-repo");
      const otherResp = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-unrelated-repo", {
        workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: `ws-unrelated-repo`, base_commit: other.head },
      }));
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, otherResp.session_id).state).toBe("IDLE");
      expect(runner2.addCalls()).toHaveLength(1);
      expect(git(f.journalPath(otherResp.session_id), ["rev-parse", "HEAD"])).toBe(other.head);
      await f.drain();
    } finally {
      f.cleanup();
    }
  });

  it.each(["added", "ready"])("reconciles durably completed %s after restart/response-loss to one ID with one add", async (stage) => {
    const f = makeFixture();
    try {
      // The dispatch completed and the core recorded the durable completion
      // stage, but the process died before final metadata completion: craft
      // the journal into exactly that post-proof state (stage "added" with
      // the real receipt the owned job protocol produced).
      f.runner.postMutateDelayMs = 4_000;
      const resp = f.worktreeSpawn("wt-crash-post-proof");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("owned quiescence receipt", () => f.runner.lastCompletion !== null);
      const launch = f.runner.lastCompletion;
      craftJournal(f, resp.session_id, { stage, completion: launch });

      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([resp.session_id]);
      await restarted.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      expect(runner2.addCalls()).toHaveLength(0); // reconciled WITHOUT re-adding
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(rawJournal(f, resp.session_id).stage).toBe("ready");
      const j = rawJournal(f, resp.session_id);
      expect(j.launch).toEqual(launch); // the original owned receipt survives
      expect(session.initial_snapshot_id).toBeTruthy();

      // A whole-daemon restart after FULL completion replays one ID, one add.
      const runner3 = new RecordingRunner();
      const again = restartedCore(f, runner3);
      const replay = again.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-crash-post-proof"));
      expect(replay).toMatchObject({ session_id: resp.session_id, replayed_request: true, state: "IDLE" });
      expect(replay.worktree).toEqual(resp.worktree);
      expect(runner3.addCalls()).toHaveLength(0);
      const listed = git(f.repoPath, ["worktree", "list", "--porcelain"]);
      expect(listed.match(/^worktree /gm)).toHaveLength(2); // main + one worktree
      await f.drain();
    } finally {
      f.cleanup();
    }
  });

  it("fake receipts and reused/stale fencing tokens cannot unfence a repository", async () => {
    const f = makeFixture();
    try {
      // A journal whose receipt was not produced by the owned protocol (and
      // whose lock seq/hold is reused from a stale incarnation) must never
      // enable a re-add or a completion: raw JSON is not proof.
      f.runner.parkNextDispatch = new Promise<never>(() => undefined);
      const resp = f.worktreeSpawn("wt-fake-receipt");
      await waitFor("stage adding", () => rawJournal(f, resp.session_id).stage === "adding");
      const j = rawJournal(f, resp.session_id);
      craftJournal(f, resp.session_id, {
        launch: fakeLaunch(),
        lock: { key: j.source_common_dir, seq: 1, acquired_at: 1, hold_id: "crafted-hold", incarnation: "stale-incarnation" },
      });

      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([resp.session_id]);
      await restarted.drain();

      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id).state).toBe("PROVISIONING");
      expect(intentState(f, resp.session_id)).toBe("pending");
      expect(rawJournal(f, resp.session_id).stage).toBe("adding"); // still fenced
      expect(runner2.addCalls()).toHaveLength(0);
      // The crafted receipt fences the repository for NEW provisions too.
      const fenced = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-fake-receipt-fenced"));
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, fenced.session_id).state).toBe("PROVISIONING");
      expect(runner2.addCalls()).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it("a crafted completed stage without the verified worktree is never adopted or re-added", async () => {
    const f = makeFixture();
    try {
      // Stage "added" with a fake receipt but NOTHING at the allocated path:
      // recovery must fail closed with evidence — no adoption, no re-add.
      f.runner.parkNextDispatch = new Promise<never>(() => undefined);
      const resp = f.worktreeSpawn("wt-crafted-added");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("stage adding", () => rawJournal(f, resp.session_id).stage === "adding");
      const fake = fakeLaunch();
      craftJournal(f, resp.session_id, { stage: "added", launch: fake, completion: fake });

      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([resp.session_id]);
      await restarted.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("worktree-verified-state-vanished");
      expect(existsSync(wtPath)).toBe(false); // nothing was created either
      expect(runner2.addCalls()).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it("installs an uncertain mutation fence before the queued repository holder runs", async () => {
    const f = makeFixture();
    try {
      f.runner.failNextMutate = new WorktreeGitRunError("git-uncertain-after-resume", false);
      const a = f.worktreeSpawn("wt-unknown-queued-a");
      const b = f.worktreeSpawn("wt-unknown-queued-b");
      await f.drain();
      expect(f.runner.addCalls()).toHaveLength(1);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("PROVISIONING");
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("PROVISIONING");
      // The fence survives restart even if no launch receipt was returned.
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      const c = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-unknown-queued-c"));
      await restarted.drain();
      expect(runner2.addCalls()).toHaveLength(0);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, c.session_id).state).toBe("PROVISIONING");
    } finally { f.cleanup(); }
  });

  it.each(["bad-stage", "missing-common-dir", "unreadable-payload"])("retains and quarantines malformed journal %s", async (damage) => {
    const f = makeFixture();
    try {
      f.runner.parkNextDispatch = new Promise<void>(() => undefined);
      const a = f.worktreeSpawn(`wt-malformed-${damage}`);
      await waitFor("adding", () => rawJournal(f, a.session_id).stage === "adding");
      const ownedWorkspaceId = rawJournal(f, a.session_id).workspace_id;
      if (damage === "unreadable-payload") {
        f.h.db.raw.prepare("UPDATE intents SET payload=? WHERE kind='provision_session' AND session_id=?").run("{invalid", a.session_id);
      } else {
        craftJournal(f, a.session_id, damage === "bad-stage" ? { stage: "broken" } : { source_common_dir: "" });
      }
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      const b = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest(`wt-malformed-related-${damage}`));
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("PROVISIONING");
      expect(runner2.addCalls()).toHaveLength(0);
      expect((f.h.db.raw.prepare("SELECT quarantined FROM workspaces WHERE workspace_id=?").get(ownedWorkspaceId) as { quarantined: number }).quarantined).toBe(1);
      const other = registerOtherRepo(f, `other-${damage}`);
      const c = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest(`wt-malformed-unrelated-${damage}`, {
        workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: `ws-other-${damage}`, base_commit: other.head },
      }));
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, c.session_id).state).toBe(damage === "unreadable-payload" ? "PROVISIONING" : "IDLE");
      expect(runner2.addCalls()).toHaveLength(damage === "unreadable-payload" ? 0 : 1);
      expect(intentState(f, a.session_id)).toBe("pending");
    } finally { f.cleanup(); }
  });

  it("a late pre-dispatch holder cannot resume or fail a replacement incarnation", async () => {
    const f = makeFixture();
    let release!: () => void;
    try {
      f.runner.parkNextDispatch = new Promise<void>((resolve) => { release = resolve; });
      const a = f.worktreeSpawn("wt-late-holder");
      await waitFor("adding", () => rawJournal(f, a.session_id).stage === "adding");
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([a.session_id]);
      await restarted.drain();
      const replacement = rawJournal(f, a.session_id);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("IDLE");
      release();
      await f.drain();
      expect(rawJournal(f, a.session_id)).toEqual(replacement);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("IDLE");
      expect(intentState(f, a.session_id)).toBe("completed");
      expect(git(f.repoPath, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(2);
    } finally { release?.(); f.cleanup(); }
  });

  it.each(["added", "ready"])("pending %s fences siblings before owner verification and releases after verified completion", async (stage) => {
    const f = makeFixture();
    try {
      f.runner.postMutateDelayMs = 4_000;
      const a = f.worktreeSpawn(`wt-recovery-owner-${stage}`);
      await waitFor("managed completion", () => f.runner.lastCompletion !== null);
      craftJournal(f, a.session_id, { stage, completion: f.runner.lastCompletion });
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      // Sibling arrives before the completed operation's owner is reconciled.
      const req = f.spawnRequest(`wt-recovery-sibling-${stage}`);
      const b = restarted.spawn(f.h.seed.coordinatorId, req);
      await restarted.drain();
      expect(runner2.addCalls()).toHaveLength(0);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("PROVISIONING");
      restarted.reconcileRetainedProvisions([a.session_id]);
      await restarted.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("IDLE");
      const replay = restarted.spawn(f.h.seed.coordinatorId, req);
      expect(replay.session_id).toBe(b.session_id);
      await restarted.drain();
      expect(runner2.addCalls()).toHaveLength(1);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("IDLE");
      await f.drain();
    } finally { f.cleanup(); }
  });

  it("post-add UNKNOWN inspection stays fenced across restart", async () => {
    const f = makeFixture();
    try {
      const realRun = f.runner.run.bind(f.runner);
      let mutated = false;
      f.runner.run = async (args) => {
        if (mutated && args.kind === "read") throw new WorktreeGitRunError("git-uncertain-after-resume", false);
        const result = await realRun(args);
        if (args.kind === "mutate") mutated = true;
        return result;
      };
      const a = f.worktreeSpawn("wt-inspection-unknown");
      await f.drain();
      expect(rawJournal(f, a.session_id).stage).toBe("added");
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("PROVISIONING");
      const runner2 = new RecordingRunner();
      const restarted = restartedCore(f, runner2);
      restarted.reconcileRetainedProvisions([a.session_id]);
      const b = restarted.spawn(f.h.seed.coordinatorId, f.spawnRequest("wt-inspection-unknown-related"));
      await restarted.drain();
      expect(runner2.addCalls()).toHaveLength(0);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("PROVISIONING");
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("PROVISIONING");
    } finally { f.cleanup(); }
  });

  it("refuses a source alias retargeted before the owned mutation resumes", async (ctx) => {
    const f = makeFixture({ withJunctionAlias: true });
    if (!f.junctionOk) { f.cleanup(); ctx.skip(); return; }
    let release!: () => void;
    try {
      const other = registerOtherRepo(f, "retargeted-source");
      f.runner.gate = new Promise<void>((resolve) => { release = resolve; });
      const a = f.worktreeSpawn("wt-source-retarget", {
        workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo-alias", base_commit: f.head },
      });
      await waitFor("adding", () => rawJournal(f, a.session_id).stage === "adding");
      const alias = path.join(path.dirname(f.repoPath), "repo-alias");
      unlinkSync(alias);
      symlinkSync(other.repoPath, alias, process.platform === "win32" ? "junction" : "dir");
      release();
      await f.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("BLOCKED");
      expect(rawJournal(f, a.session_id).launch).toBeNull();
      expect(existsSync(f.journalPath(a.session_id))).toBe(false);
      expect(git(f.repoPath, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
      expect(git(other.repoPath, ["worktree", "list", "--porcelain"]).match(/^worktree /gm)).toHaveLength(1);
    } finally { release?.(); f.cleanup(); }
  });

  it("serializes concurrent provisions of one repository; aliases cannot bypass the lock", async (ctx) => {
    const f = makeFixture({ withJunctionAlias: true });
    if (!f.junctionOk) {
      f.cleanup();
      ctx.skip();
      return;
    }
    try {
      f.runner.postMutateDelayMs = 20;
      const a = f.worktreeSpawn("wt-serial-a");
      const b = f.worktreeSpawn("wt-serial-b", {
        workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo-alias", base_commit: f.head },
      });
      await f.drain();
      expect(f.runner.mutations.length).toBe(2);
      const [m1, m2] = f.runner.mutations;
      expect(m2!.start).toBeGreaterThanOrEqual(m1!.end); // strictly serialized
      const rootA = f.journalPath(a.session_id);
      const rootB = f.journalPath(b.session_id);
      expect(rootA).not.toBe(rootB); // distinct roots
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, a.session_id).state).toBe("IDLE");
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, b.session_id).state).toBe("IDLE");
      expect(git(rootA, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(git(rootB, ["rev-parse", "HEAD"])).toBe(f.head);
    } finally {
      f.cleanup();
    }
  });

  it("rejects contradictory, missing and unusable requests before any accepted resource", async () => {
    const f = makeFixture();
    try {
      const workspacesBefore = workspaceCount(f);
      let badKey = 0;
      const bad = (workspace: Record<string, unknown>): BrokerError =>
        expectBrokerError(
          () =>
            f.core.spawn(f.h.seed.coordinatorId, {
              project_id: f.h.seed.projectId,
              idempotency_key: `wt-bad-${badKey++}`,
              provider: "mock",
              account_profile_id: f.h.seed.accountMock1,
              model: "mock-model-1",
              effort: null,
              role: "worker",
              instructions: "x",
              workspace,
              policy_profile_id: "pol-writer",
            } as SpawnRequest),
          "INVALID_REQUEST",
        );

      // Contradictory: broker-created fields with a registered workspace id.
      bad({ mode: "worktree", workspace_id: "ws-main", repository_workspace_id: "ws-repo", base_commit: f.head });
      // Contradictory: additive fields outside worktree mode.
      bad({ mode: "current", workspace_id: f.h.seed.workspaceMain, base_commit: f.head });
      bad({ mode: "review_slot", workspace_id: null, repository_workspace_id: "ws-repo" });
      // Missing: worktree mode without source and commit.
      bad({ mode: "worktree", workspace_id: null });
      // Not a full lowercase hex commit.
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo", base_commit: "HEAD" });
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo", base_commit: f.head.slice(0, 7) });
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo", base_commit: f.head.toUpperCase() });
      // Hex-shaped but nonexistent commit.
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: "ws-repo", base_commit: "a".repeat(40) });
      // Unknown source reference.
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: "ws-missing", base_commit: f.head });
      // Registered path that is not a real Git repository.
      bad({ mode: "worktree", workspace_id: null, repository_workspace_id: f.h.seed.workspaceMain, base_commit: f.head });

      expect(sessionCount(f)).toBe(0);
      expect(workspaceCount(f)).toBe(workspacesBefore);
      expect(f.runner.addCalls()).toHaveLength(0); // no Git mutation ever ran

      // A mutable rejection frees the key: the corrected request is accepted.
      const resp = f.worktreeSpawn("wt-bad-0");
      await f.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id).state).toBe("IDLE");
    } finally {
      f.cleanup();
    }
  });

  it("rejects a cross-project source reference before admission", async () => {
    const f = makeFixture();
    try {
      const otherDir = path.join(path.dirname(f.repoPath), "other-project-repo");
      mkdirSync(path.join(otherDir, "src"), { recursive: true });
      git(otherDir, ["init"]);
      git(otherDir, ["config", "user.email", "x@example.invalid"]);
      git(otherDir, ["config", "user.name", "x"]);
      writeFileSync(path.join(otherDir, "src", "a.txt"), "a\n", "utf8");
      git(otherDir, ["add", "."]);
      git(otherDir, ["commit", "-m", "other"]);
      insertProject(f.h.db, {
        project_id: "project-other-wt",
        display_name: "Other",
        configuration_revision: 1,
        session_cap: 5,
        created_at: f.h.clock.now(),
      });
      insertWorkspace(f.h.db, {
        workspace_id: "ws-foreign-repo",
        project_id: "project-other-wt",
        mode: "current",
        canonical_path: otherDir,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: f.h.seed.coverageProfileId,
      });
      expectBrokerError(
        () =>
          f.core.spawn(f.h.seed.coordinatorId, {
            project_id: f.h.seed.projectId,
            idempotency_key: "wt-cross-project",
            provider: "mock",
            account_profile_id: f.h.seed.accountMock1,
            model: "mock-model-1",
            effort: null,
            role: "worker",
            instructions: "x",
            workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: "ws-foreign-repo", base_commit: f.head },
            policy_profile_id: "pol-writer",
          } as SpawnRequest),
        "INVALID_REQUEST",
      );
      expect(sessionCount(f)).toBe(0);
      expect(f.runner.addCalls()).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it("an injected Git failure blocks the session with evidence and the key remains", async () => {
    const f = makeFixture();
    try {
      f.runner.failNextMutate = new Error("injected disk-full during worktree add");
      const resp = f.worktreeSpawn("wt-git-failure");
      await f.drain();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("git-worktree-add-failed");
      const intentState = f.h.db.raw.prepare("SELECT state FROM intents WHERE kind='provision_session' AND session_id=?").get(resp.session_id) as { state: string };
      expect(intentState.state).toBe("failed");
      const generated = f.h.db.raw.prepare("SELECT quarantined, quarantine_reason FROM workspaces WHERE workspace_id=?").get(resp.worktree!.workspace_id) as Record<string, unknown>;
      expect(generated.quarantined).toBe(1);
      expect(String(generated.quarantine_reason)).toContain("git-add-failed");
      const event = f.h.db.raw.prepare("SELECT payload FROM events WHERE session_id=? AND type='session_provisioning_failed'").get(resp.session_id) as { payload: string };
      expect(event.payload).toContain("git-add-failed");
      expect(f.runner.addCalls()).toHaveLength(1);

      // Same key replays the same blocked session — no new resources, no re-run.
      const workspacesBefore = workspaceCount(f);
      const replay = f.worktreeSpawn("wt-git-failure");
      expect(replay).toMatchObject({ session_id: resp.session_id, replayed_request: true, state: "BLOCKED" });
      expect(replay.worktree).toEqual(resp.worktree);
      expect(workspaceCount(f)).toBe(workspacesBefore);
      expect(f.runner.addCalls()).toHaveLength(1);
    } finally {
      f.cleanup();
    }
  });

  it("never deletes or adopts a foreign path at the target location", async () => {
    const f = makeFixture();
    try {
      const resp = f.worktreeSpawn("wt-foreign-path");
      // Before any background Git read runs, occupy the hashed target path.
      const wtPath = f.journalPath(resp.session_id);
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(path.join(wtPath, "operator-data.txt"), "precious\n", "utf8");
      await f.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("foreign-target");
      // The foreign content is untouched and unadopted.
      expect(readFileSync(path.join(wtPath, "operator-data.txt"), "utf8")).toBe("precious\n");
      expect(f.runner.addCalls()).toHaveLength(0);
      const generated = f.h.db.raw.prepare("SELECT quarantined FROM workspaces WHERE workspace_id=?").get(resp.worktree!.workspace_id) as { quarantined: number };
      expect(generated.quarantined).toBe(1);
    } finally {
      f.cleanup();
    }
  });

  it("pending rejects any preexisting path — even a valid matching detached worktree — and preserves it", async () => {
    const f = makeFixture();
    try {
      // Hold every runner call so the provision stays at stage "pending"
      // while the target path is occupied by a REAL foreign worktree.
      let release!: () => void;
      f.runner.gate = new Promise<void>((r) => (release = r));
      const resp = f.worktreeSpawn("wt-pending-foreign-detached");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("journal pending", () => {
        try {
          return rawJournal(f, resp.session_id).stage === "pending";
        } catch {
          return false;
        }
      });
      git(f.repoPath, ["worktree", "add", "--detach", wtPath, f.head]); // exact match, not ours
      writeFileSync(path.join(wtPath, "operator-data.txt"), "precious\n", "utf8");
      release();
      await f.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("existing-path-occupied-before-provision");
      // The valid foreign worktree is untouched and still functional.
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(readFileSync(path.join(wtPath, "operator-data.txt"), "utf8")).toBe("precious\n");
      expect(f.runner.addCalls()).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it("pending rejects a branch-checked-out worktree at the target and preserves it", async () => {
    const f = makeFixture();
    try {
      let release!: () => void;
      f.runner.gate = new Promise<void>((r) => (release = r));
      const resp = f.worktreeSpawn("wt-pending-foreign-branch");
      const wtPath = f.journalPath(resp.session_id);
      await waitFor("journal pending", () => {
        try {
          return rawJournal(f, resp.session_id).stage === "pending";
        } catch {
          return false;
        }
      });
      git(f.repoPath, ["worktree", "add", "-b", "foreign-branch-wt", wtPath]); // branch checkout
      release();
      await f.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("existing-path-occupied-before-provision");
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(git(wtPath, ["symbolic-ref", "--short", "HEAD"])).toBe("foreign-branch-wt");
      expect(f.runner.addCalls()).toHaveLength(0);
    } finally {
      f.cleanup();
    }
  });

  it("refuses a junction alias to another session's worktree inside the managed root", async (ctx) => {
    const f = makeFixture();
    if (!f.junctionOk) {
      f.cleanup();
      ctx.skip();
      return;
    }
    try {
      // A first session provisions normally; the second session's target is
      // occupied by a junction pointing INTO that other session's worktree.
      const first = f.worktreeSpawn("wt-junction-a");
      await f.drain();
      const pathA = f.journalPath(first.session_id);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, first.session_id).state).toBe("IDLE");

      let release!: () => void;
      f.runner.gate = new Promise<void>((r) => (release = r));
      const second = f.worktreeSpawn("wt-junction-b");
      const pathB = f.journalPath(second.session_id);
      symlinkSync(pathA, pathB, process.platform === "win32" ? "junction" : "dir");
      release();
      await f.drain();

      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, second.session_id);
      expect(session.state).toBe("BLOCKED");
      expect(session.block_reason).toContain("existing-path-is-not-a-plain-directory");
      // The OTHER session's worktree is completely untouched.
      expect(git(pathA, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, first.session_id).state).toBe("IDLE");
      expect(f.runner.addCalls()).toHaveLength(1); // only the first provision
    } finally {
      f.cleanup();
    }
  });

  it("binds the registered source despite ambient Git routing environment overrides", async () => {
    const f = makeFixture();
    const foreign = registerOtherRepo(f, "env-override-repo");
    const saved: Array<[string, string | undefined]> = [];
    const set = (k: string, v: string) => {
      saved.push([k, process.env[k]]);
      process.env[k] = v;
    };
    try {
      // A hostile ambient environment must not reroute broker Git to the
      // foreign repository: GIT_DIR/GIT_WORK_TREE/GIT_COMMON_DIR and injected
      // config are stripped before every subprocess.
      set("GIT_DIR", path.join(foreign.repoPath, ".git"));
      set("GIT_WORK_TREE", foreign.repoPath);
      set("GIT_COMMON_DIR", path.join(foreign.repoPath, ".git"));
      set("GIT_INDEX_FILE", path.join(foreign.repoPath, ".git", "index"));
      set("GIT_CONFIG_COUNT", "1");
      set("GIT_CONFIG_KEY_0", "core.worktree");
      set("GIT_CONFIG_VALUE_0", foreign.repoPath);

      const resp = f.worktreeSpawn("wt-env-override");
      await f.drain();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      const j = rawJournal(f, resp.session_id);
      expect(realpathSync(j.source_common_dir).toLowerCase()).toBe(realpathSync(path.join(f.repoPath, ".git")).toLowerCase());
      const wtPath = f.journalPath(resp.session_id);
      for (const [k, v] of saved.reverse()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      saved.length = 0;
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(git(f.repoPath, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/").toLowerCase()).toContain(wtPath.replace(/\\/g, "/").toLowerCase());
    } finally {
      for (const [k, v] of saved.reverse()) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      f.cleanup();
    }
  });

  it("stop preserves the dirty worktree checkout and its history", async () => {
    const f = makeFixture();
    try {
      const resp = f.worktreeSpawn("wt-stop-dirty");
      await f.drain();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(session.state).toBe("IDLE");
      const wtPath = f.journalPath(resp.session_id);
      const turn = f.h.sendTask(resp.session_id, "wt-turn", "edit worktree");
      f.h.adapter.plan(turn.turn_id, [
        { kind: "workspace_write", files: [{ path: "src/agent-edit.c", content: "by agent\n" }] },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(f.h, turn);
      await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, turn.turn_id).state).toBe("SUCCEEDED");
      writeFileSync(path.join(wtPath, "untracked-after.txt"), "local\n", "utf8");

      const stop = f.h.core.stop(f.h.seed.coordinatorId, { session_id: resp.session_id, idempotency_key: "wt-stop" });
      await settle(f.h);
      expect(stop.close_state).toBe("pending"); // acknowledgement is not a CLOSED claim
      const after = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      expect(after.state).toBe("CLOSED");
      expect(after.close_state).toBe("completed");

      // Nothing was cleaned up: dirty files, untracked file, worktree, history.
      expect(existsSync(path.join(wtPath, "src", "agent-edit.c"))).toBe(true);
      expect(existsSync(path.join(wtPath, "untracked-after.txt"))).toBe(true);
      expect(git(wtPath, ["rev-parse", "HEAD"])).toBe(f.head);
      expect(git(f.repoPath, ["worktree", "list", "--porcelain"]).replace(/\\/g, "/").toLowerCase()).toContain(wtPath.replace(/\\/g, "/").toLowerCase());
    } finally {
      f.cleanup();
    }
  });

  it("initial capture excludes later new untracked files; explicit snapshot policy respects them", async () => {
    const f = makeFixture();
    try {
      const resp = f.worktreeSpawn("wt-capture-later");
      await f.drain();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id);
      const wtPath = f.journalPath(resp.session_id);
      writeFileSync(path.join(wtPath, "src", "later.txt"), "new local file\n", "utf8");

      const snap = f.core.snapshot(f.h.seed.coordinatorId, {
        project_id: f.h.seed.projectId,
        workspace_id: resp.worktree!.workspace_id,
        idempotency_key: "wt-explicit-capture",
      });
      expect(snap.capture_state).toBe("SEALED");
      expect(snap.snapshot_id).not.toBe(session.initial_snapshot_id);
      const initialDigest = (f.h.db.raw.prepare("SELECT source_digest FROM snapshot_records WHERE snapshot_id=?").get(session.initial_snapshot_id) as { source_digest: string }).source_digest;
      expect(snap.source_digest).not.toBe(initialDigest);
      const inventory = takeInventory(wtPath, COVERAGE_CONFIG);
      expect(inventory.entries.some((e) => e.path === "src/later.txt")).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("accepts a full 64-hex (SHA-256 repository) base commit", async () => {
    const f = makeFixture();
    try {
      const { repoPath: shaDir, head: shaHead } = createRepo(path.dirname(f.repoPath), "sha256-repo", "sha256");
      expect(shaHead).toMatch(/^[0-9a-f]{64}$/);
      insertWorkspace(f.h.db, {
        workspace_id: "ws-sha256-repo",
        project_id: f.h.seed.projectId,
        mode: "current",
        canonical_path: shaDir,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: f.h.seed.coverageProfileId,
      });
      const resp = f.worktreeSpawn("wt-sha256", {
        workspace: { mode: "worktree", workspace_id: null, repository_workspace_id: "ws-sha256-repo", base_commit: shaHead },
      });
      expect(resp.worktree).toMatchObject({ base_commit: shaHead, current_checkout_changes_copied: false });
      await f.drain();
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, resp.session_id).state).toBe("IDLE");
      expect(git(f.journalPath(resp.session_id), ["rev-parse", "HEAD"])).toBe(shaHead);
    } finally {
      f.cleanup();
    }
  });

  it("provisions end-to-end through the public bridge tool with the additive fields", async () => {
    const f = makeFixture();
    try {
      const ctx = { coordinatorId: f.h.seed.coordinatorId, core: f.core };
      const result = (await callBridgeTool(ctx, "agent_session_spawn", {
        project_id: f.h.seed.projectId,
        idempotency_key: "wt-bridge",
        provider: "mock",
        account_profile_id: f.h.seed.accountMock1,
        model: "mock-model-1",
        role: "worker",
        instructions: "via bridge",
        workspace: { mode: "worktree", repository_workspace_id: "ws-repo", base_commit: f.head },
        policy_profile_id: "pol-writer",
      })) as { session_id: string; worktree: { workspace_id: string; base_commit: string; current_checkout_changes_copied: boolean } };
      expect(result.worktree).toMatchObject({
        base_commit: f.head,
        current_checkout_changes_copied: false,
      });
      await f.drain();
      const st = f.h.core.sessionStatus(f.h.seed.coordinatorId, result.session_id);
      expect(st.state).toBe("IDLE");

      // The public bridge validates the additive workspace object strictly.
      await expect(
        callBridgeTool(ctx, "agent_session_spawn", {
          project_id: f.h.seed.projectId,
          idempotency_key: "wt-bridge-bad",
          provider: "mock",
          account_profile_id: f.h.seed.accountMock1,
          model: "mock-model-1",
          role: "worker",
          instructions: "via bridge",
          workspace: { mode: "worktree", repository_workspace_id: "ws-repo", base_commit: f.head, sneaky: 1 },
          policy_profile_id: "pol-writer",
        }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      // Discovery remains usable: the registered repository reference is
      // offered with the additive eligibility flag (never a guessed id).
      const discovery = (await callBridgeTool(ctx, "agents_list", { project_id: f.h.seed.projectId })) as {
        entries: Array<{ kind: string; id: string; eligible_worktree_source?: boolean }>;
      };
      const source = discovery.entries.find((e) => e.kind === "workspace" && e.id === "ws-repo");
      expect(source?.eligible_worktree_source).toBe(true);
    } finally {
      f.cleanup();
    }
  });

  it("advertises the additive workspace properties in the spawn tool schema", () => {
    const spawnDef = bridgeToolDefs().find((d) => d.name === "agent_session_spawn")!;
    const workspaceSchema = spawnDef.inputSchema as {
      properties: { workspace: { properties: Record<string, unknown>; additionalProperties: boolean } };
    };
    expect(workspaceSchema.properties.workspace.properties.repository_workspace_id).toEqual({ type: "string" });
    expect(workspaceSchema.properties.workspace.properties.base_commit).toEqual({ type: "string" });
    expect(workspaceSchema.properties.workspace.additionalProperties).toBe(false);
  });
});

// ─── managed Git runner: real process fixtures (offline) ────────────────────

const win32Only = process.platform === "win32" ? describe : describe.skip;

describe("createRealWorktreeGitRunner process fixtures", () => {
  it("retains UNKNOWN when helper loses resume acknowledgement after possible dispatch", async () => {
    const ownership = fakeLaunch() as unknown as managedJob.WindowsJobOwnership;
    const mocked = vi.spyOn(managedJob, "runWindowsJob").mockImplementationOnce(async (spec) => {
      await spec.onBeforeResume(ownership);
      return {
        exitCode: null, killed: false, resumed: false, quiesced: false,
        uncertainAfterResume: true, ownership, terminationReason: "helper-loss",
        stderrTail: "", protocolError: null,
      };
    });
    try {
      let launches = 0;
      const runner = createRealWorktreeGitRunner({ programOverride: () => ({ program: process.execPath, args: [] }) });
      const error = await runner.run({ cwd: process.cwd(), gitArgs: [], kind: "mutate", onOwnership: () => { launches++; } }).catch((e: unknown) => e);
      expect(launches).toBe(1);
      expect(error).toBeInstanceOf(WorktreeGitRunError);
      expect((error as WorktreeGitRunError).reason).toBe("git-uncertain-after-resume");
      expect((error as WorktreeGitRunError).definitive).toBe(false);
    } finally { mocked.mockRestore(); }
  });
  const nodeExe = process.execPath;
  const MUTATE_ARGS = ["worktree", "add", "--detach", "C:\\does\\not\\matter", "a".repeat(40)];

  /** Program override that ignores the git args and runs a node script. */
  const nodeScript = (script: string) => (gitArgs: string[], kind: "read" | "mutate") => ({
    program: nodeExe,
    args: ["-e", script + `/*${gitArgs.length}:${kind}*/`],
  });

  const expectNoLeakedContext = (e: unknown): void => {
    expect(e).toBeInstanceOf(WorktreeGitRunError);
    const err = e as WorktreeGitRunError;
    expect(err.message).toBe(err.reason); // class only — no raw output/args
    expect(err.message).not.toMatch(/[A-Za-z]:\\/); // no absolute paths
    expect(err.message).not.toContain("worktree"); // no git arguments echoed
  };

  it("mutates through the owned job and delivers the exact launch receipt before resume", async () => {
    const receipts: unknown[] = [];
    let resumedAfterReceipt = false;
    const runner = createRealWorktreeGitRunner({
      programOverride: (gitArgs, kind) => (kind === "mutate" ? nodeScript("process.exit(0);")(gitArgs, kind) : undefined),
    });
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-runner-"));
    try {
      const res = await runner.run({
        cwd,
        gitArgs: MUTATE_ARGS,
        kind: "mutate",
        onOwnership: (receipt) => {
          receipts.push(receipt);
          // The receipt arrives strictly BEFORE the root runs: a durable
          // write here gates the resume (zero-resume on throw).
          setTimeout(() => (resumedAfterReceipt = true), 50);
        },
      });
      expect(res.stdout).toBe("");
      expect(receipts).toHaveLength(1);
      const r = receipts[0] as Record<string, unknown>;
      expect(typeof r.nonce).toBe("string");
      expect((r.nonce as string).length).toBeGreaterThan(0);
      expect(typeof r.launch_uuid).toBe("string");
      expect(typeof r.named_job).toBe("string");
      expect(Number.isInteger(r.root_pid)).toBe(true);
      expect(/^\d+$/.test(String(r.root_creation_time))).toBe(true);
      expect(r.owner_pid).toBe(process.pid);
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(resumedAfterReceipt).toBe(true); // resume happened after the gate
    } finally {
      rmSyncRetry(cwd);
    }
  }, 30_000);

  it("bounds a stderr/stdout flood on both pipes and fails with a class, never raw output", async () => {
    const flood = `process.stdout.write("o".repeat(33_554_432));process.stderr.write("e".repeat(33_554_432));process.exit(0);`;
    const runner = createRealWorktreeGitRunner({
      programOverride: (gitArgs, kind) => (kind === "mutate" ? nodeScript(flood)(gitArgs, kind) : undefined),
    });
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-runner-"));
    try {
      const err = await runner
        .run({ cwd, gitArgs: MUTATE_ARGS, kind: "mutate" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectNoLeakedContext(err);
      expect((err as WorktreeGitRunError).reason).toBe("git-output-limit");
      expect((err as WorktreeGitRunError).definitive).toBe(false); // killed mid-run: effect unknown
      // The managed path is not wedged: a subsequent run still works.
      const ok = await createRealWorktreeGitRunner({
        programOverride: (gitArgs, kind) => (kind === "mutate" ? nodeScript("process.exit(0);")(gitArgs, kind) : undefined),
      }).run({ cwd, gitArgs: MUTATE_ARGS, kind: "mutate" });
      expect(ok.stdout).toBe("");
    } finally {
      rmSyncRetry(cwd);
    }
  }, 60_000);

  it("a hung mutation times out, keeps the effect uncertain, and never echoes arguments", async () => {
    const runner = createRealWorktreeGitRunner({
      mutateTimeoutMs: 1_500,
      programOverride: (gitArgs, kind) => (kind === "mutate" ? nodeScript("setInterval(()=>{},1000);")(gitArgs, kind) : undefined),
    });
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-runner-"));
    try {
      const err = await runner
        .run({ cwd, gitArgs: MUTATE_ARGS, kind: "mutate" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectNoLeakedContext(err);
      expect((err as WorktreeGitRunError).reason).toBe("git-timeout");
      expect((err as WorktreeGitRunError).definitive).toBe(false);
    } finally {
      rmSyncRetry(cwd);
    }
  }, 60_000);

  it("a clean nonzero mutation exit is definitive and class-typed", async () => {
    const runner = createRealWorktreeGitRunner({
      programOverride: (gitArgs, kind) => (kind === "mutate" ? nodeScript("process.exit(3);")(gitArgs, kind) : undefined),
    });
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-runner-"));
    try {
      const err = await runner
        .run({ cwd, gitArgs: MUTATE_ARGS, kind: "mutate" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectNoLeakedContext(err);
      expect((err as WorktreeGitRunError).reason).toBe("git-exit-nonzero");
      expect((err as WorktreeGitRunError).definitive).toBe(true);
    } finally {
      rmSyncRetry(cwd);
    }
  }, 30_000);

  it("bounds a read-side flood and classifies read failures without leaking content", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "wt-runner-"));
    try {
      const flood = createRealWorktreeGitRunner({
        programOverride: (gitArgs, kind) => (kind === "read" ? nodeScript(`process.stdout.write("o".repeat(33_554_432));process.exit(0);`)(gitArgs, kind) : undefined),
      });
      const overflow = await flood
        .run({ cwd, gitArgs: ["rev-parse", "HEAD"], kind: "read" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectNoLeakedContext(overflow);
      expect((overflow as WorktreeGitRunError).reason).toBe("git-output-limit");
      expect((overflow as WorktreeGitRunError).definitive).toBe(true);

      const hang = createRealWorktreeGitRunner({
        readTimeoutMs: 800,
        programOverride: (gitArgs, kind) => (kind === "read" ? nodeScript("setInterval(()=>{},1000);")(gitArgs, kind) : undefined),
      });
      const timedOut = await hang
        .run({ cwd, gitArgs: ["rev-parse", "HEAD"], kind: "read" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect((timedOut as WorktreeGitRunError).reason).toBe("git-timeout");

      const failing = createRealWorktreeGitRunner({
        programOverride: (gitArgs, kind) => (kind === "read" ? nodeScript("process.stderr.write('boom');process.exit(1);")(gitArgs, kind) : undefined),
      });
      const nonzero = await failing
        .run({ cwd, gitArgs: ["rev-parse", "HEAD"], kind: "read" })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expectNoLeakedContext(nonzero);
      expect((nonzero as WorktreeGitRunError).reason).toBe("git-exit-nonzero");
    } finally {
      rmSyncRetry(cwd);
    }
  }, 60_000);

  it("succeeds a real read against a real repository with bounded output", async () => {
    const f = makeFixture();
    try {
      const runner = createRealWorktreeGitRunner();
      const res = await runner.run({ cwd: f.repoPath, gitArgs: ["rev-parse", "HEAD"], kind: "read" });
      expect(res.stdout).toBe(f.head);
    } finally {
      f.cleanup();
    }
  });
});
