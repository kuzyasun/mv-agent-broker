import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { callBridgeTool, bridgeToolDefs } from "../bridge/tools.ts";
import { runStdioBridge, type McpToolContext } from "../bridge/server.ts";
import { startDaemon } from "../daemon/bootstrap.ts";
import { startDaemonRpc, type OperatorStopPlan } from "../daemon/rpc.ts";
import { listNonterminalTurns, listPendingIntents } from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";
import { applyOperatorConfig, loadOperatorConfig, type OperatorConfig } from "./config.ts";
import { readRuntimeRecord, startOperator, statusOperator, stopOperator } from "./operations.ts";
import { projectOperatorOverview } from "./overview.ts";
import { inspectQuarantine, reconcileWorkspace } from "./recovery.ts";
import { startOperatorUi } from "./ui.ts";

type Command = "validate" | "stdio" | "daemon" | "mcp-config" | "ui" | "start" | "status" | "stop" | "quarantine-inspect" | "reconcile-workspace";

function parseArgs(argv: string[]): {
  command: Command;
  configPath: string;
  connect: boolean;
  port: number;
  ref: string;
  workspaceId?: string;
  note?: string;
} {
  let command: Command = "stdio";
  let configPath: string | undefined;
  let connect = false;
  let port = 4318;
  let ref = "HEAD";
  let workspaceId: string | undefined;
  let note: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--connect") { connect = true; continue; }
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
    if (arg === "validate" || arg === "stdio" || arg === "daemon" || arg === "mcp-config" || arg === "ui" || arg === "start" || arg === "status" || arg === "stop" || arg === "quarantine-inspect" || arg === "reconcile-workspace") {
      command = arg;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'.`);
  }
  if (!configPath) throw new Error("--config PATH is required.");
  if (connect && command !== "mcp-config") throw new Error("--connect is only supported by mcp-config.");
  if (port !== 4318 && command !== "ui") throw new Error("--port is only supported by ui.");
  if (ref !== "HEAD" && command !== "start") throw new Error("--ref is only supported by start.");
  if (workspaceId !== undefined && command !== "quarantine-inspect" && command !== "reconcile-workspace") {
    throw new Error("--workspace-id is only supported by quarantine-inspect or reconcile-workspace.");
  }
  if (note !== undefined && command !== "reconcile-workspace") throw new Error("--note is only supported by reconcile-workspace.");
  if (command === "reconcile-workspace" && workspaceId === undefined) throw new Error("reconcile-workspace requires --workspace-id.");
  if (command === "reconcile-workspace" && note === undefined) throw new Error("reconcile-workspace requires --note.");
  return { command, configPath: path.resolve(configPath), connect, port, ref, workspaceId, note };
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
    ...pins,
    routes: new Map(config.routes.map(route => [route.route_id, route])),
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

export function daemonOperatorStatus(daemon: Awaited<ReturnType<typeof startDaemon>>): Record<string, unknown> {
  const runtimePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const manifestPath = path.join(runtimePath, "runtime-manifest.json");
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) as { commit: string } : null;
  const overview = projectOperatorOverview(daemon.db);
  return {
    readiness: daemon.lifecycle.currentState,
    state: daemon.lifecycle.currentState,
    incarnation: daemon.lifecycle.currentIncarnation,
    daemon_pid: process.pid,
    runtime_observation: "observed-running",
    runtime_commit: manifest?.commit ?? null,
    runtime_path: manifest ? runtimePath : null,
    ...overview,
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
  let stopRequestedResolve: (() => void) | undefined;
  let operatorStopPromise: Promise<void> | null = null;
  const stopRequested = new Promise<void>(resolve => { stopRequestedResolve = resolve; });
  const operator = {
    coordinatorId: config.coordinator_id,
    status: () => daemonOperatorStatus(daemon),
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
        response: { ...daemonOperatorStatus(daemon), accepted: true, readiness: "STOPPING" },
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
  const record = connect ? readRuntimeRecord(config.state_dir) : null;
  const scriptPath = connect
    ? path.resolve(record?.runtime_path ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."), "src/bridge/main-stdio.ts")
    : path.resolve(fileURLToPath(import.meta.url));
  process.stdout.write(`${JSON.stringify({
    mcpServers: {
      "agent-broker": {
        command: path.resolve(process.execPath),
        args: ["--experimental-transform-types", scriptPath, ...(connect ? [] : ["stdio", "--config", configPath])],
        ...(connect ? { env: { AB_STATE_DIR: config.state_dir, AB_COORDINATOR_ID: config.coordinator_id } } : {}),
      },
    },
  }, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { command, configPath, connect, port, ref, workspaceId, note } = parseArgs(process.argv.slice(2));
  if (command === "ui") {
    await runUi(configPath, port);
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
