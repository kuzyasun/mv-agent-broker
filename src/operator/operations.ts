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
import type { OperatorConfig } from "./config.ts";

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
  runtime_commit: string | null;
  runtime_path: string | null;
  daemon_pid: number | null;
  active_turns: unknown[] | null;
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

async function requestDaemon(config: OperatorConfig, method: string): Promise<unknown> {
  const client = new DaemonRpcClient(
    socketPathFor(config.state_dir),
    () => readBridgeToken(config.state_dir),
  );
  try {
    await client.connect(config.coordinator_id);
    return await client.request(method);
  } finally {
    client.close();
  }
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
    runtime_commit: record.runtime_commit,
    runtime_path: record.runtime_path,
    state_dir: config.state_dir,
    daemon_pid: record.daemon_pid,
    active_turns: status.active_turns ?? [],
    pending_intents: status.pending_intents ?? [],
  };
}

export async function statusOperator(config: OperatorConfig): Promise<OperatorStatus> {
  const record = readRuntimeRecord(config.state_dir);
  try {
    const status = await requestDaemon(config, "operator/status") as Record<string, unknown>;
    const readiness = String(status.readiness ?? status.state ?? "UNAVAILABLE");
    return {
      status: readiness === "READY" ? "ready" : "unavailable",
      readiness,
      runtime_commit: typeof status.runtime_commit === "string" ? status.runtime_commit : null,
      runtime_path: typeof status.runtime_path === "string" ? status.runtime_path : null,
      daemon_pid: typeof status.daemon_pid === "number" ? status.daemon_pid : null,
      active_turns: Array.isArray(status.active_turns) ? status.active_turns : null,
      pending_intents: Array.isArray(status.pending_intents) ? status.pending_intents : null,
      state_dir: config.state_dir,
    };
  } catch (error) {
    if (error instanceof DaemonRpcError && error.code === "UNAUTHORIZED") throw error;
    return {
      status: error instanceof DaemonRpcError || existsSync(path.join(config.state_dir, "daemon.lock")) ? "unavailable" : "stopped",
      readiness: "UNAVAILABLE",
      runtime_commit: record?.runtime_commit ?? null,
      runtime_path: record?.runtime_path ?? null,
      daemon_pid: record?.daemon_pid ?? null,
      active_turns: null,
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

export async function stopOperator(config: OperatorConfig): Promise<Record<string, unknown>> {
  const response = await requestDaemon(config, "operator/stop") as Record<string, unknown>;
  if (response.accepted !== true) throw new Error("Daemon did not acknowledge graceful stop.");
  await waitForStopped(config);
  return {
    status: "stopped",
    readiness: "UNAVAILABLE",
    runtime_commit: response.runtime_commit ?? null,
    runtime_path: response.runtime_path ?? null,
    state_dir: config.state_dir,
    daemon_pid: response.daemon_pid ?? null,
  };
}
