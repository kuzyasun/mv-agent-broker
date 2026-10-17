import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AntigravityAdapter } from "../../src/providers/antigravity/antigravityAdapter.ts";
import { captureAntigravityConversation, readAntigravityTurnEvidence } from "../../src/providers/antigravity/nativeTurnEvidence.ts";
import { runHeadlessCli, type HeadlessCliEvents, type HeadlessCliResult } from "../../src/providers/common/headless.ts";
import type { TurnExecutionRequest } from "../../src/runtime/adapter.ts";

vi.mock("../../src/providers/common/headless.ts", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/providers/common/headless.ts")>(),
  runHeadlessCli: vi.fn(),
}));

const roots: string[] = [];
const conversationId = "00000000-0000-4000-8000-000000000001";
const interruption = "The stream was interrupted. Please continue the task you were working on.";
const quota = "Individual quota reached. Please upgrade your subscription. Resets in 10m.";
const resetRunner = () => vi.mocked(runHeadlessCli).mockReset();
afterEach(() => { resetRunner(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value >>>= 7; } while (value);
  return Buffer.from(bytes);
}
function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function payload(type: number, text: string): Buffer {
  return type === 17 ? field(24, field(3, field(2, Buffer.from(text))))
    : type === 15 ? field(20, field(1, Buffer.from(text))) : Buffer.alloc(0);
}
function fixture(oldError = interruption) {
  const root = mkdtempSync(path.join(os.tmpdir(), "agy-turn-scope-")); roots.push(root);
  const file = path.join(root, `${conversationId}.db`);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE trajectory_meta(cascade_id TEXT); CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type INTEGER,status INTEGER,step_payload BLOB)");
  db.prepare("INSERT INTO trajectory_meta VALUES(?)").run(conversationId);
  const add = (idx: number, type: number, text = "", status = 3) => db.prepare("INSERT INTO steps VALUES(?,?,?,?)").run(idx, type, status, payload(type, text));
  add(0, 14); add(1, 17, oldError); add(2, 15, "old response"); db.close();
  return {
    root, file,
    append(response: string, currentError?: string, status = 3) {
      const next = new DatabaseSync(file);
      const insert = (idx: number, type: number, text = "", state = 3) => next.prepare("INSERT INTO steps VALUES(?,?,?,?)").run(idx,type,state,payload(type,text));
      insert(3,14);
      if (currentError) insert(4,17,currentError);
      const lastIndex = currentError ? 5 : 4;
      insert(lastIndex,15,response,status); next.close();
      return lastIndex;
    },
    adapter: new AntigravityAdapter({ binary: process.execPath, conversationsDir: root }),
  };
}
const request = (resume: string | null = conversationId): TurnExecutionRequest => ({
  turn_id: "turn-test", session_id: "session-test", role: "worker", provider: "antigravity",
  account_profile_id: "account-test", requested_model: "gemini-3.8-flash", requested_effort: "high",
  instructions_hash: "instructions", native_conversation_ref: resume, task_envelope: "Perform this task.",
  workspace_mode: "current", workspace_path: null, deadline_at: Date.now() + 60_000, clock: { now: () => Date.now() },
});
const gate = { acquireDispatchPermission() {}, cancellationRequested: () => null };
const cleanExit: HeadlessCliResult = { exitCode: 0, killed: false, timedOut: null, stderrTail: "", quiesced: true };
function stream(events: HeadlessCliEvents, status: string, error: string | null, response: string, lastIndex = 4, done = true, userState = "DONE", userIndex = 3) {
  for (const record of [
    { event: "init", conversation_id: conversationId },
    { event: "step_update", step_update: { conversation_id: conversationId, step_index: userIndex, state: userState, step_type: "user_input" } },
    { event: "step_update", step_update: { conversation_id: conversationId, step_index: lastIndex, state: done ? "DONE" : "ACTIVE", step_type: "agent_response", text_delta: response } },
    { event: "result", result: { conversation_id: conversationId, status, error, response } },
  ]) events.onStdoutLine(JSON.stringify(record));
}

describe("Antigravity current-turn attribution", () => {
  it.each([interruption, quota])("ignores an historical error only with matching current native and stream completion: %s", async oldError => {
    const f = fixture(oldError);
    const response = "current response " + "x".repeat(5000);
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      const last = f.append(response); stream(events, "ERROR", oldError, response, last); return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(), gate, () => {});
    expect(result.native_outcome).toBe("completed");
    expect(result.failure).toBeUndefined();
    expect(result.agent_reported?.full_text).toBe(response);
    expect(result.agent_reported?.provenance).toBe("recovered_current_turn");
  });

  it.each([interruption, quota])("classifies an identical error when it actually recurs in the current turn: %s", async error => {
    const f = fixture(error);
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      const last = f.append("partial answer", error); stream(events, "FAILED", error, "partial answer", last); return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(), gate, () => {});
    expect(result.native_outcome).toBe("failed");
    expect(result.failure?.code).toBe(error === quota ? "QUOTA_EXHAUSTED" : "PROVIDER_STREAM_INTERRUPTED");
    expect(result.agent_reported?.summary).toBe("partial answer");
  });

  it("uses the current native error when the result repeats a different historical error", async () => {
    const f = fixture(quota);
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      const last = f.append("partial answer", interruption); stream(events, "ERROR", quota, "partial answer", last); return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(), gate, () => {});
    expect(result.failure?.code).toBe("PROVIDER_STREAM_INTERRUPTED");
  });

  it.each(["native-active", "stream-active", "user-active", "different-user", "different-response", "no-new-steps", "nonzero-exit", "missing-store"])("does not recover historical failure with incomplete evidence: %s", async mode => {
    const f = fixture(quota);
    if (mode === "missing-store") rmSync(f.file);
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      if (mode !== "no-new-steps" && mode !== "missing-store") f.append("current response", undefined, mode === "native-active" ? 1 : 3);
      stream(events, "ERROR", quota, mode === "different-response" ? "different" : "current response", 4, mode !== "stream-active", mode === "user-active" ? "ACTIVE" : "DONE", mode === "different-user" ? 2 : 3);
      return { ...cleanExit, exitCode: mode === "nonzero-exit" ? 1 : 0 };
    });
    const result = await f.adapter.executeTurn(request(), gate, () => {});
    expect(result.native_outcome).toBe("failed");
    expect(result.failure?.code).toBe("PROVIDER_RESULT_AMBIGUOUS");
    expect(result.failure?.retry_after_ms).toBeUndefined();
    expect(result.agent_reported).toBeDefined();
    expect(result.failure?.message).toContain("Missing completion evidence:");
    if (mode === "stream-active") expect(result.failure?.message).toContain("stream_final_done");
    if (mode === "native-active") expect(result.failure?.message).toContain("native_segment_completed");
    if (mode === "different-response") expect(result.failure?.message).toContain("final_response_matches");
  });

  it("uses the last stream state per step, permitting ACTIVE followed by DONE", async () => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      f.append("current response");
      for (const step_update of [
        { step_index: 3, state: "ACTIVE", step_type: "user_input" },
        { step_index: 3, state: "DONE", step_type: "user_input" },
        { step_index: 4, state: "ACTIVE", step_type: "agent_response", text_delta: "current " },
        { step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "response" },
      ]) events.onStdoutLine(JSON.stringify({ event: "step_update", step_update: { ...step_update, conversation_id: conversationId } }));
      events.onStdoutLine(JSON.stringify({ event: "result", result: { conversation_id: conversationId, status: "ERROR", error: interruption, response: "current response" } }));
      return cleanExit;
    });
    expect((await f.adapter.executeTurn(request(), gate, () => {})).native_outcome).toBe("completed");
  });

  it.each(["late-tool-done", "background-tool-active"])("recovers a completed native turn with %s stream updates", async mode => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      f.append("current response");
      const db = new DatabaseSync(f.file);
      db.exec("UPDATE steps SET idx=5 WHERE idx=4");
      db.prepare("INSERT INTO steps VALUES(4,132,3,?)").run(Buffer.alloc(0));
      db.close();
      for (const step_update of [
        {step_index:3,state:"DONE",step_type:"user_input"},
        {step_index:4,state:"ACTIVE",step_type:"tool"},
        {step_index:5,state:"DONE",step_type:"agent_response",text_delta:"current response"},
        ...(mode === "late-tool-done" ? [{step_index:4,state:"DONE",step_type:"tool"}] : []),
      ]) events.onStdoutLine(JSON.stringify({event:"step_update",step_update:{...step_update,conversation_id:conversationId}}));
      events.onStdoutLine(JSON.stringify({event:"result",result:{conversation_id:conversationId,status:"ERROR",error:interruption,response:"current response"}}));
      return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(),gate,()=>{});
    expect(result).toMatchObject({native_outcome:"completed",agent_reported:{summary:"current response",provenance:"recovered_current_turn"}});
    expect(result.failure).toBeUndefined();
  });

  it("does not use an unverified native step status as completion evidence", async () => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      f.append("current response");
      const db = new DatabaseSync(f.file); db.exec("UPDATE steps SET status=7 WHERE idx=3"); db.close();
      stream(events, "ERROR", interruption, "current response"); return cleanExit;
    });
    expect((await f.adapter.executeTurn(request(), gate, () => {})).failure?.code).toBe("PROVIDER_RESULT_AMBIGUOUS");
  });

  it.each(["ERROR", "FAILED"])("does not recover an explicit current stream %s despite a completed native projection", async state => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      f.append("current response");
      const db = new DatabaseSync(f.file);
      db.exec("UPDATE steps SET idx=5 WHERE idx=4");
      db.prepare("INSERT INTO steps VALUES(4,132,3,?)").run(Buffer.alloc(0));
      db.close();
      events.onStdoutLine(JSON.stringify({event:"step_update",step_update:{conversation_id:conversationId,step_index:3,state:"DONE",step_type:"user_input"}}));
      events.onStdoutLine(JSON.stringify({event:"step_update",step_update:{conversation_id:conversationId,step_index:4,state,step_type:"tool"}}));
      stream(events,"ERROR",interruption,"current response",5);
      return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(),gate,()=>{});
    expect(result.failure).toMatchObject({code:"PROVIDER_RESULT_AMBIGUOUS",message:expect.stringContaining("stream_error_free")});
  });

  it.each(["FAILED", "ERROR"])("preserves a genuinely failed new-turn response for status %s", async status => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => {
      stream(events, status, interruption, "response before failure"); return cleanExit;
    });
    const result = await f.adapter.executeTurn(request(null), gate, () => {});
    expect(result).toMatchObject({ native_outcome: "failed", failure: { code: "PROVIDER_STREAM_INTERRUPTED" }, agent_reported: { summary: "response before failure" } });
  });

  it.each(["output-limit", "unknown", "cancelled"])("preserves supervision precedence over historical recovery: %s", async mode => {
    const f = fixture(quota);
    let cancelled: string | null = null;
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (spec, events) => {
      f.append("current response"); stream(events, "ERROR", quota, "current response");
      if (mode === "cancelled") { cancelled = "operator cancel"; await new Promise(resolve => setTimeout(resolve, 150)); expect(spec.signal.aborted).toBe(true); }
      return { ...cleanExit, outputLimited: mode === "output-limit", uncertainAfterResume: mode === "unknown", killed: mode === "cancelled" };
    });
    const execution = f.adapter.executeTurn(request(), { ...gate, cancellationRequested: () => cancelled }, () => {});
    if (mode === "unknown") await expect(execution).rejects.toMatchObject({ code: "EXECUTION_UNKNOWN" });
    else {
      const result = await execution;
      expect(result.native_outcome).toBe("failed");
      expect(result.failure?.code).toBe(mode === "output-limit" ? "PROVIDER_OUTPUT_LIMIT" : "PROVIDER_EXECUTION_ERROR");
    }
  });

  it("does not mistake response-only quota prose for a native quota failure", async () => {
    const f = fixture();
    vi.mocked(runHeadlessCli).mockImplementationOnce(async (_spec, events) => { stream(events, "FAILED", null, quota); return cleanExit; });
    const result = await f.adapter.executeTurn(request(null), gate, () => {});
    expect(result.failure?.code).toBe("PROVIDER_EXECUTION_ERROR");
    expect(result.agent_reported?.summary).toBe(quota);
  });
});

describe("optional Antigravity native evidence", () => {
  it("does not create missing stores or read non-conversation paths", () => {
    const f = fixture();
    expect(captureAntigravityConversation("../arbitrary", f.root)).toBeNull();
    expect(captureAntigravityConversation("00000000-0000-4000-8000-000000000002", f.root)).toBeNull();
  });
  it("rejects a changed store identity or malformed error payload", () => {
    const f = fixture();
    const db = new DatabaseSync(f.file);
    db.prepare("UPDATE steps SET step_payload=? WHERE idx=1").run(Buffer.from([0])); db.close();
    expect(captureAntigravityConversation(conversationId, f.root)).toBeNull();
    const changed = new DatabaseSync(f.file); changed.exec("UPDATE trajectory_meta SET cascade_id='foreign'"); changed.close();
    expect(captureAntigravityConversation(conversationId, f.root)).toBeNull();
  });
  it("rejects multiple new user messages instead of mixing native turns", () => {
    const f = fixture();
    const checkpoint = captureAntigravityConversation(conversationId, f.root);
    expect(checkpoint?.lastIndex).toBe(2);
    f.append("current response");
    const db = new DatabaseSync(f.file); db.prepare("INSERT INTO steps VALUES(5,14,3,?)").run(Buffer.alloc(0)); db.close();
    expect(readAntigravityTurnEvidence(conversationId, checkpoint, f.root)).toBeNull();
  });
});
