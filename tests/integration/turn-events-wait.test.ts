import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendEvent } from "../../src/storage/repo.ts";
import { callBridgeTool } from "../../src/bridge/tools.ts";
import { runStdioBridge, type McpToolContext } from "../../src/bridge/server.ts";
import { createHarness, settle, start, type Harness } from "../helpers/harness.ts";
import type { AdapterEvent } from "../../src/runtime/adapter.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDaemonRpc } from "../../src/daemon/rpc.ts";
import { DaemonRpcClient } from "../../src/bridge/rpcClient.ts";

let harnesses: Harness[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const harness of harnesses.splice(0)) harness.cleanup();
});

async function pendingTurn(harness: Harness): Promise<{ turnId: string }> {
  const session = await harness.spawnWorkerSession();
  const turn = harness.sendTask(session.session_id, "wait-turn");
  return { turnId: turn.turn_id };
}

function event(harness: Harness, turnId: string, type: string, payload: Record<string, unknown> = {}): number {
  return appendEvent(harness.db, {
    turn_id: turnId,
    session_id: null,
    type,
    payload,
    created_at: harness.clock.now(),
  });
}

describe("bounded agent_turn_events wait", () => {
  it("heartbeats a silent final-only provider without inventing RUNNING or durable progress", async () => {
    const h = createHarness(); harnesses.push(h);
    const { turnId } = await pendingTurn(h);
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    vi.spyOn(h.adapter, 'executeTurn').mockImplementation(async (_req, gate) => {
      gate.acquireDispatchPermission();
      await pending;
      return { native_outcome:'completed', native_conversation_ref:'mock-final-only', agent_reported:{summary:'final-only result',format_status:'text_only'} };
    });
    const ctx = { coordinatorId:h.seed.coordinatorId, core:h.core };
    try {
      await start(h, {turn_id:turnId});
      const before = h.core.turnEvents(h.seed.coordinatorId,turnId,0,200);
      const after = before.at(-1)!.seq;
      h.clock.advance(20_000);
      const first = await callBridgeTool(ctx,'agent_turn_events',{turn_id:turnId,after_cursor:after,wait_ms:30});
      expect(first).toEqual({events:[],next_cursor:null,heartbeat:{source:'broker',observed_at:h.clock.now(),state:'STARTING',
        execution_started:true,supervised:true,last_provider_event_at:null,deadline_at:h.core.turnStatus(h.seed.coordinatorId,turnId).deadline_at,next_action:'wait'}});
      h.clock.advance(20_000);
      const second = await callBridgeTool(ctx,'agent_turn_events',{turn_id:turnId,after_cursor:after}) as {heartbeat:{observed_at:number}};
      expect(second.heartbeat.observed_at).toBe(h.clock.now());
      expect(second.heartbeat.observed_at).toBeGreaterThan((first as typeof second).heartbeat.observed_at);
      expect(h.core.turnEvents(h.seed.coordinatorId,turnId,0,200)).toEqual(before);
      expect(await callBridgeTool(ctx,'agent_turn_status',{turn_id:turnId})).toMatchObject({state:'STARTING',heartbeat:second.heartbeat});
      finish(); await settle(h);
      const last = h.core.turnEvents(h.seed.coordinatorId,turnId,0,200).at(-1)!.seq;
      expect(await callBridgeTool(ctx,'agent_turn_events',{turn_id:turnId,after_cursor:last,wait_ms:20_000}))
        .toMatchObject({events:[],heartbeat:{state:'SUCCEEDED',supervised:false,next_action:'read_result'}});
    } finally { finish(); await settle(h); }
  });

  it("keeps a real provider activity timestamp while ownership receipts and polls remain silent", async () => {
    const h = createHarness(); harnesses.push(h);
    const {turnId} = await pendingTurn(h);
    let finish!: () => void;
    let emit!: (event:AdapterEvent) => void;
    const pending = new Promise<void>(resolve => {finish=resolve;});
    vi.spyOn(h.adapter,'executeTurn').mockImplementation(async (_req,gate,onEvent) => {
      gate.acquireDispatchPermission(); emit=onEvent; await pending;
      return {native_outcome:'completed',native_conversation_ref:'mock-progress'};
    });
    const ctx = {coordinatorId:h.seed.coordinatorId,core:h.core};
    try {
      await start(h,{turn_id:turnId});
      h.clock.advance(1000);
      emit({type:'progress',payload:{label:'status:running'}});
      const nativeAt = h.clock.now();
      h.clock.advance(5000);
      event(h,turnId,'adapter:owned_resumed');
      const after = h.core.turnEvents(h.seed.coordinatorId,turnId,0,200).at(-1)!.seq;
      expect(await callBridgeTool(ctx,'agent_turn_events',{turn_id:turnId,after_cursor:after,wait_ms:20}))
        .toMatchObject({events:[],heartbeat:{state:'RUNNING',supervised:true,last_provider_event_at:nativeAt,next_action:'wait'}});
    } finally {finish();await settle(h);}
  });

  it.each(['UNKNOWN','STARTING','RUNNING'])("advises inspection rather than ongoing progress for an unsupervised %s turn", async state => {
    const h=createHarness();harnesses.push(h);
    const {turnId}=await pendingTurn(h);
    h.db.raw.prepare('UPDATE turns SET state=? WHERE turn_id=?').run(state,turnId);
    expect(await callBridgeTool({coordinatorId:h.seed.coordinatorId,core:h.core},'agent_turn_events',{turn_id:turnId}))
      .toMatchObject({heartbeat:{state,supervised:false,next_action:'inspect'}});
  });

  it("reports the current heartbeat without advancing a paginated durable cursor", async () => {
    const h=createHarness();harnesses.push(h);
    const {turnId}=await pendingTurn(h);
    const first=event(h,turnId,'adapter:progress',{label:'status:running'});
    h.clock.advance(1000);
    event(h,turnId,'adapter:progress',{label:'tool_call:started'});
    const page=await callBridgeTool({coordinatorId:h.seed.coordinatorId,core:h.core},'agent_turn_events',{turn_id:turnId,after_cursor:first-1,limit:1});
    expect(page).toMatchObject({events:[{cursor:first}],next_cursor:String(first),heartbeat:{last_provider_event_at:h.clock.now(),state:'ACCEPTED',supervised:false,next_action:'wait'}});
    h.clock.set(h.core.turnStatus(h.seed.coordinatorId,turnId).deadline_at);
    expect(await callBridgeTool({coordinatorId:h.seed.coordinatorId,core:h.core},'agent_turn_status',{turn_id:turnId}))
      .toMatchObject({heartbeat:{next_action:'inspect'}});
    await expect(callBridgeTool({coordinatorId:h.seed.outsiderId,core:h.core},'agent_turn_status',{turn_id:turnId}))
      .rejects.toMatchObject({code:'UNAUTHORIZED'});
  });

  it("validates wait_ms and returns existing events immediately", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const { turnId } = await pendingTurn(harness);
    const after = harness.core.turnEvents(harness.seed.coordinatorId, turnId, 0, 200).at(-1)?.seq ?? 0;
    const cursor = event(harness, turnId, "progress", { step: 1 });

    await expect(callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, wait_ms: 20_001 },
    )).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    const page = await callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: after, limit: 1, wait_ms: 20_000 },
    ) as { events: Array<{ cursor: number; type: string }> };
    expect(page.events).toEqual([{ cursor, type: "progress", payload: { step: 1 }, created_at: harness.clock.now() }]);
  });

  it("times out empty, wakes on a committed event, and rechecks ACL", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const { turnId } = await pendingTurn(harness);
    const after = harness.core.turnEvents(harness.seed.coordinatorId, turnId, 0, 200).at(-1)?.seq ?? 0;
    const started = Date.now();
    const empty = await callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: after, wait_ms: 40 },
    ) as { events: unknown[] };
    expect(empty.events).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);

    const waking = callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: after, wait_ms: 1_000 },
    ) as Promise<{ events: Array<{ cursor: number; type: string }> }>;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const cursor = event(harness, turnId, "committed", { ok: true });
    await expect(waking).resolves.toMatchObject({ events: [{ cursor, type: "committed" }] });

    const revoked = callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: cursor, wait_ms: 1_000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    harness.db.raw.prepare("UPDATE coordinator_profiles SET revoked = 1 WHERE coordinator_id = ?")
      .run(harness.seed.coordinatorId);
    await expect(revoked).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("returns terminal events immediately and then an empty prompt page", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const { turnId } = await pendingTurn(harness);
    const after = harness.core.turnEvents(harness.seed.coordinatorId, turnId, 0, 200).at(-1)?.seq ?? 0;
    harness.db.raw.prepare("UPDATE turns SET state = 'SUCCEEDED', terminal_at = ? WHERE turn_id = ?")
      .run(harness.clock.now(), turnId);
    const finalCursor = event(harness, turnId, "turn_terminal", { state: "SUCCEEDED" });

    const finalPage = await callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: after, wait_ms: 20_000 },
    ) as { events: Array<{ cursor: number; type: string }> };
    expect(finalPage.events).toEqual([expect.objectContaining({ cursor: finalCursor, type: "turn_terminal" })]);

    const started = Date.now();
    const emptyPage = await callBridgeTool(
      { coordinatorId: harness.seed.coordinatorId, core: harness.core },
      "agent_turn_events",
      { turn_id: turnId, after_cursor: finalCursor, wait_ms: 20_000 },
    ) as { events: unknown[] };
    expect(emptyPage.events).toEqual([]);
    expect(Date.now() - started).toBeLessThan(100);
  });

  it("runs a positive event wait concurrently with ordinary stdio requests", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const wait = new Promise<void>(() => {});
    const responses: Array<Record<string, unknown>> = [];
    const context: McpToolContext = {
      listTools: () => [],
      callTool: async (name, _args, signal) => {
        if (name === "agent_turn_events") {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => reject(new Error("aborted"));
            signal?.addEventListener("abort", onAbort, { once: true });
            wait.then(() => {
              signal?.removeEventListener("abort", onAbort);
              resolve();
            });
          });
          return { events: [] };
        }
        return { state: "RUNNING" };
      },
    };
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      for (const line of chunk.trim().split("\n").filter(Boolean)) responses.push(JSON.parse(line) as Record<string, unknown>);
    });

    const bridge = runStdioBridge(context, input, output);
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "agent_turn_events", arguments: { turn_id: "t", wait_ms: 20_000 } },
    })}\n`);
    input.write(`${JSON.stringify({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "agent_turn_status", arguments: { turn_id: "t" } },
    })}\n`);

    await new Promise<void>((resolve) => {
      const check = () => responses.some((response) => response.id === 2) ? resolve() : setTimeout(check, 5);
      check();
    });
    expect(responses.find((response) => response.id === 2)?.result).toBeDefined();
    input.end();
    await bridge;
  });

  it("keeps same-connection RPC status and cancel responsive, and aborts reads on disconnect/shutdown", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const {turnId} = await pendingTurn(harness);
    const after = harness.core.turnEvents(harness.seed.coordinatorId, turnId, 0, 200).at(-1)?.seq ?? 0;
    const stateDir = mkdtempSync(path.join(tmpdir(), "ab-event-wait-rpc-"));
    const server = await startDaemonRpc({core:harness.core, coordinatorId:harness.seed.coordinatorId, stateDir, token:"event-wait-test"});
    const client = new DaemonRpcClient(server.socketPath, "event-wait-test");
    try {
      await client.connect(harness.seed.coordinatorId);
      const waiting = client.call("agent_turn_events", {turn_id:turnId, after_cursor:after, wait_ms:20_000});
      const status = await client.call("agent_turn_status", {turn_id:turnId}) as {state:string};
      expect(status.state).toBe("ACCEPTED");
      const cancelled = await client.call("agent_turn_cancel", {turn_id:turnId, idempotency_key:"wait-test-cancel"}) as {state:string};
      expect(["CANCELLING","CANCELLED"]).toContain(cancelled.state);
      await expect(waiting).resolves.toMatchObject({events:expect.arrayContaining([expect.objectContaining({type:expect.stringMatching(/cancel|terminal/)})])});

      // A second unexecuted turn lets disconnect exercise a real outstanding wait.
      harness.executor.startTurn(turnId);
      await harness.core.drain();
      await harness.executor.drain();
      const second = harness.sendTask(harness.core.turnStatus(harness.seed.coordinatorId, turnId).session_id, "wait-disconnect");
      const cursor = harness.core.turnEvents(harness.seed.coordinatorId, second.turn_id, 0, 200).at(-1)?.seq ?? 0;
      const abandonedRead = client.call("agent_turn_events", {turn_id:second.turn_id, after_cursor:cursor, wait_ms:20_000});
      const rejectedRead = expect(abandonedRead).rejects.toThrow();
      await client.call("agent_turn_status", {turn_id:second.turn_id});
      client.close();
      await rejectedRead;
      const stopped = Date.now();
      await server.stop();
      expect(Date.now()-stopped).toBeLessThan(1_000);
      expect(harness.core.turnStatus(harness.seed.coordinatorId, second.turn_id).state).toBe("ACCEPTED");
    } finally {
      client.close();
      await server.stop();
      rmSync(stateDir,{recursive:true,force:true});
    }
  }, 8_000);

  it("keeps real stdio status/cancel responsive during a core wait and drains EOF read waits", async () => {
    const harness = createHarness();
    harnesses.push(harness);
    const {turnId} = await pendingTurn(harness);
    const after = harness.core.turnEvents(harness.seed.coordinatorId, turnId, 0, 200).at(-1)?.seq ?? 0;
    const input = new PassThrough();
    const output = new PassThrough();
    const replies = new Map<number, Record<string,unknown>>();
    const deadlines = new Set<ReturnType<typeof setTimeout>>();
    const listeners = new Map<number,(reply:Record<string,unknown>)=>void>();
    output.setEncoding("utf8");
    output.on("data", (chunk:string) => {
      for (const line of chunk.trim().split("\n").filter(Boolean)) {
        const reply = JSON.parse(line) as Record<string,unknown>;
        replies.set(Number(reply.id),reply); listeners.get(Number(reply.id))?.(reply);
      }
    });
    const context:McpToolContext={listTools:()=>[],callTool:(name,args,signal)=>callBridgeTool({core:harness.core,coordinatorId:harness.seed.coordinatorId,signal},name,args)};
    const bridge=runStdioBridge(context,input,output);
    const send=(id:number,name:string,args:Record<string,unknown>)=>input.write(JSON.stringify({jsonrpc:"2.0",id,method:"tools/call",params:{name,arguments:args}})+"\n");
    const response=(id:number)=>new Promise<Record<string,unknown>>((resolve,reject)=>{
      if(replies.has(id)){resolve(replies.get(id)!);return;}
      const timeout=setTimeout(()=>{deadlines.delete(timeout);reject(new Error("stdio response timeout"));},1_000);
      deadlines.add(timeout); listeners.set(id,reply=>{clearTimeout(timeout);deadlines.delete(timeout);listeners.delete(id);resolve(reply);});
    });
    try {
      send(1,"agent_turn_events",{turn_id:turnId,after_cursor:after,wait_ms:20_000});
      send(2,"agent_turn_status",{turn_id:turnId});
      expect((await response(2)).result).toBeDefined();
      expect(replies.has(1)).toBe(false);
      send(3,"agent_turn_cancel",{turn_id:turnId,idempotency_key:"stdio-wait-cancel"});
      expect((await response(3)).result).toBeDefined();
      expect((await response(1)).result).toBeDefined();
      harness.executor.startTurn(turnId);
      await harness.core.drain(); await harness.executor.drain();
      const second=harness.sendTask(harness.core.turnStatus(harness.seed.coordinatorId,turnId).session_id,"stdio-eof-wait");
      const cursor=harness.core.turnEvents(harness.seed.coordinatorId,second.turn_id,0,200).at(-1)?.seq ?? 0;
      send(4,"agent_turn_events",{turn_id:second.turn_id,after_cursor:cursor,wait_ms:20_000});
      send(5,"agent_turn_status",{turn_id:second.turn_id});
      await response(5);
      output.end(); input.end();
      await bridge;
      expect(harness.core.turnStatus(harness.seed.coordinatorId,second.turn_id).state).toBe("ACCEPTED");
    } finally {
      for(const timeout of deadlines)clearTimeout(timeout);
      input.end(); await bridge;
    }
  }, 8_000);
});
