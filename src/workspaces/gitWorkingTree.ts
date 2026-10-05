/** Local fingerprint for a Git review of uncommitted work. No source copies. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readlinkSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { BrokerError } from "../shared/errors.ts";

function git(root: string, args: string[]): Buffer {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !/^GIT_/i.test(key)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  try {
    return execFileSync("git", ["-c", "core.fsmonitor=false", "--no-pager", "--no-optional-locks", "-C", root, ...args], {
      windowsHide: true, timeout: 15_000, maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch {
    throw new BrokerError("WORKSPACE_CHANGED", "Cannot identify the Git working tree for review.", { executionStarted: false });
  }
}

/** Covers HEAD, index metadata, tracked edits/deletions and nonignored new files. */
export function gitWorkingTreeDigest(root: string): string {
  root = realpathSync(root);
  const digest = createHash("sha256");
  const add = (value: string | Buffer) => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    digest.update(String(bytes.length)).update(":").update(bytes);
  };
  add(git(root, ["rev-parse", "--verify", "HEAD"]));
  add(git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]));
  const indexEntries = git(root, ["ls-files", "--stage", "-z"]);
  add(indexEntries);
  const gitlinks = new Set<string>();
  for (const entry of indexEntries.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) [0-9a-f]+ [0-3]\t([\s\S]*)$/.exec(entry);
    if (match?.[1] === "160000") gitlinks.add(match[2]!);
  }

  // Read tracked contents independently of status/diff: assume-unchanged and
  // skip-worktree flags can hide real edits from those commands. HEAD names
  // also cover a file removed from the index but still present on disk.
  const names = [
    git(root, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
    git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]),
  ];
  const paths = [...new Set(names.flatMap(bytes => bytes.toString("utf8").split("\0").filter(Boolean)))].sort();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (const name of paths) {
    const file = path.resolve(root, name);
    const relative = path.relative(root, file);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new BrokerError("WORKSPACE_CHANGED", "Git review path is outside the checkout.", { executionStarted: false });
    }
    add(name);
    if (gitlinks.has(name)) {
      addSubmoduleDigest(root, name, add);
      continue;
    }
    const stat = lstatSync(file, { throwIfNoEntry: false });
    if (!stat) { add("deleted"); continue; }
    add(String(stat.mode));
    if (stat.isSymbolicLink()) { add("symlink"); add(readlinkSync(file)); continue; }
    if (!stat.isFile()) {
      throw new BrokerError("INPUT_UNSUPPORTED", `Working-tree review cannot fingerprint ${name}; use a committed target for submodules or special files.`, { executionStarted: false });
    }
    const physicalRelative = path.relative(root, realpathSync(file));
    if (path.isAbsolute(physicalRelative) || physicalRelative === ".." || physicalRelative.startsWith(`..${path.sep}`)) {
      throw new BrokerError("WORKSPACE_CHANGED", `Git review file resolves outside the checkout: ${name}.`, { executionStarted: false });
    }
    const content = createHash("sha256");
    const fd = openSync(file, "r");
    try {
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) content.update(buffer.subarray(0, count));
    } finally { closeSync(fd); }
    add("file"); add(content.digest("hex"));
  }
  return digest.digest("hex");
}

function addSubmoduleDigest(root: string, name: string, add: (value: string | Buffer) => void): void {
  const file = path.resolve(root, name);
  const stat = lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new BrokerError("INPUT_UNSUPPORTED", `Git submodule ${name} is not initialized; initialize it before requesting review.`, { executionStarted: false });
  }
  const childRoot = realpathSync(file);
  const relative = path.relative(root, childRoot);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`) || relative === "") {
    throw new BrokerError("WORKSPACE_CHANGED", `Git submodule ${name} resolves outside the checkout or to its root.`, { executionStarted: false });
  }

  let topLevel: string;
  try {
    topLevel = realpathSync(git(childRoot, ["rev-parse", "--show-toplevel"]).toString("utf8").trim());
  } catch {
    throw new BrokerError("INPUT_UNSUPPORTED", `Git submodule ${name} is not an initialized standalone checkout.`, { executionStarted: false });
  }
  if (path.relative(childRoot, topLevel) !== "" || path.relative(topLevel, childRoot) !== "") {
    throw new BrokerError("INPUT_UNSUPPORTED", `Git submodule ${name} does not resolve to its own repository root.`, { executionStarted: false });
  }

  const flags = git(childRoot, ["ls-files", "-v", "-z"]);
  for (const record of flags.toString("utf8").split("\0").filter(Boolean)) {
    const tag = record[0];
    if (tag === tag?.toLowerCase() || tag === "S") {
      throw new BrokerError("INPUT_UNSUPPORTED", `Git submodule ${name} contains assume-unchanged or skip-worktree entries.`, { executionStarted: false });
    }
  }
  const status = git(childRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
  if (status.length > 0) {
    throw new BrokerError("INPUT_UNSUPPORTED", `Git submodule ${name} has uncommitted or untracked nonignored contents; review its committed target separately.`, { executionStarted: false });
  }

  add("submodule");
  add(git(childRoot, ["rev-parse", "--verify", "HEAD"]));
  add(git(childRoot, ["ls-files", "--stage", "-z"]));
  add(flags);
  add(status);
}
