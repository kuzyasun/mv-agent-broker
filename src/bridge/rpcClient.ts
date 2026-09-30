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
  readonly token: string;
  private socket: net.Socket | null = null;
  private connected = false;
  private handshaked = false;
  private nextId = 1;
  private readonly pending = new Map<
    number | string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private buffer = "";

  constructor(socketPath: string, token: string) {
    this.socketPath = socketPath;
    this.token = token;
  }

  async connect(coordinatorId?: string): Promise<void> {
    if (this.connected && this.socket) {
      if (coordinatorId && !this.handshaked) {
        await this.handshake(coordinatorId);
      }
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      let settled = false;

      const onConnect = () => {
        if (settled) return;
        settled = true;
        this.connected = true;
        this.socket = socket;
        socket.removeListener("error", onError);
        this.attachListeners(socket);
        resolve();
      };

      const onError = (err: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(err);
      };

      socket.once("connect", onConnect);
      socket.once("error", onError);
    });

    if (coordinatorId) {
      await this.handshake(coordinatorId);
    }
  }

  async handshake(coordinatorId: string): Promise<void> {
    await this.sendRequest("handshake", {
      protocolVersion: "1",
      coordinatorId,
      token: this.token,
    });
    this.handshaked = true;
  }

  async connectAndHandshake(coordinatorId: string): Promise<void> {
    return this.connect(coordinatorId);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return this.sendRequest("tool", { name, arguments: args });
  }

  async listTools(): Promise<{ tools: McpToolDef[] }> {
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
    this.buffer = "";
  }

  private attachListeners(socket: net.Socket): void {
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk: Buffer) => {
      this.buffer += decoder.write(chunk);
      this.processBuffer();
    });

    socket.on("end", () => {
      const rest = decoder.end();
      if (rest) {
        this.buffer += rest;
        this.processBuffer();
      }
    });

    socket.on("close", () => {
      this.connected = false;
      this.handshaked = false;
      for (const [, p] of this.pending.entries()) {
        p.reject(new Error("Daemon RPC connection closed"));
      }
      this.pending.clear();
      this.buffer = "";
    });

    socket.on("error", (err: Error) => {
      for (const [, p] of this.pending.entries()) {
        p.reject(err);
      }
      this.pending.clear();
      this.buffer = "";
    });
  }

  private processBuffer(): void {
    let newlineIdx: number;
    while ((newlineIdx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIdx);
      this.buffer = this.buffer.slice(newlineIdx + 1);
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
          if (p) {
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
          for (const [, p] of this.pending.entries()) {
            p.reject(err);
          }
          this.pending.clear();
        }
      } catch {
        // ignore unparseable lines
      }
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.socket || !this.connected) {
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
      this.pending.set(id, { resolve, reject });
      this.socket!.write(JSON.stringify(payload) + "\n", (err) => {
        if (err) {
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }
}
