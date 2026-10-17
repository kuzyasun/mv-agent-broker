import { afterEach, describe, expect, it, vi } from "vitest";
import { ZcodeAdapter } from "../../src/providers/zcode/zcodeAdapter.ts";
import { adaptDesktopAuthSource, ZCODE_DESKTOP_AUTH_REJECTED, ZCODE_DESKTOP_AUTH_REQUEST } from "../../src/providers/zcode/desktopAuth.ts";
import { sanitizeAdapterEvent, type AdapterEvent, type TurnExecutionRequest } from "../../src/runtime/adapter.ts";
import { runHeadlessCli } from "../../src/providers/common/headless.ts";
import * as config from "../../src/providers/zcode/nativeConfig.ts";
import { ZCODE_PROJECT_ACCESS_PREFIX, parseZcodeProjectAccessDiagnostic, zcodeProjectAccessError } from "../../src/providers/zcode/projectAccessDiagnostic.ts";

vi.mock("../../src/providers/common/headless.ts", () => ({ runHeadlessCli: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

// The exact verified native exchange/request boundaries, with no account store.
const boundary = 'const T7=()=>true;function fpt(e){let o=r(async(f,g)=>{let _=await e.httpClient.request({url:f,...g}).catch(b=>{throw T7(b)?b:b});if(_.status===401&&new URL(f).pathname.startsWith("/api/biz/"))e.reject();if(_.status>=400)throw new Error("project_token_request_failed");return JSON.parse(new TextDecoder().decode(_.body))},"request");return {exchange:g=>(()=>o(`${Iso}/api/auth/z/login`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:g})}))(),request:o}}async function Ita(){}';
const patUrl = "https://api.z.ai/api/biz/v1/organization/synthetic/projects/synthetic/api_keys/synthetic/access_tokens";

describe("ZCode Desktop business-token bridge", () => {
  it("uses the already exchanged token and leaves real PAT requests with native transport", async () => {
    const messages: string[] = [];
    const request = vi.fn().mockResolvedValue({ status: 200, body: new TextEncoder().encode('{"native":"PAT response"}') });
    const resolver = new Function("r", "Iso", "process", adaptDesktopAuthSource(boundary) + ";return fpt;")(
      (f: unknown) => f, "https://api.z.ai", { stderr: { write: (s: string) => messages.push(s) } },
    )({ httpClient: { request }, reject: vi.fn() });
    const token = "synthetic-desktop-business-token";
    expect(await resolver.exchange(token)).toEqual({ code: 200, data: { access_token: token } });
    expect(request).not.toHaveBeenCalled();
    const input = { method: "POST", headers: { Authorization: "Bearer synthetic" }, body: "PAT request" };
    expect(await resolver.request(patUrl, input)).toEqual({ native: "PAT response" });
    expect(request).toHaveBeenCalledExactlyOnceWith({ url: patUrl, ...input });
    expect(messages.join("")).not.toContain(token);
  });
  it("reports a real business 401 with fixed messages, without changing native retry/rejection", async () => {
    const messages: string[] = [];
    const reject = vi.fn();
    const resolver = new Function("r", "Iso", "process", adaptDesktopAuthSource(boundary) + ";return fpt;")(
      (f: unknown) => f, "https://api.z.ai", { stderr: { write: (s: string) => messages.push(s) } },
    )({ httpClient: { request: async () => ({ status: 401 }) }, reject });
    await expect(resolver.request(patUrl, {})).rejects.toThrow("project_token_request_failed");
    expect(messages).toEqual([ZCODE_DESKTOP_AUTH_REQUEST + "\n", ZCODE_PROJECT_ACCESS_PREFIX + '{"stage":"pat_issue","kind":"http","status":401}\n', ZCODE_DESKTOP_AUTH_REJECTED + "\n"]);
    expect(reject).toHaveBeenCalledOnce();
    messages.length = 0;
    await expect(resolver.request("https://other.example/api/biz/project/pat", {})).rejects.toThrow();
    expect(messages).toEqual([]);
  });
  it.each(["", boundary.replace("function fpt(e){", "function changed(e){"), boundary + boundary,
    boundary.replace('JSON.stringify({token:g})', 'JSON.stringify({changed:g})')])("refuses changed resolver contracts", source => {
    // Duplicated resolver definitions must also fail, even outside its first body.
    expect(() => adaptDesktopAuthSource(source)).toThrow(/revalidation/);
  });
  it.each([
    { status: 403, body: "{}", kind: "http" },
    { status: 429, body: "{}", kind: "http" },
    { status: 503, body: "{}", kind: "http" },
    { error: "timeout", kind: "timeout" },
    { error: "network_error", kind: "network_error" },
    { status: 200, body: "not json PRIVATE_RESPONSE", kind: "invalid_json" },
    { status: 200, body: '{"code":1308,"token":"PRIVATE_RESPONSE"}', kind: "provider_error" },
  ])("captures the cause before native error collapse without private data: %j", async row => {
    const messages: string[] = [];
    const resolver = new Function("r", "Iso", "process", adaptDesktopAuthSource(boundary) + ";return fpt;")(
      (f: unknown) => f, "https://api.z.ai", { stderr: { write: (s: string) => messages.push(s) } },
    )({ httpClient: { request: async () => {
      if (row.error) throw Object.assign(new Error("PRIVATE_RESPONSE"), { code: row.error });
      return { status: row.status, body: new TextEncoder().encode(row.body) };
    } }, reject: vi.fn() });
    await resolver.request(patUrl, {}).catch(() => {});
    const diagnostic = messages.map(line => parseZcodeProjectAccessDiagnostic(line.trim())).find(Boolean);
    expect(diagnostic).toMatchObject({ stage: "pat_issue", kind: row.kind });
    expect(messages.join("")).not.toContain("PRIVATE_RESPONSE");
    expect(messages.join("")).not.toContain("synthetic");
  });
});

describe("Desktop auth failure attribution", () => {
  async function run(lines: string[], exitCode: number, cancellation = false, events: AdapterEvent[] = []) {
    const adapter = new ZcodeAdapter({ bundlePath: "unused", authSource: "desktop" });
    vi.spyOn(adapter, "preflight").mockReturnValue(undefined);
    // Config is intentionally mocked separately from auth: no credential reads.
    vi.spyOn(config, "resolveZcodeBuiltinPath").mockReturnValue("unused");
    vi.spyOn(config, "createZcodePersonalConfig").mockReturnValue({});
    vi.mocked(runHeadlessCli).mockImplementation(async (options, callbacks) => {
      expect(options.args.slice(0, 2)).toEqual(["--import", expect.stringContaining("desktopAuthPreload.")]);
      lines.forEach(line => callbacks.onStderrLine?.(line));
      callbacks.onStdoutLine?.('{"type":"turn.started","sessionId":"sess_test","turnId":"turn_test","payload":{}}');
      callbacks.onStdoutLine?.('{"type":"result","turnId":"turn_test","sessionId":"sess_test","response":"ok","projection":{"status":"idle"}}');
      return { exitCode, killed: false, timedOut: null, stderrTail: "native failure", uncertainAfterResume: false } as Awaited<ReturnType<typeof runHeadlessCli>>;
    });
    let checks = 0;
    const req = { task_envelope: "test", native_conversation_ref: null, requested_model: "GLM-5.3-Flash", requested_effort: "max",
      workspace_path: null, deadline_at: Date.now() + 1000, clock: { now: Date.now } } as TurnExecutionRequest;
    return adapter.executeTurn(req, { acquireDispatchPermission() {}, cancellationRequested: () => cancellation && checks++ > 0 ? "operator" : null }, event => events.push(event));
  }
  it("classifies terminal credential rejection as AUTH_REQUIRED", async () => {
    await expect(run([ZCODE_DESKTOP_AUTH_REQUEST, ZCODE_DESKTOP_AUTH_REJECTED], 1)).rejects.toMatchObject({
      code: "AUTH_REQUIRED", details: { status_code: 401 }, message: expect.stringContaining("Sign in to ZCode Desktop"),
    });
  });
  it("allows a recovered 401 on a successful turn", async () => {
    await expect(run([ZCODE_DESKTOP_AUTH_REJECTED], 0)).resolves.toMatchObject({ native_outcome: "completed" });
  });
  it.each([{ lines: [] }, { lines: ["HTTP 401"] }, { lines: [ZCODE_DESKTOP_AUTH_REJECTED, ZCODE_DESKTOP_AUTH_REQUEST] }])("does not attribute another failure to an old or unstructured 401: %j", async ({ lines }) => {
    await expect(run(lines, 1)).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
  });
  it("keeps explicit cancellation ahead of auth failure", async () => {
    await expect(run([ZCODE_DESKTOP_AUTH_REJECTED], 1, true)).rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
  });
  it("retains an actual PAT denial rather than the generic final log wrapper", async () => {
    const events: AdapterEvent[] = [];
    await expect(run([ZCODE_DESKTOP_AUTH_REQUEST, ZCODE_PROJECT_ACCESS_PREFIX + '{"stage":"pat_issue","kind":"http","status":403}'], 1, false, events))
      .rejects.toMatchObject({ code: "PROVIDER_EXECUTION_ERROR", details: { stage: "pat_issue", status_code: 403 }, message: expect.stringContaining("HTTP 403") });
    expect(events.filter(e => e.type === 'provider_diagnostic').map(sanitizeAdapterEvent)).toEqual([
      {type:'provider_diagnostic',payload:{provider:'zcode',stage:'pat_issue',kind:'http',status:403}},
    ]);
  });
  it("clears a recovered project-access failure before a later unrelated failure", async () => {
    await expect(run([ZCODE_PROJECT_ACCESS_PREFIX + '{"stage":"pat_issue","kind":"http","status":403}', ZCODE_DESKTOP_AUTH_REQUEST], 1))
      .rejects.toMatchObject({ code: "PROVIDER_PROTOCOL_ERROR" });
  });
});

describe("Safe project-access diagnostics", () => {
  it.each([
    { kind: "http", status: 401, expected: "AUTH_REQUIRED" },
    { kind: "http", status: 403, expected: "PROVIDER_EXECUTION_ERROR" },
    { kind: "http", status: 429, expected: "RATE_LIMITED" },
    { kind: "http", status: 503, expected: "PROVIDER_UNAVAILABLE" },
    { kind: "timeout", expected: "PROVIDER_NETWORK_ERROR" },
    { kind: "network_error", expected: "PROVIDER_NETWORK_ERROR" },
    { kind: "invalid_json", expected: "PROVIDER_PROTOCOL_ERROR" },
    { kind: "provider_error", status: 200, vendor_code: 1308, expected: "QUOTA_EXHAUSTED" },
    { kind: "provider_error", status: 200, vendor_code: 401, expected: "PROVIDER_EXECUTION_ERROR" },
  ])("classifies observed metadata accurately: %j", row => {
    const diagnostic = parseZcodeProjectAccessDiagnostic(ZCODE_PROJECT_ACCESS_PREFIX + JSON.stringify({ stage: "pat_issue", ...row, token: "PRIVATE" }));
    expect(diagnostic).not.toBeNull();
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE");
    expect(zcodeProjectAccessError(diagnostic!).code).toBe(row.expected);
  });
  it.each(["HTTP 403", ZCODE_PROJECT_ACCESS_PREFIX + '{}', ZCODE_PROJECT_ACCESS_PREFIX + '{"stage":"PRIVATE","kind":"http","status":403}',
    ZCODE_PROJECT_ACCESS_PREFIX + '{"stage":"pat_issue","kind":"http","status":"403"}'])("rejects unstructured or untrusted metadata: %s", line => {
    expect(parseZcodeProjectAccessDiagnostic(line)).toBeNull();
  });
});
