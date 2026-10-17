/** Process-level adapter checks use a fake Node CLI; no provider inference. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZcodeAdapter } from "../../src/providers/zcode/zcodeAdapter.ts";
import { createZcodePersonalConfig, ZCODE_ACCOUNT_PROVIDER, ZCODE_START_PLAN_PROVIDER } from "../../src/providers/zcode/nativeConfig.ts";
import { parseZcodeResult } from "../../src/providers/zcode/resultParser.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";
import { createHarness, settle, start } from "../helpers/harness.ts";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-zcode-test-")); roots.push(root);
  const bundle = path.join(root, "fake.cjs");
  const builtin = path.join(root, "zcode-builtin.json");
  writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [
      { providerId: ZCODE_ACCOUNT_PROVIDER, config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" } } },
      { providerId: "account:other", config: {} },
    ] }, modelConfigRules: { builtinProviderModelRules: [] },
  } }));
  writeFileSync(bundle, `
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
const config = JSON.parse(fs.readFileSync(personal, 'utf8'));
const pathProbe = {};
if (prompt === 'path-probe') {
  const probe = require('child_process').spawnSync(process.platform === 'win32' ? 'node.exe' : 'node',
    ['-p', 'process.execPath'], { encoding: 'utf8' });
  pathProbe.path = process.env.PATH ?? null;
  pathProbe.nodeLookup = { ok: probe.status === 0 && probe.error === undefined,
    execPath: probe.status === 0 ? String(probe.stdout).trim() : null };
}
const inspection = { args, personal, config, builtin: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE,
  cwd: process.cwd(), leaked: process.env.BROKER_TEST_SECRET !== undefined,
  ...pathProbe };
if (prompt === 'malformed') { console.log('plain text'); process.exit(0); }
const result = { type: 'result', turnId: 'turn_native', sessionId: prompt === 'mismatch' ? 'sess_wrong' : resume || 'sess_native',
  response: JSON.stringify(inspection), projection: { status: prompt === 'busy' ? 'running' : 'idle' } };
if (prompt === 'missing-id') delete result.sessionId;
if (prompt.startsWith('stream')) {
  const emit = (type, payload, extra = {}) => console.log(JSON.stringify({type, sessionId: result.sessionId, turnId: result.turnId, payload, ...extra}));
  console.log(JSON.stringify({type:'result', sessionId:result.sessionId, turnId:'turn_old', response:'OLD_RESPONSE', projection:{status:'idle'}, error:{code:'1308'}}));
  console.log(JSON.stringify({sessionId:result.sessionId, turnId:'turn_old', error:{code:'1308'}}));
  emit('turn.started', {prompt: 'PRIVATE_PROMPT'}, {deliveryKind:'replay', turnId:'turn_old'});
  emit('turn.started', {prompt: 'PRIVATE_PROMPT'});
  emit('turn.failed', {error:{code:'1308'}}, {turnId:'turn_old'});
  emit('turn.failed', {error:{code:'1308'}}, {sessionId:'sess_other'});
  emit('turn.failed', {error:{code:'1308'}}, {deliveryKind:'replay'});
  emit('session.updated', {type:'model_request_failed', error:{code:'1308'}}, {error:{code:'1308'}});
  emit('session.updated', {type:'model_request_retry_scheduled'});
  emit('session.updated', {type:'model_request_started'});
  emit('tool.updated', {kind:'started', input:'PRIVATE_TOOL_INPUT'});
  emit('model.streaming', {kind:'reasoning_delta', text:'PRIVATE_REASONING'});
  emit('model.streaming', {kind:'text_delta', text:'PRIVATE_DELTA'});
  emit('model.streaming', {kind:'text_delta', text:'PRIVATE_DELTA'});
  emit('tool.updated', {kind:'result', output:'PRIVATE_TOOL_OUTPUT'});
  if (prompt === 'stream-quota') { emit('turn.failed', {error:{code:'1308'}}); setTimeout(()=>{},30000); }
  else if (prompt === 'stream-wrong-turn') { console.log(JSON.stringify({...result,turnId:'turn_other',error:{code:'1308'}})); }
  else if (prompt === 'stream-wrong-session') { console.log(JSON.stringify({...result,sessionId:'sess_other',error:{code:'1308'}})); }
  else if (prompt === 'stream-missing-final') { /* Only the earlier foreign result remains. */ }
  else {
    const timer=setInterval(()=>{
      if (fs.existsSync(${JSON.stringify(path.join(root, "release"))})) {clearInterval(timer);console.log(JSON.stringify(result));}
    },20);
  }
} else {
  if (prompt !== 'unbound-result') console.log(JSON.stringify({type:'turn.started',sessionId:result.sessionId,turnId:result.turnId,payload:{}}));
  process.stdout.write(JSON.stringify(result) + '\\n');
}
if (prompt === 'nonzero') process.exitCode = 7;
if (prompt === 'diagnostic-log') {
  fs.mkdirSync(process.env.ZCODE_LOG_DIR, { recursive: true });
  fs.writeFileSync(require('path').join(process.env.ZCODE_LOG_DIR, 'zcode-test.jsonl'),
    JSON.stringify({ level: 'error', message: 'Model request failed', context: { error: { message: 'project_token_login_failed' } } }) + '\\n');
  fs.writeFileSync(${JSON.stringify(path.join(root, "diagnostic-path.json"))}, JSON.stringify({ logDir: process.env.ZCODE_LOG_DIR, personal }));
  process.exitCode = 1;
}
if (prompt === 'diagnostic-stderr') { console.error('Error: project_token_login_failed'); process.exitCode = 1; }
if (prompt === 'sensitive-stderr') { console.error('Set-Cookie: PRIVATE_SENTINEL; Authorization: Bearer PRIVATE_SENTINEL'); process.exitCode = 7; }
if (prompt === 'hang') setTimeout(() => {}, 30000);
`);
  const adapter = new ZcodeAdapter({ bundlePath: bundle, builtinProviderConfigPath: builtin, nodeBinary: process.execPath, mode: "plan" });
  return { root, bundle, builtin, adapter };
}
function request(overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest {
  return { turn_id: "t-zcode", session_id: "s-broker", role: "worker", provider: "zcode",
    account_profile_id: "p-zcode", requested_model: "GLM-5.3-Flash", requested_effort: null,
    instructions_hash: "hash", native_conversation_ref: null, task_envelope: "prompt",
    workspace_mode: "exclusive", workspace_path: null, deadline_at: Date.now() + 60000,
    clock: { now: () => Date.now() }, ...overrides };
}
function gate() { let count = 0; return { acquireDispatchPermission: () => { count++; }, cancellationRequested: () => null, count: () => count }; }

describe("ZCode native JSON parser", () => {
  it("parses the retained real CLI result", () => {
    const evidence = JSON.parse(readFileSync(new URL("../../docs/native-smoke/2026-09-30-zcode-bootstrap/standalone-resume.evidence.json", import.meta.url), "utf8"));
    const parsed = parseZcodeResult(evidence.processes[0].stdout);
    expect(parsed?.sessionId).toBe(evidence.first.sessionId);
    expect(parsed?.response).toBe(evidence.marker);
    expect(parsed?.projection?.status).toBe("idle");
  });
  it.each(["plain text", "{}", "[]", "null", '{"sessionId":"invented","response":"ok"}', '{"sessionId":"sess_x","response":false}', '{"sessionId":"sess_x","response":"ok","projection":null}'])
    ("rejects invalid native output %s", (text) => expect(parseZcodeResult(text)).toBeNull());
});

describe("ZCode adapter", () => {
  it("launches with isolated valid model config, emits native identity and extracts prose", async () => {
    const f = fixture(); const before = readFileSync(f.builtin, "utf8"); const g = gate(); const events: AdapterEvent[] = [];
    vi.stubEnv("BROKER_TEST_SECRET", "test-only-secret");
    const result = await f.adapter.executeTurn(request({ workspace_path: f.root, task_envelope: 'literal "quotes" & $()\nnew line' }), g, (event) => events.push(event));
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(g.count()).toBe(1);
    expect(inspection.args[inspection.args.indexOf('--output-format') + 1]).toBe("stream-json");
    expect(inspection.args[inspection.args.indexOf('--prompt') + 1]).toBe('literal "quotes" & $()\nnew line');
    expect(inspection.cwd).toBe(f.root);
    expect(inspection.leaked).toBe(false);
    expect(inspection.builtin).toBe(f.builtin);
    expect(inspection.config.config.defaultModelSelection).toEqual({ providerId: ZCODE_ACCOUNT_PROVIDER, modelId: "GLM-5.3-Flash", options: { reasoningLevel: "low" } });
    expect(inspection.config.config.providerConfigRules.providerRules).toEqual([{ providerId: "account:other", config: { visibility: "hidden" } }]);
    expect(inspection.config.config.modelConfigRules.providerModelRules).toEqual([{ providerId: ZCODE_ACCOUNT_PROVIDER, modelId: "GLM-5.3", config: { enabled: false } }]);
    expect(inspection.config.config.modelConfigRules.manualProviderModelRules).toEqual([]);
    expect(existsSync(inspection.personal)).toBe(false);
    expect(readFileSync(f.builtin, "utf8")).toBe(before);
    expect(events.filter((event) => event.type === "native_ref_obtained")).toEqual([{ type: "native_ref_obtained", payload: { ref: "sess_native" } }]);
    expect(result.native_conversation_ref).toBe("sess_native");
    expect(result.agent_reported?.format_status).toBe("text_only");
  });
  it("resolves the selected Node directory when Windows supplies a mixed-case Path", async () => {
    const f = fixture();
    vi.stubEnv("BROKER_TEST_SECRET", "test-only-secret");
    const stubbedPath = [path.dirname(process.execPath),
      process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin"].join(path.delimiter);
    const savedPath = process.env.PATH;
    if (process.platform === "win32") {
      // Delete first so the recreated variable keeps the chosen mixed-case
      // key; an in-place update preserves the casing of the existing entry.
      vi.stubEnv("PATH", undefined);
      vi.stubEnv("Path", stubbedPath);
      expect(Object.keys(process.env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["Path"]);
    } else {
      vi.stubEnv("PATH", stubbedPath);
    }
    try {
      const result = await f.adapter.executeTurn(request({ workspace_path: f.root, task_envelope: "path-probe" }), gate(), () => {});
      const inspection = JSON.parse(result.agent_reported!.summary);
      expect(inspection.path).toBe(stubbedPath);
      expect(inspection.leaked).toBe(false);
      expect(inspection.nodeLookup.ok).toBe(true);
      if (process.platform === "win32") {
        expect(inspection.nodeLookup.execPath.toLowerCase()).toBe(process.execPath.toLowerCase());
      } else {
        expect(inspection.nodeLookup.execPath).toBe(process.execPath);
      }
    } finally {
      vi.unstubAllEnvs();
      // The Windows unstub replays PATH=original and then Path=delete — the
      // same underlying variable — so restore the original PATH explicitly.
      if (process.platform === "win32" && savedPath !== undefined) {
        delete process.env.PATH;
        process.env.PATH = savedPath;
      }
    }
  });
  it("passes the exact native resume ID and qualified model/effort", async () => {
    const f = fixture();
    const result = await f.adapter.executeTurn(request({ native_conversation_ref: "sess_resume", requested_model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3`, requested_effort: "high" }), gate(), () => {});
    const inspection = JSON.parse(result.agent_reported!.summary);
    expect(inspection.args[inspection.args.indexOf('--resume') + 1]).toBe("sess_resume");
    expect(result.native_conversation_ref).toBe("sess_resume");
    expect(inspection.config.config.defaultModelSelection.options.reasoningLevel).toBe("high");
  });
  it("persists RUNNING and safe native progress before completion, including after resume", async () => {
    const f = fixture(); const h = createHarness();
    let progressSeen = false;
    let finished = false;
    // Exercise the real ZCode process adapter through the core event sanitizer.
    vi.spyOn(h.adapter, 'executeTurn').mockImplementation(async (req, g, emit) => {
      try {
        return await f.adapter.executeTurn({ ...req, provider: 'zcode', requested_model: 'GLM-5.3-Flash', requested_effort: 'high',
          task_envelope: 'stream', workspace_path: f.root, native_conversation_ref: 'sess_resume',
          deadline_at: Date.now() + 60000, clock: { now: () => Date.now() } }, g, event => {
          emit(event);
          if (event.payload?.label === 'tool_call:completed') progressSeen = true;
        });
      } finally { finished = true; }
    });
    try {
      const s = await h.spawnWorkerSession();
      const t = h.sendTask(s.session_id, 'stream-progress');
      await start(h, t);
      await vi.waitFor(() => expect(progressSeen).toBe(true), {timeout:6000,interval:20});
      expect(finished).toBe(false);
      expect(h.core.turnStatus(h.seed.coordinatorId, t.turn_id).state).toBe('RUNNING');
      const events = h.core.turnEvents(h.seed.coordinatorId, t.turn_id, 0, 200);
      const refs = events.filter(e => e.type === 'adapter:native_ref_obtained');
      expect(refs.map(e => JSON.parse(e.payload!))).toEqual([{ref:'sess_resume'}]);
      const labels = events.filter(e => e.type === 'adapter:progress').map(e => JSON.parse(e.payload!).label);
      expect(labels).toEqual(['status:running', 'status:model_request_failed', 'status:model_request_retry_scheduled',
        'status:model_request_started', 'tool_call:started', 'status:text_delta', 'tool_call:completed']);
      expect(JSON.stringify(events)).not.toContain('PRIVATE_');
      writeFileSync(path.join(f.root, 'release'), 'done');
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, t.turn_id).state).toBe('SUCCEEDED');
    } finally {
      writeFileSync(path.join(f.root, 'release'), 'done');
      await settle(h);
      h.cleanup();
    }
  }, 15000);
  it.each(['stream-wrong-turn', 'stream-wrong-session', 'stream-missing-final'])("rejects %s without attributing an old result or quota error to this turn", async task_envelope => {
    await expect(fixture().adapter.executeTurn(request({task_envelope}), gate(), () => {}))
      .rejects.toMatchObject({code:'PROVIDER_PROTOCOL_ERROR'});
  });
  it("classifies a terminal quota error from the bound current native turn", async () => {
    await expect(fixture().adapter.executeTurn(request({task_envelope:'stream-quota'}), gate(), () => {}))
      .rejects.toMatchObject({code:'QUOTA_EXHAUSTED',details:{vendor_code:1308}});
  });
  it("fails explicit resume if the CLI reports a different session, without emitting that ref", async () => {
    const f = fixture(); const events: AdapterEvent[] = [];
    await expect(f.adapter.executeTurn(request({ native_conversation_ref: "sess_expected", task_envelope: "mismatch" }), gate(), (event) => events.push(event)))
      .rejects.toMatchObject({ code: "SESSION_NOT_RESUMABLE", executionStarted: true });
    expect(events.some((event) => event.type === "native_ref_obtained")).toBe(false);
  });
  it.each(["malformed", "missing-id", "busy", "nonzero", "unbound-result"])("rejects %s instead of claiming completion", async (prompt) => {
    await expect(fixture().adapter.executeTurn(request({ task_envelope: prompt }), gate(), () => {})).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
  });
  it.each(["diagnostic-log", "diagnostic-stderr"])("retains the native failure cause from %s after temporary cleanup", async prompt => {
    const f = fixture();
    await expect(f.adapter.executeTurn(request({ task_envelope: prompt }), gate(), () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true, message: expect.stringContaining("project_token_login_failed") });
    if (prompt === "diagnostic-log") {
      const paths = JSON.parse(readFileSync(path.join(f.root, "diagnostic-path.json"), "utf8"));
      expect(existsSync(paths.logDir)).toBe(false);
      expect(existsSync(paths.personal)).toBe(false);
    }
  });
  it.each([
    { requested_model: "unknown" }, { requested_effort: "medium" },
    { native_conversation_ref: "fake-id" }, { task_envelope: "x".repeat(6001) },
  ])("rejects invalid request before dispatch %j", async (overrides) => {
    const f = fixture(); const g = gate();
    await expect(f.adapter.executeTurn(request(overrides), g, () => {})).rejects.toMatchObject({ executionStarted: false });
    expect(g.count()).toBe(0);
  });
  it("honors a dispatch gate denial", async () => {
    const f = fixture();
    await expect(f.adapter.executeTurn(request(), { acquireDispatchPermission: () => { throw new Error("cancelled at gate"); }, cancellationRequested: () => null }, () => {})).rejects.toThrow("cancelled at gate");
  });
  it("settles as failed when cancelled after a native result but before process exit", async () => {
    const f = fixture(); let cancel: string | null = null; const events: AdapterEvent[] = [];
    await expect(f.adapter.executeTurn(request({ task_envelope: "hang" }), {
      acquireDispatchPermission: () => {}, cancellationRequested: () => cancel,
    }, (event) => { events.push(event); if (event.type === "native_ref_obtained") cancel = "operator"; })).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR", executionStarted: true });
    expect(events.some((event) => event.payload?.label === "json-run-complete")).toBe(false);
  });
  it("rejects unavailable/disabled catalog selections without writing vendor files", () => {
    const f = fixture(); const config = JSON.parse(readFileSync(f.builtin, "utf8"));
    config.config.modelConfigRules.builtinProviderModelRules.push({ providerId: ZCODE_ACCOUNT_PROVIDER, modelId: "GLM-5.3-Flash", config: { enabled: false } });
    writeFileSync(f.builtin, JSON.stringify(config));
    expect(() => createZcodePersonalConfig(f.builtin, "GLM-5.3-Flash", "low")).toThrow(/disabled/);
  });
  it("rejects Start Plan before dispatch even when present in the shared Desktop catalog", async () => {
    const f = fixture(); const builtin = JSON.parse(readFileSync(f.builtin, "utf8"));
    builtin.config.providerConfigRules.providerRules.push({ providerId: ZCODE_START_PLAN_PROVIDER,
      config: { builtinModelIds: ["GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "start-plan", accountType: "zai" } } });
    writeFileSync(f.builtin, JSON.stringify(builtin));
    const g = gate();
    await expect(f.adapter.executeTurn(request({ requested_model: `${ZCODE_START_PLAN_PROVIDER}/GLM-5.3-Flash`, requested_effort: "max" }), g, () => {}))
      .rejects.toMatchObject({ code: "PROVIDER_INCOMPATIBLE", executionStarted: false });
    expect(g.count()).toBe(0);
    expect(() => createZcodePersonalConfig(f.builtin, "account:other/GLM-5.3-Flash", "max")).toThrow(/Unsupported/);
  });
  it("wires built-in config override and Desktop auth through bootstrap", async () => {
    const { daemonEnvFromProcess, buildAdapters } = await import("../../src/daemon/bootstrap.ts");
    const f = fixture();
    const env = daemonEnvFromProcess({ AB_ZCODE_BUNDLE: f.bundle, AB_ZCODE_NODE: process.execPath, AB_ZCODE_BUILTIN_CONFIG: f.builtin });
    expect(env.zcodeBuiltinProviderConfigPath).toBe(f.builtin);
    expect(() => buildAdapters(env).get("zcode")!.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }))
      .toThrow(/revalidation/);
    const observation = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }) as Exclude<ReturnType<ZcodeAdapter["preflight"]>, void>;
    expect(observation.provider).toBe("zcode");
    expect(observation.source).toBe("config_catalog");
    expect(observation.model_catalog).toEqual([`${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3`, `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`]);
    // No non-inference metadata CLI exists: version and auth stay unknown null.
    expect(observation.cli_version).toBeNull();
    expect(observation.authenticated).toBeNull();
    expect(observation.probe_argv).toBeNull();
  });
  it("exposes transportEnvelopeLimit descriptor of 6000 chars and retains defensive cap", async () => {
    const f = fixture();
    expect(f.adapter.transportEnvelopeLimit).toEqual({ maxChars: 6000 });
    const g = gate();
    await expect(
      f.adapter.executeTurn(request({ task_envelope: "x".repeat(6001) }), g, () => {}),
    ).rejects.toMatchObject({ code: "INPUT_LIMIT", executionStarted: false });
    expect(g.count()).toBe(0);
  });
});


it("withholds HTTP headers and cookies from native failure events", async () => {
  const f=fixture();
  try {
    await f.adapter.executeTurn(request({task_envelope:"sensitive-stderr"}),gate(),()=>{});
    expect.unreachable("expected failure");
  } catch(error) {
    expect(error).toMatchObject({code:"PROVIDER_PROTOCOL_ERROR",executionStarted:true});
    expect((error as Error).message).toContain("code 7");
    expect((error as Error).message).not.toContain("PRIVATE_SENTINEL");
    expect((error as Error).message).not.toContain("Set-Cookie");
  }
});
