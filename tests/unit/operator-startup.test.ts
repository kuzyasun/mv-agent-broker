import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../src/daemon/bootstrap.ts";
import { applyOperatorConfig, type OperatorConfig } from "../../src/operator/config.ts";
import { getWorkspace } from "../../src/storage/repo.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("operator owned startup", () => {
  it("uses active registrations after a configuration replacement while retaining historical rows", async () => {
    const stateDir = mkdtempSync(path.join(os.tmpdir(), "broker-startup-registration-")); roots.push(stateDir);
    const current: OperatorConfig = {
      state_dir: stateDir, coordinator_id: "coord",
      projects: [{ project_id: "project", display_name: "Project" }],
      coordinators: [{ coordinator_id: "coord", display_name: "Coordinator", allowed_project_ids: ["project"] }],
      accounts: [{ account_profile_id: "account", provider: "mock", quota_scope_id: "quota", auth_mode: "cli-owned" }],
      workspaces: [{ workspace_id: "active-root", project_id: "project", mode: "current", canonical_path: stateDir, coverage_profile_id: "root-coverage" }],
      coverage_profiles: [{ coverage_profile_id: "root-coverage", config: { source_prefixes: ["."], non_source_prefixes: [], excluded_prefixes: [".git"] } }],
      policy_profiles: [{ policy_profile_id: "worker", config: { access: "workspace_write" } }],
      routes: [{ route_id: "worker-route", project_id: "project", provider: "mock", account_profile_id: "account", model: "mock-model-1", role: "worker", policy_profile_id: "worker" }],
    };
    const before: OperatorConfig = {
      ...current,
      workspaces: [{ ...current.workspaces[0]!, workspace_id: "historical-root" }, ...current.workspaces],
    };
    const daemon = await startDaemon({
      stateDir, coordinatorId: current.coordinator_id,
      routes: new Map(current.routes.map(route => [route.route_id, route])),
      configuredWorkspaceIds: new Set(current.workspaces.map(workspace => workspace.workspace_id)),
      configureRegistry: db => { applyOperatorConfig(db, before); applyOperatorConfig(db, current); },
    });
    try {
      const discovered = daemon.core.discovery("coord", "project", undefined, 100).entries;
      expect(discovered.filter(entry => entry.kind === "workspace").map(entry => entry.id)).toEqual(["active-root"]);
      expect(discovered.find(entry => entry.kind === "route")).toMatchObject({ compatible_workspace_ids: ["active-root"] });
      expect(getWorkspace(daemon.db, "historical-root")).not.toBeNull();
      expect(() => daemon.core.spawn("coord", {
        project_id: "project", route_id: "worker-route", idempotency_key: "stale-workspace",
        instructions: "Do not execute.", workspace: { mode: "current", workspace_id: "historical-root" },
      })).toThrow();
      expect(daemon.db.raw.prepare("SELECT COUNT(*) count FROM sessions").get()).toMatchObject({ count: 0 });
    } finally { await daemon.stop(); daemon.db.close(); }
  });

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
