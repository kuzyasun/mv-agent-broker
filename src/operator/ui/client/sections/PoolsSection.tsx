import { useEffect } from "preact/hooks";
import { useSignal } from "@preact/signals";
import type { JSX } from "preact";
import {
  PlusIcon,
  SearchIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  CopyIcon,
  TrashIcon,
  RefreshIcon,
  XIcon,
  CheckIcon,
} from "../components/Icons.tsx";
import {
  applyRouteDraft,
  cancelRouteDraft,
  catalogModelOptions,
  catalogObservations,
  deleteRouteAction,
  draftConfig,
  duplicateRouteAction,
  editingRouteId,
  isNewRoute,
  isRouteDraftDirty,
  routeDraft,
  searchQuery,
  selectedProject,
  startEditRoute,
  tagFilter,
  toggleRouteEnabledAction,
  updateRouteDraftField,
  setActionMessage,
} from "../store.ts";
import {
  createDefaultRoute,
  effectiveRouteTags,
  filterRoutes,
  findReadOnlyPolicy,
  isReadOnlyRole,
  parseModelOptions,
  roleDisplayName,
} from "../profile.ts";
import { refreshCatalog } from "../api.ts";
import type { OperatorRoute, OperatorPolicyProfile } from "../types.ts";

export function PoolsSection(): JSX.Element {
  const config = draftConfig.value;
  const routes = config?.routes ?? [];
  const accounts = config?.accounts ?? [];
  const policies = config?.policy_profiles ?? [];
  const projects = config?.projects ?? [];

  // Collapsed states per pool
  const workersOpen = useSignal<boolean>(true);
  const reviewersOpen = useSignal<boolean>(true);
  const researchersOpen = useSignal<boolean>(true);

  // Manual model input toggle in inspector
  const manualModel = useSignal<boolean>(false);
  const catalogRefreshing = useSignal<boolean>(false);

  // Filtered routes
  const filtered = filterRoutes(routes, {
    projectId: selectedProject.value,
    search: searchQuery.value,
    tag: tagFilter.value,
  });

  const workers = filtered.filter((r) => r.role === "worker");
  const reviewers = filtered.filter((r) => r.role === "reviewer");
  const researchers = filtered.filter((r) => r.role === "researcher");

  // Collect all unique tags for filter dropdown
  const allUniqueTags = Array.from(
    new Set(routes.flatMap((r) => effectiveRouteTags(r))),
  ).sort();

  const handleAddProfile = (role: "worker" | "reviewer" | "researcher" = "worker") => {
    const projId = selectedProject.value || projects[0]?.project_id || "default";
    const newRoute = createDefaultRoute(projId, routes, accounts, policies, role);
    startEditRoute(newRoute, true);
    if (role === "worker") workersOpen.value = true;
    if (role === "reviewer") reviewersOpen.value = true;
    if (role === "researcher") researchersOpen.value = true;
  };

  const handleRefreshCatalog = async (provider: string) => {
    catalogRefreshing.value = true;
    try {
      const result = await refreshCatalog(provider);
      const nextObservations = new Map(catalogObservations.value);
      nextObservations.set(provider, result.observation);
      catalogObservations.value = nextObservations;
      const nextOptions = new Map(catalogModelOptions.value);
      nextOptions.set(provider, result.options);
      catalogModelOptions.value = nextOptions;
      if (result.observation.models.length === 0 || result.observation.detail) {
        const detail = result.observation.detail ? ` ${result.observation.detail}` : "";
        setActionMessage(
          `Catalogue refresh for ${provider} returned ${result.observation.models.length} models.${detail}`,
          "warning",
          7000,
        );
      } else {
        setActionMessage(`Refreshed catalogue for ${provider} (${result.observation.models.length} models).`, "info", 3000);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setActionMessage(`Failed to refresh catalog: ${msg}`, "error", 4000);
    } finally {
      catalogRefreshing.value = false;
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && routeDraft.value) {
        if (isRouteDraftDirty.value) {
          const proceed = window.confirm(
            "You have unapplied profile edits. Discard them and close?",
          );
          if (!proceed) return;
        }
        cancelRouteDraft();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSafeCancel = () => {
    if (isRouteDraftDirty.value) {
      const proceed = window.confirm(
        "You have unapplied profile edits. Discard them and close?",
      );
      if (!proceed) return;
    }
    cancelRouteDraft();
  };

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Middle Inventory Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-[#f8f9fa] overflow-y-auto">
        {/* Top Header Summary */}
        <div className="bg-white border-b border-[#c4c5d7] p-4 space-y-3.5 shrink-0">
          <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-[20px] font-semibold text-[#141b2b] tracking-tight">
                  Agent Pools
                </h1>
                <span className="text-[11px] font-mono px-2 py-0.5 bg-[#e9edff] text-[#434655] border border-[#c4c5d7] font-medium uppercase tracking-wider">
                  {routes.length} Pools Registered
                </span>
              </div>
              <p className="text-[12px] text-[#434655] mt-1.5 max-w-2xl leading-normal">
                Configured agent execution profiles. Profiles are selected by coordinator by role, task, and tags. Multiple workers run concurrently subject to broker limits.
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                className="h-8 px-3 bg-white border border-[#c4c5d7] text-[#141b2b] text-xs font-medium hover:bg-[#e9edff] flex items-center gap-1.5 cursor-pointer"
                onClick={() => handleRefreshCatalog(routes[0]?.provider || "cursor")}
                disabled={catalogRefreshing.value}
              >
                <RefreshIcon size={14} />
                <span>Refresh Model Catalogue</span>
              </button>
              <button
                type="button"
                className="h-8 px-3.5 bg-[#1d4ed8] text-white border border-[#1d4ed8] text-xs font-semibold hover:bg-[#1e40af] flex items-center gap-1.5 cursor-pointer"
                onClick={() => handleAddProfile("worker")}
              >
                <PlusIcon size={14} />
                <span>+ Add Profile</span>
              </button>
            </div>
          </div>
        </div>

        {/* Controls Toolbar */}
        <div className="p-3 bg-white border-b border-[#c4c5d7] flex flex-wrap items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 flex-1 min-w-[240px] max-w-md">
            <div className="relative w-full">
              <span className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-[#434655]">
                <SearchIcon size={14} />
              </span>
              <input
                type="text"
                aria-label="Filter profiles by name, ID or model"
                className="w-full pl-8 pr-3 h-8 bg-white border border-[#c4c5d7] text-xs font-mono text-[#141b2b] placeholder-[#434655] outline-none focus:border-[#1d4ed8]"
                placeholder="Filter profiles by name, ID, model..."
                value={searchQuery.value}
                onInput={(e) => {
                  searchQuery.value = (e.target as HTMLInputElement).value;
                }}
              />
            </div>

            {/* Tag Filter Dropdown */}
            <select
              aria-label="Filter profiles by tag"
              className="h-8 px-2 bg-white border border-[#c4c5d7] text-xs text-[#141b2b] outline-none focus:border-[#1d4ed8] cursor-pointer"
              value={tagFilter.value}
              onChange={(e) => {
                tagFilter.value = (e.target as HTMLSelectElement).value;
              }}
            >
              <option value="">All tags</option>
              {allUniqueTags.map((t) => (
                <option key={t} value={t}>
                  #{t}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="h-8 px-3 bg-[#1d4ed8] text-white text-xs font-medium flex items-center gap-1.5 hover:bg-[#1e40af] active:bg-[#1e3a8a] cursor-pointer"
              onClick={() => handleAddProfile("worker")}
            >
              <PlusIcon size={14} />
              <span>Add Profile</span>
            </button>
          </div>
        </div>

        {/* Pools Inventory Panels */}
        <div className="p-4 space-y-4">
          {/* Workers Pool */}
          <PoolCardList
            title="Workers"
            role="worker"
            count={workers.length}
            isOpen={workersOpen.value}
            onToggle={() => {
              workersOpen.value = !workersOpen.value;
            }}
            onAdd={() => handleAddProfile("worker")}
            routes={workers}
          />

          {/* Reviewers Pool */}
          <PoolCardList
            title="Reviewers"
            role="reviewer"
            count={reviewers.length}
            isOpen={reviewersOpen.value}
            onToggle={() => {
              reviewersOpen.value = !reviewersOpen.value;
            }}
            onAdd={() => handleAddProfile("reviewer")}
            routes={reviewers}
          />

          {/* Researchers Pool */}
          <PoolCardList
            title="Researchers"
            role="researcher"
            count={researchers.length}
            isOpen={researchersOpen.value}
            onToggle={() => {
              researchersOpen.value = !researchersOpen.value;
            }}
            onAdd={() => handleAddProfile("researcher")}
            routes={researchers}
          />
        </div>
      </div>

      {/* Profile Inspector Drawer / Column */}
      {routeDraft.value && (
        <aside
          className="w-full max-w-[450px] md:w-[380px] lg:w-[420px] xl:w-[450px] bg-white border-l border-[#c4c5d7] flex flex-col shrink-0 z-20 shadow-none overflow-hidden"
          aria-label="Profile Inspector"
        >
          {/* Inspector Header */}
          <div className="h-10 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-xs font-semibold uppercase text-[#1d4ed8]">
                {isNewRoute.value ? "New Profile" : "Edit Profile"}
              </span>
              <span className="text-xs font-mono text-[#434655] truncate">
                {routeDraft.value.route_id}
              </span>
            </div>
            <button
              type="button"
              className="p-1 text-[#434655] hover:text-[#141b2b] cursor-pointer"
              onClick={handleSafeCancel}
              title="Close editor"
            >
              <XIcon size={16} />
            </button>
          </div>

          {/* Inspector Form Body */}
          <div className="flex-1 p-3 overflow-y-auto space-y-3 text-xs">
            {/* Route ID */}
            <div>
              <label htmlFor="prof-route-id" className="block font-medium text-[#434655] mb-1">
                Route ID
              </label>
              <input
                id="prof-route-id"
                type="text"
                className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                value={routeDraft.value.route_id}
                onInput={(e) =>
                  updateRouteDraftField("route_id", (e.target as HTMLInputElement).value)
                }
              />
            </div>

            {/* Display Name */}
            <div>
              <label htmlFor="prof-display-name" className="block font-medium text-[#434655] mb-1">
                Display Name
              </label>
              <input
                id="prof-display-name"
                type="text"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs focus:border-[#1d4ed8]"
                placeholder="Optional readable profile name"
                value={routeDraft.value.display_name ?? ""}
                onInput={(e) =>
                  updateRouteDraftField(
                    "display_name",
                    (e.target as HTMLInputElement).value || undefined,
                  )
                }
              />
            </div>

            {/* Project */}
            <div>
              <label htmlFor="prof-project-id" className="block font-medium text-[#434655] mb-1">
                Project
              </label>
              <select
                id="prof-project-id"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
                value={routeDraft.value.project_id}
                onChange={(e) =>
                  updateRouteDraftField("project_id", (e.target as HTMLSelectElement).value)
                }
              >
                {projects.map((p) => (
                  <option key={p.project_id} value={p.project_id}>
                    {p.display_name || p.project_id}
                  </option>
                ))}
              </select>
            </div>

            {/* Role */}
            <div>
              <label htmlFor="prof-role" className="block font-medium text-[#434655] mb-1">
                Role
              </label>
              <select
                id="prof-role"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
                value={routeDraft.value.role}
                onChange={(e) => {
                  const newRole = (e.target as HTMLSelectElement).value as
                    | "worker"
                    | "reviewer"
                    | "researcher";
                  updateRouteDraftField("role", newRole);
                  // Ensure policy compatibility: reviewers/researchers must have read-only policy
                  if (isReadOnlyRole(newRole)) {
                    const readPolicy = findReadOnlyPolicy(policies);
                    if (readPolicy) {
                      updateRouteDraftField("policy_profile_id", readPolicy);
                    }
                  }
                }}
              >
                <option value="worker">Worker (Execution / Full Scope)</option>
                <option value="reviewer">Reviewer (Strictly Read-Only)</option>
                <option value="researcher">Researcher (Strictly Read-Only)</option>
              </select>
            </div>

            {/* Account & Provider */}
            <div>
              <label htmlFor="prof-account-id" className="block font-medium text-[#434655] mb-1">
                Account & Provider
              </label>
              <select
                id="prof-account-id"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
                value={routeDraft.value.account_profile_id}
                onChange={(e) => {
                  const accId = (e.target as HTMLSelectElement).value;
                  const acc = accounts.find((a) => a.account_profile_id === accId);
                  updateRouteDraftField("account_profile_id", accId);
                  if (acc) {
                    updateRouteDraftField("provider", acc.provider);
                  }
                }}
              >
                {accounts.map((a) => (
                  <option key={a.account_profile_id} value={a.account_profile_id}>
                    {a.account_profile_id} ({a.provider} / {a.quota_scope_id})
                  </option>
                ))}
              </select>
            </div>

            {/* Model & Discovery */}
            <div className="space-y-1.5 p-2 bg-[#f8f9fa] border border-[#e5e7eb]">
              <div className="flex items-center justify-between">
                <span className="font-medium text-[#434655]">Model Selection</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-[11px] text-[#1d4ed8] hover:underline cursor-pointer flex items-center gap-1"
                    onClick={() => handleRefreshCatalog(routeDraft.value!.provider)}
                    disabled={catalogRefreshing.value}
                  >
                    <RefreshIcon size={12} />
                    <span>{catalogRefreshing.value ? "Refreshing…" : "Refresh catalogue"}</span>
                  </button>
                  <span className="text-[#c4c5d7]">|</span>
                  <button
                    type="button"
                    className="text-[11px] text-[#434655] hover:text-[#141b2b] cursor-pointer"
                    onClick={() => {
                      manualModel.value = !manualModel.value;
                    }}
                  >
                    {manualModel.value ? "Use dropdown" : "Manual entry"}
                  </button>
                </div>
              </div>

              {manualModel.value ? (
                <div className="space-y-1.5">
                  <input
                    id="prof-model-manual"
                    type="text"
                    className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs bg-white focus:border-[#1d4ed8]"
                    placeholder="Enter model identifier"
                    value={routeDraft.value.model}
                    onInput={(e) =>
                      updateRouteDraftField("model", (e.target as HTMLInputElement).value)
                    }
                  />
                  <EffortSelector
                    provider={routeDraft.value.provider}
                    selectedModel={routeDraft.value.model}
                    selectedEffort={routeDraft.value.effort ?? ""}
                    onEffortChange={(effort) => updateRouteDraftField("effort", effort || undefined)}
                  />
                </div>
              ) : (
                <ModelSelector
                  provider={routeDraft.value.provider}
                  selectedModel={routeDraft.value.model}
                  selectedEffort={routeDraft.value.effort ?? ""}
                  onModelChange={(model) => {
                    updateRouteDraftField("model", model);
                  }}
                  onEffortChange={(effort) => {
                    updateRouteDraftField("effort", effort || undefined);
                  }}
                />
              )}
            </div>

            {/* Policy Profile */}
            <div>
              <label htmlFor="prof-policy-id" className="block font-medium text-[#434655] mb-1">
                Policy Profile
              </label>
              <select
                id="prof-policy-id"
                className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
                value={routeDraft.value.policy_profile_id}
                onChange={(e) =>
                  updateRouteDraftField("policy_profile_id", (e.target as HTMLSelectElement).value)
                }
              >
                {policies.map((p) => {
                  const access = p.config?.access ?? "read_only";
                  const isRead = access === "read_only";
                  const disabled = isReadOnlyRole(routeDraft.value!.role) && !isRead;
                  return (
                    <option
                      key={p.policy_profile_id}
                      value={p.policy_profile_id}
                      disabled={disabled}
                    >
                      {p.policy_profile_id} ({access})
                    </option>
                  );
                })}
              </select>
              {isReadOnlyRole(routeDraft.value.role) && (
                <p className="mt-1 text-[11px] text-[#434655]">
                  Reviewers and researchers are restricted to read-only policies.
                </p>
              )}
            </div>

            {/* Tags Input */}
            <div>
              <label htmlFor="prof-tags" className="block font-medium text-[#434655] mb-1">
                Tags (comma separated)
              </label>
              <input
                id="prof-tags"
                type="text"
                className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs focus:border-[#1d4ed8]"
                placeholder="default, fast, review..."
                value={(routeDraft.value.tags ?? []).join(", ")}
                onInput={(e) => {
                  const raw = (e.target as HTMLInputElement).value;
                  const parsed = raw
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0 && s !== "multi-agent");
                  updateRouteDraftField("tags", parsed);
                }}
              />
              <p className="mt-1 text-[11px] text-[#434655]">
                Multi-agent tag is automatically derived from native delegation mode.
              </p>
            </div>

            {/* Native Subagents (Advisory Delegation) */}
            <div className="p-2.5 bg-[#f8f9fa] border border-[#e5e7eb] space-y-2">
              <span className="font-medium text-[#434655]">Native Subagent Delegation</span>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label htmlFor="prof-subagent-mode" className="block text-[11px] text-[#434655] mb-0.5">
                    Mode
                  </label>
                  <select
                    id="prof-subagent-mode"
                    className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white cursor-pointer"
                    value={routeDraft.value.native_subagents?.mode ?? "off"}
                    onChange={(e) => {
                      const mode = (e.target as HTMLSelectElement).value as
                        | "off"
                        | "prefer"
                        | "auto";
                      if (mode === "auto") {
                        updateRouteDraftField("native_subagents", { mode: "auto" });
                      } else if (mode === "prefer") {
                        updateRouteDraftField("native_subagents", {
                          mode: "prefer",
                          max_agents: 2,
                        });
                      } else {
                        updateRouteDraftField("native_subagents", { mode: "off", max_agents: 1 });
                      }
                    }}
                  >
                    <option value="off">Off (Single worker)</option>
                    <option value="prefer">Prefer subagents</option>
                    <option value="auto">Auto (Provider managed)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="prof-max-subagents" className="block text-[11px] text-[#434655] mb-0.5">
                    Max Subagents
                  </label>
                  <input
                    id="prof-max-subagents"
                    type="number"
                    min="1"
                    max="10"
                    className="w-full h-8 px-2 border border-[#c4c5d7] text-xs bg-white disabled:bg-[#f1f3f5] disabled:cursor-not-allowed"
                    disabled={routeDraft.value.native_subagents?.mode !== "prefer"}
                    value={
                      routeDraft.value.native_subagents &&
                      "max_agents" in routeDraft.value.native_subagents
                        ? routeDraft.value.native_subagents.max_agents
                        : 1
                    }
                    onInput={(e) => {
                      const count = parseInt((e.target as HTMLInputElement).value, 10) || 1;
                      updateRouteDraftField("native_subagents", {
                        mode: "prefer",
                        max_agents: count,
                      });
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Enablement */}
            <div className="flex items-center gap-2 pt-1">
              <input
                type="checkbox"
                id="profile-enable-toggle"
                className="w-4 h-4 border border-[#c4c5d7] text-[#1d4ed8] focus:ring-0 cursor-pointer"
                checked={routeDraft.value.enabled !== false}
                onChange={(e) => {
                  updateRouteDraftField("enabled", (e.target as HTMLInputElement).checked);
                }}
              />
              <label
                htmlFor="profile-enable-toggle"
                className="text-xs font-medium text-[#141b2b] cursor-pointer"
              >
                Enabled for new task sessions
              </label>
            </div>
          </div>

          {/* Inspector Footer Actions */}
          <div className="p-3 bg-[#f1f3ff] border-t border-[#c4c5d7] flex items-center justify-between gap-2 shrink-0">
            <div className="flex items-center gap-1.5 text-[11px] font-mono">
              {isRouteDraftDirty.value ? (
                <span className="text-[#d97706] font-medium flex items-center gap-1">
                  <span className="w-1.5 h-1.5 bg-[#d97706]" />
                  Unapplied edits in profile
                </span>
              ) : (
                <span className="text-[#434655]">No pending edits</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="h-8 px-3 bg-white border border-[#c4c5d7] text-[#141b2b] text-xs font-medium hover:bg-[#e9edff] cursor-pointer"
                onClick={handleSafeCancel}
              >
                Cancel
              </button>
              <button
                type="button"
                className="h-8 px-4 bg-[#1d4ed8] text-white text-xs font-medium hover:bg-[#1e40af] active:bg-[#1e3a8a] cursor-pointer flex items-center gap-1.5"
                onClick={applyRouteDraft}
              >
                <CheckIcon size={14} />
                <span>Apply to draft</span>
              </button>
            </div>
          </div>
        </aside>
      )}
    </div>
  );
}

// Collapsible Pool Section List
function PoolCardList(props: {
  title: string;
  role: "worker" | "reviewer" | "researcher";
  count: number;
  isOpen: boolean;
  onToggle: () => void;
  onAdd: () => void;
  routes: OperatorRoute[];
}): JSX.Element {
  const { title, role, count, isOpen, onToggle, onAdd, routes } = props;

  return (
    <div className="border border-[#c4c5d7] bg-white">
      {/* Pool Header */}
      <div className="h-10 px-3 bg-[#f1f3ff] border-b border-[#c4c5d7] flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            aria-expanded={isOpen}
            className="flex items-center gap-2 text-xs font-semibold text-[#141b2b] hover:text-[#1d4ed8] cursor-pointer"
            onClick={onToggle}
          >
            {isOpen ? <ChevronDownIcon size={14} /> : <ChevronRightIcon size={14} />}
            <h2 className="text-[13px] font-semibold text-[#141b2b] tracking-tight m-0 inline">
              {title} Pool
            </h2>
            <span className="text-[11px] font-mono text-[#434655] bg-white px-1.5 py-0.5 border border-[#c4c5d7]">
              {count} {count === 1 ? "profile" : "profiles"}
            </span>
          </button>
          <span
            className={`text-[11px] font-mono font-semibold px-2 py-0.5 border ${
              role === "worker"
                ? "bg-[#eff6ff] border-[#bfdbfe] text-[#1d4ed8]"
                : "bg-[#fffbeb] border-[#fde68a] text-[#92400e]"
            }`}
          >
            {role === "worker" ? "WORKSPACE_WRITE" : "READ_ONLY"}
          </span>
        </div>

        <button
          type="button"
          className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1 cursor-pointer"
          onClick={onAdd}
        >
          <PlusIcon size={12} />
          <span>Add to pool</span>
        </button>
      </div>

      {/* Pool Content */}
      {isOpen && (
        <div className="p-3">
          {routes.length === 0 ? (
            <div className="py-6 text-center text-xs text-[#434655] font-mono">
              No profiles found in this pool.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {routes.map((route) => (
                <ProfileCard key={route.route_id} route={route} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Individual Profile Card
function ProfileCard({ route }: { route: OperatorRoute }): JSX.Element {
  const isEditing = editingRouteId.value === route.route_id;
  const isEnabled = route.enabled !== false;
  const tags = effectiveRouteTags(route);
  const isWorker = route.role === "worker";

  return (
    <div
      className={`border p-3 flex flex-col justify-between transition-none ${
        isEditing
          ? "border-l-4 border-l-[#1d4ed8] border-t-[#c4c5d7] border-r-[#c4c5d7] border-b-[#c4c5d7] bg-[#eff6ff]"
          : isEnabled
            ? "border-[#c4c5d7] bg-white hover:border-[#434655]"
            : "border-[#e5e7eb] bg-[#f8f9fa] opacity-75"
      }`}
    >
      <div>
        {/* Top bar: Name / ID / Badges */}
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="min-w-0">
            <div
              className="text-[13px] font-semibold text-[#141b2b] truncate"
              title={route.display_name}
            >
              {route.display_name || route.route_id}
            </div>
            <div className="text-[11px] font-mono text-[#434655] truncate">
              {route.route_id}
            </div>
          </div>

          <div className="flex flex-col items-end gap-1 shrink-0">
            {isEditing && (
              <span className="px-1.5 py-0.5 text-[11px] font-mono font-semibold uppercase bg-[#1d4ed8] text-white">
                Editing
              </span>
            )}
            {!isEnabled && (
              <span className="px-1.5 py-0.5 text-[11px] font-mono uppercase bg-[#fef2f2] border border-[#fecaca] text-[#dc2626]">
                Disabled
              </span>
            )}
            <span className="px-1.5 py-0.5 text-[11px] font-mono bg-[#f1f3ff] border border-[#c4c5d7] text-[#434655]">
              {route.provider}
            </span>
          </div>
        </div>

        {/* 4-Column Structured Metadata Matrix */}
        <div className="grid grid-cols-2 gap-1.5 bg-[#f8f9fa] border border-[#e5e7eb] p-2 text-[11px] font-mono my-2">
          <div>
            <span className="text-[#434655] block text-[11px]">Model:</span>
            <span className="font-semibold text-[#141b2b] truncate block" title={route.model}>
              {route.model}
            </span>
          </div>
          <div>
            <span className="text-[#434655] block text-[11px]">Effort:</span>
            <span className="text-[#141b2b] uppercase font-semibold">
              {route.effort || "default"}
            </span>
          </div>
          <div>
            <span className="text-[#434655] block text-[11px]">Scope:</span>
            <span
              className={`font-semibold ${
                isWorker ? "text-[#1d4ed8]" : "text-[#92400e]"
              }`}
            >
              {isWorker ? "WORKSPACE_WRITE" : "READ_ONLY"}
            </span>
          </div>
          <div>
            <span className="text-[#434655] block text-[11px]">Subagents:</span>
            <span className="text-[#141b2b]">
              {route.native_subagents?.mode === "prefer"
                ? `prefer (${route.native_subagents.max_agents ?? 2})`
                : route.native_subagents?.mode ?? "off"}
            </span>
          </div>
        </div>

        {/* Tags */}
        <div className="flex flex-wrap gap-1 mt-2">
          {tags.map((t) => (
            <span
              key={t}
              className={`px-1.5 py-0.5 text-[11px] font-mono ${
                t === "multi-agent"
                  ? "bg-[#dce1ff] text-[#1d4ed8] border border-[#cad3ff]"
                  : "bg-[#f1f3ff] text-[#434655] border border-[#c4c5d7]"
              }`}
            >
              #{t}
            </span>
          ))}
        </div>
      </div>

      {/* Row Actions */}
      <div className="pt-2.5 mt-2.5 border-t border-[#e5e7eb] flex items-center justify-between">
        <button
          type="button"
          className="text-xs text-[#434655] hover:text-[#141b2b] cursor-pointer"
          onClick={() => toggleRouteEnabledAction(route.route_id)}
          title={isEnabled ? "Disable profile" : "Enable profile"}
        >
          {isEnabled ? "Disable" : "Enable"}
        </button>

        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-1 text-[#434655] hover:text-[#1d4ed8] cursor-pointer"
            onClick={() => duplicateRouteAction(route)}
            title="Duplicate profile"
          >
            <CopyIcon size={14} />
          </button>
          <button
            type="button"
            className="p-1 text-[#434655] hover:text-[#dc2626] cursor-pointer"
            onClick={() => deleteRouteAction(route.route_id)}
            title="Delete profile"
          >
            <TrashIcon size={14} />
          </button>
          <button
            type="button"
            className="h-7 px-2.5 bg-white border border-[#c4c5d7] text-xs font-medium text-[#141b2b] hover:bg-[#e9edff] flex items-center gap-1 cursor-pointer ml-1"
            onClick={() => startEditRoute(route, false)}
          >
            <EditIcon size={12} />
            <span>Edit</span>
          </button>
        </div>
      </div>
    </div>
  );
}

// Model & Effort Selector dropdown helper
function ModelSelector({
  provider,
  selectedModel,
  selectedEffort,
  onModelChange,
  onEffortChange,
}: {
  provider: string;
  selectedModel: string;
  selectedEffort: string;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
}): JSX.Element {
  const observation = catalogObservations.value.get(provider);
  const models = observation?.models ?? [selectedModel];
  const options = observation
    ? catalogModelOptions.value.get(provider) ?? []
    : parseModelOptions(provider, models);

  return (
    <div className="space-y-1.5">
      <div>
        <label htmlFor="prof-model-select" className="block text-[11px] text-[#434655] mb-0.5">
          Model
        </label>
        <select
          id="prof-model-select"
          className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
          value={selectedModel}
          onChange={(e) => {
            const nextModel = (e.target as HTMLSelectElement).value;
            onModelChange(nextModel);
          }}
        >
          {options.map((opt) => (
            <option key={opt.model} value={opt.model}>
              {opt.model}
            </option>
          ))}
          {!options.some((o) => o.model === selectedModel) && (
            <option value={selectedModel}>{selectedModel} (custom)</option>
          )}
        </select>
      </div>

      <EffortSelector
        provider={provider}
        selectedModel={selectedModel}
        selectedEffort={selectedEffort}
        onEffortChange={onEffortChange}
      />
    </div>
  );
}

function EffortSelector({
  provider,
  selectedModel,
  selectedEffort,
  onEffortChange,
}: {
  provider: string;
  selectedModel: string;
  selectedEffort: string;
  onEffortChange: (effort: string) => void;
}): JSX.Element {
  const observation = catalogObservations.value.get(provider);
  const modelOption = catalogModelOptions.value.get(provider)?.find((option) => option.model === selectedModel);
  const observed = Boolean(observation);
  const hasObservedOptions = observed && Boolean(modelOption);
  const efforts = hasObservedOptions
    ? [...modelOption!.efforts]
    : ["", "low", "medium", "high", "max"];
  // The configured default is also a value: preserve it when the catalogue
  // reports only explicit effort variants, rather than visually selecting low.
  if (!efforts.includes(selectedEffort)) efforts.push(selectedEffort);
  const configuredIsUnverified = observed
    ? !modelOption?.efforts.includes(selectedEffort)
    : selectedEffort !== "";

  return (
    <div>
      <label htmlFor="prof-effort-select" className="block text-[11px] text-[#434655] mb-0.5">
        Effort
      </label>
      <select
        id="prof-effort-select"
        className="w-full h-8 px-2 border border-[#c4c5d7] font-mono text-xs bg-white focus:border-[#1d4ed8] cursor-pointer"
        value={selectedEffort}
        onChange={(e) => onEffortChange((e.target as HTMLSelectElement).value)}
      >
        {efforts.map((effort) => {
          const unverified = !hasObservedOptions || (effort === selectedEffort && configuredIsUnverified);
          return (
            <option key={effort} value={effort}>
              {`${effort === "" ? "(provider default)" : effort}${unverified ? (effort === selectedEffort ? " (configured, unverified)" : " (unverified)") : ""}`}
            </option>
          );
        })}
      </select>
      {!observed && (
        <p className="mt-1 text-[11px] text-[#8a4b08]">
          Effort choices are unverified until catalogue refresh.
        </p>
      )}
      {observed && !modelOption && (
        <p className="mt-1 text-[11px] text-[#8a4b08]">
          Model was not reported by the current catalogue. Effort choices are unverified.
        </p>
      )}
      {hasObservedOptions && configuredIsUnverified && (
        <p className="mt-1 text-[11px] text-[#8a4b08]">
          Configured effort was not reported by the current catalogue.
        </p>
      )}
    </div>
  );
}
