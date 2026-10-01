/**
 * Bounded native readiness observations + durable provider binding (§13.2/§13.3).
 *
 * Fake metadata CLIs ONLY — installed vendor binaries are never launched, no
 * inference, no credentials, no /model, no settings/history reads. Covered:
 * - cursor pinned probes (--version/--list-models/status): observed version +
 *   catalog + CLI-owned auth, exact catalog validation, wrong/missing binary,
 *   probe argv scope, secret env never inherited, exact-fingerprint cache,
 * - conservative before-gate owned chat-store path budget (AB_STATE_DIR hint),
 * - antigravity pinned `agy models` probe: observed effort-suffixed catalog,
 *   exact route validation, no invented version/status probes,
 * - zcode config-catalog observation with ZERO subprocess (never /model):
 *   bundle metadata version, null unknowns, cache invalidation on config
 *   fingerprint change,
 * - core: observation bound durably into the provision intent, observed
 *   cli_version persisted truthfully, account/quota/readiness drift refused
 *   before acceptance with zero resources, idempotent replay bypasses
 *   readiness, unknown stays null, failed-first-turn continuation is the
 *   requested route (not ref presence).
 */
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURSOR_CHAT_STORE_PATH_BUDGET,
  CursorAdapter,
  cursorChatStorePathBudgetViolation,
} from "../../src/providers/cursor/cursorAdapter.ts";
import { AntigravityAdapter } from "../../src/providers/antigravity/antigravityAdapter.ts";
import { ZcodeAdapter } from "../../src/providers/zcode/zcodeAdapter.ts";
import { ZCODE_ACCOUNT_PROVIDER } from "../../src/providers/zcode/nativeConfig.ts";
import {
  ALLOWED_METADATA_PROBE_TOKENS,
  assertProbeArgvSafe,
  fingerprintBinaryTarget,
  hashFileBounded,
  readReadinessObservation,
  runMetadataProbe,
  isProviderReadinessObservation,
  ReadinessObservationCache,
  resolveBinaryPath,
  type ProviderReadinessObservation,
} from "../../src/providers/common/readiness.ts";
import { insertAccount } from "../../src/storage/repo.ts";
import { BrokerError } from "../../src/shared/errors.ts";
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../src/runtime/adapter.ts";
import { createHarness, settle, start, type Harness } from "../helpers/harness.ts";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** PowerShell/POSIX shim around a CommonJS fake script (no vendor binaries). */
function shim(script: string, root: string): string {
  const scriptPath = path.join(root, "fake.cjs");
  writeFileSync(scriptPath, script);
  const binary = path.join(root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
  if (process.platform === "win32") {
    const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
    writeFileSync(binary, `& ${quote(process.execPath)} ${quote(scriptPath)} $args\nexit $LASTEXITCODE\n`);
  } else {
    writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(scriptPath)});\n`);
    chmodSync(binary, 0o755);
  }
  return binary;
}

function expectBrokerError(fn: () => unknown, code: string): BrokerError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    expect((e as BrokerError).code).toBe(code);
    return e as BrokerError;
  }
  throw new Error(`expected BrokerError ${code}, call succeeded`);
}

interface FakeInvocation { args: string[]; leaked: boolean }

function readInvocations(logFile: string): FakeInvocation[] {
  return readFileSync(logFile, "utf8").split("\n").filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeInvocation);
}

const CURSOR_CATALOG = "auto - Auto (default)\ngpt-5.3-codex - Codex 5.3\ngpt-5.6-sol-high - Sol high\ncomposer-2.5 - Composer 2.5\n";

/** Cursor fake: metadata probes + a full stream-json turn mode. */
function cursorFixture(opts: { version?: string; stateRoot?: string } = {}) {
  const root = tempRoot("broker-cursor-ready-");
  const logFile = path.join(root, "invocations.jsonl");
  const sentinel = path.join(root, "launched.txt");
  const version = opts.version ?? "2026.09.28-64d2043";
  const binary = shim(`
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, leaked: process.env.BROKER_TEST_SECRET !== undefined }) + '\\n');
if (args.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
if (args.includes('--list-models')) { console.log(${JSON.stringify(CURSOR_CATALOG)}); process.exit(0); }
if (args.includes('status')) { console.log('logged in as redacted-account'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(sentinel)}, 'started');
if (args.includes('--print')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
    const id = resume || 'cursor-native-id';
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: id, model: 'Fake Model' }));
    console.log(JSON.stringify({ type: 'result', is_error: false, session_id: id, result: JSON.stringify({ ok: true }) }));
  });
  return;
}
process.exit(3);
`, root);
  return { root, logFile, sentinel, adapter: new CursorAdapter({ binary, ...(opts.stateRoot ? { stateRoot: opts.stateRoot } : {}) }) };
}

// ─── cursor: pinned metadata probes ───────────────────────────────────────────

describe("cursor readiness probes", () => {
  it("observes version/catalog/CLI-owned auth from pinned probes and validates the exact model", () => {
    const f = cursorFixture();
    const observation = f.adapter.preflight({ model: "auto" }) as ProviderReadinessObservation;
    expect(isProviderReadinessObservation(observation)).toBe(true);
    expect(observation.provider).toBe("cursor");
    expect(observation.cli_version).toBe("2026.09.28-64d2043");
    expect(observation.model_catalog).toContain("auto");
    expect(observation.model_catalog).toContain("gpt-5.3-codex");
    expect(observation.authenticated).toBe(true);
    expect(observation.source).toBe("cli_metadata_probe");
    expect(observation.probe_argv).toEqual(["--version", "--list-models", "status"]);
    const invocations = readInvocations(f.logFile);
    expect(invocations.map((i) => i.args)).toEqual([["--version"], ["--list-models"], ["status"]]);
  });

  it("refuses models outside the observed catalog without dispatch", () => {
    const f = cursorFixture();
    expectBrokerError(() => f.adapter.preflight({ model: "made-up-model" }), "MODEL_UNAVAILABLE");
    expect(readInvocations(f.logFile).some((i) => i.args.some((a) => a === "--print"))).toBe(false);
  });

  it("maps effort to an exact catalog ID and rejects unavailable or contradictory choices", () => {
    const available = cursorFixture();
    expect(available.adapter.preflight({ model: "gpt-5.6-sol", effort: "high" })).toBeTruthy();
    const unavailable = cursorFixture();
    expectBrokerError(() => unavailable.adapter.preflight({ model: "gpt-5.6-sol", effort: "low" }), "MODEL_UNAVAILABLE");
    const contradictory = cursorFixture();
    expectBrokerError(() => contradictory.adapter.preflight({ model: "gpt-5.6-sol-xhigh", effort: "high" }), "MODEL_UNAVAILABLE");
  });

  it("refuses a missing binary with zero dispatch", () => {
    const root = tempRoot("broker-cursor-missing-");
    const adapter = new CursorAdapter({ binary: path.join(root, "absent" + (process.platform === "win32" ? ".ps1" : "")) });
    const error = expectBrokerError(() => adapter.preflight({ model: "auto" }), "PROVIDER_INCOMPATIBLE");
    expect(error.executionStarted).toBe(false);
  });

  it("refuses an observed version older than the verified layout: native upgrade + replacement/revalidation", () => {
    const f = cursorFixture({ version: "2026.09.27-0000000" });
    const error = expectBrokerError(() => f.adapter.preflight({ model: "auto" }), "PROVIDER_INCOMPATIBLE");
    expect(error.message).toMatch(/upgrade/);
    expect(error.message).toMatch(/replacement/);
  });

  it("fails closed when the observed version does not declare the verified scheme", () => {
    const f = cursorFixture({ version: "banana" });
    expectBrokerError(() => f.adapter.preflight({ model: "auto" }), "PROVIDER_INCOMPATIBLE");
  });

  it("never inherits secret env in probes and never launches the print path", () => {
    vi.stubEnv("BROKER_TEST_SECRET", "test-only-secret");
    const f = cursorFixture();
    f.adapter.preflight({ model: "auto" });
    const invocations = readInvocations(f.logFile);
    expect(invocations.length).toBeGreaterThan(0);
    expect(invocations.every((i) => i.leaked === false)).toBe(true);
    expect(existsSync(f.sentinel)).toBe(false);
  });

  it("reuses the cached observation only for the exact input fingerprint", () => {
    const f = cursorFixture();
    const first = f.adapter.preflight({ model: "auto" }) as ProviderReadinessObservation;
    const second = f.adapter.preflight({ model: "auto" }) as ProviderReadinessObservation;
    expect(second).toEqual(first); // immutable cached copy; no new metadata probe
    expect(Object.isFrozen(second)).toBe(true);
    expect(readInvocations(f.logFile)).toHaveLength(3); // no re-probe
  });
});

// ─── cursor: before-gate owned chat-store path budget ─────────────────────────

describe("cursor chat-store path budget", () => {
  it("projects fresh conversations with a 36-char native UUID plus the journal sidecar", () => {
    expect(cursorChatStorePathBudgetViolation("C:\\owned", "C:\\ws", null)).toBeNull();
    const violation = cursorChatStorePathBudgetViolation("C:\\owned", "C:\\ws", "a".repeat(36));
    expect(violation).toBeNull();
  });

  it("reports the precise violation with the shorter-AB_STATE_DIR hint over budget", () => {
    const deepConfig = path.join(tempRoot("broker-budget-"), ...Array.from({ length: 4 }, () => "owned-segment-padding-0123456789"));
    const violation = cursorChatStorePathBudgetViolation(deepConfig, "C:\\ws", null);
    expect(violation).toMatch(/AB_STATE_DIR/);
    expect(violation!).toContain(String(CURSOR_CHAT_STORE_PATH_BUDGET));
    // The exact id is what the store will use; the projection stays exact.
    const exact = cursorChatStorePathBudgetViolation(deepConfig, "C:\\ws", "b".repeat(36));
    expect(exact).toMatch(/AB_STATE_DIR/);
  });

  it("refuses the owned stateRoot turn BEFORE the dispatch gate when over budget", async () => {
    const root = tempRoot("broker-cursor-budget-");
    const stateRoot = path.join(root, ...Array.from({ length: 4 }, () => "owned-segment-padding-0123456789"));
    const f = cursorFixture({ stateRoot });
    const gate = { count: 0, acquireDispatchPermission: () => { gate.count++; }, cancellationRequested: () => null };
    const error = await f.adapter.executeTurn({
      turn_id: "t-budget", session_id: "s-budget", role: "reviewer", provider: "cursor",
      account_profile_id: "local", requested_model: "auto", requested_effort: null,
      instructions_hash: "hash", native_conversation_ref: null, task_envelope: "prompt",
      workspace_mode: "review_slot", workspace_path: root, deadline_at: Date.now() + 60000,
      clock: { now: () => Date.now() },
    }, gate, () => {}).catch((e) => e);
    expect(error).toBeInstanceOf(BrokerError);
    expect((error as BrokerError).code).toBe("PROVIDER_INCOMPATIBLE");
    expect((error as BrokerError).executionStarted).toBe(false);
    expect((error as BrokerError).message).toMatch(/AB_STATE_DIR/);
    expect(gate.count).toBe(0);
    expect(existsSync(f.sentinel)).toBe(false);
  });

  it("fits the default short owned stateRoot and dispatches normally", async () => {
    const root = tempRoot("broker-cursor-fits-");
    const f = cursorFixture({ stateRoot: path.join(root, "cursor-state") });
    const gate = { count: 0, acquireDispatchPermission: () => { gate.count++; }, cancellationRequested: () => null };
    const result = await f.adapter.executeTurn({
      turn_id: "t-fits", session_id: "s-fits", role: "reviewer", provider: "cursor",
      account_profile_id: "local", requested_model: "auto", requested_effort: null,
      instructions_hash: "hash", native_conversation_ref: null, task_envelope: "prompt",
      workspace_mode: "review_slot", workspace_path: root, deadline_at: Date.now() + 60000,
      clock: { now: () => Date.now() },
    }, gate, () => {});
    expect(gate.count).toBe(1);
    expect(result.native_outcome).toBe("completed");
    expect(existsSync(f.sentinel)).toBe(true);
  });
});

// ─── antigravity: pinned `agy models` probe ───────────────────────────────────

const AGY_CATALOG = [
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.7-flash-low\tGemini 3.7 Flash (Low)",
].join("\n");

function agyFixture() {
  const root = tempRoot("broker-agy-ready-");
  const logFile = path.join(root, "invocations.jsonl");
  const binary = shim(`
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args, leaked: process.env.BROKER_TEST_SECRET !== undefined }) + '\\n');
if (args[0] === 'models') { console.log(${JSON.stringify(AGY_CATALOG)}); process.exit(0); }
console.error('unexpected argv');
process.exit(9);
`, root);
  return { root, logFile, adapter: new AntigravityAdapter({ binary }) };
}

describe("antigravity readiness probe", () => {
  it("observes the effort-suffixed catalog via the single pinned `models` probe", () => {
    const f = agyFixture();
    const observation = f.adapter.preflight({ model: "gemini-3.8-flash", effort: "high" }) as ProviderReadinessObservation;
    expect(observation.cli_version).toBeNull(); // no verified non-inference version probe
    expect(observation.authenticated).toBeNull(); // unknown stays null
    expect(observation.model_catalog).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.7-flash-low"]);
    expect(readInvocations(f.logFile).map((i) => i.args)).toEqual([["models"]]);
  });

  it("refuses routes absent from the observed catalog, including unobserved efforts", () => {
    const f = agyFixture();
    expectBrokerError(() => f.adapter.preflight({ model: "gemini-3.8-flash", effort: "max" }), "MODEL_UNAVAILABLE");
    expectBrokerError(() => f.adapter.preflight({ model: "gemini-3.8-flash", effort: null }), "MODEL_UNAVAILABLE");
    expectBrokerError(() => f.adapter.preflight({ model: "unknown-model", effort: "high" }), "MODEL_UNAVAILABLE");
  });

  it("refuses a missing binary as PROVIDER_INCOMPATIBLE with zero dispatch", () => {
    const root = tempRoot("broker-agy-missing-");
    const adapter = new AntigravityAdapter({ binary: path.join(root, "absent" + (process.platform === "win32" ? ".ps1" : "")) });
    expectBrokerError(() => adapter.preflight({ model: "gemini-3.8-flash", effort: "high" }), "PROVIDER_INCOMPATIBLE");
  });

  it("never inherits secret env in the probe", () => {
    vi.stubEnv("BROKER_TEST_SECRET", "test-only-secret");
    const f = agyFixture();
    f.adapter.preflight({ model: "gemini-3.8-flash", effort: "high" });
    expect(readInvocations(f.logFile).every((i) => i.leaked === false)).toBe(true);
  });
});

// ─── zcode: config-catalog observation, ZERO subprocess ───────────────────────

function zcodeFixture() {
  const root = tempRoot("broker-zcode-ready-");
  const bundle = path.join(root, "zcode.cjs");
  const builtin = path.join(root, "zcode-builtin.json");
  writeFileSync(builtin, JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [
      { providerId: ZCODE_ACCOUNT_PROVIDER, config: { builtinModelIds: ["GLM-5.3", "GLM-5.3-Flash"], access: { type: "zhipu-account", mode: "individual-coding-plan", accountType: "zai" } } },
    ] },
    modelConfigRules: { builtinProviderModelRules: [] },
  } }));
  writeFileSync(bundle, "/* installed bundle bytes (never executed by readiness) */");
  const adapter = new ZcodeAdapter({ bundlePath: bundle, builtinProviderConfigPath: builtin, nodeBinary: process.execPath });
  return { root, bundle, builtin, adapter };
}

describe("zcode config-catalog readiness", () => {
  it("observes the installed catalog with no metadata subprocess and null unknowns", () => {
    const f = zcodeFixture();
    const observation = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "max" }) as ProviderReadinessObservation;
    expect(observation.source).toBe("config_catalog");
    expect(observation.probe_argv).toBeNull();
    expect(observation.model_catalog).toEqual([`${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3`, `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`]);
    expect(observation.cli_version).toBeNull(); // unknown without bundle metadata
    expect(observation.authenticated).toBeNull(); // never inferred from auth_mode
  });

  it("reads the version from adjacent bundle metadata only when present", () => {
    const f = zcodeFixture();
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "zcode", version: "0.16.9" }));
    const observation = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }) as ProviderReadinessObservation;
    expect(observation.cli_version).toBeNull(); // no verified CLI version channel
  });

  it("leaves cli_version null when adjacent package.json lacks verified CLI package identity", () => {
    const f = zcodeFixture();
    writeFileSync(path.join(f.root, "package.json"), JSON.stringify({ name: "unrelated-app", version: "1.2.3" }));
    const observation = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }) as ProviderReadinessObservation;
    expect(observation.cli_version).toBeNull();
  });

  it("refuses catalog-invalid selections with zero side effects", () => {
    const f = zcodeFixture();
    const before = readFileSync(f.builtin, "utf8");
    expectBrokerError(() => f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-4-air`, effort: "low" }), "MODEL_UNAVAILABLE");
    expectBrokerError(() => f.adapter.preflight({ model: "account:unknown/GLM-5.3", effort: "low" }), "MODEL_UNAVAILABLE");
    expect(readFileSync(f.builtin, "utf8")).toBe(before);
  });

  it("invalidates the cached observation when the installed config fingerprint changes", () => {
    const f = zcodeFixture();
    const first = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }) as ProviderReadinessObservation;
    const config = JSON.parse(readFileSync(f.builtin, "utf8"));
    config.config.providerConfigRules.providerRules[0].config.builtinModelIds.push("GLM-5.2");
    writeFileSync(f.builtin, JSON.stringify(config));
    const second = f.adapter.preflight({ model: `${ZCODE_ACCOUNT_PROVIDER}/GLM-5.3-Flash`, effort: "low" }) as ProviderReadinessObservation;
    expect(second.input_fingerprint).not.toBe(first.input_fingerprint);
    expect(second.model_catalog).toContain(`${ZCODE_ACCOUNT_PROVIDER}/GLM-5.2`);
  });
});

// ─── pinned metadata probe allowlist & bounded validator ─────────────────────

describe("pinned metadata probe allowlist", () => {
  it("allows verified metadata flags and subcommands only", () => {
    expect(() => assertProbeArgvSafe(["--version"])).not.toThrow();
    expect(() => assertProbeArgvSafe(["--list-models"])).not.toThrow();
    expect(() => assertProbeArgvSafe(["status"])).not.toThrow();
    expect(() => assertProbeArgvSafe(["models"])).not.toThrow();
    expect(() => assertProbeArgvSafe(["--version", "--list-models", "status"])).toThrow(/length/);
  });

  it("strictly rejects login, prompt, or arbitrary commands", () => {
    expect(() => assertProbeArgvSafe(["--login"])).toThrow(/rejected/);
    expect(() => assertProbeArgvSafe(["login"])).toThrow(/rejected/);
    expect(() => assertProbeArgvSafe(["prompt"])).toThrow(/rejected/);
    expect(() => assertProbeArgvSafe(["--prompt"])).toThrow(/rejected/);
    expect(() => assertProbeArgvSafe([])).toThrow(/length/);
    expect(() => assertProbeArgvSafe(["--version", "cat /etc/passwd"])).toThrow(/rejected/);
  });
});

describe("bounded observation validator and future timestamps", () => {
  it("rejects future timestamps and unverified probe tokens", () => {
    const base: ProviderReadinessObservation = {
      provider: "cursor",
      cli_version: "2026.09.28",
      model_catalog: ["auto"],
      authenticated: true,
      input_fingerprint: "a".repeat(64),
      observed_at: Date.now() + 120_000, // future timestamp
      source: "cli_metadata_probe",
      probe_argv: ["--version"],
    };
    expect(isProviderReadinessObservation(base)).toBe(false);

    const withBadArgv: ProviderReadinessObservation = {
      ...base,
      observed_at: Date.now(),
      probe_argv: ["--login"],
    };
    expect(isProviderReadinessObservation(withBadArgv)).toBe(false);

    const valid: ProviderReadinessObservation = {
      ...base,
      observed_at: Date.now(),
      probe_argv: ["--version"],
    };
    expect(isProviderReadinessObservation(valid)).toBe(true);

    const cache = new ReadinessObservationCache();
    expect(() => cache.put(base.input_fingerprint, base)).toThrow();
    expect(cache.get(base.input_fingerprint, Date.now())).toBeNull(); // future timestamp fails closed
  });
});

// ─── core: durable binding, drift refusal, replay, continuation ────────────────

function observation(overrides: Partial<ProviderReadinessObservation> = {}): ProviderReadinessObservation {
  return {
    provider: "mock",
    cli_version: "1.2.3",
    model_catalog: ["mock-model-1"],
    authenticated: true,
    input_fingerprint: "a".repeat(64),
    observed_at: 1,
    source: "cli_metadata_probe",
    probe_argv: ["--version"],
    ...overrides,
  };
}

/** Harness mock wrapper returning a readiness observation from preflight. */
class ReadinessSpyAdapter implements ProviderAdapter {
  readonly preflightCalls: Array<Record<string, unknown>> = [];
  observation: ProviderReadinessObservation | null;
  preflightError: unknown = null;

  constructor(private readonly inner: ProviderAdapter, observationValue: ProviderReadinessObservation | null = null) {
    this.observation = observationValue;
  }

  get providerId(): string { return this.inner.providerId; }
  get adapterVersion(): string { return this.inner.adapterVersion; }

  preflight(config: Record<string, unknown>): ProviderReadinessObservation | void {
    this.preflightCalls.push(config);
    if (this.preflightError !== null) throw this.preflightError;
    return this.observation ?? undefined;
  }

  executeTurn(req: TurnExecutionRequest, gate: DispatchGate, onEvent: (ev: AdapterEvent) => void): Promise<TurnExecutionResult> {
    return this.inner.executeTurn(req, gate, onEvent);
  }
  shutdownIdleRuntime(sessionId: string): Promise<void> { return this.inner.shutdownIdleRuntime(sessionId); }
  inspectRuntime(sessionId: string): RuntimeObservation | null { return this.inner.inspectRuntime(sessionId); }
  interruptTurn(turnId: string): Promise<boolean> { return this.inner.interruptTurn(turnId); }
}

function installSpy(h: Harness, observationValue: ProviderReadinessObservation | null = null): ReadinessSpyAdapter {
  const spy = new ReadinessSpyAdapter(h.adapter, observationValue);
  h.core.adapters.set("mock", spy);
  return spy;
}

function provisionBinding(h: Harness, sessionId: string): Record<string, unknown> | undefined {
  const row = h.db.raw
    .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=?")
    .get(sessionId) as { payload: string };
  return (JSON.parse(row.payload) as Record<string, unknown>).provider_binding as Record<string, unknown> | undefined;
}

function brokerCounts(h: Harness): { sessions: number; turns: number; idempotency: number } {
  const one = (sql: string): number => (h.db.raw.prepare(sql).get() as { c: number }).c;
  return {
    sessions: one("SELECT COUNT(*) c FROM sessions"),
    turns: one("SELECT COUNT(*) c FROM turns"),
    idempotency: one("SELECT COUNT(*) c FROM idempotency_records"),
  };
}

/** core.send is synchronous: capture its BrokerError refusal directly. */
function sendError(h: Harness, sessionId: string, key: string): BrokerError {
  try {
    h.sendTask(sessionId, key);
  } catch (e) {
    expect(e).toBeInstanceOf(BrokerError);
    return e as BrokerError;
  }
  throw new Error("expected send to refuse");
}

describe("core durable provider binding", () => {
  it("seals the observed readiness + registered account tuple into the provision intent and persists observed cli_version truthfully", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h, observation());
      const spawn = await h.spawnWorkerSession();
      const binding = provisionBinding(h, spawn.session_id);
      expect(binding).toBeDefined();
      expect(binding!.binding_version).toBe(1);
      expect(binding!.account).toEqual({
        account_profile_id: h.seed.accountMock1,
        provider: "mock",
        auth_mode: "native",
        quota_scope_id: "qs-shared",
      });
      expect(binding!.adapter_version).toBe("0.1.0");
      expect(binding!.cli_version).toBe("1.2.3");
      const readiness = binding!.readiness as Record<string, unknown>;
      expect(readiness.source).toBe("cli_metadata_probe");
      expect(readiness.authenticated).toBe(true);
      expect(typeof readiness.fingerprint).toBe("string");

      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.cli_version).toBe("1.2.3"); // observed, not fabricated
      expect(session.effective_model).toBeNull(); // never a request echo

      const bindingStatus = h.core.sessionProviderBinding(h.seed.coordinatorId, spawn.session_id);
      expect(bindingStatus.account).toEqual(binding!.account);
      expect(bindingStatus.authenticated).toBe(true);
      expect(bindingStatus.readiness_source).toBe("cli_metadata_probe");
      expect(spy.preflightCalls).toHaveLength(1); // spawn only
    } finally {
      h.cleanup();
    }
  });

  it("keeps unknown readiness null (void-compatible adapters) and still sends", async () => {
    const h = createHarness();
    try {
      installSpy(h, null);
      const spawn = await h.spawnWorkerSession();
      const binding = provisionBinding(h, spawn.session_id);
      expect(binding!.readiness).toBeNull(); // no observed readiness for void-compatible adapters
      expect(binding!.cli_version).toBeNull();
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.cli_version).toBeNull();
      const bindingStatus = h.core.sessionProviderBinding(h.seed.coordinatorId, spawn.session_id);
      expect(bindingStatus.authenticated).toBeNull(); // unknown — never false
      expect(bindingStatus.readiness_fingerprint).toBeNull();

      const sent = h.sendTask(spawn.session_id, "void-send");
      h.adapter.plan(sent.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, sent);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, sent.turn_id).state).toBe("SUCCEEDED");
    } finally {
      h.cleanup();
    }
  });

  it("refuses a turn when the live account row drifts from the durable tuple (quota alias or auth mode): zero accepted resources", async () => {
    const h = createHarness();
    try {
      installSpy(h, observation());
      const spawn = await h.spawnWorkerSession();
      const before = brokerCounts(h);

      h.db.raw.prepare("UPDATE account_profiles SET quota_scope_id='qs-drifted' WHERE account_profile_id=?").run(h.seed.accountMock1);
      const quotaError = sendError(h, spawn.session_id, "drift-quota");
      expect(quotaError.executionStarted).toBe(false);
      expect(brokerCounts(h)).toEqual(before);

      // Key freed as a mutable rejection; restored binding admits the retry.
      h.db.raw.prepare("UPDATE account_profiles SET quota_scope_id='qs-shared' WHERE account_profile_id=?").run(h.seed.accountMock1);
      h.db.raw.prepare("UPDATE account_profiles SET auth_mode='api-key' WHERE account_profile_id=?").run(h.seed.accountMock1);
      const authError = sendError(h, spawn.session_id, "drift-auth");
      expect(authError.code).toBe("PROVIDER_INCOMPATIBLE");
      expect(brokerCounts(h)).toEqual(before);

      h.db.raw.prepare("UPDATE account_profiles SET auth_mode='native' WHERE account_profile_id=?").run(h.seed.accountMock1);
      const sent = h.sendTask(spawn.session_id, "drift-quota"); // same freed key
      expect(sent.state).toBe("ACCEPTED");
    } finally {
      h.cleanup();
    }
  });

  it("refuses a turn when observed readiness drifts from the durable fingerprint — before acceptance", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h, observation());
      const spawn = await h.spawnWorkerSession();
      const before = brokerCounts(h);
      spy.observation = observation({ cli_version: "9.9.9", input_fingerprint: "b".repeat(64) });
      const error = sendError(h, spawn.session_id, "readiness-drift");
      expect(error.code).toBe("PROVIDER_INCOMPATIBLE");
      expect(error.message).toMatch(/replacement session/);
      expect(brokerCounts(h)).toEqual(before); // zero accepted resources
    } finally {
      h.cleanup();
    }
  });

  it("accepted same-key send replay bypasses readiness entirely", async () => {
    const h = createHarness();
    try {
      const spy = installSpy(h, observation());
      const spawn = await h.spawnWorkerSession();
      const sent = h.sendTask(spawn.session_id, "replay-readiness");
      const callsAfterAccept = spy.preflightCalls.length;
      spy.preflightError = new BrokerError("AUTH_REQUIRED", "cli vanished after acceptance");
      const replay = h.sendTask(spawn.session_id, "replay-readiness");
      expect(replay.replayed_request).toBe(true);
      expect(replay.turn_id).toBe(sent.turn_id);
      expect(spy.preflightCalls.length).toBe(callsAfterAccept);
    } finally {
      h.cleanup();
    }
  });

  it("a failed FIRST turn keeps its requested new-conversation continuation even after a native ref was observed", async () => {
    const h = createHarness();
    try {
      installSpy(h, null);
      const spawn = await h.spawnWorkerSession();
      const sent = h.sendTask(spawn.session_id, "failed-first");
      h.adapter.plan(sent.turn_id, [
        { kind: "report_native_ref", ref: "native-ctx-1" },
        { kind: "complete", outcome: "failed", summary: "native crashed" },
      ]);
      await start(h, sent);
      await settle(h);
      const failed = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(failed.state).toBe("FAILED");
      expect(failed.native_conversation_ref).toBe("native-ctx-1"); // observed context, retained
      // The turn REQUESTED a fresh conversation; ref presence alone must not
      // relabel it as native_resume.
      expect(failed.continuation).toBe("new_native_conversation");
      const session = h.core.sessionStatus(h.seed.coordinatorId, spawn.session_id);
      expect(session.native_conversation_ref).toBe("native-ctx-1");

      // The next turn explicitly resumes the observed context.
      const second = h.sendTask(spawn.session_id, "resume-second");
      h.adapter.plan(second.turn_id, [{ kind: "complete", outcome: "completed" }]);
      await start(h, second);
      await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId, second.turn_id).continuation).toBe("native_resume");
    } finally {
      h.cleanup();
    }
  });

  it("refuses native legacy sessions without bound tuple before admission: replacement required", async () => {
    const f = cursorFixture();
    const h = createHarness();
    try {
      h.core.adapters.set("cursor", f.adapter);
      insertAccount(h.db, {
        account_profile_id: "acct-cursor-legacy",
        provider: "cursor",
        quota_scope_id: "qs-shared",
        auth_mode: "native",
      });
      const spawn = await h.spawnWorkerSession({ provider: "cursor", model: "auto", account_profile_id: "acct-cursor-legacy" });
      // Delete the provision intent so it is unbound (legacy session)
      h.db.raw.prepare("DELETE FROM intents WHERE kind='provision_session' AND session_id=?").run(spawn.session_id);

      const err = sendError(h, spawn.session_id, "legacy-send");
      expect(err.code).toBe("PROVIDER_INCOMPATIBLE");
      expect(err.message).toMatch(/Native legacy session lacks durable provider binding/);
    } finally {
      h.cleanup();
    }
  });

  it("PATH retarget invalidates cached readiness and refuses durable session", async () => {
    const fA = cursorFixture();
    const fB = cursorFixture();

    const h = createHarness();
    try {
      h.core.adapters.set("cursor", fA.adapter);
      insertAccount(h.db, {
        account_profile_id: "acct-cursor-path",
        provider: "cursor",
        quota_scope_id: "qs-shared",
        auth_mode: "native",
      });
      const spawn = await h.spawnWorkerSession({ provider: "cursor", model: "auto", account_profile_id: "acct-cursor-path" });
      const binding = provisionBinding(h, spawn.session_id);
      expect(binding).toBeDefined();

      // Now swap adapter to the retargeted binary location
      h.core.adapters.set("cursor", fB.adapter);
      const err = sendError(h, spawn.session_id, "path-drift-send");
      expect(err.code).toBe("PROVIDER_INCOMPATIBLE");
      expect(err.message).toMatch(/Observed provider readiness drifted from the session's durable binding/);
    } finally {
      h.cleanup();
    }
  });

  it("detects same-path binary mutation between admission and dispatch: zero native launch", async () => {
    const root = tempRoot("broker-mutate-dispatch-");
    const logFile = path.join(root, "invocations.jsonl");
    const sentinel = path.join(root, "sentinel.txt");
    const scriptPath = path.join(root, "fake.cjs");
    writeFileSync(scriptPath, `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) { console.log('2026.09.28-64d2043'); process.exit(0); }
if (args.includes('--list-models')) { console.log(${JSON.stringify(CURSOR_CATALOG)}); process.exit(0); }
if (args.includes('status')) { console.log('logged in as redacted-account'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(sentinel)}, 'started');
if (args.includes('--print')) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'c-id', model: 'Auto' }));
  console.log(JSON.stringify({ type: 'result', is_error: false, session_id: 'c-id', result: JSON.stringify({ ok: true }) }));
  process.exit(0);
}
process.exit(0);
`);
    const binary = path.join(root, process.platform === "win32" ? "fake.ps1" : "fake-cli");
    if (process.platform === "win32") {
      const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
      writeFileSync(binary, `& ${quote(process.execPath)} ${quote(scriptPath)} $args\nexit $LASTEXITCODE\n`);
    } else {
      writeFileSync(binary, `#!${process.execPath}\nimport(${JSON.stringify(scriptPath)});\n`);
      chmodSync(binary, 0o755);
    }
    const adapter = new CursorAdapter({ binary });
    const h = createHarness();
    try {
      h.core.adapters.set("cursor", adapter);
      insertAccount(h.db, {
        account_profile_id: "acct-cursor-mutate",
        provider: "cursor",
        quota_scope_id: "qs-shared",
        auth_mode: "native",
      });
      const spawn = await h.spawnWorkerSession({ provider: "cursor", model: "auto", account_profile_id: "acct-cursor-mutate" });
      const sent = h.sendTask(spawn.session_id, "mutate-send");
      expect(sent.state).toBe("ACCEPTED");

      // Mutate binary on disk before dispatch
      writeFileSync(scriptPath, `
// mutated script
console.log('mutated');
process.exit(1);
`);

      // Dispatch the accepted turn
      await start(h, sent);
      await settle(h);

      const turn = h.core.turnStatus(h.seed.coordinatorId, sent.turn_id);
      expect(turn.state).toBe("FAILED");
      expect(turn.execution_started).toBe(false);
      expect(existsSync(sentinel)).toBe(false); // zero native launch
    } finally {
      h.cleanup();
    }
  });
});


describe("primary readiness regression checks", () => {
  it("hashes complete bytes beyond the former 16MiB prefix and refuses oversized files", () => {
    const root=tempRoot("broker-complete-program-");
    const file=path.join(root,"program.bin");
    const bytes=Buffer.alloc(16*1024*1024+32,17);
    writeFileSync(file,bytes);
    const first=hashFileBounded(file);
    expect(first).toBe(createHash("sha256").update(bytes).digest("hex"));
    bytes[bytes.length-1]=18;
    writeFileSync(file,bytes);
    expect(hashFileBounded(file)).not.toBe(first);
    expect(()=>hashFileBounded(file,16*1024*1024)).toThrow(/bound/);
  });
  it("binds known Cursor wrapper selected index and interpreter bytes, including version selection", () => {
    if(process.platform!=="win32") return;
    const root=tempRoot("broker-cursor-program-");
    const wrapper=path.join(root,"cursor-agent.ps1");
    writeFileSync(wrapper,'function Parse-VersionString {}\n$versionDir = Get-ChildItem -Path "$scriptPath\\versions" -Directory\n& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args\n');
    const version=path.join(root,"versions","2026.09.28-deadbeef");
    mkdirSync(version,{recursive:true});
    writeFileSync(path.join(version,"node.exe"),"node-program");
    writeFileSync(path.join(version,"index.js"),"index-one");
    const first=fingerprintBinaryTarget(wrapper);
    expect(first.runtime_target?.canonical_path).toContain("index.js");
    expect(first.interpreter_identity?.canonical_path).toContain("node.exe");
    expect(first.shell_file_bytes_sha256).toMatch(/^[0-9a-f]{64}$/);
    writeFileSync(path.join(version,"index.js"),"index-two");
    expect(fingerprintBinaryTarget(wrapper).runtime_target?.file_bytes_sha256).not.toBe(first.runtime_target?.file_bytes_sha256);
    const sameDate=path.join(root,"versions","2026.09.28-cafebabe");
    mkdirSync(sameDate);
    expect(()=>fingerprintBinaryTarget(wrapper)).toThrow(/ambiguous/);
  });
  it("malformed, foreign and missing native observations cannot bypass binding", () => {
    expect(()=>readReadinessObservation({},"mock")).toThrow(/invalid/);
    expect(()=>readReadinessObservation(observation(),"cursor")).toThrow(/invalid/);
    expect(()=>readReadinessObservation(undefined,"cursor")).toThrow(/no readiness/);
    expect(readReadinessObservation(undefined,"mock")).toBeNull();
    const h=createHarness();
    try {
      const spy=installSpy(h,observation());
      spy.observation={} as ProviderReadinessObservation;
      const before=brokerCounts(h);
      expect(()=>h.core.spawn(h.seed.coordinatorId,{project_id:h.seed.projectId,idempotency_key:"bad-obs",provider:"mock",account_profile_id:h.seed.accountMock1,model:"mock-model-1",role:"worker",instructions:"test",workspace:{mode:"current",workspace_id:h.seed.workspaceMain},policy_profile_id:"pol-writer"})).toThrow(/invalid readiness/);
      expect(brokerCounts(h)).toEqual(before);
    } finally {h.cleanup();}
  });
  it("metadata limits must be finite and positive before any subprocess", () => {
    for(const override of [{timeoutMs:Infinity},{timeoutMs:0},{maxOutputChars:NaN},{maxOutputChars:-1}]) {
      expect(()=>runMetadataProbe({binary:"never-started",argv:["--version"],cwd:process.cwd(),envAllowlist:[],...override})).toThrow(/bounds/);
    }
  });
  it("refuses registered account drift after admission before dispatch", async () => {
    const h=createHarness();
    try {
      installSpy(h,observation());
      const spawn=await h.spawnWorkerSession();
      const sent=h.sendTask(spawn.session_id,"post-admission-account");
      h.db.raw.prepare("UPDATE account_profiles SET auth_mode='changed' WHERE account_profile_id=?").run(h.seed.accountMock1);
      await start(h,sent);await settle(h);
      expect(h.core.turnStatus(h.seed.coordinatorId,sent.turn_id).state).toBe("FAILED");
      expect(h.core.turnStatus(h.seed.coordinatorId,sent.turn_id).execution_started).toBe(false);
      expect(h.adapter.dispatchPermissionAcquired(sent.turn_id)).toBe(false);
    } finally {h.cleanup();}
  });
  it("persisted null quota binding refuses live non-null scope without reinterpretation", async () => {
    const h=createHarness();
    try {
      installSpy(h,observation());
      const spawn=await h.spawnWorkerSession();
      // Historical/corrupt persisted null must not be filled from the live row.
      const row=h.db.raw.prepare("SELECT intent_id,payload FROM intents WHERE kind='provision_session' AND session_id=?").get(spawn.session_id) as {intent_id:string;payload:string};
      const payload=JSON.parse(row.payload);
      payload.provider_binding.account.quota_scope_id=null;
      h.db.raw.prepare("UPDATE intents SET payload=? WHERE intent_id=?").run(JSON.stringify(payload),row.intent_id);
      const counts=brokerCounts(h);
      expect(sendError(h,spawn.session_id,"null-retarget").code).toBe("PROVIDER_INCOMPATIBLE");
      expect(brokerCounts(h)).toEqual(counts);
    } finally {h.cleanup();}
  });
});


it("corrupt persisted binding metadata refuses instead of fabricating version or freshness", async () => {
  const h=createHarness();
  try {
    installSpy(h,observation());
    const spawn=await h.spawnWorkerSession();
    const row=h.db.raw.prepare("SELECT intent_id,payload FROM intents WHERE kind='provision_session' AND session_id=?").get(spawn.session_id) as {intent_id:string;payload:string};
    for (const change of [{binding_version:2},{adapter_version:null},{readiness:{}},{readiness:undefined}]) {
      const payload=JSON.parse(row.payload);
      Object.assign(payload.provider_binding,change);
      h.db.raw.prepare("UPDATE intents SET payload=? WHERE intent_id=?").run(JSON.stringify(payload),row.intent_id);
      expect(sendError(h,spawn.session_id,"corrupt-"+JSON.stringify(change)).code).toBe("POLICY_UNSUPPORTED");
    }
  } finally {h.cleanup();}
});
