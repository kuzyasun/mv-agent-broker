import { describe, expect, it, vi } from "vitest";
import { BrokerCore } from "../../src/core/broker.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import { insertCoverageProfile, insertPolicyProfile, insertWorkspace } from "../../src/storage/repo.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import type { OperatorRoute } from "../../src/operator/config.ts";
import { createHarness } from "../helpers/harness.ts";

function request(h: ReturnType<typeof createHarness>, workspaceId: string, key: string) {
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

describe("workspace spawn admission", () => {
  it("hides stale configured rows and rejects new spawns while preserving accepted replay", () => {
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
      const acceptedRequest = request(h, "ws-stale", "accepted-before-config-change");
      const accepted = h.core.spawn(h.seed.coordinatorId, acceptedRequest);
      const core = configuredCore(h, [h.seed.workspaceMain]);
      const discovery = core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100);
      expect(discovery.entries.filter((entry) => entry.kind === "workspace").map((entry) => entry.id)).toEqual([h.seed.workspaceMain]);

      const before = counts(h);
      const preflight = vi.spyOn(h.adapter, "preflight");
      expect(() => core.spawn(h.seed.coordinatorId, request(h, "ws-stale", "new-stale-spawn"))).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST", executionStarted: false }),
      );
      expect(preflight).not.toHaveBeenCalled();
      expect(counts(h)).toEqual(before);

      const replay = core.spawn(h.seed.coordinatorId, acceptedRequest);
      expect(replay).toMatchObject({ session_id: accepted.session_id, replayed_request: true });
      expect(core.sessionStatus(h.seed.coordinatorId, accepted.session_id).workspace_id).toBe("ws-stale");
    } finally { h.cleanup(); }
  });

  it("rejects an uncovered effective scope before provider preflight and all admission effects", () => {
    const h = createHarness({ configuredWorkspaceIds: new Set(["ws-main"]) });
    try {
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-docs-writer",
        version: "1",
        config: JSON.stringify({ access: "workspace_write", write_scope: ["docs"] }),
      });
      const before = counts(h);
      const preflight = vi.spyOn(h.adapter, "preflight");
      try {
        h.core.spawn(h.seed.coordinatorId, { ...request(h, h.seed.workspaceMain, "uncovered-spawn"), policy_profile_id: "pol-docs-writer" });
        throw new Error("expected coverage refusal");
      } catch (error) {
        expect(error).toBeInstanceOf(BrokerError);
        expect(error).toMatchObject({ code: "SNAPSHOT_COVERAGE_MISMATCH", executionStarted: false });
        expect((error as BrokerError).details).toMatchObject({
          actual_write_scope: ["docs"],
          uncovered_write_scope: ["docs"],
          compatible_workspace_ids: [],
        });
      }
      expect(preflight).not.toHaveBeenCalled();
      expect(counts(h)).toEqual(before);
    } finally { h.cleanup(); }
  });

  it("reports route policy and compatible workspace coverage, and allows an explicitly read-only audit", async () => {
    const route: OperatorRoute = {
      route_id: "writer-route",
      project_id: "project-parser",
      provider: "mock",
      account_profile_id: "acct-mock-1",
      model: "mock-model-1",
      role: "worker",
      policy_profile_id: "pol-writer",
    };
    const h = createHarness({ configuredWorkspaceIds: new Set(["ws-main"]), routes: new Map([[route.route_id, route]]) });
    try {
      const entries = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries;
      expect(entries.find((entry) => entry.kind === "workspace" && entry.id === "ws-main")).toMatchObject({
        coverage_profile_id: h.seed.coverageProfileId,
        coverage_profile_version: "1",
        coverage_source_prefixes: ["src", "tests"],
      });
      expect(entries.find((entry) => entry.kind === "route" && entry.id === route.route_id)).toMatchObject({
        effective_policy: { access: "workspace_write", write_scope: ["src", "tests"] },
        compatible_workspace_ids: ["ws-main"],
      });

      const spawned = h.core.spawn(h.seed.coordinatorId, {
        ...request(h, h.seed.workspaceMain, "read-only-audit"),
        route_id: route.route_id,
        provider: undefined,
        account_profile_id: undefined,
        model: undefined,
        role: undefined,
        policy_profile_id: undefined,
        policy_restrictions: { access: "read_only" },
      });
      expect(spawned.session_id).toBeTruthy();
      expect(h.core.sessionEffectivePolicy(h.seed.coordinatorId, spawned.session_id)).toMatchObject({ access: "read_only", write_scope: [] });
    } finally { h.cleanup(); }
  });

  it("filters review slots from worker guidance and admits read-only physical reviewers without coverage", () => {
    const workerRoute: OperatorRoute = {
      route_id: "worker-route",
      project_id: "project-parser",
      provider: "mock",
      account_profile_id: "acct-mock-1",
      model: "mock-model-1",
      role: "worker",
      policy_profile_id: "pol-writer",
    };
    const reviewerRoute: OperatorRoute = {
      ...workerRoute,
      route_id: "reviewer-route",
      role: "reviewer",
      policy_profile_id: "pol-readonly",
    };
    const h = createHarness({
      configuredWorkspaceIds: new Set(["ws-main", "ws-review-slot", "ws-physical-no-coverage"]),
      routes: new Map([[workerRoute.route_id, workerRoute], [reviewerRoute.route_id, reviewerRoute]]),
    });
    try {
      insertPolicyProfile(h.db, {
        policy_profile_id: "pol-readonly",
        version: "1",
        config: JSON.stringify({ access: "read_only", write_scope: [] }),
      });
      const reviewCoverage = {
        source_prefixes: ["src", "tests"],
        non_source_prefixes: ["docs"],
        excluded_prefixes: [".git", "node_modules"],
      };
      insertCoverageProfile(h.db, {
        coverage_profile_id: "cov-review",
        version: "1",
        config: JSON.stringify(reviewCoverage),
        contract_hash: coverageContractHash(reviewCoverage),
      });
      insertWorkspace(h.db, {
        workspace_id: "ws-review-slot",
        project_id: h.seed.projectId,
        mode: "review_slot",
        canonical_path: null,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: "cov-review",
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

      const entries = h.core.discovery(h.seed.coordinatorId, h.seed.projectId, null, 100).entries;
      expect(entries.find((entry) => entry.kind === "workspace" && entry.id === "ws-physical-no-coverage")).toMatchObject({
        eligible_worktree_source: true,
        coverage_profile_id: null,
      });
      expect(entries.find((entry) => entry.kind === "route" && entry.id === workerRoute.route_id)).toMatchObject({
        compatible_workspace_ids: ["ws-main"],
      });
      expect(entries.find((entry) => entry.kind === "route" && entry.id === reviewerRoute.route_id)).toMatchObject({
        effective_policy: { access: "read_only", write_scope: [] },
        compatible_workspace_ids: ["ws-main", "ws-physical-no-coverage", "ws-review-slot"],
      });

      const reviewer = h.core.spawn(h.seed.coordinatorId, {
        project_id: h.seed.projectId,
        idempotency_key: "physical-reviewer-no-coverage",
        provider: "mock",
        account_profile_id: h.seed.accountMock1,
        model: "mock-model-1",
        role: "reviewer",
        instructions: "Review the checkout read-only.",
        workspace: { mode: "current", workspace_id: "ws-physical-no-coverage" },
        policy_profile_id: "pol-readonly",
      });
      expect(reviewer.state).toBe("IDLE");
    } finally { h.cleanup(); }
  });
});
