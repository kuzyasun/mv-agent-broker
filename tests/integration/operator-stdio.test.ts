import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator stdio", () => {
  it("emits a client startup snippet and refuses connect without an accepted daemon", () => {
    const args = ["--experimental-transform-types", path.resolve("src/operator/main.ts"), "mcp-config", "--config", path.resolve("docs/examples/operator.mock.json")];
    const run = (connect: boolean) => JSON.parse(execFileSync(process.execPath, [...args, ...(connect ? ["--connect"] : [])], { encoding: "utf8", windowsHide: true }).toString()).mcpServers["agent-broker"];
    const startup = run(false);
    expect(startup.args).toContain("stdio");
    expect(() => run(true)).toThrow(/Start the shared daemon/);
  });

  it("discovers and spawns a named mock route through a fresh daemon", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-operator-stdio-"));
    roots.push(root);
    const stateRoot = mkdtempSync(path.join(os.tmpdir(), "broker-operator-state-"));
    roots.push(stateRoot);
    mkdirSync(path.join(root, "src"));
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      state_dir: stateRoot,
      coordinator_id: "coord-main",
      projects: [{ project_id: "project-main", display_name: "Main" }],
      coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] }],
      accounts: [{ account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
      workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: root, coverage_profile_id: "cov-main" }],
      policy_profiles: [{ policy_profile_id: "pol-main", version: "1", config: { access: "workspace_write", write_scope: ["src"] } }],
      coverage_profiles: [{
        coverage_profile_id: "cov-main",
        version: "1",
        config: { source_prefixes: ["src"], non_source_prefixes: [], excluded_prefixes: [".git"] },
      }],
      routes: [{
        route_id: "route-mock",
        project_id: "project-main",
        provider: "mock",
        account_profile_id: "acct-mock",
        model: "mock-model-1",
        role: "worker",
        policy_profile_id: "pol-main",
      }],
    }), "utf8");

    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      path.resolve("src/operator/main.ts"),
      "stdio",
      "--config",
      configPath,
    ], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    const rl = createInterface({ input: child.stdout });
    const responses = new Map<number, (value: any) => void>();
    rl.on("line", line => {
      const response = JSON.parse(line) as { id: number };
      responses.get(response.id)?.(response);
      responses.delete(response.id);
    });
    const call = (id: number, method: string, params?: unknown): Promise<any> => new Promise(resolve => {
      responses.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
    try {
      expect((await call(1, "initialize")).result.serverInfo.name).toBe("agent-broker");
      const tools = await call(2, "tools/list");
      expect(tools.result.tools.some((tool: { name: string }) => tool.name === "agents_list")).toBe(true);
      const discovery = await call(3, "tools/call", { name: "agents_list", arguments: { project_id: "project-main" } });
      const discoveryBody = JSON.parse(discovery.result.content[0].text);
      expect(discoveryBody.entries.some((entry: { kind: string; id: string }) => entry.kind === "route" && entry.id === "route-mock")).toBe(true);
      const spawned = await call(4, "tools/call", {
        name: "agent_session_spawn",
        arguments: {
          project_id: "project-main",
          idempotency_key: "spawn-route",
          route_id: "route-mock",
          instructions: "Use the named route.",
          workspace: { mode: "current", workspace_id: "ws-main" },
        },
      });
      const spawnBody = JSON.parse(spawned.result.content[0].text);
      expect(spawnBody.session_id).toBeTruthy();
      expect(spawnBody.initial_snapshot_id).toBeTruthy();
      const sent = await call(5, "tools/call", {
        name: "agent_session_send",
        arguments: {
          session_id: spawnBody.session_id,
          idempotency_key: "turn-route",
          task: { goal: "Return a deterministic mock result.", artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: spawnBody.initial_snapshot_id },
        },
      });
      const sendBody = JSON.parse(sent.result.content[0].text);
      expect(sendBody.turn_id).toBeTruthy();
      let finalState: string | undefined;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const status = await call(100 + attempt, "tools/call", {
          name: "agent_turn_status",
          arguments: { turn_id: sendBody.turn_id },
        });
        const body = JSON.parse(status.result.content[0].text);
        finalState = body.state;
        if (["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT", "ABANDONED"].includes(body.state)) {
          if (body.state !== "SUCCEEDED") throw new Error(`mock turn failed: ${JSON.stringify(body)}`);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(finalState).toBe("SUCCEEDED");
    } finally {
      await new Promise<void>(resolve => {
        child.once("exit", () => resolve());
        child.kill();
      });
      rl.close();
    }
  }, 20_000);
});
