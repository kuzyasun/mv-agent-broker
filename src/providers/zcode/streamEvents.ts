/** Project native NDJSON events to fixed metadata; never retain native payloads. */
export interface ZcodeStreamEvent {
  sessionId: string;
  turnId: string;
  started: boolean;
  label: string | null;
  textDelta: boolean;
  failed: boolean;
}

export function parseZcodeStreamEvent(value: unknown): ZcodeStreamEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  if (event.deliveryKind === "replay" || typeof event.sessionId !== "string" || !/^sess_[a-zA-Z0-9_-]{1,256}$/.test(event.sessionId) ||
    typeof event.turnId !== "string" || !/^turn_[a-zA-Z0-9_-]{1,256}$/.test(event.turnId)) return null;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : {};
  let label: string | null = null;
  let textDelta = false;
  if (event.type === "turn.started") label = "status:running";
  else if (event.type === "tool.updated") {
    if (payload.kind === "started") label = "tool_call:started";
    else if (payload.kind === "result" || payload.kind === "error") label = "tool_call:completed";
  } else if (event.type === "session.updated" && typeof payload.type === "string" &&
    ["model_request_started", "model_request_completed", "model_request_failed", "model_request_retry_scheduled"].includes(payload.type)) {
    label = `status:${payload.type}`;
  } else if (event.type === "model.streaming" && payload.kind === "text_delta") {
    label = "status:text_delta";
    textDelta = true;
  }
  if (!label && event.type !== "turn.failed") return null;
  return { sessionId: event.sessionId, turnId: event.turnId, started: event.type === "turn.started", label, textDelta, failed: event.type === "turn.failed" };
}
