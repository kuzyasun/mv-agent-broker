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
  it("uses agent-decided native delegation without injecting a numeric cap", async () => {
    const autoRoute: OperatorRoute = { ...route, native_subagents: { mode: "auto" } };
    const h = createHarness({ routes: new Map([[autoRoute.route_id, autoRoute]]) });
    try {
      const spawned = await h.spawnWorkerSession({
        route_id: autoRoute.route_id,
        instructions: "Choose useful independent work.",
        provider: undefined,
        account_profile_id: undefined,
        model: undefined,
        effort: undefined,
        role: undefined,
        policy_profile_id: undefined,
      });
      const payload = JSON.parse((h.db.raw.prepare("SELECT payload FROM intents WHERE session_id = ? AND kind = 'provision_session'")
        .get(spawned.session_id) as { payload: string }).payload) as { instructions: string };
      expect(payload.instructions).toContain("mode=auto");
      expect(payload.instructions).toContain("Agent decides");
      expect(payload.instructions).toContain("vendor choose the number");
      expect(payload.instructions).not.toContain("max_agents");
      expect(payload.instructions).not.toMatch(/at most \d+ children/);

      const discovered = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries
        .find((entry) => entry.kind === "route" && entry.route_id === autoRoute.route_id);
      expect(discovered).toMatchObject({
        native_subagents: { mode: "auto" },
        native_subagents_enforcement: "advisory",
      });
    } finally { h.cleanup(); }
  });

  it("requests a single agent by default and suggests a maximum in prefer mode", async () => {
    const offRoute: OperatorRoute = { ...route, route_id: "mock-off", native_subagents: undefined };
    const h = createHarness({ routes: new Map([[offRoute.route_id, offRoute], [route.route_id, route]]) });
    try {
      const defaultSpawned = await h.spawnWorkerSession({
        route_id: offRoute.route_id,
        provider: undefined,
        account_profile_id: undefined,
        model: undefined,
        effort: undefined,
        role: undefined,
        policy_profile_id: undefined,
      });
      const defaultPayload = JSON.parse((h.db.raw.prepare("SELECT payload FROM intents WHERE session_id = ? AND kind = 'provision_session'")
        .get(defaultSpawned.session_id) as { payload: string }).payload) as { instructions: string };
      expect(defaultPayload.instructions).toContain("Perform this task as one agent");
      expect(defaultPayload.instructions).toContain("Do not delegate to native subagents");

      const preferredSpawned = await h.spawnWorkerSession({
        route_id: route.route_id,
        provider: undefined,
        account_profile_id: undefined,
        model: undefined,
        effort: undefined,
        role: undefined,
        policy_profile_id: undefined,
      });
      const preferredPayload = JSON.parse((h.db.raw.prepare("SELECT payload FROM intents WHERE session_id = ? AND kind = 'provision_session'")
        .get(preferredSpawned.session_id) as { payload: string }).payload) as { instructions: string };
      expect(preferredPayload.instructions).toContain("at most 2 children");
      expect(preferredPayload.instructions).toContain("wait for their results");
    } finally { h.cleanup(); }
  });

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
