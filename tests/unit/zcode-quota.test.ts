/**
 * Offline unit tests for ZCode quota and rate-limit error classification.
 * Uses fake Node CLI fixtures; no vendor inference, no real network calls.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZcodeAdapter } from "../../src/providers/zcode/zcodeAdapter.ts";
import { ZCODE_ACCOUNT_PROVIDER } from "../../src/providers/zcode/nativeConfig.ts";
import {
  classifyZcodeError,
  classifyZcodeStderrLine,
  classifyZcodeText,
  parseZcodeResult,
} from "../../src/providers/zcode/resultParser.ts";
import type { AdapterEvent, TurnExecutionRequest } from "../../src/runtime/adapter.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import * as headless from "../../src/providers/common/headless.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors in tests
    }
  }
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-zcode-quota-test-"));
  roots.push(root);
  const bundle = path.join(root, "fake.cjs");
  const builtin = path.join(root, "zcode-builtin.json");
  writeFileSync(
    builtin,
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: ZCODE_ACCOUNT_PROVIDER,
              config: {
                builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"],
                access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" },
              },
            },
            { providerId: "account:other", config: {} },
          ],
        },
        modelConfigRules: { builtinProviderModelRules: [] },
      },
    }),
  );

  writeFileSync(
    bundle,
    `
const fs = require('fs');
const args = process.argv.slice(2);
const prompt = args[args.indexOf('--prompt') + 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;

if (prompt === 'stdout-projection-quota-1308') {
  const result = {
    sessionId: 'sess_native',
    projection: {
      status: 'running',
      lastError: {
        code: 'model_rate_limited',
        message: 'Five-hour usage limit reached',
        attribution: { providerErrorCode: '1308', statusCode: 429, retryable: false }
      }
    }
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(1);
}

if (prompt === 'stdout-top-error-1308') {
  const result = {
    sessionId: 'sess_native',
    error: {
      code: 'model_rate_limited',
      providerErrorCode: 1308,
      statusCode: 429
    }
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(1);
}

if (prompt === 'stdout-projection-rate-limit') {
  const result = {
    sessionId: 'sess_native',
    projection: {
      status: 'running',
      lastError: {
        code: 'model_rate_limited',
        message: 'Start Plan is busy',
        attribution: { providerErrorCode: '3010', statusCode: 429 }
      }
    }
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(1);
}

if (prompt === 'stderr-1308') {
  process.stderr.write('{"error":{"code":"1308","statusCode":429,"message":"usage limit"}}\\n');
  process.exit(1);
}

if (prompt === 'stderr-1310') {
  process.stderr.write('{"error":{"code":"1310","message":"weekly limit"}}\\n');
  process.exit(1);
}

if (prompt === 'stderr-startplan-busy') {
  process.stderr.write('{"error":{"code":"model_rate_limited","providerErrorCode":3010,"statusCode":429}}\\n');
  process.exit(1);
}

if (prompt === 'stderr-json-quota') {
  process.stderr.write(JSON.stringify({
    code: 'model_rate_limited',
    attribution: { providerErrorCode: '1308', statusCode: 429 }
  }) + '\\n');
  process.exit(1);
}

if (prompt === 'owned-descendant-quota') {
  require('child_process').spawn(process.execPath,['-e',"const fs=require('fs');const timer=setInterval(()=>fs.appendFileSync('heartbeat','x'),20);setTimeout(()=>clearInterval(timer),8000);"],{stdio:'ignore',windowsHide:true});
  const ready=setInterval(()=>{if(fs.existsSync('heartbeat')){clearInterval(ready);process.stderr.write(JSON.stringify({error:{code:'1308'}})+'\\n')}},20);
  setTimeout(()=>process.exit(0),8000);
  return;
}

if (prompt === 'hang-after-quota') {
  process.stderr.write('{"error":{"code":"1308","statusCode":429,"message":"usage limit"}}\\n');
  setTimeout(() => {}, 60000);
  return;
}

if (prompt === 'split-unterminated') {
  process.stderr.write('{"error":{"code":"1308","statusCode":429,"message":"usage limit"}}');
  process.exit(1);
}

if (prompt === 'large-error-bounded') {
  const padding = 'x'.repeat(20000);
  process.stderr.write(JSON.stringify({error:{code:'1308',message:padding}}) + '\\n');
  process.exit(1);
}

if (prompt === 'prose-with-429-1308') {
  const result = {
    sessionId: 'sess_native',
    response: 'I investigated error 429 and resolved issue 1308 in the repository.',
    projection: { status: 'idle' }
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(0);
}

if (prompt === 'tool-stderr-429') {
  process.stderr.write('curl: (22) The requested URL returned error: 429 Too Many Requests\\n');
  const result = {
    sessionId: 'sess_native',
    response: 'Tool executed and handled retry.',
    projection: { status: 'idle' }
  };
  process.stdout.write(JSON.stringify(result) + '\\n');
  process.exit(0);
}

if (prompt === 'tool-stderr-1308-not-quota') {
  process.stderr.write('Found 1308 matching records in database query.\\n');
  process.exit(7);
}

if (prompt === 'auth-failure') {
  process.stderr.write('ModelProviderError: 401 Unauthorized - invalid authentication credentials\\n');
  process.exit(1);
}

if (prompt === 'malformed-json') {
  process.stdout.write('not valid json { 1308: 429 }\\n');
  process.exit(0);
}

if (prompt === 'sensitive-with-quota') {
  process.stderr.write(JSON.stringify({error:{code:'1308',message:'Set-Cookie: PRIVATE_SENTINEL_COOKIE; Authorization: Bearer PRIVATE_SENTINEL_TOKEN'}}) + '\\n');
  process.exit(1);
}

if (prompt === 'output-cap') {
  process.stdout.write('x'.repeat(1_100_000));
  process.exit(0);
}
`,
  );

  const adapter = new ZcodeAdapter({
    bundlePath: bundle,
    builtinProviderConfigPath: builtin,
    nodeBinary: process.execPath,
    mode: "plan",
  });
  return { root, bundle, builtin, adapter };
}

function request(overrides: Partial<TurnExecutionRequest> = {}): TurnExecutionRequest {
  return {
    turn_id: "t-zcode-quota",
    session_id: "s-broker-quota",
    role: "worker",
    provider: "zcode",
    account_profile_id: "p-zcode",
    requested_model: "GLM-5.3-Flash",
    requested_effort: null,
    instructions_hash: "hash",
    native_conversation_ref: null,
    task_envelope: "prompt",
    workspace_mode: "exclusive",
    workspace_path: null,
    deadline_at: Date.now() + 60000,
    clock: { now: () => Date.now() },
    ...overrides,
  };
}

function gate(cancelFn: () => string | null = () => null) {
  let count = 0;
  return {
    acquireDispatchPermission: () => {
      count++;
    },
    cancellationRequested: cancelFn,
    count: () => count,
  };
}

describe("ZCode quota classification parser", () => {
  it("classifies explicit 1308 usage quota in projection lastError", () => {
    const error = classifyZcodeError({
      projection: {
        status: "running",
        lastError: {
          code: "model_rate_limited",
          attribution: { providerErrorCode: "1308", statusCode: 429 },
        },
      },
    });
    expect(error).toEqual({
      kind: "quota_exhausted",
      errorCode: "QUOTA_EXHAUSTED",
      safeMessage: "ZCode provider quota exhausted.",
      vendorCode: 1308,
      statusCode: 429,
    });
  });

  it("classifies explicit 1310 quota limit in projection lastError", () => {
    const error = classifyZcodeError({
      error: {
        code: "model_rate_limited",
        attribution: { providerErrorCode: "1310" },
      },
    });
    expect(error).toEqual({
      kind: "quota_exhausted",
      errorCode: "QUOTA_EXHAUSTED",
      safeMessage: "ZCode provider quota exhausted.",
      vendorCode: 1310,
    });
  });

  it("classifies transient rate limit in projection lastError", () => {
    const error = classifyZcodeError({
      projection: {
        status: "running",
        lastError: {
          code: "model_rate_limited",
          attribution: { providerErrorCode: "3010", statusCode: 429 },
        },
      },
    });
    expect(error).toEqual({
      kind: "rate_limited",
      errorCode: "RATE_LIMITED",
      safeMessage: "ZCode rate limit exceeded.",
      vendorCode: 3010,
      statusCode: 429,
    });
  });

  it("classifies explicit stderr JSON with observed numeric attribution", () => {
    const error = classifyZcodeStderrLine(
      "{\"error\":{\"code\":\"1308\",\"statusCode\":429,\"message\":\"usage limit\"}}",
    );
    expect(error).toEqual({
      kind: "quota_exhausted",
      errorCode: "QUOTA_EXHAUSTED",
      safeMessage: "ZCode provider quota exhausted.",
      vendorCode: 1308,
      statusCode: 429,
    });
  });

  it("classifies an explicitly attributed busy error on stderr", () => {
    const error = classifyZcodeStderrLine(
      "{\"error\":{\"code\":\"model_rate_limited\",\"providerErrorCode\":3010,\"statusCode\":429}}",
    );
    expect(error).toEqual({
      kind: "rate_limited",
      errorCode: "RATE_LIMITED",
      safeMessage: "ZCode rate limit exceeded.",
      vendorCode: 3010,
      statusCode: 429,
    });
  });

  it("rejects untrusted generic stderr containing 429 or 1308 without native envelope", () => {
    expect(classifyZcodeStderrLine("HTTP/1.1 429 Too Many Requests")).toBeNull();
    expect(classifyZcodeStderrLine("curl: (22) The requested URL returned error: 429")).toBeNull();
    expect(classifyZcodeStderrLine("Found 1308 lines in index.ts")).toBeNull();
  });
});

describe("ZCode adapter quota execution with fake Node CLI", () => {
  it("surfaces QUOTA_EXHAUSTED from structured stdout projection", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stdout-projection-quota-1308" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      const bErr = err as BrokerError;
      expect(bErr.code).toBe("QUOTA_EXHAUSTED");
      expect(bErr.message).toBe("ZCode provider quota exhausted.");
      expect(bErr.executionStarted).toBe(true);
      expect(bErr.details?.vendor_code).toBe(1308);
      expect(bErr.details?.status_code).toBe(429);
    }
  });

  it("surfaces QUOTA_EXHAUSTED from structured top-level error in stdout", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stdout-top-error-1308" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      const bErr = err as BrokerError;
      expect(bErr.code).toBe("QUOTA_EXHAUSTED");
      expect(bErr.message).toBe("ZCode provider quota exhausted.");
      expect(bErr.details?.vendor_code).toBe(1308);
    }
  });

  it("surfaces RATE_LIMITED from structured stdout projection", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stdout-projection-rate-limit" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toBeInstanceOf(BrokerError);
      const bErr = err as BrokerError;
      expect(bErr.code).toBe("RATE_LIMITED");
      expect(bErr.message).toBe("ZCode rate limit exceeded.");
      expect(bErr.details?.vendor_code).toBe(3010);
      expect(bErr.details?.status_code).toBe(429);
    }
  });

  it("surfaces QUOTA_EXHAUSTED from supported stderr format (1308 and 1310)", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stderr-1308" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
      expect((err as BrokerError).details?.vendor_code).toBe(1308);
    }

    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stderr-1310" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
      expect((err as BrokerError).details?.vendor_code).toBe(1310);
    }
  });

  it("surfaces RATE_LIMITED from Start Plan busy stderr message", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stderr-startplan-busy" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "RATE_LIMITED",
        message: "ZCode rate limit exceeded.",
        executionStarted: true,
      });
      expect((err as BrokerError).details?.vendor_code).toBe(3010);
    }
  });

  it("surfaces QUOTA_EXHAUSTED from stderr JSON error envelope", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "stderr-json-quota" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
      expect((err as BrokerError).details?.vendor_code).toBe(1308);
    }
  });

  it("aborts early on observable quota while CLI hangs/retries and achieves quiescence", async () => {
    const f = fixture();
    const start = Date.now();
    const events: AdapterEvent[] = [];
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "hang-after-quota" }),
        gate(),
        (ev) => events.push(ev),
      );
      expect.unreachable("should fail");
    } catch (err) {
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(10000); // aborted early, didn't wait 60s
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
      expect(events.some((ev) => ev.payload?.label === "json-run-complete")).toBe(false);
    }
  });

  it("handles split and unterminated stderr chunks", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "split-unterminated" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
    }
  });

  it("bounds large error messages without failing closed or leaking memory", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "large-error-bounded" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
    }
  });

  it("does not classify generic 429 or 1308 in successful response prose as quota", async () => {
    const f = fixture();
    const result = await f.adapter.executeTurn(
      request({ workspace_path: f.root, task_envelope: "prose-with-429-1308" }),
      gate(),
      () => {},
    );
    expect(result.native_outcome).toBe("completed");
    expect(result.native_conversation_ref).toBe("sess_native");
    expect(result.agent_reported?.summary).toContain("error 429 and resolved issue 1308");
  });

  it("does not classify arbitrary tool stderr with 429 as quota when turn completes", async () => {
    const f = fixture();
    const result = await f.adapter.executeTurn(
      request({ workspace_path: f.root, task_envelope: "tool-stderr-429" }),
      gate(),
      () => {},
    );
    expect(result.native_outcome).toBe("completed");
    expect(result.agent_reported?.summary).toBe("Tool executed and handled retry.");
  });

  it("does not classify arbitrary tool stderr with 1308 as quota on nonzero exit", async () => {
    const f = fixture();
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "tool-stderr-1308-not-quota" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "PROVIDER_PROTOCOL_ERROR",
        executionStarted: true,
      });
      expect((err as Error).message).toContain("code 7");
      expect((err as Error).message).toContain("native stderr withheld");
    }
  });

  it("preserves auth and malformed failures as PROVIDER_PROTOCOL_ERROR", async () => {
    const f = fixture();
    await expect(
      f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "auth-failure" }),
        gate(),
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_PROTOCOL_ERROR",
      executionStarted: true,
    });

    await expect(
      f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "malformed-json" }),
        gate(),
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_PROTOCOL_ERROR",
      executionStarted: true,
    });
  });

  it("gives explicit cancellation precedence over quota error", async () => {
    const f = fixture();
    let cancel: string | null = null;
    await expect(
      f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "hang-after-quota" }),
        gate(() => cancel),
        (event) => {
          if (event.type === "owned_resumed") cancel = "operator";
        },
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: "ZCode execution interrupted.",
      executionStarted: true,
    });
  });

  it("gives output cap precedence over completion", async () => {
    const f = fixture();
    await expect(
      f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "output-cap" }),
        gate(),
        () => {},
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_PROTOCOL_ERROR",
      message: expect.stringContaining("output limit"),
      executionStarted: true,
    });
  });

  it("retains temp directory resources on uncertain execution receipt", async () => {
    const f = fixture();
    let capturedTmpDir: string | null = null;

    // Spy on runHeadlessCli to capture tmpDir and return uncertainAfterResume
    const originalRun = headless.runHeadlessCli;
    vi.spyOn(headless, "runHeadlessCli").mockImplementation(async (spec, events) => {
      const personal = spec.inheritEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
      if (personal) capturedTmpDir = path.dirname(personal);
      const res = await originalRun(spec, events);
      return { ...res, uncertainAfterResume: true };
    });

    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "prose-with-429-1308" }),
        gate(),
        () => {},
      );
      expect.unreachable("should fail with EXECUTION_UNKNOWN");
    } catch (err) {
      expect(err).toMatchObject({
        code: "EXECUTION_UNKNOWN",
        executionStarted: null,
      });
      // The created directory must be retained
      expect(capturedTmpDir).not.toBeNull();
      expect(existsSync(capturedTmpDir!)).toBe(true);
      if (capturedTmpDir && existsSync(capturedTmpDir)) {
        rmSync(capturedTmpDir, { recursive: true, force: true });
      }
    }
  });

  it("withholds sensitive cookies and auth headers from errors and events", async () => {
    const f = fixture();
    const events: AdapterEvent[] = [];
    try {
      await f.adapter.executeTurn(
        request({ workspace_path: f.root, task_envelope: "sensitive-with-quota" }),
        gate(),
        (ev) => events.push(ev),
      );
      expect.unreachable("should fail");
    } catch (err) {
      expect(err).toMatchObject({
        code: "QUOTA_EXHAUSTED",
        message: "ZCode provider quota exhausted.",
        executionStarted: true,
      });
      const errMsg = (err as Error).message;
      expect(errMsg).not.toContain("PRIVATE_SENTINEL_COOKIE");
      expect(errMsg).not.toContain("PRIVATE_SENTINEL_TOKEN");
      expect(errMsg).not.toContain("Set-Cookie");
      expect(errMsg).not.toContain("Authorization");

      const errDetails = JSON.stringify((err as BrokerError).details ?? {});
      expect(errDetails).not.toContain("PRIVATE_SENTINEL_COOKIE");
      expect(errDetails).not.toContain("PRIVATE_SENTINEL_TOKEN");

      const eventPayloads = JSON.stringify(events);
      expect(eventPayloads).not.toContain("PRIVATE_SENTINEL_COOKIE");
      expect(eventPayloads).not.toContain("PRIVATE_SENTINEL_TOKEN");
    }
  });
});

describe("ZCode quota attribution boundaries", () => {
  it.each([1308,1310,1316,1317,1318,1319,1320,1321])("maps documented usage code %s without inventing duration or HTTP status", code => {
    expect(classifyZcodeError({error:{code:String(code)}})).toMatchObject({errorCode:"QUOTA_EXHAUSTED",vendorCode:code,safeMessage:"ZCode provider quota exhausted."});
    expect(classifyZcodeError({error:{code:String(code)}})?.statusCode).toBeUndefined();
  });
  it.each([1302,1305])("distinguishes transient vendor code %s", code => {
    expect(classifyZcodeError({error:{code:String(code)}})?.errorCode).toBe("RATE_LIMITED");
  });
  it.each([
    {code:1308}, {tool:{error:{code:1308}}}, {response:'Error: 1308 quota'},
    {error:{code:401,message:'Previous error 1308 quota, HTTP 429'}},
    {error:{code:1311,statusCode:429}}, {error:{code:1309,statusCode:429}},
    {projection:{status:'idle',lastError:{code:'1308'}}},
    {projection:{status:'idle',lastError:{code:'model_rate_limited',attribution:{providerErrorCode:1308}}}},
    {projection:{status:'running',apiRetry:{reasonCode:'rate_limited'}}},
  ])("ignores success, unrelated errors and unsupported metadata %#", value => {
    expect(classifyZcodeError(value)).toBeNull();
  });
  it.each(['Error: 1308 quota','ModelProviderError: 1308','ModelProtocolError: sample issue 1310', 'Set-Cookie: secret; HTTP 429', '{"error":{"code":"1308"}}garbage'])('does not classify unsupported plain stderr %s', line => {
    expect(classifyZcodeStderrLine(line)).toBeNull();
  });
  it("accepts successful resume with a historical lastError", async () => {
    const f=fixture();
    writeFileSync(f.bundle,'process.stdout.write(JSON.stringify({sessionId:"sess_native",response:"recovered",projection:{status:"idle",lastError:{code:"1308"}}})+"\\n")');
    const result=await f.adapter.executeTurn(request({workspace_path:f.root,native_conversation_ref:'sess_native'}),gate(),()=>{});
    expect(result.native_outcome).toBe('completed');
    expect(result.agent_reported?.summary).toBe('recovered');
  });
  it("recognizes pretty printed structured errors during execution", async () => {
    const f=fixture();
    writeFileSync(f.bundle,'process.stdout.write(JSON.stringify({error:{code:"1308"}},null,2)+"\\n");setTimeout(()=>{},8000)');
    const start=Date.now();
    await expect(f.adapter.executeTurn(request({workspace_path:f.root}),gate(),()=>{})).rejects.toMatchObject({code:'QUOTA_EXHAUSTED'});
    expect(Date.now()-start).toBeLessThan(7000);
  });
  it.skipIf(process.platform !== 'win32')("proves owned descendant quiescence before returning a definite quota failure", async () => {
    const f=fixture();const events:AdapterEvent[]=[];
    await expect(f.adapter.executeTurn(request({workspace_path:f.root,task_envelope:'owned-descendant-quota'}),gate(),ev=>events.push(ev))).rejects.toMatchObject({code:'QUOTA_EXHAUSTED'});
    expect(events.filter(ev=>ev.type==='owned_quiescence')).toHaveLength(1);
    expect(events.find(ev=>ev.type==='owned_quiescence')?.payload).toMatchObject({active:0,drained:true});
    const marker=path.join(f.root,'heartbeat');const stopped=readFileSync(marker,'utf8');
    await new Promise(resolve=>setTimeout(resolve,250));
    expect(readFileSync(marker,'utf8')).toBe(stopped);
  },15000);
  it.each(['unknown','capture','deadline','outputcap'])("preserves %s precedence over an observed quota error", async mode => {
    const f=fixture();
    vi.spyOn(headless,'runHeadlessCli').mockImplementation(async(spec,events)=>{
      const personal=spec.inheritEnv.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE!;roots.push(path.dirname(personal));
      events.onStderrLine('{"error":{"code":"1308"}}');
      if(mode==='capture')throw new BrokerError('EVIDENCE_CAPTURE_FAILED','Capture failed.',{executionStarted:true});
      return {exitCode:1,killed:true,timedOut:mode==='deadline'?'inactivity':null,stderrTail:'',uncertainAfterResume:mode==='unknown',outputLimited:mode==='outputcap',outputLimitReason:mode==='outputcap'?'total':null};
    });
    await expect(f.adapter.executeTurn(request({workspace_path:f.root}),gate(),()=>{})).rejects.toMatchObject({code:mode==='unknown'?'EXECUTION_UNKNOWN':mode==='capture'?'EVIDENCE_CAPTURE_FAILED':'PROVIDER_PROTOCOL_ERROR'});
  });
});

describe("Explicit errors override historical idle projections", () => {
  it("classifies a top-level error without using the stale projection error", () => {
    expect(classifyZcodeError({error:{code:"1308"},projection:{status:"idle",lastError:{code:"1302"}}})).toMatchObject({errorCode:"QUOTA_EXHAUSTED",vendorCode:1308});
  });
  it("surfaces an explicit top-level failure accompanying idle on the CLI", async () => {
    const f=fixture();
    writeFileSync(f.bundle,'process.stdout.write(JSON.stringify({sessionId:"sess_native",response:"",error:{code:"1308"},projection:{status:"idle"}})+"\\n");process.exitCode=1;');
    await expect(f.adapter.executeTurn(request({workspace_path:f.root}),gate(),()=>{})).rejects.toMatchObject({code:"QUOTA_EXHAUSTED",details:{vendor_code:1308}});
  });
});
