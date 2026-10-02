import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DaemonRpcError, DaemonRpcClient } from "../bridge/rpcClient.ts";
import { readBridgeToken, socketPathFor } from "../daemon/rpc.ts";
import { operatorConfigFingerprint, type OperatorConfig } from "./config.ts";

const OPERATOR_RECORD = "operator-runtime.json";
const READY_TIMEOUT_MS = 20_000;
const STOP_TIMEOUT_MS = 15_000;

export interface RuntimeManifestFile {
  path: string;
  mode: string;
  oid: string;
  size: number;
}

export interface RuntimeManifest {
  commit: string;
  files: RuntimeManifestFile[];
}

export interface RuntimeRecord {
  runtime_commit: string;
  runtime_path: string;
  manifest_path: string;
  runtime_files: number;
  config_path: string;
  daemon_pid: number;
  process_identity: string;
  started_at: number;
}

export interface OperatorStatus {
  status: "ready" | "stopped" | "unavailable";
  readiness: string;
  runtime_observation: "observed-running" | "last-known" | "unknown";
  settings_state: "applied" | "restart_required" | "unknown";
  saved_config_fingerprint: string;
  applied_config_fingerprint: string | null;
  runtime_commit: string | null;
  runtime_path: string | null;
  daemon_pid: number | null;
  active_turn_count: number | null;
  active_turns: Array<Record<string, unknown>> | null;
  active_turns_truncated: boolean | null;
  error_turn_count: number | null;
  error_turns: Array<Record<string, unknown>> | null;
  error_turns_truncated: boolean | null;
  pending_intents: unknown[] | null;
  state_dir: string;
  [key: string]: unknown;
}

function gitOptions(repoRoot: string) {
  return {
    cwd: repoRoot,
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    maxBuffer: 256 * 1024 * 1024,
  };
}

function repoRootFromSource(): string {
  const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  return execFileSync("git", ["rev-parse", "--show-toplevel"], gitOptions(sourceRoot)).toString("utf8").trim();
}

function safeRuntimeTarget(runtimePath: string, relativePath: string): string {
  const target = path.resolve(runtimePath, relativePath);
  const relative = path.relative(runtimePath, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Invalid Git runtime path '${relativePath}'.`);
  }
  return target;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", "utf8");
  renameSync(temporary, filePath);
}

function extractGitRuntime(repoRoot: string, runtimePath: string, ref: string): RuntimeManifest {
  const commit = execFileSync(
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    gitOptions(repoRoot),
  ).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) throw new Error(`Git ref '${ref}' did not resolve to a full commit.`);

  const tree = execFileSync(
    "git",
    ["ls-tree", "-rz", "-r", commit, "--", "src", "package.json"],
    gitOptions(repoRoot),
  ).toString("utf8");
  const files: RuntimeManifestFile[] = [];
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/s.exec(entry);
    if (!match) throw new Error("Runtime export requires regular Git-tracked files only.");
    const mode = match[1]!;
    const oid = match[2]!;
    const relativePath = match[3]!;
    if (relativePath !== "package.json" && !relativePath.startsWith("src/")) {
      throw new Error(`Runtime export contains an unexpected path '${relativePath}'.`);
    }
    const target = safeRuntimeTarget(runtimePath, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    const contents = execFileSync("git", ["cat-file", "blob", oid], gitOptions(repoRoot));
    writeFileSync(target, contents);
    if (mode === "100755") {
      try { chmodSync(target, 0o755); } catch { /* best effort on Windows */ }
    }
    files.push({ path: relativePath, mode, oid, size: contents.byteLength });
  }
  if (!files.some(file => file.path === "package.json") || !files.some(file => file.path === "src/operator/main.ts")) {
    throw new Error("Runtime export is missing package.json or src/operator/main.ts.");
  }
  return { commit, files };
}

export function extractRuntime(
  ref = "HEAD",
  stateDir = path.join(os.tmpdir(), "agent-broker-state"),
  configPath = process.cwd(),
): { record: RuntimeRecord; manifest: RuntimeManifest } {
  const repoRoot = repoRootFromSource();
  const runtimeRoot = path.join(path.resolve(stateDir), "runtimes");
  mkdirSync(runtimeRoot, { recursive: true });
  const runtimePath = path.join(runtimeRoot, `${Date.now()}-${randomUUID()}`);
  mkdirSync(runtimePath, { recursive: true });
  const manifest = extractGitRuntime(repoRoot, runtimePath, ref);
  const manifestPath = path.join(runtimePath, "runtime-manifest.json");
  writeJsonAtomically(manifestPath, manifest);
  const record: RuntimeRecord = {
    runtime_commit: manifest.commit,
    runtime_path: runtimePath,
    manifest_path: manifestPath,
    runtime_files: manifest.files.length,
    config_path: path.resolve(configPath),
    daemon_pid: 0,
    process_identity: "",
    started_at: Date.now(),
  };
  return { record, manifest };
}

function runtimeRecordPath(stateDir: string): string {
  return path.join(path.resolve(stateDir), OPERATOR_RECORD);
}

function saveRuntimeRecord(stateDir: string, record: RuntimeRecord): void {
  mkdirSync(path.resolve(stateDir), { recursive: true });
  writeJsonAtomically(runtimeRecordPath(stateDir), record);
}

export function readRuntimeRecord(stateDir: string): RuntimeRecord | null {
  try {
    const value = JSON.parse(readFileSync(runtimeRecordPath(stateDir), "utf8")) as Partial<RuntimeRecord>;
    if (
      typeof value.runtime_commit !== "string" ||
      typeof value.runtime_path !== "string" ||
      typeof value.manifest_path !== "string" ||
      typeof value.daemon_pid !== "number"
    ) return null;
    return value as RuntimeRecord;
  } catch {
    return null;
  }
}

function powershellPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

interface LaunchedProcess {
  pid: number;
  identity: string;
  child?: ChildProcess;
}

function launchDaemon(runtimePath: string, configPath: string, stateDir: string): LaunchedProcess {
  const entrypoint = path.join(runtimePath, "src", "operator", "main.ts");
  const logDir = path.join(runtimePath, "logs");
  mkdirSync(logDir, { recursive: true });
  if (process.platform === "win32") {
    const helper = path.join(runtimePath, "src", "operator", "launchDaemon.ps1");
    const output = execFileSync(
      powershellPath(),
      [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper,
        "-NodePath", path.resolve(process.execPath),
        "-RuntimeEntry", entrypoint,
        "-ConfigPath", path.resolve(configPath),
        "-RuntimePath", runtimePath,
        "-StateDir", path.resolve(stateDir),
      ],
      { cwd: runtimePath, windowsHide: true, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 20_000 },
    ).trim();
    const parsed = JSON.parse(output) as { pid: number; creationDate: string };
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) throw new Error("Windows launcher did not return a valid daemon PID.");
    if (!parsed.creationDate) throw new Error("Windows launcher did not observe process creation identity.");
    return { pid: parsed.pid, identity: parsed.creationDate };
  }

  const stdout = openSync(path.join(logDir, "daemon.stdout.log"), "a");
  const stderr = openSync(path.join(logDir, "daemon.stderr.log"), "a");
  const child = spawn(
    process.execPath,
    ["--experimental-transform-types", entrypoint, "daemon", "--config", path.resolve(configPath)],
    { cwd: runtimePath, detached: true, stdio: ["ignore", stdout, stderr], windowsHide: true },
  );
  child.unref();
  if (!child.pid) throw new Error("Daemon launcher did not return a PID.");
  return { pid: child.pid, identity: `started:${Date.now()}`, child };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestDaemon(config: OperatorConfig, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const client = new DaemonRpcClient(
    socketPathFor(config.state_dir),
    () => readBridgeToken(config.state_dir),
  );
  try {
    await client.connect(config.coordinator_id);
    return await client.request(method, params);
  } finally {
    client.close();
  }
}

function projectStatusRows(value: unknown, limit: number, includeErrorCode: boolean): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const projected: Array<Record<string, unknown>> = [];
  for (const row of value.slice(0, limit)) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    if (
      typeof item.turn_id !== "string" ||
      typeof item.session_id !== "string" ||
      typeof item.project_id !== "string" ||
      typeof item.provider !== "string" ||
      typeof item.model !== "string" ||
      (item.effort !== null && typeof item.effort !== "string") ||
      typeof item.state !== "string" ||
      typeof item.timestamp !== "number"
    ) return null;
    if (includeErrorCode && item.error_code !== null && typeof item.error_code !== "string") return null;
    projected.push({
      turn_id: item.turn_id,
      session_id: item.session_id,
      project_id: item.project_id,
      provider: item.provider,
      model: item.model,
      effort: item.effort,
      state: item.state,
      timestamp: item.timestamp,
      ...(includeErrorCode ? { error_code: item.error_code } : {}),
      ...(!includeErrorCode ? {
        accepted_at: typeof item.accepted_at === "number" ? item.accepted_at : null,
        deadline_at: typeof item.deadline_at === "number" ? item.deadline_at : null,
        execution_started: typeof item.execution_started === "boolean" ? item.execution_started : null,
        last_activity_at: typeof item.last_activity_at === "number" ? item.last_activity_at : null,
      } : {}),
    });
  }
  return projected;
}

async function waitForReady(config: OperatorConfig): Promise<Record<string, unknown>> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await requestDaemon(config, "operator/status");
      if (!value || typeof value !== "object") throw new Error("Daemon returned an invalid operator status.");
      const status = value as Record<string, unknown>;
      if (status.readiness === "READY" || status.state === "READY") return status;
      lastError = new Error(`Daemon readiness is ${String(status.readiness ?? status.state)}.`);
    } catch (error) {
      lastError = error;
      if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") throw error;
    }
    await sleep(100);
  }
  throw new Error(`Daemon did not become READY within ${READY_TIMEOUT_MS}ms: ${String(lastError)}`);
}

async function assertNotOwned(config: OperatorConfig): Promise<void> {
  if (existsSync(path.join(config.state_dir, "daemon.lock"))) {
    throw new Error("DAEMON_ALREADY_RUNNING: the configured state directory is owned or has an unresolved lock.");
  }
  const client = new DaemonRpcClient(socketPathFor(config.state_dir), () => readBridgeToken(config.state_dir));
  try {
    await client.connect(config.coordinator_id);
    throw new Error("DAEMON_ALREADY_RUNNING: another daemon owns the configured state directory.");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("DAEMON_ALREADY_RUNNING")) throw error;
  } finally {
    client.close();
  }
}

export async function startOperator(config: OperatorConfig, configPath: string, ref = "HEAD"): Promise<Record<string, unknown>> {
  await assertNotOwned(config);
  const extracted = extractRuntime(ref, config.state_dir, configPath);
  const launched = launchDaemon(extracted.record.runtime_path, path.resolve(configPath), config.state_dir);
  const record: RuntimeRecord = {
    ...extracted.record,
    config_path: path.resolve(configPath),
    daemon_pid: launched.pid,
    process_identity: launched.identity,
  };
  const status = await waitForReady(config);
  if (status.daemon_pid !== record.daemon_pid || status.runtime_commit !== record.runtime_commit || status.runtime_path !== record.runtime_path) {
    throw new Error("Daemon READY identity does not match the launched runtime.");
  }
  saveRuntimeRecord(config.state_dir, record);
  return {
    status: "ready",
    readiness: "READY",
    settings_state: status.applied_config_fingerprint === operatorConfigFingerprint(config) ? "applied" : "unknown",
    saved_config_fingerprint: operatorConfigFingerprint(config),
    applied_config_fingerprint: typeof status.applied_config_fingerprint === "string" ? status.applied_config_fingerprint : null,
    runtime_commit: record.runtime_commit,
    runtime_path: record.runtime_path,
    state_dir: config.state_dir,
    daemon_pid: record.daemon_pid,
    runtime_observation: "observed-running",
    active_turn_count: status.active_turn_count ?? null,
    active_turns: status.active_turns ?? [],
    active_turns_truncated: status.active_turns_truncated ?? false,
    error_turn_count: status.error_turn_count ?? null,
    error_turns: status.error_turns ?? [],
    error_turns_truncated: status.error_turns_truncated ?? false,
    pending_intents: status.pending_intents ?? [],
  };
}

export async function statusOperator(config: OperatorConfig): Promise<OperatorStatus> {
  const record = readRuntimeRecord(config.state_dir);
  const savedConfigFingerprint = operatorConfigFingerprint(config);
  try {
    const status = await requestDaemon(config, "operator/status") as Record<string, unknown>;
    const readiness = String(status.readiness ?? status.state ?? "UNAVAILABLE");
    if (readiness === "READY") {
      const appliedConfigFingerprint = typeof status.applied_config_fingerprint === "string"
        ? status.applied_config_fingerprint
        : null;
      return {
        status: "ready",
        readiness,
        runtime_observation: "observed-running",
        settings_state: appliedConfigFingerprint === null
          ? "unknown"
          : appliedConfigFingerprint === savedConfigFingerprint ? "applied" : "restart_required",
        saved_config_fingerprint: savedConfigFingerprint,
        applied_config_fingerprint: appliedConfigFingerprint,
        runtime_commit: typeof status.runtime_commit === "string" ? status.runtime_commit : null,
        runtime_path: typeof status.runtime_path === "string" ? status.runtime_path : null,
        daemon_pid: typeof status.daemon_pid === "number" ? status.daemon_pid : null,
        active_turn_count: typeof status.active_turn_count === "number" ? status.active_turn_count : null,
        active_turns: typeof status.active_turn_count === "number" ? projectStatusRows(status.active_turns, 30, false) : null,
        active_turns_truncated: typeof status.active_turns_truncated === "boolean" ? status.active_turns_truncated : null,
        error_turn_count: typeof status.error_turn_count === "number" ? status.error_turn_count : null,
        error_turns: typeof status.error_turn_count === "number" ? projectStatusRows(status.error_turns, 10, true) : null,
        error_turns_truncated: typeof status.error_turns_truncated === "boolean" ? status.error_turns_truncated : null,
        pending_intents: Array.isArray(status.pending_intents) ? status.pending_intents : null,
        state_dir: config.state_dir,
      };
    }
    return {
      status: "unavailable",
      readiness,
      runtime_observation: record ? "last-known" : "unknown",
      settings_state: "unknown",
      saved_config_fingerprint: savedConfigFingerprint,
      applied_config_fingerprint: null,
      runtime_commit: record?.runtime_commit ?? null,
      runtime_path: record?.runtime_path ?? null,
      daemon_pid: record?.daemon_pid ?? null,
      active_turn_count: null,
      active_turns: null,
      active_turns_truncated: null,
      error_turn_count: null,
      error_turns: null,
      error_turns_truncated: null,
      pending_intents: null,
      state_dir: config.state_dir,
    };
  } catch (error) {
    if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") throw error;
    return {
      status: error instanceof DaemonRpcError || existsSync(path.join(config.state_dir, "daemon.lock")) ? "unavailable" : "stopped",
      readiness: "UNAVAILABLE",
      runtime_observation: record ? "last-known" : "unknown",
      settings_state: "unknown",
      saved_config_fingerprint: savedConfigFingerprint,
      applied_config_fingerprint: null,
      runtime_commit: record?.runtime_commit ?? null,
      runtime_path: record?.runtime_path ?? null,
      daemon_pid: record?.daemon_pid ?? null,
      active_turn_count: null,
      active_turns: null,
      active_turns_truncated: null,
      error_turn_count: null,
      error_turns: null,
      error_turns_truncated: null,
      pending_intents: null,
      state_dir: config.state_dir,
    };
  }
}

async function waitForStopped(config: OperatorConfig): Promise<void> {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lockExists = existsSync(path.join(config.state_dir, "daemon.lock"));
    let reachable = false;
    try {
      const client = new DaemonRpcClient(socketPathFor(config.state_dir), () => readBridgeToken(config.state_dir));
      await client.connect(config.coordinator_id);
      reachable = true;
      client.close();
    } catch {
      // The daemon is expected to become unavailable after releasing ownership.
    }
    if (!lockExists && !reachable) return;
    await sleep(100);
  }
  throw new Error(`Daemon did not become unavailable within ${STOP_TIMEOUT_MS}ms.`);
}

function sameRuntimePath(value: unknown, runtimePath: string): boolean {
  return typeof value === "string" && path.resolve(value) === path.resolve(runtimePath);
}

export async function restartOperator(config: OperatorConfig, configPath: string): Promise<Record<string, unknown>> {
  const record = readRuntimeRecord(config.state_dir);
  if (
    !record ||
    !/^[0-9a-f]{40}$/i.test(record.runtime_commit) ||
    typeof record.runtime_path !== "string" ||
    typeof record.manifest_path !== "string" ||
    typeof record.config_path !== "string" ||
    !Number.isInteger(record.daemon_pid) ||
    record.daemon_pid <= 0
  ) {
    throw new Error("NO_ACCEPTED_RUNTIME: no accepted runtime record is available; restart was not started.");
  }
  const runtimePath = path.resolve(record.runtime_path);
  const manifestPath = path.resolve(record.manifest_path);
  const savedConfigPath = path.resolve(configPath);
  if (manifestPath !== path.join(runtimePath, "runtime-manifest.json") || path.resolve(record.config_path) !== savedConfigPath) {
    throw new Error("NO_ACCEPTED_RUNTIME: the accepted runtime record does not match its manifest and saved config; restart was not started.");
  }
  let manifestCommit = "";
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { commit?: unknown };
    if (typeof manifest.commit === "string") manifestCommit = manifest.commit;
  } catch {
    throw new Error("NO_ACCEPTED_RUNTIME: the accepted runtime manifest cannot be read; restart was not started.");
  }
  if (manifestCommit !== record.runtime_commit || !existsSync(path.join(runtimePath, "src", "operator", "main.ts"))) {
    throw new Error("NO_ACCEPTED_RUNTIME: the accepted runtime manifest does not match the recorded commit; restart was not started.");
  }

  let live: Record<string, unknown>;
  try {
    const value = await requestDaemon(config, "operator/status");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DAEMON_UNAVAILABLE: daemon status was invalid; restart was not started.");
    }
    live = value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") throw error;
    if (error instanceof Error && /^(?:DAEMON_UNAVAILABLE|NO_ACCEPTED_RUNTIME|RUNTIME_IDENTITY_MISMATCH|UNKNOWN_ACTIVITY):/.test(error.message)) throw error;
    throw new Error("DAEMON_UNAVAILABLE: authenticated daemon status is unavailable; restart was not started.");
  }
  if (live.readiness !== "READY") {
    throw new Error(`DAEMON_UNAVAILABLE: daemon readiness is ${String(live.readiness ?? "unknown")}; restart was not started.`);
  }
  if (live.runtime_commit !== record.runtime_commit || !sameRuntimePath(live.runtime_path, runtimePath) || live.daemon_pid !== record.daemon_pid) {
    throw new Error("RUNTIME_IDENTITY_MISMATCH: live daemon identity does not match the accepted runtime record; restart was not started.");
  }
  if (typeof live.active_turn_count !== "number" || !Array.isArray(live.pending_intents)) {
    throw new Error("UNKNOWN_ACTIVITY: live activity is not observed; restart was not started.");
  }

  await stopOperator(config);
  const launched = launchDaemon(runtimePath, savedConfigPath, config.state_dir);
  let status: Record<string, unknown>;
  try {
    status = await waitForReady(config);
  } catch (error) {
    if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") throw error;
    throw new Error(`DAEMON_UNAVAILABLE: restarted daemon did not become READY; restart was not retried. ${error instanceof Error ? error.message : String(error)}`);
  }
  const expectedFingerprint = operatorConfigFingerprint(config);
  if (
    status.daemon_pid !== launched.pid ||
    status.runtime_commit !== record.runtime_commit ||
    !sameRuntimePath(status.runtime_path, runtimePath) ||
    status.applied_config_fingerprint !== expectedFingerprint
  ) {
    throw new Error("RUNTIME_IDENTITY_MISMATCH: restarted daemon identity does not match the accepted runtime and saved configuration; restart was not retried.");
  }
  const updated: RuntimeRecord = {
    ...record,
    runtime_commit: record.runtime_commit,
    runtime_path: runtimePath,
    manifest_path: manifestPath,
    config_path: savedConfigPath,
    daemon_pid: launched.pid,
    process_identity: launched.identity,
    started_at: Date.now(),
  };
  saveRuntimeRecord(config.state_dir, updated);
  return {
    status: "ready",
    readiness: "READY",
    settings_state: "applied",
    saved_config_fingerprint: expectedFingerprint,
    applied_config_fingerprint: expectedFingerprint,
    runtime_commit: record.runtime_commit,
    runtime_path: runtimePath,
    daemon_pid: launched.pid,
    state_dir: config.state_dir,
    runtime_observation: "observed-running",
  };
}

export async function stopOperator(config: OperatorConfig): Promise<Record<string, unknown>> {
  const response = await requestDaemon(config, "operator/stop") as Record<string, unknown>;
  if (response.accepted !== true) throw new Error("Daemon did not acknowledge graceful stop.");
  await waitForStopped(config);
  return {
    status: "stopped",
    readiness: "UNAVAILABLE",
    runtime_observation: "last-known",
    runtime_commit: response.runtime_commit ?? null,
    runtime_path: response.runtime_path ?? null,
    state_dir: config.state_dir,
    daemon_pid: response.daemon_pid ?? null,
    active_turn_count: null,
    active_turns: null,
    active_turns_truncated: null,
    error_turn_count: null,
    error_turns: null,
    error_turns_truncated: null,
    pending_intents: null,
  };
}

export async function turnErrorOperator(config: OperatorConfig, turnId: string): Promise<Record<string, unknown>> {
  const value = await requestDaemon(config, "operator/turn-error", { turn_id: turnId });
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Turn error detail is unavailable.");
  }
  return value as Record<string, unknown>;
}
