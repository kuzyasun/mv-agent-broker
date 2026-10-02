/**
 * Bridge-side RPC client connecting to the agent-broker daemon (spec §4.1, ADR-0003).
 *
 * Speaks line-delimited JSON-RPC over a local private socket (POSIX) or named
 * pipe (Windows). Performs handshake authentication and proxies bridge tool calls.
 */
import net from "node:net";
import { StringDecoder } from "node:string_decoder";
import type { McpToolDef } from "./server.ts";

export class DaemonRpcError extends Error {
  readonly code: string | number;
  readonly data?: unknown;

  constructor(code: string | number, message: string, data?: unknown) {
    super(message ? `${code}: ${message}` : String(code));
    this.name = "DaemonRpcError";
    this.code = code;
    this.data = data;
  }

  toJSON(): unknown {
    if (this.data && typeof this.data === "object") {
      return this.data;
    }
    return {
      ok: false,
      error: {
        code: this.code,
        message: this.message,
      },
    };
  }
}

export class DaemonRpcClient {
  readonly socketPath: string;
  private readonly tokenSupplier: () => string;
  private socket: net.Socket | null = null;
  private connected = false;
  private handshaked = false;
  private nextId = 1;
  private coordinatorId: string | null = null;
  private connectionPromise: Promise<void> | null = null;
  private readonly pending = new Map<
    number | string,
    {
      socket: net.Socket;
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  >();

  constructor(socketPath: string, token: string | (() => string)) {
    this.socketPath = socketPath;
    this.tokenSupplier = typeof token === "function" ? token : () => token;
  }

  async connect(coordinatorId?: string): Promise<void> {
    if (coordinatorId) this.coordinatorId = coordinatorId;

    if (this.connectionPromise) {
      await this.connectionPromise;
      if (coordinatorId && !this.handshaked) {
        await this.connect(coordinatorId);
      }
      return;
    }

    if (this.connected && this.socket && !this.socket.destroyed) {
      if (coordinatorId && !this.handshaked) {
        await this.startOperation(() => this.handshake(coordinatorId));
      }
      return;
    }

    await this.startOperation(() => this.establishConnection(coordinatorId));
  }

  async handshake(coordinatorId: string, timeoutMs = RPC_TIMEOUT_MS): Promise<void> {
    const socket = this.socket;
    const wasHandshaked = this.handshaked;
    this.coordinatorId = coordinatorId;
    try {
      await this.sendRequest(
        "handshake",
        {
          protocolVersion: "1",
          coordinatorId,
          token: this.tokenSupplier(),
        },
        timeoutMs,
      );
      this.handshaked = true;
    } catch (err: unknown) {
      if (socket && !wasHandshaked) this.discardSocket(socket, asError(err));
      throw err;
    }
  }

  async connectAndHandshake(coordinatorId: string): Promise<void> {
    return this.connect(coordinatorId);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureReady();
    return this.sendRequest("tool", { name, arguments: args });
  }

  async listTools(): Promise<{ tools: McpToolDef[] }> {
    await this.ensureReady();
    return (await this.sendRequest("tools/list")) as { tools: McpToolDef[] };
  }

  close(): void {
    this.connected = false;
    this.handshaked = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const [, p] of this.pending.entries()) {
      p.reject(new Error("Daemon RPC client closed"));
    }
    this.pending.clear();
  }

  private async ensureReady(): Promise<void> {
    if (this.coordinatorId) {
      await this.connect(this.coordinatorId);
    }
  }

  private startOperation(operation: () => Promise<void>): Promise<void> {
    const tracked = operation().finally(() => {
      if (this.connectionPromise === tracked) {
        this.connectionPromise = null;
      }
    });
    this.connectionPromise = tracked;
    return tracked;
  }

  private async establishConnection(coordinatorId?: string): Promise<void> {
    const socket = net.connect(this.socketPath);
    const deadline = Date.now() + RPC_TIMEOUT_MS;
    try {
      await this.waitForConnect(socket, Math.max(1, deadline - Date.now()));
      this.socket = socket;
      this.connected = true;
      this.handshaked = false;
      this.attachListeners(socket);
      if (coordinatorId) {
        await this.handshake(coordinatorId, Math.max(1, deadline - Date.now()));
      }
    } catch (err: unknown) {
      this.discardSocket(socket, asError(err));
      throw err;
    }
  }

  private waitForConnect(socket: net.Socket, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout;

      const cleanup = (): void => {
        clearTimeout(timer);
        socket.removeListener("connect", onConnect);
        socket.removeListener("error", onError);
      };
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        finish();
      };
      const onConnect = (): void => settle(resolve);
      const onError = (err: Error): void => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.destroy();
        reject(new Error(`Daemon RPC connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });
  }

  private attachListeners(socket: net.Socket): void {
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      buffer = this.processBuffer(socket, buffer);
    });

    socket.on("end", () => {
      const rest = decoder.end();
      if (rest) {
        buffer += rest;
        buffer = this.processBuffer(socket, buffer);
      }
    });

    socket.on("close", () => {
      this.handleSocketLost(socket, new Error("Daemon RPC connection closed"));
    });

    socket.on("error", (err: Error) => {
      this.handleSocketLost(socket, err);
    });
  }

  private processBuffer(socket: net.Socket, buffer: string): string {
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed) as {
          id?: number | string | null;
          result?: unknown;
          error?: { code: string | number; message: string; data?: unknown };
        };
        if (msg.id !== undefined && msg.id !== null) {
          const p = this.pending.get(msg.id);
          if (p && p.socket === socket) {
            this.pending.delete(msg.id);
            if (msg.error) {
              p.reject(new DaemonRpcError(msg.error.code, msg.error.message, msg.error.data));
            } else {
              p.resolve(msg.result);
            }
          }
        } else if (msg.error) {
          // Unsolicited error or error with id: null (e.g. oversize line error)
          const err = new DaemonRpcError(msg.error.code, msg.error.message, msg.error.data);
          this.rejectPending(socket, err);
        }
      } catch {
        // ignore unparseable lines
      }
    }
    return buffer;
  }

  private sendRequest(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<unknown> {
    const socket = this.socket;
    if (!socket || !this.connected || socket.destroyed) {
      if (socket?.destroyed) this.handleSocketLost(socket, new Error("Daemon RPC connection closed"));
      return Promise.reject(new Error("Daemon RPC client is not connected"));
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const pending = {
        socket,
        resolve: (value: unknown): void => {
          if (timer) clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error): void => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };
      this.pending.set(id, pending);
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          if (this.pending.get(id) === pending) {
            this.pending.delete(id);
            pending.reject(new Error(`Daemon RPC ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      socket.write(JSON.stringify(payload) + "\n", (err) => {
        if (err && this.pending.get(id) === pending) {
          this.pending.delete(id);
          pending.reject(err);
          this.handleSocketLost(socket, err);
        }
      });
    });
  }

  private discardSocket(socket: net.Socket, error: Error): void {
    this.rejectPending(socket, error);
    if (this.socket === socket) {
      this.socket = null;
      this.connected = false;
      this.handshaked = false;
    }
    socket.destroy();
  }

  private handleSocketLost(socket: net.Socket, error: Error): void {
    this.rejectPending(socket, error);
    if (this.socket === socket) {
      this.socket = null;
      this.connected = false;
      this.handshaked = false;
    }
  }

  private rejectPending(socket: net.Socket, error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      if (pending.socket === socket) {
        this.pending.delete(id);
        pending.reject(error);
      }
    }
  }
}

const RPC_TIMEOUT_MS = 5_000;

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
