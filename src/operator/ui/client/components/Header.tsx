import type { JSX } from "preact";
import {
  canRestart,
  canSave,
  draftConfig,
  hasUnappliedEditor,
  isGlobalDirty,
  isReloading,
  isRestarting,
  isSaving,
  loadConfiguration,
  restartDaemonAction,
  saveConfiguration,
  selectedProject,
  statusData,
} from "../store.ts";
import { HubIcon, RefreshIcon, RestartIcon, SaveIcon } from "./Icons.tsx";

export function Header(): JSX.Element {
  const projects = draftConfig.value?.projects ?? [];
  const status = statusData.value;

  let statusBadge: JSX.Element;
  if (hasUnappliedEditor.value) {
    statusBadge = (
      <div className="flex items-center gap-2 px-2.5 h-7 bg-[#fffbeb] border border-[#fde68a] text-[#d97706] text-xs font-medium whitespace-nowrap">
        <span className="w-2 h-2 rounded-none bg-[#d97706] inline-block animate-pulse" />
        <span>Pending unapplied edits</span>
      </div>
    );
  } else if (isGlobalDirty.value) {
    statusBadge = (
      <div className="flex items-center gap-2 px-2.5 h-7 bg-[#fffbeb] border border-[#fde68a] text-[#d97706] text-xs font-medium whitespace-nowrap">
        <span className="w-2 h-2 rounded-none bg-[#d97706] inline-block animate-pulse" />
        <span>Unsaved changes in draft</span>
      </div>
    );
  } else if (status?.settings_state === "applied") {
    statusBadge = (
      <div className="flex items-center gap-2 px-2.5 h-7 bg-[#ecfdf5] border border-[#a7f3d0] text-[#059669] text-xs font-medium whitespace-nowrap">
        <span className="w-2 h-2 rounded-none bg-[#059669] inline-block" />
        <span>Applied to running broker</span>
      </div>
    );
  } else if (status?.settings_state === "restart_required") {
    statusBadge = (
      <div className="flex items-center gap-2 px-2.5 h-7 bg-[#fffbeb] border border-[#fde68a] text-[#d97706] text-xs font-medium whitespace-nowrap">
        <span className="w-2 h-2 rounded-none bg-[#d97706] inline-block" />
        <span>Restart required to apply saved config</span>
      </div>
    );
  } else {
    statusBadge = (
      <div className="flex items-center gap-2 px-2.5 h-7 bg-[#f1f3f5] border border-[#d1d5db] text-[#434655] text-xs font-medium whitespace-nowrap">
        <span className="w-2 h-2 rounded-none bg-[#747686] inline-block" />
        <span>Configuration saved</span>
      </div>
    );
  }

  const restartDisabledReason = (() => {
    if (isSaving.value) return "Cannot restart while saving configuration";
    if (isRestarting.value) return "Restart in progress";
    if (hasUnappliedEditor.value) return "Apply or discard editor changes before restarting";
    if (isGlobalDirty.value) return "Save configuration before restarting daemon";
    const active = status?.active_turn_count ?? 0;
    if (active > 0) return `Cannot restart while ${active} active turn(s) running`;
    return "Restart idle daemon on the same accepted runtime";
  })();

  return (
    <header className="bg-white border-b border-[#c4c5d7] h-10 px-3 flex items-center justify-between z-30 shrink-0">
      <div className="flex items-center space-x-3">
        {/* Brand */}
        <div className="flex items-center gap-2 whitespace-nowrap">
          <HubIcon className="text-[#1d4ed8]" size={18} />
          <span className="text-[14px] font-semibold text-[#141b2b] tracking-tight">
            Agent Broker
          </span>
        </div>

        <div className="h-4 w-[1px] bg-[#c4c5d7]" />

        {/* Project Selector */}
        <div className="flex items-center gap-1.5 bg-[#f1f3ff] border border-[#c4c5d7] px-2.5 h-7">
          <label htmlFor="project-filter-select" className="text-xs font-medium text-[#747686] whitespace-nowrap">
            PROJECT:
          </label>
          <select
            id="project-filter-select"
            className="bg-transparent text-xs font-semibold text-[#141b2b] border-none py-0 pl-1 pr-4 h-5 focus:ring-0 cursor-pointer outline-none"
            value={selectedProject.value}
            onChange={(e) => {
              selectedProject.value = (e.target as HTMLSelectElement).value;
            }}
          >
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.display_name || p.project_id}
              </option>
            ))}
          </select>
        </div>

        {/* Config Status Indicator */}
        {statusBadge}
      </div>

      {/* Trailing Actions */}
      <div className="flex items-center space-x-2">
        <button
          type="button"
          className="h-7 px-3 bg-white border border-[#c4c5d7] text-[#141b2b] text-xs font-medium hover:bg-[#e9edff] active:bg-[#e1e8fd] disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
          disabled={isReloading.value || isSaving.value}
          onClick={() => void loadConfiguration()}
          title="Reload configuration from disk"
        >
          <RestartIcon size={14} />
          <span>{isReloading.value ? "Reloading…" : "Reload"}</span>
        </button>

        <button
          type="button"
          className={`h-7 px-3 border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-none ${
            canSave.value
              ? "bg-[#1d4ed8] border-[#1d4ed8] text-white hover:bg-[#1e40af] active:bg-[#1e3a8a] cursor-pointer"
              : "bg-[#f1f3f5] border-[#c4c5d7] text-[#747686] cursor-not-allowed"
          }`}
          disabled={!canSave.value}
          onClick={() => void saveConfiguration()}
          title={
            hasUnappliedEditor.value
              ? "Apply editor changes first"
              : isGlobalDirty.value
                ? "Save configuration to disk"
                : "No unsaved changes"
          }
        >
          <SaveIcon size={14} />
          <span>{isSaving.value ? "Saving…" : "Save configuration"}</span>
        </button>

        <div className="relative group">
          <button
            type="button"
            className={`h-7 px-3 border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-none ${
              canRestart.value
                ? "bg-white border-[#c4c5d7] text-[#141b2b] hover:bg-[#e9edff] active:bg-[#e1e8fd] cursor-pointer"
                : "bg-[#f1f3f5] border-[#c4c5d7] text-[#747686] cursor-not-allowed"
            }`}
            disabled={!canRestart.value}
            onClick={() => void restartDaemonAction()}
            title={restartDisabledReason}
          >
            <RefreshIcon size={14} />
            <span>{isRestarting.value ? "Restarting…" : "Restart daemon"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}
