/**
 * stdio MCP bridge entry point (spec §4.1, §16.1).
 * Run: AB_STATE_DIR=... AB_COORDINATOR_ID=... node dist/main.js
 */
import { runStdioBridge, type McpToolContext } from "../bridge/server.ts";
import { bridgeToolDefs, callBridgeTool } from "../bridge/tools.ts";
import { daemonEnvFromProcess, startDaemon } from "./bootstrap.ts";

async function main(): Promise<void> {
  const env = daemonEnvFromProcess(process.env);
  if (!env.coordinatorId) {
    process.stderr.write("agent-broker bridge: AB_COORDINATOR_ID is required (operator-configured profile, section 4.2)\n");
    process.exit(2);
  }
  const daemon = await startDaemon(env);
  const ctx: McpToolContext = {
    listTools: () => bridgeToolDefs(),
    callTool: (name, args) =>
      callBridgeTool({ coordinatorId: env.coordinatorId, core: daemon.core }, name, args),
  };
  process.stderr.write(
    `agent-broker bridge ready (state=${daemon.lifecycle.currentState} adapters=[${[...daemon.adapters.keys()].join(",")}])\n`,
  );
  try {
    await runStdioBridge(ctx, process.stdin, process.stdout);
  } finally {
    // §4.1/§14: drain in-flight turns before releasing ownership/closing DB.
    await daemon.core.drain();
    await daemon.executor.drain();
    await daemon.lifecycle.shutdown();
    daemon.db.close();
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-broker bridge fatal: ${String(err)}\n`);
  process.exit(1);
});
