import { batch, computed, signal } from "@preact/signals";
import {
  ApiError,
  clearQuotaPause,
  fetchConfig,
  fetchStatus,
  fetchTurnError,
  getBootstrap,
  restartDaemon,
  saveConfig,
} from "./api.ts";
import {
  duplicateRoute,
  effectiveRouteTags,
} from "./profile.ts";
import type {
  CatalogObservation,
  ConnectionSnippets,
  HostDisplayPreferences,
  OperatorConfig,
  OperatorRoute,
  OperatorStatus,
  TurnErrorDetail,
} from "./types.ts";

export type NavSection =
  | "overview"
  | "projects"
  | "pools"
  | "limits"
  | "storage"
  | "connection"
  | "advanced";

const VALID_SECTIONS: NavSection[] = [
  "overview",
  "projects",
  "pools",
  "limits",
  "storage",
  "connection",
  "advanced",
];

// Navigation & Filters
export const activeSection = signal<NavSection>("pools");
export const selectedProject = signal<string>("");
export const tagFilter = signal<string>("");
export const searchQuery = signal<string>("");

// Configuration layers
export const savedConfig = signal<OperatorConfig | null>(null);
export const savedRevision = signal<string>("");
export const draftConfig = signal<OperatorConfig | null>(null);
export const connectionSnippets = signal<ConnectionSnippets | null>(null);
export const displayPreferences = signal<HostDisplayPreferences | null>(null);

// Route Profile Inspector state
export const editingRouteId = signal<string | null>(null);
export const routeDraft = signal<OperatorRoute | null>(null);
export const originalRouteInDraft = signal<OperatorRoute | null>(null);
export const isNewRoute = signal<boolean>(false);

// Advanced editor state
export interface AdvancedDraftState {
  accountsJson: string;
  pinsJson: string;
  stateDir: string;
  coverageJson: string;
}
export const advancedDraft = signal<AdvancedDraftState | null>(null);
export const advancedError = signal<string | null>(null);

// Live Status & Turn errors
export const statusData = signal<OperatorStatus | null>(null);
export const statusLoading = signal<boolean>(false);
export const statusError = signal<string | null>(null);
export const selectedTurnError = signal<TurnErrorDetail | null>(null);
export const turnErrorLoading = signal<boolean>(false);

// Catalog cache
export const catalogObservations = signal<Map<string, CatalogObservation>>(new Map());

// Operation state & feedback
export const isSaving = signal<boolean>(false);
export const isReloading = signal<boolean>(false);
export const isRestarting = signal<boolean>(false);
export const actionMessage = signal<{
  text: string;
  kind: "info" | "success" | "warning" | "error";
} | null>(null);
export const saveConflict = signal<boolean>(false);

// Derived dirty states
export const isGlobalDirty = computed(() => {
  if (!draftConfig.value || !savedConfig.value) return false;
  return JSON.stringify(draftConfig.value) !== JSON.stringify(savedConfig.value);
});

export const isRouteDraftDirty = computed(() => {
  if (!routeDraft.value) return false;
  if (!originalRouteInDraft.value) return true;
  return JSON.stringify(routeDraft.value) !== JSON.stringify(originalRouteInDraft.value);
});

export const isAdvancedDirty = computed(() => {
  if (!advancedDraft.value || !draftConfig.value) return false;
  try {
    const currentAccounts = JSON.stringify(draftConfig.value.accounts ?? [], null, 2);
    const currentPins = JSON.stringify(draftConfig.value.native_binary_pins ?? {}, null, 2);
    const currentState = draftConfig.value.state_dir ?? "";
    const currentCoverage = JSON.stringify(draftConfig.value.coverage_profiles ?? [], null, 2);

    return (
      advancedDraft.value.accountsJson !== currentAccounts ||
      advancedDraft.value.pinsJson !== currentPins ||
      advancedDraft.value.stateDir !== currentState ||
      advancedDraft.value.coverageJson !== currentCoverage
    );
  } catch {
    return true;
  }
});

export const hasUnappliedEditor = computed(() => {
  return isRouteDraftDirty.value || isAdvancedDirty.value;
});

export const isDirty = computed(() => {
  return isGlobalDirty.value || hasUnappliedEditor.value;
});

export const canSave = computed(() => {
  return isGlobalDirty.value && !hasUnappliedEditor.value && !isSaving.value;
});

export const canRestart = computed(() => {
  if (isSaving.value || isRestarting.value || isDirty.value) return false;
  if (!statusData.value) return false;
  const activeCount = statusData.value.active_turn_count ?? 0;
  return activeCount === 0;
});

let messageTimer: ReturnType<typeof setTimeout> | null = null;
export function setActionMessage(
  text: string,
  kind: "info" | "success" | "warning" | "error" = "info",
  duration = 5000,
): void {
  if (messageTimer) clearTimeout(messageTimer);
  actionMessage.value = { text, kind };
  if (duration > 0) {
    messageTimer = setTimeout(() => {
      actionMessage.value = null;
      messageTimer = null;
    }, duration);
  }
}

export function clearActionMessage(): void {
  if (messageTimer) clearTimeout(messageTimer);
  actionMessage.value = null;
  messageTimer = null;
}

// Navigation handling
export function setSection(section: NavSection): void {
  if (hasUnappliedEditor.value) {
    const proceed = window.confirm(
      "You have unapplied editor changes. Discard them and switch section?",
    );
    if (!proceed) return;
    cancelRouteDraft();
    cancelAdvancedDraft();
  }
  activeSection.value = section;
  window.location.hash = section;
}

export function initNavigation(): void {
  const parseHash = () => {
    const hash = window.location.hash.replace(/^#/, "") as NavSection;
    if (VALID_SECTIONS.includes(hash)) {
      activeSection.value = hash;
    } else {
      activeSection.value = "pools";
    }
  };
  parseHash();
  window.addEventListener("hashchange", parseHash);
}

// Config loading & lifecycle
export async function loadConfiguration(force = false): Promise<void> {
  if (!force && isDirty.value) {
    const proceed = window.confirm("You have unsaved changes. Discard and reload?");
    if (!proceed) return;
  }

  isReloading.value = true;
  clearActionMessage();
  saveConflict.value = false;

  try {
    const res = await fetchConfig();
    batch(() => {
      savedConfig.value = res.config;
      savedRevision.value = res.revision;
      draftConfig.value = JSON.parse(JSON.stringify(res.config));
      connectionSnippets.value = res.snippets;
      displayPreferences.value = res.display;

      // Reset editor drafts
      editingRouteId.value = null;
      routeDraft.value = null;
      originalRouteInDraft.value = null;
      isNewRoute.value = false;
      advancedDraft.value = null;
      advancedError.value = null;
    });
    setActionMessage("Configuration loaded.", "info", 3000);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setActionMessage(`Failed to load configuration: ${msg}`, "error", 0);
  } finally {
    isReloading.value = false;
  }
}

export async function saveConfiguration(): Promise<boolean> {
  if (!draftConfig.value) return false;

  if (hasUnappliedEditor.value) {
    setActionMessage(
      "Cannot save: Please apply or cancel pending edits in the open profile or advanced editor first.",
      "warning",
      7000,
    );
    return false;
  }

  isSaving.value = true;
  clearActionMessage();
  saveConflict.value = false;

  try {
    const res = await saveConfig(draftConfig.value, savedRevision.value);
    batch(() => {
      savedConfig.value = JSON.parse(JSON.stringify(draftConfig.value));
      savedRevision.value = res.revision;
      connectionSnippets.value = res.snippets;
    });
    setActionMessage(res.message || "Configuration saved successfully.", "success", 5000);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      saveConflict.value = true;
      setActionMessage(
        "Revision conflict (409): The configuration file on disk has changed. Reload to inspect the updated file.",
        "error",
        0,
      );
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      setActionMessage(`Save failed: ${msg}`, "error", 7000);
    }
    return false;
  } finally {
    isSaving.value = false;
  }
}

export async function restartDaemonAction(): Promise<boolean> {
  if (!savedRevision.value) return false;
  if (!canRestart.value) {
    setActionMessage(
      "Restart refused: cannot restart while saving, active, or with unsaved changes.",
      "warning",
      5000,
    );
    return false;
  }

  isRestarting.value = true;
  clearActionMessage();

  try {
    const res = await restartDaemon(savedRevision.value);
    setActionMessage(res.message || "Daemon restarted successfully.", "success", 5000);
    await refreshStatus();
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setActionMessage(`Restart failed: ${msg}`, "error", 7000);
    return false;
  } finally {
    isRestarting.value = false;
  }
}

// Profile Editor Actions
export function startEditRoute(route: OperatorRoute, isNew = false): void {
  if (isRouteDraftDirty.value) {
    const proceed = window.confirm(
      "You have unapplied profile edits. Discard them and edit this profile?",
    );
    if (!proceed) return;
  }

  batch(() => {
    editingRouteId.value = route.route_id;
    routeDraft.value = JSON.parse(JSON.stringify(route));
    originalRouteInDraft.value = isNew ? null : JSON.parse(JSON.stringify(route));
    isNewRoute.value = isNew;
  });
}

export function updateRouteDraftField<K extends keyof OperatorRoute>(
  field: K,
  value: OperatorRoute[K],
): void {
  if (!routeDraft.value) return;
  routeDraft.value = {
    ...routeDraft.value,
    [field]: value,
  };
}

export function applyRouteDraft(): boolean {
  if (!routeDraft.value || !draftConfig.value) return false;
  const currentDraft = routeDraft.value;

  // Basic validation
  if (!currentDraft.route_id.trim()) {
    setActionMessage("Profile Route ID cannot be empty.", "warning", 4000);
    return false;
  }
  if (!currentDraft.model.trim()) {
    setActionMessage("Model must be specified.", "warning", 4000);
    return false;
  }

  const routes = [...(draftConfig.value.routes ?? [])];
  if (isNewRoute.value) {
    const exists = routes.some((r) => r.route_id === currentDraft.route_id);
    if (exists) {
      setActionMessage(`Route ID '${currentDraft.route_id}' already exists.`, "error", 4000);
      return false;
    }
    routes.push(currentDraft);
  } else {
    const oldId = editingRouteId.value;
    const existsOther = routes.some(
      (r) => r.route_id === currentDraft.route_id && r.route_id !== oldId,
    );
    if (existsOther) {
      setActionMessage(`Route ID '${currentDraft.route_id}' is already taken.`, "error", 4000);
      return false;
    }
    const index = routes.findIndex((r) => r.route_id === oldId);
    if (index !== -1) {
      routes[index] = currentDraft;
    } else {
      routes.push(currentDraft);
    }
  }

  batch(() => {
    draftConfig.value = {
      ...draftConfig.value!,
      routes,
    };
    editingRouteId.value = null;
    routeDraft.value = null;
    originalRouteInDraft.value = null;
    isNewRoute.value = false;
  });

  setActionMessage("Profile applied to draft. Remember to Save configuration.", "info", 3000);
  return true;
}

export function cancelRouteDraft(): void {
  batch(() => {
    editingRouteId.value = null;
    routeDraft.value = null;
    originalRouteInDraft.value = null;
    isNewRoute.value = false;
  });
}

export function duplicateRouteAction(sourceRoute: OperatorRoute): void {
  if (!draftConfig.value) return;
  const duplicated = duplicateRoute(sourceRoute, draftConfig.value.routes ?? []);
  startEditRoute(duplicated, true);
}

export function deleteRouteAction(routeId: string): void {
  if (!draftConfig.value) return;
  const proceed = window.confirm(`Delete profile '${routeId}' from draft?`);
  if (!proceed) return;

  const routes = (draftConfig.value.routes ?? []).filter((r) => r.route_id !== routeId);
  batch(() => {
    draftConfig.value = {
      ...draftConfig.value!,
      routes,
    };
    if (editingRouteId.value === routeId) {
      cancelRouteDraft();
    }
  });
  setActionMessage(`Profile '${routeId}' deleted from draft.`, "info", 3000);
}

export function toggleRouteEnabledAction(routeId: string): void {
  if (!draftConfig.value) return;
  const routes = (draftConfig.value.routes ?? []).map((r) => {
    if (r.route_id === routeId) {
      const current = r.enabled !== false;
      return { ...r, enabled: !current };
    }
    return r;
  });

  draftConfig.value = {
    ...draftConfig.value,
    routes,
  };
}

// Advanced editor actions
export function initAdvancedDraft(): void {
  if (!draftConfig.value) return;
  batch(() => {
    advancedDraft.value = {
      accountsJson: JSON.stringify(draftConfig.value?.accounts ?? [], null, 2),
      pinsJson: JSON.stringify(draftConfig.value?.native_binary_pins ?? {}, null, 2),
      stateDir: draftConfig.value?.state_dir ?? "",
      coverageJson: JSON.stringify(draftConfig.value?.coverage_profiles ?? [], null, 2),
    };
    advancedError.value = null;
  });
}

export function applyAdvancedDraft(): boolean {
  if (!advancedDraft.value || !draftConfig.value) return false;
  advancedError.value = null;

  try {
    const accounts = JSON.parse(advancedDraft.value.accountsJson);
    const pins = JSON.parse(advancedDraft.value.pinsJson);
    const coverage = JSON.parse(advancedDraft.value.coverageJson);
    const stateDir = advancedDraft.value.stateDir.trim();

    if (!Array.isArray(accounts)) throw new Error("Accounts must be an array");
    if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
      throw new Error("Binary pins must be an object");
    }
    if (!Array.isArray(coverage)) throw new Error("Coverage profiles must be an array");
    if (!stateDir) throw new Error("State directory cannot be empty");

    batch(() => {
      draftConfig.value = {
        ...draftConfig.value!,
        accounts,
        native_binary_pins: pins,
        state_dir: stateDir,
        coverage_profiles: coverage,
      };
      advancedDraft.value = null;
      advancedError.value = null;
    });

    setActionMessage("Advanced settings applied to draft.", "info", 3000);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    advancedError.value = `Failed to apply: ${msg}`;
    return false;
  }
}

export function cancelAdvancedDraft(): void {
  batch(() => {
    advancedDraft.value = null;
    advancedError.value = null;
  });
}

// Status Polling
let statusInterval: ReturnType<typeof setInterval> | null = null;

export async function refreshStatus(): Promise<void> {
  if (statusLoading.value) return;
  statusLoading.value = true;
  statusError.value = null;

  try {
    const data = await fetchStatus();
    statusData.value = data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    statusError.value = msg;
  } finally {
    statusLoading.value = false;
  }
}

export function startStatusPolling(): void {
  if (statusInterval) clearInterval(statusInterval);
  void refreshStatus();
  statusInterval = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      return;
    }
    void refreshStatus();
  }, 15000);
}

export function stopStatusPolling(): void {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
}

export async function loadTurnErrorAction(turnId: string): Promise<void> {
  turnErrorLoading.value = true;
  try {
    const data = await fetchTurnError(turnId);
    selectedTurnError.value = data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setActionMessage(`Failed to inspect turn error: ${msg}`, "error", 5000);
  } finally {
    turnErrorLoading.value = false;
  }
}

export async function clearQuotaPauseAction(
  provider: string,
  quotaScopeId: string,
): Promise<void> {
  try {
    await clearQuotaPause(provider, quotaScopeId);
    setActionMessage(`Cleared quota pause for ${provider} / ${quotaScopeId}`, "success", 4000);
    await refreshStatus();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    setActionMessage(`Failed to clear quota pause: ${msg}`, "error", 5000);
  }
}
