/**
 * MCP stdio transport bridge for agent-broker (spec §4.1).
 * Thin presentation + bounded RPC layer only — no business logic.
 * Speaks line-delimited JSON-RPC 2.0 on stdin/stdout.
 */

import * as readline from "node:readline";
import type { Writable } from "node:stream";
import {
  JSONRPC_ERROR,
  MCP_PROTOCOL_VERSION,
  parseRequest,
  type JsonRpcResponse,
} from "./protocol.ts";

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * MCP tool annotations (hints only — never enforcement): truthful flags
   * about what a tool does, e.g. a read-only local capture vs a tool that
   * launches a provider run.
   */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpToolContext {
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  listTools(): McpToolDef[] | Promise<McpToolDef[]>;
}

function formatErrorPayload(err: unknown): Record<string, unknown> {
  if (err && typeof err === "object") {
    if ("toJSON" in err && typeof (err as { toJSON: unknown }).toJSON === "function") {
      const json = (err as { toJSON(): unknown }).toJSON();
      if (json && typeof json === "object") return json as Record<string, unknown>;
    }
    const obj = err as Record<string, unknown>;
    const message = typeof obj["message"] === "string" ? obj["message"] : String(err);
    return { ok: false, error: { message, ...(obj["code"] !== undefined ? { code: obj["code"] } : {}) } };
  }
  return { ok: false, error: { message: String(err) } };
}

export async function handleJsonRpcLine(
  line: string,
  ctx: McpToolContext,
  signal?: AbortSignal,
): Promise<JsonRpcResponse | null> {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const req = parseRequest(trimmed);
  if (!req) {
    // Distinguish per JSON-RPC 2.0: valid JSON that is not a conforming
    // request is INVALID_REQUEST; unparseable text is PARSE_ERROR.
    let validJson = false;
    try {
      JSON.parse(trimmed);
      validJson = true;
    } catch {
      validJson = false;
    }
    return {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: validJson ? JSONRPC_ERROR.INVALID_REQUEST : JSONRPC_ERROR.PARSE_ERROR,
        message: validJson ? "Invalid Request: not a JSON-RPC 2.0 request" : "Parse error: invalid JSON",
      },
    };
  }

  // Notifications (id null + method without expectation, e.g. "notifications/initialized") → null
  if (
    req.id === null &&
    (req.method.startsWith("notifications/") || req.method === "initialized" || req.method.startsWith("$/"))
  ) {
    return null;
  }

  switch (req.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-broker", version: "0.2.0" },
        },
      };

    case "tools/list":
      return { jsonrpc: "2.0", id: req.id, result: { tools: await ctx.listTools() } };

    case "tools/call": {
      const p = req.params as Record<string, unknown> | undefined;
      if (!p || typeof p["name"] !== "string") {
        return { jsonrpc: "2.0", id: req.id, error: { code: JSONRPC_ERROR.INVALID_PARAMS, message: "Invalid params: missing tool name" } };
      }
      const rawArgs = p["arguments"];
      const args = typeof rawArgs === "object" && rawArgs !== null && !Array.isArray(rawArgs) ? (rawArgs as Record<string, unknown>) : {};

      try {
        const toolResult = await ctx.callTool(p["name"], args, signal);
        return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(toolResult) }], isError: false } };
      } catch (err: unknown) {
        return { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: JSON.stringify(formatErrorPayload(err)) }], isError: true } };
      }
    }

    default:
      return { jsonrpc: "2.0", id: req.id, error: { code: JSONRPC_ERROR.METHOD_NOT_FOUND, message: `Method not found: ${req.method}` } };
  }
}

export async function runStdioBridge(
  ctx: McpToolContext,
  input: NodeJS.ReadableStream,
  output: Writable,
): Promise<void> {
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  let serialized = Promise.resolve();
  const waitTasks = new Set<Promise<void>>();
  const waitControllers = new Set<AbortController>();
  let acceptingResponses = true;
  const writeResponse = (response: JsonRpcResponse | null): void => {
    if (acceptingResponses && !output.writableEnded && !output.destroyed && response !== null) {
      output.write(JSON.stringify(response) + "\n");
    }
  };
  const writeFallback = (): void => {
    const fallback: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: null,
      error: { code: JSONRPC_ERROR.INTERNAL_ERROR, message: "Internal error" },
    };
    try { writeResponse(fallback); } catch { /* ignore */ }
  };
  try {
    for await (const rawLine of rl) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      if (isPositiveEventWaitRequest(trimmed)) {
        const controller = new AbortController();
        waitControllers.add(controller);
        const prior = serialized;
        const task = prior
          .then(() => handleJsonRpcLine(trimmed, ctx, controller.signal))
          .then(writeResponse)
          .catch(() => writeFallback());
        waitTasks.add(task);
        void task.finally(() => {
          waitTasks.delete(task);
          waitControllers.delete(controller);
        }).catch(() => {});
        continue;
      }
      serialized = serialized
        .then(() => handleJsonRpcLine(trimmed, ctx))
        .then(writeResponse)
        .catch(() => writeFallback());
    }
  } catch {
    // never throws
  } finally {
    for (const controller of waitControllers) controller.abort();
    await serialized;
    await Promise.allSettled(waitTasks);
    acceptingResponses = false;
    rl.close();
  }
}

function isPositiveEventWaitRequest(line: string): boolean {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw.method !== "tools/call") return false;
    const params = raw.params;
    if (!params || typeof params !== "object" || Array.isArray(params)) return false;
    const call = params as Record<string, unknown>;
    if (call.name !== "agent_turn_events") return false;
    const args = call.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    const waitMs = (args as Record<string, unknown>).wait_ms;
    return typeof waitMs === "number" && Number.isInteger(waitMs) && waitMs > 0 && waitMs <= 20_000;
  } catch {
    return false;
  }
}
