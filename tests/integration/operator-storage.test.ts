/**
 * Integration tests for the operator storage surface: the authenticated
 * operator/storage-preview and operator/storage-execute daemon RPC methods
 * (same operator-coordinator/revocation guard as operator/clear-quota-pause)
 * and the UI HTTP endpoints POST /api/storage/preview and
 * POST /api/storage/execute end-to-end against a live daemon.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemon, type Daemon } from "../../src/daemon/bootstrap.ts";
import { startDaemonRpc, writeBridgeToken, type DaemonRpcServer } from "../../src/daemon/rpc.ts";
import { DaemonRpcClient, DaemonRpcError } from "../../src/bridge/rpcClient.ts";
import { daemonOperatorStatus } from "../../src/operator/main.ts";
import { createOperatorStorageHandlers } from "../../src/operator/storage.ts";
import { startOperatorUi, type OperatorUiService } from "../../src/operator/ui.ts";
import { insertCoordinator, insertProject } from "../../src/storage/repo.ts";

const DAY_MS = 86_400_000;
const OLD = 1_000; // far older than any plausible now - retention_days cutoff

interface Fixture {
  root: string;
  stateDir: string;
  configPath: string;
  daemon: Daemon;
  rpc: DaemonRpcServer;
  ui: OperatorUiService;
  authHeaders: Record<string, string>;
  rpcToken: string;
  staleBlob: { hash: string; size: number };
  clientFor(coordinatorId: string): Promise<DaemonRpcClient>;
  cleanup(): Promise<void>;
}

async function createFixture(configCoordinatorId = "operator"): Promise<Fixture> {
  const root = mkdtempSync(path.join(tmpdir(), "operator-storage-int-"));
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "operator.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    state_dir: stateDir,
    coordinator_id: configCoordinatorId,
    projects: [{ project_id: "project-main", display_name: "Main" }],
    coordinators: [{ coordinator_id: configCoordinatorId, display_name: "Operator", allowed_project_ids: ["project-main"] }],
    accounts: [{ account_profile_id: "account-main", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
    workspaces: [{ workspace_id: "workspace-main", project_id: "project-main", mode: "current", canonical_path: null }],
    policy_profiles: [{ policy_profile_id: "policy-main", config: { access: "read_only" } }],
    coverage_profiles: [],
    routes: [{
      route_id: "route-main",
      project_id: "project-main",
      provider: "mock",
      account_profile_id: "account-main",
      model: "mock-model",
      role: "worker",
      policy_profile_id: "policy-main",
    }],
  }));

  const daemon = await startDaemon({ stateDir, coordinatorId: "operator" });
  insertProject(daemon.db, {
    project_id: "project-main",
    display_name: "Main",
    configuration_revision: 1,
    session_cap: 20,
    created_at: 1,
  });
  insertCoordinator(daemon.db, {
    coordinator_id: "operator",
    display_name: "Operator",
    allowed_project_ids: ["project-main"],
    revoked: false,
    config_revision: 1,
  });
  insertCoordinator(daemon.db, {
    coordinator_id: "other-coordinator",
    display_name: "Other",
    allowed_project_ids: ["project-main"],
    revoked: false,
    config_revision: 1,
  });

  // One old sealed unpinned artifact with one old registered blob: a cleanup candidate.
  const blob = daemon.blobs.write("project-main", "stale artifact content");
  daemon.db.raw
    .prepare("INSERT INTO blobs (project_id, content_hash, size_bytes, created_at) VALUES (?, ?, ?, ?)")
    .run("project-main", blob.hash, blob.size, OLD);
  daemon.db.raw
    .prepare(
      "INSERT INTO artifacts (artifact_id, project_id, kind, content_hash, size_bytes, state, created_at, sealed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run("art-stale", "project-main", "findings", blob.hash, blob.size, "sealed", OLD, OLD);

  const storageHandlers = createOperatorStorageHandlers(daemon.db, daemon.blobs, "operator");
  // Fixed bridge token: the daemon RPC server authenticates against exactly
  // this value, and the UI's requestDaemon reads it from the state directory.
  const rpcToken = writeBridgeToken(stateDir);
  const rpc = await startDaemonRpc({
    core: daemon.core,
    coordinatorId: "operator",
    stateDir,
    token: rpcToken,
    operator: {
      coordinatorId: "operator",
      status: () => daemonOperatorStatus(daemon, "fingerprint"),
      storagePreview: (params: Record<string, unknown>) => storageHandlers.preview(params),
      storageExecute: (params: Record<string, unknown>) => storageHandlers.execute(params),
      stop: () => ({ response: { accepted: true }, shutdown: async () => undefined }),
    },
  });
  const ui = await startOperatorUi({ configPath, port: 0 });

  return {
    root,
    stateDir,
    configPath,
    daemon,
    rpc,
    ui,
    authHeaders: { host: new URL(ui.url).host, "x-operator-token": ui.token },
    rpcToken,
    staleBlob: blob,
    async clientFor(coordinatorId: string) {
      const client = new DaemonRpcClient(rpc.socketPath, rpcToken);
      await client.connect(coordinatorId);
      return client;
    },
    async cleanup() {
      await ui.close();
      await rpc.stop();
      await daemon.stop();
      daemon.db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("operator storage cleanup over authenticated RPC and UI HTTP", () => {
  it("previews and executes exact cleanup through operator/storage-* RPC with the operator guard", async () => {
    const f = await createFixture();
    let client: DaemonRpcClient | null = null;
    try {
      // A valid non-operator coordinator handshake cannot use the operator methods.
      client = await f.clientFor("other-coordinator");
      await expect(client.request("operator/storage-preview", { project_id: "project-main" }))
        .rejects.toMatchObject({ code: "UNAUTHORIZED" });
      await expect(client.request("operator/storage-execute", { preview_token: "x" }))
        .rejects.toMatchObject({ code: "UNAUTHORIZED" });
      client.close();
      client = null;

      client = await f.clientFor("operator");
      const preview = await client.request("operator/storage-preview", {
        project_id: "project-main",
        retention_days: 7,
      }) as Record<string, unknown>;
      expect(preview).toMatchObject({
        project_id: "project-main",
        retention_days: 7,
        eligible_artifact_count: 1,
        protected_artifact_count: 0,
        registered_blob_count: 1,
        reclaimable_blob_count: 1,
        gc_blocked_reason: null,
        protected_reasons: [],
      });
      const token = preview.preview_token as string;
      expect(typeof token).toBe("string");
      expect(JSON.stringify(preview)).not.toContain("art-stale");

      // Invalid retention and unknown projects fail without side effects.
      await expect(client.request("operator/storage-preview", { project_id: "project-main", retention_days: 0.5 }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
      await expect(client.request("operator/storage-preview", { project_id: "ghost" }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });

      const result = await client.request("operator/storage-execute", { preview_token: token }) as Record<string, unknown>;
      expect(result).toMatchObject({
        project_id: "project-main",
        expired_artifact_count: 1,
        skipped_artifact_count: 0,
        deleted_blob_count: 1,
        replayed_request: false,
      });
      expect(f.daemon.blobs.has("project-main", f.staleBlob.hash)).toBe(false);
      expect(f.daemon.db.raw.prepare("SELECT state FROM artifacts WHERE artifact_id = 'art-stale'").get())
        .toMatchObject({ state: "expired" });

      const replay = await client.request("operator/storage-execute", { preview_token: token }) as Record<string, unknown>;
      expect(replay).toMatchObject({ ...result, replayed_request: true });

      const audit = f.daemon.db.raw
        .prepare("SELECT payload FROM events WHERE type = 'operator_storage_cleanup'")
        .all() as Array<{ payload: string }>;
      expect(audit).toHaveLength(1);
      expect(audit[0]!.payload).not.toContain(token);

      await expect(client.request("operator/storage-execute", { preview_token: "bogus" }))
        .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    } finally {
      client?.close();
      await f.cleanup();
    }
  });

  it("rejects a revoked operator coordinator over RPC", async () => {
    const f = await createFixture();
    let client: DaemonRpcClient | null = null;
    try {
      client = await f.clientFor("operator");
      f.daemon.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = 'operator'").run();
      await expect(client.request("operator/storage-preview", { project_id: "project-main" }))
        .rejects.toMatchObject({ code: "UNAUTHORIZED" });
    } finally {
      client?.close();
      await f.cleanup();
    }
  });

  it("serves the UI HTTP storage endpoints with token/host guards and bounded error mapping", async () => {
    const f = await createFixture();
    try {
      const unauthenticated = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { host: new URL(f.ui.url).host, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-main" }),
      });
      expect(unauthenticated.status).toBe(401);

      const missingProject = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missingProject.status).toBe(400);

      const unconfiguredProject = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "ghost" }),
      });
      expect(unconfiguredProject.status).toBe(400);

      const preview = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-main", retention_days: 7 }),
      });
      expect(preview.status).toBe(200);
      const previewBody = await preview.json() as Record<string, unknown>;
      expect(previewBody).toMatchObject({ project_id: "project-main", eligible_artifact_count: 1, gc_blocked_reason: null });
      const token = previewBody.preview_token as string;

      const badRetention = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-main", retention_days: 9999 }),
      });
      expect(badRetention.status).toBe(400);

      const badToken = await fetch(`${f.ui.url}/api/storage/execute`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ preview_token: "bogus" }),
      });
      expect(badToken.status).toBe(400);

      const execute = await fetch(`${f.ui.url}/api/storage/execute`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ preview_token: token }),
      });
      expect(execute.status).toBe(200);
      expect(await execute.json()).toMatchObject({ expired_artifact_count: 1, deleted_blob_count: 1, replayed_request: false });

      const replay = await fetch(`${f.ui.url}/api/storage/execute`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ preview_token: token }),
      });
      expect(await replay.json()).toMatchObject({ replayed_request: true });

      // A saved config whose coordinator is not the daemon's operator is 403.
      writeFileSync(f.configPath, JSON.stringify({
        version: 1,
        state_dir: f.stateDir,
        coordinator_id: "other-coordinator",
        projects: [{ project_id: "project-main", display_name: "Main" }],
        coordinators: [{ coordinator_id: "other-coordinator", display_name: "Other", allowed_project_ids: ["project-main"] }],
        accounts: [{ account_profile_id: "account-main", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
        workspaces: [{ workspace_id: "workspace-main", project_id: "project-main", mode: "current", canonical_path: null }],
        policy_profiles: [{ policy_profile_id: "policy-main", config: { access: "read_only" } }],
        coverage_profiles: [],
        routes: [{
          route_id: "route-main",
          project_id: "project-main",
          provider: "mock",
          account_profile_id: "account-main",
          model: "mock-model",
          role: "worker",
          policy_profile_id: "policy-main",
        }],
      }));
      const forbidden = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-main" }),
      });
      expect(forbidden.status).toBe(403);
      expect((await forbidden.json() as { error: string }).error).toBe("forbidden");
    } finally {
      await f.cleanup();
    }
  });

  it("maps an unavailable daemon to 409 on the storage endpoints", async () => {
    const f = await createFixture();
    try {
      await f.rpc.stop();
      const preview = await fetch(`${f.ui.url}/api/storage/preview`, {
        method: "POST",
        headers: { ...f.authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ project_id: "project-main" }),
      });
      expect(preview.status).toBe(409);
      const body = await preview.json() as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
      expect(body.error.length).toBeLessThanOrEqual(240);
    } finally {
      await f.cleanup();
    }
  });

  it("surfaces daemon INVALID_REQUEST as 400 through the typed RPC error", async () => {
    const f = await createFixture();
    let client: DaemonRpcClient | null = null;
    try {
      client = await f.clientFor("operator");
      const failure = await client.request("operator/storage-preview", { project_id: "project-main", retention_days: -1 })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(DaemonRpcError);
      expect((failure as DaemonRpcError).code).toBe("INVALID_REQUEST");
    } finally {
      client?.close();
      await f.cleanup();
    }
  });
});
