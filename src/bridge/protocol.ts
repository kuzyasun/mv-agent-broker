/**
 * Pure JSON-RPC 2.0 protocol definitions for the MCP stdio transport layer.
 * Spec §4.1: Presentation + bounded RPC only (pure, no fs).
 */

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export const JSONRPC_ERROR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

/**
 * Parses a single line as a JSON-RPC 2.0 request.
 * Returns null on invalid JSON or non-conforming request shape.
 */
export function parseRequest(line: string): JsonRpcRequest | null {
  if (typeof line !== "string") {
    return null;
  }
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }

  const obj = raw as Record<string, unknown>;
  if (obj["jsonrpc"] !== "2.0") {
    return null;
  }

  if (typeof obj["method"] !== "string") {
    return null;
  }

  let id: number | string | null = null;
  if ("id" in obj) {
    const rawId = obj["id"];
    if (typeof rawId === "number" || typeof rawId === "string" || rawId === null) {
      id = rawId;
    } else if (rawId === undefined) {
      id = null;
    } else {
      return null;
    }
  }

  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id,
    method: obj["method"],
  };

  if ("params" in obj) {
    req.params = obj["params"];
  }

  return req;
}
