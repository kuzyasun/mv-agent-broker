import path from "node:path";
import { fileURLToPath } from "node:url";
import { callBridgeTool, bridgeToolDefs } from "../bridge/tools.ts";
import { runStdioBridge, type McpToolContext } from "../bridge/server.ts";
import { startDaemon } from "../daemon/bootstrap.ts";
import { startDaemonRpc } from "../daemon/rpc.ts";
import { applyOperatorConfig, loadOperatorConfig, type OperatorConfig } from "./config.ts";

type Command = "validate" | "stdio" | "daemon" | "mcp-config";

function parseArgs(argv: string[]): { command: Command; configPath: string; connect: boolean } {
  let command: Command = "stdio";
  let configPath: string | undefined;
  let connect = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--connect") { connect = true; continue; }
    if (arg === "--config") {
      configPath = argv[++index];
      continue;
    }
    if (arg === "validate" || arg === "stdio" || arg === "daemon" || arg === "mcp-config") {
      command = arg;
      continue;
    }
    throw new Error(`Unknown argument '${arg}'.`);
  }
  if (!configPath) throw new Error("--config PATH is required.");
  if (connect && command !== "mcp-config") throw new Error("--connect is only supported by mcp-config.");
  return { command, configPath: path.resolve(configPath), connect };
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
    callTool: (name, args) => callBridgeTool({
      coordinatorId: config.coordinator_id,
      core: daemon.core,
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

async function runDaemon(config: OperatorConfig): Promise<void> {
  const env = daemonEnv(config);
  const daemon = await startDaemon(env);
  const rpc = await startDaemonRpc({
    core: daemon.core,
    coordinatorId: config.coordinator_id,
    stateDir: config.state_dir,
  });
  process.stderr.write(`agent-broker daemon listening ${rpc.socketPath}\n`);
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
    await rpc.stop();
    await daemon.stop();
    daemon.db.close();
  }
}

function printMcpConfig(configPath: string, config: OperatorConfig, connect: boolean): void {
  const scriptPath = connect
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bridge/main-stdio.ts")
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
  const { command, configPath, connect } = parseArgs(process.argv.slice(2));
  const config = loadOperatorConfig(configPath);
  if (command === "validate") {
    process.stdout.write(`${JSON.stringify({ valid: true, version: config.version, state_dir: config.state_dir, projects: config.projects.length, routes: config.routes.length })}\n`);
  } else if (command === "mcp-config") {
    printMcpConfig(configPath, config, connect);
  } else if (command === "daemon") {
    await runDaemon(config);
  } else {
    await runStdio(config);
  }
}

void main().catch(error => {
  process.stderr.write(`agent-broker operator fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
