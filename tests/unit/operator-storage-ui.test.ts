import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubDocument, StubElement, waitFor } from "../helpers/uiDom.ts";

let document: StubDocument;
let requests: Array<{ route: string; body: Record<string, unknown> }>;
let confirm: ReturnType<typeof vi.fn>;
let response: () => Promise<Record<string, unknown>>;
const preview = () => ({
  project_id: "main", retention_days: 7, cutoff_at: Date.now() - 7 * 86400000,
  preview_token: "owned-preview", expires_at: Date.now() + 300000,
  registered_blob_bytes: 1048576, registered_blob_count: 4,
  eligible_artifact_count: 2, protected_artifact_count: 1,
  reclaimable_registered_bytes: 524288, reclaimable_blob_count: 2,
  protected_reasons: [{ root_kind: "unknown_execution", count: 1 }],
  gc_blocked_reason: null,
});

beforeEach(async () => {
  vi.resetModules();
  document = new StubDocument();
  document.elements.set("storage-project", new StubElement("select"));
  requests = [];
  confirm = vi.fn(() => true);
  response = async () => preview();
  vi.stubGlobal("document", document);
  vi.stubGlobal("setInterval", () => 0);
  vi.stubGlobal("window", { __OPERATOR_BOOTSTRAP__: { token: "ui-token", snippets: { json: "{}", toml: "" } }, confirm });
  vi.stubGlobal("fetch", async (route: string, options: { body?: string } = {}) => {
    const body = options.body ? JSON.parse(options.body) : {};
    requests.push({ route, body });
    if (route === "/api/config") return { ok: true, json: async () => ({ config: {
      projects: [{ project_id: "main", display_name: "Main" }, { project_id: "other", display_name: "Other" }],
      routes: [], accounts: [], workspaces: [], policy_profiles: [], coverage_profiles: [], coordinators: [],
    }, revision: "r1", snippets: { json: "{}", toml: "" } }) };
    if (route === "/api/storage/preview") return { ok: true, json: response };
    if (route === "/api/storage/execute") return { ok: true, json: async () => ({
      project_id: "main", expired_artifact_count: 1, skipped_artifact_count: 1,
      deleted_blob_count: 1, reclaimed_registered_bytes: 262144, gc_blocked_reason: null, replayed_request: false,
    }) };
    return { ok: true, json: async () => ({ status: "stopped", readiness: "UNAVAILABLE" }) };
  });
  await import("../../src/operator/ui/app.js");
  await waitFor(() => document.getElementById("storage-project").value === "main"
    && !document.getElementById("storage-preview").disabled, "storage UI to load");
});

afterEach(async () => {
  await waitFor(() => !document.getElementById("save").disabled && !document.getElementById("storage-preview").disabled, "pending UI operations to settle");
  vi.unstubAllGlobals();
});

async function requestPreview(): Promise<void> {
  document.getElementById("storage-preview").dispatch("click");
  await waitFor(() => !document.getElementById("storage-preview").disabled, "preview request to finish");
}

describe("operator storage UI", () => {
  it("serves UI assets as valid UTF-8 without replacement characters", () => {
    for (const asset of ["app.js", "index.html", "styles.css"]) {
      const bytes = readFileSync(new URL(`../../src/operator/ui/${asset}`, import.meta.url));
      expect(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes)).not.toThrow();
    }
  });

  it("shows a small reclaimable blob in bytes instead of rounding it to zero MiB", async () => {
    response = async () => ({ ...preview(), registered_blob_bytes: 28, registered_blob_count: 1,
      reclaimable_registered_bytes: 28, reclaimable_blob_count: 1 });
    await requestPreview();
    expect(document.getElementById("storage-summary").textContent).toContain("28 B");
    expect(document.getElementById("storage-summary").textContent).not.toContain("0 MiB");
  });

  it("requires a preview and explicit confirmation, then executes only its token", async () => {
    expect(document.getElementById("storage-execute").disabled).toBe(true);
    expect(requests.some(request => request.route.startsWith("/api/storage/"))).toBe(false);
    await requestPreview();
    expect(requests.find(request => request.route === "/api/storage/preview")?.body)
      .toEqual({ project_id: "main", retention_days: 7 });
    expect(document.getElementById("storage-summary").textContent).toContain("unknown_execution");
    expect(document.getElementById("storage-execute").disabled).toBe(false);
    confirm.mockReturnValue(false);
    document.getElementById("storage-execute").dispatch("click");
    await waitFor(() => !document.getElementById("storage-execute").disabled, "cancelled confirmation");
    expect(requests.some(request => request.route === "/api/storage/execute")).toBe(false);
    confirm.mockReturnValue(true);
    document.getElementById("storage-execute").dispatch("click");
    await waitFor(() => document.getElementById("storage-message").textContent.includes("Expired 1"), "confirmed cleanup");
    expect(requests.find(request => request.route === "/api/storage/execute")?.body).toEqual({ preview_token: "owned-preview" });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Main"));
    expect(document.getElementById("storage-message").textContent).toContain("Skipped 1");
    await waitFor(() => !document.getElementById("storage-preview").disabled, "controls restored");
    expect(document.getElementById("storage-execute").disabled).toBe(true);
  });

  it("invalidates previews on retention or project change and refuses empty/invalid days", async () => {
    await requestPreview();
    const days = document.getElementById("storage-days");
    days.value = "0"; days.dispatch("input");
    expect(document.getElementById("storage-execute").disabled).toBe(true);
    expect(document.getElementById("storage-preview").disabled).toBe(false);
    for (const value of ["", "-1", "1.5", "3651"]) {
      days.value = value; days.dispatch("input");
      expect(document.getElementById("storage-preview").disabled).toBe(true);
    }
    days.value = "7"; days.dispatch("input");
    await requestPreview();
    document.getElementById("storage-project").value = "other";
    document.getElementById("storage-project").dispatch("change");
    expect(document.getElementById("storage-execute").disabled).toBe(true);
  });

  it("discards an in-flight preview when the selection changes", async () => {
    let resolve!: (body: Record<string, unknown>) => void;
    response = () => new Promise(done => { resolve = done; });
    document.getElementById("storage-preview").dispatch("click");
    await waitFor(() => Boolean(resolve), "preview response pending");
    document.getElementById("storage-project").value = "other";
    document.getElementById("storage-project").dispatch("change");
    resolve(preview());
    await waitFor(() => !document.getElementById("storage-preview").disabled, "stale request discarded");
    expect(document.getElementById("storage-execute").disabled).toBe(true);
    expect(document.getElementById("storage-summary").textContent).toBe("");
  });

  it("shows blocked accounting while refusing cleanup for unreadable retained manifests", async () => {
    response = async () => ({ ...preview(), reclaimable_registered_bytes: 0, reclaimable_blob_count: 0, gc_blocked_reason: "unreadable-retained-manifests" });
    await requestPreview();
    expect(document.getElementById("storage-summary").textContent).toContain("1 MiB");
    expect(document.getElementById("storage-message").textContent).toContain("Cleanup blocked");
    expect(document.getElementById("storage-execute").disabled).toBe(true);
  });

  it("requires a fresh preview after the handle expires", async () => {
    response = async () => ({ ...preview(), expires_at: Date.now() - 1 });
    await requestPreview();
    expect(document.getElementById("storage-execute").disabled).toBe(true);
    expect(document.getElementById("storage-message").textContent).toContain("Preview expired");
  });

  it("prevents Apply advanced from hiding the result of an in-progress confirmed cleanup", async () => {
    await requestPreview();
    const normalFetch = globalThis.fetch;
    let release!: () => void;
    let started = false;
    const pending = new Promise<void>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", async (route: string, options: unknown) => {
      if (route === "/api/storage/execute") { started = true; await pending; }
      return normalFetch(route, options as RequestInit);
    });
    try {
      document.getElementById("storage-execute").dispatch("click");
      await waitFor(() => started, "cleanup request accepted");
      expect(document.getElementById("apply-advanced").disabled).toBe(true);
      document.getElementById("apply-advanced").dispatch("click");
      expect(document.getElementById("storage-message").textContent).toContain("Clearing only the previewed data");
      // A project wizard rerender can still invalidate the displayed selection.
      document.getElementById("storage-project").value = "other";
      document.getElementById("storage-project").dispatch("change");
      release();
      await waitFor(() => document.getElementById("storage-message").textContent.includes("Expired 1"), "cleanup result retained");
      expect(document.getElementById("storage-message").textContent).toContain("Main: Expired 1");
      await waitFor(() => !document.getElementById("apply-advanced").disabled, "advanced action restored");
    } finally { release(); }
  });

  it("retains the exact preview for explicit retry on a lost execute response", async () => {
    await requestPreview();
    const normalFetch = globalThis.fetch;
    let failed = false;
    vi.stubGlobal("fetch", async (route: string, options: unknown) => {
      if (route === "/api/storage/execute" && !failed) { failed = true; throw new Error("Connection lost"); }
      return normalFetch(route, options as RequestInit);
    });
    document.getElementById("storage-execute").dispatch("click");
    await waitFor(() => document.getElementById("storage-message").textContent.includes("Connection lost"), "execute failure");
    await waitFor(() => !document.getElementById("storage-execute").disabled, "explicit retry enabled");
    expect(document.getElementById("storage-message").textContent).toContain("no automatic retry");
    document.getElementById("storage-execute").dispatch("click");
    await waitFor(() => requests.some(request => request.route === "/api/storage/execute"), "explicit retry");
    expect(requests.filter(request => request.route === "/api/storage/execute").map(request => request.body)).toEqual([{ preview_token: "owned-preview" }]);
  });
});
