import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../src/daemon/bootstrap.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("operator owned startup", () => {
  it("releases ownership after rejected registry configuration so startup can retry", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "broker-startup-")); roots.push(stateDir);
    await expect(startDaemon({ stateDir, coordinatorId: "coord", configureRegistry: () => { throw new Error("invalid registry config"); } }))
      .rejects.toThrow("invalid registry config");
    expect(existsSync(path.join(stateDir, "daemon.lock"))).toBe(false);
    const daemon = await startDaemon({ stateDir, coordinatorId: "coord" });
    try {
      expect(existsSync(path.join(stateDir, "inputs"))).toBe(true);
      expect(existsSync(path.join(stateDir, "slots"))).toBe(true);
    } finally { await daemon.stop(); daemon.db.close(); }
  });

  it("rejects a linked state ancestor before creating a database or base directories", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-startup-link-")); roots.push(root);
    const target = path.join(root, "target"), link = path.join(root, "link"); mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    await expect(startDaemon({ stateDir: path.join(link, "new-state"), coordinatorId: "coord" })).rejects.toThrow(/Unsafe daemon directory ancestor/);
    expect(existsSync(path.join(target, "new-state"))).toBe(false);
  });
});
