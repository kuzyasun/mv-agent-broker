import type { JSX } from "preact";
import {
  activeSection,
  draftConfig,
  setSection,
  statusData,
  type NavSection,
} from "../store.ts";
import {
  CodeIcon,
  DashboardIcon,
  DatabaseIcon,
  FolderIcon,
  HubIcon,
  LinkIcon,
  MemoryIcon,
  SlidersIcon,
} from "./Icons.tsx";

interface NavItemConfig {
  id: NavSection;
  label: string;
  icon: (props: { size?: number; className?: string }) => JSX.Element;
}

const NAV_ITEMS: NavItemConfig[] = [
  { id: "overview", label: "Overview", icon: DashboardIcon },
  { id: "projects", label: "Projects", icon: FolderIcon },
  { id: "pools", label: "Agent Pools", icon: HubIcon },
  { id: "limits", label: "Limits", icon: SlidersIcon },
  { id: "storage", label: "Storage", icon: DatabaseIcon },
  { id: "connection", label: "Connection", icon: LinkIcon },
  { id: "advanced", label: "Advanced", icon: CodeIcon },
];

export function NavigationRail(): JSX.Element {
  const currentSection = activeSection.value;
  const coordinatorId = draftConfig.value?.coordinator_id ?? "operator";
  const version = statusData.value?.runtime_version ?? "v0.3.0";

  return (
    <aside className="w-[220px] bg-[#f1f3ff] border-r border-[#c4c5d7] flex flex-col justify-between shrink-0 select-none">
      <div className="p-2 space-y-3">
        {/* Profile Card */}
        <div className="px-2.5 py-2 border-b border-[#c4c5d7] flex items-center gap-2.5 bg-white">
          <div className="w-7 h-7 bg-[#1d4ed8] text-white flex items-center justify-center font-bold text-sm shrink-0">
            <MemoryIcon size={16} />
          </div>
          <div className="overflow-hidden min-w-0">
            <div className="text-[13px] font-semibold text-[#141b2b] truncate leading-tight">
              {coordinatorId}
            </div>
            <div className="text-[11px] font-mono text-[#747686] leading-tight mt-0.5">
              {version}
            </div>
          </div>
        </div>

        {/* Navigation Items */}
        <nav className="space-y-0.5" aria-label="Main Navigation">
          {NAV_ITEMS.map((item) => {
            const isActive = currentSection === item.id;
            const IconComponent = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                aria-current={isActive ? "page" : undefined}
                className={`w-full flex items-center gap-2.5 px-2.5 h-8 text-[13px] whitespace-nowrap text-left transition-none cursor-pointer ${
                  isActive
                    ? "bg-[#d6e0f4] text-[#1d4ed8] font-semibold border-l-[3px] border-[#1d4ed8]"
                    : "text-[#434655] hover:bg-[#e9edff] border-l-[3px] border-transparent"
                }`}
                onClick={() => setSection(item.id)}
              >
                <IconComponent
                  size={16}
                  className={isActive ? "text-[#1d4ed8]" : "text-[#434655]"}
                />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Info */}
      <div className="p-2.5 border-t border-[#c4c5d7] text-[11px] font-mono bg-[#f8f9fa] space-y-1">
        <div className="flex items-center justify-between text-[#141b2b]">
          <div className="flex items-center gap-1.5 truncate">
            <span
              className={`w-2 h-2 shrink-0 ${
                statusData.value?.status === "ready" ? "bg-[#059669]" : "bg-[#d97706]"
              }`}
            />
            <span className="font-medium truncate">
              {statusData.value?.daemon_pid
                ? `PID ${statusData.value.daemon_pid}: READY`
                : "Daemon: Stopped"}
            </span>
          </div>
          <span className="text-[#434655]">TCP</span>
        </div>
        <div className="flex items-center justify-between text-[#434655]">
          <span className="truncate">
            Commit #{statusData.value?.runtime_commit?.slice(0, 7) ?? "local"}
          </span>
          <span>{version}</span>
        </div>
      </div>
    </aside>
  );
}
