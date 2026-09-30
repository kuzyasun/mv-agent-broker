/**
 * Daemon and in-process bridge entry point (spec §4.1, §16.1, ADR-0003).
 * AB_ROLE selects the operational mode:
 *   - "bridge" (default, backward compat): runs in-process stdio MCP bridge.
 *   - "daemon": runs durable daemon core with private socket RPC server.
 */
import { runStdioBridge, type McpToolContext } from "../bridge/server.ts";
import { bridgeToolDefs, callBridgeTool } from "../bridge/tools.ts";
import { daemonEnvFromProcess, startDaemon } from "./bootstrap.ts";
import { startDaemonRpc } from "./rpc.ts";

async function main(): Promise<void> {
  const role = process.env.AB_ROLE ?? "bridge";
  const env = daemonEnvFromProcess(process.env);

  if (role === "bridge") {
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
  } else if (role === "daemon") {
    const daemon = await startDaemon(env);
    const rpcServer = await startDaemonRpc({
      core: daemon.core,
      coordinatorId: env.coordinatorId,
      stateDir: env.stateDir,
    });
    process.stderr.write(`agent-broker daemon listening ${rpcServer.socketPath}\n`);

    try {
      await new Promise<void>((resolve) => {
        const shutdown = () => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);
          resolve();
        };
        process.on("SIGINT", shutdown);
        process.on("SIGTERM", shutdown);
      });
    } finally {
      await rpcServer.stop();
      await daemon.core.drain();
      await daemon.executor.drain();
      await daemon.lifecycle.shutdown();
      daemon.db.close();
    }
  } else {
    process.stderr.write(`agent-broker: unknown AB_ROLE '${role}' (expected 'bridge' or 'daemon')\n`);
    process.exit(2);
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-broker fatal: ${String(err)}\n`);
  process.exit(1);
});
