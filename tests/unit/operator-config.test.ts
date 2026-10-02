import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openRegistryDb } from "../../src/storage/db.ts";
import {
  applyOperatorConfig,
  loadOperatorConfig,
  operatorConfigFingerprint,
  validateOperatorConfig,
  type OperatorConfig,
} from "../../src/operator/config.ts";
import { createHarness, COVERAGE_CONFIG } from "../helpers/harness.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function validConfig(overrides: Partial<OperatorConfig> = {}): OperatorConfig {
  return {
    version: 1,
    state_dir: "./state",
    coordinator_id: "coord-main",
    projects: [
      { project_id: "project-main", display_name: "Main project", session_cap: 4 },
    ],
    coordinators: [
      { coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] },
    ],
    accounts: [
      { account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock-quota", auth_mode: "cli-owned" },
    ],
    workspaces: [
      { workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: "." },
    ],
    policy_profiles: [
      { policy_profile_id: "policy-main", version: "1", config: { access: "read_only" } },
    ],
    coverage_profiles: [],
    routes: [
      {
        route_id: "route-main",
        project_id: "project-main",
        provider: "mock",
        account_profile_id: "acct-mock",
        model: "mock-model",
        role: "worker",
        policy_profile_id: "policy-main",
      },
    ],
    ...overrides,
  };
}

describe("operator configuration", () => {
  it("rejects credential fields and typoed provider pins without echoing values", () => {
    expect(() => loadOperatorConfig(JSON.stringify({ ...validConfig(), accounts: [{ ...validConfig().accounts[0], api_key: "private-value" }] })))
      .toThrow(/credential field/);
    expect(() => loadOperatorConfig(JSON.stringify({ ...validConfig(), native_binary_pins: { cursorr: "some-path" } })))
      .toThrow(/unknown native binary pin/);
  });

  it("applies operator ACL changes and preserves bound settings despite JSON key order", async () => {
    const h = createHarness();
    try {
      const spawned = await h.spawnWorkerSession();
      h.db.raw.prepare("UPDATE policy_profiles SET config = ? WHERE policy_profile_id = ?")
        .run(JSON.stringify({ write_scope: ["src", "tests"], access: "workspace_write" }), "pol-writer");
      const applied = applyOperatorConfig(h.db, {
        version: 1, state_dir: "./state", coordinator_id: h.seed.coordinatorId,
        projects: [{ project_id: h.seed.projectId, display_name: "Main" }],
        coordinators: [{ coordinator_id: h.seed.coordinatorId, display_name: "Renamed", allowed_project_ids: [h.seed.projectId], revoked: true }],
        accounts: [{ account_profile_id: h.seed.accountMock1, provider: "mock", quota_scope_id: "qs-shared", auth_mode: "native" }],
        workspaces: [{ workspace_id: h.seed.workspaceMain, project_id: h.seed.projectId, mode: "current", canonical_path: h.workspaceRoot, coverage_profile_id: h.seed.coverageProfileId }],
        policy_profiles: [{ policy_profile_id: "pol-writer", config: { access: "workspace_write", write_scope: ["src", "tests"] } }],
        coverage_profiles: [{ coverage_profile_id: h.seed.coverageProfileId, config: COVERAGE_CONFIG }],
        routes: [{ route_id: "route-main", project_id: h.seed.projectId, provider: "mock", account_profile_id: h.seed.accountMock1, model: "new-model", role: "worker", policy_profile_id: "pol-writer" }],
      });
      expect(applied.routes.get("route-main")?.model).toBe("new-model");
      expect(h.db.raw.prepare("SELECT requested_model FROM sessions WHERE session_id = ?").get(spawned.session_id))
        .toMatchObject({ requested_model: "mock-model-1" });
      expect(() => h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 10))
        .toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    } finally { h.cleanup(); }
  });

  it("loads relative state paths and validates references before applying", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "broker-operator-config-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(validConfig({ state_dir: "./owned-state" })));

    const loaded = loadOperatorConfig(configPath);

    expect(loaded.state_dir).toBe(path.join(root, "owned-state"));
    expect(loaded.routes[0]?.route_id).toBe("route-main");
  });

  it("normalizes concurrency defaults and validates only positive safe integers", () => {
    const loaded = loadOperatorConfig(JSON.stringify(validConfig()));
    expect(loaded.limits).toEqual({
      globalUnfinishedTurns: 3,
      quotaScopeUnfinishedTurns: 1,
    });

    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validateOperatorConfig({
        ...validConfig(),
        limits: { globalUnfinishedTurns: value },
      })).toThrow(/positive finite safe integer/);
    }
    expect(() => validateOperatorConfig({
      ...validConfig(),
      limits: { quotaScopeUnfinishedTurns: -1 },
    })).toThrow(/positive finite safe integer/);
    expect(() => validateOperatorConfig({
      ...validConfig(),
      limits: { globalUnfinishedTurns: 6, unexpected: 2 },
    })).toThrow(/unknown limits key/);
  });

  it("fingerprints normalized semantic settings, not formatting or generated timestamps", () => {
    const first = validConfig();
    const route = first.routes[0]!;
    const second = {
      routes: [{
        policy_profile_id: route.policy_profile_id,
        role: route.role,
        model: route.model,
        account_profile_id: route.account_profile_id,
        provider: route.provider,
        project_id: route.project_id,
        route_id: route.route_id,
      }],
      coverage_profiles: first.coverage_profiles,
      policy_profiles: first.policy_profiles,
      workspaces: first.workspaces,
      accounts: first.accounts,
      coordinators: first.coordinators,
      projects: first.projects,
      coordinator_id: first.coordinator_id,
      state_dir: first.state_dir,
      version: first.version,
    };
    const firstFingerprint = operatorConfigFingerprint(loadOperatorConfig(JSON.stringify(first)));
    const secondFingerprint = operatorConfigFingerprint(loadOperatorConfig(` \n${JSON.stringify(second, null, 2)}\n`));

    expect(secondFingerprint).toBe(firstFingerprint);
    expect(operatorConfigFingerprint(loadOperatorConfig(JSON.stringify({
      ...first,
      routes: [{ ...first.routes[0]!, model: "different-model" }],
    })))).not.toBe(firstFingerprint);
    expect(operatorConfigFingerprint(loadOperatorConfig(JSON.stringify({
      ...first,
      limits: { globalUnfinishedTurns: 6, quotaScopeUnfinishedTurns: 2 },
    })))).not.toBe(firstFingerprint);
  });

  it("rejects duplicate IDs and foreign route references", () => {
    const duplicate = validConfig({
      projects: [
        { project_id: "project-main", display_name: "Main", session_cap: 4 },
        { project_id: "project-main", display_name: "Again", session_cap: 4 },
      ],
    });
    expect(() => loadOperatorConfig(JSON.stringify(duplicate))).toThrow(/duplicate/i);

    const foreignRoute = validConfig({
      routes: [{ ...validConfig().routes[0]!, project_id: "missing-project" }],
    });
    expect(() => loadOperatorConfig(JSON.stringify(foreignRoute))).toThrow(/project/i);
  });

  it("round-trips auto native-subagent mode without a child count", () => {
    const loaded = loadOperatorConfig(JSON.stringify({
      ...validConfig(),
      routes: [{ ...validConfig().routes[0], native_subagents: { mode: "auto" } }],
    }));

    expect(loaded.routes[0]?.native_subagents).toEqual({ mode: "auto" });
  });

  it("rejects missing or non-positive counts for counted native-subagent modes", () => {
    expect(() => loadOperatorConfig(JSON.stringify({
      ...validConfig(),
      routes: [{ ...validConfig().routes[0], native_subagents: { mode: "off" } }],
    }))).toThrow(/positive max_agents/);
    expect(() => loadOperatorConfig(JSON.stringify({
      ...validConfig(),
      routes: [{ ...validConfig().routes[0], native_subagents: { mode: "prefer", max_agents: 0 } }],
    }))).toThrow(/positive max_agents/);
  });

  it("rejects a child count combined with auto native-subagent mode", () => {
    expect(() => loadOperatorConfig(JSON.stringify({
      ...validConfig(),
      routes: [{ ...validConfig().routes[0], native_subagents: { mode: "auto", max_agents: 2 } }],
    }))).toThrow(/auto.*without max_agents|mode off\|prefer/i);
  });

  it("applies registry entries transactionally and exposes named routes without wiping state", () => {
    const db = openRegistryDb(":memory:");
    try {
      const applied = applyOperatorConfig(db, validConfig());
      expect(applied.routes.get("route-main")?.model).toBe("mock-model");
      expect(db.raw.prepare("SELECT project_id FROM projects").all()).toHaveLength(1);
      expect(db.raw.prepare("SELECT coordinator_id FROM coordinator_profiles").all()).toHaveLength(1);
      expect(db.raw.prepare("SELECT account_profile_id FROM account_profiles").all()).toHaveLength(1);
      applyOperatorConfig(db, validConfig());
      expect((db.raw.prepare("SELECT configuration_revision FROM projects WHERE project_id = ?")
        .get("project-main") as { configuration_revision: number }).configuration_revision).toBe(2);
    } finally {
      db.close();
    }
  });
});
