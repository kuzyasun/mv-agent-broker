import { describe, expect, it } from "vitest";
import {
  createDefaultRoute,
  duplicateRoute,
  effectiveRouteTags,
  filterRoutes,
  findReadOnlyPolicy,
  formatTimestamp,
  generateUniqueRouteId,
  groupRoutesByRole,
  isReadOnlyRole,
  parseModelOptions,
} from "../../../src/operator/ui/client/profile.ts";
import type {
  HostDisplayPreferences,
  OperatorAccount,
  OperatorPolicyProfile,
  OperatorRoute,
} from "../../../src/operator/ui/client/types.ts";

describe("profile helpers and business rules", () => {
  it("generates unique route IDs for duplicates", () => {
    const existing: OperatorRoute[] = [
      {
        route_id: "worker-1",
        project_id: "p1",
        provider: "mock",
        account_profile_id: "a1",
        model: "m1",
        role: "worker",
        policy_profile_id: "pol-w",
      },
      {
        route_id: "worker-1-copy",
        project_id: "p1",
        provider: "mock",
        account_profile_id: "a1",
        model: "m1",
        role: "worker",
        policy_profile_id: "pol-w",
      },
    ];

    const duplicated = duplicateRoute(existing[0]!, existing);
    expect(duplicated.route_id).toBe("worker-1-copy-2");
    expect(duplicated.display_name).toBeUndefined();

    const withName: OperatorRoute = {
      ...existing[0]!,
      display_name: "Original Worker",
    };
    const dupWithName = duplicateRoute(withName, existing);
    expect(dupWithName.display_name).toBe("Original Worker (Copy)");
  });

  it("identifies read-only roles and finds compatible read-only policies", () => {
    expect(isReadOnlyRole("worker")).toBe(false);
    expect(isReadOnlyRole("reviewer")).toBe(true);
    expect(isReadOnlyRole("researcher")).toBe(true);

    const policies: OperatorPolicyProfile[] = [
      { policy_profile_id: "write-all", config: { access: "workspace_write" } },
      { policy_profile_id: "read-strict", config: { access: "read_only" } },
    ];
    expect(findReadOnlyPolicy(policies)).toBe("read-strict");
  });

  it("derives multi-agent tag dynamically without mutating stored tags", () => {
    const single: Pick<OperatorRoute, "tags" | "native_subagents"> = {
      tags: ["fast", "default"],
      native_subagents: { mode: "off", max_agents: 1 },
    };
    expect(effectiveRouteTags(single)).toEqual(["fast", "default"]);

    const preferSubagents: Pick<OperatorRoute, "tags" | "native_subagents"> = {
      tags: ["fast"],
      native_subagents: { mode: "prefer", max_agents: 3 },
    };
    expect(effectiveRouteTags(preferSubagents)).toEqual(["fast", "multi-agent"]);

    const autoSubagents: Pick<OperatorRoute, "tags" | "native_subagents"> = {
      tags: [],
      native_subagents: { mode: "auto" },
    };
    expect(effectiveRouteTags(autoSubagents)).toEqual(["multi-agent"]);
  });

  it("filters routes by project, search query, and effective tags", () => {
    const routes: OperatorRoute[] = [
      {
        route_id: "worker-alpha",
        display_name: "Alpha Worker",
        project_id: "proj-1",
        provider: "cursor",
        account_profile_id: "a1",
        model: "gpt-5.6-luna",
        role: "worker",
        policy_profile_id: "p-write",
        tags: ["primary"],
      },
      {
        route_id: "reviewer-beta",
        display_name: "Beta Reviewer",
        project_id: "proj-2",
        provider: "antigravity",
        account_profile_id: "a2",
        model: "gemini-3.1",
        role: "reviewer",
        policy_profile_id: "p-read",
        tags: ["audit"],
        native_subagents: { mode: "prefer", max_agents: 2 },
      },
    ];

    expect(filterRoutes(routes, { projectId: "proj-1" })).toHaveLength(1);
    expect(filterRoutes(routes, { search: "alpha" })).toHaveLength(1);
    expect(filterRoutes(routes, { search: "gemini" })).toHaveLength(1);
    expect(filterRoutes(routes, { tag: "primary" })).toHaveLength(1);
    expect(filterRoutes(routes, { tag: "multi-agent" })).toHaveLength(1);
    expect(filterRoutes(routes, { tag: "missing" })).toHaveLength(0);
  });

  it("groups routes into workers, reviewers, and researchers", () => {
    const routes: OperatorRoute[] = [
      { route_id: "w1", project_id: "p", provider: "m", account_profile_id: "a", model: "m", role: "worker", policy_profile_id: "pol" },
      { route_id: "r1", project_id: "p", provider: "m", account_profile_id: "a", model: "m", role: "reviewer", policy_profile_id: "pol" },
      { route_id: "res1", project_id: "p", provider: "m", account_profile_id: "a", model: "m", role: "researcher", policy_profile_id: "pol" },
    ];
    const groups = groupRoutesByRole(routes);
    expect(groups.workers).toHaveLength(1);
    expect(groups.reviewers).toHaveLength(1);
    expect(groups.researchers).toHaveLength(1);
  });

  it("formats timestamps consistently using host display preferences", () => {
    const prefs: HostDisplayPreferences = {
      locale: "en-US",
      timeZone: "UTC",
      hourCycle: "h23",
    };
    const ts = Date.UTC(2026, 9, 8, 12, 34, 56);
    const formatted = formatTimestamp(ts, prefs);
    expect(formatted).toContain("2026");
    expect(formatted).toContain("12:34:56");

    expect(formatTimestamp(null)).toBe("Unknown");
    expect(formatTimestamp(undefined)).toBe("Unknown");
  });

  it("parses catalog models and sorts effort options", () => {
    const models = ["gpt-5.6-luna-high", "gpt-5.6-luna-low", "gpt-5.6-luna"];
    const options = parseModelOptions("cursor", models);
    expect(options.length).toBeGreaterThan(0);
    const baseOpt = options.find((o) => o.model === "gpt-5.6-luna");
    expect(baseOpt).toBeDefined();
    expect(baseOpt!.efforts).toContain("high");
    expect(baseOpt!.efforts).toContain("low");
  });
});
