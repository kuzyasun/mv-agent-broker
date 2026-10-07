import type { JSX } from "preact";
import { useEffect } from "preact/hooks";
import { Header } from "./components/Header.tsx";
import { NavigationRail } from "./components/NavigationRail.tsx";
import { ActionToast } from "./components/ActionToast.tsx";
import {
  activeSection,
  initNavigation,
  loadConfiguration,
  startStatusPolling,
  stopStatusPolling,
} from "./store.ts";
import { PoolsSection } from "./sections/PoolsSection.tsx";
import { ProjectsSection } from "./sections/ProjectsSection.tsx";
import { OverviewSection } from "./sections/OverviewSection.tsx";
import { LimitsSection } from "./sections/LimitsSection.tsx";
import { StorageSection } from "./sections/StorageSection.tsx";
import { ConnectionSection } from "./sections/ConnectionSection.tsx";
import { AdvancedSection } from "./sections/AdvancedSection.tsx";

export function App(): JSX.Element {
  useEffect(() => {
    initNavigation();
    void loadConfiguration(true);
    startStatusPolling();
    return () => {
      stopStatusPolling();
    };
  }, []);

  const section = activeSection.value;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <Header />
      <ActionToast />
      <div className="flex flex-1 overflow-hidden">
        <NavigationRail />
        <main className="flex-1 flex overflow-hidden">
          {section === "pools" && <PoolsSection />}
          {section === "projects" && <ProjectsSection />}
          {section === "overview" && <OverviewSection />}
          {section === "limits" && <LimitsSection />}
          {section === "storage" && <StorageSection />}
          {section === "connection" && <ConnectionSection />}
          {section === "advanced" && <AdvancedSection />}
        </main>
      </div>
    </div>
  );
}
