import { spawn } from "node:child_process";
import readline from "node:readline";
import { MCP_PROTOCOL_VERSION } from "../../src/bridge/protocol.ts";

export async function installedBrokerStatus(definition: { command: string; args: string[]; env?: Record<string, string> }): Promise<Record<string, unknown>> {
  const child = spawn(definition.command, definition.args, {
    env: { ...process.env, ...definition.env }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = readline.createInterface({ input: child.stdout });
  let sequence = 0;
  let stderr = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  child.stderr.on("data", chunk => { stderr += chunk; });
  const fail = (error: Error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); };
  child.on("error", fail);
  child.on("exit", () => fail(new Error("MCP bridge exited: " + stderr)));
  lines.on("line", line => {
    const message = JSON.parse(line);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  });
  const request = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("MCP timeout: " + method + " " + stderr)); }, 10000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  try {
    await request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "package-smoke", version: "1" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request("tools/list", {});
    if (!tools.tools.some((tool: { name: string }) => tool.name === "broker_status")) throw new Error("Installed MCP has no broker_status.");
    const result = await request("tools/call", { name: "broker_status", arguments: {} });
    return JSON.parse(result.content.find((item: { type: string }) => item.type === "text").text);
  } finally {
    child.stdin.end();
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
    lines.close();
    fail(new Error("MCP smoke closed."));
  }
}
