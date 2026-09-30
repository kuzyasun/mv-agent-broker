/** Fake native processes only; no Claude requests or quota use. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude/claudeAdapter.ts";
import { parseClaudeStreamLine } from "../../src/providers/claude/hookEvents.ts";
import * as headless from "../../src/providers/common/headless.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-claude-test-")); roots.push(root);
  const script = path.join(root, "fake.cjs"); const sentinel = path.join(root, "launched.txt");
  writeFileSync(script, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(sentinel)}, 'started');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const args = process.argv.slice(2); const mode = input.split('\\n')[0];
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const id = mode === 'mismatch' ? 'other-id' : resume || 'claude-native-id';
  const emit = obj => console.log(JSON.stringify(obj));
  if (!args.includes('--verbose')) { console.error('stream-json requires --verbose'); process.exitCode = 1; return; }
  if (!['missing-id', 'result-only'].includes(mode)) emit({ type: 'system', subtype: 'init', session_id: id });
  const inspection = { args, input, cwd: process.cwd(), profile: process.env.USERPROFILE,
    config: process.env.CLAUDE_CONFIG_DIR, hasOAuthEnv: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN),
    leaked: process.env.BROKER_TEST_SECRET !== undefined };
  if (mode !== 'missing-result') emit({ type: 'result', subtype: mode === 'result-error' ? 'error_api' : 'success',
    is_error: mode === 'result-error', session_id: mode === 'missing-id' ? undefined : mode === 'conflict' ? 'conflicting-id' : id,
    result: mode === 'malformed' ? {} : JSON.stringify(inspection) });
  if (mode === 'nonzero') { console.error('native failure'); process.exitCode = 7; }
  if (mode === 'hang') setTimeout(() => {}, 30000);
});
`);
  const binary = path.join(root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
  if (process.platform === "win32") {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    writeFileSync(binary, `& ${quote(process.execPath)} ${quote(script)} $args\nexit $LASTEXITCODE\n`);
  } else {
    writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(script)});\n`); chmodSync(binary, 0o755);
  }
  return { root, sentinel, adapter: new ClaudeAdapter({ binary }) };
}
function request(overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest {
  return { turn_id: "t-claude", session_id: "s-broker", role: "worker", provider: "claude-code",
    account_profile_id: "local", requested_model: "explicit-model", requested_effort: null,
    instructions_hash: "hash", native_conversation_ref: null, task_envelope: "prompt",
    workspace_mode: "current", workspace_path: null, deadline_at: Date.now() + 60000,
    clock: { now: () => Date.now() }, ...overrides };
}
function gate() { let count = 0; return { acquireDispatchPermission: () => { count++; }, cancellationRequested: () => null, count: () => count }; }

describe("Claude adapter native process contract", () => {
  it("replays retained native turns and captures identity at the first startup hook", async () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/native-smoke/2026-09-30-claude/adapter-resume.evidence.json", import.meta.url), "utf8"));
    for (let i = 0; i < 2; i++) {
      const lines = evidence.processes[i].stdout.trim().split(/\r?\n/);
      let delivered = -1; let refLine: number | null = null;
      vi.spyOn(headless, "runHeadlessCli").mockImplementation(async (_spec, events) => {
        for (let index = 0; index < lines.length; index++) { delivered = index; events.onStdoutLine(lines[index]!); }
        return { exitCode: 0, killed: false, timedOut: null, stderrTail: "" };
      });
      const events: AdapterEvent[] = []; const g = gate();
      const result = await new ClaudeAdapter().executeTurn(request({ requested_model: evidence.requestedModel,
        native_conversation_ref: evidence.turns[i].requestedNativeRef }), g, ev => {
        events.push(ev); if (ev.type === "native_ref_obtained") refLine = delivered;
      });
      expect(result).toEqual(evidence.turns[i].result); expect(g.count()).toBe(1);
      expect(events.filter(ev => ev.type === "native_ref_obtained")).toHaveLength(1);
      expect(refLine).toBe(0);
      if (i === 0) expect(parseClaudeStreamLine(lines[0]!)).toEqual({ kind: "session_ref", session_id: result.native_conversation_ref });
    }
  });
  it("uses verbose stream mode, literal stdin, model, cwd and native-owned auth environment", async () => {
    const f = fixture(); const g = gate(); const events: AdapterEvent[] = [];
    vi.stubEnv("BROKER_TEST_SECRET", "not-forwarded");
    vi.stubEnv("CLAUDE_CONFIG_DIR", f.root); vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "fake-test-value");
    const prompt = 'literal "quotes" & $()\nsecond line';
    const result = await f.adapter.executeTurn(request({ task_envelope: prompt, workspace_path: f.root }), g, ev => events.push(ev));
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.input).toContain(prompt + "\n[broker-eor ");
    expect(inspection.args[inspection.args.indexOf("--model") + 1]).toBe("explicit-model");
    expect(inspection.cwd).toBe(f.root); expect(inspection.config).toBe(f.root);
    expect(inspection.leaked).toBe(false); expect(inspection.hasOAuthEnv).toBe(true);
    if (process.platform === "win32") expect(inspection.profile).toBe(process.env.USERPROFILE);
    expect(g.count()).toBe(1); expect(result.native_conversation_ref).toBe("claude-native-id");
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toEqual([{ type: "native_ref_obtained", payload: { ref: "claude-native-id" } }]);
  });
  it("passes the exact native resume ID", async () => {
    const result = await fixture().adapter.executeTurn(request({ native_conversation_ref: "native-resume-id" }), gate(), () => {});
    const args = JSON.parse(result.agent_reported!.summary).args;
    expect(args[args.indexOf("--resume") + 1]).toBe("native-resume-id");
    expect(result.native_conversation_ref).toBe("native-resume-id");
  });
  it("captures result-only identity without duplication", async () => {
    const events: AdapterEvent[] = [];
    const result = await fixture().adapter.executeTurn(request({ task_envelope: "result-only" }), gate(), ev => events.push(ev));
    expect(result.native_conversation_ref).toBe("claude-native-id");
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toHaveLength(1);
  });
  it("does not invent a fresh native reference", async () => {
    const result = await fixture().adapter.executeTurn(request({ task_envelope: "missing-id" }), gate(), () => {});
    expect(result.native_conversation_ref).toBe("");
  });
  it.each(["nonzero", "missing-result", "malformed", "result-error", "conflict"])("rejects %s", async mode => {
    await expect(fixture().adapter.executeTurn(request({ task_envelope: mode }), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it.each(["mismatch", "missing-id"])("rejects %s on explicit resume without emitting a replacement ID", async mode => {
    const events: AdapterEvent[] = [];
    await expect(fixture().adapter.executeTurn(request({ task_envelope: mode, native_conversation_ref: "expected-id" }), gate(), ev => events.push(ev)))
      .rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE", executionStarted: true });
    expect(events.some(ev => ev.type === "native_ref_obtained")).toBe(false);
  });
  it("fails cancellation after receiving success", async () => {
    let reason: string | null = null;
    await expect(fixture().adapter.executeTurn(request({ task_envelope: "hang" }), {
      acquireDispatchPermission: () => {}, cancellationRequested: () => reason,
    }, ev => { if (ev.type === "native_ref_obtained") reason = "operator"; }))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it("does not accept a success record followed by timeout", async () => {
    vi.spyOn(headless, "runHeadlessCli").mockImplementation(async (_spec, events) => {
      events.onStdoutLine(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok", session_id: "native-id" }));
      return { exitCode: null, killed: true, timedOut: "inactivity", stderrTail: "" };
    });
    await expect(fixture().adapter.executeTurn(request(), gate(), () => {})).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
  });
  it.each([{ requested_model: "" }, { native_conversation_ref: " " }])("rejects invalid selection before dispatch %j", async overrides => {
    const f = fixture(); const g = gate();
    await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(g.count()).toBe(0); expect(existsSync(f.sentinel)).toBe(false);
  });
  it("does not launch after dispatch denial or pending cancellation", async () => {
    const f = fixture();
    await expect(f.adapter.executeTurn(request(), { acquireDispatchPermission: () => { throw new Error("denied"); }, cancellationRequested: () => null }, () => {})).rejects.toThrow("denied");
    await expect(f.adapter.executeTurn(request(), { acquireDispatchPermission: () => {}, cancellationRequested: () => "cancelled" }, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(existsSync(f.sentinel)).toBe(false);
  });
});

describe("Claude result protocol", () => {
  it("does not capture unknown or empty startup identities", () => {
    for (const record of [
      { type: "system", subtype: "unknown", session_id: "id" },
      { type: "system", subtype: "hook_started", session_id: " " },
    ]) expect(parseClaudeStreamLine(JSON.stringify(record))).toEqual({ kind: "unknown" });
  });
  it.each([
    { type: "result", result: "ok" },
    { type: "result", subtype: "success", is_error: "false", result: "ok" },
    { type: "result", subtype: "success", is_error: false, result: {} },
    { type: "result", subtype: "unrecognized", is_error: false, result: "ok" },
  ])("rejects ambiguous success %j", record => expect(parseClaudeStreamLine(JSON.stringify(record))).toEqual({ kind: "unknown" }));
  it("extracts native error arrays and identity", () => {
    expect(parseClaudeStreamLine(JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true,
      session_id: "native-id", errors: ["authentication failed", 1] })))
      .toEqual({ kind: "result", session_id: "native-id", text: "authentication failed", is_error: true });
  });
});
