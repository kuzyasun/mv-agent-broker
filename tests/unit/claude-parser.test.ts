import { describe, expect, it } from "vitest";
import { ClaudeAdapter } from "../../src/providers/claude/claudeAdapter.ts";
import {
  isTerminalStop,
  parseClaudeStreamLine,
  parseHookPayload,
} from "../../src/providers/claude/hookEvents.ts";
import { BrokerError } from "../../src/shared/errors.ts";

describe("Claude stream parser (parseClaudeStreamLine)", () => {
  it("parses init event correctly", () => {
    const line = JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-session-001",
    });
    const ev = parseClaudeStreamLine(line);
    expect(ev).toEqual({
      kind: "init",
      session_id: "claude-session-001",
    });
  });

  it("parses assistant text events with single and multiple text blocks", () => {
    const single = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Refactoring code..." }],
      },
    });
    expect(parseClaudeStreamLine(single)).toEqual({
      kind: "assistant_text",
      text: "Refactoring code...",
    });

    const multiple = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Step 1: check. " },
          { type: "text", text: "Step 2: apply." },
        ],
      },
    });
    expect(parseClaudeStreamLine(multiple)).toEqual({
      kind: "assistant_text",
      text: "Step 1: check. Step 2: apply.",
    });

    const directString = JSON.stringify({
      type: "assistant",
      message: {
        content: "Streaming response directly",
      },
    });
    expect(parseClaudeStreamLine(directString)).toEqual({
      kind: "assistant_text",
      text: "Streaming response directly",
    });
  });

  it("parses result events for success and errors", () => {
    const success = JSON.stringify({
      type: "result",
      subtype: "success",
      result: "All tasks completed cleanly",
      is_error: false,
    });
    expect(parseClaudeStreamLine(success)).toEqual({
      kind: "result",
      session_id: null,
      text: "All tasks completed cleanly",
      is_error: false,
    });

    const errorEvent = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      result: "Maximum turn limit reached",
      is_error: true,
    });
    expect(parseClaudeStreamLine(errorEvent)).toEqual({
      kind: "result",
      session_id: null,
      text: "Maximum turn limit reached",
      is_error: true,
    });

    const errorSubtypeOnly = JSON.stringify({
      type: "result",
      subtype: "error_api_failure",
      result: "API rate limited",
    });
    expect(parseClaudeStreamLine(errorSubtypeOnly)).toEqual({
      kind: "result",
      session_id: null,
      text: "API rate limited",
      is_error: true,
    });
  });

  it("returns unknown for unhandled, malformed, or empty lines", () => {
    expect(parseClaudeStreamLine("")).toEqual({ kind: "unknown" });
    expect(parseClaudeStreamLine("   ")).toEqual({ kind: "unknown" });
    expect(parseClaudeStreamLine("invalid json {")).toEqual({ kind: "unknown" });
    expect(parseClaudeStreamLine("12345")).toEqual({ kind: "unknown" });
    expect(parseClaudeStreamLine(JSON.stringify(["array", "not", "object"]))).toEqual({
      kind: "unknown",
    });
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: "system", subtype: "other" })),
    ).toEqual({ kind: "unknown" });
    expect(
      parseClaudeStreamLine(
        JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use" }] } }),
      ),
    ).toEqual({ kind: "unknown" });
    expect(
      parseClaudeStreamLine(JSON.stringify({ type: "unrecognized_type" })),
    ).toEqual({ kind: "unknown" });
  });
});

describe("Claude hook payload parser (parseHookPayload)", () => {
  it("parses SessionStart payloads", () => {
    const payload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-abc-123",
      transcript_path: "/transcripts/sess-abc-123.jsonl",
      source: "startup",
    });
    expect(parseHookPayload(payload)).toEqual({
      event: "SessionStart",
      session_id: "sess-abc-123",
      stop_reason: null,
    });

    const resumePayload = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-def-456",
      transcript_path: "/transcripts/sess-def-456.jsonl",
      source: "resume",
    });
    expect(parseHookPayload(resumePayload)).toEqual({
      event: "SessionStart",
      session_id: "sess-def-456",
      stop_reason: null,
    });
  });

  it("parses Stop payloads with reasons", () => {
    const normalStop = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-abc-123",
      stop_reason: "end_turn",
      message: "turn completed successfully",
    });
    expect(parseHookPayload(normalStop)).toEqual({
      event: "Stop",
      session_id: "sess-abc-123",
      stop_reason: "end_turn",
    });

    const errorStop = JSON.stringify({
      hook_event_name: "Stop",
      session_id: "sess-abc-123",
      stop_reason: "error_max_turns",
      message: "aborted due to turn limits",
    });
    expect(parseHookPayload(errorStop)).toEqual({
      event: "Stop",
      session_id: "sess-abc-123",
      stop_reason: "error_max_turns",
    });
  });

  it("returns null for invalid JSON or payloads without event names", () => {
    expect(parseHookPayload("not json")).toBeNull();
    expect(parseHookPayload("{")).toBeNull();
    expect(parseHookPayload("")).toBeNull();
    expect(parseHookPayload("null")).toBeNull();
    expect(parseHookPayload("123")).toBeNull();
    expect(parseHookPayload("[]")).toBeNull();
    expect(parseHookPayload(JSON.stringify({ session_id: "missing-event" }))).toBeNull();
  });
});

describe("Claude terminal stop classification (isTerminalStop)", () => {
  it("returns true normally", () => {
    expect(isTerminalStop(null)).toBe(true);
    expect(isTerminalStop("end_turn")).toBe(true);
    expect(isTerminalStop("stop_sequence")).toBe(true);
    expect(isTerminalStop("completed")).toBe(true);
    expect(isTerminalStop("normal")).toBe(true);
  });

  it("returns false for error_max_turns, cancel, and other non-terminal stop reasons", () => {
    expect(isTerminalStop("error_max_turns")).toBe(false);
    expect(isTerminalStop("cancel")).toBe(false);
    expect(isTerminalStop("aborted")).toBe(false);
    expect(isTerminalStop("failed")).toBe(false);
    expect(isTerminalStop("interrupted")).toBe(false);
    expect(isTerminalStop("internal_error")).toBe(false);
  });
});

describe("ClaudeAdapter lifecycle and preflight", () => {
  it("initializes with default binary and version", () => {
    const adapter = new ClaudeAdapter();
    expect(adapter.providerId).toBe("claude-code");
    expect(adapter.adapterVersion).toBe("0.2.2");
    expect(adapter.inspectRuntime("sess-1")).toBeNull();
  });

  it("handles preflight checks using config.failPreflight", async () => {
    const adapter = new ClaudeAdapter();
    expect(() => adapter.preflight({})).not.toThrow();

    const error = new BrokerError("PROVIDER_INCOMPATIBLE", "test error");
    expect(() => adapter.preflight({ failPreflight: error })).toThrow(error);
  });

  it("handles idle shutdown and turn interrupt without errors", async () => {
    const adapter = new ClaudeAdapter();
    await expect(adapter.shutdownIdleRuntime("sess-1")).resolves.toBeUndefined();
    await expect(adapter.interruptTurn("turn-1")).resolves.toBe(false);
  });

  it("calls gate.acquireDispatchPermission() before dispatching", async () => {
    const adapter = new ClaudeAdapter();
    const gate = {
      acquireDispatchPermission() {
        throw new BrokerError("INVALID_REQUEST", "cancelled before dispatch");
      },
      cancellationRequested() {
        return null;
      },
    };
    const req = {
      turn_id: "t1",
      session_id: "s1",
      role: "worker" as const,
      provider: "claude-code",
      account_profile_id: "p1",
      requested_model: "claude-3-5-sonnet",
      requested_effort: null,
      instructions_hash: "hash",
      native_conversation_ref: null,
      task_envelope: "envelope",
      workspace_mode: "exclusive" as const,
      workspace_path: null,
      deadline_at: Date.now() + 60_000,
      clock: { now: () => Date.now() },
    };
    await expect(adapter.executeTurn(req, gate, () => {})).rejects.toThrow("cancelled before dispatch");
  });
});
