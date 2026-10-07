// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/preact";
import { StorageSection } from "../../../src/operator/ui/client/sections/StorageSection.tsx";
import { draftConfig } from "../../../src/operator/ui/client/store.ts";
import { setBootstrapForTesting } from "../../../src/operator/ui/client/api.ts";
import type { OperatorConfig } from "../../../src/operator/ui/client/types.ts";

const fixtureConfig = (): OperatorConfig => ({
  version: 1,
  state_dir: "C:/test-state",
  coordinator_id: "coord-test",
  projects: [
    { project_id: "main", display_name: "Main Project" },
    { project_id: "other", display_name: "Other Project" },
  ],
  coordinators: [],
  accounts: [],
  workspaces: [],
  policy_profiles: [],
  coverage_profiles: [],
  routes: [],
});

describe("operator storage UI section", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setBootstrapForTesting({
      token: "secret-token",
      port: 4319,
      configPath: "C:/test-state/config.json",
      snippets: { json: "{}", toml: "" },
      display: { locale: "en-US", timeZone: "UTC", hourCycle: null },
    });
    draftConfig.value = fixtureConfig();
  });

  it("generates a cleanup preview, displays accounting, and executes deletion upon confirmation", async () => {
    const fetchMock = vi.fn().mockImplementation(async (route: string, options: RequestInit = {}) => {
      if (route === "/api/storage/preview") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              project_id: "main",
              retention_days: 30,
              preview_token: "tok-123",
              registered_blob_bytes: 2048,
              registered_blob_count: 5,
              eligible_artifact_count: 3,
              protected_artifact_count: 2,
              retained_recent_count: 1,
            }),
        };
      }
      if (route === "/api/storage/execute") {
        return {
          ok: true,
          text: async () =>
            JSON.stringify({
              executed: true,
              deleted_blob_count: 3,
              deleted_blob_bytes: 2048,
            }),
        };
      }
      return { ok: true, text: async () => "{}" };
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("confirm", vi.fn(() => true));

    const { getByText, getByPlaceholderText, queryByText } = render(<StorageSection />);

    // Initially no preview summary
    expect(queryByText("Cleanup Preview Summary: main")).toBeNull();

    // Click preview
    const previewBtn = getByText("Preview Cleanup");
    fireEvent.click(previewBtn);

    await waitFor(() => {
      expect(getByText("Cleanup Preview Summary: main")).toBeTruthy();
    });

    expect(getByText("2.0 KiB")).toBeTruthy(); // 2048 bytes formatted as 2.0 KiB
    expect(getByText("Execute Cleanup")).toBeTruthy();

    // Changing retention days invalidates the preview!
    const daysInput = getByPlaceholderText("30");
    fireEvent.input(daysInput, { target: { value: "14" } });

    // Preview should now be invalidated and hidden
    expect(queryByText("Cleanup Preview Summary: main")).toBeNull();

    // Generate preview again with 14 days
    fireEvent.click(previewBtn);
    await waitFor(() => {
      expect(getByText("Cleanup Preview Summary: main")).toBeTruthy();
    });

    // Execute cleanup
    const execBtn = getByText("Execute Cleanup");
    fireEvent.click(execBtn);

    await waitFor(() => {
      expect(getByText(/Successfully deleted 3 blobs/)).toBeTruthy();
    });
  });
});
