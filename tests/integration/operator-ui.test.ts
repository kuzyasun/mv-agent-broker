import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator UI CLI", () => {
  it("starts on the requested loopback port and closes on SIGINT", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-cli-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      state_dir: path.join(root, "state"),
      coordinator_id: "coord-main",
      projects: [{ project_id: "project-main", display_name: "Main" }],
      coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] }],
      accounts: [{ account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
      workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: root }],
      policy_profiles: [{ policy_profile_id: "pol-main", config: { access: "read_only" } }],
      coverage_profiles: [],
      routes: [{ route_id: "route-main", project_id: "project-main", provider: "mock", account_profile_id: "acct-mock", model: "mock-model", role: "worker", policy_profile_id: "pol-main" }],
    }));
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      path.resolve("src/operator/main.ts"),
      "ui",
      "--config",
      configPath,
      "--port",
      "0",
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    const lines = createInterface({ input: child.stderr });
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UI did not announce a URL")), 10_000);
      lines.on("line", line => {
        const match = /agent-broker ui listening (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]!);
        }
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`UI exited before announcing URL (${code})`)));
    });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Agent Broker Operator");
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    child.kill("SIGINT");
    await expect(exited).resolves.toBe(process.platform === "win32" ? null : 0);
    lines.close();
  }, 20_000);
});
