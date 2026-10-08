import { describe, expect, it } from "vitest";
import { BrokerCore, requiredSendBinding } from "../../src/core/broker.ts";
import { createHarness, settle, start } from "../helpers/harness.ts";
import { insertPolicyProfile, insertWorkspace } from "../../src/storage/repo.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import type { OperatorRoute } from "../../src/operator/config.ts";

function spawnRequest(h: ReturnType<typeof createHarness>, workspaceId: string, key: string) {
  return {
    project_id: h.seed.projectId,
    idempotency_key: key,
    provider: "mock",
    account_profile_id: h.seed.accountMock1,
    model: "mock-model-1",
    role: "worker" as const,
    instructions: "Run a bounded task.",
    workspace: { mode: "current" as const, workspace_id: workspaceId },
    policy_profile_id: "pol-writer",
  };
}

function configuredCore(h: ReturnType<typeof createHarness>, workspaceIds: string[], routes?: ReadonlyMap<string, OperatorRoute>) {
  return new BrokerCore({
    db: h.db,
    clock: h.clock,
    limits: h.limits,
    adapters: new Map([["mock", h.adapter]]),
    deferExecution: true,
    blobStore: openBlobStore(h.blobRoot),
    configuredWorkspaceIds: new Set(workspaceIds),
    routes,
  });
}

function counts(h: ReturnType<typeof createHarness>) {
  const count = (table: string): number => Number((h.db.raw.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
  return {
    sessions: count("sessions"),
    intents: count("intents"),
    reservations: count("reservations"),
    snapshots: count("snapshot_records"),
    idempotency: count("idempotency_records"),
  };
}

describe("physical workspace admission", () => {
  it("hides stale configured rows, rejects new spawns, and preserves accepted replay", async () => {
    const h = createHarness();
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-stale",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: h.workspaceRoot,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: h.seed.coverageProfileId,
      });
      const acceptedRequest = spawnRequest(h, "ws-stale", "accepted-before-config-change");
      const accepted = h.core.spawn(h.seed.coordinatorId, acceptedRequest);
      const core = configuredCore(h, [h.seed.workspaceMain]);
      const discovery = core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100);
      expect(discovery.entries.filter((entry) => entry.kind === "workspace").map((entry) => entry.id)).toEqual([h.seed.workspaceMain]);

      const before = counts(h);
      expect(() => core.spawn(h.seed.coordinatorId, spawnRequest(h, "ws-stale", "new-stale-spawn"))).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST", executionStarted: false }),
      );
      expect(counts(h)).toEqual(before);

      const replay = core.spawn(h.seed.coordinatorId, acceptedRequest);
      expect(replay).toMatchObject({ session_id: accepted.session_id, replayed_request: true });
      expect(core.sessionStatus(h.seed.coordinatorId, accepted.session_id).workspace_id).toBe("ws-stale");
    } finally {
      h.cleanup();
    }
  });

  it("accepts a registered checkout without coverage or automatic snapshots", async () => {
    const route = {
      route_id: "worker",
      project_id: "project-parser",
      provider: "mock",
      account_profile_id: "acct-mock-1",
      model: "mock-model-1",
      role: "worker" as const,
      policy_profile_id: "pol-writer",
    };
    const h = createHarness({ routes: new Map([[route.route_id, route]]) });
    try {
      insertWorkspace(h.db, {
        workspace_id: "ws-no-coverage",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: h.workspaceRoot,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: null,
      });
      const spawn = await h.spawnWorkerSession({
        workspace: { mode: "current", workspace_id: "ws-no-coverage" },
      });
      expect(spawn.initial_snapshot_id).toBeNull();
      expect(h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id)).toMatchObject({
        state: "IDLE",
        initial_snapshot_id: null,
        latest_snapshot_id: null,
      });
      const entries = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries;
      expect(entries.find((entry) => entry.kind === "route")).toMatchObject({
        effective_policy: { access: "workspace_write" },
        compatible_workspace_ids: expect.arrayContaining(["ws-no-coverage"]),
      });
    } finally {
      h.cleanup();
    }
  });

  it("guides every physical role by selectable checkout IDs, independent of coverage", () => {
    const workerRoute: OperatorRoute = {
      route_id: "worker",
      project_id: "project-parser",
      provider: "mock",
      account_profile_id: "acct-mock-1",
      model: "mock-model-1",
      role: "worker",
      policy_profile_id: "pol-writer",
    };
    const reviewerRoute: OperatorRoute = {
      ...workerRoute,
      route_id: "reviewer",
      role: "reviewer",
      policy_profile_id: "pol-readonly",
    };
    const h = createHarness({ routes: new Map([[workerRoute.route_id, workerRoute], [reviewerRoute.route_id, reviewerRoute]]) });
    try {
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-readonly",
        version: "1",
        config: JSON.stringify({ access: "read_only" }),
      });
      insertWorkspace(h.db, {
        workspace_id: "ws-physical-no-coverage",
        project_id: h.seed.projectId,
        mode: "current",
        canonical_path: h.workspaceRoot,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: null,
      });
      insertWorkspace(h.db, {
        workspace_id: "ws-review-slot",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: null,
      });

      const entries = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries;
      const expectedPhysicalIds = ["ws-main", "ws-other", "ws-physical-no-coverage"];
      expect(entries.find((entry) => entry.kind === "route" && entry.id === "worker")).toMatchObject({
        effective_policy: { access: "workspace_write" },
        compatible_workspace_ids: expectedPhysicalIds,
      });
      expect(entries.find((entry) => entry.kind === "route" && entry.id === "reviewer")).toMatchObject({
        effective_policy: { access: "read_only" },
        compatible_workspace_ids: expectedPhysicalIds,
      });
    } finally {
      h.cleanup();
    }
  });

  it("sends a plain task to a physical read-only reviewer without Git or snapshot bindings", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession({ role: "reviewer", access: "read_only" });
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(requiredSendBinding(session)).toBe("none");
      const sent = h.sendTask(spawn.session_id, "physical-review");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed", summary: "review complete" }]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id)).toMatchObject({
        state: "SUCCEEDED",
        baseline_snapshot_id: null,
        review_target_snapshot_id: null,
        final_snapshot_id: null,
      });
    } finally {
      h.cleanup();
    }
  });

  it("keeps physical write scope at project root with no snapshot gate", async () => {
    const h = createHarness();
    try {
      const spawn = await h.spawnWorkerSession();
      const sent = h.sendTask(spawn.session_id, "root-doc-write");
      h.adapter.plan(sent.turn_id, [
        { kind: "workspace_write", files: [{ path: "docs/new-note.md", content: "local workflow\n" }] },
        { kind: "complete", outcome: "completed", summary: "written" },
      ]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id)).toMatchObject({
        state: "SUCCEEDED",
        final_snapshot_id: null,
      });
    } finally {
      h.cleanup();
    }
  });
});
