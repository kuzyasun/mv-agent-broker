/**
 * Git-native reviewer workflow (git_review_binding): real disposable temp Git
 * repositories + mock provider, no inference.
 *
 * Covers: dispatch into the exact registered existing checkout with committed
 * text+PNG changes and ZERO snapshots/diff inputs; read-only policy and role
 * admission rules; exact-commit/HEAD/cleanliness admission checks; exclusive
 * checkout lease contention between writers and reviews (aliases included);
 * queued pre-dispatch drift; post-run drift (no accepted SUCCEEDED review);
 * durable binding across reconciliation; broker-created reviewer worktree at
 * an exact commit for parallel review; bridge binding validation.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createHarness, settle, settleTurn, start, type Harness } from "../helpers/harness.ts";
import { insertPolicyProfile, insertWorkspace } from "../../src/storage/repo.ts";
import { BrokerCore } from "../../src/core/broker.ts";
import type { SendRequest } from "../../src/core/broker.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { callBridgeTool, bridgeToolDefs } from "../../src/bridge/tools.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { gitWorkingTreeDigest } from "../../src/workspaces/gitWorkingTree.ts";

// ─── disposable Git fixtures (offline, plain git args, own temp dirs) ───────

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${r.status}): ${r.stderr}`);
  }
  return r.stdout.trim();
}

/** A minimal valid 1x1 PNG (binary change the textual diff pipeline cannot carry). */
const PNG_BYTES = Buffer.from(
  "89504e470d0a1a0a0000000d494844520000000100000001080600000" + "01f15c4890000000d49444154789c626001000000ffff030000060005" + "57bfabd40000000049454e44ae426082",
  "hex",
);

interface RepoFixture {
  repoPath: string;
  baseCommit: string;
  targetCommit: string;
  /** A commit AFTER the review target, to prove source-side progress is tolerated. */
  aheadCommit(): string;
}

function createRepo(baseDir: string, name: string): RepoFixture {
  const repoPath = path.join(baseDir, name);
  mkdirSync(path.join(repoPath, "src"), { recursive: true });
  git(repoPath, ["init"]);
  git(repoPath, ["config", "user.email", "broker-test@example.invalid"]);
  git(repoPath, ["config", "user.name", "Broker Test"]);
  writeFileSync(path.join(repoPath, "src", "main.c"), "int main(){return 0;}\n", "utf8");
  writeFileSync(path.join(repoPath, "README.md"), "fixture\n", "utf8");
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "initial"]);
  const baseCommit = git(repoPath, ["rev-parse", "HEAD"]);
  // The reviewed change: committed text edit + committed binary PNG addition.
  writeFileSync(path.join(repoPath, "src", "main.c"), "int main(){return 42;}\n", "utf8");
  mkdirSync(path.join(repoPath, "src", "assets"), { recursive: true });
  writeFileSync(path.join(repoPath, "src", "assets", "logo.png"), PNG_BYTES);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", "add feature and logo"]);
  const targetCommit = git(repoPath, ["rev-parse", "HEAD"]);
  return {
    repoPath,
    baseCommit,
    targetCommit,
    aheadCommit(): string {
      writeFileSync(path.join(repoPath, "README.md"), "author moved on\n", "utf8");
      git(repoPath, ["add", "."]);
      git(repoPath, ["commit", "-m", "author continues"]);
      return git(repoPath, ["rev-parse", "HEAD"]);
    },
  };
}

/** Harness plus a registered real Git repository as a current-mode workspace. */
interface GitFixture {
  h: Harness;
  repo: RepoFixture;
  reviewerReadonlySession(overrides?: Record<string, unknown>): ReturnType<BrokerCore["spawn"]>;
  spawnWorkerOn(wsId: string): ReturnType<BrokerCore["spawn"]>;
  gitReviewSend(sessionId: string, key: string, overrides?: Partial<SendRequest>): ReturnType<BrokerCore["send"]>;
  cleanup(): void;
}

function makeFixture(): GitFixture {
  const h = createHarness();
  insertPolicyProfile(h.db, {
    policy_profile_id: "pol-reviewer",
    version: "1",
    config: JSON.stringify({ access: "read_only" }),
  });
  const rawBase = mkdtempSync(path.join(tmpdir(), "agent-broker-gitrev-"));
  const baseDir =
    process.platform === "win32" && typeof realpathSync.native === "function"
      ? realpathSync.native(rawBase)
      : realpathSync(rawBase);
  const repo = createRepo(baseDir, "source-repo");
  insertWorkspace(h.db, {
    workspace_id: "ws-repo",
    project_id: h.seed.projectId,
    mode: "current",
    canonical_path: repo.repoPath,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: h.seed.coverageProfileId,
  });
  let counter = 0;
  return {
    h,
    repo,
    reviewerReadonlySession(overrides: Record<string, unknown> = {}) {
      counter += 1;
      return h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        idempotency_key: `spawn-reviewer-${counter}-${Math.random().toString(36).slice(2)}`,
        provider: "mock",
        // Distinct quota scope from the default worker account, so contention
        // tests exercise the CHECKOUT lease, not the shared quota-scope cap.
        account_profile_id: h.seed.accountMock3OtherQuota,
        model: "mock-model-1",
        effort: null,
        role: "reviewer",
        instructions: "Review exact commits read-only.",
        workspace: { mode: "current", workspace_id: "ws-repo" },
        policy_profile_id: "pol-reviewer",
        ...overrides,
      });
    },
    spawnWorkerOn(wsId: string) {
      counter += 1;
      return h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        idempotency_key: `spawn-worker-${counter}-${Math.random().toString(36).slice(2)}`,
        provider: "mock",
        account_profile_id: h.seed.accountMock1,
        model: "mock-model-1",
        effort: null,
        role: "worker",
        instructions: "Implement bounded tasks.",
        workspace: { mode: "current", workspace_id: wsId },
        policy_profile_id: "pol-writer",
      });
    },
    gitReviewSend(sessionId: string, key: string, overrides: Partial<SendRequest> = {}) {
      return h.core.send(h.seed.coordinatorId, {
        session_id: sessionId,
        idempotency_key: key,
        task: { goal: "Review the bound commits.", acceptance_criteria: ["Findings first."], artifact_refs: [] },
        git_review_binding: { base_commit: repo.baseCommit, target_commit: repo.targetCommit },
        ...overrides,
      } as Parameters<BrokerCore["send"]>[1]);
    },
    cleanup() {
      rmSync(baseDir, { recursive: true, force: true });
      h.cleanup();
    },
  };
}

function snapshotCount(h: Harness): number {
  return (h.db.raw.prepare("SELECT COUNT(*) c FROM snapshot_records").get() as { c: number }).c;
}

function patchArtifactCount(h: Harness): number {
  return (h.db.raw.prepare("SELECT COUNT(*) c FROM artifacts WHERE kind = 'patch'").get() as { c: number }).c;
}

function errorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof BrokerError) return e.code;
    throw e;
  }
  throw new Error("expected BrokerError");
}

/** Capture the exact envelope the broker hands to the adapter. */
function captureEnvelope(h: Harness): { latest(): string | null; workspacePath(): string | null } {
  let latest: string | null = null;
  let workspacePath: string | null = null;
  const inner = h.adapter.executeTurn.bind(h.adapter);
  h.adapter.executeTurn = async (req, gate, onEvent) => {
    latest = req.task_envelope;
    workspacePath = req.workspace_path;
    return inner(req, gate, onEvent);
  };
  return { latest: () => latest, workspacePath: () => workspacePath };
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe("git_review_binding: admission", () => {
  it("spawns a Git reviewer without any initial snapshot capture", () => {
    const f = makeFixture();
    try {
      const spawned = f.reviewerReadonlySession();
      expect(spawned.state).toBe("IDLE");
      expect(spawned.initial_snapshot_id).toBeNull();
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, spawned.session_id);
      expect(session.role).toBe("reviewer");
      expect(session.workspace_mode).toBe("current");
      expect(session.initial_snapshot_id).toBeNull();
      expect(snapshotCount(f.h)).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("rejects write-enabled policy and unregistered/contradictory reviewer spawns", () => {
    const f = makeFixture();
    try {
      expect(errorCodeOf(() => f.reviewerReadonlySession({ policy_profile_id: "pol-writer" }))).toBe("INVALID_REQUEST");
      expect(errorCodeOf(() =>
        f.reviewerReadonlySession({ workspace: { mode: "current", workspace_id: null } }),
      )).toBe("INVALID_REQUEST");
      // Narrowing a write profile to read_only at spawn is allowed.
      const narrowed = f.reviewerReadonlySession({
        policy_profile_id: "pol-writer",
        policy_restrictions: { access: "read_only" },
      });
      expect(narrowed.state).toBe("IDLE");
    } finally {
      f.cleanup();
    }
  });

  it("admits an exact clean-commit review, dispatches into the same checkout, and creates zero snapshots/diff inputs", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const envelopes = captureEnvelope(f.h);
      const beforeSnapshots = snapshotCount(f.h);
      const beforePatches = patchArtifactCount(f.h);

      const sent = f.gitReviewSend(reviewer.session_id, "g1");
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(f.h, sent);
      await settle(f.h);

      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.git_base_commit).toBe(f.repo.baseCommit);
      expect(turn.git_target_commit).toBe(f.repo.targetCommit);
      expect(turn.baseline_snapshot_id).toBeNull();
      expect(turn.review_target_snapshot_id).toBeNull();
      expect(turn.final_snapshot_id).toBeNull();
      expect(turn.execution_started).toBe(true);

      // Zero snapshots, zero synthesized diff artifacts.
      expect(snapshotCount(f.h)).toBe(beforeSnapshots);
      expect(patchArtifactCount(f.h)).toBe(beforePatches);

      // The reviewer read the REAL checkout: the committed text and PNG are there.
      expect(readFileSync(path.join(f.repo.repoPath, "src", "main.c"), "utf8")).toBe("int main(){return 42;}\n");
      expect(readFileSync(path.join(f.repo.repoPath, "src", "assets", "logo.png"))).toEqual(PNG_BYTES);

      // The envelope carries compact commit ids and suggested commands —
      // never autogenerated diff bytes.
      const envelope = envelopes.latest();
      expect(envelope).toContain(`git_review_binding: base_commit=${f.repo.baseCommit} target_commit=${f.repo.targetCommit}`);
      expect(envelope).toContain(`git diff --no-ext-diff --no-textconv --stat ${f.repo.baseCommit}..${f.repo.targetCommit}`);
      expect(envelope).toContain(`git show --no-ext-diff --no-textconv ${f.repo.targetCommit} --stat`);
      expect(envelope).not.toContain("diff --git");
      expect(envelope!.includes("89504e47")).toBe(false);

      // The sealed input manifest binds the git review pair, with no
      // snapshot-derived inputs.
      expect(turn.input_manifest_id).toBeTruthy();
      const manifestRow = f.h.db.raw
        .prepare(
          "SELECT content_hash FROM artifacts WHERE artifact_id = (SELECT input_manifest_id FROM turns WHERE turn_id = ?)",
        )
        .get(sent.turn_id) as { content_hash: string };
      const manifest = JSON.parse(
        Buffer.from(openBlobStore(f.h.blobRoot).read(f.h.seed.projectId, manifestRow.content_hash)).toString("utf8"),
      ) as {
        workspace_binding: { git_review?: { workspace_id: string; base_commit: string; target_commit: string; working_tree_digest: string | null } };
        inputs: Array<{ origin: string }>;
      };
      expect(manifest.workspace_binding.git_review).toEqual({
        workspace_id: "ws-repo",
        base_commit: f.repo.baseCommit,
        target_commit: f.repo.targetCommit,
        working_tree_digest: null,
      });
      for (const input of manifest.inputs) {
        expect(["review_baseline", "review_diff"]).not.toContain(input.origin);
      }

      // The reviewer's published report is a findings artifact.
      const report = f.h.core.turnReportArtifact(f.h.seed.coordinatorId, sent.turn_id);
      expect(report?.kind).toBe("findings");
    } finally {
      f.cleanup();
    }
  });

  it("admits staged, unstaged, and untracked binary work by digest at HEAD and dispatches in the exact checkout", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const envelopes = captureEnvelope(f.h);
      writeFileSync(path.join(f.repo.repoPath, "src", "main.c"), "staged change\n", "utf8");
      git(f.repo.repoPath, ["add", "src/main.c"]);
      writeFileSync(path.join(f.repo.repoPath, "README.md"), "unstaged change\n", "utf8");
      const untrackedBinary = path.join(f.repo.repoPath, "new-hidden.bin");
      writeFileSync(untrackedBinary, Buffer.from([0, 255, 1, 128]));
      const digest = gitWorkingTreeDigest(f.repo.repoPath);
      const beforeSnapshots = snapshotCount(f.h);
      const beforePatches = patchArtifactCount(f.h);

      const sent = f.gitReviewSend(reviewer.session_id, "dirty-accepted", {
        git_review_binding: {
          base_commit: f.repo.targetCommit,
          target_commit: f.repo.targetCommit,
          include_working_tree: true,
        },
      } as Partial<SendRequest>);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id).git_working_tree_digest).toBe(digest);
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(f.h, sent);
      await settle(f.h);

      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.git_base_commit).toBe(f.repo.targetCommit);
      expect(turn.git_target_commit).toBe(f.repo.targetCommit);
      expect(turn.git_working_tree_digest).toBe(digest);
      expect(envelopes.workspacePath()).toBe(f.repo.repoPath);
      expect(envelopes.latest()).toContain(`working_tree_digest=${digest}`);
      expect(envelopes.latest()).toContain("git diff --cached");
      expect(envelopes.latest()).toContain("git ls-files --others --exclude-standard");
      expect(envelopes.latest()).not.toContain("diff --git");
      expect(readFileSync(untrackedBinary)).toEqual(Buffer.from([0, 255, 1, 128]));
      expect(snapshotCount(f.h)).toBe(beforeSnapshots);
      expect(patchArtifactCount(f.h)).toBe(beforePatches);

      const manifestRow = f.h.db.raw.prepare(
        "SELECT content_hash FROM artifacts WHERE artifact_id = (SELECT input_manifest_id FROM turns WHERE turn_id = ?)",
      ).get(sent.turn_id) as { content_hash: string };
      const manifest = JSON.parse(Buffer.from(openBlobStore(f.h.blobRoot).read(f.h.seed.projectId, manifestRow.content_hash)).toString("utf8"));
      expect(manifest.workspace_binding.git_review.working_tree_digest).toBe(digest);
    } finally {
      f.cleanup();
    }
  });

  it("rejects branch shorthand, unknown commits, wrong HEAD, and dirty checkouts before admission", () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const send = (key: string, base: string, target: string) =>
        f.gitReviewSend(reviewer.session_id, key, {
          git_review_binding: { base_commit: base, target_commit: target },
        } as Partial<SendRequest>);
      expect(errorCodeOf(() => send("k1", "main", f.repo.targetCommit))).toBe("INVALID_REQUEST");
      expect(errorCodeOf(() => send("k2", f.repo.baseCommit.slice(0, 8), f.repo.targetCommit))).toBe("INVALID_REQUEST");
      expect(errorCodeOf(() => send("k3", "0".repeat(40), f.repo.targetCommit))).toBe("INVALID_REQUEST");
      // HEAD is at target; an older existing commit as target must be refused.
      expect(errorCodeOf(() => send("k4", f.repo.baseCommit, f.repo.baseCommit))).toBe("INVALID_REQUEST");
      // Untracked non-ignored file dirties the checkout.
      writeFileSync(path.join(f.repo.repoPath, "notes.txt"), "dirty\n", "utf8");
      expect(errorCodeOf(() => send("k5", f.repo.baseCommit, f.repo.targetCommit))).toBe("INVALID_REQUEST");
      expect(f.h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get() as { c: number }).toEqual({ c: 0 });
    } finally {
      f.cleanup();
    }
  });

  it("rejects a registered subdirectory that would inspect an ancestor checkout outside its lease", () => {
    const f = makeFixture();
    try {
      insertWorkspace(f.h.db, {
        workspace_id: "ws-nested", project_id: f.h.seed.projectId, mode: "current",
        canonical_path: path.join(f.repo.repoPath, "src"), quarantined: false,
        quarantine_reason: null, coverage_profile_id: f.h.seed.coverageProfileId,
      });
      const reviewer = f.reviewerReadonlySession({ workspace: { mode: "current", workspace_id: "ws-nested" } });
      for (const include_working_tree of [false, true]) {
        expect(errorCodeOf(() => f.gitReviewSend(reviewer.session_id, `nested-${include_working_tree}`, {
          git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit, include_working_tree },
        } as Partial<SendRequest>))).toBe("INVALID_REQUEST");
      }
      expect(f.h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get()).toMatchObject({ c: 0 });
    } finally { f.cleanup(); }
  });

  it("rejects hidden index flags at admission and before dispatch of a clean review", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      git(f.repo.repoPath, ["update-index", "--assume-unchanged", "README.md"]);
      writeFileSync(path.join(f.repo.repoPath, "README.md"), "hidden source change\n");
      expect(git(f.repo.repoPath, ["status", "--porcelain"])).toBe("");
      expect(errorCodeOf(() => f.gitReviewSend(reviewer.session_id, "hidden-admission"))).toBe("INVALID_REQUEST");
      git(f.repo.repoPath, ["update-index", "--no-assume-unchanged", "README.md"]);
      writeFileSync(path.join(f.repo.repoPath, "README.md"), "fixture\n");
      const sent = f.gitReviewSend(reviewer.session_id, "hidden-dispatch");
      git(f.repo.repoPath, ["update-index", "--skip-worktree", "README.md"]);
      writeFileSync(path.join(f.repo.repoPath, "README.md"), "later hidden source\n");
      expect(git(f.repo.repoPath, ["status", "--porcelain"])).toBe("");
      await start(f.h, sent); await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id)).toMatchObject({
        state: "FAILED", error_code: "WORKSPACE_CHANGED", execution_started: false,
      });
    } finally { f.cleanup(); }
  });

  it("explains wrong bindings and accepts corrected dirty Git review in the same session", async () => {
    const f = makeFixture();
    try {
      // A read-only worker session is still not a reviewer.
      const workerReadonly = f.reviewerReadonlySession({ role: "worker" });
      expect(errorCodeOf(() => f.gitReviewSend(workerReadonly.session_id, "k1"))).toBe("INVALID_REQUEST");

      // review_slot sessions keep the snapshot contract; git binding rejected.
      insertWorkspace(f.h.db, {
        workspace_id: "ws-review-slot",
        project_id: f.h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: f.h.seed.coverageProfileId,
      });
      const slotReviewer = f.reviewerReadonlySession({
        workspace: { mode: "review_slot", workspace_id: "ws-review-slot" },
      });
      expect(errorCodeOf(() => f.gitReviewSend(slotReviewer.session_id, "k2"))).toBe("INVALID_REQUEST");

      // A Git reviewer session accepts only git_review_binding turns.
      const reviewer = f.reviewerReadonlySession();
      const worker = f.spawnWorkerOn("ws-repo");
      const workerStatus = f.h.core.sessionStatus(f.h.seed.coordinatorId, worker.session_id);
      const ctx = { coordinatorId: f.h.seed.coordinatorId, core: f.h.core };
      for (const [session, binding] of [
        [worker, "workspace_precondition"],
        [workerReadonly, "workspace_precondition"],
        [slotReviewer, "review_binding"],
        [reviewer, "git_review_binding"],
      ] as const) {
        const status = await callBridgeTool(ctx, "agent_session_status", { session_id: session.session_id });
        expect(status).toMatchObject({ required_send_binding: binding });
      }
      const wrongBindings = [
        {
          session_id: reviewer.session_id,
          idempotency_key: "k3",
          task: { goal: "write", acceptance_criteria: [], artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: workerStatus.initial_snapshot_id! },
        },
        {
          session_id: reviewer.session_id,
          idempotency_key: "k4",
          task: { goal: "snapshot review", acceptance_criteria: [], artifact_refs: [] },
          review_binding: { baseline_snapshot_id: workerStatus.initial_snapshot_id!, target_snapshot_id: workerStatus.initial_snapshot_id! },
        },
      ];
      for (const args of wrongBindings) {
        await expect(callBridgeTool(ctx, "agent_session_send", args)).rejects.toMatchObject({
          code: "INVALID_REQUEST",
          executionStarted: false,
          retryGuidance: "send_git_review_binding_in_same_session",
          details: { required_send_binding: "git_review_binding", workspace_mode: "current" },
        });
      }
      expect(f.h.db.raw.prepare("SELECT COUNT(*) c FROM turns").get()).toMatchObject({ c: 0 });
      expect(f.h.core.sessionStatus(f.h.seed.coordinatorId, reviewer.session_id)).toMatchObject({
        state: "IDLE", active_turn_id: null,
      });
      writeFileSync(path.join(f.repo.repoPath, "README.md"), "uncommitted documentation\n", "utf8");
      const snapshotsBefore = snapshotCount(f.h);
      const corrected = f.gitReviewSend(reviewer.session_id, "corrected-review", {
        git_review_binding: {
          base_commit: f.repo.targetCommit,
          target_commit: f.repo.targetCommit,
          include_working_tree: true,
        },
      });
      f.h.adapter.plan(corrected.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(f.h, corrected);
      await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, corrected.turn_id).state).toBe("SUCCEEDED");
      expect(snapshotCount(f.h)).toBe(snapshotsBefore);
    } finally {
      f.cleanup();
    }
  });
});

describe("git_review_binding: checkout lease serialization", () => {
  it("refuses a git review while a broker writer holds the checkout (same id or alias)", async () => {
    const f = makeFixture();
    try {
      insertWorkspace(f.h.db, {
        workspace_id: "ws-repo-alias",
        project_id: f.h.seed.projectId,
        mode: "current",
        canonical_path: f.repo.repoPath,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: f.h.seed.coverageProfileId,
      });
      const worker = f.spawnWorkerOn("ws-repo-alias");
      const status = f.h.core.sessionStatus(f.h.seed.coordinatorId, worker.session_id);
      const sent = f.h.core.send(f.h.seed.coordinatorId, {
        session_id: worker.session_id,
        idempotency_key: "w1",
        task: { goal: "Write.", acceptance_criteria: [], artifact_refs: [] },
        workspace_precondition: { expected_snapshot_id: status.initial_snapshot_id! },
      });
      f.h.adapter.plan(sent.turn_id, [{ kind: "barrier", name: "hold-write" }, { kind: "complete", outcome: "completed" }]);
      await start(f.h, sent);
      expect(f.h.adapter.pendingBarriers()).toContain("hold-write");

      const reviewer = f.reviewerReadonlySession();
      expect(errorCodeOf(() => f.gitReviewSend(reviewer.session_id, "r1"))).toBe("WORKSPACE_BUSY");

      f.h.adapter.releaseBarrier("hold-write");
      await settle(f.h);
      // After the writer settles, the review is admitted.
      const ok = f.gitReviewSend(reviewer.session_id, "r2");
      f.h.adapter.plan(ok.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(f.h, ok);
      await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, ok.turn_id).state).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });

  it("refuses a broker writer while a git review holds the checkout", async () => {
    const f = makeFixture();
    try {
      // Worker registered AFTER the reviewed commit so its digest precondition matches.
      const worker = f.spawnWorkerOn("ws-repo");
      const status = f.h.core.sessionStatus(f.h.seed.coordinatorId, worker.session_id);

      const reviewer = f.reviewerReadonlySession();
      const review = f.gitReviewSend(reviewer.session_id, "r1");
      f.h.adapter.plan(review.turn_id, [{ kind: "barrier", name: "hold-review" }, { kind: "complete", outcome: "completed" }]);
      await start(f.h, review);
      expect(f.h.adapter.pendingBarriers()).toContain("hold-review");

      expect(errorCodeOf(() =>
        f.h.core.send(f.h.seed.coordinatorId, {
          session_id: worker.session_id,
          idempotency_key: "w1",
          task: { goal: "Write.", acceptance_criteria: [], artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: status.initial_snapshot_id! },
        }),
      )).toBe("WORKSPACE_BUSY");

      f.h.adapter.releaseBarrier("hold-review");
      await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, review.turn_id).state).toBe("SUCCEEDED");
    } finally {
      f.cleanup();
    }
  });
});

describe("git_review_binding: drift discipline", () => {
  it("rejects same-status content changes after dirty admission and before dispatch", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const tracked = path.join(f.repo.repoPath, "README.md");
      writeFileSync(tracked, "edit alpha\n", "utf8");
      const sent = f.gitReviewSend(reviewer.session_id, "dirty-pre-dispatch", {
        git_review_binding: { base_commit: f.repo.targetCommit, target_commit: f.repo.targetCommit, include_working_tree: true },
      } as Partial<SendRequest>);
      const originalStatus = git(f.repo.repoPath, ["status", "--porcelain=v1"]);
      writeFileSync(tracked, "edit bravo\n", "utf8");
      expect(git(f.repo.repoPath, ["status", "--porcelain=v1"])).toBe(originalStatus);

      await start(f.h, sent);
      await settle(f.h);
      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.execution_started).toBe(false);
      expect(f.h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
    } finally { f.cleanup(); }
  });

  it("fails a queued review before dispatch when the checkout drifts (zero inference)", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const sent = f.gitReviewSend(reviewer.session_id, "g1"); // ACCEPTED, not started
      writeFileSync(path.join(f.repo.repoPath, "late-edit.txt"), "external edit\n", "utf8");

      await start(f.h, sent);
      await settle(f.h);

      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.execution_started).toBe(false);
      expect(turn.final_snapshot_id).toBeNull();
      expect(f.h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBeNull();
      expect(f.h.adapter.executedSteps(sent.turn_id)).toEqual([]);
    } finally {
      f.cleanup();
    }
  });

  it("does not accept a SUCCEEDED review when the checkout became dirty during the run", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const sent = f.gitReviewSend(reviewer.session_id, "g1");
      f.h.adapter.plan(sent.turn_id, [
        { kind: "barrier", name: "hold-review" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(f.h, sent);
      expect(f.h.adapter.pendingBarriers()).toContain("hold-review");

      writeFileSync(path.join(f.repo.repoPath, "mid-review.txt"), " drifted\n", "utf8");
      f.h.adapter.releaseBarrier("hold-review");
      await settle(f.h);

      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.native_outcome).toBe("completed"); // the native run stood; the review evidence did not
      expect(turn.final_snapshot_id).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it("fails a dirty review if content changes during inference without changing Git status", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const tracked = path.join(f.repo.repoPath, "README.md");
      writeFileSync(tracked, "edit alpha\n", "utf8");
      const sent = f.gitReviewSend(reviewer.session_id, "dirty-post-run", {
        git_review_binding: { base_commit: f.repo.targetCommit, target_commit: f.repo.targetCommit, include_working_tree: true },
      } as Partial<SendRequest>);
      const originalStatus = git(f.repo.repoPath, ["status", "--porcelain=v1"]);
      f.h.adapter.plan(sent.turn_id, [
        { kind: "barrier", name: "hold-dirty-review" },
        { kind: "complete", outcome: "completed" },
      ]);
      await start(f.h, sent);
      expect(f.h.adapter.pendingBarriers()).toContain("hold-dirty-review");
      writeFileSync(tracked, "edit bravo\n", "utf8");
      expect(git(f.repo.repoPath, ["status", "--porcelain=v1"])).toBe(originalStatus);
      f.h.adapter.releaseBarrier("hold-dirty-review");
      await settle(f.h);
      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.native_outcome).toBe("completed");
      expect(turn.git_working_tree_digest).toMatch(/^[0-9a-f]{64}$/);
    } finally { f.cleanup(); }
  });

  it("keeps the binding durable across reconciliation without final snapshots", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const tracked = path.join(f.repo.repoPath, "README.md");
      writeFileSync(tracked, "persist this staged state\n", "utf8");
      git(f.repo.repoPath, ["add", "README.md"]);
      writeFileSync(tracked, "and this unstaged state\n", "utf8");
      writeFileSync(path.join(f.repo.repoPath, "untracked-review.bin"), Buffer.from([7, 0, 255]));
      const digest = gitWorkingTreeDigest(f.repo.repoPath);
      const sent = f.gitReviewSend(reviewer.session_id, "g1", {
        git_review_binding: { base_commit: f.repo.targetCommit, target_commit: f.repo.targetCommit, include_working_tree: true },
      } as Partial<SendRequest>);
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      // Crash window: native outcome is journaled, terminal commit skipped.
      await f.h.executor.completeWithoutCommitForTest(sent.turn_id);
      let turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.git_base_commit).toBe(f.repo.targetCommit);
      expect(turn.git_target_commit).toBe(f.repo.targetCommit);
      expect(turn.git_working_tree_digest).toBe(digest);

      // A dirty checkout at reconciliation time must not yield SUCCEEDED.
      writeFileSync(path.join(f.repo.repoPath, "reconcile-dirty.txt"), "x\n", "utf8");
      await f.h.executor.reconcileJournaledOutcomes();
      turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.error_code).toBe("WORKSPACE_CHANGED");
      expect(turn.git_working_tree_digest).toBe(digest);
      expect(turn.final_snapshot_id).toBeNull();
    } finally {
      f.cleanup();
    }
  });

  it("reconciles a journaled completed review to SUCCEEDED with zero final snapshot on a clean checkout", async () => {
    const f = makeFixture();
    try {
      const reviewer = f.reviewerReadonlySession();
      const sent = f.gitReviewSend(reviewer.session_id, "g1");
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await f.h.executor.completeWithoutCommitForTest(sent.turn_id);
      const before = snapshotCount(f.h);
      await f.h.executor.reconcileJournaledOutcomes();
      const turn = f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("SUCCEEDED");
      expect(turn.git_base_commit).toBe(f.repo.baseCommit);
      expect(turn.git_target_commit).toBe(f.repo.targetCommit);
      expect(turn.final_snapshot_id).toBeNull();
      expect(snapshotCount(f.h)).toBe(before);
    } finally {
      f.cleanup();
    }
  });
});

describe("git_review_binding: broker-created reviewer worktree (parallel review)", () => {
  it("provisions a detached reviewer worktree at the exact target commit and reviews there while the author moves on", async () => {
    const f = makeFixture();
    const managedRoot = path.join(path.dirname(f.repo.repoPath), "managed-worktrees");
    const core = new BrokerCore({
      db: f.h.db,
      clock: f.h.clock,
      adapters: new Map([["mock", f.h.adapter]]),
      limits: f.h.limits,
      deferExecution: true,
      blobStore: f.h.core.blobStore,
      worktreesRoot: managedRoot,
    });
    core.attachExecutor(f.h.executor);
    try {
      const spawned = core.spawn(f.h.seed.coordinatorId, {
        project_id: f.h.seed.projectId,
        idempotency_key: "spawn-wt-reviewer",
        provider: "mock",
        account_profile_id: f.h.seed.accountMock1,
        model: "mock-model-1",
        effort: null,
        role: "reviewer",
        instructions: "Review the exact target commit in your own worktree.",
        workspace: {
          mode: "worktree",
          workspace_id: null,
          repository_workspace_id: "ws-repo",
          base_commit: f.repo.targetCommit,
        },
        policy_profile_id: "pol-reviewer",
      });
      await core.drain();
      await f.h.executor.drain();
      // Worktree completion runs as tracked background work: re-read the row.
      const session = f.h.core.sessionStatus(f.h.seed.coordinatorId, spawned.session_id);
      expect(session.state).toBe("IDLE");
      expect(session.initial_snapshot_id).toBeNull();
      expect(spawned.worktree?.base_commit).toBe(f.repo.targetCommit);

      // The worktree is detached exactly at the review target and clean.
      const journalRow = f.h.db.raw
        .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
        .get(spawned.session_id) as { payload: string };
      const worktreePath = ((JSON.parse(journalRow.payload) as { worktree_provisioning: { worktree_path: string } }).worktree_provisioning).worktree_path;
      expect(existsSync(worktreePath)).toBe(true);
      expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(f.repo.targetCommit);
      // The reviewed PNG content is present via Git, with no snapshot copy.
      expect(readFileSync(path.join(worktreePath, "src", "assets", "logo.png"))).toEqual(PNG_BYTES);

      // The author keeps working in the source checkout; the review proceeds.
      f.repo.aheadCommit();
      const sent = f.h.core.send(f.h.seed.coordinatorId, {
        session_id: spawned.session_id,
        idempotency_key: "wt-review-1",
        task: { goal: "Review the bound commits.", acceptance_criteria: [], artifact_refs: [] },
        git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit },
      } as Parameters<BrokerCore["send"]>[1]);
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      f.h.executor.startTurn(sent.turn_id);
      await settle(f.h);
      expect(f.h.core.turnStatus(f.h.seed.coordinatorId, sent.turn_id).state).toBe("SUCCEEDED");
    } finally {
      rmSync(managedRoot, { recursive: true, force: true });
      f.cleanup();
    }
  });
});

describe("git_review_binding: MCP bridge surface", () => {
  it("advertises git_review_binding and truthful snapshot annotations; rejects two bindings", async () => {
    const f = makeFixture();
    try {
      const defs = bridgeToolDefs();
      const sendDef = defs.find((d) => d.name === "agent_session_send")!;
      expect(Object.keys((sendDef.inputSchema as { properties: Record<string, unknown> }).properties))
        .toContain("git_review_binding");
      const snapshotDef = defs.find((d) => d.name === "agent_workspace_snapshot")!;
      expect(snapshotDef.annotations?.readOnlyHint).toBe(false);
      expect(snapshotDef.annotations?.destructiveHint).toBe(false);
      expect(snapshotDef.description).toMatch(/LOCAL/i);
      expect(snapshotDef.description).toMatch(/launches no inference/i);
      expect(sendDef.annotations?.readOnlyHint).toBe(false);
      const gitBindingSchema = (sendDef.inputSchema as { properties: { git_review_binding: { properties: Record<string, unknown>; additionalProperties: boolean } } }).properties.git_review_binding;
      expect(gitBindingSchema.properties.include_working_tree).toMatchObject({ type: "boolean" });
      expect(gitBindingSchema.additionalProperties).toBe(false);
      const spawnDef = defs.find((d) => d.name === "agent_session_spawn")!;
      expect(spawnDef.description).toMatch(/without provider inference/i);

      const ctx = { coordinatorId: f.h.seed.coordinatorId, core: f.h.core };
      const reviewer = f.reviewerReadonlySession();
      const two = {
        session_id: reviewer.session_id,
        idempotency_key: "bridge-1",
        task: { goal: "x", artifact_refs: [] },
        git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit },
        workspace_precondition: { expected_snapshot_id: "snap-x" },
      };
      await expect(callBridgeTool(ctx, "agent_session_send", two)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(callBridgeTool(ctx, "agent_session_send", {
        session_id: reviewer.session_id,
        idempotency_key: "bridge-forged-digest",
        task: { goal: "Review.", artifact_refs: [] },
        git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit, working_tree_digest: "0".repeat(64) },
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(callBridgeTool(ctx, "agent_session_send", {
        session_id: reviewer.session_id,
        idempotency_key: "bridge-invalid-flag",
        task: { goal: "Review.", artifact_refs: [] },
        git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit, include_working_tree: "true" },
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });

      // The tool path reaches the core with the git binding.
      const sent = (await callBridgeTool(ctx, "agent_session_send", {
        session_id: reviewer.session_id,
        idempotency_key: "bridge-2",
        task: { goal: "Review.", artifact_refs: [] },
        git_review_binding: { base_commit: f.repo.baseCommit, target_commit: f.repo.targetCommit },
      })) as { turn_id: string };
      f.h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      f.h.executor.startTurn(sent.turn_id);
      await settle(f.h);
      const status = (await callBridgeTool(ctx, "agent_turn_status", { turn_id: sent.turn_id })) as {
        git_base_commit: string | null;
        git_target_commit: string | null;
        git_working_tree_digest: string | null;
      };
      expect(status.git_base_commit).toBe(f.repo.baseCommit);
      expect(status.git_target_commit).toBe(f.repo.targetCommit);
      expect(status.git_working_tree_digest).toBeNull();
    } finally {
      f.cleanup();
    }
  });
});
