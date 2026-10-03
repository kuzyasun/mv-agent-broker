/**
 * Offline pool-UI behavior for src/operator/ui/app.js: three pools rendered
 * as native collapsed disclosures (expandable, expansion retained across
 * re-renders, auto-opened when an add or role move targets them) with counts
 * and per-pool Add, readable names, no badge while enabled plus a Disabled
 * badge and disabled card visibility, default/large chips plus the derived
 * multi-agent chip, tag filter including the derived tag, read-only policy
 * handling on role moves, and duplicate preserving metadata with a new route
 * ID. A minimal DOM stub (tests/helpers/uiDom.ts) replaces the browser;
 * interactions dispatch the same listeners the page registers.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  findPool,
  poolCards,
  waitFor,
  StubDocument,
  type StubElement,
} from "../helpers/uiDom.ts";

const config = () => ({
  version: 1,
  state_dir: "./state",
  coordinator_id: "coord-main",
  projects: [{ project_id: "project-main", display_name: "Main" }],
  coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] }],
  accounts: [{ account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
  workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: "./repo" }],
  policy_profiles: [
    { policy_profile_id: "policy-read", version: "1", config: { access: "read_only" } },
    { policy_profile_id: "policy-write", version: "1", config: { access: "workspace_write" } },
  ],
  coverage_profiles: [],
  routes: [{
    route_id: "route-worker-a",
    project_id: "project-main",
    provider: "mock",
    account_profile_id: "acct-mock",
    model: "mock-model",
    effort: "high",
    role: "worker",
    policy_profile_id: "policy-write",
    display_name: "Economical worker",
    tags: ["default"],
    native_subagents: { mode: "prefer", max_agents: 2 },
  }],
});

let document: StubDocument;
const requests: Array<{ method: string; route: string; body: unknown }> = [];
let savedConfig: ReturnType<typeof config> = config();
/** The live draft routes array the page is currently mutating. */
let draftRoutes: Array<Record<string, unknown>> = savedConfig.routes as Array<Record<string, unknown>>;

async function loadApp(): Promise<void> {
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", {
    __OPERATOR_BOOTSTRAP__: { token: "test-token", snippets: { json: "{}", toml: "" }, display: { locale: "en-US", timeZone: "UTC", hourCycle: null } },
    confirm: () => true,
  });
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal("fetch", async (route: string, options: { method?: string; body?: string } = {}) => {
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    requests.push({ method: options.method ?? "GET", route, body });
    if (route === "/api/config" && (options.method ?? "GET") === "GET") {
      // The page adopts this exact object as its draft state.
      draftRoutes = savedConfig.routes as Array<Record<string, unknown>>;
      return { ok: true, json: async () => ({ config: savedConfig, revision: "rev-1", snippets: { json: "{}", toml: "" }, display: null }) };
    }
    if (route === "/api/config" && options.method === "PUT") {
      savedConfig = body.config;
      return { ok: true, json: async () => ({ saved: true, revision: "rev-2", backup: "b", snippets: { json: "{}", toml: "" }, message: "saved" }) };
    }
    if (route === "/api/status") {
      return { ok: true, json: async () => ({ status: "stopped", readiness: "UNAVAILABLE", settings_state: "unknown", active_turns: null, error_turns: null, active_turn_count: 0, error_turn_count: 0 }) };
    }
    return { ok: true, json: async () => ({}) };
  });
  await import("../../src/operator/ui/app.js");
}

function fieldInput(card: StubElement, label: string): StubElement {
  const field = card.querySelectorAll("label").find((child) =>
    child.childNodes[0]?.textContent === label);
  if (!field) throw new Error(`field '${label}' not found`);
  return field.querySelector("input") ?? field.querySelector("select") ?? field.children[0]!;
}

/** Worker card of the fresh fixture after the pending load/reload settles. */
async function reloadFixture(): Promise<StubElement> {
  const before = requests.length;
  savedConfig = config();
  document.getElementById("reload").dispatch("click");
  await waitFor(() => requests.slice(before).some((request) => request.route === "/api/status"), "reload to settle");
  const card = poolCards(findPool(document.getElementById("routes"), "Workers")!)[0]!;
  expect(card.querySelector(".route-title")!.querySelector("h3")!.textContent).toBe("Economical worker");
  return card;
}

beforeAll(async () => {
  document = new StubDocument();
  await loadApp();
  await waitFor(() => findPool(document.getElementById("routes"), "Workers") !== null, "initial pool render");
});

beforeEach(async () => {
  requests.length = 0;
  await reloadFixture();
});

describe("operator pools UI", () => {
  it("renders three collapsed pool disclosures with counts, explanations, and per-pool Add", () => {
    const routes = document.getElementById("routes");
    for (const pool of ["Workers", "Reviewers", "Researchers"] as const) {
      const section = findPool(routes, pool);
      expect(section, pool).not.toBeNull();
      // Native disclosure: collapsed on a fresh load, keyboard operable.
      expect(section!.tagName).toBe("details");
      expect(section!.open).toBe(false);
      const summary = section!.children.find((child) => child.tagName === "summary")!;
      expect(summary.querySelector("h3")!.textContent).toBe(pool === "Workers" ? "Workers (1)" : `${pool} (0)`);
      const toolbar = section!.querySelector(".pool-toolbar")!;
      expect(toolbar.children.some((child) => child.textContent === "Add profile")).toBe(true);
      expect(section!.textContent).toContain(pool === "Workers" ? "Implement bounded tasks"
        : pool === "Reviewers" ? "Independent review sessions" : "Read-only investigation");
      expect(poolCards(section!)).toHaveLength(pool === "Workers" ? 1 : 0);
    }
  });

  it("preserves operator pool expansion across re-renders", () => {
    const routes = document.getElementById("routes");
    const workers = findPool(routes, "Workers")!;
    workers.open = true;
    workers.dispatch("toggle");
    // A chip click rerenders every pool; expansion must survive, others stay collapsed.
    const card = poolCards(workers)[0]!;
    card.querySelector(".tag-chips")!.children.find((chip) => chip.textContent === "large")!.dispatch("click");
    expect(findPool(routes, "Workers")!.open).toBe(true);
    expect(findPool(routes, "Reviewers")!.open).toBe(false);
    expect(findPool(routes, "Researchers")!.open).toBe(false);
  });

  it("auto-opens a collapsed destination pool when adding a profile", () => {
    const routes = document.getElementById("routes");
    const workers = findPool(routes, "Workers")!;
    workers.open = false;
    workers.dispatch("toggle");
    workers.querySelector(".pool-toolbar")!.children.find((child) => child.textContent === "Add profile")!.dispatch("click");
    const rendered = findPool(routes, "Workers")!;
    expect(rendered).not.toBe(workers);
    expect(rendered.open).toBe(true);
    expect(poolCards(rendered)).toHaveLength(2);
  });

  it("auto-opens the destination pool when moving a profile between pools", () => {
    const routes = document.getElementById("routes");
    const workers = findPool(routes, "Workers")!;
    workers.open = true;
    workers.dispatch("toggle");
    const card = poolCards(workers)[0]!;
    const roleSelect = fieldInput(card, "Role (move pool)");
    roleSelect.value = "researcher";
    roleSelect.dispatch("change");
    expect(findPool(routes, "Researchers")!.open).toBe(true);
    expect(findPool(routes, "Workers")!.open).toBe(true);
  });

  it("shows the readable name without an enabled badge, and the derived multi-agent chip", () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers")!)[0]!;
    const title = card.querySelector(".route-title")!;
    expect(title.querySelector("h3")!.textContent).toBe("Economical worker");
    // An enabled profile carries no badge; only the disabled state is badged.
    expect(title.children.filter((child) => child.classList.contains("pill"))).toHaveLength(0);
    // Derived chip is a non-button span next to the default/large chip buttons.
    const chipsRow = card.querySelector(".tag-chips")!;
    const chips = chipsRow.children.slice(1);
    expect(chips.map((chip) => chip.textContent)).toEqual(["default", "large", "multi-agent"]);
    expect(chips[0]!.getAttribute("aria-pressed")).toBe("true");
    expect(chips[1]!.getAttribute("aria-pressed")).toBe("false");
    expect(chips[2]!.tagName).toBe("span");
    expect(card.querySelector(".route-summary")!.textContent).toContain("tags default, multi-agent");
  });

  it("keeps the profile-name input mounted throughout typing and updates its heading", () => {
    const pool = findPool(document.getElementById("routes"), "Workers")!;
    const card = poolCards(pool)[0]!;
    const name = fieldInput(card, "Profile name");
    for (const value of ["New", "New name", ""]) {
      name.value = value;
      name.dispatch("input");
      expect(poolCards(findPool(document.getElementById("routes"), "Workers"))[0]).toBe(card);
      expect(fieldInput(card, "Profile name")).toBe(name);
      expect(card.querySelector(".route-title")!.querySelector("h3")!.textContent).toBe(value || "route-worker-a");
    }
  });

  it("disables a profile through the toggle and keeps the disabled card editable and visible", async () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers")!)[0]!;
    const checkbox = card.querySelector("input")!;
    checkbox.checked = false;
    checkbox.dispatch("change");
    const disabledCard = poolCards(findPool(document.getElementById("routes"), "Workers")!)[0]!;
    expect(disabledCard.classList.contains("is-disabled")).toBe(true);
    expect(disabledCard.querySelector(".route-title")!.querySelector(".pill")!.textContent).toBe("Disabled");
    expect(fieldInput(disabledCard, "Profile name").value).toBe("Economical worker");
    // The disabled card stays editable and its draft keeps enabled: false.
    const nameInput = fieldInput(disabledCard, "Profile name");
    nameInput.value = "Renamed while disabled";
    nameInput.dispatch("input");
    await waitFor(() => draftRoutes[0]?.display_name === "Renamed while disabled", "renamed draft route");
    expect(draftRoutes[0]?.enabled).toBe(false);

    const before = requests.length;
    document.getElementById("save").dispatch("click");
    await waitFor(() => requests.slice(before).some((request) => request.route === "/api/status"), "save to settle");
    const put = requests.slice(before).find((request) => request.method === "PUT")!;
    const savedRoute = (put.body as { config: { routes: Array<Record<string, unknown>> } }).config.routes[0];
    expect(savedRoute).toMatchObject({ enabled: false, display_name: "Renamed while disabled", tags: ["default"] });
  });

  it("toggles default and large chips and validates custom tags", async () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers")!)[0]!;
    const large = card.querySelector(".tag-chips")!.children.filter((chip) => chip.textContent === "large")[0]!;
    large.dispatch("click");
    await waitFor(() => (draftRoutes[0]?.tags as string[]).includes("large"), "large chip toggled");
    expect(draftRoutes[0]?.tags).toEqual(["default", "large"]);

    const editingCard = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    const custom = fieldInput(editingCard, "Custom tags (comma separated)");
    custom.value = "Fast-Track, windows_only";
    custom.dispatch("input");
    await waitFor(() => (draftRoutes[0]?.tags as string[]).join(",") === "fast-track,windows_only", "custom tags applied");
    custom.value = "multi-agent";
    custom.dispatch("input");
    expect(draftRoutes[0]?.tags).toEqual(["multi-agent"]);
    expect(document.getElementById("status").textContent).toContain("cannot be stored");
    document.getElementById("save").dispatch("click");
    await waitFor(() => document.getElementById("save").disabled === false, "invalid save to settle");
    expect(requests.some(request => request.method === "PUT")).toBe(false);
    expect(document.getElementById("change-label").textContent).toBe("Unsaved changes");
    custom.value = "default, fast-track";
    custom.dispatch("input");
    expect(custom.getAttribute("aria-invalid")).toBe("false");
    expect(editingCard.querySelector(".route-summary")!.textContent).toContain("fast-track");
    expect(document.getElementById("tag-filter").children.map(child => child.textContent)).toContain("fast-track");
  });

  it("filters pools by an effective tag including the derived multi-agent tag", () => {
    const filter = document.getElementById("tag-filter");
    // Options come from effective tags at render time: stored default plus
    // the derived multi-agent tag; large appears once a profile stores it.
    expect(filter.children.map((child) => child.textContent)).toEqual(["All tags", "default", "multi-agent"]);
    filter.value = "multi-agent";
    filter.dispatch("change");
    expect(poolCards(findPool(document.getElementById("routes"), "Workers"))).toHaveLength(1);
    expect(poolCards(findPool(document.getElementById("routes"), "Reviewers"))).toHaveLength(0);
    const emptyPool = findPool(document.getElementById("routes"), "Reviewers")!;
    expect(emptyPool.textContent).toContain("No profiles in this pool match the tag filter.");
    filter.value = "";
    filter.dispatch("change");
    expect(poolCards(findPool(document.getElementById("routes"), "Workers"))).toHaveLength(1);
  });

  it("restricts reviewer and researcher moves to read-only policies", async () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    const roleSelect = fieldInput(card, "Role (move pool)");
    roleSelect.value = "reviewer";
    roleSelect.dispatch("change");
    const moved = poolCards(findPool(document.getElementById("routes"), "Reviewers"))[0]!;
    // Exactly one read-only policy exists: it is selected unambiguously.
    expect(draftRoutes[0]?.policy_profile_id).toBe("policy-read");
    const policyOptions = fieldInput(moved, "Explicit policy").children.map((child) => child.textContent);
    expect(policyOptions).toEqual(["policy-read · read_only"]);

    // Zero read-only policies: the choice stays explicitly unresolved.
    savedConfig = { ...config(), policy_profiles: [{ policy_profile_id: "policy-write", version: "1", config: { access: "workspace_write" } }] } as ReturnType<typeof config>;
    const before = requests.length;
    document.getElementById("reload").dispatch("click");
    await waitFor(() => requests.slice(before).some((request) => request.route === "/api/status"), "write-only reload");
    const writeCard = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    const select = fieldInput(writeCard, "Role (move pool)");
    select.value = "researcher";
    select.dispatch("change");
    expect(draftRoutes[0]?.policy_profile_id).toBe("");
    const researcherCard = poolCards(findPool(document.getElementById("routes"), "Researchers"))[0]!;
    const unresolved = fieldInput(researcherCard, "Explicit policy");
    expect(unresolved.children[0]!.textContent).toBe("Choose a read-only policy");
  });

  it("adds workers with the project's write policy even when a read-only policy is first", () => {
    const filter = document.getElementById("tag-filter");
    filter.value = "multi-agent";
    filter.dispatch("change");
    const pool = findPool(document.getElementById("routes"), "Workers")!;
    pool.querySelector(".pool-toolbar")!.children.find(child => child.textContent === "Add profile")!.dispatch("click");
    expect(poolCards(findPool(document.getElementById("routes"), "Workers"))).toHaveLength(2);
    expect(document.getElementById("tag-filter").children[0]!.selected).toBe(true);
    expect(draftRoutes[1]).toMatchObject({ role: "worker", policy_profile_id: "policy-write" });
  });

  it("refuses a chip addition beyond the stored-tag budget", () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    const custom = fieldInput(card, "Custom tags (comma separated)");
    const tags = Array.from({ length: 12 }, (_, i) => `tag-${i}`);
    custom.value = tags.join(", ");
    custom.dispatch("input");
    card.querySelector(".tag-chips")!.children.find(chip => chip.textContent === "large")!.dispatch("click");
    expect(draftRoutes[0]?.tags).toEqual(tags);
    expect(document.getElementById("status").textContent).toContain("At most 12");
  });

  it("duplicates a profile with all metadata and a distinct technical ID", async () => {
    const card = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    const duplicate = card.querySelector(".route-actions")!.children.find((child) => child.textContent === "Duplicate")!;
    duplicate.dispatch("click");
    await waitFor(() => draftRoutes.length === 2, "duplicate appended");
    const [original, copy] = draftRoutes;
    expect(copy.route_id).not.toBe(original.route_id);
    expect(copy).toMatchObject({
      display_name: "Economical worker",
      tags: ["default"],
      role: "worker",
      effort: "high",
      native_subagents: { mode: "prefer", max_agents: 2 },
    });
    expect(poolCards(findPool(document.getElementById("routes"), "Workers"))).toHaveLength(2);
  });

  it("keeps save/reload round-trip preserving model, effort, and subagent settings", async () => {
    let before = requests.length;
    document.getElementById("save").dispatch("click");
    await waitFor(() => requests.slice(before).some((request) => request.route === "/api/status"), "save to settle");
    before = requests.length;
    document.getElementById("reload").dispatch("click");
    await waitFor(() => requests.slice(before).some((request) => request.route === "/api/status"), "reload to settle");
    const card = poolCards(findPool(document.getElementById("routes"), "Workers"))[0]!;
    expect(fieldInput(card, "Role (move pool)").value).toBe("worker");
    const cardText = card.textContent;
    expect(cardText).toContain("Prefer subagents");
    expect(cardText).toContain("tags default, multi-agent");
    expect(fieldInput(card, "Effort (parent/model limits apply)").value).toBe("high");
  });
});
