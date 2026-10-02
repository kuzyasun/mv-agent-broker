import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../src/daemon/bootstrap.ts";
import { startDaemonRpc } from "../../src/daemon/rpc.ts";
import {
  loadOperatorConfig,
  operatorConfigFingerprint,
} from "../../src/operator/config.ts";
import { statusOperator } from "../../src/operator/operations.ts";
import { insertCoordinator } from "../../src/storage/repo.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(stateDir: string, model = "mock-model") {
  return {
    version: 1,
    state_dir: stateDir,
    coordinator_id: "operator",
    projects: [{ project_id: "project-main", display_name: "Main" }],
    coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: ["project-main"] }],
    accounts: [{ account_profile_id: "account-main", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
    workspaces: [{ workspace_id: "workspace-main", project_id: "project-main", mode: "current", canonical_path: null }],
    policy_profiles: [{ policy_profile_id: "policy-main", config: { access: "read_only" } }],
    coverage_profiles: [],
    routes: [{
      route_id: "route-main",
      project_id: "project-main",
      provider: "mock",
      account_profile_id: "account-main",
      model,
      role: "worker",
      policy_profile_id: "policy-main",
    }],
  };
}

describe("saved versus applied operator settings", () => {
  it("reports applied, restart-required, and unknown only from live RPC", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-settings-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config(stateDir)));
    const loaded = loadOperatorConfig(configPath);
    const appliedFingerprint = operatorConfigFingerprint(loaded);
    const daemon = await startDaemon({ stateDir, coordinatorId: "operator" });
    insertCoordinator(daemon.db, {
      coordinator_id: "operator",
      display_name: "Operator",
      allowed_project_ids: ["project-main"],
      revoked: false,
      config_revision: 1,
    });
    const rpc = await startDaemonRpc({
      core: daemon.core,
      stateDir,
      coordinatorId: "operator",
      operator: {
        coordinatorId: "operator",
        status: () => ({ readiness: "READY", applied_config_fingerprint: appliedFingerprint }),
        stop: () => ({ response: { accepted: true }, shutdown: async () => undefined }),
      },
    });
    try {
      await expect(statusOperator(loaded)).resolves.toMatchObject({
        settings_state: "applied",
        applied_config_fingerprint: appliedFingerprint,
      });

      writeFileSync(configPath, JSON.stringify(config(stateDir, "new-model")));
      await expect(statusOperator(loadOperatorConfig(configPath))).resolves.toMatchObject({
        settings_state: "restart_required",
      });

      daemon.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = ?").run("operator");
      await expect(statusOperator(loadOperatorConfig(configPath))).rejects.toThrow(/UNAUTHORIZED/);
    } finally {
      await rpc.stop();
      await daemon.stop();
      daemon.db.close();
    }
  });

  it("reports unknown when the daemon cannot be observed", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-settings-down-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    const stateDir = path.join(root, "state");
    writeFileSync(configPath, JSON.stringify(config(stateDir)));

    await expect(statusOperator(loadOperatorConfig(configPath))).resolves.toMatchObject({
      status: "stopped",
      settings_state: "unknown",
      applied_config_fingerprint: null,
    });
  });
});
