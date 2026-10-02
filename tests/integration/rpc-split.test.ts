/**
 * Integration tests for the private-socket daemon/bridge split (spec §4.1, ADR-0003).
 *
 * Verifies:
 *   - DaemonRpcServer initialization and socket path derivation (Windows named pipe / POSIX socket)
 *   - Bridge token creation and reading
 *   - DaemonRpcClient connection and handshake with coordinator verification
 *   - 13 tools exposed via tools/list
 *   - End-to-end broker_status and agent_session_spawn via socket
 *   - Authentication guards: wrong token and pre-handshake tool execution rejected with UNAUTHORIZED
 *   - Multi-bridge: concurrent bridge clients attached to one daemon
 *   - Bounded inbound line size (>1 MiB cap)
 *   - Clean shutdown and resource release
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import net from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { startDaemon, type Daemon } from "../../src/daemon/bootstrap.ts";
import {
  startDaemonRpc,
  readBridgeToken,
  socketPathFor,
  writeBridgeToken,
  type DaemonRpcServer,
} from "../../src/daemon/rpc.ts";
import { DaemonRpcClient, DaemonRpcError } from "../../src/bridge/rpcClient.ts";
import { sha256Hex } from "../../src/shared/ids.ts";
import {
  insertAccount,
  insertCoordinator,
  insertCoverageProfile,
  insertPolicyProfile,
  insertProject,
  insertWorkspace,
} from "../../src/storage/repo.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";

interface DaemonRpcFixture {
  stateDir: string;
  daemon: Daemon;
  token: string;
  rpcServer: DaemonRpcServer;
  cleanup: () => Promise<void>;
}

async function setupDaemonRpc(): Promise<DaemonRpcFixture> {
  const stateDir = mkdtempSync(path.join(tmpdir(), "ab-rpc-"));
  const wsRoot = path.join(stateDir, "ws-main");
  mkdirSync(path.join(wsRoot, "src"), { recursive: true });
  writeFileSync(path.join(wsRoot, "src", "main.c"), "int main(){return 0;}\n", "utf8");

  const daemon = await startDaemon({ stateDir, coordinatorId: "coord-rpc" });

  const coverage = {
    source_prefixes: ["src", "tests"],
    non_source_prefixes: ["dist"],
    excluded_prefixes: [".git", "node_modules"],
  };
  insertProject(daemon.db, {
    project_id: "p-rpc",
    display_name: "RPC Project",
    configuration_revision: 1,
    session_cap: 5,
    created_at: 1,
  });
  insertCoordinator(daemon.db, {
    coordinator_id: "coord-rpc",
    display_name: "RPC Coordinator",
    allowed_project_ids: ["p-rpc"],
    revoked: false,
    config_revision: 1,
  });
  insertAccount(daemon.db, { account_profile_id: "acct-rpc", provider: "mock", auth_mode: "native", quota_scope_id: "shared:mock" });
  insertCoverageProfile(daemon.db, {
    coverage_profile_id: "cov-rpc",
    version: "1",
    config: JSON.stringify(coverage),
    contract_hash: coverageContractHash(coverage),
  });
  insertPolicyProfile(daemon.db, {
    policy_profile_id: "pol-rpc",
    version: "1",
    config: JSON.stringify({ access: "workspace_write", write_scope: ["src", "tests"] }),
  });
  insertWorkspace(daemon.db, {
    workspace_id: "ws-rpc",
    project_id: "p-rpc",
    mode: "current",
    canonical_path: wsRoot,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: "cov-rpc",
  });

  const token = writeBridgeToken(stateDir);
  const rpcServer = await startDaemonRpc({
    core: daemon.core,
    coordinatorId: "coord-rpc",
    stateDir,
    token,
  });

  const cleanup = async () => {
    await rpcServer.stop();
    await daemon.core.drain();
    await daemon.executor.drain();
    await daemon.lifecycle.shutdown();
    daemon.db.close();
    rmSync(stateDir, { recursive: true, force: true });
  };

  return { stateDir, daemon, token, rpcServer, cleanup };
}

describe("private-socket daemon/bridge split (ADR-0003, spec §4.1)", () => {
  it("connect+handshake → tools/list → broker_status → agent_session_spawn, and auth guards", async () => {
    const fixture = await setupDaemonRpc();
    const client = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
    try {
      // 1. Tool call before handshake → UNAUTHORIZED
      const unauthClient = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
      await unauthClient.connect();
      await expect(unauthClient.call("broker_status", {})).rejects.toThrow(/UNAUTHORIZED/);
      unauthClient.close();

      // 2. Unknown-token handshake → UNAUTHORIZED
      const badTokenClient = new DaemonRpcClient(fixture.rpcServer.socketPath, "bad-token-wrong");
      await badTokenClient.connect();
      await expect(badTokenClient.handshake("coord-rpc")).rejects.toThrow(/UNAUTHORIZED/);
      badTokenClient.close();

      // 3. Valid handshake
      await client.connect("coord-rpc");

      // 4. tools/list has 13 tools
      const toolsRes = await client.listTools();
      expect(toolsRes.tools).toHaveLength(13);
      expect(toolsRes.tools.map((t) => t.name)).toContain("agent_session_send");

      // 5. broker_status tool call → allowed_projects contains the project
      const status = (await client.call("broker_status", {})) as {
        allowed_projects: Array<{ project_id: string; display_name: string }>;
      };
      expect(status.allowed_projects.some((p) => p.project_id === "p-rpc")).toBe(true);

      // 6. agent_session_spawn (mock provider) works end-to-end (spawn → status IDLE) via the SOCKET path
      const spawn = (await client.call("agent_session_spawn", {
        project_id: "p-rpc",
        idempotency_key: "rpc-spawn-1",
        provider: "mock",
        account_profile_id: "acct-rpc",
        model: "mock-model",
        role: "worker",
        instructions: "test rpc spawn",
        workspace: { mode: "current", workspace_id: "ws-rpc" },
        policy_profile_id: "pol-rpc",
      })) as { session_id: string; state: string };
      expect(spawn.state).toBe("IDLE");
      expect(typeof spawn.session_id).toBe("string");

      const sessionStatus = (await client.call("agent_session_status", {
        session_id: spawn.session_id,
      })) as { session_id: string; state: string };
      expect(sessionStatus.state).toBe("IDLE");
      expect(sessionStatus.session_id).toBe(spawn.session_id);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("multi-bridge: multiple concurrent bridges attach to one daemon", async () => {
    const fixture = await setupDaemonRpc();
    const client1 = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
    const client2 = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
    try {
      await client1.connect("coord-rpc");
      await client2.connect("coord-rpc");

      const [status1, status2] = (await Promise.all([
        client1.call("broker_status", {}),
        client2.call("broker_status", {}),
      ])) as [
        { allowed_projects: Array<{ project_id: string }> },
        { allowed_projects: Array<{ project_id: string }> },
      ];

      expect(status1.allowed_projects.some((p) => p.project_id === "p-rpc")).toBe(true);
      expect(status2.allowed_projects.some((p) => p.project_id === "p-rpc")).toBe(true);
      expect(status1.allowed_projects).toEqual(status2.allowed_projects);
    } finally {
      client1.close();
      client2.close();
      await fixture.cleanup();
    }
  });

  it("reconnects concurrent requests once and recovers after an unavailable daemon", async () => {
    const fixture = await setupDaemonRpc();
    let tokenReads = 0;
    const client = new DaemonRpcClient(
      fixture.rpcServer.socketPath,
      () => {
        tokenReads += 1;
        return readBridgeToken(fixture.stateDir);
      },
    );
    let activeRpc: DaemonRpcServer = fixture.rpcServer;
    try {
      await client.connect("coord-rpc");
      expect(tokenReads).toBe(1);

      await activeRpc.stop();
      await new Promise((resolve) => setTimeout(resolve, 25));
      activeRpc = await startDaemonRpc({
        core: fixture.daemon.core,
        coordinatorId: "coord-rpc",
        stateDir: fixture.stateDir,
      });

      const [tools, status] = await Promise.all([
        client.listTools(),
        client.call("broker_status", {}),
      ]);
      expect(tokenReads).toBe(2); // concurrent requests share one new handshake
      expect(tools.tools).toHaveLength(13);
      expect((status as { allowed_projects: Array<{ project_id: string }> }).allowed_projects)
        .toEqual(expect.arrayContaining([expect.objectContaining({ project_id: "p-rpc" })]));

      await activeRpc.stop();
      await new Promise((resolve) => setTimeout(resolve, 25));
      await expect(client.call("broker_status", {})).rejects.toThrow(/not connected|connect/i);

      activeRpc = await startDaemonRpc({
        core: fixture.daemon.core,
        coordinatorId: "coord-rpc",
        stateDir: fixture.stateDir,
      });
      const recovered = (await client.call("broker_status", {})) as {
        allowed_projects: Array<{ project_id: string }>;
      };
      expect(recovered.allowed_projects.some((p) => p.project_id === "p-rpc")).toBe(true);
      expect(tokenReads).toBe(3);
    } finally {
      client.close();
      if (activeRpc !== fixture.rpcServer) await activeRpc.stop();
      await fixture.cleanup();
    }
  });

  it("keeps the stdio bridge alive across daemon restart and token rotation", async () => {
    const fixture = await setupDaemonRpc();
    const child = spawn(process.execPath, [
      "--experimental-transform-types",
      path.resolve("src/bridge/main-stdio.ts"),
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        AB_STATE_DIR: fixture.stateDir,
        AB_COORDINATOR_ID: "coord-rpc",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const rl = createInterface({ input: child.stdout });
    const responses = new Map<number, (value: any) => void>();
    rl.on("line", (line) => {
      const response = JSON.parse(line) as { id: number };
      responses.get(response.id)?.(response);
    });
    const call = (id: number, method: string, params?: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          responses.delete(id);
          reject(new Error(`stdio response timed out for request ${id}`));
        }, 5_000);
        responses.set(id, (response) => {
          clearTimeout(timer);
          resolve(response);
        });
        child.stdin.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        })}\n`);
      });

    let restartedRpc: DaemonRpcServer | undefined;
    try {
      expect((await call(1, "initialize")).result.serverInfo.name).toBe("agent-broker");
      expect((await call(2, "tools/list")).result.tools).toHaveLength(13);

      await fixture.rpcServer.stop();
      await new Promise((resolve) => setTimeout(resolve, 25));
      restartedRpc = await startDaemonRpc({
        core: fixture.daemon.core,
        coordinatorId: "coord-rpc",
        stateDir: fixture.stateDir,
      });

      expect((await call(3, "tools/list")).result.tools).toHaveLength(13);
      const status = await call(4, "tools/call", {
        name: "broker_status",
        arguments: {},
      });
      const statusBody = JSON.parse(status.result.content[0].text) as {
        allowed_projects: Array<{ project_id: string }>;
      };
      expect(statusBody.allowed_projects.some((project) => project.project_id === "p-rpc")).toBe(true);
    } finally {
      rl.close();
      child.kill();
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
        } else {
          child.once("exit", () => resolve());
        }
      });
      if (restartedRpc) await restartedRpc.stop();
      await fixture.cleanup();
    }
  });

  it("rejects a lost in-flight tool once, then recovers on the next call", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "ab-rpc-fake-"));
    const socketPath = socketPathFor(stateDir);
    let token = writeBridgeToken(stateDir, "fake-token-1");
    let toolCalls = 0;
    let server: net.Server | undefined;

    const startFakeServer = async (dropFirstTool: boolean): Promise<void> => {
      server = net.createServer((socket) => {
        let buffer = "";
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx);
            buffer = buffer.slice(newlineIdx + 1);
            if (!line.trim()) continue;
            const request = JSON.parse(line) as {
              id: number;
              method: string;
              params?: Record<string, unknown>;
            };
            if (request.method === "handshake") {
              expect(request.params?.token).toBe(token);
              expect(request.params?.coordinatorId).toBe("coord-rpc");
              socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } }) + "\n");
            } else if (request.method === "tool") {
              toolCalls += 1;
              if (dropFirstTool && toolCalls === 1) {
                socket.destroy();
              } else {
                socket.write(JSON.stringify({
                  jsonrpc: "2.0",
                  id: request.id,
                  result: { ok: true, tool: request.params?.name },
                }) + "\n");
              }
            }
          }
        });
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(socketPath, () => resolve());
      });
    };

    const stopFakeServer = async (): Promise<void> => {
      if (!server) return;
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    };

    const client = new DaemonRpcClient(socketPath, () => readBridgeToken(stateDir));
    try {
      await startFakeServer(true);
      await client.connect("coord-rpc");
      await expect(client.call("once_only", { idempotency_key: "once-1" })).rejects.toThrow(/closed|connect|not connected/i);
      expect(toolCalls).toBe(1);

      await stopFakeServer();
      token = writeBridgeToken(stateDir, "fake-token-2");
      await startFakeServer(false);
      await expect(client.call("recovered", {})).resolves.toEqual({ ok: true, tool: "recovered" });
      expect(toolCalls).toBe(2);
    } finally {
      client.close();
      await stopFakeServer();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("bounds a silent handshake and cleans up the failed socket", async () => {
    const stateDir = mkdtempSync(path.join(tmpdir(), "ab-rpc-silent-"));
    const socketPath = socketPathFor(stateDir);
    writeBridgeToken(stateDir, "silent-token");
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });

    const client = new DaemonRpcClient(socketPath, () => readBridgeToken(stateDir));
    const startedAt = Date.now();
    try {
      await expect(client.connect("coord-rpc")).rejects.toThrow(/timed out/i);
      expect(Date.now() - startedAt).toBeLessThan(6_000);
    } finally {
      client.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("oversize line (>1MiB) returns error and closes connection", async () => {
    const fixture = await setupDaemonRpc();
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect(fixture.rpcServer.socketPath, () => {
          const padding = "x".repeat(1024 * 1024 + 4096);
          socket.write(`{"id":1,"method":"tool","params":{"name":"${padding}"}}\n`);
        });

        let received = "";
        socket.on("data", (chunk: Buffer) => {
          received += chunk.toString("utf8");
        });

        socket.on("close", () => {
          try {
            const parsed = JSON.parse(received.trim()) as {
              error?: { code: string; message: string };
            };
            expect(parsed.error?.code).toBe("INVALID_REQUEST");
            expect(parsed.error?.message).toBe("message too large");
            resolve();
          } catch (err) {
            reject(err);
          }
        });

        socket.on("error", () => {
          // Ignore connection reset error on client side when closed by server
        });
      });
    } finally {
      await fixture.cleanup();
    }
  });

  it("reads bridge token from state directory and rejects unknown coordinator", async () => {
    const fixture = await setupDaemonRpc();
    const client = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
    try {
      const readToken = readBridgeToken(fixture.stateDir);
      expect(readToken).toBe(fixture.token);
      expect(readToken.length).toBe(64); // 32 random bytes formatted as hex

      const unknownCoordClient = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
      await unknownCoordClient.connect();
      await expect(unknownCoordClient.handshake("coord-nonexistent")).rejects.toThrow(/UNAUTHORIZED/);
      unknownCoordClient.close();
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });

  it("handshake is once-per-connection; UTF-8 payloads survive transport", async () => {
    const fixture = await setupDaemonRpc();
    const client = new DaemonRpcClient(fixture.rpcServer.socketPath, fixture.token);
    try {
      // (a) Initial handshake succeeds
      await client.connect("coord-rpc");

      // Second handshake on the same connection is rejected
      let secondHandshakeErr: unknown;
      try {
        await client.handshake("coord-rpc");
      } catch (err) {
        secondHandshakeErr = err;
      }
      expect(secondHandshakeErr).toBeInstanceOf(DaemonRpcError);
      expect((secondHandshakeErr as DaemonRpcError).code).toBe("INVALID_REQUEST");
      expect((secondHandshakeErr as DaemonRpcError).message).toContain("Connection already authenticated.");

      // Normal tool call on the SAME connection still works (identity unchanged)
      const status = (await client.call("broker_status", {})) as {
        allowed_projects: Array<{ project_id: string; display_name: string }>;
      };
      expect(status.allowed_projects.some((p) => p.project_id === "p-rpc")).toBe(true);

      // (b) Spawn a session with Ukrainian instructions
      const ukrainianInstructions = "Реалізуй парсер. Не комить.";
      const spawn = (await client.call("agent_session_spawn", {
        project_id: "p-rpc",
        idempotency_key: "ukr-spawn-1",
        provider: "mock",
        account_profile_id: "acct-rpc",
        model: "mock-model",
        role: "worker",
        instructions: ukrainianInstructions,
        workspace: { mode: "current", workspace_id: "ws-rpc" },
        policy_profile_id: "pol-rpc",
      })) as { session_id: string; state: string; initial_snapshot_id: string };
      expect(spawn.state).toBe("IDLE");
      expect(typeof spawn.session_id).toBe("string");

      // Verify session via agent_session_status
      const sessionStatus = (await client.call("agent_session_status", {
        session_id: spawn.session_id,
      })) as { session_id: string; state: string };
      expect(sessionStatus.state).toBe("IDLE");
      expect(sessionStatus.session_id).toBe(spawn.session_id);

      // Verify session and instructions_hash directly in SQLite
      const row = fixture.daemon.db.raw
        .prepare("SELECT session_id, instructions_hash FROM sessions WHERE session_id = ?")
        .get(spawn.session_id) as { session_id: string; instructions_hash: string } | undefined;
      expect(row).toBeDefined();
      expect(row?.session_id).toBe(spawn.session_id);
      expect(row?.instructions_hash).toBe(sha256Hex(ukrainianInstructions));

      // Craft tool call with Ukrainian goal string in agent_session_send expecting ACCEPTED then cancel it
      const send = (await client.call("agent_session_send", {
        session_id: spawn.session_id,
        idempotency_key: "ukr-send-1",
        task: {
          goal: "Напиши юніт-тести для парсера.",
          acceptance_criteria: ["всі тести проходять"],
          artifact_refs: [],
        },
        workspace_precondition: { expected_snapshot_id: spawn.initial_snapshot_id },
      })) as { turn_id: string; state: string };
      expect(send.state).toBe("ACCEPTED");
      expect(typeof send.turn_id).toBe("string");

      const cancel = (await client.call("agent_turn_cancel", {
        turn_id: send.turn_id,
        idempotency_key: "ukr-cancel-1",
        reason: "скасовано оператором",
      })) as { turn_id: string; state: string };
      expect(cancel.turn_id).toBe(send.turn_id);
      expect(["CANCELLING", "CANCELLED", "SUCCEEDED"]).toContain(cancel.state);
    } finally {
      client.close();
      await fixture.cleanup();
    }
  });
});
