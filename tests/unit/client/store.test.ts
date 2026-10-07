import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  actionMessage,
  advancedDraft,
  advancedError,
  applyAdvancedDraft,
  applyRouteDraft,
  cancelAdvancedDraft,
  cancelRouteDraft,
  canSave,
  deleteRouteAction,
  draftConfig,
  editingRouteId,
  hasUnappliedEditor,
  initAdvancedDraft,
  isAdvancedDirty,
  isGlobalDirty,
  isRouteDraftDirty,
  loadConfiguration,
  routeDraft,
  saveConfiguration,
  saveConflict,
  savedConfig,
  savedRevision,
  startEditRoute,
  toggleRouteEnabledAction,
  updateRouteDraftField,
} from "../../../src/operator/ui/client/store.ts";
import { setBootstrapForTesting } from "../../../src/operator/ui/client/api.ts";
import type { OperatorConfig, OperatorRoute } from "../../../src/operator/ui/client/types.ts";

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
  projects: [{ project_id: "p1", display_name: "Project 1" }],
  coordinators: [{ coordinator_id: "coord-test", display_name: "Coord", allowed_project_ids: ["p1"] }],
  accounts: [{ account_profile_id: "acc1", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
  workspaces: [{ workspace_id: "w1", project_id: "p1", mode: "current", canonical_path: "C:/p1" }],
  policy_profiles: [
    { policy_profile_id: "p-write", config: { access: "workspace_write" } },
    { policy_profile_id: "p-read", config: { access: "read_only" } },
  ],
  coverage_profiles: [],
  routes: [
    {
      route_id: "worker-1",
      project_id: "p1",
      provider: "mock",
      account_profile_id: "acc1",
      model: "mock-model-1",
      effort: "high",
      role: "worker",
      policy_profile_id: "p-write",
      display_name: "Worker One",
      enabled: true,
      tags: ["default"],
    },
  ],
});

describe("operator UI reactive store and draft lifecycle", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setBootstrapForTesting({
      token: "secret-token",
      port: 4319,
      configPath: "C:/test-state/config.json",
      snippets: { json: "{}", toml: "" },
      display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
    });
  });

  it("loads configuration and initializes draft without dirty state", async () => {
    const config = fixtureConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            config,
            revision: "rev-1",
            snippets: { json: "{}", toml: "" },
            display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
          }),
      }),
    );

    await loadConfiguration(true);
    expect(savedRevision.value).toBe("rev-1");
    expect(savedConfig.value?.coordinator_id).toBe("coord-test");
    expect(draftConfig.value?.routes).toHaveLength(1);
    expect(isGlobalDirty.value).toBe(false);
    expect(hasUnappliedEditor.value).toBe(false);
    expect(canSave.value).toBe(false);
  });

  it("tracks global dirty state when modifying draft routes", async () => {
    const config = fixtureConfig();
    savedConfig.value = JSON.parse(JSON.stringify(config));
    savedRevision.value = "rev-1";
    draftConfig.value = JSON.parse(JSON.stringify(config));

    expect(isGlobalDirty.value).toBe(false);

    toggleRouteEnabledAction("worker-1");
    expect(draftConfig.value?.routes[0]?.enabled).toBe(false);
    expect(isGlobalDirty.value).toBe(true);
    expect(canSave.value).toBe(true);
  });

  it("manages profile inspector local draft and blocks save until applied or cancelled", async () => {
    const config = fixtureConfig();
    savedConfig.value = JSON.parse(JSON.stringify(config));
    savedRevision.value = "rev-1";
    draftConfig.value = JSON.parse(JSON.stringify(config));

    const route = config.routes[0]!;
    startEditRoute(route, false);

    expect(editingRouteId.value).toBe("worker-1");
    expect(isRouteDraftDirty.value).toBe(false);
    expect(hasUnappliedEditor.value).toBe(false);

    // Edit local field
    updateRouteDraftField("display_name", "Renamed Worker");
    expect(isRouteDraftDirty.value).toBe(true);
    expect(hasUnappliedEditor.value).toBe(true);

    // Save should be blocked with explanation
    const saveResult = await saveConfiguration();
    expect(saveResult).toBe(false);
    expect(actionMessage.value?.text).toContain("Cannot save: Please apply or cancel pending edits");

    // Apply to draft
    const applied = applyRouteDraft();
    expect(applied).toBe(true);
    expect(hasUnappliedEditor.value).toBe(false);
    expect(draftConfig.value?.routes[0]?.display_name).toBe("Renamed Worker");
    expect(isGlobalDirty.value).toBe(true);
    expect(canSave.value).toBe(true);
  });

  it("saves configuration successfully and adopts new revision", async () => {
    const config = fixtureConfig();
    savedConfig.value = JSON.parse(JSON.stringify(config));
    savedRevision.value = "rev-1";
    draftConfig.value = JSON.parse(JSON.stringify(config));

    // Make an edit
    draftConfig.value = {
      ...draftConfig.value!,
      coordinator_id: "coord-updated",
    };
    expect(canSave.value).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            saved: true,
            revision: "rev-2",
            backup: "b.json",
            snippets: { json: "{}", toml: "" },
            message: "Configuration saved.",
          }),
      }),
    );

    const ok = await saveConfiguration();
    expect(ok).toBe(true);
    expect(savedRevision.value).toBe("rev-2");
    expect(savedConfig.value?.coordinator_id).toBe("coord-updated");
    expect(isGlobalDirty.value).toBe(false);
    expect(actionMessage.value?.kind).toBe("success");
  });

  it("handles 409 revision conflict without dropping local draft edits", async () => {
    const config = fixtureConfig();
    savedConfig.value = JSON.parse(JSON.stringify(config));
    savedRevision.value = "rev-1";
    draftConfig.value = {
      ...config,
      coordinator_id: "coord-local-edit",
    };

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        text: async () =>
          JSON.stringify({
            error: "stale config revision",
            revision: "rev-disk-changed",
          }),
      }),
    );

    const ok = await saveConfiguration();
    expect(ok).toBe(false);
    expect(saveConflict.value).toBe(true);
    expect(draftConfig.value?.coordinator_id).toBe("coord-local-edit");
    expect(actionMessage.value?.text).toContain("Revision conflict (409)");
  });

  it("manages advanced raw settings editor and validates JSON syntax on apply", () => {
    const config = fixtureConfig();
    draftConfig.value = JSON.parse(JSON.stringify(config));

    initAdvancedDraft();
    expect(advancedDraft.value).not.toBeNull();
    expect(advancedDraft.value?.stateDir).toBe("C:/test-state");

    // Invalid JSON
    advancedDraft.value = {
      ...advancedDraft.value!,
      accountsJson: "{ invalid json",
    };
    const applyFailed = applyAdvancedDraft();
    expect(applyFailed).toBe(false);
    expect(advancedError.value).toContain("Failed to apply");

    // Valid JSON
    advancedDraft.value = {
      ...advancedDraft.value!,
      accountsJson: "[]",
    };
    const applySuccess = applyAdvancedDraft();
    expect(applySuccess).toBe(true);
    expect(draftConfig.value?.accounts).toEqual([]);
    expect(advancedDraft.value?.accountsJson).toBe("[]");
    expect(isAdvancedDirty.value).toBe(false);
  });
});
