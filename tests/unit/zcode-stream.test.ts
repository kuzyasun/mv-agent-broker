import { describe, expect, it } from "vitest";
import { parseZcodeStreamEvent } from "../../src/providers/zcode/streamEvents.ts";
import { sanitizeAdapterEvent } from "../../src/runtime/adapter.ts";

describe("ZCode native stream projection", () => {
  const envelope = { sessionId: "sess_current", turnId: "turn_current", eventId: "private", traceId: "private" };
  it.each([
    ["turn.started", { prompt: "PRIVATE" }, "status:running"],
    ["tool.updated", { kind: "started", input: "PRIVATE" }, "tool_call:started"],
    ["tool.updated", { kind: "result", output: "PRIVATE" }, "tool_call:completed"],
    ["tool.updated", { kind: "error", message: "PRIVATE" }, "tool_call:completed"],
    ["session.updated", { type: "model_request_completed", details: "PRIVATE" }, "status:model_request_completed"],
    ["model.streaming", { kind: "text_delta", text: "PRIVATE" }, "status:text_delta"],
  ])("projects %s to fixed metadata accepted by the core", (type, payload, label) => {
    const event = parseZcodeStreamEvent({ ...envelope, type, payload });
    expect(event).toMatchObject({sessionId:"sess_current", turnId:"turn_current", label});
    expect(JSON.stringify(event)).not.toMatch(/PRIVATE|private/);
    expect(sanitizeAdapterEvent({ type: "progress", payload: { label: event!.label } })).toEqual({type:"progress", payload:{label}});
  });
  it.each([
    {type:"model.streaming", payload:{kind:"reasoning_delta", text:"PRIVATE"}},
    {type:"session.updated", payload:{type:"PRIVATE"}},
    {type:"tool.updated", payload:{kind:"progress", text:"PRIVATE"}},
    {type:"turn.started", deliveryKind:"replay"},
    {type:"turn.started", sessionId:"PRIVATE"},
    {type:"turn.started", turnId:null},
    {type:"unknown", payload:{text:"PRIVATE"}},
  ])("drops replay, reasoning and unsupported envelopes %j", event => {
    expect(parseZcodeStreamEvent({...envelope, ...event})).toBeNull();
  });
  it("exposes terminal failure identity without retaining its private error", () => {
    expect(parseZcodeStreamEvent({...envelope, type:"turn.failed", payload:{error:{message:"PRIVATE"}}}))
      .toEqual({sessionId:"sess_current", turnId:"turn_current", started:false, label:null, textDelta:false, failed:true});
  });
});
