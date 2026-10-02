import { afterEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../src/daemon/bootstrap.ts";
import { socketPathFor, startDaemonRpc, writeBridgeToken } from "../../src/daemon/rpc.ts";
import { DaemonRpcClient } from "../../src/bridge/rpcClient.ts";
import { insertCoordinator, insertIntent } from "../../src/storage/repo.ts";
import { openRegistryDb } from "../../src/storage/db.ts";
import { ID_PREFIX, newId } from "../../src/shared/ids.ts";
import { extractRuntime } from "../../src/operator/operations.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator runtime RPC", () => {
  it("starts a committed detached runtime that survives CLI exit and ignores later source edits", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-frozen-start-"));
    roots.push(root);
    const repo = path.join(root, "source with spaces");
    mkdirSync(repo);
    cpSync(path.resolve("src"), path.join(repo, "src"), { recursive: true });
    cpSync(path.resolve("package.json"), path.join(repo, "package.json"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8" }).trim();
    git(["init", "-q"]);
    git(["add", "src", "package.json"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Runtime fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1, state_dir: "./state", coordinator_id: "operator",
      limits: { globalUnfinishedTurns: 6, quotaScopeUnfinishedTurns: 2 },
      projects: [], coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: [] }],
      accounts: [], workspaces: [], policy_profiles: [], coverage_profiles: [], routes: [],
    }));
    const cli = (command: string, extra: string[] = []) => JSON.parse(execFileSync(process.execPath,
      ["--experimental-transform-types", path.join(repo, "src/operator/main.ts"), command, "--config", configPath, ...extra],
      { cwd: repo, encoding: "utf8", windowsHide: true, timeout: 35_000, stdio: ["ignore", "pipe", "pipe"] }));
    // Dirty helper/UI changes before start must not enter the exported Git tree.
    writeFileSync(path.join(repo, "src/operator/ui/styles.css"), "DIRTY_UI");
    writeFileSync(path.join(repo, "src/providers/common/windowsJobHelper.ps1"), "DIRTY_HELPER");
    writeFileSync(path.join(repo, "src/operator/untracked-marker.txt"), "UNTRACKED");
    let started = false;
    try {
      const running = cli("start", ["--ref", commit]);
      started = true;
      expect(running.readiness).toBe("READY");
      expect(running.runtime_commit).toBe(commit);
      expect(running.state_dir).toBe(path.join(root, "state"));
      const manifest = JSON.parse(readFileSync(path.join(running.runtime_path, "runtime-manifest.json"), "utf8"));
      expect(manifest.files.some((f: { path: string }) => f.path.endsWith("untracked-marker.txt"))).toBe(false);
      for (const file of ["src/operator/main.ts", "src/operator/ui/styles.css", "src/providers/common/windowsJobHelper.ps1"]) {
        expect(readFileSync(path.join(running.runtime_path, file), "utf8")).toBe(git(["show", `${commit}:${file}`]) + "\n");
      }
      const status = cli("status");
      expect(status.status).toBe("ready");
      expect(status.settings_state).toBe("applied");
      expect(status.applied_config_fingerprint).toBe(status.saved_config_fingerprint);
      expect(status.runtime_commit).toBe(commit);
      expect(status.daemon_pid).toBe(running.daemon_pid);
      const snippet = cli("mcp-config", ["--connect"]).mcpServers["agent-broker"];
      expect(snippet.args[1]).toBe(path.join(running.runtime_path, "src/bridge/main-stdio.ts"));
      const client = new DaemonRpcClient(socketPathFor(snippet.env.AB_STATE_DIR), () => readFileSync(path.join(root, "state/bridge.token"), "utf8").trim());
      try {
        await client.connect("operator");
        const result = await client.call("broker_status") as { daemon_state: string };
        expect(result.daemon_state).toBe("READY");
        expect((await client.call("broker_status") as { limits: Record<string, number> }).limits).toEqual({
          globalUnfinishedTurns: 6,
          quotaScopeUnfinishedTurns: 2,
          openSessionsPerProject: 20,
          hardTurnDeadlineMs: 900_000,
        });
      } finally { client.close(); }
      expect(() => cli("start")).toThrow(/DAEMON_ALREADY_RUNNING/);
      // A stale sidecar must not change the version reported by the running daemon.
      writeFileSync(path.join(root, "state/operator-runtime.json"), JSON.stringify({ runtime_commit: "stale", runtime_path: "stale", manifest_path: "stale", daemon_pid: 1 }));
      expect(cli("status").runtime_commit).toBe(commit);
      const savedConfig = JSON.parse(readFileSync(configPath, "utf8"));
      savedConfig.coordinators[0].display_name = "Saved name changed";
      writeFileSync(configPath, JSON.stringify(savedConfig));
      const changedStatus = cli("status");
      expect(changedStatus.settings_state).toBe("restart_required");
      expect(changedStatus.applied_config_fingerprint).toBe(status.applied_config_fingerprint);
      const stopped = cli("stop");
      expect(stopped.status).toBe("stopped");
      expect(stopped.runtime_commit).toBe(commit);
      expect(stopped.daemon_pid).toBe(running.daemon_pid);
      started = false;
      expect(existsSync(path.join(root, "state/daemon.lock"))).toBe(false);
      expect(cli("status").status).toBe("stopped");
      expect(cli("status").settings_state).toBe("unknown");
    } finally {
      if (started) cli("stop");
    }
  }, 60_000);

  it("exports only the selected Git tree into a unique state-owned runtime", () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "broker-operator-runtime-"));
    roots.push(stateDir);
    const extracted = extractRuntime("HEAD", stateDir, path.join(stateDir, "operator.json"));
    expect(path.isAbsolute(extracted.record.runtime_path)).toBe(true);
    expect(extracted.record.runtime_path.startsWith(path.join(stateDir, "runtimes"))).toBe(true);
    expect(extracted.manifest.files.some(file => file.path === "package.json")).toBe(true);
    const trackedMain = execFileSync("git", ["show", `HEAD:src/operator/main.ts`], {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
    });
    expect(readFileSync(path.join(extracted.record.runtime_path, "src/operator/main.ts"), "utf8")).toBe(trackedMain);
  });

  it("exposes authenticated operator status only to the configured coordinator", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "broker-operator-rpc-"));
    roots.push(stateDir);
    const daemon = await startDaemon({ stateDir, coordinatorId: "operator-coordinator" });
    insertCoordinator(daemon.db, {
      coordinator_id: "operator-coordinator",
      display_name: "Operator",
      allowed_project_ids: [],
      revoked: false,
      config_revision: 1,
    });
    insertCoordinator(daemon.db, {
      coordinator_id: "other-coordinator",
      display_name: "Other",
      allowed_project_ids: [],
      revoked: false,
      config_revision: 1,
    });
    const token = writeBridgeToken(stateDir);
    const rpc = await startDaemonRpc({
      core: daemon.core,
      coordinatorId: "operator-coordinator",
      stateDir,
      token,
      operator: {
        coordinatorId: "operator-coordinator",
        status: () => ({ readiness: daemon.lifecycle.currentState }),
        stop: () => ({ response: { accepted: true }, shutdown: async () => undefined }),
      },
    });
    const client = new DaemonRpcClient(rpc.socketPath, token);
    try {
      await client.connect("operator-coordinator");
      await expect(client.request("operator/status")).resolves.toEqual({ readiness: "READY" });
      const other = new DaemonRpcClient(rpc.socketPath, token);
      try {
        await other.connect("other-coordinator");
        await expect(other.request("operator/status")).rejects.toThrow(/UNAUTHORIZED/);
      } finally {
        other.close();
      }
      daemon.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = ?").run("operator-coordinator");
      await expect(client.request("operator/status")).rejects.toThrow(/UNAUTHORIZED/);
      await expect(client.request("operator/stop")).rejects.toThrow(/UNAUTHORIZED/);
    } finally {
      client.close();
      await rpc.stop();
      await daemon.stop();
      daemon.db.close();
    }
  });

  it("reports READY through a fresh process and performs an idle graceful stop", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-operator-process-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      state_dir: stateDir,
      coordinator_id: "operator-coordinator",
      projects: [],
      coordinators: [{
        coordinator_id: "operator-coordinator",
        display_name: "Operator",
        allowed_project_ids: [],
      }],
      accounts: [],
      workspaces: [],
      policy_profiles: [],
      coverage_profiles: [],
      routes: [],
    }), "utf8");

    const entrypoint = path.resolve("src/operator/main.ts");
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      entrypoint,
      "daemon",
      "--config",
      configPath,
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    const readyDeadline = Date.now() + 10_000;
    try {
      while (!stderr.includes("daemon listening")) {
        if (child.exitCode !== null) throw new Error(`daemon exited early: ${stderr}`);
        if (Date.now() > readyDeadline) throw new Error(`daemon did not start: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }

      const status = JSON.parse(execFileSync(process.execPath, [
        "--experimental-transform-types",
        entrypoint,
        "status",
        "--config",
        configPath,
      ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true }));
      expect(status.status).toBe("ready");
      expect(status.readiness).toBe("READY");
      expect(status.active_turns).toEqual([]);
      expect(status.pending_intents).toEqual([]);

      expect(() => execFileSync(process.execPath, [
        "--experimental-transform-types",
        entrypoint,
        "start",
        "--config",
        configPath,
      ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, stdio: "pipe" })).toThrow(/DAEMON_ALREADY_RUNNING/);

      const injectedDb = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      insertIntent(injectedDb, {
        intent_id: newId(ID_PREFIX.intent),
        kind: "input_publication",
        session_id: null,
        turn_id: null,
        state: "pending",
        payload: "{}",
        created_at: Date.now(),
        updated_at: Date.now(),
      });
      injectedDb.close();
      expect(() => execFileSync(process.execPath, [
        "--experimental-transform-types",
        entrypoint,
        "stop",
        "--config",
        configPath,
      ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true, stdio: "pipe" })).toThrow(/RESOURCE_BUSY/);
      expect(child.exitCode).toBeNull();
      expect(existsSync(path.join(stateDir, "daemon.lock"))).toBe(true);
      const clearDb = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      clearDb.raw.prepare("DELETE FROM intents WHERE kind = ?").run("input_publication");
      clearDb.close();

      const stopped = JSON.parse(execFileSync(process.execPath, [
        "--experimental-transform-types",
        entrypoint,
        "stop",
        "--config",
        configPath,
      ], { cwd: process.cwd(), encoding: "utf8", windowsHide: true }));
      expect(stopped.status).toBe("stopped");
      await new Promise<void>(resolve => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      });
      expect(existsSync(path.join(stateDir, "daemon.lock"))).toBe(false);
    } finally {
      if (child.exitCode === null) child.kill();
    }
  }, 20_000);
});
