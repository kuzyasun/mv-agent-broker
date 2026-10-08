import { useSignal } from "@preact/signals";
import type { JSX } from "preact";
import { FolderIcon, PlusIcon, TrashIcon, CheckIcon, XIcon } from "../components/Icons.tsx";
import {
  draftConfig,
  setActionMessage,
  selectedProject,
} from "../store.ts";
import { fetchFolders } from "../api.ts";
import type {
  FolderEntry,
  OperatorProject,
  OperatorWorkspace,
  OperatorPolicyProfile,
  OperatorCoverageProfile,
  OperatorRoute,
} from "../types.ts";

export function ProjectsSection(): JSX.Element {
  const config = draftConfig.value;
  const projects = config?.projects ?? [];
  const workspaces = config?.workspaces ?? [];
  const routes = config?.routes ?? [];

  // Wizard state
  const isWizardOpen = useSignal<boolean>(false);
  const wizardProjectId = useSignal<string>("");
  const wizardDisplayName = useSignal<string>("");
  const wizardCanonicalPath = useSignal<string>("");
  const wizardCopyFrom = useSignal<string>("");
  const wizardFolderPickerOpen = useSignal<boolean>(false);
  const currentFolderEntry = useSignal<FolderEntry | null>(null);
  const folderLoading = useSignal<boolean>(false);

  const openFolderPicker = async (initialPath?: string) => {
    wizardFolderPickerOpen.value = true;
    folderLoading.value = true;
    try {
      const entry = await fetchFolders(initialPath);
      currentFolderEntry.value = entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionMessage(`Folder picker error: ${msg}`, "error", 4000);
    } finally {
      folderLoading.value = false;
    }
  };

  const handleSelectFolder = (folderPath: string) => {
    wizardCanonicalPath.value = folderPath;
    if (!wizardProjectId.value) {
      const basename = folderPath.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "project";
      const cleanId = basename.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      wizardProjectId.value = cleanId;
      wizardDisplayName.value = basename;
    }
    wizardFolderPickerOpen.value = false;
  };

  const handleCreateProject = () => {
    const id = wizardProjectId.value.trim();
    const name = wizardDisplayName.value.trim() || id;
    const folder = wizardCanonicalPath.value.trim();

    if (!id) {
      setActionMessage("Project ID cannot be empty.", "warning", 3000);
      return;
    }
    if (projects.some((p) => p.project_id === id)) {
      setActionMessage(`Project ID '${id}' already exists.`, "error", 4000);
      return;
    }

    const newProject: OperatorProject = {
      project_id: id,
      display_name: name,
    };

    const newWorkspace: OperatorWorkspace = {
      workspace_id: `${id}-current`,
      project_id: id,
      mode: "current",
      canonical_path: folder || null,
      coverage_profile_id: `${id}-coverage`,
    };

    const newCoverage: OperatorCoverageProfile = {
      coverage_profile_id: `${id}-coverage`,
      version: "1",
      config: {
        source_prefixes: ["."],
        non_source_prefixes: [],
        excluded_prefixes: [".git", ".state", "node_modules", "dist"],
      },
    };

    const newPolicyWrite: OperatorPolicyProfile = {
      policy_profile_id: `${id}-worker`,
      version: "1",
      config: { access: "workspace_write" },
    };

    const newPolicyRead: OperatorPolicyProfile = {
      policy_profile_id: `${id}-read-only`,
      version: "1",
      config: { access: "read_only" },
    };

    let copiedRoutes: OperatorRoute[] = [];
    if (wizardCopyFrom.value) {
      const sourceRoutes = routes.filter((r) => r.project_id === wizardCopyFrom.value);
      copiedRoutes = sourceRoutes.map((r, idx) => ({
        ...JSON.parse(JSON.stringify(r)),
        route_id: `${id}-${r.provider}-${r.role}-${idx + 1}`,
        project_id: id,
        policy_profile_id: r.role === "worker" ? `${id}-worker` : `${id}-read-only`,
      }));
    }

    const nextConfig = {
      ...draftConfig.value!,
      projects: [...projects, newProject],
      workspaces: [...workspaces, newWorkspace],
      coverage_profiles: [...(config?.coverage_profiles ?? []), newCoverage],
      policy_profiles: [...(config?.policy_profiles ?? []), newPolicyWrite, newPolicyRead],
      routes: [...routes, ...copiedRoutes],
    };

    draftConfig.value = nextConfig;
    selectedProject.value = id;
    isWizardOpen.value = false;
    wizardProjectId.value = "";
    wizardDisplayName.value = "";
    wizardCanonicalPath.value = "";
    wizardCopyFrom.value = "";

    setActionMessage(`Project '${name}' registered in draft.`, "success", 4000);
  };

  const handleDeleteProject = (projectId: string) => {
    const proceed = window.confirm(
      `Delete project '${projectId}' and associated workspaces from draft?`,
    );
    if (!proceed) return;

    const nextProjects = projects.filter((p) => p.project_id !== projectId);
    const nextWorkspaces = workspaces.filter((w) => w.project_id !== projectId);
    const nextRoutes = routes.filter((r) => r.project_id !== projectId);

    draftConfig.value = {
      ...draftConfig.value!,
      projects: nextProjects,
      workspaces: nextWorkspaces,
      routes: nextRoutes,
    };

    if (selectedProject.value === projectId) {
      selectedProject.value = "";
    }
    setActionMessage(`Project '${projectId}' removed from draft.`, "info", 3000);
  };

  return (
    <div className="flex-1 p-4 bg-[#f8f9fa] overflow-y-auto space-y-4">
      {/* Top Header */}
      <div className="flex items-center justify-between pb-3 border-b border-[#c4c5d7]">
        <div>
          <h2 className="text-base font-semibold text-[#141b2b]">Registered Projects</h2>
          <p className="text-xs text-[#747686]">
            Manage project repositories, canonical workspace locations, and scope permissions.
          </p>
        </div>
        <button
          type="button"
          className="h-8 px-3 bg-[#1d4ed8] text-white text-xs font-medium flex items-center gap-1.5 hover:bg-[#1e40af] cursor-pointer"
          onClick={() => {
            isWizardOpen.value = !isWizardOpen.value;
          }}
        >
          <PlusIcon size={14} />
          <span>{isWizardOpen.value ? "Close Wizard" : "Register New Project"}</span>
        </button>
      </div>

      {/* New Project Wizard */}
      {isWizardOpen.value && (
        <div className="border border-[#1d4ed8] bg-white p-4 space-y-3">
          <div className="text-sm font-semibold text-[#1d4ed8] border-b border-[#e5e7eb] pb-2">
            Register New Project
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
            <div>
              <label htmlFor="wizard-project-id" className="block font-medium text-[#434655] mb-1">
                Project ID
              </label>
              <input
                id="wizard-project-id"
                type="text"
                className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                placeholder="e.g. backend-api"
                value={wizardProjectId.value}
                onInput={(e) => {
                  wizardProjectId.value = (e.target as HTMLInputElement).value;
                }}
              />
            </div>

            <div>
              <label htmlFor="wizard-display-name" className="block font-medium text-[#434655] mb-1">
                Display Name
              </label>
              <input
                id="wizard-display-name"
                type="text"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs focus:border-[#1d4ed8]"
                placeholder="e.g. Backend API Repository"
                value={wizardDisplayName.value}
                onInput={(e) => {
                  wizardDisplayName.value = (e.target as HTMLInputElement).value;
                }}
              />
            </div>
          </div>

          {/* Canonical Workspace Path & Folder Picker */}
          <div>
            <label htmlFor="wizard-canonical-path" className="block font-medium text-[#434655] mb-1 text-xs">
              Canonical Workspace Directory
            </label>
            <div className="flex gap-2">
              <input
                id="wizard-canonical-path"
                type="text"
                className="flex-1 h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                placeholder="C:\projects\my-repo"
                value={wizardCanonicalPath.value}
                onInput={(e) => {
                  wizardCanonicalPath.value = (e.target as HTMLInputElement).value;
                }}
              />
              <button
                type="button"
                className="h-8 px-3 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1 cursor-pointer"
                onClick={() => openFolderPicker(wizardCanonicalPath.value || undefined)}
              >
                <FolderIcon size={14} />
                <span>Browse…</span>
              </button>
            </div>
          </div>

          {/* Folder Picker Modal / Panel */}
          {wizardFolderPickerOpen.value && (
            <div className="p-3 bg-[#f1f3ff] border border-[#c4c5d7] text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-[#141b2b]">
                  Current Path: {currentFolderEntry.value?.path ?? "Loading…"}
                </span>
                <button
                  type="button"
                  className="text-xs text-[#434655] hover:text-[#141b2b] cursor-pointer"
                  onClick={() => {
                    wizardFolderPickerOpen.value = false;
                  }}
                >
                  Close
                </button>
              </div>

              {folderLoading.value ? (
                <div className="py-2 text-[#434655]">Scanning directory…</div>
              ) : (
                <div className="space-y-1 max-h-48 overflow-y-auto bg-white border border-[#c4c5d7] p-2">
                  {currentFolderEntry.value?.parent && (
                    <button
                      type="button"
                      className="w-full text-left font-mono text-xs text-[#1d4ed8] hover:bg-[#e9edff] px-1 py-0.5 flex items-center gap-1.5"
                      onClick={() => openFolderPicker(currentFolderEntry.value!.parent!)}
                    >
                      <FolderIcon size={14} className="text-[#1d4ed8] shrink-0" />
                      <span>.. (parent directory)</span>
                    </button>
                  )}
                  {currentFolderEntry.value?.folders.map((f) => (
                    <div key={f.path} className="flex items-center justify-between hover:bg-[#f8f9fa] px-1 py-0.5">
                      <button
                        type="button"
                        className="text-left font-mono text-xs text-[#141b2b] hover:text-[#1d4ed8] flex-1 truncate flex items-center gap-1.5"
                        onClick={() => openFolderPicker(f.path)}
                      >
                        <FolderIcon size={14} className="text-[#1d4ed8] shrink-0" />
                        <span className="truncate">{f.name}</span>
                      </button>
                      <button
                        type="button"
                        className="h-7 px-2.5 bg-[#1d4ed8] text-white text-[11px] font-medium ml-2 cursor-pointer flex items-center"
                        onClick={() => handleSelectFolder(f.path)}
                      >
                        Select
                      </button>
                    </div>
                  ))}
                  {currentFolderEntry.value && currentFolderEntry.value.folders.length === 0 && (
                    <div className="text-[#434655] text-xs p-1">No child folders found.</div>
                  )}
                </div>
              )}

              {currentFolderEntry.value && (
                <button
                  type="button"
                  className="h-8 px-3 bg-[#1d4ed8] text-white text-xs font-medium cursor-pointer"
                  onClick={() => handleSelectFolder(currentFolderEntry.value!.path)}
                >
                  Use this folder ({currentFolderEntry.value.path})
                </button>
              )}
            </div>
          )}

          {/* Copy Profiles Option */}
          {projects.length > 0 && (
            <div>
              <label htmlFor="wizard-copy-from" className="block font-medium text-[#434655] mb-1 text-xs">
                Copy Agent Profiles From Existing Project
              </label>
              <select
                id="wizard-copy-from"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
                value={wizardCopyFrom.value}
                onChange={(e) => {
                  wizardCopyFrom.value = (e.target as HTMLSelectElement).value;
                }}
              >
                <option value="">Do not copy (create empty project)</option>
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.display_name || p.project_id}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Wizard Action Footer */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#e5e7eb]">
            <button
              type="button"
              className="h-8 px-3 bg-white border border-[#c4c5d7] text-xs text-[#141b2b] hover:bg-[#e9edff] cursor-pointer"
              onClick={() => {
                isWizardOpen.value = false;
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="h-8 px-4 bg-[#1d4ed8] text-white text-xs font-medium hover:bg-[#1e40af] flex items-center gap-1.5 cursor-pointer"
              onClick={handleCreateProject}
            >
              <CheckIcon size={14} />
              <span>Create Project</span>
            </button>
          </div>
        </div>
      )}

      {/* Projects Table / List */}
      <div className="border border-[#c4c5d7] bg-white">
        <div className="h-9 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between text-xs font-semibold text-[#141b2b]">
          <span>Registered Projects ({projects.length})</span>
        </div>

        {projects.length === 0 ? (
          <div className="p-6 text-center text-xs text-[#747686] font-mono">
            No projects registered. Click "Register New Project" above to create one.
          </div>
        ) : (
          <div className="divide-y divide-[#e5e7eb]">
            {projects.map((project) => {
              const projectWorkspaces = workspaces.filter(
                (w) => w.project_id === project.project_id,
              );
              const projectRoutes = routes.filter(
                (r) => r.project_id === project.project_id,
              );
              return (
                <div key={project.project_id} className="p-3 flex items-start justify-between gap-4 hover:bg-[#f8f9fa]">
                  <div className="space-y-1 min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-[#141b2b]">
                        {project.display_name || project.project_id}
                      </span>
                      <span className="text-xs font-mono text-[#747686] bg-[#f1f3ff] px-1.5 py-0.5 border border-[#c4c5d7]">
                        {project.project_id}
                      </span>
                    </div>

                    <div className="text-xs text-[#434655]">
                      <span className="font-medium">Workspaces: </span>
                      {projectWorkspaces.map((ws) => (
                        <span key={ws.workspace_id} className="font-mono text-[#747686] mr-2">
                          {ws.canonical_path || "(review slot)"}
                        </span>
                      ))}
                    </div>

                    <div className="text-xs text-[#747686]">
                      <span>{projectRoutes.length} agent profile(s) bound</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      className="p-1.5 text-[#747686] hover:text-[#dc2626] border border-[#c4c5d7] hover:border-[#dc2626] cursor-pointer"
                      onClick={() => handleDeleteProject(project.project_id)}
                      title="Delete project"
                    >
                      <TrashIcon size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
