/**
 * Bounded Git reads for the Git-native reviewer (git_review_binding).
 *
 * A Git review reads the REGISTERED physical checkout as-is: the reviewer is
 * dispatched into a checkout at the exact target commit and inspects the diff with its
 * own Git tooling. The broker runs only safe bounded READ commands (no locks,
 * no mutations, nothing created) to admit the review and to revalidate the
 * exact-commit contract before dispatch and after completion:
 *   - both binding commits must resolve to commit OBJECTS in the local
 *     repository (`rev-parse --verify <sha>^{commit}`); a moving branch or
 *     other ref shorthand is never accepted — binding fields are full hex;
 *   - HEAD must equal the exact target commit at admission;
 *   - by default the checkout must be clean; dirty review binds a digest of
 *     tracked and nonignored untracked contents.
 *
 * The environment is scrubbed of ambient GIT_* routing (same contract as
 * worktree.ts §12.3) so a hostile environment cannot redirect the reads to
 * another repository. No optional locks are taken.
 */
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import { gitWorkingTreeDigest } from "./gitWorkingTree.ts";

/** Explicit full commit object id: SHA-1 (40) or SHA-256 (64) lowercase hex. */
export const GIT_REVIEW_COMMIT_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** Bounded subprocess budgets: no unbounded output, no hang. */
const GIT_REVIEW_TIMEOUT_MS = 10_000;
const GIT_REVIEW_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export class GitReviewPreflightError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message);
    this.name = "GitReviewPreflightError";
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^GIT_/i.test(key)) continue; // no ambient Git routing survives
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0"; // reads never take locks
  return env;
}

function runGit(cwd: string, args: string[]): { stdout: string } {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "buffer",
    timeout: GIT_REVIEW_TIMEOUT_MS,
    maxBuffer: GIT_REVIEW_MAX_OUTPUT_BYTES,
    windowsHide: true,
    env: gitEnv(),
  });
  if (result.error) {
    throw new GitReviewPreflightError("git could not be executed", "git-unavailable");
  }
  if (result.status !== 0) {
    throw new GitReviewPreflightError(
      `git ${args[0]} failed with status ${result.status}`,
      "git-command-failed",
    );
  }
  return { stdout: result.stdout.toString("utf8").trim() };
}

/**
 * Resolve the physical checkout root a Git review session is bound to.
 * Returns the realpath of the directory, or null when it does not resolve to
 * an existing directory (callers fail closed — never guess a root).
 */
export function resolveGitReviewRoot(checkoutPath: string): string | null {
  if (!checkoutPath || !path.isAbsolute(checkoutPath)) return null;
  try {
    const resolved = realpathSync(checkoutPath);
    return resolved;
  } catch {
    return null;
  }
}

function assertCommitObject(root: string, commit: string, label: string): void {
  if (!GIT_REVIEW_COMMIT_PATTERN.test(commit)) {
    throw new GitReviewPreflightError(
      `${label}_commit must be a full 40- or 64-character lowercase hexadecimal commit id.`,
      "invalid-commit-id",
    );
  }
  let verified: string;
  try {
    verified = runGit(root, ["rev-parse", "--verify", `${commit}^{commit}`]).stdout;
  } catch {
    throw new GitReviewPreflightError(
      `${label}_commit does not resolve to a commit object in the registered repository.`,
      "unknown-commit",
    );
  }
  if (verified !== commit) {
    throw new GitReviewPreflightError(
      `${label}_commit does not resolve to the given commit object in the registered repository.`,
      "unknown-commit",
    );
  }
}

function assertCheckoutRoot(root: string): void {
  const top = realpathSync(runGit(root, ["rev-parse", "--show-toplevel"]).stdout);
  const canonicalRoot = realpathSync(root);
  const same = process.platform === "win32"
    ? top.toLowerCase() === canonicalRoot.toLowerCase()
    : top === canonicalRoot;
  if (!same) {
    throw new GitReviewPreflightError(
      "Git review requires the registered Git checkout root, not a subdirectory inside another checkout.",
      "not-checkout-root",
    );
  }
}

/** True when `status --porcelain` reports no tracked/untracked non-ignored entry. */
export function gitCheckoutClean(root: string): boolean {
  // Git status trusts assume-unchanged/skip-worktree flags and can hide real
  // edits. A clean-commit review refuses those flags; working-tree review
  // fingerprints actual files independently and remains available.
  const indexFlags = runGit(root, ["ls-files", "-v", "-z"]).stdout.split("\0");
  if (indexFlags.some(entry => entry && (entry[0] === "S" || /^[a-z]/.test(entry)))) return false;
  return runGit(root, ["status", "--porcelain", "--ignore-submodules=none"]).stdout.length === 0;
}

/**
 * Full review admission preflight (runs OUTSIDE any transaction, creates
 * nothing, mutates nothing): the checkout must be a real Git repository of
 * the registered workspace, both binding fields must resolve to commit
 * objects and HEAD must equal the exact target commit. By default the
 * checkout must be clean; dirty review returns its durable content digest.
 * No branch/ref shorthand is accepted for either field.
 */
export function preflightGitReview(args: { root: string; baseCommit: string; targetCommit: string; includeWorkingTree?: boolean }): string | null {
  // A failed common-dir read means the path is not a repository at all.
  let commonDir: string;
  try {
    commonDir = runGit(args.root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).stdout;
  } catch (e) {
    if (e instanceof GitReviewPreflightError) {
      throw new GitReviewPreflightError(
        "Registered checkout is not a real Git repository.",
        "checkout-not-a-repository",
      );
    }
    throw e;
  }
  if (!commonDir || !path.isAbsolute(commonDir)) {
    throw new GitReviewPreflightError("Registered checkout is not a real Git repository.", "checkout-not-a-repository");
  }
  assertCheckoutRoot(args.root);
  assertCommitObject(args.root, args.baseCommit, "base");
  assertCommitObject(args.root, args.targetCommit, "target");
  let head: string;
  try {
    head = runGit(args.root, ["rev-parse", "HEAD"]).stdout;
  } catch {
    throw new GitReviewPreflightError(
      "Registered checkout HEAD could not be read (unborn or unreadable).",
      "head-unreadable",
    );
  }
  if (head !== args.targetCommit) {
    throw new GitReviewPreflightError(
      "Registered checkout HEAD does not equal the review target commit; move the checkout to the exact target commit before requesting the review.",
      "head-not-target-commit",
    );
  }
  if (!args.includeWorkingTree && !gitCheckoutClean(args.root)) {
    throw new GitReviewPreflightError(
      "Clean Git review requires no tracked/untracked changes or index flags that hide edits. Use include_working_tree=true to bind uncommitted contents.",
      "checkout-dirty",
    );
  }
  return args.includeWorkingTree ? gitWorkingTreeDigest(args.root) : null;
}

/**
 * Drift revalidation of the exact-commit contract (used pre-dispatch and
 * post-completion): null when HEAD still equals the target commit and the
 * checkout is clean or matches its bound digest; a bounded human-readable
 * reason otherwise.
 * Unreadable state fails closed as drift — a review must never be accepted
 * against a checkout whose contract cannot be re-proved.
 */
export function gitReviewDrift(root: string, targetCommit: string, expectedWorkingTreeDigest: string | null = null): string | null {
  let head: string;
  try {
    assertCheckoutRoot(root);
    head = runGit(root, ["rev-parse", "HEAD"]).stdout;
  } catch {
    return "review checkout HEAD could not be re-read";
  }
  if (head !== targetCommit) {
    return "review checkout HEAD moved off the exact target commit during the review";
  }
  if (expectedWorkingTreeDigest !== null) {
    try {
      if (gitWorkingTreeDigest(root) !== expectedWorkingTreeDigest) {
        return "review working-tree contents or index changed during the review";
      }
    } catch {
      return "review working-tree digest could not be re-verified";
    }
    return null;
  }
  let clean: boolean;
  try {
    clean = gitCheckoutClean(root);
  } catch {
    return "review checkout cleanliness could not be re-verified";
  }
  if (!clean) {
    return "review checkout became dirty during the review (tracked or untracked non-ignored changes)";
  }
  return null;
}
