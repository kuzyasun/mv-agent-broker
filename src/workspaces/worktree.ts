/**
 * Broker-created detached Git worktrees (spec §8.3).
 *
 * The broker provisions a detached worktree of a REGISTERED repository
 * workspace at an explicit base commit — never a caller path, never a
 * branch/HEAD guess, never a branch creation. Provisioning runs external Git
 * OUTSIDE any metadata transaction; the durable intent journal (owned by the
 * broker core) stages every step so a crash reconciles without duplicate
 * creation, and a foreign path is never deleted or adopted.
 *
 * §8.3 (normative): ALL broker Git metadata mutations of one repository
 * serialize under a repository-level lock keyed by the resolved shared Git
 * common-dir identity — not the worktree path, not the workspace id — so
 * registered aliases cannot bypass it. Reads stay lock-free.
 *
 * Git MUTATIONS run through the shared Windows job-object managed execution
 * path (KILL_ON_JOB_CLOSE): the exact owned launch receipt is persisted in
 * the session provision journal BEFORE the root is resumed, and a completion
 * is only ever returned after the helper's authoritative quiescence receipt
 * (ActiveProcesses==0 with drained pipes) — never a parent exit or a bare
 * PID. An uncertain outcome after resume retains the journal and fences the
 * repository durably (no TTL, no PID reuse release); a restart must never
 * start another mutation against the same repository while an old operation
 * may still be alive. On platforms without the owned-job infrastructure
 * mutations are refused honestly (capability refusal, never a fabricated
 * completion); bounded reads (both pipes drained, fixed caps) stay available.
 */
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { sha256Hex } from "../shared/ids.ts";
import { prepareCommand } from "../providers/common/headless.ts";
import {
  runWindowsJob,
  WindowsJobCapabilityError,
  type WindowsJobOwnership,
} from "../providers/common/windowsJob.ts";

/** Journal schema version for the broker-owned worktree provision record. */
export const WORKTREE_PROVISION_BINDING_VERSION = 1;

/** Explicit base commit: full SHA-1 (40) or SHA-256 (64) lowercase hex. */
const BASE_COMMIT_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Bounded subprocess budgets (§15.1): no unbounded output, no hang. */
export const READ_TIMEOUT_MS = 10_000;
export const MUTATE_TIMEOUT_MS = 60_000;
export const MAX_OUTPUT_BYTES = 64 * 1024;
const PATH_TOO_LONG_PATTERN = /\b(?:file(?:name)?|path)\s+too\s+long\b/i;

/**
 * Stages of the durable provisioning journal (inside the session-owned
 * provision_session intent payload — no schema change):
 *   pending  — admitted; no Git mutation started yet
 *   adding   — `git worktree add` dispatched (crash here = unknown state
 *              once a launch receipt exists; provably never resumed without
 *              one, because the receipt is persisted BEFORE ResumeThread)
 *   added    — owned quiescence proof recorded: the add completed
 *   ready    — provision verified; normal snapshot completion may proceed
 */
export type WorktreeProvisionStage = "pending" | "adding" | "added" | "ready";

/**
 * Exact owned launch receipt of one Git mutation (Windows job object). It is
 * observed by the broker's own managed-execution protocol — never caller
 * supplied — and persisted durably BEFORE the root process is resumed. The
 * nonce identifies one dispatch attempt uniquely across incarnations.
 */
export interface WorktreeLaunchReceipt {
  /** Broker-generated unique operation nonce for this dispatch attempt. */
  nonce: string;
  launch_uuid: string;
  named_job: string;
  root_pid: number;
  root_creation_time: string;
  owner_pid: number;
  owner_creation_time: string;
  helper_pid: number;
}

/**
 * Exact owned completion receipt of one Git mutation, binding to the exact
 * launch nonce/ownership from the managed protocol before declaring added.
 */
export interface WorktreeCompletionReceipt extends WorktreeLaunchReceipt {}

/**
 * Durable provisioning intent (journal). Contains no credentials; the path is
 * broker-internal evidence and is never echoed in public API responses.
 */
export interface WorktreeProvisionJournal {
  binding_version: number;
  /** Registered source repository workspace reference (same project). */
  source_workspace_id: string;
  /** Resolved shared Git common dir (lock identity), realpath-normalized. */
  source_common_dir: string;
  /** Explicit full-hex base commit the detached worktree is created at. */
  base_commit: string;
  /** Broker-generated workspace row bound to the session. */
  workspace_id: string;
  /** Broker-managed absolute worktree path (hash-of-session under the root). */
  worktree_path: string;
  /** Managed root the path was allocated under. */
  managed_root: string;
  stage: WorktreeProvisionStage;
  /**
   * Repository-level lock fencing recorded while held (§8.3). The hold_id +
   * incarnation pair is the exact owner token: process-local seq values
   * reset on restart and never authorize a transition on their own.
   */
  lock: {
    key: string;
    seq: number;
    acquired_at: number;
    hold_id?: string;
    incarnation?: string;
  } | null;
  /**
   * Launch receipt of the current mutation dispatch attempt. Present from
   * the moment the owned root was created (pre-resume) — its existence means
   * the operation MAY have run and must never be re-dispatched or inferred
   * from files alone. Absent proves the root was never resumed (zero resume).
   */
  launch: WorktreeLaunchReceipt | null;
  /**
   * Verified completion receipt from the managed protocol, binding to the
   * exact launch nonce and ownership before stage 'added' is declared.
   */
  completion?: WorktreeCompletionReceipt | null;
  /** The source checkout's dirty/untracked content is never copied. */
  current_checkout_changes_copied: false;
  /** Bounded failure evidence (quarantine reason class, never a full path). */
  failure?: { reason: string };
}

/** Bounded shape validation for one launch receipt field set. */
function parseLaunchReceipt(value: unknown): WorktreeLaunchReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const str = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;
  const int = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (
    !str(r.nonce, 128) ||
    !str(r.launch_uuid, 128) ||
    !str(r.named_job, 256) ||
    !int(r.root_pid) ||
    !str(r.root_creation_time, 64) || !/^[0-9]{1,19}$/.test(r.root_creation_time) ||
    !int(r.owner_pid) ||
    !str(r.owner_creation_time, 64) || !/^[0-9]{1,19}$/.test(r.owner_creation_time) ||
    !int(r.helper_pid)
  ) {
    return null;
  }
  return {
    nonce: r.nonce,
    launch_uuid: r.launch_uuid,
    named_job: r.named_job,
    root_pid: r.root_pid,
    root_creation_time: r.root_creation_time,
    owner_pid: r.owner_pid,
    owner_creation_time: r.owner_creation_time,
    helper_pid: r.helper_pid,
  };
}

/** Parse and validate a journal recorded in a provision intent payload. */
export function parseWorktreeJournal(value: unknown): WorktreeProvisionJournal | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const j = value as Record<string, unknown>;
  const stages: readonly string[] = ["pending", "adding", "added", "ready"];
  if (
    j.binding_version !== WORKTREE_PROVISION_BINDING_VERSION ||
    typeof j.source_workspace_id !== "string" ||
    typeof j.source_common_dir !== "string" ||
    !path.isAbsolute(j.source_common_dir) ||
    typeof j.base_commit !== "string" ||
    !BASE_COMMIT_PATTERN.test(j.base_commit) ||
    typeof j.workspace_id !== "string" ||
    typeof j.worktree_path !== "string" ||
    !path.isAbsolute(j.worktree_path) ||
    typeof j.managed_root !== "string" ||
    !path.isAbsolute(j.managed_root) ||
    !stages.includes(String(j.stage)) ||
    j.current_checkout_changes_copied !== false
  ) {
    return null;
  }
  const lock = j.lock;
  const lockObj = lock as Record<string, unknown> | null;
  const validLock =
    lock === null ||
    (typeof lock === "object" && !Array.isArray(lock) &&
      typeof lockObj!.key === "string" &&
      Number.isSafeInteger(lockObj!.seq) &&
      Number.isSafeInteger(lockObj!.acquired_at) &&
      (lockObj!.hold_id === undefined || typeof lockObj!.hold_id === "string") &&
      (lockObj!.incarnation === undefined || typeof lockObj!.incarnation === "string"));
  if (!validLock) return null;
  // A present-but-malformed launch receipt makes the whole journal malformed
  // (retained, never interpreted as an ordinary provision).
  let launch: WorktreeLaunchReceipt | null = null;
  if (j.launch !== undefined && j.launch !== null) {
    launch = parseLaunchReceipt(j.launch);
    if (!launch) return null;
  }
  let completion: WorktreeCompletionReceipt | null = null;
  if (j.completion !== undefined && j.completion !== null) {
    completion = parseLaunchReceipt(j.completion);
    if (!completion) return null;
  }
  return {
    binding_version: WORKTREE_PROVISION_BINDING_VERSION,
    source_workspace_id: j.source_workspace_id,
    source_common_dir: j.source_common_dir,
    base_commit: j.base_commit,
    workspace_id: j.workspace_id,
    worktree_path: j.worktree_path,
    managed_root: j.managed_root,
    stage: j.stage as WorktreeProvisionStage,
    lock: lock === null ? null : {
      key: lockObj!.key as string,
      seq: lockObj!.seq as number,
      acquired_at: lockObj!.acquired_at as number,
      ...(typeof lockObj!.hold_id === "string" ? { hold_id: lockObj!.hold_id } : {}),
      ...(typeof lockObj!.incarnation === "string" ? { incarnation: lockObj!.incarnation } : {}),
    },
    launch,
    ...(completion !== null ? { completion } : {}),
    current_checkout_changes_copied: false,
    ...(j.failure && typeof j.failure === "object" && !Array.isArray(j.failure) &&
      typeof (j.failure as Record<string, unknown>).reason === "string"
      ? { failure: { reason: (j.failure as Record<string, unknown>).reason as string } }
      : {}),
  };
}

// ─── managed path allocation ────────────────────────────────────────────────

/**
 * Deterministic managed worktree path for a logical session: one hash-of-
 * session directory under the broker-managed root. The session id is
 * validated (no separators/leading dot) before hashing; the result is
 * re-verified to stay strictly inside the resolved root (§8.3 containment).
 */
export function computeManagedWorktreePath(managedRoot: string, sessionId: string): string {
  if (!sessionId || !/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith(".")) {
    throw new Error("INVALID_SESSION_ID");
  }
  const root = realpathSync(managedRoot);
  const candidate = path.join(root, `wt-${sha256Hex(sessionId)}`);
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("WORKTREE_PATH_OUTSIDE_MANAGED_ROOT");
  }
  return candidate;
}

/** Realpath containment: does `candidate` resolve strictly inside `root`? */
export function resolvesInsideRoot(root: string, candidate: string): boolean {
  try {
    const resolvedRoot = realpathSync(root);
    const resolved = realpathSync(candidate);
    const relative = path.relative(resolvedRoot, resolved);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  } catch {
    return false;
  }
}

/**
 * Physical/case-alias-proof lock identity: resolve to the on-disk canonical
 * spelling so junctions, links and letter-case variants of one repository
 * share a single §8.3 lock key. Unresolvable keys fall back to their literal
 * form (the repo is gone; preflight refuses them anyway).
 */
export function pathsEqual(a: string, b: string): boolean {
  if (a === b) return true;
  if (process.platform === "win32") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return false;
}

export function canonicalizeLockKey(key: string): string {
  try {
    const resolved = realpathSync(key);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  } catch {
    return process.platform === "win32" ? key.toLowerCase() : key;
  }
}

// ─── Git environment routing (§12.3) ────────────────────────────────────────

/**
 * Git routing must bind the REGISTERED source checkout: ambient GIT_DIR /
 * GIT_WORK_TREE / GIT_COMMON_DIR / index / config override variables are
 * stripped so a hostile or stale environment can never redirect broker Git
 * reads or mutations to another repository. Local config files are part of
 * the registered checkout itself and stay in effect.
 */
function gitRoutingEnv(kind: "read" | "mutate"): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^GIT_/i.test(key)) continue; // no ambient Git routing survives
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0"; // local repos must never hang on a prompt
  if (kind === "read") env.GIT_OPTIONAL_LOCKS = "0"; // reads never take locks
  return env;
}

// ─── bounded Git subprocess execution (reads) ───────────────────────────────

export class WorktreePreflightError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "WorktreePreflightError";
  }
}

/** Result of the synchronous source-repository preflight (§8.3 reads). */
export interface SourceRepositoryIdentity {
  /** realpath-normalized shared Git common dir — the §8.3 lock identity. */
  commonDir: string;
}

function runGitSync(args: {
  cwd: string;
  gitArgs: string[];
  timeoutMs: number;
}): { stdout: string } {
  const result = spawnSync("git", args.gitArgs, {
    cwd: args.cwd,
    encoding: "buffer",
    timeout: args.timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
    env: gitRoutingEnv("read"),
  });
  if (result.error) {
    throw new WorktreePreflightError("git could not be executed", "git-unavailable");
  }
  if (result.status !== 0) {
    throw new WorktreePreflightError(
      `git ${args.gitArgs[0]} failed with status ${result.status}`,
      "git-command-failed",
    );
  }
  return { stdout: result.stdout.toString("utf8").trim() };
}

/**
 * Synchronous preflight of a REGISTERED source repository (§8.3 reads; runs
 * OUTSIDE any transaction and OUTSIDE the repository lock — reads never take
 * it): the canonical path must be a real Git repository, and the explicit
 * base commit must exist and be a commit. No branch is resolved, no HEAD is
 * guessed, nothing is created. Only allowlisted argument shapes reach Git,
 * with bounded output, under a scrubbed environment.
 */
export function resolveSourceCommonDir(sourcePath: string): string {
  if (!existsSync(sourcePath) || !statSync(sourcePath).isDirectory()) {
    throw new WorktreePreflightError("Source workspace path is not a directory.", "source-not-a-repository");
  }
  // Resolve the shared common dir as an absolute path; realpath-normalize so
  // junction/symlink/case aliases of one repository share one lock identity.
  const common = runGitSync({
    cwd: sourcePath,
    gitArgs: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    timeoutMs: READ_TIMEOUT_MS,
  });
  const raw = common.stdout;
  if (!raw || !path.isAbsolute(raw)) {
    throw new WorktreePreflightError("Source workspace is not a real Git repository.", "source-not-a-repository");
  }
  let commonDir: string;
  try {
    commonDir = realpathSync(raw);
  } catch {
    throw new WorktreePreflightError("Source repository common dir does not resolve.", "source-not-a-repository");
  }
  return commonDir;
}

export function preflightSourceRepository(sourcePath: string, baseCommit: string): SourceRepositoryIdentity {
  if (!BASE_COMMIT_PATTERN.test(baseCommit)) {
    throw new WorktreePreflightError(
      "base_commit must be a full 40- or 64-character lowercase hexadecimal commit id.",
      "invalid-base-commit",
    );
  }
  const commonDir = resolveSourceCommonDir(sourcePath);
  // The commit must exist and be a commit: peel with ^{commit} — never a
  // branch or HEAD guess. The common-dir read above already proved Git works
  // here, so a failed peel means the id does not resolve to a commit.
  try {
    const verify = runGitSync({
      cwd: sourcePath,
      gitArgs: ["rev-parse", "--verify", `${baseCommit}^{commit}`],
      timeoutMs: READ_TIMEOUT_MS,
    });
    if (verify.stdout !== baseCommit) {
      throw new WorktreePreflightError(
        "base_commit does not resolve to the given commit in the source repository.",
        "unknown-base-commit",
      );
    }
  } catch (e) {
    if (e instanceof WorktreePreflightError) throw e;
    throw new WorktreePreflightError(
      "base_commit does not resolve to a commit in the source repository.",
      "unknown-base-commit",
    );
  }
  return { commonDir };
}

// ─── async Git runner (mutations + post-mutation verification) ──────────────

export interface WorktreeLaunchOwnership extends WindowsJobOwnership {}

/** Persist the exact launch receipt durably BEFORE the root is resumed. */
export type OwnershipGate = (receipt: WorktreeLaunchReceipt) => void | Promise<void>;

export interface WorktreeGitRun {
  cwd: string;
  gitArgs: string[];
  /** "read" commands run without the repository lock; "mutate" under it. */
  kind: "read" | "mutate";
  /** Mutation only: durable ownership-before-resume gate (core journal). */
  onOwnership?: OwnershipGate;
}

export function receiptsMatch(a: WorktreeLaunchReceipt, b: WorktreeCompletionReceipt): boolean {
  return (
    a.nonce === b.nonce &&
    a.launch_uuid === b.launch_uuid &&
    a.named_job === b.named_job &&
    a.root_pid === b.root_pid &&
    a.root_creation_time === b.root_creation_time &&
    a.owner_pid === b.owner_pid &&
    a.owner_creation_time === b.owner_creation_time &&
    a.helper_pid === b.helper_pid
  );
}

export interface WorktreeGitRunner {
  run(args: WorktreeGitRun): Promise<{ stdout: string; completion?: WorktreeCompletionReceipt }>;
}

/**
 * Classified Git execution failure. `definitive` means the effect question
 * is decidable: the process tree PROVABLY never started or provably
 * terminated cleanly (helper quiescence receipt) — a re-inspection of the
 * filesystem is authoritative. Non-definitive (uncertain) failures leave the
 * effect UNKNOWN: callers must retain the journal and fence the repository,
 * never re-dispatch and never infer completion from files.
 */
export class WorktreeGitRunError extends Error {
  constructor(
    /** Bounded reason class — never raw args, paths or stderr content. */
    readonly reason: string,
    readonly definitive: boolean,
  ) {
    super(reason);
    this.name = "WorktreeGitRunError";
  }
}

export interface WorktreeGitRunnerOptions {
  readTimeoutMs?: number;
  mutateTimeoutMs?: number;
  /**
   * Fault-injection seam (tests/process fixtures): override the launched
   * program for a Git invocation. Undefined in production — plain `git`.
   */
  programOverride?: (gitArgs: string[], kind: "read" | "mutate") => { program: string; args: string[] } | undefined;
}

/**
 * Production runner: argument-array subprocess (no shell), bounded time and
 * output, both pipes always drained under fixed caps, generic safe error
 * classes (no raw paths/args/stderr anywhere).
 *
 * Mutations (Windows) launch through the broker-owned job-object helper:
 * completion is returned ONLY on the helper's quiescence receipt
 * (ActiveProcesses==0, pipes drained) — never on a parent exit or a bare
 * PID. The ownership callback persists the exact launch receipt before
 * ResumeThread; a throw there cancels with zero resume (the child never
 * executed). Helper/process loss after resume resolves as UNCERTAIN.
 */
export function createRealWorktreeGitRunner(options: WorktreeGitRunnerOptions = {}): WorktreeGitRunner {
  const readTimeoutMs = options.readTimeoutMs ?? READ_TIMEOUT_MS;
  const mutateTimeoutMs = options.mutateTimeoutMs ?? MUTATE_TIMEOUT_MS;
  const resolveProgram = (gitArgs: string[], kind: "read" | "mutate") => {
    // Keep the setting per invocation: broker worktrees must not alter the
    // source repository or the user's global Git configuration.
    const invocationArgs =
      kind === "mutate" && process.platform === "win32"
        ? ["-c", "core.longpaths=true", ...gitArgs]
        : gitArgs;
    return options.programOverride?.(invocationArgs, kind) ?? { program: "git", args: invocationArgs };
  };
  const classifyGitExit = (stderr: string): string =>
    PATH_TOO_LONG_PATTERN.test(stderr) ? "git-path-too-long" : "git-exit-nonzero";

  /** Bounded read: plain spawn, both pipes drained, settle only on close. */
  const runBoundedRead = (args: WorktreeGitRun): Promise<{ stdout: string }> =>
    new Promise((resolve, reject) => {
      const program = resolveProgram(args.gitArgs, "read");
      let child: ReturnType<typeof nodeSpawn>;
      try {
        child = nodeSpawn(program.program, program.args, {
          cwd: args.cwd,
          windowsHide: true,
          env: gitRoutingEnv("read"),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(new WorktreeGitRunError("git-unavailable", true));
        return;
      }
      let stdout: Buffer[] = [];
      let stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let overflowed = false;
      let timedOut = false;
      let spawnError = false;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (spawnError) {
          reject(new WorktreeGitRunError("git-unavailable", true));
          return;
        }
        if (overflowed) {
          reject(new WorktreeGitRunError("git-output-limit", true));
          return;
        }
        if (timedOut) {
          // Settle only after `close`: both pipes are drained and the child
          // is provably gone — never reject ahead of it.
          reject(new WorktreeGitRunError("git-timeout", true));
          return;
        }
        if (child.exitCode === 0 && child.signalCode === null) {
          resolve({ stdout: Buffer.concat(stdout).toString("utf8").trim() });
        } else {
          reject(new WorktreeGitRunError(classifyGitExit(Buffer.concat(stderr).toString("utf8")), true));
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child.kill();
        } catch {
          /* gone */
        }
      }, readTimeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
        else overflowed = true; // keep draining both pipes under the cap
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.byteLength;
        if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(chunk);
        else if (stderrBytes - chunk.byteLength < MAX_OUTPUT_BYTES) {
          stderr.push(chunk.subarray(0, MAX_OUTPUT_BYTES - (stderrBytes - chunk.byteLength)));
        }
        if (stderrBytes > MAX_OUTPUT_BYTES) overflowed = true; // drained, discarded
      });
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      child.on("error", () => {
        spawnError = true;
      });
      child.on("close", () => finish());
    });

  /** Managed mutation: owned job launch with receipt-before-resume. */
  const runManagedMutation = async (
    args: WorktreeGitRun,
  ): Promise<{ stdout: string; completion?: WorktreeCompletionReceipt }> => {
    const program = resolveProgram(args.gitArgs, "mutate");
    let prepared: ReturnType<typeof prepareCommand>;
    try {
      prepared = prepareCommand(program.program, program.args);
    } catch {
      throw new WorktreeGitRunError("git-launch-refused", true);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), mutateTimeoutMs);
    let stdout: Buffer[] = [];
    let stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimited = false;
    let recordedReceipt: WorktreeLaunchReceipt | null = null;
    try {
      const result = await runWindowsJob({
        applicationName: prepared.command,
        args: prepared.windowsVerbatim ? [] : prepared.args,
        verbatimCommandLine: prepared.windowsVerbatim
          ? [
              /[\s"]/.test(prepared.command) ? `"${prepared.command.replace(/"/g, "")}"` : prepared.command,
              ...prepared.args,
            ].join(" ")
          : undefined,
        cwd: args.cwd,
        envPairs: Object.entries(gitRoutingEnv("mutate"))
          .filter(([k, v]) => v !== undefined && !k.includes("=") && !k.includes("\0") && !String(v).includes("\0"))
          .map(([k, v]) => `${k}=${v}`),
        childStdin: Buffer.alloc(0),
        signal: ac.signal,
        maxNativeOutputBytes: MAX_OUTPUT_BYTES,
        onBeforeResume: async (ownership: WindowsJobOwnership) => {
          if (!args.onOwnership) return;
          const receipt: WorktreeLaunchReceipt = {
            nonce: randomUUID(),
            launch_uuid: ownership.launch_uuid,
            named_job: ownership.named_job,
            root_pid: ownership.root_pid,
            root_creation_time: ownership.root_creation_time,
            owner_pid: ownership.owner_pid,
            owner_creation_time: ownership.owner_creation_time,
            helper_pid: ownership.helper_pid,
          };
          recordedReceipt = receipt;
          await args.onOwnership(receipt);
        },
        onStdoutChunk: (bytes) => {
          stdoutBytes += bytes.byteLength;
          if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(bytes);
        },
        onStderrChunk: (bytes) => {
          stderrBytes += bytes.byteLength; // drained; never echoed anywhere
          if (stderrBytes <= MAX_OUTPUT_BYTES) stderr.push(bytes);
          else if (stderrBytes - bytes.byteLength < MAX_OUTPUT_BYTES) {
            stderr.push(bytes.subarray(0, MAX_OUTPUT_BYTES - (stderrBytes - bytes.byteLength)));
          }
          if (stderrBytes > MAX_OUTPUT_BYTES) outputLimited = true;
        },
      });
      // Resume acknowledgement may be lost after the root actually started.
      // The helper's uncertainty evidence outranks an absent resumed receipt.
      if (result.uncertainAfterResume) {
        throw new WorktreeGitRunError("git-uncertain-after-resume", false);
      }
      if (!result.resumed || result.ownership === null) {
        // The gate persisted nothing: the root was created suspended and
        // never resumed — the mutation provably never executed.
        throw new WorktreeGitRunError("git-launch-refused", true);
      }
      if (!result.quiesced) {
        throw new WorktreeGitRunError("git-uncertain-after-resume", false);
      }
      if (result.protocolError) {
        throw new WorktreeGitRunError("git-protocol-failed", false);
      }
      if (result.killed || outputLimited || result.outputLimited === true) {
        // Provably dead tree, but the effect of a killed mutation is unknown.
        throw new WorktreeGitRunError(
          result.terminationReason === "output_limit" || outputLimited ? "git-output-limit" : "git-timeout",
          false,
        );
      }
      if (result.exitCode !== 0) {
        const stderrText = `${Buffer.concat(stderr).toString("utf8")}\n${result.stderrTail}`;
        throw new WorktreeGitRunError(classifyGitExit(stderrText), true);
      }
      return {
        stdout: Buffer.concat(stdout).toString("utf8").trim(),
        completion: recordedReceipt ?? undefined,
      };
    } catch (e) {
      if (e instanceof WindowsJobCapabilityError) {
        throw new WorktreeGitRunError("git-launch-refused", true);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    async run(args: WorktreeGitRun): Promise<{ stdout: string; completion?: WorktreeCompletionReceipt }> {
      if (args.kind === "mutate") {
        if (process.platform !== "win32") {
          // Honest capability refusal: no owned-quiescence proof exists on
          // this platform, so a mutation would be a fabricated completion.
          throw new WorktreeGitRunError("managed-git-mutation-unavailable", true);
        }
        return runManagedMutation(args);
      }
      return runBoundedRead(args);
    },
  };
}

// ─── repository-level mutation lock (§8.3) ──────────────────────────────────

export interface RepositoryLockTicket {
  /** Realpath-normalized common dir — the lock identity. */
  key: string;
  /** Process-wide monotonic sequence (resets on restart; never a fence). */
  seq: number;
  acquired_at: number;
  /** Unique hold nonce — the exact owner token for journal CAS transitions. */
  hold_id: string;
  /** Broker incarnation that owns this hold. */
  incarnation: string;
}

let lockSequence = 0;

/**
 * Keyed async mutex over Git metadata mutations. The key is canonicalized to
 * the resolved shared Git common-dir identity (physical/case aliases cannot
 * bypass it), so registered aliases, junctions and path spellings of one
 * repository serialize while distinct repositories proceed independently.
 * Holders run to completion (owned-operation commit included) before the
 * next mutation starts. A crashed holder dies with the process — the
 * daemon's exclusive state-dir ownership forbids a concurrent replacement —
 * and the durable journal fence, not this in-process mutex, is what stops a
 * restarted daemon from re-mutating an uncertain repository.
 */
export class RepositoryMutationLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  constructor(private readonly incarnation: string = randomUUID()) {}

  get currentIncarnation(): string {
    return this.incarnation;
  }

  async withLock<T>(key: string, fn: (ticket: RepositoryLockTicket) => Promise<T>): Promise<T> {
    const canonical = canonicalizeLockKey(key);
    const previous = this.tails.get(canonical) ?? Promise.resolve();
    let releaseTail!: () => void;
    const tail = new Promise<void>((resolve) => (releaseTail = resolve));
    // The next waiter resolves only after every earlier holder released.
    this.tails.set(canonical, previous.then(() => tail));
    await previous.catch(() => undefined);
    const ticket: RepositoryLockTicket = {
      key: canonical,
      seq: ++lockSequence,
      acquired_at: Date.now(),
      hold_id: randomUUID(),
      incarnation: this.incarnation,
    };
    try {
      return await fn(ticket);
    } finally {
      releaseTail();
    }
  }
}

// ─── provisioning primitives ────────────────────────────────────────────────

/** Classification of the target path inspected INSIDE the repository lock. */
export type TargetInspection =
  | { kind: "absent" }
  | { kind: "owned" }
  | { kind: "foreign"; reason: string }
  | { kind: "uncertain"; reason: string };

const FORK_LINK = "gitdir:";

/**
 * Inspect an existing (or absent) worktree path and classify ownership.
 *
 * `allowOwned=false` (a pending provision, or a re-dispatch after an
 * operation that provably never ran) rejects ANY preexisting path — even a
 * valid Git worktree of the same repository at the same commit: adoption
 * requires durable operation proof this early state cannot have.
 *
 * `allowOwned=true` (recovery of a provision whose stage carries durable
 * completion proof) requires the EXACT allocation: no symlink/junction at
 * the path (including an alias to another session inside the managed root),
 * the on-disk realpath identical to the generated canonical path, strict
 * managed-root containment, same shared common dir, an actually linked
 * worktree (`.git` file backpointer + broker gitdir inside the common dir +
 * toplevel equality), a DETACHED HEAD, at exactly the journaled base commit.
 * The main checkout, a foreign branch checkout or another repository never
 * pass even at the same HEAD.
 */
export async function inspectWorktreeTarget(args: {
  managedRoot: string;
  worktreePath: string;
  sourceCommonDir: string;
  baseCommit: string;
  runner: WorktreeGitRunner;
  allowOwned: boolean;
}): Promise<TargetInspection> {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(args.worktreePath);
  } catch {
    return { kind: "absent" };
  }
  const foreign = (reason: string): TargetInspection => ({ kind: "foreign", reason });
  if (!st.isDirectory() || st.isSymbolicLink()) {
    return foreign("existing-path-is-not-a-plain-directory");
  }
  if (!args.allowOwned) {
    // No durable operation proof exists: any preexisting content — even a
    // byte-identical foreign worktree — is refused and preserved.
    return foreign("existing-path-occupied-before-provision");
  }
  let real: string;
  try {
    real = realpathSync(args.worktreePath);
  } catch {
    return foreign("existing-path-has-no-stable-physical-identity");
  }
  if (!pathsEqual(real, args.worktreePath)) {
    return foreign("existing-path-is-not-the-exact-canonical-allocation");
  }
  if (!resolvesInsideRoot(args.managedRoot, args.worktreePath)) {
    return foreign("worktree-path-outside-managed-root");
  }
  const read = async (gitArgs: string[]): Promise<string> =>
    (await args.runner.run({ cwd: args.worktreePath, gitArgs, kind: "read" })).stdout;
  const classify = (e: unknown): TargetInspection =>
    e instanceof WorktreeGitRunError
      ? e.definitive
        ? foreign("existing-path-is-not-a-worktree-of-the-source-repository")
        : { kind: "uncertain", reason: e.reason }
      : { kind: "uncertain", reason: "worktree-inspection-failed" };
  try {
    let commonDir: string;
    try {
      commonDir = realpathSync(await read(["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    } catch (e) {
      if (e instanceof WorktreeGitRunError && !e.definitive) return classify(e);
      return foreign("existing-path-belongs-to-another-repository");
    }
    if (!pathsEqual(commonDir, args.sourceCommonDir)) {
      return foreign("existing-path-belongs-to-another-repository");
    }
    // Actual toplevel: the path must be the worktree root itself, not an
    // ancestor or an unrelated subdirectory of one.
    let toplevel: string;
    try {
      toplevel = realpathSync(await read(["rev-parse", "--path-format=absolute", "--show-toplevel"]));
    } catch {
      return foreign("existing-path-is-not-a-linked-worktree-toplevel");
    }
    if (!pathsEqual(toplevel, real)) {
      return foreign("existing-path-is-not-a-linked-worktree-toplevel");
    }
    // The private gitdir must be a broker-managed worktree admin dir INSIDE
    // the source common dir, with a .git file backpointer to THIS path.
    let gitDir: string;
    try {
      gitDir = realpathSync(await read(["rev-parse", "--path-format=absolute", "--git-dir"]));
    } catch {
      return foreign("existing-path-is-not-a-linked-worktree");
    }
    const relative = path.relative(realpathSync(args.sourceCommonDir), gitDir);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return foreign("existing-path-is-not-a-linked-worktree");
    }
    try {
      const dotGit = path.join(args.worktreePath, ".git");
      const stDot = statSync(dotGit);
      if (!stDot.isFile() || stDot.size > 4096) return foreign("existing-path-is-not-a-linked-worktree");
      const back = readFileSync(dotGit, "utf8").trim();
      if (!back.startsWith(FORK_LINK)) return foreign("existing-path-is-not-a-linked-worktree");
      const backGitdir = realpathSync(back.slice(FORK_LINK.length).trim());
      if (!pathsEqual(backGitdir, gitDir)) return foreign("existing-path-is-not-a-linked-worktree");
      // The admin gitdir backpointer names the worktree's .git FILE.
      const backpointer = readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
      if (!pathsEqual(realpathSync(backpointer), realpathSync(dotGit))) {
        return foreign("existing-path-is-not-a-linked-worktree");
      }
    } catch {
      return foreign("existing-path-is-not-a-linked-worktree");
    }
    // Detached: a branch-checked-out worktree (main checkout or a foreign
    // branch) is never adopted, even at the same commit.
    try {
      await args.runner.run({ cwd: args.worktreePath, gitArgs: ["symbolic-ref", "-q", "HEAD"], kind: "read" });
      return foreign("existing-path-is-on-a-branch");
    } catch (e) {
      if (!(e instanceof WorktreeGitRunError) || e.reason !== "git-exit-nonzero") return classify(e);
      // nonzero = no branch ref = detached: the only acceptable shape
    }
    const head = await read(["rev-parse", "HEAD"]);
    if (head !== args.baseCommit) {
      return foreign("existing-path-head-differs-from-base-commit");
    }
    return { kind: "owned" };
  } catch (e) {
    return classify(e);
  }
}

/**
 * Create the detached worktree: `git worktree add --detach <path> <commit>`.
 * No --force, no branch creation, no HEAD/branch guess — the explicit full
 * commit is the only revision argument. Caller holds the repository lock and
 * receives the exact owned launch receipt via `onOwnership` BEFORE the root
 * is resumed.
 */
export async function worktreeAddDetached(args: {
  sourcePath: string;
  worktreePath: string;
  baseCommit: string;
  runner: WorktreeGitRunner;
  onOwnership: OwnershipGate;
}): Promise<WorktreeCompletionReceipt> {
  const result = await args.runner.run({
    cwd: args.sourcePath,
    gitArgs: ["worktree", "add", "--detach", args.worktreePath, args.baseCommit],
    kind: "mutate",
    onOwnership: args.onOwnership,
  });
  if (!result.completion) {
    throw new WorktreeGitRunError("git-completion-receipt-missing", false);
  }
  return result.completion;
}
