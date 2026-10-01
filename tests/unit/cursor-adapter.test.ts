/** Fake process tests only; no Cursor requests or quota use. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { CursorAdapter } from "../../src/providers/cursor/cursorAdapter.ts";
import * as headless from "../../src/providers/common/headless.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); syncBuiltinESMExports(); vi.unstubAllEnvs();
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
    home: process.env.HOME,
    localAppData: process.env.LOCALAPPDATA, pathext: process.env.PATHEXT,
    leaked: process.env.BROKER_TEST_SECRET !== undefined,
    cursorConfigDir: configDir,
    cursorDataDir: process.env.CURSOR_DATA_DIR,
    xdgConfigHome: process.env.XDG_CONFIG_HOME,
    xdgCacheHome: process.env.XDG_CACHE_HOME,
    xdgDataHome: process.env.XDG_DATA_HOME,
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
  const stateRoot = path.join(root, "cursor-state");
  return { root, sentinel, stateRoot, adapter: new CursorAdapter({ binary, stateRoot }) };
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
      const f = fixture();
      const result = await f.adapter.executeTurn(request({ role, workspace_path: f.root }), gate(), () => {});
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
    const result = await f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), gate(), () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.cursorConfigDir).toBeTruthy();
    expect(inspection.cursorConfig).toEqual({
      version: 1,
      editor: { vimMode: false },
      approvalMode: "allowlist",
      sandbox: { readBoundary: "workspace" },
      permissions: {
        allow: [`Read(${f.root})`],
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
    const result = await f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), gate(), () => {});
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
    await expect(f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root, task_envelope: "nonzero" }), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
    const observedPath = path.join(f.root, "observed-config-dir.txt");
    expect(existsSync(observedPath)).toBe(true);
    const observedDir = readFileSync(observedPath, "utf8");
    expect(existsSync(observedDir)).toBe(false);
  });
  it("cleans up private config after cancellation", async () => {
    const f = fixture();
    let cancelReason: string | null = null;
    await expect(f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root, task_envelope: "hang" }), {
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
    await expect(f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), denyingGate, () => {}))
      .rejects.toThrow("gate denied");
    expect(createdConfigDir).not.toBeNull();
    expect(existsSync(createdConfigDir!)).toBe(false);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("bumps adapter version to 0.2.3", () => {
    expect(new CursorAdapter().adapterVersion).toBe("0.2.3");
  });
  it.each(["root", "sessions", "data"])("refuses a private history %s junction before native launch", async component => {
    const f = fixture(); const g = gate();
    const target = path.join(f.root, "outside-history");
    mkdirSync(target);
    let link = f.stateRoot;
    if (component === "sessions") {
      mkdirSync(f.stateRoot);
      link = path.join(f.stateRoot, "sessions");
    } else if (component === "data") {
      const session = path.join(f.stateRoot, "sessions", createHash("sha256").update("s-broker").digest("hex"));
      mkdirSync(session, { recursive: true });
      link = path.join(session, "data");
    }
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    await expect(f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), g, () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_INCOMPATIBLE", executionStarted: false });
    expect(g.count()).toBe(0);
    expect(existsSync(f.sentinel)).toBe(false);
    expect(readdirSync(target)).toEqual([]);
  });
  it("rechecks a directory created between inspection and mkdir", async () => {
    const f = fixture();
    const original = fs.mkdirSync;
    let raced = false;
    vi.spyOn(fs, "mkdirSync").mockImplementation(((directory: fs.PathLike, options?: fs.MakeDirectoryOptions) => {
      if (String(directory) === path.join(f.stateRoot, "sessions") && !raced) {
        raced = true;
        original(directory, options);
        throw Object.assign(new Error("directory created concurrently"), { code: "EEXIST" });
      }
      return original(directory, options);
    }) as typeof fs.mkdirSync);
    syncBuiltinESMExports();
    const g = gate();
    await f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), g, () => {});
    expect(raced).toBe(true);
    expect(g.count()).toBe(1);
  });
  it("uses a physical private fallback when the system temp path is a junction", async () => {
    const f = fixture();
    const target = path.join(f.root, "physical-temp");
    const alias = path.join(f.root, "temp-alias");
    mkdirSync(target);
    symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
    vi.spyOn(os, "tmpdir").mockReturnValue(alias);
    const adapter = new CursorAdapter({ binary: path.join(f.root, process.platform === "win32" ? "fake.ps1" : "fake-cli") });
    const result = await adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), gate(), () => {});
    expect(JSON.parse(result.agent_reported!.summary).home.startsWith(target + path.sep)).toBe(true);
  });
  it("fails with POLICY_UNSUPPORTED before dispatch when workspace is missing for reviewer", async () => {
    const f = fixture(); const g = gate();
    await expect(f.adapter.executeTurn(request({ role: "reviewer", workspace_path: null }), g, () => {}))
      .rejects.toMatchObject({ code: "POLICY_UNSUPPORTED", executionStarted: false });
    expect(g.count()).toBe(0);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it.each([
    ["relative workspace", "relative/path", undefined],
    ["wildcard in workspace", "C:\\work*space", undefined],
    ["wildcard ? in workspace", "C:\\work?space", undefined],
    ["permission token ) in workspace", "C:\\work), Write(**", undefined],
    ["permission token ( in workspace", "C:\\work(space", undefined],
    ["NUL byte in workspace", "C:\\work\0space", undefined],
    ["newline in workspace", "C:\\work\nspace", undefined],
    ["relative traversal in workspace", "C:\\work\\..\\space", undefined],
    ["wildcard in input path", "C:\\workspace", ["C:\\inputs\\*"]],
    ["permission token in input path", "C:\\workspace", ["C:\\inputs\\Read(**)"]],
    ["NUL in input path", "C:\\workspace", ["C:\\inputs\0test"]],
    ["newline in input path", "C:\\workspace", ["C:\\inputs\ntest"]],
    ["relative traversal in input path", "C:\\workspace", ["C:\\inputs\\..\\test"]],
  ])("rejects dangerous path (%s) with zero gate and zero native process", async (_name, wsPath, inputPaths) => {
    const f = fixture(); const g = gate();
    await expect(f.adapter.executeTurn(request({
      role: "reviewer",
      workspace_path: wsPath,
      read_only_input_paths: inputPaths,
    }), g, () => {})).rejects.toMatchObject({ code: "POLICY_UNSUPPORTED", executionStarted: false });
    expect(g.count()).toBe(0);
    expect(existsSync(f.sentinel)).toBe(false);
  });
  it("handles paths with spaces and Windows slashes in candidate native config", async () => {
    const f = fixture(); const g = gate();
    const ws = path.join(f.root, "my workspace", "sub dir");
    mkdirSync(ws, { recursive: true });
    const inputs = [
      path.join(f.root, "broker inputs", "test file.txt"),
      path.join(f.root, "other inputs", "doc.md"),
    ];
    for (const inp of inputs) {
      mkdirSync(path.dirname(inp), { recursive: true });
      writeFileSync(inp, "content");
    }
    const result = await f.adapter.executeTurn(request({
      role: "reviewer",
      workspace_path: ws,
      read_only_input_paths: inputs,
    }), g, () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.cursorConfig).toEqual({
      version: 1,
      editor: { vimMode: false },
      approvalMode: "allowlist",
      sandbox: { readBoundary: "workspace" },
      permissions: {
        allow: [
          `Read(${ws})`,
          `Read(${inputs[0]})`,
          `Read(${inputs[1]})`,
        ],
        deny: ["Write(**)", "Shell(*)", "WebFetch(*)", "Mcp(*:*)"],
      },
    });
  });
  it("reuses same session home/data across two turns and adapter reconstruction with same state root", async () => {
    const f = fixture();
    const sessId = "session-test-stable-reuse";
    const res1 = await f.adapter.executeTurn(request({
      role: "reviewer",
      session_id: sessId,
      workspace_path: f.root,
    }), gate(), () => {});
    const insp1 = JSON.parse(res1.agent_reported!.summary);
    expect(insp1.cursorDataDir).toBeTruthy();
    expect(insp1.home).toBeTruthy();
    expect(existsSync(insp1.cursorDataDir)).toBe(true);

    // Write marker into session data dir
    const markerFile = path.join(insp1.cursorDataDir, "marker.txt");
    writeFileSync(markerFile, "turn-1-history");

    // Turn 2 with same adapter and session
    const res2 = await f.adapter.executeTurn(request({
      role: "reviewer",
      session_id: sessId,
      workspace_path: f.root,
    }), gate(), () => {});
    const insp2 = JSON.parse(res2.agent_reported!.summary);
    expect(insp2.cursorDataDir).toBe(insp1.cursorDataDir);
    expect(insp2.home).toBe(insp1.home);
    expect(readFileSync(markerFile, "utf8")).toBe("turn-1-history");

    // Reconstruct adapter with same stateRoot
    const script = path.join(f.root, "fake.cjs");
    const binary = path.join(f.root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
    const reconstructed = new CursorAdapter({ binary, stateRoot: f.stateRoot });
    const res3 = await reconstructed.executeTurn(request({
      role: "reviewer",
      session_id: sessId,
      workspace_path: f.root,
    }), gate(), () => {});
    const insp3 = JSON.parse(res3.agent_reported!.summary);
    expect(insp3.cursorDataDir).toBe(insp1.cursorDataDir);
    expect(insp3.home).toBe(insp1.home);
    expect(readFileSync(markerFile, "utf8")).toBe("turn-1-history");

    // Idle shutdown keeps stable home/data
    await reconstructed.shutdownIdleRuntime(sessId);
    expect(existsSync(markerFile)).toBe(true);
    expect(existsSync(insp1.cursorDataDir)).toBe(true);
  });
  it("assigns distinct session home and data directories for differing sessions", async () => {
    const f = fixture();
    const res1 = await f.adapter.executeTurn(request({ role: "reviewer", session_id: "session-alpha", workspace_path: f.root }), gate(), () => {});
    const res2 = await f.adapter.executeTurn(request({ role: "reviewer", session_id: "session-beta", workspace_path: f.root }), gate(), () => {});
    const insp1 = JSON.parse(res1.agent_reported!.summary);
    const insp2 = JSON.parse(res2.agent_reported!.summary);
    expect(insp1.cursorDataDir).not.toBe(insp2.cursorDataDir);
    expect(insp1.home).not.toBe(insp2.home);
  });
  it("excludes outside ambient HOME/config/plugin dirs while preserving Windows auth env", async () => {
    const f = fixture();
    const ambientHome = path.join(f.root, "ambient-home");
    const ambientXdgConfig = path.join(f.root, "ambient-xdg-config");
    const ambientXdgData = path.join(f.root, "ambient-xdg-data");
    const ambientCursorData = path.join(f.root, "ambient-cursor-data");
    vi.stubEnv("HOME", ambientHome);
    vi.stubEnv("USERPROFILE", ambientHome);
    vi.stubEnv("XDG_CONFIG_HOME", ambientXdgConfig);
    vi.stubEnv("XDG_DATA_HOME", ambientXdgData);
    vi.stubEnv("CURSOR_DATA_DIR", ambientCursorData);

    const res = await f.adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), gate(), () => {});
    const insp = JSON.parse(res.agent_reported!.summary);

    expect(insp.home).not.toBe(ambientHome);
    expect(insp.profile).not.toBe(ambientHome);
    expect(insp.cursorDataDir).not.toBe(ambientCursorData);
    expect(insp.xdgConfigHome).not.toBe(ambientXdgConfig);
    expect(insp.xdgDataHome).not.toBe(ambientXdgData);

    if (process.platform === "win32") {
      expect(insp.localAppData).toBe(process.env.LOCALAPPDATA);
      expect(insp.pathext).toBe(process.env.PATHEXT);
    }
  });
  it("leaves request inputs and process.env immutable", async () => {
    const f = fixture();
    const reqObj = Object.freeze(request({
      role: "reviewer",
      workspace_path: f.root,
      read_only_input_paths: Object.freeze(["C:\\inputs\\file.txt"]) as readonly string[],
    }));
    const envBefore = { ...process.env };
    await f.adapter.executeTurn(reqObj, gate(), () => {});
    expect(process.env).toEqual(envBefore);
  });
  it("does not emit progress events for thinking lines in Cursor adapter", async () => {
    const f = fixture();
    const events: AdapterEvent[] = [];
    const script = path.join(f.root, "fake-stream.cjs");
    writeFileSync(script, `
      const emit = obj => console.log(JSON.stringify(obj));
      emit({ type: "system", subtype: "init", session_id: "cursor-stream-id", model: "Fake Model" });
      emit({ type: "thinking", text: "this is internal thinking text" });
      emit({ type: "assistant", message: { content: "this is assistant text" } });
      emit({ type: "tool_call", subtype: "Read" });
      emit({ type: "result", is_error: false, session_id: "cursor-stream-id", result: "done" });
    `);
    const binary = path.join(f.root, process.platform === "win32" ? "fake-stream.ps1" : "fake-stream-cli");
    if (process.platform === "win32") {
      const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
      writeFileSync(binary, `& ${quote(process.execPath)} ${quote(script)} $args\nexit $LASTEXITCODE\n`);
    } else {
      writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(script)});\n`);
      chmodSync(binary, 0o755);
    }
    const adapter = new CursorAdapter({ binary, stateRoot: f.stateRoot });
    await adapter.executeTurn(request({ role: "reviewer", workspace_path: f.root }), gate(), ev => events.push(ev));
    const progressEvents = events.filter(e => e.type === "progress");
    expect(progressEvents.some(e => (e.payload?.label as string)?.includes("thinking"))).toBe(false);
    expect(progressEvents.some(e => (e.payload?.label as string)?.includes("this is internal thinking text"))).toBe(false);
    expect(progressEvents.some(e => (e.payload?.label as string)?.includes("this is assistant text"))).toBe(true);
    expect(progressEvents.some(e => (e.payload?.label as string)?.includes("tool_call: Read"))).toBe(true);
  });
  it("configures stateRoot from bootstrap buildAdapters", async () => {
    const { buildAdapters } = await import("../../src/daemon/bootstrap.ts");
    const stateDir = path.join(fixture().root, "daemon-state");
    const adapters = buildAdapters({
      stateDir,
      coordinatorId: "coord",
      cursorBinary: "cursor-agent",
    });
    const adapter = adapters.get("cursor") as CursorAdapter;
    expect(adapter).toBeDefined();
    expect(adapter.stateRoot).toBe(path.join(stateDir, "providers", "cursor"));
  });
});
