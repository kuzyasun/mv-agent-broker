/** Protocol/dispatch tests never send native inference. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { CodexAdapter } from "../../src/providers/codex/codexAdapter.ts";
import { parseCodexStreamLine } from "../../src/providers/codex/streamParser.ts";
import * as headless from "../../src/providers/common/headless.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";

afterEach(() => vi.restoreAllMocks());
const request = (overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest => ({
  turn_id: "t-codex", session_id: "s-broker", role: "worker", provider: "codex", account_profile_id: "local",
  requested_model: "explicit-model", requested_effort: "low", instructions_hash: "hash", native_conversation_ref: null,
  task_envelope: 'literal "quotes" & $()\nsecond line', workspace_mode: "current", workspace_path: process.cwd(),
  deadline_at: Date.now() + 60000, clock: { now: () => Date.now() }, ...overrides,
});
const thread = { type: "thread.started", thread_id: "native-id" };
const message = { type: "item.completed", item: { type: "agent_message", text: "ok" } };
const completed = { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 1 } };
function simulate(records: unknown[] = [thread, message, completed], processOverrides = {}) {
  return vi.spyOn(headless, "runHeadlessCli").mockImplementation(async (_spec, events) => {
    for (const record of records) events.onStdoutLine(typeof record === "string" ? record : JSON.stringify(record));
    return { exitCode: 0, killed: false, timedOut: null, stderrTail: "", ...processOverrides };
  });
}
const gate = () => ({ acquireDispatchPermission: vi.fn(), cancellationRequested: () => null });

describe("Codex JSONL adapter", () => {
  it("replays the retained native process streams without inference", async () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/native-smoke/2026-09-30-codex/mcp-resume.evidence.json", import.meta.url), "utf8"));
    for (let i = 0; i < 2; i++) {
      const records = evidence.processes[i].stdout.trim().split("\n");
      const runner = simulate(records); const events: AdapterEvent[] = [];
      const result = await new CodexAdapter().executeTurn(request({ requested_model: evidence.requestedModel,
        native_conversation_ref: i === 0 ? null : evidence.nativeSession.id }), gate(), ev => events.push(ev));
      expect(result.agent_reported).toEqual(evidence.turns[i].result.agent_reported);
      expect(result.native_conversation_ref).toBe(evidence.nativeSession.id);
      expect(events[0]).toEqual({ type: "native_ref_obtained", payload: { ref: evidence.nativeSession.id } });
      runner.mockRestore();
    }
  });

  it("uses explicit model, effort, role sandbox, native profile and stdin without notify", async () => {
    const runner = simulate(); const g = gate(); const events: AdapterEvent[] = [];
    const req = request(); const result = await new CodexAdapter().executeTurn(req, g, ev => events.push(ev));
    expect(result.native_conversation_ref).toBe("native-id"); expect(result.agent_reported?.summary).toBe("ok");
    expect(g.acquireDispatchPermission).toHaveBeenCalledOnce();
    const spec = runner.mock.calls[0]![0];
    expect(spec.args).toEqual(["exec", "--sandbox", "workspace-write", "--json", "--ignore-user-config", "--model", "explicit-model", "-c", 'model_reasoning_effort="low"', "-"]);
    expect(spec.promptStdin).toBe(req.task_envelope); expect(spec.cwd).toBe(req.workspace_path);
    expect(spec.envAllowlist).toEqual(expect.arrayContaining(["CODEX_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]));
    expect(events[0]).toEqual({ type: "native_ref_obtained", payload: { ref: "native-id" } });
  });
  it("resumes exact native ID with model/effort and no latest-session selection", async () => {
    const runner = simulate();
    await new CodexAdapter().executeTurn(request({ native_conversation_ref: "native-id", role: "reviewer" }), gate(), () => {});
    expect(runner.mock.calls[0]![0].args).toEqual(["exec", "--sandbox", "read-only", "resume", "--json", "--ignore-user-config", "--model", "explicit-model", "-c", 'model_reasoning_effort="low"', "native-id", "-"]);
  });
  it("emits duplicate identity only once", async () => {
    simulate([thread, thread, message, completed]); const events: AdapterEvent[] = [];
    await new CodexAdapter().executeTurn(request(), gate(), ev => events.push(ev));
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toHaveLength(1);
  });
  it.each([
    [message, completed], [thread, completed], [thread, message],
    [thread, message, completed, { type: "turn.failed", error: { message: "failed" } }],
    [thread, { type: "error", message: "quota" }, message, completed],
    [thread, { type: "thread.started", thread_id: "other" }, message, completed],
    [thread, { type: "item.completed", item: { type: "agent_message", text: {} } }, completed],
  ])("rejects incomplete/failed/conflicting stream %#", async (...records) => {
    simulate(records);
    await expect(new CodexAdapter().executeTurn(request(), gate(), () => {})).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it.each([[message, completed], [thread, message, completed]])("fails missing/mismatched resume identity %#", async (...records) => {
    simulate(records); const events: AdapterEvent[] = [];
    await expect(new CodexAdapter().executeTurn(request({ native_conversation_ref: "expected" }), gate(), ev => events.push(ev))).rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE" });
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toHaveLength(0);
  });
  it.each([{ exitCode: 7 }, { killed: true }, { timedOut: "inactivity" as const }])("does not allow a completed record to override %j", async processOverride => {
    simulate(undefined, processOverride);
    await expect(new CodexAdapter().executeTurn(request(), gate(), () => {})).rejects.toMatchObject({ executionStarted: true });
  });
  it.each([{ requested_model: "" }, { native_conversation_ref: " " }])("rejects invalid request before dispatch %j", async overrides => {
    const runner = simulate(); const g = gate();
    await expect(new CodexAdapter().executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(runner).not.toHaveBeenCalled(); expect(g.acquireDispatchPermission).not.toHaveBeenCalled();
  });
  it("never dispatches after gate denial or preaccepted cancellation", async () => {
    const runner = simulate();
    await expect(new CodexAdapter().executeTurn(request(), { acquireDispatchPermission: () => { throw new Error("denied"); }, cancellationRequested: () => null }, () => {})).rejects.toThrow("denied");
    await expect(new CodexAdapter().executeTurn(request(), { acquireDispatchPermission: () => {}, cancellationRequested: () => "cancel" }, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("Codex stream parser", () => {
  it.each(["", "bad", "null", "[]", '{"type":"future"}'])("ignores unrelated line %s", line => {
    expect(parseCodexStreamLine(line)).toEqual({ kind: "unknown" });
  });
  it("rejects empty native identity", () => expect(parseCodexStreamLine('{"type":"thread.started","thread_id":" "}').kind).toBe("failure"));
});
