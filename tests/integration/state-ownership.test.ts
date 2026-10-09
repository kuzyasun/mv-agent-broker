import {describe, expect, it} from "vitest";
import {spawn, type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {acquireStateDirectoryOwnership, isStateDirectoryOwned} from "../../src/daemon/lifecycle.ts";

const moduleUrl = pathToFileURL(path.resolve("src/daemon/lifecycle.ts")).href;
async function contender(directory: string, children: ChildProcess[]): Promise<{child: ChildProcess; owned: boolean}> {
  const script = `import {acquireStateDirectoryOwnership} from ${JSON.stringify(moduleUrl)};
    try {
      const ownership = await acquireStateDirectoryOwnership(${JSON.stringify(directory)});
      process.on("message", () => ownership.release());
      setInterval(() => {}, 1000);
      process.send({owned:true});
    } catch (e) {
      process.send({owned:false, code:e.code}, () => process.disconnect());
    }`;
  const child = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", script], {
    stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true,
  });
  children.push(child);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [result] = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {throw new Error("Lock contender exited before reporting");}),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lock contender timed out")), 10000); }),
    ]);
    if (!result.owned) expect(result.code).toBe("DAEMON_ALREADY_RUNNING");
    return {child, owned: result.owned};
  } catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
}

async function killOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

describe("state directory OS ownership", () => {
  it("two concurrent processes have exactly one owner, and its crash releases the lock", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ab-os-owner-"));
    const children: ChildProcess[] = [];
    try {
      const contenders = await Promise.all([contender(directory, children), contender(directory, children)]);
      expect(contenders.filter(c => c.owned)).toHaveLength(1);
      expect(isStateDirectoryOwned(directory)).toBe(true);
      expect(isStateDirectoryOwned(directory)).toBe(true); // A probe never releases the owner's lock.
      await expect(acquireStateDirectoryOwnership(directory)).rejects.toMatchObject({code: "DAEMON_ALREADY_RUNNING"});
      await killOwned(contenders.find(c => c.owned)!.child);
      expect(existsSync(path.join(directory, "daemon-ownership.sqlite"))).toBe(true);
      expect(isStateDirectoryOwned(directory)).toBe(false);
      const recovered = await acquireStateDirectoryOwnership(directory);
      try { expect(isStateDirectoryOwned(directory)).toBe(true); }
      finally { await recovered.release(); }
      await recovered.release();
      expect(isStateDirectoryOwned(directory)).toBe(false);
    } finally {
      await Promise.all(children.map(killOwned));
      rmSync(directory, {recursive: true, force: true});
    }
  }, 15000);

  it("a leftover plain lock file does not prevent acquiring ownership", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ab-orphan-file-"));
    writeFileSync(path.join(directory, "daemon.lock"), "");
    try {
      const owner = await acquireStateDirectoryOwnership(directory);
      try { expect(isStateDirectoryOwned(directory)).toBe(true); }
      finally { await owner.release(); }
      expect(isStateDirectoryOwned(directory)).toBe(false);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });
});
