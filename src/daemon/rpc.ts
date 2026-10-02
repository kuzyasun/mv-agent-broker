/**
 * Private local socket/named pipe RPC server for daemon/bridge split (spec §4.1, ADR-0003).
 *
 * Implements a line-delimited JSON protocol over a local domain socket (POSIX)
 * or named pipe (Windows). Performs coordinator authentication via bridge token
 * and profile verification before delegating tool executions to BrokerCore.
 */
import net from "node:net";
import path from "node:path";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { BrokerCore } from "../core/broker.ts";
import { getCoordinator } from "../storage/repo.ts";
import { callBridgeTool, bridgeToolDefs } from "../bridge/tools.ts";
import { BrokerError } from "../shared/errors.ts";
import { sha256Hex } from "../shared/ids.ts";

export interface DaemonRpcServer {
  readonly socketPath: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface OperatorStopPlan {
  response: Record<string, unknown>;
  shutdown(): Promise<void>;
}

export interface OperatorRpcHandlers {
  coordinatorId: string;
  status(): Record<string, unknown>;
  stop(): OperatorStopPlan;
}

export interface DaemonRpcOptions {
  core: BrokerCore;
  coordinatorId: string;
  stateDir: string;
  token?: string;
  operator?: OperatorRpcHandlers;
}

export function socketPathFor(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  if (process.platform === "win32") {
    const base = path.basename(resolved).replace(/[\\/]/g, "") || "state";
    const hash16 = sha256Hex(resolved).slice(0, 16);
    return `\\\\.\\pipe\\agent-broker-${base}-${hash16}`;
  }
  return path.join(resolved, "daemon.sock");
}

export function writeBridgeToken(stateDir: string, token?: string): string {
  const resolved = path.resolve(stateDir);
  mkdirSync(resolved, { recursive: true });
  const t = token ?? randomBytes(32).toString("hex");
  const tokenPath = path.join(resolved, "bridge.token");
  writeFileSync(tokenPath, t + "\n", { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tokenPath, 0o600);
  } catch {
    // Best-effort chmod on platforms/filesystems that do not support POSIX file modes
  }
  return t;
}

export function readBridgeToken(stateDir: string): string {
  const resolved = path.resolve(stateDir);
  const tokenPath = path.join(resolved, "bridge.token");
  return readFileSync(tokenPath, "utf8").trim();
}

class DaemonRpcServerImpl implements DaemonRpcServer {
  readonly socketPath: string;
  private readonly opts: DaemonRpcOptions & { token: string };
  private server: net.Server | null = null;
  private listening = false;
  private readonly activeSockets = new Set<net.Socket>();
  private operatorStopping = false;

  constructor(opts: DaemonRpcOptions & { token: string }, socketPath: string) {
    this.opts = opts;
    this.socketPath = socketPath;
  }

  async start(): Promise<void> {
    if (this.listening) return;

    if (process.platform !== "win32") {
      if (existsSync(this.socketPath)) {
        try {
          rmSync(this.socketPath, { force: true });
        } catch {
          // ignore
        }
      }
    }

    const server = net.createServer((socket) => {
      this.handleConnection(socket);
    });
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.removeListener("error", reject);
        this.listening = true;
        server.on("error", (err) => {
          if (this.listening) console.error("Daemon RPC server socket error:", err);
        });
        if (process.platform !== "win32") {
          try {
            chmodSync(this.socketPath, 0o600);
          } catch {
            // Best-effort chmod on platforms/filesystems that do not support POSIX file modes
          }
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.listening && !this.server) return;
    this.listening = false;

    for (const sock of this.activeSockets) {
      sock.destroy();
    }
    this.activeSockets.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    if (process.platform !== "win32") {
      try {
        rmSync(this.socketPath, { force: true });
      } catch {
        // ignore
      }
    }
  }

  private handleConnection(socket: net.Socket): void {
    this.activeSockets.add(socket);

    const MAX_LINE_BYTES = 1024 * 1024; // 1 MiB cap
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let closedDueToOversize = false;
    let handshakedCoordinatorId: string | null = null;
    let messageQueue: Promise<void> = Promise.resolve();

    const send = (payload: Record<string, unknown>, flushed?: () => void): void => {
      if (socket.writable && !socket.destroyed) {
        const line = JSON.stringify(payload) + "\n";
        socket.write(line, () => flushed?.());
      }
    };

    const sendError = (reqId: string | number | null, code: string, message: string, data: Record<string, unknown> = {}): void => {
      send({
        jsonrpc: "2.0",
        id: reqId,
        error: { code, message, data: { ok: false, error: { code, message, ...data } } },
      });
    };

    const handleLine = async (trimmed: string): Promise<void> => {
      let raw: unknown;
      try {
        raw = JSON.parse(trimmed);
      } catch {
        send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: "PARSE_ERROR",
            message: "Parse error: invalid JSON",
            data: { ok: false, error: { code: "PARSE_ERROR", message: "Parse error: invalid JSON" } },
          },
        });
        return;
      }

      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        send({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid Request: expected object",
            data: { ok: false, error: { code: "INVALID_REQUEST", message: "Invalid Request: expected object" } },
          },
        });
        return;
      }

      const msg = raw as Record<string, unknown>;

      // Notifications (no id) are ignored
      if (!("id" in msg) || msg.id === undefined) {
        return;
      }
      const reqId = msg.id as string | number | null;

      if (typeof msg.method !== "string") {
        send({
          jsonrpc: "2.0",
          id: reqId,
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid Request: missing method",
            data: { ok: false, error: { code: "INVALID_REQUEST", message: "Invalid Request: missing method" } },
          },
        });
        return;
      }

      if (msg.method === "handshake") {
        if (handshakedCoordinatorId) {
          send({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: "INVALID_REQUEST",
              message: "Connection already authenticated.",
              data: { ok: false, error: { code: "INVALID_REQUEST", message: "Connection already authenticated." } },
            },
          });
          return;
        }

        const params = (msg.params as Record<string, unknown> | undefined) ?? {};
        if (params.protocolVersion !== "1") {
          send({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: "INVALID_REQUEST",
              message: "Unsupported protocol version.",
              data: { ok: false, error: { code: "INVALID_REQUEST", message: "Unsupported protocol version." } },
            },
          });
          return;
        }

        const token = typeof params.token === "string" ? params.token : "";
        const coordinatorId = typeof params.coordinatorId === "string" ? params.coordinatorId : "";

        const tokenBuf = Buffer.from(token, "utf8");
        const expectedBuf = Buffer.from(this.opts.token, "utf8");
        const tokenValid = tokenBuf.length === expectedBuf.length && timingSafeEqual(tokenBuf, expectedBuf);

        if (!tokenValid) {
          send({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: "UNAUTHORIZED",
              message: "Invalid token.",
              data: { ok: false, error: { code: "UNAUTHORIZED", message: "Invalid token." } },
            },
          });
          return;
        }

        const coord = getCoordinator(this.opts.core.db, coordinatorId);
        if (!coord || coord.revoked) {
          send({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: "UNAUTHORIZED",
              message: "Unknown or revoked coordinator profile.",
              data: { ok: false, error: { code: "UNAUTHORIZED", message: "Unknown or revoked coordinator profile." } },
            },
          });
          return;
        }

        handshakedCoordinatorId = coordinatorId;
        send({
          jsonrpc: "2.0",
          id: reqId,
          result: {
            ok: true,
            serverInfo: { name: "agent-broker-daemon" },
          },
        });
        return;
      }

      // If connection not handshaked yet, reject all other methods
      if (!handshakedCoordinatorId) {
        sendError(reqId, "UNAUTHORIZED", "handshake required");
        return;
      }

      switch (msg.method) {
        case "operator/status": {
          const operator = this.opts.operator;
          const coordinator = getCoordinator(this.opts.core.db, handshakedCoordinatorId);
          if (!operator) {
            sendError(reqId, "METHOD_NOT_FOUND", "Method not found: operator/status");
            break;
          }
          if (handshakedCoordinatorId !== operator.coordinatorId || !coordinator || coordinator.revoked) {
            sendError(reqId, "UNAUTHORIZED", "operator coordinator is not authorized");
            break;
          }
          try {
            send({ jsonrpc: "2.0", id: reqId, result: operator.status() });
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            sendError(reqId, "INTERNAL_ERROR", message);
          }
          break;
        }

        case "operator/stop": {
          const operator = this.opts.operator;
          const coordinator = getCoordinator(this.opts.core.db, handshakedCoordinatorId);
          if (!operator) {
            sendError(reqId, "METHOD_NOT_FOUND", "Method not found: operator/stop");
            break;
          }
          if (handshakedCoordinatorId !== operator.coordinatorId || !coordinator || coordinator.revoked) {
            sendError(reqId, "UNAUTHORIZED", "operator coordinator is not authorized");
            break;
          }
          if (this.operatorStopping) {
            sendError(reqId, "DAEMON_NOT_READY", "Daemon shutdown is already in progress.");
            break;
          }
          try {
            const plan = operator.stop();
            this.operatorStopping = true;
            send({ jsonrpc: "2.0", id: reqId, result: plan.response }, () => {
              void plan.shutdown().catch((err: unknown) => {
                console.error("Operator shutdown failed:", err);
              });
            });
          } catch (err: unknown) {
            if (err instanceof BrokerError) {
              send({
                jsonrpc: "2.0",
                id: reqId,
                error: { code: err.code, message: err.message, data: err.toJSON() },
              });
            } else {
              const message = err instanceof Error ? err.message : String(err);
              sendError(reqId, "INTERNAL_ERROR", message);
            }
          }
          break;
        }

        case "tools/list": {
          send({
            jsonrpc: "2.0",
            id: reqId,
            result: { tools: bridgeToolDefs() },
          });
          break;
        }

        case "tool": {
          if (this.operatorStopping) {
            sendError(reqId, "DAEMON_NOT_READY", "Daemon shutdown is in progress.");
            break;
          }
          const params = (msg.params as Record<string, unknown> | undefined) ?? {};
          const toolName = typeof params.name === "string" ? params.name : "";
          const toolArgs =
            typeof params.arguments === "object" && params.arguments !== null && !Array.isArray(params.arguments)
              ? (params.arguments as Record<string, unknown>)
              : {};

          if (!toolName) {
            send({
              jsonrpc: "2.0",
              id: reqId,
              error: {
                code: "INVALID_REQUEST",
                message: "Tool name is required.",
                data: { ok: false, error: { code: "INVALID_REQUEST", message: "Tool name is required." } },
              },
            });
            return;
          }

          try {
            const toolResult = await callBridgeTool(
              { coordinatorId: handshakedCoordinatorId, core: this.opts.core },
              toolName,
              toolArgs,
            );
            send({
              jsonrpc: "2.0",
              id: reqId,
              result: toolResult,
            });
          } catch (err: unknown) {
            if (err instanceof BrokerError) {
              send({
                jsonrpc: "2.0",
                id: reqId,
                error: {
                  code: err.code,
                  message: err.message,
                  data: err.toJSON(),
                },
              });
            } else {
              const message = err instanceof Error ? err.message : String(err);
              send({
                jsonrpc: "2.0",
                id: reqId,
                error: {
                  code: "INTERNAL_ERROR",
                  message,
                  data: { ok: false, error: { code: "INTERNAL_ERROR", message } },
                },
              });
            }
          }
          break;
        }

        default: {
          send({
            jsonrpc: "2.0",
            id: reqId,
            error: {
              code: "METHOD_NOT_FOUND",
              message: `Method not found: ${msg.method}`,
              data: { ok: false, error: { code: "METHOD_NOT_FOUND", message: `Method not found: ${msg.method}` } },
            },
          });
          break;
        }
      }
    };

    const enqueueLine = (line: string): void => {
      messageQueue = messageQueue.then(() => handleLine(line)).catch(() => {});
    };

    const triggerOversize = (): void => {
      if (closedDueToOversize) return;
      closedDueToOversize = true;
      const errResp =
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: "INVALID_REQUEST",
            message: "message too large",
            data: { ok: false, error: { code: "INVALID_REQUEST", message: "message too large" } },
          },
        }) + "\n";
      socket.write(errResp, () => {
        socket.destroy();
      });
      setTimeout(() => {
        if (!socket.destroyed) socket.destroy();
      }, 500);
    };

    const processBuffer = (): void => {
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length > MAX_LINE_BYTES) {
          triggerOversize();
          return;
        }

        const trimmed = line.trim();
        if (!trimmed) continue;
        enqueueLine(trimmed);
      }

      if (buffer.length > MAX_LINE_BYTES) {
        triggerOversize();
        return;
      }
    };

    socket.on("data", (chunk: Buffer) => {
      if (closedDueToOversize) return;
      buffer += decoder.write(chunk);

      if (buffer.length > MAX_LINE_BYTES && buffer.indexOf("\n") === -1) {
        triggerOversize();
        return;
      }

      processBuffer();
    });

    socket.on("end", () => {
      if (closedDueToOversize) return;
      const rest = decoder.end();
      if (rest) {
        buffer += rest;
        processBuffer();
      }
    });

    const cleanup = () => {
      this.activeSockets.delete(socket);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  }
}

export async function startDaemonRpc(opts: DaemonRpcOptions): Promise<DaemonRpcServer> {
  const socketPath = socketPathFor(opts.stateDir);
  const token = writeBridgeToken(opts.stateDir, opts.token);
  const server = new DaemonRpcServerImpl({ ...opts, token }, socketPath);
  await server.start();
  return server;
}
