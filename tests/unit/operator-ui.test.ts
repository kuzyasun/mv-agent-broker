import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildModelOptions,
  defaultCatalogReader,
  startOperatorUi,
  type CatalogObservation,
} from "../../src/operator/ui.ts";
import { resolveCursorModel } from "../../src/providers/cursor/cursorAdapter.ts";

const roots: string[] = [];
const services: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config() {
  return {
    version: 1,
    state_dir: "./relative-state",
    coordinator_id: "coord-main",
    custom_unknown: { keep: true },
    projects: [{ project_id: "project-main", display_name: "Main" }],
    coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] }],
    accounts: [{ account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
    workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: "./repo" }],
    policy_profiles: [{ policy_profile_id: "policy-main", config: { access: "read_only" } }],
    coverage_profiles: [],
    routes: [{
      route_id: "route-main",
      project_id: "project-main",
      provider: "mock",
      account_profile_id: "acct-mock",
      model: "mock-model",
      role: "worker",
      policy_profile_id: "policy-main",
    }],
  };
}

async function request(
  service: { url: string; token: string },
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(`${service.url}${route}`, {
    method,
    headers: {
      host: new URL(service.url).host,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("operator settings UI service", () => {
  it("refreshes shared bridge snippets after saved state directory changes", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-snippets-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config()));
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);
    const headers = { "x-operator-token": service.token };
    const current = await (await request(service, "GET", "/api/config", undefined, headers)).json() as { revision: string };
    const updated = { ...config(), state_dir: "./new-state" };
    const saved = await (await request(service, "PUT", "/api/config", { revision: current.revision, config: updated }, headers)).json() as { snippets: { json: string } };
    const check = (snippets: { json: string }) => {
      const connection = JSON.parse(snippets.json).mcpServers["agent-broker"];
      expect(connection.env).toEqual({ AB_STATE_DIR: path.join(root, "new-state"), AB_COORDINATOR_ID: "coord-main" });
      expect(connection.args).toEqual(["--experimental-transform-types", path.resolve("src/bridge/main-stdio.ts")]);
    };
    check(saved.snippets);
    const reloaded = await (await request(service, "GET", "/api/config", undefined, headers)).json() as { snippets: { json: string } };
    check(reloaded.snippets);
    const page = await (await fetch(service.url)).text();
    expect(page).toContain("new-state");
    expect(page).not.toContain("relative-state");
    expect(page).toContain('id="app"');
    expect(page).toContain('/app.js');
  });

  it("protects config reads and writes with the loopback host, origin, and token", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-unit-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config()));
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);

    const pageResponse = await fetch(service.url);
    expect(pageResponse.headers.get("x-frame-options")).toBe("DENY");
    const page = await pageResponse.text();
    expect(page).toContain('window.__OPERATOR_BOOTSTRAP__ = {"token":');
    expect(page).not.toContain("/*OPERATOR_BOOTSTRAP_JSON*/");
    expect(page).toContain("main-stdio.ts");
    expect(page).toContain("AB_STATE_DIR");
    expect(page).toContain("AB_COORDINATOR_ID");
    expect(page).not.toContain('"stdio", "--config"');

    expect((await fetch(`${service.url}/api/config`)).status).toBe(401);
    expect((await request(service, "GET", "/api/config", undefined, { "x-operator-token": service.token })).status).toBe(200);
    expect((await request(service, "GET", "/api/config", undefined, {
      "x-operator-token": service.token,
      origin: "http://evil.example",
    })).status).toBe(403);
    expect((await fetch(`${service.url.replace("127.0.0.1", "localhost")}/api/config`, {
      headers: { "x-operator-token": service.token, host: new URL(service.url).host },
    })).status).toBe(403);
  });

  it("returns an honest unavailable status without mutating saved configuration", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-status-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config()));
    const original = readFileSync(configPath);
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);

    expect((await fetch(`${service.url}/api/status`)).status).toBe(401);
    expect((await request(service, "GET", "/api/status", undefined, {
      "x-operator-token": service.token,
      origin: "http://evil.example",
    })).status).toBe(403);
    const localhost = await fetch(`${service.url.replace("127.0.0.1", "localhost")}/api/status`, {
      headers: { "x-operator-token": service.token, host: new URL(service.url).host },
    });
    expect(localhost.status).toBe(403);

    const response = await request(service, "GET", "/api/status", undefined, { "x-operator-token": service.token });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "stopped",
      readiness: "UNAVAILABLE",
      runtime_observation: "unknown",
      settings_state: "unknown",
      active_turns: null,
      error_turns: null,
    });
    expect(readFileSync(configPath)).toEqual(original);
  });

  it("lists one authenticated folder level without exposing file contents", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-folders-"));
    roots.push(root);
    const child = path.join(root, "child");
    mkdirSync(child);
    writeFileSync(path.join(root, "secret.txt"), "private file contents");
    writeFileSync(path.join(child, "nested.txt"), "nested private contents");
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      ...config(),
      workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: root }],
    }));
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);

    expect((await fetch(`${service.url}/api/folders`)).status).toBe(401);
    expect((await request(service, "POST", "/api/folders", {}, {
      "x-operator-token": service.token,
      origin: "http://evil.example",
    })).status).toBe(403);
    const response = await request(service, "POST", "/api/folders", {}, { "x-operator-token": service.token });
    expect(response.status).toBe(200);
    const listing = await response.json() as {
      path: string;
      parent: string | null;
      directories: Array<{ name: string; path: string }>;
      entries: Array<{ name: string; kind: string }>;
      roots: string[];
    };
    expect(listing.path).toBe(path.resolve(root));
    expect(listing.parent).toBe(path.dirname(path.resolve(root)));
    expect(listing.directories).toEqual([{ name: "child", path: path.resolve(child) }]);
    expect(listing.entries).toEqual([
      { name: "child", kind: "directory" },
      { name: "operator.json", kind: "file" },
      { name: "secret.txt", kind: "file" },
    ]);
    expect(JSON.stringify(listing)).not.toContain("private file contents");
    expect(listing.roots.length).toBeGreaterThan(0);
  });

  it("rejects relative, missing, and file folder paths", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-folders-"));
    roots.push(root);
    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a folder");
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      ...config(),
      workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: root }],
    }));
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);

    for (const folderPath of ["relative", path.join(root, "missing"), file]) {
      const response = await request(service, "POST", "/api/folders", { path: folderPath }, { "x-operator-token": service.token });
      expect(response.status).toBe(400);
    }
  });

  it("saves route profile metadata and rejects reserved tags or write-access reviewers without backups", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-metadata-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config()));
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);
    const headers = { "x-operator-token": service.token };
    const revision = ((await (await request(service, "GET", "/api/config", undefined, headers)).json()) as { revision: string }).revision;
    const metadataRoute = {
      ...config().routes[0],
      display_name: "Economical worker",
      enabled: false,
      tags: ["default", "fast-track"],
    };
    const saved = await request(service, "PUT", "/api/config", {
      revision,
      config: { ...config(), routes: [metadataRoute] },
    }, headers);
    expect(saved.status).toBe(200);
    const reloaded = await (await request(service, "GET", "/api/config", undefined, headers)).json() as { config: { routes: Array<Record<string, unknown>> } };
    expect(reloaded.config.routes[0]).toMatchObject({ display_name: "Economical worker", enabled: false, tags: ["default", "fast-track"] });

    const saveFailing = async (override: Record<string, unknown>) => {
      const currentRevision = ((await (await request(service, "GET", "/api/config", undefined, headers)).json()) as { revision: string }).revision;
      return request(service, "PUT", "/api/config", { revision: currentRevision, config: { ...config(), ...override } }, headers);
    };
    for (const routes of [
      [{ ...metadataRoute, tags: ["multi-agent"] }],
      [{ ...metadataRoute, tags: ["Big"] }],
      [{ ...metadataRoute, tags: Array.from({ length: 13 }, (_, i) => `tag-${i}`) }],
      [{ ...metadataRoute, enabled: "yes" }],
      [{ ...metadataRoute, display_name: "  " }],
    ]) {
      const rejected = await saveFailing({ routes });
      expect(rejected.status).toBe(400);
    }
    expect(readFileSync(configPath, "utf8")).toContain('"Economical worker"');
    expect(readdirSync(root).filter(name => name.includes(".backup.")).length).toBe(1);

    // The wizard bug cannot be reintroduced through JSON: a named reviewer or
    // researcher profile needs a read-only policy; a read-only worker stays valid.
    const withRole = (role: string, policy: string) => ({
      policy_profiles: [...config().policy_profiles, { policy_profile_id: "policy-write", version: "1", config: { access: "workspace_write" } }],
      routes: [{ ...config().routes[0], route_id: "route-role", role, policy_profile_id: policy }],
    });
    const rejectedReviewer = await saveFailing(withRole("reviewer", "policy-write"));
    expect(rejectedReviewer.status).toBe(400);
    expect(((await rejectedReviewer.json()) as { error: string }).error).toMatch(/role 'reviewer' requires a policy profile with access 'read_only'/);
    const rejectedResearcher = await saveFailing(withRole("researcher", "policy-write"));
    expect(rejectedResearcher.status).toBe(400);
    const acceptedReadOnlyWorker = await saveFailing(withRole("worker", "policy-main"));
    expect(acceptedReadOnlyWorker.status).toBe(200);
  });

  it("rejects invalid updates without creating a backup or changing the raw file", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-unit-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    const original = JSON.stringify(config());
    writeFileSync(configPath, original);
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);
    const revision = await (await request(service, "GET", "/api/config", undefined, { "x-operator-token": service.token })).json() as { revision: string };

    const response = await request(service, "PUT", "/api/config", {
      revision: revision.revision,
      config: { ...config(), routes: [{ ...config().routes[0], account_profile_id: "missing-account" }] },
    }, { "x-operator-token": service.token });
    expect(response.status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(readdirSync(root).filter(name => name.includes(".backup.")).length).toBe(0);
  });

  it("saves exact backups, preserves unknown raw fields and rejects stale revisions", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-unit-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    const original = JSON.stringify(config());
    writeFileSync(configPath, original);
    const service = await startOperatorUi({ configPath, port: 0 });
    services.push(service);
    const get = await request(service, "GET", "/api/config", undefined, { "x-operator-token": service.token });
    const revision = ((await get.json()) as { revision: string }).revision;
    const next = config();
    next.projects[0]!.display_name = "Updated";
    const saved = await request(service, "PUT", "/api/config", { revision, config: next }, { "x-operator-token": service.token });
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(configPath, "utf8")).custom_unknown).toEqual({ keep: true });
    expect(JSON.parse(readFileSync(configPath, "utf8")).state_dir).toBe("./relative-state");
    const backups = readdirSync(root).filter(name => name.includes(".backup."));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(root, backups[0]!), "utf8")).toBe(original);

    writeFileSync(configPath, JSON.stringify({ ...config(), external: true }));
    const stale = await request(service, "PUT", "/api/config", { revision: (await saved.json() as { revision: string }).revision, config: next }, { "x-operator-token": service.token });
    expect(stale.status).toBe(409);
    expect(JSON.parse(readFileSync(configPath, "utf8")).external).toBe(true);
  });

  it("maps only observed provider catalog entries into effort variants", () => {
    const cursor = buildModelOptions("cursor", ["gpt-5.6-sol", "gpt-5.6-sol-high", "gpt-5.6-sol-high-fast"]);
    expect(cursor).toEqual(expect.arrayContaining([
      { model: "gpt-5.6-sol", efforts: ["", "high"] },
      { model: "gpt-5.6-sol-high-fast", efforts: ["", "high"] },
    ]));
    const catalogue = ["gpt-5.6-sol", "gpt-5.6-sol-high", "gpt-5.6-sol-high-fast"];
    for (const entry of cursor) for (const effort of entry.efforts) {
      expect(catalogue).toContain(resolveCursorModel(entry.model, effort || null));
    }
    expect(buildModelOptions("cursor", ["gpt-5.6-sol-none"]))
      .toEqual(expect.arrayContaining([{ model: "gpt-5.6-sol", efforts: ["none"] }]));
    expect(buildModelOptions("antigravity", ["gemini-3.8-flash-medium"])).toEqual([
      { model: "gemini-3.8-flash", efforts: ["medium"] },
    ]);
    expect(buildModelOptions("zcode", ["GLM-5.3", "GLM-5.3-Flash"])).toHaveLength(2);
  });

  it("keeps unpinned native providers unavailable without invoking a CLI", async () => {
    for (const provider of ["cursor", "antigravity", "zcode"]) {
      expect(await defaultCatalogReader(provider, config(), "operator.json"))
        .toMatchObject({ models: [], detail: expect.stringContaining("not pinned") });
    }
  });

  it("uses injected catalog readers only when refresh is explicitly requested", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-unit-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify(config()));
    let calls = 0;
    const observation: CatalogObservation = {
      provider: "mock",
      models: ["configured-model"],
      observed_at: 1,
      source: "config_catalog",
      detail: null,
    };
    const service = await startOperatorUi({
      configPath,
      port: 0,
      readCatalog: async () => {
        calls += 1;
        return observation;
      },
    });
    services.push(service);
    expect(calls).toBe(0);
    const response = await request(service, "POST", "/api/models/refresh", { provider: "mock" }, { "x-operator-token": service.token });
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect(await response.json()).toMatchObject({ observation });
  });
});
