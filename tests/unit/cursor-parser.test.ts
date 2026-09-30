import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseCursorStreamLine,
  summarizeCursorTurn,
  type CursorStreamEvent,
} from "../../src/providers/cursor/streamParser.ts";

describe("Cursor stream parser", () => {
  it("parses retained native Windows output with the display model name", () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/native-smoke/2026-09-30-cursor/adapter-resume.evidence.json", import.meta.url), "utf8"));
    const events = evidence.processes[0].stdout.trim().split(/\r?\n/).map(parseCursorStreamLine);
    expect(events[0]).toEqual({ kind: "init", session_id: evidence.turns[0].observedNativeRef, model: "GPT-5.4 Mini None" });
    const summary = summarizeCursorTurn(events);
    expect(summary.sawResult).toBe(true); expect(summary.isError).toBe(false);
    expect(summary.sessionId).toBe(evidence.turns[0].result.native_conversation_ref);
    expect(summary.resultText).toBe(evidence.turns[0].result.agent_reported.summary);
  });
  it.each([
    { type: "result", result: "ok" },
    { type: "result", is_error: "false", result: "ok" },
    { type: "result", is_error: false, result: {} },
    { type: "system", subtype: "init", session_id: " " },
  ])("does not turn malformed native records into success %j", record => {
    expect(parseCursorStreamLine(JSON.stringify(record))).toEqual({ kind: "unknown" });
  });
  describe("parseCursorStreamLine", () => {
    it("captures init event with session_id and model", () => {
      const line = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-123",
        model: "claude-3-5-sonnet",
        cwd: "C:\\projects\\workspace",
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "init",
        session_id: "cursor-session-123",
        model: "claude-3-5-sonnet",
      });
    });

    it("captures init event when model is omitted", () => {
      const line = JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "cursor-session-456",
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "init",
        session_id: "cursor-session-456",
        model: null,
      });
    });

    it("ignores system events with subtype other than init", () => {
      const line = JSON.stringify({
        type: "system",
        subtype: "heartbeat",
      });
      expect(parseCursorStreamLine(line)).toEqual({ kind: "unknown" });
    });

    it("parses assistant text with array content", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Hello " },
            { type: "text", text: "world!" },
          ],
        },
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "assistant_text",
        text: "Hello world!",
      });
    });

    it("parses assistant text with string content", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: "Direct string message",
        },
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "assistant_text",
        text: "Direct string message",
      });
    });

    it("parses thinking event", () => {
      const line = JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "Analyzing project structure...",
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "thinking",
        text: "Analyzing project structure...",
      });
    });

    it("parses tool_call event with subtype", () => {
      const started = JSON.stringify({
        type: "tool_call",
        subtype: "started",
        tool: "read_file",
      });
      expect(parseCursorStreamLine(started)).toEqual({
        kind: "tool_call",
        subtype: "started",
      });

      const completed = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
      });
      expect(parseCursorStreamLine(completed)).toEqual({
        kind: "tool_call",
        subtype: "completed",
      });
    });

    it("parses result event for success (is_error: false)", () => {
      const line = JSON.stringify({
        type: "result",
        session_id: "cursor-session-123",
        result: "Task completed successfully",
        is_error: false,
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "result",
        session_id: "cursor-session-123",
        text: "Task completed successfully",
        is_error: false,
        usage: { prompt_tokens: 50, completion_tokens: 25 },
      });
    });

    it("parses result event for failure (is_error: true)", () => {
      const line = JSON.stringify({
        type: "result",
        session_id: "cursor-session-123",
        result: "Command execution failed with exit code 1",
        is_error: true,
        usage: null,
      });
      const ev = parseCursorStreamLine(line);
      expect(ev).toEqual({
        kind: "result",
        session_id: "cursor-session-123",
        text: "Command execution failed with exit code 1",
        is_error: true,
        usage: null,
      });
    });

    it("returns unknown for blank lines and invalid JSON", () => {
      expect(parseCursorStreamLine("")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine("   \t\r\n")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine("not valid json")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine("12345")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine("true")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine("[1, 2, 3]")).toEqual({ kind: "unknown" });
      expect(parseCursorStreamLine(JSON.stringify({ type: "other_unhandled_type" }))).toEqual({
        kind: "unknown",
      });
    });
  });

  describe("summarizeCursorTurn", () => {
    it("returns default values for empty event stream", () => {
      const summary = summarizeCursorTurn([]);
      expect(summary).toEqual({
        sessionId: null,
        assistantText: "",
        resultText: null,
        isError: false,
        sawResult: false,
      });
    });

    it("accumulates assistantText and captures session and result correctly", () => {
      const events: CursorStreamEvent[] = [
        { kind: "init", session_id: "session-abc", model: "claude-3-5-sonnet" },
        { kind: "thinking", text: "Step 1..." },
        { kind: "assistant_text", text: "Hello " },
        { kind: "tool_call", subtype: "started" },
        { kind: "tool_call", subtype: "completed" },
        { kind: "assistant_text", text: "there!" },
        {
          kind: "result",
          session_id: "session-abc",
          text: "Done with everything",
          is_error: false,
          usage: null,
        },
      ];

      const summary = summarizeCursorTurn(events);
      expect(summary).toEqual({
        sessionId: "session-abc",
        assistantText: "Hello there!",
        resultText: "Done with everything",
        isError: false,
        sawResult: true,
      });
    });

    it("captures sessionId from result if init was absent", () => {
      const events: CursorStreamEvent[] = [
        { kind: "assistant_text", text: "Work in progress" },
        {
          kind: "result",
          session_id: "session-from-result",
          text: "Finished",
          is_error: false,
          usage: null,
        },
      ];

      const summary = summarizeCursorTurn(events);
      expect(summary.sessionId).toBe("session-from-result");
      expect(summary.sawResult).toBe(true);
      expect(summary.isError).toBe(false);
    });

    it("sets isError to true when result has is_error: true", () => {
      const events: CursorStreamEvent[] = [
        { kind: "init", session_id: "sess-err", model: null },
        {
          kind: "result",
          session_id: "sess-err",
          text: "Fatal error encountered",
          is_error: true,
          usage: null,
        },
      ];

      const summary = summarizeCursorTurn(events);
      expect(summary.sawResult).toBe(true);
      expect(summary.isError).toBe(true);
      expect(summary.resultText).toBe("Fatal error encountered");
    });

    it("flags sawResult as false if no result event is received", () => {
      const events: CursorStreamEvent[] = [
        { kind: "init", session_id: "sess-incomplete", model: "gpt-4" },
        { kind: "assistant_text", text: "Interrupted stream..." },
      ];

      const summary = summarizeCursorTurn(events);
      expect(summary.sawResult).toBe(false);
      expect(summary.resultText).toBeNull();
      expect(summary.isError).toBe(false);
      expect(summary.assistantText).toBe("Interrupted stream...");
    });
  });
});
