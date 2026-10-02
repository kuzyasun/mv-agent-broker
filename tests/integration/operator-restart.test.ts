import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { startOperatorUi } from "../../src/operator/ui.ts";
import { DaemonRpcClient } from "../../src/bridge/rpcClient.ts";
import { readBridgeToken, socketPathFor } from "../../src/daemon/rpc.ts";
import { openRegistryDb } from "../../src/storage/db.ts";
import { getSession, insertIntent } from "../../src/storage/repo.ts";

describe("operator UI accepted-runtime restart", () => {
  it("restarts from a frozen UI without Git, applies saved settings, refuses busy/stale requests and joins double clicks", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-ui-restart-"));
    const repo = path.join(root, "source with spaces");
    mkdirSync(repo);
    cpSync(path.resolve("src"), path.join(repo, "src"), { recursive: true });
    cpSync(path.resolve("package.json"), path.join(repo, "package.json"));
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, windowsHide: true, encoding: "utf8", stdio: "pipe" }).trim();
    git(["init", "-q"]); git(["add", "src", "package.json"]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Frozen restart fixture"]);
    const commit = git(["rev-parse", "HEAD"]);
    const configPath = path.join(root, "operator.json"), stateDir = path.join(root, "state");
    const workspace = path.join(root, "workspace");
    mkdirSync(path.join(workspace, "src"), { recursive: true });
    writeFileSync(path.join(workspace, "src/main.txt"), "source");
    const config = { version: 1, state_dir: stateDir, coordinator_id: "operator",
      projects: [{ project_id: "p", display_name: "Mock project" }],
      coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: ["p"] }],
      accounts: [{ account_profile_id: "mock-account", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
      workspaces: [{ workspace_id: "ws", project_id: "p", mode: "current", canonical_path: workspace, coverage_profile_id: "source" }],
      policy_profiles: [{ policy_profile_id: "read-only", config: { access: "read_only" } }],
      coverage_profiles: [{ coverage_profile_id: "source", config: { source_prefixes: ["src"], non_source_prefixes: [], excluded_prefixes: [] } }],
      routes: [{ route_id: "mock-worker", project_id: "p", provider: "mock", account_profile_id: "mock-account", model: "mock-model-1", role: "worker", policy_profile_id: "read-only" }] };
    writeFileSync(configPath, JSON.stringify(config));
    const cli = (command: string) => JSON.parse(execFileSync(process.execPath, ["--experimental-transform-types", path.join(repo, "src/operator/main.ts"), command, "--config", configPath],
      { cwd: repo, windowsHide: true, encoding: "utf8", stdio: "pipe", timeout: 35000 }));
    let ui: Awaited<ReturnType<typeof startOperatorUi>> | undefined;
    let started = false;
    try {
      const running = cli("start"); started = true;
      const frozen = await import(pathToFileURL(path.join(running.runtime_path, "src/operator/ui.ts")).href);
      expect(existsSync(path.join(running.runtime_path, ".git"))).toBe(false);
      ui = await frozen.startOperatorUi({ configPath, port: 0 });
      const service = ui!;
      const api = (url: string, method = "GET", body?: unknown, token = service.token) => fetch(service.url + url,
        { method, headers: { "x-operator-token": token, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const initial = await (await api("/api/config")).json() as { revision: string };
      expect((await api("/api/restart", "POST", { revision: initial.revision }, "bad-token")).status).toBe(401);
      expect((await api("/api/restart", "POST", { revision: "stale" })).status).toBe(409);
      expect((await api("/api/restart", "POST", { revision: initial.revision, config })).status).toBe(400);
      expect((await (await api("/api/status")).json() as { daemon_pid: number }).daemon_pid).toBe(running.daemon_pid);

      const client = new DaemonRpcClient(socketPathFor(stateDir), () => readBridgeToken(stateDir));
      let sessionId: string;
      try {
        await client.connect("operator");
        const session = await client.call("agent_session_spawn", { project_id: "p", route_id: "mock-worker", idempotency_key: "old-session", instructions: "No inference", workspace: { mode: "current", workspace_id: "ws" } }) as { session_id: string };
        sessionId = session.session_id;
      } finally { client.close(); }

      const db = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      try {
        insertIntent(db, { intent_id: "pending-test", kind: "input_publication", session_id: null, turn_id: null, state: "pending", payload: "{}", created_at: Date.now(), updated_at: Date.now() });
        const busy = await api("/api/restart", "POST", { revision: initial.revision });
        expect(busy.status).toBe(409);
        expect(await busy.text()).toContain("RESOURCE_BUSY");
        expect(cli("status").daemon_pid).toBe(running.daemon_pid);
        db.raw.prepare("DELETE FROM intents WHERE intent_id='pending-test'").run();
      } finally { db.close(); }

      const recordPath = path.join(stateDir, "operator-runtime.json"), recordBytes = readFileSync(recordPath);
      writeFileSync(recordPath, JSON.stringify({ ...JSON.parse(recordBytes.toString()), daemon_pid: 1 }));
      expect(await (await api("/api/restart", "POST", { revision: initial.revision })).text()).toContain("RUNTIME_IDENTITY_MISMATCH");
      expect(cli("status").daemon_pid).toBe(running.daemon_pid);
      writeFileSync(recordPath, recordBytes);

      config.routes[0]!.model = "mock-model-2";
      const saved = await api("/api/config", "PUT", { revision: initial.revision, config });
      expect(saved.status).toBe(200);
      const savedBody = await saved.json() as { revision: string };
      expect(cli("status").settings_state).toBe("restart_required");
      const savedBytes = readFileSync(configPath);
      const results = await Promise.all([api("/api/restart", "POST", { revision: savedBody.revision }), api("/api/restart", "POST", { revision: savedBody.revision })]);
      for (const result of results) expect(result.status).toBe(200);
      const first = await results[0]!.json() as Record<string, unknown>, second = await results[1]!.json() as Record<string, unknown>;
      expect(first.daemon_pid).not.toBe(running.daemon_pid);
      expect(second.daemon_pid).toBe(first.daemon_pid);
      expect(first.runtime_path).toBe(running.runtime_path);
      expect(first.runtime_commit).toBe(commit);
      expect(first.applied_config_fingerprint).toBe(first.saved_config_fingerprint);
      expect(readFileSync(configPath).equals(savedBytes)).toBe(true);
      expect(cli("status").settings_state).toBe("applied");
      const checkDb = openRegistryDb(path.join(stateDir, "registry.sqlite"));
      try { expect(getSession(checkDb, sessionId!)?.requested_model).toBe("mock-model-1"); } finally { checkDb.close(); }
    } finally {
      await ui?.close();
      if (started) cli("stop");
      rmSync(root, { recursive: true, force: true });
    }
  }, 60000);
});
