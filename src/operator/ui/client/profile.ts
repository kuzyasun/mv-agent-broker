import type {
  HostDisplayPreferences,
  ModelOption,
  OperatorAccount,
  OperatorPolicyProfile,
  OperatorRoute,
} from "./types.ts";

export const DERIVED_MULTI_AGENT_TAG = "multi-agent";

let displayFormatter: Intl.DateTimeFormat | null = null;
let cachedPreferences: HostDisplayPreferences | null = null;

export function formatTimestamp(
  value: number | null | undefined,
  prefs?: HostDisplayPreferences | null,
): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";

  if (prefs && (!displayFormatter || prefs !== cachedPreferences)) {
    try {
      const options: Intl.DateTimeFormatOptions = {
        timeZone: prefs.timeZone || undefined,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      };
      if (
        prefs.hourCycle === "h11" ||
        prefs.hourCycle === "h12" ||
        prefs.hourCycle === "h23" ||
        prefs.hourCycle === "h24"
      ) {
        options.hourCycle = prefs.hourCycle;
      }
      displayFormatter = new Intl.DateTimeFormat(prefs.locale || undefined, options);
      cachedPreferences = prefs;
    } catch {
      displayFormatter = null;
    }
  }

  return displayFormatter ? displayFormatter.format(date) : date.toLocaleString();
}

export function effectiveRouteTags(
  route: Pick<OperatorRoute, "tags" | "native_subagents">,
): string[] {
  const mode = route.native_subagents?.mode;
  const isMultiAgent = mode === "prefer" || mode === "auto";
  const stored = route.tags ?? [];
  if (isMultiAgent) {
    return Array.from(new Set([...stored, DERIVED_MULTI_AGENT_TAG]));
  }
  return [...stored];
}

export function isReadOnlyRole(role: string): boolean {
  return role === "reviewer" || role === "researcher";
}

export function roleDisplayName(role: string): string {
  switch (role) {
    case "reviewer":
      return "Reviewer";
    case "researcher":
      return "Researcher";
    case "worker":
    default:
      return "Worker";
  }
}

export function findReadOnlyPolicy(policies: OperatorPolicyProfile[]): string | undefined {
  const strict = policies.find((p) => p.config?.access === "read_only");
  if (strict) return strict.policy_profile_id;
  const fallback = policies.find((p) =>
    p.policy_profile_id.toLowerCase().includes("read-only"),
  );
  return fallback?.policy_profile_id;
}

export function generateUniqueRouteId(baseId: string, existingRoutes: OperatorRoute[]): string {
  const existingIds = new Set(existingRoutes.map((r) => r.route_id));
  if (!existingIds.has(baseId)) return baseId;
  let counter = 2;
  while (existingIds.has(`${baseId}-${counter}`)) {
    counter += 1;
  }
  return `${baseId}-${counter}`;
}

export function duplicateRoute(
  source: OperatorRoute,
  allRoutes: OperatorRoute[],
): OperatorRoute {
  const newId = generateUniqueRouteId(`${source.route_id}-copy`, allRoutes);
  const displayName = source.display_name ? `${source.display_name} (Copy)` : undefined;
  return {
    ...JSON.parse(JSON.stringify(source)),
    route_id: newId,
    display_name: displayName,
  };
}

export function createDefaultRoute(
  projectId: string,
  allRoutes: OperatorRoute[],
  accounts: OperatorAccount[],
  policies: OperatorPolicyProfile[],
  role: "worker" | "reviewer" | "researcher" = "worker",
): OperatorRoute {
  const account = accounts[0];
  const provider = account?.provider ?? "mock";
  const accountId = account?.account_profile_id ?? "default-account";

  let policyId = policies[0]?.policy_profile_id ?? "default-policy";
  if (isReadOnlyRole(role)) {
    const readPolicy = findReadOnlyPolicy(policies);
    if (readPolicy) policyId = readPolicy;
  }

  const baseId = `${provider}-${role}`;
  const routeId = generateUniqueRouteId(baseId, allRoutes);

  return {
    route_id: routeId,
    project_id: projectId,
    provider,
    account_profile_id: accountId,
    model: "mock-model-1",
    role,
    policy_profile_id: policyId,
    display_name: `New ${roleDisplayName(role)}`,
    enabled: true,
    tags: ["default"],
  };
}

export function filterRoutes(
  routes: OperatorRoute[],
  filters: {
    projectId?: string;
    search?: string;
    tag?: string;
  },
): OperatorRoute[] {
  return routes.filter((route) => {
    if (filters.projectId && filters.projectId !== "" && route.project_id !== filters.projectId) {
      return false;
    }
    if (filters.tag && filters.tag !== "") {
      const allTags = effectiveRouteTags(route);
      if (!allTags.includes(filters.tag)) {
        return false;
      }
    }
    if (filters.search && filters.search.trim() !== "") {
      const q = filters.search.trim().toLowerCase();
      const matchId = route.route_id.toLowerCase().includes(q);
      const matchName = route.display_name?.toLowerCase().includes(q) ?? false;
      const matchModel = route.model.toLowerCase().includes(q);
      const matchProvider = route.provider.toLowerCase().includes(q);
      if (!matchId && !matchName && !matchModel && !matchProvider) {
        return false;
      }
    }
    return true;
  });
}

export function groupRoutesByRole(routes: OperatorRoute[]): {
  workers: OperatorRoute[];
  reviewers: OperatorRoute[];
  researchers: OperatorRoute[];
} {
  const workers: OperatorRoute[] = [];
  const reviewers: OperatorRoute[] = [];
  const researchers: OperatorRoute[] = [];

  for (const route of routes) {
    if (route.role === "reviewer") reviewers.push(route);
    else if (route.role === "researcher") researchers.push(route);
    else workers.push(route);
  }

  return { workers, reviewers, researchers };
}

export function parseModelOptions(provider: string, models: string[]): ModelOption[] {
  const map = new Map<string, Set<string>>();
  for (const id of models) {
    if (provider === "zcode") {
      if (id === "GLM-5.3" || id === "GLM-5.3-Flash") {
        for (const effort of ["low", "high", "max"]) {
          const s = map.get(id) ?? new Set<string>();
          s.add(effort);
          map.set(id, s);
        }
      } else {
        const s = map.get(id) ?? new Set<string>();
        map.set(id, s);
      }
      continue;
    }

    const match =
      provider === "cursor"
        ? /^(.*?)-(none|low|normal|medium|high|xhigh|max)(-fast)?$/i.exec(id)
        : provider === "antigravity"
          ? /^(.*?)-(low|medium|high|max)$/i.exec(id)
          : null;

    if (match) {
      const parent = provider === "cursor" && match[3] ? id : match[1] ?? id;
      const effort = match[2];
      const s = map.get(parent) ?? new Set<string>();
      if (effort) s.add(effort.toLowerCase());
      map.set(parent, s);

      if (provider === "cursor") {
        const idSet = map.get(id) ?? new Set<string>();
        idSet.add("");
        if (effort) idSet.add(effort.toLowerCase());
        map.set(id, idSet);
      }
    } else {
      const s = map.get(id) ?? new Set<string>();
      s.add("");
      map.set(id, s);
    }
  }

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([model, efforts]) => ({
      model,
      efforts: [...efforts].sort((a, b) => {
        const order = ["", "none", "low", "normal", "medium", "high", "xhigh", "max"];
        return order.indexOf(a) - order.indexOf(b);
      }),
    }));
}
