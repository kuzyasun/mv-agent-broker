// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { ProjectsSection } from "../../src/operator/ui/client/sections/ProjectsSection.tsx";
import { draftConfig, selectedProject } from "../../src/operator/ui/client/store.ts";
import type { OperatorConfig } from "../../src/operator/ui/client/types.ts";

afterEach(() => {
  cleanup();
  draftConfig.value = null;
  selectedProject.value = "";
});

describe("operator project registration", () => {
  it("creates a physical workspace and access-only profiles without requiring coverage", async () => {
    draftConfig.value = {
      version: 1,
      state_dir: "C:/state",
      coordinator_id: "coord-main",
      projects: [],
      coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: [] }],
      accounts: [],
      workspaces: [],
      policy_profiles: [],
      coverage_profiles: [{
        coverage_profile_id: "manual-snapshot",
        config: { source_prefixes: ["."], non_source_prefixes: [], excluded_prefixes: [".git"] },
      }],
      routes: [],
    } satisfies OperatorConfig;

    const view = render(<ProjectsSection />);
    await fireEvent.click(view.getByRole("button", { name: "Register New Project" }));
    await fireEvent.input(view.getByLabelText("Project ID"), { target: { value: "repo" } });
    await fireEvent.input(view.getByLabelText("Display Name"), { target: { value: "Repository" } });
    await fireEvent.click(view.getByRole("button", { name: "Create Project" }));

    expect(draftConfig.value?.workspaces).toEqual([{
      workspace_id: "repo-current",
      project_id: "repo",
      mode: "current",
      canonical_path: null,
    }]);
    expect(draftConfig.value?.policy_profiles).toEqual([
      { policy_profile_id: "repo-worker", version: "1", config: { access: "workspace_write" } },
      { policy_profile_id: "repo-read-only", version: "1", config: { access: "read_only" } },
    ]);
    expect(draftConfig.value?.coverage_profiles).toHaveLength(1);
    expect(selectedProject.value).toBe("repo");
    expect(view.container.textContent).not.toContain("scope permissions");
  });
});
