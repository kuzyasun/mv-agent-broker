import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import os from "node:os";
import path from "node:path";
import { startDaemon } from "../../src/daemon/bootstrap.ts";
import { startDaemonRpc } from "../../src/daemon/rpc.ts";
import { daemonOperatorStatus } from "../../src/operator/main.ts";
import { operatorConfigFingerprint, validateOperatorConfig } from "../../src/operator/config.ts";
import { startOperatorUi } from "../../src/operator/ui.ts";
import { clearQuotaPauseResult, projectOperatorQuotaPauses } from "../../src/operator/overview.ts";
import { recordQuotaCooldown } from "../../src/core/quotaCooldown.ts";
import { insertCoordinator, insertProject, insertSession, insertTurn } from "../../src/storage/repo.ts";
import type { SessionRecord, TurnRecord } from "../../src/shared/api-types.ts";

const roots: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill();
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operator UI CLI", () => {
  it("starts on the requested loopback port and closes on SIGINT", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-cli-"));
    roots.push(root);
    const configPath = path.join(root, "operator.json");
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      state_dir: path.join(root, "state"),
      coordinator_id: "coord-main",
      projects: [{ project_id: "project-main", display_name: "Main" }],
      coordinators: [{ coordinator_id: "coord-main", display_name: "Main", allowed_project_ids: ["project-main"] }],
      accounts: [{ account_profile_id: "acct-mock", provider: "mock", quota_scope_id: "mock", auth_mode: "cli-owned" }],
      workspaces: [{ workspace_id: "ws-main", project_id: "project-main", mode: "current", canonical_path: root }],
      policy_profiles: [{ policy_profile_id: "pol-main", config: { access: "read_only" } }],
      coverage_profiles: [],
      routes: [{ route_id: "route-main", project_id: "project-main", provider: "mock", account_profile_id: "acct-mock", model: "mock-model", role: "worker", policy_profile_id: "pol-main" }],
    }));
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      path.resolve("src/operator/main.ts"),
      "ui",
      "--config",
      configPath,
      "--port",
      "0",
    ], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    children.push(child);
    const lines = createInterface({ input: child.stderr });
    const url = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("UI did not announce a URL")), 10_000);
      lines.on("line", line => {
        const match = /agent-broker ui listening (http:\/\/127\.0\.0\.1:\d+)/.exec(line);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]!);
        }
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`UI exited before announcing URL (${code})`)));
    });
    const page = await fetch(url);
    expect(page.status).toBe(200);
    const pageText = await page.text();
    expect(pageText).toContain("Agent Broker Operator");
    expect(pageText).toContain('id="app"');
    expect(pageText).toContain('/app.js');
    const exited = new Promise<number | null>(resolve => child.once("exit", code => resolve(code)));
    child.kill("SIGINT");
    await expect(exited).resolves.toBe(process.platform === "win32" ? null : 0);
    lines.close();
  }, 20_000);

  it("reads authenticated live daemon status without dispatching work", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-live-status-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "operator.json");
    const config = {
      version: 1,
      state_dir: stateDir,
      coordinator_id: "operator",
      projects: [{ project_id: "project-main", display_name: "Main" }],
      coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: ["project-main"] }],
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
    };
    writeFileSync(configPath, JSON.stringify(config));
    const appliedConfigFingerprint = operatorConfigFingerprint(validateOperatorConfig(config, root));

    const daemon = await startDaemon({ stateDir, coordinatorId: "operator" });
    insertCoordinator(daemon.db, {
      coordinator_id: "operator",
      display_name: "Operator",
      allowed_project_ids: [],
      revoked: false,
      config_revision: 1,
    });
    insertProject(daemon.db, {
      project_id: "project-main",
      display_name: "Main",
      configuration_revision: 1,
      session_cap: 20,
      created_at: 1,
    });
    const session: SessionRecord = {
      session_id: "session-live",
      project_id: "project-main",
      owner_coordinator_id: "operator",
      provider: "mock",
      adapter_version: null,
      cli_version: null,
      account_profile_id: "account-main",
      auth_mode: "cli-owned",
      requested_model: "mock-model",
      requested_effort: "high",
      effective_model: null,
      effective_effort: null,
      role: "worker",
      instructions_hash: "instructions",
      policy_profile_id: "policy-main",
      policy_profile_version: "1",
      workspace_id: null,
      workspace_mode: "current",
      coverage_profile_id: null,
      coverage_profile_version: null,
      coverage_contract_hash: null,
      native_conversation_ref: null,
      context_status: "not_started",
      state: "ACTIVE",
      active_turn_id: "turn-live",
      block_reason: null,
      runtime_id: null,
      close_state: "none",
      close_intent_id: null,
      initial_snapshot_id: null,
      latest_snapshot_id: null,
      record_version: 1,
      created_at: 1,
      updated_at: 2,
    };
    const activeTurn: TurnRecord = {
      turn_id: "turn-live",
      session_id: session.session_id,
      project_id: session.project_id,
      owner_coordinator_id: "operator",
      idempotency_key: "idempotency-live",
      request_hash: "request-live",
      task_goal_hash: "private-goal",
      state: "RUNNING",
      state_version: 1,
      execution_started: true,
      native_outcome: null,
      termination_reason: null,
      finalization_error: null,
      terminal_candidate: null,
      retry_of_turn_id: null,
      deadline_at: null,
      native_conversation_ref: null,
      continuation: null,
      input_manifest_id: null,
      task_artifact_refs: [],
      baseline_snapshot_id: null,
      review_target_snapshot_id: null,
      final_snapshot_id: null,
      runtime_id: null,
      error_code: null,
      created_at: 3,
      accepted_at: 3,
      terminal_at: null,
      updated_at: 4,
    };
    insertSession(daemon.db, session);
    insertTurn(daemon.db, activeTurn);
    insertTurn(daemon.db, {
      ...activeTurn,
      turn_id: "turn-failed",
      idempotency_key: "idempotency-failed",
      state: "FAILED",
      execution_started: false,
      error_code: "PROVIDER_AUTH_FAILED",
      native_conversation_ref: "private-native-ref",
      finalization_error: "private-provider-error-text",
      terminal_at: 9,
      updated_at: 10,
    });

    const rpc = await startDaemonRpc({
      core: daemon.core,
      coordinatorId: "operator",
      stateDir,
      operator: {
        coordinatorId: "operator",
        status: () => daemonOperatorStatus(daemon, appliedConfigFingerprint),
        stop: () => ({ response: { accepted: true }, shutdown: async () => undefined }),
      },
    });
    const service = await startOperatorUi({ configPath, port: 0 });
    const before = readFileSync(configPath);
    const turnCountBefore = Number(daemon.db.raw.prepare("SELECT COUNT(*) AS count FROM turns").get()?.count);
    try {
      const response = await fetch(`${service.url}/api/status`, {
        headers: { host: new URL(service.url).host, "x-operator-token": service.token },
      });
      expect(response.status).toBe(200);
      const payload = await response.json();
      expect(payload).toMatchObject({
        status: "ready",
        readiness: "READY",
        settings_state: "applied",
        runtime_observation: "observed-running",
        runtime_commit: null,
        daemon_pid: process.pid,
        active_turn_count: 1,
        active_turns: [{
          turn_id: "turn-live",
          session_id: "session-live",
          project_id: "project-main",
          provider: "mock",
          model: "mock-model",
          effort: "high",
          state: "RUNNING",
          timestamp: 4,
        }],
        error_turn_count: 1,
        error_turns: [{ turn_id: "turn-failed", model: "mock-model", effort: "high", error_code: "PROVIDER_AUTH_FAILED", timestamp: 9 }],
      });
      expect(JSON.stringify(payload)).not.toContain("private-");
      expect(readFileSync(configPath)).toEqual(before);
      expect(Number(daemon.db.raw.prepare("SELECT COUNT(*) AS count FROM turns").get()?.count)).toBe(turnCountBefore);

      const configResponse = await fetch(`${service.url}/api/config`, {
        headers: { "x-operator-token": service.token },
      });
      const savedConfig = await configResponse.json() as { revision: string };
      const save = await fetch(`${service.url}/api/config`, {
        method: "PUT",
        headers: { "x-operator-token": service.token, "content-type": "application/json" },
        body: JSON.stringify({ revision: savedConfig.revision, config: {
          ...config,
          routes: [{ ...config.routes[0], model: "new-model" }],
        } }),
      });
      expect(save.status).toBe(200);
      expect(await save.json()).not.toHaveProperty("restart_required");
      const changed = await fetch(`${service.url}/api/status`, {
        headers: { host: new URL(service.url).host, "x-operator-token": service.token },
      });
      expect(changed.status).toBe(200);
      expect(await changed.json()).toMatchObject({
        settings_state: "restart_required",
        active_turns: [{ model: "mock-model" }],
      });
      expect(Number(daemon.db.raw.prepare("SELECT COUNT(*) AS count FROM turns").get()?.count)).toBe(turnCountBefore);

      writeFileSync(configPath, JSON.stringify({
        ...config,
        coordinator_id: "wrong-coordinator",
        coordinators: [...config.coordinators, { coordinator_id: "wrong-coordinator", display_name: "Wrong", allowed_project_ids: [] }],
      }));
      const forbidden = await fetch(`${service.url}/api/status`, {
        headers: { host: new URL(service.url).host, "x-operator-token": service.token },
      });
      expect(forbidden.status).toBe(403);
    } finally {
      await service.close();
      await rpc.stop();
      await daemon.stop();
      daemon.db.close();
    }
  }, 20_000);

  it("sends host display preferences read-only and clears a learned quota pause as the operator", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "operator-ui-quota-pause-"));
    roots.push(root);
    const stateDir = path.join(root, "state");
    const configPath = path.join(root, "operator.json");
    const config = {
      version: 1,
      state_dir: stateDir,
      coordinator_id: "operator",
      projects: [{ project_id: "project-main", display_name: "Main" }],
      coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: ["project-main"] }],
      accounts: [{ account_profile_id: "account-main", provider: "mock", quota_scope_id: "qs-shared", auth_mode: "cli-owned" }],
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
    };
    writeFileSync(configPath, JSON.stringify(config));

    const daemon = await startDaemon({ stateDir, coordinatorId: "operator" });
    insertCoordinator(daemon.db, {
      coordinator_id: "operator",
      display_name: "Operator",
      allowed_project_ids: [],
      revoked: false,
      config_revision: 1,
    });
    insertProject(daemon.db, {
      project_id: "project-main",
      display_name: "Main",
      configuration_revision: 1,
      session_cap: 20,
      created_at: 1,
    });
    recordQuotaCooldown(daemon.db, {
      quotaScopeId: "qs-shared", provider: "mock", turnId: "turn-quota",
      detail: "Individual quota reached. Resets in 20m.", now: Date.now(),
    });

    const rpc = await startDaemonRpc({
      core: daemon.core,
      coordinatorId: "operator",
      stateDir,
      operator: {
        coordinatorId: "operator",
        status: () => daemonOperatorStatus(daemon, "fingerprint"),
        clearQuotaPause: (params: Record<string, unknown>) => clearQuotaPauseResult(daemon.db, params),
        stop: () => ({ response: { accepted: true }, shutdown: async () => undefined }),
      },
    });
    const service = await startOperatorUi({ configPath, port: 0 });
    const authHeaders = { host: new URL(service.url).host, "x-operator-token": service.token };
    try {
      // Bootstrap HTML embeds the HOST locale/timeZone preferences for the client.
      const page = await fetch(service.url);
      const pageText = await page.text();
      const bootstrapMatch = /window\.__OPERATOR_BOOTSTRAP__ = (\{.*\});<\/script>/.exec(pageText);
      expect(bootstrapMatch).not.toBeNull();
      const bootstrap = JSON.parse(bootstrapMatch![1]!) as { display: { locale: string; timeZone: string; hourCycle: string | null } };
      expect(typeof bootstrap.display.locale).toBe("string");
      expect(bootstrap.display.locale.length).toBeGreaterThan(0);
      expect(typeof bootstrap.display.timeZone).toBe("string");
      expect(bootstrap.display.timeZone.length).toBeGreaterThan(0);

      // /api/config carries the same read-only preferences OUTSIDE the saved config.
      const configResponse = await fetch(`${service.url}/api/config`, { headers: authHeaders });
      expect(configResponse.status).toBe(200);
      const configPayload = await configResponse.json() as {
        config: Record<string, unknown>;
        display: { locale: string; timeZone: string; hourCycle: string | null };
      };
      expect(configPayload.display).toEqual(bootstrap.display);
      expect(configPayload.config).not.toHaveProperty("display");

      // Saving never persists display preferences into the configuration file.
      const save = await fetch(`${service.url}/api/config`, {
        method: "PUT",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ revision: (await (await fetch(`${service.url}/api/config`, { headers: authHeaders })).json() as { revision: string }).revision, config }),
      });
      expect(save.status).toBe(200);
      expect(readFileSync(configPath, "utf8")).not.toContain('"display"');

      // The learned pause is exposed through live status.
      const statusResponse = await fetch(`${service.url}/api/status`, { headers: authHeaders });
      const status = await statusResponse.json() as { quota_pauses: Array<{ quota_scope_id: string; until_ms: number; source: string }> };
      expect(status.quota_pauses).toHaveLength(1);
      expect(status.quota_pauses[0]).toMatchObject({ quota_scope_id: "qs-shared", source: "vendor_reset_suffix" });

      // Unauthenticated requests never reach the clear action.
      const unauthenticated = await fetch(`${service.url}/api/quota-pause/clear`, {
        method: "POST",
        headers: { host: new URL(service.url).host, "content-type": "application/json" },
        body: JSON.stringify({ quota_scope_id: "qs-shared" }),
      });
      expect(unauthenticated.status).toBe(401);

      const clear = await fetch(`${service.url}/api/quota-pause/clear`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ quota_scope_id: "qs-shared" }),
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toMatchObject({ cleared: true, quota_scope_id: "qs-shared" });

      const clearedStatus = await fetch(`${service.url}/api/status`, { headers: authHeaders });
      expect((await clearedStatus.json() as { quota_pauses: unknown[] }).quota_pauses).toHaveLength(0);
      expect(daemon.db.raw.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'quota_pause_cleared'").get())
        .toMatchObject({ c: 1 });

      const missing = await fetch(`${service.url}/api/quota-pause/clear`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(400);

      // A valid coordinator handshake still cannot use another operator's clear action.
      insertCoordinator(daemon.db, {
        coordinator_id: "other-coordinator", display_name: "Other",
        allowed_project_ids: [], revoked: false, config_revision: 1,
      });
      recordQuotaCooldown(daemon.db, {
        quotaScopeId: "qs-shared", provider: "mock", turnId: "turn-quota-again",
        detail: "Individual quota reached. Resets in 20m.", now: Date.now(),
      });
      writeFileSync(configPath, JSON.stringify({
        ...config, coordinator_id: "other-coordinator",
        coordinators: [...config.coordinators, {
          coordinator_id: "other-coordinator", display_name: "Other", allowed_project_ids: [],
        }],
      }));
      const forbiddenClear = await fetch(`${service.url}/api/quota-pause/clear`, {
        method: "POST",
        headers: { ...authHeaders, "content-type": "application/json" },
        body: JSON.stringify({ quota_scope_id: "qs-shared" }),
      });
      expect(forbiddenClear.status).toBe(403);
      expect(projectOperatorQuotaPauses(daemon.db, Date.now())).toHaveLength(1);
      expect(daemon.db.raw.prepare("SELECT COUNT(*) AS c FROM events WHERE type = 'quota_pause_cleared'").get())
        .toMatchObject({ c: 1 });
    } finally {
      await service.close();
      await rpc.stop();
      await daemon.stop();
      daemon.db.close();
    }
  }, 20_000);
});
