/** Fake process tests only; no Cursor requests or quota use. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CursorAdapter } from "../../src/providers/cursor/cursorAdapter.ts";
import * as headless from "../../src/providers/common/headless.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-cursor-test-")); roots.push(root);
  const script = path.join(root, "fake.cjs");
  const sentinel = path.join(root, "launched.txt");
  writeFileSync(script, `
const fs = require('fs');
fs.writeFileSync(${JSON.stringify(sentinel)}, 'started');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const mode = input.split('\\n')[0];
  const args = process.argv.slice(2);
  const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
  const id = mode === 'resume-mismatch' ? 'wrong-native-id' : resume || 'cursor-native-id';
  let configRaw = null;
  let configParsed = null;
  const configDir = process.env.CURSOR_CONFIG_DIR;
  if (configDir && fs.existsSync(configDir + '/cli-config.json')) {
    configRaw = fs.readFileSync(configDir + '/cli-config.json', 'utf8');
    try { configParsed = JSON.parse(configRaw); } catch {}
  }
  if (configDir) {
    try { fs.writeFileSync(${JSON.stringify(path.join(root, "observed-config-dir.txt"))}, configDir); } catch {}
  }
  const inspection = { args, input, cwd: process.cwd(), profile: process.env.USERPROFILE,
    localAppData: process.env.LOCALAPPDATA, pathext: process.env.PATHEXT,
    leaked: process.env.BROKER_TEST_SECRET !== undefined,
    cursorConfigDir: configDir,
    cursorConfigRaw: configRaw,
    cursorConfig: configParsed,
  };
  const emit = obj => console.log(JSON.stringify(obj));
  if (!['missing-id', 'empty-id', 'result-only'].includes(mode)) emit({ type: 'system', subtype: 'init', session_id: id, model: 'Fake Model' });
  if (mode !== 'missing-result') emit({ type: 'result', is_error: mode === 'result-error',
    session_id: mode === 'missing-id' ? undefined : mode === 'empty-id' ? ' ' : mode === 'conflicting-id' ? 'other-native-id' : id,
    result: mode === 'malformed' ? false : JSON.stringify(inspection) });
  if (mode === 'nonzero') { console.error('native failure'); process.exitCode = 7; }
  if (mode === 'hang') setTimeout(() => {}, 30000);
});
`);
  const binary = path.join(root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
  if (process.platform === "win32") {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    writeFileSync(binary, `& ${quote(process.execPath)} ${quote(script)} $args\nexit $LASTEXITCODE\n`);
  } else {
    writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(script)});\n`);
    chmodSync(binary, 0o755);
  }
  return { root, sentinel, adapter: new CursorAdapter({ binary }) };
}
function request(overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest {
  return { turn_id: "t-cursor", session_id: "s-broker", role: "worker", provider: "cursor",
    account_profile_id: "local", requested_model: "explicit-model", requested_effort: null,
    instructions_hash: "hash", native_conversation_ref: null, task_envelope: "prompt",
    workspace_mode: "current", workspace_path: null, deadline_at: Date.now() + 60000,
    clock: { now: () => Date.now() }, ...overrides };
}
function gate() { let count = 0; return { acquireDispatchPermission: () => { count++; }, cancellationRequested: () => null, count: () => count }; }

describe("Cursor adapter", () => {
  it("uses ask mode for reviewer reports and leaves worker mode unchanged", async () => {
    for (const role of ["worker", "reviewer"] as const) {
      const result = await fixture().adapter.executeTurn(request({ role }), gate(), () => {});
      const inspection = JSON.parse(result.agent_reported!.summary);
      if (role === "reviewer") expect(inspection.args.slice(inspection.args.indexOf("--mode"), inspection.args.indexOf("--mode") + 2)).toEqual(["--mode", "ask"]);
      else expect(inspection.args).not.toContain("--mode");
    }
  });
  it("passes literal stdin, explicit model/workspace and Windows profile without unrelated env", async () => {
    const f = fixture(); const g = gate(); const events: AdapterEvent[] = [];
    vi.stubEnv("BROKER_TEST_SECRET", "test-only-secret");
    const prompt = 'literal "quotes" & $()\nsecond line';
    const result = await f.adapter.executeTurn(request({ workspace_path: f.root, task_envelope: prompt }), g, ev => events.push(ev));
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.input).toContain(prompt + "\n[broker-eor ");
    expect(inspection.args[inspection.args.indexOf("--model") + 1]).toBe("explicit-model");
    expect(inspection.cwd).toBe(f.root);
    expect(inspection.leaked).toBe(false);
    if (process.platform === "win32") {
      expect(inspection.profile).toBe(process.env.USERPROFILE);
      expect(inspection.localAppData).toBe(process.env.LOCALAPPDATA);
      expect(inspection.pathext).toBe(process.env.PATHEXT);
    }
    expect(g.count()).toBe(1);
    expect(result.native_conversation_ref).toBe("cursor-native-id");
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toEqual([{ type: "native_ref_obtained", payload: { ref: "cursor-native-id" } }]);
  });
  it("resumes exactly the requested ID", async () => {
    const f = fixture();
    const result = await f.adapter.executeTurn(request({ native_conversation_ref: "real-resume-id" }), gate(), () => {});
    const args = JSON.parse(result.agent_reported!.summary).args;
    expect(args[args.indexOf("--resume") + 1]).toBe("real-resume-id");
    expect(result.native_conversation_ref).toBe("real-resume-id");
  });
  it("emits identity when it appears only in the result", async () => {
    const events: AdapterEvent[] = [];
    await fixture().adapter.executeTurn(request({ task_envelope: "result-only" }), gate(), ev => events.push(ev));
    expect(events.filter(ev => ev.type === "native_ref_obtained")).toEqual([{ type: "native_ref_obtained", payload: { ref: "cursor-native-id" } }]);
  });
  it.each(["missing-id", "empty-id"])("does not fabricate identity for %s", async mode => {
    const result = await fixture().adapter.executeTurn(request({ task_envelope: mode }), gate(), () => {});
    expect(result.native_conversation_ref).toBe("");
  });
  it.each(["nonzero", "malformed", "missing-result", "result-error", "conflicting-id"])("rejects %s", async mode => {
    await expect(fixture().adapter.executeTurn(request({ task_envelope: mode }), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it("rejects a different ID during resume without emitting it", async () => {
    const events: AdapterEvent[] = [];
    await expect(fixture().adapter.executeTurn(request({ task_envelope: "resume-mismatch", native_conversation_ref: "expected-id" }), gate(), ev => events.push(ev)))
      .rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE", executionStarted: true });
    expect(events.some(ev => ev.type === "native_ref_obtained")).toBe(false);
  });
  it("requires observed identity on resume", async () => {
    await expect(fixture().adapter.executeTurn(request({ task_envelope: "missing-id", native_conversation_ref: "expected-id" }), gate(), () => {}))
      .rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE", executionStarted: true });
  });
  it("fails cancellation even after a success record", async () => {
    const f = fixture(); let reason: string | null = null;
    await expect(f.adapter.executeTurn(request({ task_envelope: "hang" }), {
      acquireDispatchPermission: () => {}, cancellationRequested: () => reason,
    }, ev => { if (ev.type === "native_ref_obtained") reason = "operator"; }))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it("does not infer rate limiting from a startup timeout", async () => {
    vi.spyOn(headless, "runHeadlessCli").mockResolvedValue({ exitCode: null, killed: true, timedOut: "first-line", stderrTail: "" });
    await expect(fixture().adapter.executeTurn(request(), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it.each([{ requested_model: "" }, { native_conversation_ref: "" }])("rejects invalid selection before dispatch %j", async overrides => {
    const f = fixture(); const g = gate();
    await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(g.count()).toBe(0); expect(existsSync(f.sentinel)).toBe(false);
  });
  it("does not launch after gate denial or a pending cancellation", async () => {
    const f = fixture();
    await expect(f.adapter.executeTurn(request(), { acquireDispatchPermission: () => { throw new Error("gate denied"); }, cancellationRequested: () => null }, () => {})).rejects.toThrow("gate denied");
    await expect(f.adapter.executeTurn(request(), { acquireDispatchPermission: () => {}, cancellationRequested: () => "cancelled" }, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("creates a unique private CURSOR_CONFIG_DIR with expected cli-config.json for reviewer and cleans up on success", async () => {
    const f = fixture();
    const result = await f.adapter.executeTurn(request({ role: "reviewer" }), gate(), () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.cursorConfigDir).toBeTruthy();
    expect(inspection.cursorConfig).toEqual({
      version: 1,
      editor: { vimMode: false },
      approvalMode: "allowlist",
      permissions: {
        allow: ["Read(**)"],
        deny: ["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
      },
    });
    // Private directory cleaned up after successful completion
    expect(existsSync(inspection.cursorConfigDir)).toBe(false);
    expect(process.env.CURSOR_CONFIG_DIR).toBeUndefined();
  });
  it("isolates reviewer from ambient CURSOR_CONFIG_DIR and preserves process.env", async () => {
    const f = fixture();
    const ambientDir = path.join(f.root, "ambient-cursor-config");
    vi.stubEnv("CURSOR_CONFIG_DIR", ambientDir);
    const result = await f.adapter.executeTurn(request({ role: "reviewer" }), gate(), () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.cursorConfigDir).toBeTruthy();
    expect(inspection.cursorConfigDir).not.toBe(ambientDir);
    expect(existsSync(inspection.cursorConfigDir)).toBe(false);
    // Original process.env untouched
    expect(process.env.CURSOR_CONFIG_DIR).toBe(ambientDir);
  });
  it("leaves worker invocation unchanged without CURSOR_CONFIG_DIR even with ambient env", async () => {
    const f = fixture();
    const ambientDir = path.join(f.root, "ambient-cursor-config");
    vi.stubEnv("CURSOR_CONFIG_DIR", ambientDir);
    const result = await f.adapter.executeTurn(request({ role: "worker" }), gate(), () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.args).not.toContain("--mode");
    expect(inspection.cursorConfigDir).toBeUndefined();
    expect(inspection.cursorConfig).toBeNull();
    expect(process.env.CURSOR_CONFIG_DIR).toBe(ambientDir);
  });
  it("cleans up private config after process error", async () => {
    const f = fixture();
    await expect(f.adapter.executeTurn(request({ role: "reviewer", task_envelope: "nonzero" }), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
    const observedPath = path.join(f.root, "observed-config-dir.txt");
    expect(existsSync(observedPath)).toBe(true);
    const observedDir = readFileSync(observedPath, "utf8");
    expect(existsSync(observedDir)).toBe(false);
  });
  it("cleans up private config after cancellation", async () => {
    const f = fixture();
    let cancelReason: string | null = null;
    await expect(f.adapter.executeTurn(request({ role: "reviewer", task_envelope: "hang" }), {
      acquireDispatchPermission: () => {},
      cancellationRequested: () => cancelReason,
    }, ev => {
      if (ev.type === "native_ref_obtained") cancelReason = "operator";
    })).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
    const observedPath = path.join(f.root, "observed-config-dir.txt");
    expect(existsSync(observedPath)).toBe(true);
    const observedDir = readFileSync(observedPath, "utf8");
    expect(existsSync(observedDir)).toBe(false);
  });
  it("cleans up private config on gate denial", async () => {
    const f = fixture();
    vi.spyOn(os, "tmpdir").mockReturnValue(f.root);
    const beforeDirs = new Set(readdirSync(os.tmpdir()).filter(n => n.startsWith("agent-broker-cursor-")));
    let createdConfigDir: string | null = null;
    const denyingGate = {
      acquireDispatchPermission: () => {
        const currentDirs = readdirSync(os.tmpdir()).filter(n => n.startsWith("agent-broker-cursor-"));
        const diff = currentDirs.filter(d => !beforeDirs.has(d));
        if (diff.length > 0) {
          createdConfigDir = path.join(os.tmpdir(), diff[0]);
          expect(existsSync(path.join(createdConfigDir, "cli-config.json"))).toBe(true);
        }
        throw new Error("gate denied");
      },
      cancellationRequested: () => null,
    };
    await expect(f.adapter.executeTurn(request({ role: "reviewer" }), denyingGate, () => {}))
      .rejects.toThrow("gate denied");
    expect(createdConfigDir).not.toBeNull();
    expect(existsSync(createdConfigDir!)).toBe(false);
    expect(existsSync(f.sentinel)).toBe(false);
  });
});
