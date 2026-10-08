import path from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callBridgeTool, bridgeToolDefs } from "../bridge/tools.ts";
import { runStdioBridge, type McpToolContext } from "../bridge/server.ts";
import { startDaemon } from "../daemon/bootstrap.ts";
import { startDaemonRpc, type OperatorStopPlan } from "../daemon/rpc.ts";
import { listNonterminalTurns, listPendingIntents } from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";
import { applyOperatorConfig, loadOperatorConfig, operatorConfigFingerprint, validateOperatorConfig, type OperatorConfig } from "./config.ts";
import { readRuntimeRecord, startOperator, statusOperator, stopOperator } from "./operations.ts";
import { operatorTurnErrorResult, projectOperatorOverview, projectOperatorQuotaPauses, clearQuotaPauseResult } from "./overview.ts";
import { inspectQuarantine, reconcileWorkspace } from "./recovery.ts";
import { isPackageBuild, packageRootFromSource, readRuntimeManifest, runtimeEntryInfo, runtimeIdentity } from "./packageOrigin.ts";
import { createOperatorStorageHandlers } from "./storage.ts";
import { startOperatorUi } from "./ui.ts";

type Command = "init" | "validate" | "stdio" | "daemon" | "mcp-config" | "ui" | "start" | "status" | "stop" | "quarantine-inspect" | "reconcile-workspace";

function parseArgs(argv: string[]): {
  command: Command;
  configPath: string;
  connect: boolean;
  port: number;
  ref: string;
  workspaceId?: string;
  note?: string;
  help: boolean;
  version: boolean;
} {
  let command: Command = "stdio";
  let configPath: string | undefined;
  let connect = false;
  let port = 4318;
  let ref = "HEAD";
  let workspaceId: string | undefined;
  let note: string | undefined;
  let help = false;
  let version = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--connect") { connect = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg === "--version") { version = true; continue; }
    if (arg === "--config") {
      configPath = argv[++index];
      continue;
    }
    if (arg === "--port") {
      const value = argv[++index];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65_535) throw new Error("--port must be a number from 0 to 65535.");
      port = Number(value);
      continue;
    }
    if (arg === "--ref") {
      const value = argv[++index];
      if (!value) throw new Error("--ref requires a Git commit.");
      ref = value;
      continue;
    }
    if (arg === "--workspace-id") {
      workspaceId = argv[++index];
      if (!workspaceId) throw new Error("--workspace-id requires a workspace id.");
      continue;
    }
    if (arg === "--note") {
      note = argv[++index];
      if (!note) throw new Error("--note requires an operator explanation.");
      continue;
    }
    if (arg === "init" || arg === "validate" || arg === "stdio" || arg === "daemon" || arg === "mcp-config" || arg === "ui" || arg === "start" || arg === "status" || arg === "stop" || arg === "quarantine-inspect" || arg === "reconcile-workspace") {
      command = arg;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'.`);
  }
  if (help || version) {
    return { command, configPath: "", connect, port, ref, workspaceId, note, help, version };
  }
  if (!configPath) throw new Error("--config PATH is required. Run with --help for usage.");
  if (connect && command !== "mcp-config") throw new Error("--connect is only supported by mcp-config.");
  if (port !== 4318 && command !== "ui") throw new Error("--port is only supported by ui.");
  if (ref !== "HEAD" && command !== "start") throw new Error("--ref is only supported by start.");
  if (workspaceId !== undefined && command !== "quarantine-inspect" && command !== "reconcile-workspace") {
    throw new Error("--workspace-id is only supported by quarantine-inspect or reconcile-workspace.");
  }
  if (note !== undefined && command !== "reconcile-workspace") throw new Error("--note is only supported by reconcile-workspace.");
  if (command === "reconcile-workspace" && workspaceId === undefined) throw new Error("reconcile-workspace requires --workspace-id.");
  if (command === "reconcile-workspace" && note === undefined) throw new Error("reconcile-workspace requires --note.");
  return { command, configPath: path.resolve(configPath), connect, port, ref, workspaceId, note, help, version };
}

const HELP_TEXT = `agent-broker — local MCP broker for multi-vendor coding agents

Usage: agent-broker <command> --config PATH [options]

Commands:
  init                 Write a minimal valid empty operator config and exit.
  validate             Parse and validate the operator config, then exit.
  start                Freeze the current runtime into the state directory and
                       launch a detached shared daemon, then wait until READY.
  status               Report daemon status (observed-running, last-known or stopped).
  stop                 Gracefully stop an idle daemon (refuses with active turns).
  ui                   Serve the operator settings UI on http://127.0.0.1.
  mcp-config           Print an MCP client configuration snippet.
  stdio                Run an in-process stdio MCP bridge (default command).
  daemon               Run the shared daemon in the foreground.
  quarantine-inspect   List quarantined workspaces in the state directory.
  reconcile-workspace  Reconcile one workspace after a failure.

Options:
  --config PATH        Operator configuration file (required except for
                       --help and --version).
  --port N             ui: loopback port to listen on (default 4318).
  --connect            mcp-config: attach to an already-started shared daemon
                       instead of starting a private in-process one.
  --ref COMMIT         start: development-only Git snapshot to freeze
                       (requires running from a Git checkout).
  --workspace-id ID    quarantine-inspect/reconcile-workspace workspace.
  --note TEXT          reconcile-workspace operator explanation.
  --help               Print this help and exit.
  --version            Print the package version and exit.

Typical first run:
  agent-broker init --config ./operator.json
  agent-broker ui --config ./operator.json

The generated config starts empty; add projects, accounts and agent profile
pools in the operator UI, then run 'agent-broker start --config ./operator.json'.
`;

function printVersion(): void {
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRootFromSource(), "package.json"), "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version) version = pkg.version;
  } catch { /* keep unknown */ }
  process.stdout.write(`${version}\n`);
}

function initOperatorConfigFile(configPath: string): { config: string; state_dir: string; coordinator_id: string } {
  const target = path.resolve(configPath);
  const configDir = path.dirname(target);
  const packageRoot = packageRootFromSource();
  if (isPackageBuild()) {
    const relative = path.relative(packageRoot, target);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      throw new Error("Refusing to create operator configuration inside the installed package; keep configuration and state outside the installation.");
    }
  }
  if (existsSync(target)) throw new Error(`Refusing to overwrite the existing config '${target}'.`);
  const stateDirRelative = "./agent-broker-state";
  const config = {
    version: 1 as const,
    state_dir: stateDirRelative,
    coordinator_id: "operator",
    projects: [],
    coordinators: [{ coordinator_id: "operator", display_name: "Operator", allowed_project_ids: [] }],
    accounts: [],
    workspaces: [],
    policy_profiles: [],
    coverage_profiles: [],
    routes: [],
  };
  // Prove the generated file is valid before writing it.
  validateOperatorConfig(JSON.parse(JSON.stringify(config)), configDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  return {
    config: target,
    state_dir: path.resolve(configDir, stateDirRelative),
    coordinator_id: "operator",
  };
}

function binaryPins(config: OperatorConfig): Record<string, string | undefined> {
  const pins = config.native_binary_pins ?? {};
  const pin = (name: string) => pins[name];
  return {
    codexBinary: pin("codex"),
    claudeBinary: pin("claude-code") ?? pin("claude"),
    cursorBinary: pin("cursor"),
    zcodeBundlePath: pin("zcode") ?? pin("zcode-bundle"),
    zcodeNodeBinary: pin("zcode-node"),
    zcodeBuiltinProviderConfigPath: pin("zcode-config"),
    antigravityBinary: pin("antigravity"),
  };
}

function daemonEnv(config: OperatorConfig) {
  const pins = binaryPins(config);
  return {
    stateDir: config.state_dir,
    coordinatorId: config.coordinator_id,
    limits: config.limits,
    ...pins,
    routes: new Map(config.routes.map(route => [route.route_id, route])),
    configuredWorkspaceIds: new Set(config.workspaces.map(workspace => workspace.workspace_id)),
    configureRegistry: (db: Parameters<typeof applyOperatorConfig>[0]) => {
      applyOperatorConfig(db, config);
    },
  };
}

async function runStdio(config: OperatorConfig): Promise<void> {
  const env = daemonEnv(config);
  const daemon = await startDaemon(env);
  const ctx: McpToolContext = {
    listTools: () => bridgeToolDefs(),
    callTool: (name, args, signal) => callBridgeTool({
      coordinatorId: config.coordinator_id,
      core: daemon.core,
      signal,
      daemonState: daemon.lifecycle.currentState,
      incarnation: daemon.lifecycle.currentIncarnation,
    }, name, args),
  };
  process.stderr.write(`agent-broker stdio ready (state=${daemon.lifecycle.currentState} adapters=[${[...daemon.adapters.keys()].join(",")}])\n`);
  try {
    await runStdioBridge(ctx, process.stdin, process.stdout);
  } finally {
    await daemon.stop();
    daemon.db.close();
  }
}

export function daemonOperatorStatus(
  daemon: Awaited<ReturnType<typeof startDaemon>>,
  appliedConfigFingerprint: string,
): Record<string, unknown> {
  const runtimePath = packageRootFromSource();
  const origin = readRuntimeManifest(runtimePath)?.origin ?? null;
  const overview = projectOperatorOverview(daemon.db);
  return {
    readiness: daemon.lifecycle.currentState,
    state: daemon.lifecycle.currentState,
    incarnation: daemon.lifecycle.currentIncarnation,
    daemon_pid: process.pid,
    runtime_observation: "observed-running",
    applied_config_fingerprint: appliedConfigFingerprint,
    runtime_commit: origin?.kind === "git" ? origin.commit : null,
    runtime_version: origin?.kind === "npm-package" ? origin.version : null,
    runtime_origin: origin,
    runtime_identity: origin ? runtimeIdentity(origin) : null,
    runtime_path: origin ? runtimePath : null,
    ...overview,
    quota_pauses: projectOperatorQuotaPauses(daemon.db, Date.now()),
    pending_intents: listPendingIntents(daemon.db).map(intent => ({
      intent_id: intent.intent_id,
      kind: intent.kind,
      session_id: intent.session_id,
      turn_id: intent.turn_id,
    })),
  };
}

async function runDaemon(config: OperatorConfig): Promise<void> {
  const env = daemonEnv(config);
  const daemon = await startDaemon(env);
  const appliedConfigFingerprint = operatorConfigFingerprint(config);
  let stopRequestedResolve: (() => void) | undefined;
  let operatorStopPromise: Promise<void> | null = null;
  const stopRequested = new Promise<void>(resolve => { stopRequestedResolve = resolve; });
  const storageHandlers = createOperatorStorageHandlers(daemon.db, daemon.blobs, config.coordinator_id);
  const operator = {
    coordinatorId: config.coordinator_id,
    status: () => daemonOperatorStatus(daemon, appliedConfigFingerprint),
    turnError: (params: Record<string, unknown>) => operatorTurnErrorResult(daemon.db, params),
    clearQuotaPause: (params: Record<string, unknown>) => clearQuotaPauseResult(daemon.db, params),
    storagePreview: (params: Record<string, unknown>) => storageHandlers.preview(params),
    storageExecute: (params: Record<string, unknown>) => storageHandlers.execute(params),
    stop: (): OperatorStopPlan => {
      const activeTurns = listNonterminalTurns(daemon.db);
      const pendingIntents = listPendingIntents(daemon.db);
      if (daemon.lifecycle.currentState !== "READY") {
        throw new BrokerError("DAEMON_NOT_READY", `Daemon is ${daemon.lifecycle.currentState}.`);
      }
      if (activeTurns.length > 0 || pendingIntents.length > 0) {
        throw new BrokerError("RESOURCE_BUSY", "Daemon stop requires no active turns or pending intents.", {
          details: {
            active_turns: activeTurns.map(turn => ({ turn_id: turn.turn_id, state: turn.state })),
            pending_intents: pendingIntents.map(intent => ({ intent_id: intent.intent_id, kind: intent.kind })),
          },
        });
      }
      return {
        response: { ...daemonOperatorStatus(daemon, appliedConfigFingerprint), accepted: true, readiness: "STOPPING" },
        shutdown: () => {
          operatorStopPromise ??= daemon.stop();
          stopRequestedResolve?.();
          return operatorStopPromise;
        },
      };
    },
  };
  const rpc = await startDaemonRpc({
    core: daemon.core,
    coordinatorId: config.coordinator_id,
    stateDir: config.state_dir,
    operator,
  });
  process.stderr.write(`agent-broker daemon listening ${rpc.socketPath}\n`);
  let signalResolve: (() => void) | undefined;
  const signal = new Promise<void>(resolve => { signalResolve = resolve; });
  const shutdown = () => {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    signalResolve?.();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  try {
    await Promise.race([signal, stopRequested]);
    // A rejected drain retains the registry, RPC, ownership, and supervision.
    await (operatorStopPromise ?? daemon.stop());
    await rpc.stop();
    daemon.db.close();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

async function runUi(configPath: string, port: number): Promise<void> {
  const ui = await startOperatorUi({
    configPath,
    port,
    scriptPath: path.resolve(fileURLToPath(import.meta.url)),
  });
  process.stderr.write(`agent-broker ui listening ${ui.url}\n`);
  try {
    await new Promise<void>(resolve => {
      const shutdown = () => {
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        resolve();
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    });
  } finally {
    await ui.close();
  }
}

function printMcpConfig(configPath: string, config: OperatorConfig, connect: boolean): void {
  // Without --connect the client runs this CLI in-process stdio mode; with
  // --connect it attaches to the accepted frozen runtime's out-of-process
  // bridge. TypeScript runtimes (Git snapshots) need the transform flag;
  // installed packages run compiled JavaScript with plain Node.
  const runningScript = path.resolve(fileURLToPath(import.meta.url));
  let scriptPath = runningScript;
  let nodeArgs = runningScript.endsWith(".ts") ? ["--experimental-transform-types"] : [];
  if (connect) {
    const record = readRuntimeRecord(config.state_dir);
    const entry = record ? runtimeEntryInfo(record.runtime_path) : null;
    if (entry) {
      const extension = entry.entryPath.endsWith(".ts") ? ".ts" : ".js";
      scriptPath = path.resolve(path.dirname(entry.entryPath), "..", "bridge", `main-stdio${extension}`);
      nodeArgs = entry.nodeArgs;
    } else {
      throw new Error("Start the shared daemon before requesting mcp-config --connect.");
    }
  }
  process.stdout.write(`${JSON.stringify({
    mcpServers: {
      "agent-broker": {
        command: path.resolve(process.execPath),
        args: [...nodeArgs, scriptPath, ...(connect ? [] : ["stdio", "--config", configPath])],
        ...(connect ? { env: { AB_STATE_DIR: config.state_dir, AB_COORDINATOR_ID: config.coordinator_id } } : {}),
      },
    },
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { command, configPath, connect, port, ref, workspaceId, note, help, version } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  if (version) {
    printVersion();
    return;
  }
  if (command === "ui") {
    await runUi(configPath, port);
    return;
  }
  if (command === "init") {
    process.stdout.write(`${JSON.stringify(initOperatorConfigFile(configPath))}\n`);
    return;
  }
  const config = loadOperatorConfig(configPath);
  if (command === "validate") {
    process.stdout.write(`${JSON.stringify({ valid: true, version: config.version, state_dir: config.state_dir, projects: config.projects.length, routes: config.routes.length })}\n`);
  } else if (command === "mcp-config") {
    printMcpConfig(configPath, config, connect);
  } else if (command === "daemon") {
    await runDaemon(config);
  } else if (command === "start") {
    process.stdout.write(`${JSON.stringify(await startOperator(config, configPath, ref))}\n`);
  } else if (command === "status") {
    process.stdout.write(`${JSON.stringify(await statusOperator(config))}\n`);
  } else if (command === "stop") {
    process.stdout.write(`${JSON.stringify(await stopOperator(config))}\n`);
  } else if (command === "quarantine-inspect") {
    process.stdout.write(`${JSON.stringify(inspectQuarantine(config.state_dir, workspaceId))}\n`);
  } else if (command === "reconcile-workspace") {
    process.stdout.write(`${JSON.stringify(await reconcileWorkspace({ stateDir: config.state_dir, workspaceId: workspaceId!, note: note! }))}\n`);
  } else {
    await runStdio(config);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch(error => {
    process.stderr.write(`agent-broker operator fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
