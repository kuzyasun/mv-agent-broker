import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitWorkingTreeDigest } from "../../src/workspaces/gitWorkingTree.ts";
import { BrokerError } from "../../src/shared/errors.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "broker-git-dirty-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  git("init"); git("config", "user.name", "Broker Test"); git("config", "user.email", "broker@example.invalid");
  writeFileSync(path.join(root, "code.txt"), "base\n");
  writeFileSync(path.join(root, ".gitignore"), "cache/\n*.log\n");
  git("add", "."); git("commit", "-m", "fixture");
  return { root, git, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function submoduleFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "broker-git-submodule-"));
  const child = path.join(root, "submodule-source");
  const parent = path.join(root, "parent");
  mkdirSync(child); mkdirSync(parent);
  const gitAt = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const configure = (cwd: string) => {
    gitAt(cwd, "init");
    gitAt(cwd, "config", "user.name", "Broker Test");
    gitAt(cwd, "config", "user.email", "broker@example.invalid");
  };
  configure(child);
  writeFileSync(path.join(child, ".gitignore"), "child-cache/\n");
  writeFileSync(path.join(child, "code.txt"), "submodule v1\n");
  gitAt(child, "add", "."); gitAt(child, "commit", "-m", "submodule v1");

  configure(parent);
  writeFileSync(path.join(parent, "parent.txt"), "parent\n");
  gitAt(parent, "add", "."); gitAt(parent, "commit", "-m", "parent base");
  gitAt(parent, "-c", "protocol.file.allow=always", "submodule", "add", child, "deps/noise");
  gitAt(parent, "commit", "-m", "add noise submodule");
  const childCheckout = path.join(parent, "deps", "noise");
  return {
    root, parent, child: childCheckout,
    gitChild: (...args: string[]) => gitAt(childCheckout, ...args),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("Git working-tree review identity", () => {
  it("detects edits whose Git status stays the same, without writing the index", () => {
    const f = fixture();
    try {
      writeFileSync(path.join(f.root, "code.txt"), "edit one\n");
      const status = f.git("status", "--porcelain=v1").toString();
      const index = readFileSync(path.join(f.root, ".git", "index"));
      const first = gitWorkingTreeDigest(f.root);
      expect(gitWorkingTreeDigest(f.root)).toBe(first);
      writeFileSync(path.join(f.root, "code.txt"), "edit two\n");
      expect(f.git("status", "--porcelain=v1").toString()).toBe(status);
      expect(gitWorkingTreeDigest(f.root)).not.toBe(first);
      expect(readFileSync(path.join(f.root, ".git", "index"))).toEqual(index);
    } finally { f.cleanup(); }
  });

  it("includes untracked binary contents and removals, while ignoring cache files", () => {
    const f = fixture();
    try {
      const clean = gitWorkingTreeDigest(f.root);
      writeFileSync(path.join(f.root, "run.log"), "local cache");
      expect(gitWorkingTreeDigest(f.root)).toBe(clean);
      const png = path.join(f.root, "screenshot.png");
      writeFileSync(png, Buffer.from([137, 80, 78, 71, 0, 1]));
      const added = gitWorkingTreeDigest(f.root);
      expect(added).not.toBe(clean);
      writeFileSync(png, Buffer.from([137, 80, 78, 71, 0, 2]));
      expect(gitWorkingTreeDigest(f.root)).not.toBe(added);
      rmSync(png); expect(gitWorkingTreeDigest(f.root)).toBe(clean);
      rmSync(path.join(f.root, "code.txt")); expect(gitWorkingTreeDigest(f.root)).not.toBe(clean);
    } finally { f.cleanup(); }
  });

  it("detects index changes even when working files return to their original bytes", () => {
    const f = fixture();
    try {
      const initial = gitWorkingTreeDigest(f.root);
      writeFileSync(path.join(f.root, "code.txt"), "staged\n"); f.git("add", "code.txt");
      writeFileSync(path.join(f.root, "code.txt"), "base\n");
      expect(gitWorkingTreeDigest(f.root)).not.toBe(initial);
      expect(readFileSync(path.join(f.root, "code.txt"), "utf8")).toBe("base\n");
    } finally { f.cleanup(); }
  });

  it("detects tracked edits hidden from Git status by assume-unchanged", () => {
    const f = fixture();
    try {
      f.git("update-index", "--assume-unchanged", "code.txt");
      const baseline = gitWorkingTreeDigest(f.root);
      writeFileSync(path.join(f.root, "code.txt"), "hidden edit\n");
      expect(f.git("status", "--porcelain=v1").toString()).toBe("");
      expect(gitWorkingTreeDigest(f.root)).not.toBe(baseline);
    } finally { f.cleanup(); }
  });

  it("fingerprints a clean initialized gitlink submodule, notices a new child HEAD, and rejects dirty child contents", () => {
    const f = submoduleFixture();
    try {
      const baseline = gitWorkingTreeDigest(f.parent);
      mkdirSync(path.join(f.parent, "deps", "noise", "child-cache"), { recursive: true });
      writeFileSync(path.join(f.parent, "deps", "noise", "child-cache", "ignored.bin"), Buffer.from([1, 2, 3]));
      expect(gitWorkingTreeDigest(f.parent)).toBe(baseline);

      writeFileSync(path.join(f.child, "code.txt"), "submodule v2\n");
      f.gitChild("add", "code.txt"); f.gitChild("commit", "-m", "submodule v2");
      const updatedHeadDigest = gitWorkingTreeDigest(f.parent);
      expect(updatedHeadDigest).not.toBe(baseline);

      f.gitChild("update-index", "--assume-unchanged", "code.txt");
      expect(() => gitWorkingTreeDigest(f.parent)).toThrow(/assume-unchanged or skip-worktree/);
      f.gitChild("update-index", "--no-assume-unchanged", "code.txt");
      f.gitChild("update-index", "--skip-worktree", "code.txt");
      expect(() => gitWorkingTreeDigest(f.parent)).toThrow(/assume-unchanged or skip-worktree/);
      f.gitChild("update-index", "--no-skip-worktree", "code.txt");
      expect(gitWorkingTreeDigest(f.parent)).toBe(updatedHeadDigest);

      writeFileSync(path.join(f.child, "code.txt"), "uncommitted child edit\n");
      try {
        gitWorkingTreeDigest(f.parent);
        throw new Error("expected dirty submodule contents to be unsupported");
      } catch (error) {
        expect(error).toBeInstanceOf(BrokerError);
        expect((error as BrokerError).code).toBe("INPUT_UNSUPPORTED");
      }
    } finally { f.cleanup(); }
  });
});
