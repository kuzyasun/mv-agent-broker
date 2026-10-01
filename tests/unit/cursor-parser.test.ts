import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
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

  describe("tool_call receipts and denial observability", () => {
    // Native shape: protobuf-JSON flattened oneof, exactly as the installed
    // CLI emits — tool_call.<caseToolCall>.args/result with case-named result
    // keys.
    it("normalizes flattened readToolCall.result.permissionDenied with hashed path and no raw args", () => {
      const line = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-read-denied",
        tool_call: {
          readToolCall: {
            args: { path: "C:\\projects\\workspace\\secret.txt" },
            result: { permissionDenied: { error: "Hook blocked file access" } },
          },
        },
        session_id: "sess-1",
        timestamp_ms: 1727700000000,
      });
      const ev = parseCursorStreamLine(line);
      expect(ev.kind).toBe("tool_call");
      if (ev.kind === "tool_call") {
        expect(ev.receipt).toEqual({
          toolkind: "read",
          status: "permissionDenied",
          decision: "deny",
          pathhash: createHash("sha256").update("C:\\projects\\workspace\\secret.txt").digest("hex"),
          callid: createHash("sha256").update("call-read-denied").digest("hex").slice(0, 32),
        });
        expect((ev.receipt as any).args).toBeUndefined();
        expect((ev.receipt as any).output).toBeUndefined();
        expect((ev.receipt as any).error).toBeUndefined();
        expect((ev.receipt as any).thinking).toBeUndefined();
      }
    });

    it("normalizes flattened readToolCall rejected, error and success result cases", () => {
      const build = (resultCase: string, value: Record<string, unknown>) => JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-x",
        tool_call: {
          readToolCall: {
            args: { path: "/tmp/foo" },
            result: { [resultCase]: value },
          },
        },
      });
      const evRejected = parseCursorStreamLine(build("rejected", { reason: "User rejected" }));
      if (evRejected.kind === "tool_call") {
        expect(evRejected.receipt?.decision).toBe("deny");
        expect(evRejected.receipt?.status).toBe("rejected");
        expect(evRejected.receipt?.toolkind).toBe("read");
      }

      const evError = parseCursorStreamLine(build("error", { error: "I/O failure" }));
      if (evError.kind === "tool_call") {
        expect(evError.receipt?.decision).toBe("error");
        expect(evError.receipt?.status).toBe("error");
      }

      const evSuccess = parseCursorStreamLine(build("success", { output: { content: "hello" } }));
      if (evSuccess.kind === "tool_call") {
        expect(evSuccess.receipt?.decision).toBe("allow");
        expect(evSuccess.receipt?.status).toBe("success");
      }
    });

    it("normalizes flattened shellToolCall and mcpToolCall permissionDenied", () => {
      const shell = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-shell",
        tool_call: {
          shellToolCall: {
            args: { command: "rm -rf /" },
            result: { permissionDenied: { error: "Shell disabled" } },
          },
        },
      });
      const evShell = parseCursorStreamLine(shell);
      if (evShell.kind === "tool_call") {
        expect(evShell.receipt).toEqual({
          toolkind: "shell",
          status: "permissionDenied",
          decision: "deny",
          pathhash: null,
          callid: createHash("sha256").update("call-shell").digest("hex").slice(0, 32),
        });
      }

      const mcp = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-mcp",
        tool_call: {
          mcpToolCall: {
            args: { name: "dangerous_tool" },
            result: { permissionDenied: { error: "MCP disabled" } },
          },
        },
      });
      const evMcp = parseCursorStreamLine(mcp);
      if (evMcp.kind === "tool_call") {
        expect(evMcp.receipt).toEqual({
          toolkind: "mcp",
          status: "permissionDenied",
          decision: "deny",
          pathhash: null,
          callid: createHash("sha256").update("call-mcp").digest("hex").slice(0, 32),
        });
      }
    });

    it("unknownsuccessnotdeny: unknown tool case with success result does not report deny", () => {
      const line = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-unknown",
        tool_call: {
          customExtensionToolCall: {
            result: { success: {} },
          },
        },
      });
      const ev = parseCursorStreamLine(line);
      if (ev.kind === "tool_call") {
        expect(ev.receipt?.toolkind).toBe("unknown");
        expect(ev.receipt?.status).toBe("success");
        expect(ev.receipt?.decision).toBe("allow");
        expect(ev.receipt?.decision).not.toBe("deny");
      }
    });

    it("unknownstatusdropped: unobserved result cases stay status unknown and never persist the raw case", () => {
      for (const unobserved of ["timeout", "spawnError", "fileBusy", "failure"]) {
        const line = JSON.stringify({
          type: "tool_call",
          subtype: "completed",
          call_id: "call-unobserved",
          tool_call: {
            readToolCall: {
              args: { path: "/tmp/foo" },
              result: { [unobserved]: { detail: "chain-of-thought-marker" } },
            },
          },
        });
        const ev = parseCursorStreamLine(line);
        if (ev.kind === "tool_call") {
          expect(ev.receipt?.status).toBe("unknown");
          expect(ev.receipt?.decision).toBe("unknown");
          expect(JSON.stringify(ev.receipt)).not.toContain(unobserved);
          expect(JSON.stringify(ev.receipt)).not.toContain("chain-of-thought-marker");
        }
      }
    });

    it("noerrorguess: is_error false without a typed result is not a success receipt", () => {
      const line = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-noresult",
        is_error: false,
        tool_call: {
          readToolCall: { args: { path: "/tmp/foo" } },
        },
      });
      const ev = parseCursorStreamLine(line);
      if (ev.kind === "tool_call") {
        expect(ev.receipt?.status).toBe("unknown");
        expect(ev.receipt?.decision).toBe("unknown");
      }
    });

    it("wrongshapeignored: non-flattened tool_call objects produce no receipt", () => {
      for (const malformed of [
        { type: "tool_call", subtype: "completed", tool_call: "not an object" },
        { type: "tool_call", subtype: "completed", tool_call: 12345 },
        { type: "tool_call", subtype: "completed", tool_call: null },
        { type: "tool_call", subtype: "completed", tool_call: [] },
        // Synthetic {tool:{case,value}} shape is not the native wire format.
        { type: "tool_call", subtype: "completed", tool_call: { tool: { case: "readToolCall", value: { result: { result: { case: "success", value: {} } } } } } },
        { type: "tool_call", subtype: "completed", tool_call: { case: "readToolCall", value: { result: { case: "success", value: {} } } } },
        // Two case keys at once is malformed.
        { type: "tool_call", subtype: "completed", tool_call: { readToolCall: {}, grepToolCall: {} } },
      ]) {
        const ev = parseCursorStreamLine(JSON.stringify(malformed));
        expect(ev.kind).toBe("tool_call");
        if (ev.kind === "tool_call") {
          expect(ev.receipt).toBeUndefined();
        }
      }
    });

    it("fieldbombsbounded: bounds giant fields and stores zero raw args, output, env, or thinking", () => {
      const giantString = "x".repeat(100_000);
      const line = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "call-" + "c".repeat(500),
        thinking: giantString,
        tool_call: {
          readToolCall: {
            args: { path: "C:\\path\\" + "a".repeat(10_000), extraBomb: giantString },
            output: giantString,
            thinking: giantString,
            env: giantString,
            result: { permissionDenied: { error: giantString } },
          },
        },
      });
      const ev = parseCursorStreamLine(line);
      if (ev.kind === "tool_call") {
        expect(ev.receipt).toBeDefined();
        expect(ev.receipt!.callid.length).toBeLessThanOrEqual(128);
        expect(ev.receipt!.toolkind).toBe("read");
        expect(ev.receipt!.toolkind.length).toBeLessThanOrEqual(32);
        expect(ev.receipt!.status).toBe("permissionDenied");
        expect(ev.receipt!.status.length).toBeLessThanOrEqual(32);
        expect(ev.receipt!.pathhash).toHaveLength(64);
        expect(Object.keys(ev.receipt!).sort()).toEqual(["callid", "decision", "pathhash", "status", "toolkind"]);
        expect(JSON.stringify(ev.receipt)).not.toContain("xxxx");
      }
    });

    it("hashes complete call ids without persisting arbitrary source text", () => {
      const line = JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "bad id\nwith\tcontrol\u0001chars",
        tool_call: { readToolCall: { args: { path: "/tmp/foo" }, result: { success: {} } } },
      });
      const ev = parseCursorStreamLine(line);
      if (ev.kind === "tool_call") {
        expect(ev.receipt?.callid).toBe(createHash("sha256").update("bad id\nwith\tcontrol\u0001chars").digest("hex").slice(0, 32));
        expect(JSON.stringify(ev.receipt)).not.toContain("badidwithcontrolchars");
        expect(ev.receipt?.callid).not.toMatch(/[\n\t\u0001 ]/);
      }
      const empty = parseCursorStreamLine(JSON.stringify({
        type: "tool_call",
        subtype: "completed",
        call_id: "",
        tool_call: { lsToolCall: { result: { success: {} } } },
      }));
      if (empty.kind === "tool_call") {
        expect(empty.receipt?.callid).toBe("unknown");
        expect(empty.receipt?.toolkind).toBe("ls");
      }
    });

    it("zero thinking text in progress: thinking stream events are separate from progress", () => {
      const line = JSON.stringify({
        type: "thinking",
        subtype: "delta",
        text: "Secret internal chain-of-thought",
      });
      const ev = parseCursorStreamLine(line);
      expect(ev.kind).toBe("thinking");
      if (ev.kind === "thinking") {
        expect(ev.text).toBe("Secret internal chain-of-thought");
      }
    });
  });
});
