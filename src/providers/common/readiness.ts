/**
 * Bounded native readiness observations shared by provider adapters (§13.2).
 *
 * An observation records what the vendor's OWN non-inference metadata channel
 * actually showed (CLI version, model catalog, CLI-owned auth status), never
 * what was requested or configured. Unknown stays null — never false, never
 * fabricated from request echo.
 *
 * Metadata probes are pinned explicit argv (no shell interpolation, no prompt,
 * no login/logout, no inference), run in a scrubbed environment with bounded
 * output and timeouts. Authoritative broker transactions never run them.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { BrokerError } from "../../shared/errors.ts";
import { classifyWindowsTarget, prepareCommand, resolveWindowsBinary } from "./headless.ts";

/** Which channel produced an observation. "config_catalog" runs no subprocess. */
export type ReadinessSource = "cli_metadata_probe" | "config_catalog";

export interface ProviderReadinessObservation {
  provider: string;
  /** Version OBSERVED from the vendor; null = unknown (never requested echo). */
  cli_version: string | null;
  /** Catalog ids OBSERVED from the vendor's own metadata channel; null = unavailable. */
  model_catalog: readonly string[] | null;
  /** CLI-owned auth status; null = unknown — distinguished from false. */
  authenticated: boolean | null;
  /**
   * sha256 over the exact observed inputs (probe identity / config+bundle
   * bytes). Caching and drift detection key on this exact fingerprint.
   */
  input_fingerprint: string;
  /** Explicit freshness (epoch ms of the observation). */
  observed_at: number;
  source: ReadinessSource;
  /** The exact pinned metadata argv that ran; null for config-only sources. */
  probe_argv: readonly string[] | null;
}

/** Pinned metadata argv allowlist: supported metadata commands only (§13.2). */
export const ALLOWED_METADATA_PROBE_TOKENS: ReadonlySet<string> = new Set([
  "--version",
  "--list-models",
  "status",
  "models",
]);

/** Probe argv tokens must exact allowlist supported commands (never prompt or login). */
export function assertProbeArgvSafe(argv: readonly string[]): void {
  if (argv.length !== 1) {
    throw new Error("metadata probe argv rejected: length invalid");
  }
  for (const token of argv) {
    if (!ALLOWED_METADATA_PROBE_TOKENS.has(token)) {
      throw new Error(`metadata probe argv rejected: ${JSON.stringify(token.slice(0, 32))}`);
    }
  }
}

/** Defensive shape guard; callers reject malformed non-void observations. */
export function isProviderReadinessObservation(value: unknown): value is ProviderReadinessObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<ProviderReadinessObservation>;
  if (typeof v.provider !== "string" || v.provider.length === 0 || v.provider.length > 64) return false;
  if (v.cli_version !== null && (typeof v.cli_version !== "string" || v.cli_version.length > 128)) return false;
  if (v.model_catalog !== null && (!Array.isArray(v.model_catalog) || v.model_catalog.some((m) => typeof m !== "string" || m.length === 0 || m.length > 256) || v.model_catalog.length > 4096)) return false;
  if (v.authenticated !== null && typeof v.authenticated !== "boolean") return false;
  if (typeof v.input_fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.input_fingerprint)) return false;
  if (typeof v.observed_at !== "number" || !Number.isSafeInteger(v.observed_at) || v.observed_at < 0) return false;
  // Future timestamps fail closed (bounded by 60s clock skew)
  if (v.observed_at > Date.now() + 60_000) return false;
  if (v.source !== "cli_metadata_probe" && v.source !== "config_catalog") return false;
  if (v.probe_argv !== null) {
    if (!Array.isArray(v.probe_argv) || v.probe_argv.length > 8) return false;
    for (const a of v.probe_argv) {
      if (typeof a !== "string" || !ALLOWED_METADATA_PROBE_TOKENS.has(a)) return false;
    }
  }
  return true;
}

/** Pure comparable fingerprint over the observation's observed content. */
export function fingerprintReadinessObservation(observation: ProviderReadinessObservation): string {
  return sha256Canonical({
    provider: observation.provider,
    cli_version: observation.cli_version,
    model_catalog: observation.model_catalog,
    authenticated: observation.authenticated,
    input_fingerprint: observation.input_fingerprint,
  });
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

// ─── binary resolution and file fingerprinting ────────────────────────────────

export const MAX_FINGERPRINT_STREAM_BYTES = 512 * 1024 * 1024; // full regular program files, at most 512 MiB

/** Hash COMPLETE regular program bytes with fixed memory and an explicit size bound. */
export function hashFileBounded(filePath: string, maxBytes = MAX_FINGERPRINT_STREAM_BYTES): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_FINGERPRINT_STREAM_BYTES) throw new Error("Invalid program hash bound");
  const fd = openSync(filePath, "r");
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Program file exceeds complete fingerprint bound", {executionStarted:false});
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let totalRead = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalRead += bytesRead;
      if (totalRead > maxBytes) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Program grew beyond fingerprint bound", {executionStarted:false});
      hash.update(buffer.subarray(0,bytesRead));
    }
    const after = fstatSync(fd);
    if (totalRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Program changed during fingerprint capture", {executionStarted:false});
    return hash.digest("hex");
  } finally {closeSync(fd);}
}

/** Undefined is the compatibility return; malformed or foreign evidence refuses. */
export function readReadinessObservation(value: unknown, provider: string): ProviderReadinessObservation | null {
  if (value === undefined) {
    if (["cursor","antigravity","zcode"].includes(provider)) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Native adapter provided no readiness observation", {executionStarted:false});
    return null;
  }
  if (!isProviderReadinessObservation(value) || value.provider !== provider) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Adapter returned invalid readiness observation", {executionStarted:false});
  return value;
}

/** Resolve binary to canonical path across PATH/PATHEXT, resolving symlinks/junctions. */
export function resolveBinaryPath(binary: string, customPath?: string): string | null {
  if (process.platform === "win32" && customPath === undefined) {
    const launched = resolveWindowsBinary(binary);
    if (!path.isAbsolute(launched)) return null;
    try { return realpathSync(launched); } catch { return null; }
  }
  if (path.isAbsolute(binary)) {
    if (existsSync(binary)) {
      try {
        return realpathSync(binary);
      } catch {
        return path.resolve(binary);
      }
    }
    return null;
  }
  if (binary.includes("/") || binary.includes("\\")) {
    const resolved = path.resolve(binary);
    if (existsSync(resolved)) {
      try {
        return realpathSync(resolved);
      } catch {
        return resolved;
      }
    }
    return null;
  }
  const envPath =
    customPath ??
    (process.platform === "win32"
      ? (process.env.PATH ?? process.env.Path ?? "")
      : (process.env.PATH ?? ""));
  const pathExt =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean)
      : [""];
  const dirs = envPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    if (existsSync(candidate)) {
      try {
        return realpathSync(candidate);
      } catch {
        return path.resolve(candidate);
      }
    }
    if (process.platform === "win32" && !path.extname(binary)) {
      for (const ext of pathExt) {
        const withExt = candidate + ext;
        if (existsSync(withExt)) {
          try {
            return realpathSync(withExt);
          } catch {
            return path.resolve(withExt);
          }
        }
      }
    }
  }
  if (process.platform === "win32") {
    const whereResolved = resolveWindowsBinary(binary);
    if (whereResolved !== binary && existsSync(whereResolved)) {
      try {
        return realpathSync(whereResolved);
      } catch {
        return path.resolve(whereResolved);
      }
    }
  }
  return null;
}

export interface LaunchedBinaryFingerprint {
  canonical_path: string;
  file_bytes_sha256: string;
  wrapper_kind: "direct" | "cmd-shim" | "powershell-shim" | "unsupported";
  shell_identity: string | null;
  runtime_target?: {
    canonical_path: string;
    file_bytes_sha256: string;
  } | null;
}

export function fingerprintBinaryTarget(resolvedPath: string): LaunchedBinaryFingerprint & {
  shell_file_bytes_sha256: string | null;
  interpreter_identity: {canonical_path:string;file_bytes_sha256:string} | null;
} {
  const canonical = realpathSync(resolvedPath);
  const fileHash = hashFileBounded(canonical);
  const wrapperKind = process.platform === "win32" ? classifyWindowsTarget(canonical).kind : "direct";
  let shellIdentity: string | null = null;
  let interpreter: {canonical_path:string;file_bytes_sha256:string} | null = null;
  let runtimeTarget: {canonical_path:string;file_bytes_sha256:string} | null = null;
  const identity = (filename:string) => { const resolved=realpathSync(filename);return {canonical_path:resolved,file_bytes_sha256:hashFileBounded(resolved)}; };
  if (wrapperKind === "cmd-shim") shellIdentity = resolveBinaryPath(process.env.ComSpec ?? "cmd.exe");
  if (wrapperKind === "powershell-shim") {
    const pwsh = resolveWindowsBinary("pwsh.exe");
    const root = Object.entries(process.env).find(([k]) => k.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows";
    shellIdentity = resolveBinaryPath(path.isAbsolute(pwsh) ? pwsh : path.join(root,"System32","WindowsPowerShell","v1.0","powershell.exe"));
  }
  if ((wrapperKind === "cmd-shim" || wrapperKind === "powershell-shim") && !shellIdentity) throw new BrokerError("PROVIDER_INCOMPATIBLE","Wrapper shell identity unavailable",{executionStarted:false});
  const fd=openSync(canonical,"r");
  let header:string;
  try {const buffer=Buffer.alloc(8192);const count=readSync(fd,buffer,0,buffer.length,0);header=buffer.subarray(0,count).toString("utf8").replace(/^\uFEFF/,"");} finally {closeSync(fd);}
  // Known literal two-line fixture/standalone shim, not arbitrary quoted paths.
  const literal=/^& '((?:[^']|'')+)' '((?:[^']|'')+)' \$args\r?\nexit \$LASTEXITCODE\r?\n?$/.exec(header);
  if (wrapperKind === "powershell-shim" && literal) {
    interpreter=identity(literal[1]!.replaceAll("''","'"));
    runtimeTarget=identity(literal[2]!.replaceAll("''","'"));
  } else if (wrapperKind === "powershell-shim" && path.basename(canonical).toLowerCase()==="cursor-agent.ps1" && header.includes("function Parse-VersionString") && header.includes('$versionDir = Get-ChildItem -Path "$scriptPath\\versions" -Directory') && header.includes('& "$nodePath" "$scriptPath\\versions\\$versionName\\index.js" $args')) {
    // PROGRAM wrapper 2026.09.28-64d2043 chooses local node first, otherwise
    // largest version date. Equal dates have unspecified ordering: refuse.
    let programDir=path.dirname(canonical);
    if (!existsSync(path.join(programDir,"node.exe"))) {
      const versions=path.join(programDir,"versions");
      const names=readdirSync(versions,{withFileTypes:true}).filter(e=>e.isDirectory() && /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(e.name)).map(e=>e.name);
      const date=(name:string)=>{const parts=name.split('-')[0]!.split('.');return Number(parts[0]+parts[1]!.padStart(2,'0')+parts[2]!.padStart(2,'0'));};
      names.sort((a,b)=>date(b)-date(a));
      if (!names[0] || (names[1] && date(names[0])===date(names[1]))) throw new BrokerError("PROVIDER_INCOMPATIBLE","Cursor wrapper program selection is absent or ambiguous",{executionStarted:false});
      programDir=path.join(versions,names[0]);
    }
    interpreter=identity(path.join(programDir,"node.exe"));
    runtimeTarget=identity(path.join(programDir,"index.js"));
  } else if (process.platform !== "win32" && header.startsWith("#!")) {
    const shebang=header.split(/\r?\n/)[0]!.slice(2).trim();
    // Only exact absolute interpreter with no optional arguments is resolved.
    if (path.isAbsolute(shebang) && !/\s/.test(shebang)) interpreter=identity(shebang);
  }
  return {canonical_path:canonical,file_bytes_sha256:fileHash,wrapper_kind:wrapperKind,shell_identity:shellIdentity,shell_file_bytes_sha256:shellIdentity?hashFileBounded(shellIdentity):null,interpreter_identity:interpreter,runtime_target:runtimeTarget};
}

// ─── metadata probe runner (pinned argv, scrubbed env, bounded) ───────────────

export const METADATA_PROBE_TIMEOUT_MS = 30_000;
export const METADATA_PROBE_MAX_OUTPUT_CHARS = 200_000;
export const METADATA_PROBE_MAX_BUFFER_BYTES = 512 * 1024; // 512 KiB finite maxBuffer

export interface MetadataProbeSpec {
  binary: string;
  /** Pinned explicit metadata tokens only (e.g. ["--version"], ["models"]). */
  argv: readonly string[];
  cwd: string;
  envAllowlist: readonly string[];
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface MetadataProbeResult {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  /** Bounded sanitized safe status (never raw multi-line dumps or headers). */
  detail: string;
}

/** Structural OS entries only; everything else must be explicitly allowlisted. */
function scrubProbeEnv(allowlist: readonly string[], inheritEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const inherited = (key: string): string | undefined => {
    if (Object.hasOwn(inheritEnv, key)) return inheritEnv[key];
    if (process.platform !== "win32") return undefined;
    const actual = Object.keys(inheritEnv).find((name) => name.toUpperCase() === key.toUpperCase());
    return actual === undefined ? undefined : inheritEnv[actual];
  };
  for (const key of allowlist) {
    const value = inherited(key);
    if (value !== undefined) env[key] = value;
  }
  env.PATH = inherited("PATH") ?? "";
  if (process.platform === "win32") {
    env.SystemRoot = inherited("SystemRoot") ?? "C:\\Windows";
    env.SystemDrive = inherited("SystemDrive") ?? path.win32.parse(env.SystemRoot).root.replace(/\\$/, "");
    env.PATHEXT = inherited("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
    if (inherited("ComSpec")) env.ComSpec = inherited("ComSpec");
  }
  return env;
}

/**
 * Run ONE pinned metadata probe: executable + argv array (no shell), scrubbed
 * child environment, bounded output and timeout. Never sends a prompt and
 * never reaches inference; non-zero exit is a failed probe with generic safe
 * code/status.
 */
export function runMetadataProbe(spec: MetadataProbeSpec): MetadataProbeResult {
  assertProbeArgvSafe(spec.argv);
  const timeoutMs = spec.timeoutMs ?? METADATA_PROBE_TIMEOUT_MS;
  const maxOutputChars = spec.maxOutputChars ?? METADATA_PROBE_MAX_OUTPUT_CHARS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > METADATA_PROBE_TIMEOUT_MS || !Number.isSafeInteger(maxOutputChars) || maxOutputChars < 1 || maxOutputChars > METADATA_PROBE_MAX_OUTPUT_CHARS) throw new Error("Invalid metadata probe bounds");
  let prepared: ReturnType<typeof prepareCommand>;
  try {
    prepared = prepareCommand(spec.binary, [...spec.argv]);
  } catch (e) {
    return { ok: false, exitCode: null, stdout: "", detail: "metadata command preparation failed" };
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(prepared.command, prepared.args, {
      cwd: spec.cwd,
      env: scrubProbeEnv(spec.envAllowlist, process.env),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: prepared.windowsVerbatim,
      timeout: timeoutMs,
      maxBuffer: METADATA_PROBE_MAX_BUFFER_BYTES,
      killSignal: "SIGKILL",
    });
  } catch {
    return { ok: false, exitCode: null, stdout: "", detail: "spawn failed" };
  }
  if (result.error) {
    const safeError = (result.error as NodeJS.ErrnoException).code ?? (result.error.name === "ETIMEDOUT" ? "timeout" : "probe_error");
    return { ok: false, exitCode: result.status, stdout: "", detail: `probe failed (${safeError})` };
  }
  const stdout = String(result.stdout ?? "");
  if (stdout.length > maxOutputChars) return {ok:false,exitCode:result.status,stdout:"",detail:"metadata output limit"};
  if (result.status !== 0) {
    // Failure surfaces generic safe code/status, never raw stderr HTTP headers/cookies/secrets
    return { ok: false, exitCode: result.status, stdout, detail: `exit ${String(result.status)}` };
  }
  return { ok: true, exitCode: result.status, stdout, detail: "" };
}

/** Bounded, single-line sanitized detail for error surfaces (§10.4). */
export function boundedSanitizedDetail(text: string, max = 512): string {
  const sanitized = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return sanitized.length > max ? `${sanitized.slice(0, max)}…` : sanitized;
}

// ─── exact-fingerprint observation cache (explicit freshness) ────────────────

/**
 * Adapter-side cache: an observation is reused ONLY while the exact input
 * fingerprint matches AND the explicit freshness window has not elapsed.
 * Any input change (config/bundle bytes, probe identity) invalidates it.
 */
export class ReadinessObservationCache {
  private entry: { inputFingerprint: string; observation: ProviderReadinessObservation } | null = null;

  constructor(private readonly freshnessMs: number = 5 * 60_000) {}

  get(inputFingerprint: string, now: number): ProviderReadinessObservation | null {
    if (this.entry === null || this.entry.inputFingerprint !== inputFingerprint) return null;
    if (!isProviderReadinessObservation(this.entry.observation)) return null;
    if (this.entry.observation.observed_at > now + 60_000) return null;
    if (now - this.entry.observation.observed_at > this.freshnessMs) return null;
    return this.entry.observation;
  }

  put(inputFingerprint: string, observation: ProviderReadinessObservation): void {
    if (!isProviderReadinessObservation(observation) || observation.input_fingerprint !== inputFingerprint) throw new Error("Invalid cached readiness observation");
    const copy = Object.freeze({...observation,model_catalog:observation.model_catalog===null?null:Object.freeze([...observation.model_catalog]),probe_argv:observation.probe_argv===null?null:Object.freeze([...observation.probe_argv])});
    this.entry = { inputFingerprint, observation:copy };
  }
}

// ─── native operational error policy ──────────────────────────────────────────
// Vendor operational failures (exit codes, timeouts, assistant text) surface
// generic PROVIDER_PROTOCOL_ERROR with bounded sanitized details. Genuine vendor
// quota exhaustion requires a validated vendor protocol channel; without one,
// broker never fabricates QUOTA_EXHAUSTED or RATE_LIMITED.
