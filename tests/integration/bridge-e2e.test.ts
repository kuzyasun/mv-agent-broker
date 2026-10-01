/**
 * Bridge e2e (in-process stdio): the §16.2 vertical slice driven entirely
 * through MCP tool calls — initialize → tools/list → spawn (mock provider)
 * → send → poll → result → stop. Deterministic, no native CLI.
 */
import { describe, expect, it } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runStdioBridge, type McpToolContext } from "../../src/bridge/server.ts";
import { bridgeToolDefs, callBridgeTool } from "../../src/bridge/tools.ts";
import { startDaemon } from "../../src/daemon/bootstrap.ts";
import {
  insertAccount,
  insertCoordinator,
  insertCoverageProfile,
  insertPolicyProfile,
  insertProject,
  insertWorkspace,
} from "../../src/storage/repo.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";
import type { ProviderAdapter } from "../../src/runtime/adapter.ts";
import { MockAdapter } from "../../src/providers/mock/mockAdapter.ts";

interface Line {
  write(line: string): void;
}

async function withBridge(
  fn: (rpc: (method: string, params?: unknown) => Promise<unknown>, drain: () => Promise<void>) => Promise<void>,
  opts?: { extraProjects?: Array<{ project_id: string; display_name: string }>; adapter?: ProviderAdapter },
): Promise<void> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ab-e2e-"));
  const wsRoot = path.join(stateDir, "ws-main");
  mkdirSync(path.join(wsRoot, "src"), { recursive: true });
  writeFileSync(path.join(wsRoot, "src", "main.c"), "int main(){return 0;}\n", "utf8");
  const daemon = await startDaemon({ stateDir, coordinatorId: "coord-e2e" });
  if (opts?.adapter) daemon.adapters.set("mock", opts.adapter);
  try {
    const coverage = {
      source_prefixes: ["src", "tests"],
      non_source_prefixes: ["dist"],
      excluded_prefixes: [".git", "node_modules"],
    };
    insertProject(daemon.db, {
      project_id: "p-e2e", display_name: "E2E", configuration_revision: 1, session_cap: 5, created_at: 1,
    });
    for (const p of opts?.extraProjects ?? []) {
      insertProject(daemon.db, {
        project_id: p.project_id, display_name: p.display_name, configuration_revision: 1, session_cap: 5, created_at: 1,
      });
    }
    const allowedProjects = ["p-e2e", ...(opts?.extraProjects?.map((p) => p.project_id) ?? [])];
    insertCoordinator(daemon.db, {
      coordinator_id: "coord-e2e", display_name: "E2E", allowed_project_ids: allowedProjects, revoked: false, config_revision: 1,
    });
    for (const account_profile_id of ["acct", "acct-e2e"]) {
      insertAccount(daemon.db, { account_profile_id, provider: "mock", auth_mode: "native", quota_scope_id: "shared:mock" });
    }
    insertCoverageProfile(daemon.db, {
      coverage_profile_id: "cov-e2e", version: "1",
      config: JSON.stringify(coverage), contract_hash: coverageContractHash(coverage),
    });
    insertPolicyProfile(daemon.db, {
      policy_profile_id: "pol-e2e", version: "1",
      config: JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests"] }),
    });
    insertWorkspace(daemon.db, {
      workspace_id: "ws-e2e", project_id: "p-e2e", mode: "current", canonical_path: wsRoot,
      quarantined: false, quarantine_reason: null, coverage_profile_id: "cov-e2e",
    });

    const ctx: McpToolContext = {
      listTools: () => bridgeToolDefs(),
      callTool: (name, args) => callBridgeTool({ coordinatorId: "coord-e2e", core: daemon.core }, name, args),
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const done = runStdioBridge(ctx, input, output);

    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void }>();
    let buffer = "";
    output.on("data", (chunk: string) => {
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === "number") {
          const waiter = pending.get(msg.id);
          if (waiter) {
            pending.delete(msg.id);
            waiter.resolve(msg);
          }
        }
      }
    });
    const rpc = async (method: string, params?: unknown): Promise<Record<string, unknown>> => {
      const id = nextId++;
      const promise = new Promise<unknown>((resolve) => pending.set(id, { resolve }));
      (input as unknown as Line).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      const msg = (await promise) as Record<string, unknown>;
      if (msg.error) throw new Error(`rpc ${method} failed: ${JSON.stringify(msg.error)}`);
      return msg.result as Record<string, unknown>;
    };

    await fn(rpc, async () => {
      await daemon.core.drain();
      await daemon.executor.drain();
    });
    input.end();
    await done;
  } finally {
    await daemon.lifecycle.shutdown();
    daemon.db.close();
    rmSync(stateDir, { recursive: true, force: true });
  }
}

function toolParams(name: string, args: Record<string, unknown>): { name: string; arguments: Record<string, unknown> } {
  return { name, arguments: args };
}

function toolContent(result: unknown): Record<string, unknown> {
  const r = result as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>;
}

describe("bridge e2e: §16.2 vertical slice over MCP stdio", () => {
  it("delivers the full task and instructions, and retains the report after close", async () => {
    const adapter = new MockAdapter();
    adapter.executeTurn = async (req, gate, onEvent) => {
      gate.acquireDispatchPermission();
      onEvent({ type: "native_ref_obtained", payload: { ref: "native-contract" } });
      return { native_outcome: "completed", native_conversation_ref: "native-contract",
        agent_reported: { summary: req.task_envelope, format_status: "text_only" } };
    };
    await withBridge(async (rpc, drain) => {
      const spawn = toolContent(await rpc("tools/call", toolParams("agent_session_spawn", {
        project_id: "p-e2e", idempotency_key: "contract-spawn", provider: "mock", account_profile_id: "acct",
        model: "mock-model", role: "worker", instructions: "Preserve the caller instructions.",
        workspace: { mode: "current", workspace_id: "ws-e2e" }, policy_profile_id: "pol-e2e",
      })));
      const task = { goal: "Return the caller marker.", acceptance_criteria: ["exact marker"],
        relevant_paths: ["src/main.c"], context: "caller context", checks: ["compare"], artifact_refs: [] };
      const send = toolContent(await rpc("tools/call", toolParams("agent_session_send", {
        session_id: spawn.session_id, idempotency_key: "contract-send", task,
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      })));
      await drain();
      await rpc("tools/call", toolParams("agent_session_stop", { session_id: spawn.session_id, idempotency_key: "contract-close" }));
      await drain();
      const result = toolContent(await rpc("tools/call", toolParams("agent_turn_result", { turn_id: send.turn_id })));
      expect(result.execution_status).toBe("SUCCEEDED"); expect(result.quality_status).toBe("unreviewed");
      const report = result.agent_reported as { summary: string; format_status: string };
      expect(report.summary).toContain("Preserve the caller instructions.");
      const deliveredTask = report.summary.split("[task contract JSON]\n")[1]!.split("\n[/task contract JSON]")[0]!;
      expect(JSON.parse(deliveredTask)).toEqual(task); expect(report.format_status).toBe("text_only");
      expect(JSON.stringify(result.broker_observed)).not.toContain(task.goal);
      const replay = toolContent(await rpc("tools/call", toolParams("agent_turn_result", { turn_id: send.turn_id })));
      expect(replay.agent_reported).toEqual(result.agent_reported);
    }, { adapter });
  });

  it("initialize + tools/list expose the 13 API-0.2 tools", async () => {
    await withBridge(async (rpc) => {
      const init = await rpc("initialize");
      expect((init as { serverInfo: { name: string } }).serverInfo.name).toBe("agent-broker");
      const listed = (await rpc("tools/list")) as { tools: Array<{ name: string }> };
      expect(listed.tools).toHaveLength(13);
      expect(listed.tools.map((t) => t.name)).toContain("agent_session_send");
    });
  });

  it("broker_status → spawn → send → result → stop through tool calls", async () => {
    await withBridge(async (rpc, drain) => {
      const status = toolContent(await rpc("tools/call", toolParams("broker_status", {})));
      expect(status.allowed_projects).toEqual([
        { project_id: "p-e2e", display_name: "E2E", default: true },
      ]);

      const spawn = toolContent(
        await rpc("tools/call", toolParams("agent_session_spawn", {
          project_id: "p-e2e",
          idempotency_key: "e2e-spawn-1",
          provider: "mock",
          account_profile_id: "acct-e2e",
          model: "mock-model",
          role: "worker",
          instructions: "e2e",
          workspace: { mode: "current", workspace_id: "ws-e2e" },
          policy_profile_id: "pol-e2e",
        })),
      );
      expect(spawn.state).toBe("IDLE");
      const sessionId = spawn.session_id as string;
      expect(spawn.initial_snapshot_id).toBeTruthy();

      const send = toolContent(
        await rpc("tools/call", toolParams("agent_session_send", {
          session_id: sessionId,
          idempotency_key: "e2e-send-1",
          task: { goal: "Implement parser.", acceptance_criteria: ["works"], artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
        })),
      );
      const turnId = send.turn_id as string;
      expect(send.state).toBe("ACCEPTED");

      let turn: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        await drain();
        turn = toolContent(await rpc("tools/call", toolParams("agent_turn_status", { turn_id: turnId })));
        if (turn.state === "SUCCEEDED") break;
        if (turn.state === "FAILED") throw new Error(`turn failed: ${JSON.stringify(turn)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(turn.state).toBe("SUCCEEDED");

      const result = toolContent(await rpc("tools/call", toolParams("agent_turn_result", { turn_id: turnId })));
      expect(result.execution_status).toBe("SUCCEEDED");
      expect(result.quality_status).toBe("unreviewed");
      const observed = result.broker_observed as Record<string, unknown>;
      expect(observed.final_snapshot_id).toBeTruthy();
      expect(observed.input_manifest_id).toBeTruthy();

      const events = toolContent(await rpc("tools/call", toolParams("agent_turn_events", { turn_id: turnId })));
      const eventList = events.events as Array<{ type: string }>;
      expect(eventList.some((e) => e.type === "turn_terminal")).toBe(true);

      const stop = toolContent(
        await rpc("tools/call", toolParams("agent_session_stop", { session_id: sessionId, idempotency_key: "e2e-stop-1" })),
      );
      expect(["pending", "completed"]).toContain(stop.close_state);
      await drain();
      const finalSession = toolContent(
        await rpc("tools/call", toolParams("agent_session_status", { session_id: sessionId })),
      );
      expect(finalSession.state).toBe("CLOSED");
    });
  });

  it("invalid tool arguments produce the §10.4 error contract, not a crash", async () => {
    await withBridge(async (rpc) => {
      const resp = (await rpc("tools/call", toolParams("agent_session_spawn", { project_id: "p-e2e" }))) as unknown as {
        content: Array<{ text: string }>;
        isError: boolean;
      };
      const payload = JSON.parse(resp.content[0]!.text) as { ok: boolean; error: { code: string } };
      expect(resp.isError).toBe(true);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe("INVALID_REQUEST");
    });
  });

  it("agents_list discovery + broker_status paging + §10.4 error fields", async () => {
    await withBridge(
      async (rpc) => {
        // 1. discovery tool call & shape checks
        const discovery = toolContent(await rpc("tools/call", toolParams("agents_list", { project_id: "p-e2e" })));
        expect(typeof discovery.configuration_revision).toBe("number");
        expect(discovery.next_cursor === null || (typeof discovery.next_cursor === "string" && /^r\d+:\d+$/.test(discovery.next_cursor))).toBe(true);

        const entries = discovery.entries as Array<Record<string, unknown>>;
        const mockAdapter = entries.find((e) => e.kind === "adapter" && e.id === "mock");
        expect(mockAdapter).toBeDefined();
        expect(mockAdapter?.capability_status).toBe("documented");

        const wsEntry = entries.find((e) => e.kind === "workspace" && e.id === "ws-e2e" && e.mode === "current");
        expect(wsEntry).toBeDefined();

        const policyEntry = entries.find((e) => e.kind === "policy_profile");
        expect(policyEntry).toBeDefined();

        // 2. Malformed cursor → INVALID_REQUEST
        const malformed = (await rpc("tools/call", toolParams("agents_list", { project_id: "p-e2e", cursor: "garbage" }))) as {
          content: Array<{ text: string }>;
          isError: boolean;
        };
        expect(malformed.isError).toBe(true);
        const malformedPayload = JSON.parse(malformed.content[0]!.text) as { ok: boolean; error: { code: string } };
        expect(malformedPayload.ok).toBe(false);
        expect(malformedPayload.error.code).toBe("INVALID_REQUEST");

        // 3. Stale-revision cursor → DISCOVERY_CHANGED
        const stale = (await rpc("tools/call", toolParams("agents_list", { project_id: "p-e2e", cursor: "r999:0" }))) as {
          content: Array<{ text: string }>;
          isError: boolean;
        };
        expect(stale.isError).toBe(true);
        const stalePayload = JSON.parse(stale.content[0]!.text) as { ok: boolean; error: { code: string } };
        expect(stalePayload.ok).toBe(false);
        expect(stalePayload.error.code).toBe("DISCOVERY_CHANGED");

        // 4. broker_status paging check (limit: 1 has next_cursor string; limit: 100 has >=1 project)
        const statusPaged = toolContent(await rpc("tools/call", toolParams("broker_status", { limit: 1 })));
        expect(statusPaged.allowed_projects).toHaveLength(1);
        expect(typeof statusPaged.next_cursor).toBe("string");
        expect(statusPaged.next_cursor).not.toBeNull();

        const statusAll = toolContent(await rpc("tools/call", toolParams("broker_status", { limit: 100 })));
        expect((statusAll.allowed_projects as unknown[]).length).toBeGreaterThanOrEqual(1);

        // 5. §10.4 fields end-to-end: invalid role enum → INVALID_REQUEST
        const badSpawn = (await rpc("tools/call", toolParams("agent_session_spawn", {
          project_id: "p-e2e",
          idempotency_key: "e2e-spawn-bad-role",
          provider: "mock",
          account_profile_id: "acct-e2e",
          model: "mock-model",
          role: "wizard",
          instructions: "e2e",
          workspace: { mode: "current", workspace_id: "ws-e2e" },
          policy_profile_id: "pol-e2e",
        }))) as { content: Array<{ text: string }>; isError: boolean };
        expect(badSpawn.isError).toBe(true);
        const badSpawnPayload = JSON.parse(badSpawn.content[0]!.text) as { ok: boolean; error: { code: string } };
        expect(badSpawnPayload.ok).toBe(false);
        expect(badSpawnPayload.error.code).toBe("INVALID_REQUEST");

        // Foreign session ID → UNAUTHORIZED + operator_action_required
        const badSend = (await rpc("tools/call", toolParams("agent_session_send", {
          session_id: "session-foreign",
          idempotency_key: "e2e-send-foreign",
          task: { goal: "test", artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: "snap-dummy" },
        }))) as { content: Array<{ text: string }>; isError: boolean };
        expect(badSend.isError).toBe(true);
        const badSendPayload = JSON.parse(badSend.content[0]!.text) as {
          ok: boolean;
          error: { code: string; retry_guidance: string };
        };
        expect(badSendPayload.ok).toBe(false);
        expect(badSendPayload.error.code).toBe("UNAUTHORIZED");
        expect(badSendPayload.error.retry_guidance).toBe("operator_action_required");
      },
      { extraProjects: [{ project_id: "p-e2e-2", display_name: "E2E 2" }] },
    );
  });

  it("agents_list and remaining tools stay consistent after the slice", async () => {
    await withBridge(async (rpc, drain) => {
      // Pre-spawn an initial session so sessions array length >= 2 later
      const spawn1 = toolContent(
        await rpc("tools/call", toolParams("agent_session_spawn", {
          project_id: "p-e2e",
          idempotency_key: "e2e-b-spawn-1",
          provider: "mock",
          account_profile_id: "acct-e2e",
          model: "mock-model",
          role: "worker",
          instructions: "pre-session",
          workspace: { mode: "current", workspace_id: "ws-e2e" },
          policy_profile_id: "pol-e2e",
        })),
      );
      expect(spawn1.state).toBe("IDLE");

      // agents_list BEFORE
      const before = toolContent(await rpc("tools/call", toolParams("agents_list", { project_id: "p-e2e" })));

      // Fresh session 2: full spawn → send → poll result → stop flow
      const spawn2 = toolContent(
        await rpc("tools/call", toolParams("agent_session_spawn", {
          project_id: "p-e2e",
          idempotency_key: "e2e-b-spawn-2",
          provider: "mock",
          account_profile_id: "acct-e2e",
          model: "mock-model",
          role: "worker",
          instructions: "slice-session",
          workspace: { mode: "current", workspace_id: "ws-e2e" },
          policy_profile_id: "pol-e2e",
        })),
      );
      expect(spawn2.state).toBe("IDLE");
      const session2Id = spawn2.session_id as string;

      const send = toolContent(
        await rpc("tools/call", toolParams("agent_session_send", {
          session_id: session2Id,
          idempotency_key: "e2e-b-send-2",
          task: { goal: "Implement slice.", acceptance_criteria: ["ok"], artifact_refs: [] },
          workspace_precondition: { expected_snapshot_id: spawn2.initial_snapshot_id },
        })),
      );
      const turnId = send.turn_id as string;
      expect(send.state).toBe("ACCEPTED");

      let turn: Record<string, unknown> = {};
      for (let i = 0; i < 50; i++) {
        await drain();
        turn = toolContent(await rpc("tools/call", toolParams("agent_turn_status", { turn_id: turnId })));
        if (turn.state === "SUCCEEDED") break;
        if (turn.state === "FAILED") throw new Error(`turn failed: ${JSON.stringify(turn)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(turn.state).toBe("SUCCEEDED");

      const result = toolContent(await rpc("tools/call", toolParams("agent_turn_result", { turn_id: turnId })));
      expect(result.execution_status).toBe("SUCCEEDED");

      const stop = toolContent(
        await rpc("tools/call", toolParams("agent_session_stop", { session_id: session2Id, idempotency_key: "e2e-b-stop-2" })),
      );
      expect(["pending", "completed"]).toContain(stop.close_state);
      await drain();

      // agents_list AFTER
      const after = toolContent(await rpc("tools/call", toolParams("agents_list", { project_id: "p-e2e" })));

      expect(before.configuration_revision).toBe(after.configuration_revision);
      const wsBefore = (before.entries as Array<{ kind: string; id: string }>).find((e) => e.kind === "workspace" && e.id === "ws-e2e");
      const wsAfter = (after.entries as Array<{ kind: string; id: string }>).find((e) => e.kind === "workspace" && e.id === "ws-e2e");
      expect(wsBefore).toBeDefined();
      expect(wsAfter).toEqual(wsBefore);

      // Also call agent_workspace_snapshot once (idempotency_key "e2e-snap") → capture_state "SEALED"
      const snap = toolContent(
        await rpc("tools/call", toolParams("agent_workspace_snapshot", {
          project_id: "p-e2e",
          workspace_id: "ws-e2e",
          idempotency_key: "e2e-snap",
        })),
      );
      expect(snap.capture_state).toBe("SEALED");

      // and agent_sessions_list {project_id:"p-e2e"} → sessions array length ≥ 2, next_cursor null-or-string
      const sessionsList = toolContent(
        await rpc("tools/call", toolParams("agent_sessions_list", { project_id: "p-e2e" })),
      );
      expect((sessionsList.sessions as unknown[]).length).toBeGreaterThanOrEqual(2);
      expect(sessionsList.next_cursor === null || typeof sessionsList.next_cursor === "string").toBe(true);
    });
  });
});
