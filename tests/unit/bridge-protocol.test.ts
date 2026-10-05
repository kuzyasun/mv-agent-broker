/**
 * Unit tests for MCP stdio transport layer (spec §4.1, API 0.2).
 * Verifies line-delimited JSON-RPC 2.0 handling without filesystem dependencies.
 */

import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  JSONRPC_ERROR,
  MCP_PROTOCOL_VERSION,
  parseRequest,
} from "../../src/bridge/protocol.ts";
import {
  handleJsonRpcLine,
  runStdioBridge,
  type McpToolContext,
  type McpToolDef,
} from "../../src/bridge/server.ts";
import { callBridgeTool, bridgeToolDefs } from "../../src/bridge/tools.ts";
import type { BrokerCore } from "../../src/core/broker.ts";

const mockDefs: McpToolDef[] = [
  {
    name: "test_tool",
    description: "A test tool",
    inputSchema: { type: "object" },
  },
  {
    name: "calculator",
    description: "Calculates numbers",
    inputSchema: {
      type: "object",
      properties: { a: { type: "number" }, b: { type: "number" } },
      required: ["a", "b"],
    },
  },
];

function createMockContext(overrides?: {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  listTools?: () => McpToolDef[];
}): McpToolContext {
  return {
    listTools: overrides?.listTools ?? (() => mockDefs),
    callTool:
      overrides?.callTool ??
      (async (name, args) => ({ called: name, args })),
  };
}

describe("MCP protocol parser (protocol.ts)", () => {
  it("parses valid JSON-RPC 2.0 requests with numeric, string, or omitted id", () => {
    const req1 = parseRequest('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(req1).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });

    const req2 = parseRequest('{"jsonrpc":"2.0","id":"abc-123","method":"tools/list"}');
    expect(req2).toEqual({
      jsonrpc: "2.0",
      id: "abc-123",
      method: "tools/list",
    });

    const req3 = parseRequest('{"jsonrpc":"2.0","method":"notifications/initialized"}');
    expect(req3).toEqual({
      jsonrpc: "2.0",
      id: null,
      method: "notifications/initialized",
    });

    const req4 = parseRequest('{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"test"}}');
    expect(req4).toEqual({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "test" },
    });
  });

  it("returns null on invalid JSON or invalid request shapes", () => {
    expect(parseRequest("")).toBeNull();
    expect(parseRequest("   ")).toBeNull();
    expect(parseRequest("{ invalid json ")).toBeNull();
    expect(parseRequest("123")).toBeNull();
    expect(parseRequest('"hello"')).toBeNull();
    expect(parseRequest("[]")).toBeNull();
    expect(parseRequest('{"id":1,"method":"initialize"}')).toBeNull(); // missing jsonrpc
    expect(parseRequest('{"jsonrpc":"1.0","id":1,"method":"initialize"}')).toBeNull();
    expect(parseRequest('{"jsonrpc":"2.0","id":1}')).toBeNull(); // missing method
    expect(parseRequest('{"jsonrpc":"2.0","id":true,"method":"initialize"}')).toBeNull(); // invalid id type
  });
});

describe("MCP JSON-RPC line handler (server.ts)", () => {
  it("initialize handshake returns protocolVersion and serverInfo", async () => {
    const ctx = createMockContext();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "agent-broker", version: "0.2.0" },
      },
    });
  });

  it("tools/list returns defs from ctx", async () => {
    const ctx = createMockContext();
    const line = JSON.stringify({ jsonrpc: "2.0", id: "req-tools", method: "tools/list" });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: "req-tools",
      result: {
        tools: mockDefs,
      },
    });
  });

  it("tools/call success maps to content[0].text JSON with isError false", async () => {
    const ctx = createMockContext({
      callTool: async (name, args) => ({ ok: true, data: { name, args } }),
    });
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "test_tool", arguments: { query: "hello" } },
    });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 42,
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, data: { name: "test_tool", args: { query: "hello" } } }),
          },
        ],
        isError: false,
      },
    });
  });

  it("tools/call throwing an Error with (error as any).isToolError=true sets isError true and content text contains ok:false", async () => {
    const toolError = new Error("Tool execution failed");
    (toolError as any).isToolError = true;
    (toolError as any).code = "TOOL_FAILED";

    const ctx = createMockContext({
      callTool: async () => {
        throw toolError;
      },
    });
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "failing_tool", arguments: {} },
    });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res?.error).toBeUndefined();
    expect(res?.result).toBeDefined();
    const result = res!.result as { content: Array<{ type: string; text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");

    const parsedContent = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsedContent.ok).toBe(false);
    expect(parsedContent.error).toBeDefined();
    expect(parsedContent.error.message).toBe("Tool execution failed");
    expect(parsedContent.error.code).toBe("TOOL_FAILED");
  });

  it("method not found returns METHOD_NOT_FOUND", async () => {
    const ctx = createMockContext();
    const line = JSON.stringify({ jsonrpc: "2.0", id: 99, method: "non_existent_method" });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 99,
      error: {
        code: JSONRPC_ERROR.METHOD_NOT_FOUND,
        message: "Method not found: non_existent_method",
      },
    });
  });

  it("invalid JSON line returns PARSE_ERROR response with id null", async () => {
    const ctx = createMockContext();
    const res = await handleJsonRpcLine("not a json string at all {", ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: JSONRPC_ERROR.PARSE_ERROR,
        message: expect.any(String),
      },
    });
  });

  it("notifications return null", async () => {
    const ctx = createMockContext();
    const line1 = JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(await handleJsonRpcLine(line1, ctx)).toBeNull();

    const line2 = JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      method: "notifications/initialized",
    });
    expect(await handleJsonRpcLine(line2, ctx)).toBeNull();

    const line3 = JSON.stringify({
      jsonrpc: "2.0",
      method: "initialized",
    });
    expect(await handleJsonRpcLine(line3, ctx)).toBeNull();
  });

  it("tools/call with missing tool name returns INVALID_PARAMS", async () => {
    const ctx = createMockContext();
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {},
    });
    const res = await handleJsonRpcLine(line, ctx);

    expect(res).toEqual({
      jsonrpc: "2.0",
      id: 5,
      error: {
        code: JSONRPC_ERROR.INVALID_PARAMS,
        message: "Invalid params: missing tool name",
      },
    });
  });

  it("empty lines return null", async () => {
    const ctx = createMockContext();
    expect(await handleJsonRpcLine("", ctx)).toBeNull();
    expect(await handleJsonRpcLine("   \n", ctx)).toBeNull();
  });
});

describe("runStdioBridge transport loop", () => {
  it("runStdioBridge roundtrip: writes 3 lines into PassThrough input, collects output lines, asserts 2 responses (skip notification), and resolves on input end", async () => {
    const ctx = createMockContext();
    const input = new PassThrough();
    const output = new PassThrough();

    const outputChunks: string[] = [];
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      outputChunks.push(chunk);
    });

    const bridgePromise = runStdioBridge(ctx, input, output);

    // 1. Valid initialize request
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) + "\n");

    // 2. Notification (no response generated)
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    // 3. Valid tools/list request
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");

    input.end();
    await bridgePromise;

    const rawOutput = outputChunks.join("");
    const lines = rawOutput.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);

    const parsed1 = JSON.parse(lines[0]!);
    expect(parsed1.id).toBe(1);
    expect(parsed1.result.serverInfo.name).toBe("agent-broker");
    expect(parsed1.result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);

    const parsed2 = JSON.parse(lines[1]!);
    expect(parsed2.id).toBe(2);
    expect(parsed2.result.tools).toEqual(mockDefs);
  });
});

// ─── §8.3 additive spawn workspace fields at the bridge boundary ────────────

describe("agent_session_send binding guidance", () => {
  it.each(["review_binding", "workspace_precondition", "git_review_binding"])("rejects null %s before admission with actionable guidance", async (bindingName) => {
    const send = vi.fn();
    await expect(callBridgeTool({ coordinatorId: "coord", core: { send } as unknown as BrokerCore }, "agent_session_send", {
      session_id: "s", idempotency_key: "k", task: { goal: "review", artifact_refs: [] }, [bindingName]: null,
    })).rejects.toMatchObject({ code: "INVALID_REQUEST", message: expect.stringContaining(`${bindingName} must be an object`) });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects contradictory bindings before admission and explains the one-binding rule", async () => {
    const send = vi.fn();
    await expect(callBridgeTool({ coordinatorId: "coord", core: { send } as unknown as BrokerCore }, "agent_session_send", {
      session_id: "s", idempotency_key: "k", task: { goal: "review", checks: [], artifact_refs: [] },
      review_binding: { baseline_snapshot_id: "base", target_snapshot_id: "target" },
      workspace_precondition: { expected_snapshot_id: "target" },
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Exactly one of workspace_precondition / review_binding / git_review_binding is required"),
    });
    expect(send).not.toHaveBeenCalled();
    await expect(callBridgeTool({ coordinatorId: "coord", core: { send } as unknown as BrokerCore }, "agent_session_send", {
      session_id: "s", idempotency_key: "k2", task: { goal: "review", checks: [], artifact_refs: [] },
      git_review_binding: { base_commit: "a".repeat(40), target_commit: "b".repeat(40) },
      review_binding: { baseline_snapshot_id: "base", target_snapshot_id: "target" },
    })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Git reviewer turns send git_review_binding only"),
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("agent_session_spawn additive worktree workspace fields (§8.3)", () => {
  function recordingCore() {
    const calls: Array<Record<string, unknown>> = [];
    const core = {
      spawn: (_coordinatorId: string, req: Record<string, unknown>) => {
        calls.push(req);
        return { session_id: "session-stub", state: "PROVISIONING", replayed_request: false, worktree: null };
      },
    };
    return { calls, core: core as unknown as BrokerCore };
  }

  function spawnArgs(workspace: Record<string, unknown>): Record<string, unknown> {
    return {
      project_id: "p",
      idempotency_key: "k",
      provider: "mock",
      account_profile_id: "acct",
      model: "m",
      role: "worker",
      instructions: "i",
      workspace,
      policy_profile_id: "pol",
    };
  }

  it("passes repository_workspace_id and base_commit through to the broker core", async () => {
    const { calls, core } = recordingCore();
    await callBridgeTool(
      { coordinatorId: "coord", core },
      "agent_session_spawn",
      spawnArgs({ mode: "worktree", repository_workspace_id: "ws-src", base_commit: "a".repeat(40) }),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.workspace).toEqual({
      mode: "worktree",
      workspace_id: null,
      repository_workspace_id: "ws-src",
      base_commit: "a".repeat(40),
    });
  });

  it("keeps existing current/review_slot/registered-worktree calls unchanged (no additive keys)", async () => {
    const { calls, core } = recordingCore();
    await callBridgeTool(
      { coordinatorId: "coord", core },
      "agent_session_spawn",
      spawnArgs({ mode: "current", workspace_id: "ws-main" }),
    );
    expect(calls[0]!.workspace).toEqual({ mode: "current", workspace_id: "ws-main" });
  });

  it("rejects unknown workspace keys and non-string additive values", async () => {
    const { core } = recordingCore();
    const ctx = { coordinatorId: "coord", core };
    await expect(
      callBridgeTool(ctx, "agent_session_spawn", spawnArgs({ mode: "worktree", repository_path: "/etc/passwd" })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      callBridgeTool(ctx, "agent_session_spawn", spawnArgs({ mode: "worktree", base_commit: 123 })),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("advertises the additive properties in the spawn tool schema (closed object)", () => {
    const def = bridgeToolDefs().find((d) => d.name === "agent_session_spawn")!;
    const workspace = (def.inputSchema as {
      properties: { workspace: { properties: Record<string, { type: string }>; additionalProperties: boolean } };
    }).properties.workspace;
    expect(workspace.properties.repository_workspace_id).toEqual({ type: "string" });
    expect(workspace.properties.base_commit).toEqual({ type: "string" });
    expect(workspace.additionalProperties).toBe(false);
  });
});
