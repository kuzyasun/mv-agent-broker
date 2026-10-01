import { describe, expect, it } from "vitest";
import {
  parseAntigravityStreamLine,
  summarizeAntigravityTurn,
  type AntigravityStreamEvent,
} from "../../src/providers/antigravity/streamParser.ts";
import { AntigravityAdapter } from "../../src/providers/antigravity/antigravityAdapter.ts";
import { BrokerError } from "../../src/shared/errors.ts";

describe("Antigravity stream parser", () => {
  describe("parseAntigravityStreamLine", () => {
    it("parses step_update delta", () => {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { text_delta: "streaming token delta" },
      });
      const ev = parseAntigravityStreamLine(line);
      expect(ev).toEqual({
        kind: "text_delta",
        text: "streaming token delta",
      });
    });

    it("parses result SUCCESS", () => {
      const line = JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Turn completed successfully.",
          error: null,
        },
      });
      const ev = parseAntigravityStreamLine(line);
      expect(ev).toEqual({
        kind: "result",
        status: "SUCCESS",
        response: "Turn completed successfully.",
        error: null,
      });
    });

    it("parses result FAILED (error text)", () => {
      const line = JSON.stringify({
        event: "result",
        result: {
          status: "FAILED",
          response: null,
          error: "Permission denied while writing file.",
        },
      });
      const ev = parseAntigravityStreamLine(line);
      expect(ev).toEqual({
        kind: "result",
        status: "FAILED",
        response: null,
        error: "Permission denied while writing file.",
      });
    });

    it("parses conversation_id from top-level", () => {
      expect(
        parseAntigravityStreamLine(JSON.stringify({ conversationId: "agy-top-1" })),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-top-1",
      });

      expect(
        parseAntigravityStreamLine(JSON.stringify({ conversation_id: "agy-top-2" })),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-top-2",
      });

      expect(
        parseAntigravityStreamLine(JSON.stringify({ session_id: "agy-top-3" })),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-top-3",
      });
    });

    it("parses conversation_id from nested result object", () => {
      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ result: { conversation_id: "agy-nested-res-1" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-res-1",
      });

      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ result: { conversationId: "agy-nested-res-2" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-res-2",
      });

      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ result: { session_id: "agy-nested-res-3" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-res-3",
      });
    });

    it("parses conversation_id from nested step_update object", () => {
      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ step_update: { conversation_id: "agy-nested-su-1" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-su-1",
      });

      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ step_update: { conversationId: "agy-nested-su-2" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-su-2",
      });

      expect(
        parseAntigravityStreamLine(
          JSON.stringify({ step_update: { session_id: "agy-nested-su-3" } }),
        ),
      ).toEqual({
        kind: "conversation_id",
        id: "agy-nested-su-3",
      });
    });

    it("parses result SUCCESS with nested conversation_id without dropping the ID", () => {
      const line = JSON.stringify({
        event: "result",
        result: {
          status: "SUCCESS",
          response: "Final handoff text.",
          error: null,
          conversation_id: "agy-from-result-1",
        },
      });
      const ev = parseAntigravityStreamLine(line);
      expect(ev).toEqual({
        kind: "result",
        status: "SUCCESS",
        response: "Final handoff text.",
        error: null,
        conversation_id: "agy-from-result-1",
      });
      const summary = summarizeAntigravityTurn([ev]);
      expect(summary.sawResult).toBe(true);
      expect(summary.response).toBe("Final handoff text.");
      expect(summary.conversationId).toBe("agy-from-result-1");
    });

    it("preserves text_delta and conversation_id from one step_update record", () => {
      const line = JSON.stringify({
        event: "step_update",
        step_update: { text_delta: "partial ", conversation_id: "agy-delta-id" },
      });
      const ev = parseAntigravityStreamLine(line);
      expect(ev).toEqual({
        kind: "text_delta",
        text: "partial ",
        conversation_id: "agy-delta-id",
      });
      expect(summarizeAntigravityTurn([ev]).conversationId).toBe("agy-delta-id");
    });

    it("never fabricates an ID from request echo and keeps the first observed ID", () => {
      const events = [
        parseAntigravityStreamLine(JSON.stringify({ conversation_id: "agy-first" })),
        parseAntigravityStreamLine(JSON.stringify({
          event: "result",
          result: { status: "SUCCESS", response: "ok", conversation_id: "agy-different" },
        })),
      ];
      expect(summarizeAntigravityTurn(events).conversationId).toBe("agy-first");
    });

    it("returns unknown for blank lines and invalid JSON", () => {
      expect(parseAntigravityStreamLine("")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("   \t\r\n")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("not valid json")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("12345")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("true")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("[1, 2, 3]")).toEqual({ kind: "unknown" });
      expect(parseAntigravityStreamLine("{}")).toEqual({ kind: "unknown" });
      expect(
        parseAntigravityStreamLine(JSON.stringify({ event: "other_event", data: "ignored" })),
      ).toEqual({ kind: "unknown" });
    });
  });

  describe("summarizeAntigravityTurn", () => {
    it("returns default values for empty event stream", () => {
      const summary = summarizeAntigravityTurn([]);
      expect(summary).toEqual({
        conversationId: null,
        text: "",
        response: null,
        status: null,
        error: null,
        sawResult: false,
      });
    });

    it("handles summarize accumulation and first-id-wins for conversation_id", () => {
      const events: AntigravityStreamEvent[] = [
        { kind: "conversation_id", id: "first-conv-id" },
        { kind: "text_delta", text: "Delta part 1. " },
        { kind: "conversation_id", id: "second-conv-id" },
        { kind: "text_delta", text: "Delta part 2. " },
        { kind: "text_delta", text: "Delta part 3." },
        {
          kind: "result",
          status: "SUCCESS",
          response: "Final synthesized answer.",
          error: null,
        },
      ];

      const summary = summarizeAntigravityTurn(events);
      expect(summary).toEqual({
        conversationId: "first-conv-id",
        text: "Delta part 1. Delta part 2. Delta part 3.",
        response: "Final synthesized answer.",
        status: "SUCCESS",
        error: null,
        sawResult: true,
      });
    });

    it("summarizes failed turn with error message", () => {
      const events: AntigravityStreamEvent[] = [
        { kind: "conversation_id", id: "failed-turn-id" },
        { kind: "text_delta", text: "Something started..." },
        {
          kind: "result",
          status: "FAILED",
          response: null,
          error: "Process killed by safety boundary.",
        },
      ];

      const summary = summarizeAntigravityTurn(events);
      expect(summary.conversationId).toBe("failed-turn-id");
      expect(summary.sawResult).toBe(true);
      expect(summary.status).toBe("FAILED");
      expect(summary.error).toBe("Process killed by safety boundary.");
      expect(summary.response).toBeNull();
      expect(summary.text).toBe("Something started...");
    });

    it("flags sawResult as false if no result event is received", () => {
      const events: AntigravityStreamEvent[] = [
        { kind: "conversation_id", id: "sess-incomplete" },
        { kind: "text_delta", text: "Stream truncated unexpectedly." },
      ];

      const summary = summarizeAntigravityTurn(events);
      expect(summary.sawResult).toBe(false);
      expect(summary.status).toBeNull();
      expect(summary.response).toBeNull();
      expect(summary.error).toBeNull();
      expect(summary.conversationId).toBe("sess-incomplete");
      expect(summary.text).toBe("Stream truncated unexpectedly.");
    });
  });

  describe("AntigravityAdapter lifecycle and preflight", () => {
    it("initializes with default binary and version", () => {
      const adapter = new AntigravityAdapter();
      expect(adapter.providerId).toBe("antigravity");
      expect(adapter.adapterVersion).toBe("0.2.3");
      expect(adapter.inspectRuntime("sess-1")).toBeNull();
    });

    it("initializes with custom binary and model", () => {
      const adapter = new AntigravityAdapter({ binary: "custom-agy", model: "gemini-3.5-pro" });
      expect(adapter.providerId).toBe("antigravity");
    });

    it("handles preflight checks", () => {
      const adapter = new AntigravityAdapter();
      expect(() => adapter.preflight({})).not.toThrow();

      const error = new BrokerError("PROVIDER_INCOMPATIBLE", "AGY CLI incompatible");
      expect(() => adapter.preflight({ failPreflight: error })).toThrow(error);

      const emptyBinaryAdapter = new AntigravityAdapter({ binary: "" });
      expect(() => emptyBinaryAdapter.preflight({})).toThrowError(/not configured/);
    });

    it("handles idle shutdown and turn interrupt without errors", async () => {
      const adapter = new AntigravityAdapter();
      await expect(adapter.shutdownIdleRuntime("sess-1")).resolves.toBeUndefined();
      await expect(adapter.interruptTurn("turn-1")).resolves.toBe(false);
    });

    it("calls gate.acquireDispatchPermission() before dispatching", async () => {
      const adapter = new AntigravityAdapter();
      const gate = {
        acquireDispatchPermission() {
          throw new BrokerError("INVALID_REQUEST", "cancelled before dispatch");
        },
        cancellationRequested() {
          return null;
        },
      };
      const req = {
        turn_id: "turn-agy-1",
        session_id: "sess-agy-1",
        role: "worker" as const,
        provider: "antigravity",
        account_profile_id: "profile-1",
        requested_model: "gemini-3.5-pro",
        requested_effort: null,
        instructions_hash: "hash-xyz",
        native_conversation_ref: null,
        task_envelope: "Implement Antigravity adapter",
        workspace_mode: "exclusive" as const,
        workspace_path: null,
        deadline_at: Date.now() + 60_000,
        clock: { now: () => Date.now() },
      };

      await expect(adapter.executeTurn(req, gate, () => {})).rejects.toThrow("cancelled before dispatch");
      expect(adapter.dispatchPermissionAcquired("turn-agy-1")).toBe(false);
    });
  });

  describe("Antigravity bootstrap registration", () => {
    it("registers antigravity adapter only when env.antigravityBinary is provided", async () => {
      const { buildAdapters, daemonEnvFromProcess } = await import("../../src/daemon/bootstrap.ts");

      const withoutAgy = buildAdapters({
        stateDir: "./test-state",
        coordinatorId: "coord-1",
      });
      expect(withoutAgy.has("antigravity")).toBe(false);

      const withAgy = buildAdapters({
        stateDir: "./test-state",
        coordinatorId: "coord-1",
        antigravityBinary: "C:\\path\\to\\agy.exe",
      });
      expect(withAgy.has("antigravity")).toBe(true);
      expect(withAgy.get("antigravity")?.providerId).toBe("antigravity");

      const parsedEnv = daemonEnvFromProcess({
        AB_ANTIGRAVITY_BIN: "C:\\bin\\agy.exe",
      });
      expect(parsedEnv.antigravityBinary).toBe("C:\\bin\\agy.exe");
    });
  });
});
