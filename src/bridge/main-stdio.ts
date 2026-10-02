/**
 * Out-of-process MCP stdio bridge entry point (spec §4.1).
 * Connects to a running daemon via local private socket/named pipe.
 * Does NOT start a daemon implicitly.
 */
import { runStdioBridge, type McpToolContext, type McpToolDef } from "./server.ts";
import { DaemonRpcClient, DaemonRpcError } from "./rpcClient.ts";
import { readBridgeToken, socketPathFor } from "../daemon/rpc.ts";

async function main(): Promise<void> {
  const stateDir = process.env.AB_STATE_DIR ?? "./.agent-broker-state";
  const coordinatorId = process.env.AB_COORDINATOR_ID ?? "";
  if (!coordinatorId) {
    process.stderr.write(
      "agent-broker bridge: AB_COORDINATOR_ID is required (operator-configured profile, section 4.2)\n",
    );
    process.exit(2);
  }

  const socketPath = socketPathFor(stateDir);
  let client: DaemonRpcClient;
  try {
    client = new DaemonRpcClient(socketPath, () => readBridgeToken(stateDir));
    await client.connect(coordinatorId);
  } catch (err: unknown) {
    if (err instanceof DaemonRpcError && err.code === "UNAUTHORIZED") {
      process.stderr.write(`agent-broker bridge: authentication failed: ${err.message}\n`);
      process.exit(2);
    }
    process.stderr.write(
      `agent-broker bridge: daemon not reachable at ${socketPath} (start the daemon first)\n`,
    );
    process.exit(3);
  }

  process.stderr.write(
    `agent-broker bridge ready (coordinator=${coordinatorId} socket=${socketPath})\n`,
  );

  const ctx: McpToolContext = {
    listTools: async () => {
      await client.connectAndHandshake(coordinatorId);
      const res = (await client.listTools()) as { tools: McpToolDef[] };
      return res.tools;
    },
    callTool: async (name, args) => {
      await client.connectAndHandshake(coordinatorId);
      return client.call(name, args);
    },
  };

  try {
    await runStdioBridge(ctx, process.stdin, process.stdout);
  } finally {
    client.close();
  }
}

void main().catch((err) => {
  process.stderr.write(`agent-broker bridge fatal: ${String(err)}\n`);
  process.exit(1);
});
