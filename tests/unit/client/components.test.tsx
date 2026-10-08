// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/preact";
import { Header } from "../../../src/operator/ui/client/components/Header.tsx";
import { NavigationRail } from "../../../src/operator/ui/client/components/NavigationRail.tsx";
import { ErrorBoundary } from "../../../src/operator/ui/client/components/ErrorBoundary.tsx";
import { PoolsSection } from "../../../src/operator/ui/client/sections/PoolsSection.tsx";
import {
  activeSection,
  actionMessage,
  cancelRouteDraft,
  catalogModelOptions,
  catalogObservations,
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
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
    catalogObservations.value = new Map();
    catalogModelOptions.value = new Map();
    actionMessage.value = null;
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

  it("keeps configured Antigravity effort visible before refresh and uses only observed efforts after refresh", async () => {
    const cfg = fixtureConfig();
    cfg.accounts[0]!.provider = "antigravity";
    cfg.routes[0]!.provider = "antigravity";
    cfg.routes[0]!.model = "gemini-3.8-flash";
    cfg.routes[0]!.effort = "high";
    draftConfig.value = JSON.parse(JSON.stringify(cfg));
    startEditRoute(draftConfig.value!.routes[0]!, false);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observation: {
        provider: "antigravity",
        models: ["gemini-3.8-flash-low", "gemini-3.8-flash-medium", "gemini-3.8-flash-high"],
        observed_at: 1,
        source: "cli_metadata_probe",
        detail: null,
      },
      options: [{ model: "gemini-3.8-flash", efforts: ["low", "medium", "high"] }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<PoolsSection />);
    let effortSelect = view.container.querySelector("#prof-effort-select") as HTMLSelectElement;
    expect(effortSelect.value).toBe("high");
    expect(view.getByText("Effort choices are unverified until catalogue refresh.")).toBeTruthy();
    expect(Array.from(effortSelect.options).map((option) => option.value)).toEqual([
      "", "low", "medium", "high", "max",
    ]);
    expect(effortSelect.querySelector('option[value="high"]')?.textContent).toContain("configured, unverified");

    await fireEvent.click(view.getByRole("button", { name: "Refresh catalogue" }));
    await waitFor(() => expect(catalogObservations.value.get("antigravity")?.models.length).toBe(3));

    effortSelect = view.container.querySelector("#prof-effort-select") as HTMLSelectElement;
    expect(effortSelect.value).toBe("high");
    expect(Array.from(effortSelect.options).map((option) => option.value)).toEqual([
      "low", "medium", "high",
    ]);
    await fireEvent.change(effortSelect, { target: { value: "low" } });
    expect(routeDraft.value?.effort).toBe("low");
    expect(catalogModelOptions.value.get("antigravity")?.[0]?.efforts).toEqual([
      "low", "medium", "high",
    ]);

    const manualEntryButton = Array.from(view.container.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Manual entry",
    );
    expect(manualEntryButton).toBeTruthy();
    await fireEvent.click(manualEntryButton!);
    effortSelect = view.container.querySelector("#prof-effort-select") as HTMLSelectElement;
    expect(effortSelect.value).toBe("low");
    expect(Array.from(effortSelect.options).map((option) => option.value)).toEqual([
      "low", "medium", "high",
    ]);
    await fireEvent.input(view.container.querySelector("#prof-model-manual")!, { target: { value: "new-manual-model" } });
    effortSelect = view.container.querySelector("#prof-effort-select") as HTMLSelectElement;
    expect(Array.from(effortSelect.options).map((option) => option.value)).toEqual(["", "low", "medium", "high", "max"]);
    expect(effortSelect.querySelector('option[value="medium"]')?.textContent).toContain("unverified");
    await fireEvent.change(effortSelect, { target: { value: "medium" } });
    expect(routeDraft.value?.effort).toBe("medium");
    expect(view.getByText("Model was not reported by the current catalogue. Effort choices are unverified.")).toBeTruthy();
  });

  it("preserves an unset effort after refreshing explicit variants instead of silently displaying low", async () => {
    const cfg = fixtureConfig();
    cfg.accounts[0]!.provider = "antigravity";
    cfg.routes[0]!.provider = "antigravity";
    cfg.routes[0]!.model = "gemini-3.8-flash";
    delete cfg.routes[0]!.effort;
    draftConfig.value = JSON.parse(JSON.stringify(cfg));
    startEditRoute(draftConfig.value!.routes[0]!, false);
    catalogObservations.value = new Map([["antigravity", { provider: "antigravity", models: ["gemini-3.8-flash-low", "gemini-3.8-flash-high"], observed_at: 1, source: "cli_metadata_probe", detail: null }]]);
    catalogModelOptions.value = new Map([["antigravity", [{ model: "gemini-3.8-flash", efforts: ["low", "high"] }]]]);
    const view = render(<PoolsSection />);
    const effortSelect = view.container.querySelector("#prof-effort-select") as HTMLSelectElement;
    expect(effortSelect.value).toBe("");
    expect(effortSelect.selectedOptions[0]?.textContent).toContain("configured, unverified");
    expect(routeDraft.value?.effort).toBeUndefined();
    await fireEvent.change(effortSelect, { target: { value: "high" } });
    expect(routeDraft.value?.effort).toBe("high");
  });

  it("reports empty catalogue refreshes as warnings with the probe detail", async () => {
    const cfg = fixtureConfig();
    draftConfig.value = JSON.parse(JSON.stringify(cfg));
    startEditRoute(draftConfig.value!.routes[0]!, false);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      observation: {
        provider: "mock",
        models: [],
        observed_at: 1,
        source: "cli_metadata_probe",
        detail: "metadata unavailable",
      },
      options: [],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const view = render(<PoolsSection />);
    await fireEvent.click(view.getByRole("button", { name: "Refresh catalogue" }));
    await waitFor(() => expect(actionMessage.value?.kind).toBe("warning"));
    expect(actionMessage.value?.text).toContain("returned 0 models");
    expect(actionMessage.value?.text).toContain("metadata unavailable");
  });

  it("renders ErrorBoundary fallback when a child component throws", () => {
    const ProblematicChild = () => {
      throw new Error("Simulated rendering failure");
    };

    // Suppress console.error in test output for expected error boundary catch
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { getByText } = render(
      <ErrorBoundary>
        <ProblematicChild />
      </ErrorBoundary>,
    );

    expect(getByText("Rendering Error Occurred")).toBeTruthy();
    expect(getByText("Simulated rendering failure")).toBeTruthy();
    expect(getByText("Reload Operator UI")).toBeTruthy();

    spy.mockRestore();
  });
});
