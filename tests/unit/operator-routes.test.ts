import { describe, expect, it } from "vitest";
import { createHarness, settle, start } from "../helpers/harness.ts";
import type { OperatorRoute } from "../../src/operator/config.ts";

const route: OperatorRoute = {
  route_id: "mock-worker",
  project_id: "project-parser",
  provider: "mock",
  account_profile_id: "acct-mock-1",
  model: "mock-model-1",
  role: "worker",
  policy_profile_id: "pol-writer",
  native_subagents: { mode: "prefer", max_agents: 2 },
};

describe("named operator routes", () => {
  it("authorizes before looking up a route", () => {
    const h = createHarness();
    try {
      expect(() => h.core.spawn(h.seed.outsiderId, {
        project_id: h.seed.projectId, idempotency_key: "blocked-route", route_id: "missing",
        instructions: "x", workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
      })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    } finally { h.cleanup(); }
  });

  it("rejects oversized route instructions rather than truncating them", async () => {
    const h = createHarness({ routes: new Map([[route.route_id, route]]) });
    try {
      await expect(h.spawnWorkerSession({
        route_id: route.route_id, provider: undefined, account_profile_id: undefined,
        model: undefined, effort: undefined, role: undefined, policy_profile_id: undefined,
        instructions: "x".repeat(65537),
      })).rejects.toMatchObject({ code: "INPUT_LIMIT" });
    } finally { h.cleanup(); }
  });

  it("resolves a named mock route and completes one mock turn", async () => {
    const h = createHarness({ routes: new Map([[route.route_id, route]]) });
    try {
      const spawned = await h.spawnWorkerSession({
        route_id: route.route_id,
        instructions: "Use the named route.",
        provider: undefined,
        account_profile_id: undefined,
        model: undefined,
        effort: undefined,
        role: undefined,
        policy_profile_id: undefined,
      });
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawned.session_id);
      expect(session.provider).toBe("mock");
      expect(session.requested_model).toBe("mock-model-1");
      const turn = h.sendTask(spawned.session_id, "named-route-turn");
      await start(h, turn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("rejects mixing a named route with raw bindings", async () => {
    const h = createHarness({ routes: new Map([[route.route_id, route]]) });
    try {
      await expect(h.spawnWorkerSession({ route_id: route.route_id, model: "raw-model" }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      h.cleanup();
    }
  });
});
