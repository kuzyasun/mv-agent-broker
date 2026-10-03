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
  display_name: "Mock worker pool profile",
  tags: ["default"],
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

  it("publishes display name, enabled flag, and effective tags in every discovery entry, including disabled", async () => {
    const enabledAuto: OperatorRoute = { ...route, route_id: "route-auto", native_subagents: { mode: "auto" }, tags: ["default", "large"] };
    const disabledOff: OperatorRoute = {
      ...route, route_id: "route-disabled", native_subagents: { mode: "off", max_agents: 1 },
      enabled: false, display_name: undefined, tags: ["large"],
    };
    const h = createHarness({ routes: new Map([[enabledAuto.route_id, enabledAuto], [disabledOff.route_id, disabledOff]]) });
    try {
      const entries = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries
        .filter((entry) => entry.kind === "route");
      expect(entries.find((entry) => entry.route_id === enabledAuto.route_id)).toMatchObject({
        display_name: "Mock worker pool profile",
        enabled: true,
        // Derived from native_subagents auto; stored tags stay untouched.
        tags: ["default", "large", "multi-agent"],
      });
      // Disabled profiles remain visible for coordinator selection auditing.
      expect(entries.find((entry) => entry.route_id === disabledOff.route_id)).toMatchObject({
        display_name: disabledOff.route_id,
        enabled: false,
        tags: ["large"],
      });
    } finally { h.cleanup(); }
  });

  it("refuses a fresh disabled-profile spawn with zero preflight, sessions, or provisioning", async () => {
    const routes = new Map([[route.route_id, { ...route, enabled: false }]]);
    const h = createHarness({ routes });
    let preflightCalls = 0;
    const inner = h.adapter.preflight.bind(h.adapter);
    h.adapter.preflight = (config) => { preflightCalls += 1; return inner(config); };
    try {
      await expect(h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "fresh-disabled",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
      })).rejects.toMatchObject({ code: "INVALID_REQUEST", executionStarted: false });
      expect(preflightCalls).toBe(0);
      expect(h.db.raw.prepare("SELECT COUNT(*) AS c FROM sessions").get()).toMatchObject({ c: 0 });
      expect(h.db.raw.prepare("SELECT COUNT(*) AS c FROM intents WHERE kind = 'provision_session'").get())
        .toMatchObject({ c: 0 });
    } finally { h.cleanup(); }
  });

  it("keeps a foreign-project route UNAUTHORIZED even when disabled", () => {
    const foreign: OperatorRoute = { ...route, route_id: "route-foreign", project_id: "project-other", enabled: false };
    const h = createHarness({ routes: new Map([[foreign.route_id, foreign]]) });
    try {
      expect(() => h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        idempotency_key: "foreign-disabled",
        route_id: foreign.route_id,
        instructions: "x",
        workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
      })).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    } finally { h.cleanup(); }
  });

  it("replays an accepted IDLE spawn after disablement and metadata edits", async () => {
    const routes = new Map<string, OperatorRoute>([[route.route_id, { ...route }]]);
    const h = createHarness({ routes });
    const first = await h.spawnWorkerSession({
      route_id: route.route_id,
      idempotency_key: "replay-idle",
      instructions: "Same instructions.",
      provider: undefined, account_profile_id: undefined, model: undefined,
      effort: undefined, role: undefined, policy_profile_id: undefined,
    });
    expect(first.replayed_request).toBe(false);
    // Metadata is excluded from the request hash: edits and disablement of
    // name/enabled/tags must not invalidate the committed accepted spawn.
    routes.set(route.route_id, {
      ...route,
      enabled: false,
      display_name: "Renamed profile",
      tags: ["large", "custom-hint"],
    });
    try {
      const replay = await h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "replay-idle",
        instructions: "Same instructions.",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
      });
      expect(replay.session_id).toBe(first.session_id);
      expect(replay.replayed_request).toBe(true);
      // The existing bound session keeps working after its profile was disabled.
      const turn = h.sendTask(first.session_id, "turn-after-disable");
      await start(h, turn);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, turn.turn_id).state).toBe("SUCCEEDED");
    } finally { h.cleanup(); }
  });

  it("replays an accepted PROVISIONING spawn after disablement", async () => {
    const routes = new Map<string, OperatorRoute>([[route.route_id, { ...route }]]);
    const h = createHarness({ routes });
    const first = await h.spawnWorkerSession({
      route_id: route.route_id,
      idempotency_key: "replay-provisioning",
      provider: undefined, account_profile_id: undefined, model: undefined,
      effort: undefined, role: undefined, policy_profile_id: undefined,
    });
    // Simulate an accepted spawn whose provisioning window is still open
    // (the crash window between admission and provisioning completion).
    h.db.raw.prepare("UPDATE sessions SET state = 'PROVISIONING' WHERE session_id = ?").run(first.session_id);
    h.db.raw.prepare("UPDATE intents SET state = 'pending' WHERE kind = 'provision_session' AND session_id = ?")
      .run(first.session_id);
    routes.set(route.route_id, { ...route, enabled: false, display_name: "Edited while provisioning" });
    try {
      const replay = await h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "replay-provisioning",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
      });
      expect(replay.session_id).toBe(first.session_id);
      expect(replay.replayed_request).toBe(true);
      // The replay advanced the open provisioning window instead of refusing it.
      expect(h.core.sessionStatus(h.seed.coordinatorId, first.session_id).state).toBe("IDLE");
    } finally { h.cleanup(); }
  });

  it("still reports conflicting arguments on a disabled route instead of the disabled error", async () => {
    const routes = new Map<string, OperatorRoute>([[route.route_id, { ...route }]]);
    const h = createHarness({ routes });
    await h.spawnWorkerSession({
      route_id: route.route_id,
      idempotency_key: "replay-conflict",
      instructions: "Original instructions.",
      provider: undefined, account_profile_id: undefined, model: undefined,
      effort: undefined, role: undefined, policy_profile_id: undefined,
    });
    routes.set(route.route_id, { ...route, enabled: false });
    try {
      await expect(h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "replay-conflict",
        instructions: "Different instructions.",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
      })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    } finally { h.cleanup(); }
  });

  it("repeats the enabled admission check inside the authoritative transaction after its replay lookup", async () => {
    const routes = new Map<string, OperatorRoute>([[route.route_id, { ...route }]]);
    const h = createHarness({ routes });
    // The preflight observation runs BEFORE the authoritative transaction:
    // disabling the route there models a config swap during admission.
    const inner = h.adapter.preflight.bind(h.adapter);
    h.adapter.preflight = (config) => {
      routes.set(route.route_id, { ...route, enabled: false });
      return inner(config);
    };
    try {
      await expect(h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "mid-admission-disable",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
      })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
      expect(h.db.raw.prepare("SELECT COUNT(*) AS c FROM sessions").get()).toMatchObject({ c: 0 });
    } finally { h.cleanup(); }
  });

  it("admits several sessions from the same profile on distinct physical workspaces", async () => {
    const h = createHarness({ routes: new Map([[route.route_id, route]]) });
    try {
      // A profile is not an execution slot: multiple simultaneous sessions may
      // share it as long as the existing physical checkout leases stay intact.
      const first = await h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "same-profile-1",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
        workspace: { mode: "current", workspace_id: h.seed.workspaceMain },
      });
      const second = await h.spawnWorkerSession({
        route_id: route.route_id,
        idempotency_key: "same-profile-2",
        provider: undefined, account_profile_id: undefined, model: undefined,
        effort: undefined, role: undefined, policy_profile_id: undefined,
        workspace: { mode: "current", workspace_id: h.seed.workspaceOther },
      });
      expect(first.session_id).not.toBe(second.session_id);
      expect(first.replayed_request).toBe(false);
      expect(second.replayed_request).toBe(false);
      expect(h.core.sessionStatus(h.seed.coordinatorId, first.session_id).workspace_id).toBe(h.seed.workspaceMain);
      expect(h.core.sessionStatus(h.seed.coordinatorId, second.session_id).workspace_id).toBe(h.seed.workspaceOther);
    } finally { h.cleanup(); }
  });
});
