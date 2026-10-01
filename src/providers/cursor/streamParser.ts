/**
 * Stream JSON parser for the Cursor agent CLI.
 *
 * Emits typed events from line-delimited JSON stream output. Tool call
 * payloads use the native protobuf-JSON flattened oneof encoding observed in
 * the installed CLI: `tool_call.readToolCall.args.path` with a result oneof
 * serialized as case-named keys (`result.permissionDenied`, `result.rejected`,
 * `result.error`, `result.success`). Only observed typed cases produce
 * receipts; receipts carry bounded schema fields only (canonical tool kind,
 * canonical status label, decision, path hash, opaque call id).
 */

import { createHash } from "node:crypto";

export interface CursorToolCallReceipt {
  toolkind: string;
  status: string;
  decision: "allow" | "deny" | "error" | "unknown";
  pathhash: string | null;
  callid: string;
}

export type CursorStreamEvent =
  | { kind: "init"; session_id: string; model: string | null }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; subtype: string; receipt?: CursorToolCallReceipt }
  | { kind: "result"; session_id: string | null; text: string; is_error: boolean; usage: unknown }
  | { kind: "unknown" };

export interface CursorTurnSummary {
  sessionId: string | null;
  assistantText: string;
  resultText: string | null;
  isError: boolean;
  sawResult: boolean;
}

/**
 * Observed tool_call oneof case names mapped to canonical receipt kinds.
 * Strict table only: any other case (including unknown *ToolCall wrappers)
 * maps to "unknown"; no prefix guessing.
 */
export const KNOWN_TOOL_CASES: Record<string, string> = {
  readToolCall: "read",
  grepToolCall: "grep",
  globToolCall: "glob",
  lsToolCall: "ls",
  shellToolCall: "shell",
  mcpToolCall: "mcp",
  editToolCall: "edit",
  writeToolCall: "write",
  deleteToolCall: "delete",
  taskToolCall: "task",
  webSearchToolCall: "web_search",
  webFetchToolCall: "web_fetch",
};

const TOOL_CALL_CASE_KEY = /^[A-Za-z]+ToolCall$/;
const RECEIPT_CALL_ID_MAX = 4096;
const RECEIPT_PATH_MAX = 4096;

/**
 * Persist only an opaque bounded hash, matching trusted hook receipts. A
 * character allowlist would still persist arbitrary prose or sensitive text.
 */
function sanitizeCallId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > RECEIPT_CALL_ID_MAX) return "unknown";
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

/**
 * Typed result statuses observed in the installed CLI. Anything else —
 * including native cases we have not observed for these tools — maps to the
 * canonical "unknown" status without persisting the raw case name.
 */
const RECEIPT_RESULT_CASES: Record<string, { status: string; decision: CursorToolCallReceipt["decision"] }> = {
  permissionDenied: { status: "permissionDenied", decision: "deny" },
  rejected: { status: "rejected", decision: "deny" },
  error: { status: "error", decision: "error" },
  success: { status: "success", decision: "allow" },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function extractToolCallReceipt(obj: Record<string, unknown>): CursorToolCallReceipt | undefined {
  const toolCallObj = obj.tool_call;
  if (!isPlainObject(toolCallObj)) {
    return undefined;
  }

  // Flattened oneof: exactly one case key shaped like a native tool call.
  const caseKeys = Object.keys(toolCallObj).filter((key) => TOOL_CALL_CASE_KEY.test(key));
  const caseName = caseKeys.length === 1 ? caseKeys[0] : undefined;
  if (caseName === undefined) {
    return undefined;
  }
  const toolValue = toolCallObj[caseName];
  if (!isPlainObject(toolValue)) {
    return undefined;
  }

  const toolkind = KNOWN_TOOL_CASES[caseName] ?? "unknown";

  const callid = sanitizeCallId(typeof obj.call_id === "string" ? obj.call_id : toolCallObj.call_id);

  let pathhash: string | null = null;
  if (isPlainObject(toolValue.args) && typeof toolValue.args.path === "string" && toolValue.args.path.trim()) {
    const boundedPath = toolValue.args.path.slice(0, RECEIPT_PATH_MAX);
    pathhash = createHash("sha256").update(boundedPath, "utf8").digest("hex");
  }

  // Typed result oneof only: no is_error-derived success guess. An absent or
  // unobserved result case stays "unknown" and the raw case name is dropped.
  let status = "unknown";
  let decision: CursorToolCallReceipt["decision"] = "unknown";
  if (isPlainObject(toolValue.result)) {
    const resultKeys: string[] = Object.keys(toolValue.result);
    const resultCase = resultKeys.length === 1 ? resultKeys[0] : undefined;
    if (resultCase !== undefined) {
      const typed = RECEIPT_RESULT_CASES[resultCase];
      if (typed) {
        status = typed.status;
        decision = typed.decision;
      }
    }
  }

  return {
    toolkind,
    status,
    decision,
    pathhash,
    callid,
  };
}

export function parseCursorStreamLine(line: string): CursorStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "unknown" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unknown" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unknown" };
  }

  const obj = parsed as Record<string, unknown>;
  const type = obj.type;

  if (type === "system") {
    if (obj.subtype === "init" && typeof obj.session_id === "string" && obj.session_id.trim()) {
      return {
        kind: "init",
        session_id: obj.session_id,
        model: typeof obj.model === "string" ? obj.model : null,
      };
    }
    return { kind: "unknown" };
  }

  if (type === "thinking") {
    if (typeof obj.text === "string") {
      return { kind: "thinking", text: obj.text };
    }
    return { kind: "unknown" };
  }

  if (type === "assistant") {
    if (obj.message && typeof obj.message === "object") {
      const msg = obj.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        const pieces: string[] = [];
        for (const item of msg.content) {
          if (item && typeof item === "object") {
            const part = item as Record<string, unknown>;
            if (part.type === "text" && typeof part.text === "string") {
              pieces.push(part.text);
            }
          }
        }
        if (pieces.length > 0) {
          return { kind: "assistant_text", text: pieces.join("") };
        }
      } else if (typeof msg.content === "string") {
        return { kind: "assistant_text", text: msg.content };
      }
    }
    return { kind: "unknown" };
  }

  if (type === "tool_call") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    let receipt: CursorToolCallReceipt | undefined;
    if (subtype === "completed") {
      receipt = extractToolCallReceipt(obj);
    }
    return {
      kind: "tool_call",
      subtype,
      ...(receipt ? { receipt } : {}),
    };
  }

  if (type === "result") {
    if (typeof obj.is_error !== "boolean" || typeof obj.result !== "string") return { kind: "unknown" };
    const sessionId = typeof obj.session_id === "string" && obj.session_id.trim() ? obj.session_id : null;
    const text = obj.result;
    const isError = obj.is_error === true;
    const usage = obj.usage ?? null;
    return {
      kind: "result",
      session_id: sessionId,
      text,
      is_error: isError,
      usage,
    };
  }

  return { kind: "unknown" };
}

export function summarizeCursorTurn(events: CursorStreamEvent[]): CursorTurnSummary {
  let sessionId: string | null = null;
  let assistantText = "";
  let resultText: string | null = null;
  let isError = false;
  let sawResult = false;

  for (const ev of events) {
    switch (ev.kind) {
      case "init":
        if (sessionId === null) {
          sessionId = ev.session_id;
        }
        break;
      case "assistant_text":
        assistantText += ev.text;
        break;
      case "result":
        sawResult = true;
        if (sessionId === null && ev.session_id !== null) {
          sessionId = ev.session_id;
        }
        resultText = ev.text;
        isError = ev.is_error;
        break;
      case "thinking":
      case "tool_call":
      case "unknown":
        break;
    }
  }

  return {
    sessionId,
    assistantText,
    resultText,
    isError,
    sawResult,
  };
}
