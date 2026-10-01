import { describe, expect, it } from "vitest";
import { CodexAdapter } from "../../src/providers/codex/codexAdapter.ts";
import {
  isTurnComplete,
  parseCodexNotify,
  type CodexNotifyPayload,
} from "../../src/providers/codex/notifyEvents.ts";
import { BrokerError } from "../../src/shared/errors.ts";

describe("Codex notify parser (parseCodexNotify)", () => {
  it("parses thread-id key variants: 'thread-id', 'thread_id', 'threadId'", () => {
    const hyphen = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "th-hyphen-101",
    });
    expect(parseCodexNotify(hyphen)).toEqual({
      type: "agent-turn-complete",
      threadId: "th-hyphen-101",
      turnId: null,
      lastAssistantMessage: null,
      cwd: null,
    });

    const snake = JSON.stringify({
      type: "agent-turn-complete",
      thread_id: "th-snake-202",
    });
    expect(parseCodexNotify(snake)).toEqual({
      type: "agent-turn-complete",
      threadId: "th-snake-202",
      turnId: null,
      lastAssistantMessage: null,
      cwd: null,
    });

    const camel = JSON.stringify({
      type: "agent-turn-complete",
      threadId: "th-camel-303",
    });
    expect(parseCodexNotify(camel)).toEqual({
      type: "agent-turn-complete",
      threadId: "th-camel-303",
      turnId: null,
      lastAssistantMessage: null,
      cwd: null,
    });
  });

  it("parses turn-id key variants: 'turn-id', 'turn_id', 'turnId'", () => {
    const hyphen = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "th-1",
      "turn-id": "turn-hyphen-1",
    });
    expect(parseCodexNotify(hyphen)?.turnId).toBe("turn-hyphen-1");

    const snake = JSON.stringify({
      type: "agent-turn-complete",
      thread_id: "th-1",
      turn_id: "turn-snake-2",
    });
    expect(parseCodexNotify(snake)?.turnId).toBe("turn-snake-2");

    const camel = JSON.stringify({
      type: "agent-turn-complete",
      threadId: "th-1",
      turnId: "turn-camel-3",
    });
    expect(parseCodexNotify(camel)?.turnId).toBe("turn-camel-3");
  });

  it("parses last-assistant-message key variants", () => {
    const hyphen = JSON.stringify({
      type: "agent-turn-complete",
      "last-assistant-message": "Fixed the bug in module A",
    });
    expect(parseCodexNotify(hyphen)?.lastAssistantMessage).toBe("Fixed the bug in module A");

    const snake = JSON.stringify({
      type: "agent-turn-complete",
      last_assistant_message: "Refactored the parser",
    });
    expect(parseCodexNotify(snake)?.lastAssistantMessage).toBe("Refactored the parser");

    const camel = JSON.stringify({
      type: "agent-turn-complete",
      lastAssistantMessage: "Added unit tests",
    });
    expect(parseCodexNotify(camel)?.lastAssistantMessage).toBe("Added unit tests");
  });

  it("parses cwd and full payload correctly", () => {
    const full = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "th-full-99",
      "turn-id": "tu-full-1",
      "last-assistant-message": "All checks passed cleanly",
      cwd: "C:\\projects\\workspace",
    });

    const parsed = parseCodexNotify(full);
    expect(parsed).toEqual({
      type: "agent-turn-complete",
      threadId: "th-full-99",
      turnId: "tu-full-1",
      lastAssistantMessage: "All checks passed cleanly",
      cwd: "C:\\projects\\workspace",
    });
  });

  it("returns null for invalid JSON or non-object payloads", () => {
    expect(parseCodexNotify("")).toBeNull();
    expect(parseCodexNotify("   \r\n")).toBeNull();
    expect(parseCodexNotify("{ not valid json")).toBeNull();
    expect(parseCodexNotify("undefined")).toBeNull();
    expect(parseCodexNotify("null")).toBeNull();
    expect(parseCodexNotify("12345")).toBeNull();
    expect(parseCodexNotify('"just a string"')).toBeNull();
    expect(parseCodexNotify("true")).toBeNull();
    expect(parseCodexNotify("[1, 2, 3]")).toBeNull();
    expect(parseCodexNotify(JSON.stringify(["array", "payload"]))).toBeNull();
  });

  it("handles empty object by returning defaults with null fields", () => {
    const parsed = parseCodexNotify("{}");
    expect(parsed).toEqual({
      type: "",
      threadId: null,
      turnId: null,
      lastAssistantMessage: null,
      cwd: null,
    });
  });
});

describe("Codex turn completion check (isTurnComplete)", () => {
  it("returns true only for type === 'agent-turn-complete'", () => {
    const completePayload: CodexNotifyPayload = {
      type: "agent-turn-complete",
      threadId: "th-1",
      turnId: "tu-1",
      lastAssistantMessage: "done",
      cwd: "/repo",
    };
    expect(isTurnComplete(completePayload)).toBe(true);
  });

  it("returns false for non-matching event types or null", () => {
    expect(isTurnComplete(null)).toBe(false);

    const otherPayload: CodexNotifyPayload = {
      type: "agent-turn-started",
      threadId: "th-1",
      turnId: "tu-1",
      lastAssistantMessage: null,
      cwd: null,
    };
    expect(isTurnComplete(otherPayload)).toBe(false);

    const emptyPayload: CodexNotifyPayload = {
      type: "",
      threadId: null,
      turnId: null,
      lastAssistantMessage: null,
      cwd: null,
    };
    expect(isTurnComplete(emptyPayload)).toBe(false);
  });
});

describe("CodexAdapter lifecycle and preflight", () => {
  it("initializes with default binary and version", () => {
    const adapter = new CodexAdapter();
    expect(adapter.providerId).toBe("codex");
    expect(adapter.adapterVersion).toBe("0.2.2");
    expect(adapter.inspectRuntime("sess-1")).toBeNull();
  });

  it("initializes with custom binary", () => {
    const adapter = new CodexAdapter({ binary: "custom-codex" });
    expect(adapter.providerId).toBe("codex");
  });

  it("handles preflight checks using config.failPreflight", () => {
    const adapter = new CodexAdapter();
    expect(() => adapter.preflight({})).not.toThrow();

    const error = new BrokerError("PROVIDER_INCOMPATIBLE", "Codex CLI incompatible");
    expect(() => adapter.preflight({ failPreflight: error })).toThrow(error);
  });

  it("handles idle shutdown and turn interrupt without errors", async () => {
    const adapter = new CodexAdapter();
    await expect(adapter.shutdownIdleRuntime("sess-1")).resolves.toBeUndefined();
    await expect(adapter.interruptTurn("turn-1")).resolves.toBe(false);
  });

  it("calls gate.acquireDispatchPermission() before dispatching", async () => {
    const adapter = new CodexAdapter();
    const gate = {
      acquireDispatchPermission() {
        throw new BrokerError("INVALID_REQUEST", "cancelled before dispatch");
      },
      cancellationRequested() {
        return null;
      },
    };
    const req = {
      turn_id: "turn-codex-1",
      session_id: "sess-codex-1",
      role: "worker" as const,
      provider: "codex",
      account_profile_id: "profile-1",
      requested_model: "o3-mini",
      requested_effort: null,
      instructions_hash: "hash-xyz",
      native_conversation_ref: null,
      task_envelope: "Implement feature A",
      workspace_mode: "exclusive" as const,
      workspace_path: null,
      deadline_at: Date.now() + 60_000,
      clock: { now: () => Date.now() },
    };

    await expect(adapter.executeTurn(req, gate, () => {})).rejects.toThrow("cancelled before dispatch");
  });
});
