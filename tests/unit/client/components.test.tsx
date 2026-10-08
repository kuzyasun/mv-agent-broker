// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/preact";
import { Header } from "../../../src/operator/ui/client/components/Header.tsx";
import { NavigationRail } from "../../../src/operator/ui/client/components/NavigationRail.tsx";
import { PoolsSection } from "../../../src/operator/ui/client/sections/PoolsSection.tsx";
import {
  activeSection,
  cancelRouteDraft,
  draftConfig,
  editingRouteId,
  routeDraft,
  savedConfig,
  savedRevision,
  startEditRoute,
} from "../../../src/operator/ui/client/store.ts";
import { setBootstrapForTesting } from "../../../src/operator/ui/client/api.ts";
import type { OperatorConfig } from "../../../src/operator/ui/client/types.ts";

const fixtureConfig = (): OperatorConfig => ({
  version: 1,
  state_dir: "C:/test-state",
  coordinator_id: "coord-test",
  limits: {
    globalUnfinishedTurns: 3,
    quotaScopeUnfinishedTurns: 1,
    hardTurnDeadlineMs: 3600000,
    maxReviewDiffBytes: 33554432,
  },
  projects: [{ project_id: "proj-alpha", display_name: "Project Alpha" }],
  coordinators: [{ coordinator_id: "coord-test", display_name: "Coord", allowed_project_ids: ["proj-alpha"] }],
  accounts: [{ account_profile_id: "acc-1", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
  workspaces: [{ workspace_id: "ws-1", project_id: "proj-alpha", mode: "current", canonical_path: "C:/alpha" }],
  policy_profiles: [
    { policy_profile_id: "policy-write", config: { access: "workspace_write" } },
    { policy_profile_id: "policy-read", config: { access: "read_only" } },
  ],
  coverage_profiles: [],
  routes: [
    {
      route_id: "worker-alpha",
      project_id: "proj-alpha",
      provider: "mock",
      account_profile_id: "acc-1",
      model: "mock-model-alpha",
      effort: "high",
      role: "worker",
      policy_profile_id: "policy-write",
      display_name: "Economical Worker",
      enabled: true,
      tags: ["default"],
    },
    {
      route_id: "reviewer-alpha",
      project_id: "proj-alpha",
      provider: "mock",
      account_profile_id: "acc-1",
      model: "mock-model-beta",
      role: "reviewer",
      policy_profile_id: "policy-read",
      display_name: "Independent Reviewer",
      enabled: true,
      tags: ["review"],
    },
  ],
});

describe("operator UI Preact components", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setBootstrapForTesting({
      token: "secret-token",
      port: 4319,
      configPath: "C:/test-state/config.json",
      snippets: { json: "{}", toml: "" },
      display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
    });
    const cfg = fixtureConfig();
    savedConfig.value = JSON.parse(JSON.stringify(cfg));
    savedRevision.value = "rev-1";
    draftConfig.value = JSON.parse(JSON.stringify(cfg));
    cancelRouteDraft();
  });

  it("renders Header with project selector, status, and control buttons", () => {
    const { getByText, getByRole } = render(<Header />);
    expect(getByText("Agent Broker")).toBeTruthy();
    expect(getByText("All projects")).toBeTruthy();
    expect(getByText("Reload")).toBeTruthy();
    expect(getByText("Save configuration")).toBeTruthy();
    expect(getByText("Restart daemon")).toBeTruthy();
  });

  it("renders NavigationRail with 7 operational sections", () => {
    const { getByText } = render(<NavigationRail />);
    expect(getByText("Overview")).toBeTruthy();
    expect(getByText("Projects")).toBeTruthy();
    expect(getByText("Agent Pools")).toBeTruthy();
    expect(getByText("Limits")).toBeTruthy();
    expect(getByText("Storage")).toBeTruthy();
    expect(getByText("Connection")).toBeTruthy();
    expect(getByText("Advanced")).toBeTruthy();
  });

  it("renders Agent Pools with Workers, Reviewers, and Researchers pools", () => {
    const { getByText } = render(<PoolsSection />);
    expect(getByText("Workers Pool")).toBeTruthy();
    expect(getByText("Reviewers Pool")).toBeTruthy();
    expect(getByText("Researchers Pool")).toBeTruthy();
    expect(getByText("Economical Worker")).toBeTruthy();
    expect(getByText("Independent Reviewer")).toBeTruthy();
  });

  it("opens profile inspector drawer when editing a profile", () => {
    const { queryByLabelText, getByText } = render(<PoolsSection />);
    expect(queryByLabelText("Profile Inspector")).toBeNull();

    // Start editing worker-alpha
    const worker = draftConfig.value!.routes[0]!;
    startEditRoute(worker, false);

    expect(editingRouteId.value).toBe("worker-alpha");
    expect(routeDraft.value?.route_id).toBe("worker-alpha");

    const rerendered = render(<PoolsSection />);
    expect(rerendered.getByLabelText("Profile Inspector")).toBeTruthy();
    expect(rerendered.getByText("Apply to draft")).toBeTruthy();
    expect(rerendered.getByText("Cancel")).toBeTruthy();
  });
});
