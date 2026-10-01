/**
 * Stream JSON parser for the Antigravity agent CLI (`agy`).
 *
 * Emits typed events from line-delimited JSON stream output.
 */

export type AntigravityStreamEvent =
  | { kind: "text_delta"; text: string; conversation_id?: string }
  | {
      kind: "result";
      status: "SUCCESS" | "FAILED" | string;
      response: string | null;
      error: string | null;
      conversation_id?: string;
    }
  | { kind: "conversation_id"; id: string }
  | { kind: "unknown" };

export interface AntigravityTurnSummary {
  conversationId: string | null;
  text: string;
  response: string | null;
  status: string | null;
  error: string | null;
  sawResult: boolean;
}

const CONVERSATION_ID_KEYS = ["conversationId", "conversation_id", "session_id"] as const;

function findConversationId(obj: Record<string, unknown>): string | null {
  // 1. Top-level keys: conversationId, conversation_id, session_id
  for (const key of CONVERSATION_ID_KEYS) {
    const val = obj[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }

  // 2. Nested result object: conversationId, conversation_id, session_id
  if (obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)) {
    const res = obj.result as Record<string, unknown>;
    for (const key of CONVERSATION_ID_KEYS) {
      const val = res[key];
      if (typeof val === "string" && val.trim().length > 0) {
        return val.trim();
      }
    }
  }

  // 3. Nested step_update object: conversationId, conversation_id, session_id
  if (obj.step_update && typeof obj.step_update === "object" && !Array.isArray(obj.step_update)) {
    const su = obj.step_update as Record<string, unknown>;
    for (const key of CONVERSATION_ID_KEYS) {
      const val = su[key];
      if (typeof val === "string" && val.trim().length > 0) {
        return val.trim();
      }
    }
  }

  return null;
}

export function parseAntigravityStreamLine(line: string): AntigravityStreamEvent {
  const trimmed = line.trim();
  if (!trimmed) {
    return { kind: "unknown" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: "unknown" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unknown" };
  }

  const obj = parsed as Record<string, unknown>;
  const observedId = findConversationId(obj);

  // Check for step_update text_delta (may also carry an observed conversation id).
  if (obj.event === "step_update" && obj.step_update && typeof obj.step_update === "object" && !Array.isArray(obj.step_update)) {
    const su = obj.step_update as Record<string, unknown>;
    if (typeof su.text_delta === "string") {
      return observedId !== null
        ? { kind: "text_delta", text: su.text_delta, conversation_id: observedId }
        : { kind: "text_delta", text: su.text_delta };
    }
  }

  // Check for result turn settle — preserve declared final result AND observed ID
  // from the same record (do not return result before ID extraction).
  if (obj.event === "result" && obj.result && typeof obj.result === "object" && !Array.isArray(obj.result)) {
    const res = obj.result as Record<string, unknown>;
    if (typeof res.status === "string") {
      return {
        kind: "result",
        status: res.status,
        response: typeof res.response === "string" ? res.response : null,
        error: typeof res.error === "string" ? res.error : null,
        ...(observedId !== null ? { conversation_id: observedId } : {}),
      };
    }
  }

  // Check for conversation id (top-level or nested in result / step_update)
  if (observedId !== null) {
    return { kind: "conversation_id", id: observedId };
  }

  return { kind: "unknown" };
}

export function summarizeAntigravityTurn(events: AntigravityStreamEvent[]): AntigravityTurnSummary {
  let conversationId: string | null = null;
  let text = "";
  let response: string | null = null;
  let status: string | null = null;
  let error: string | null = null;
  let sawResult = false;

  const noteId = (id: string | undefined) => {
    if (conversationId === null && id && id.trim().length > 0) {
      conversationId = id.trim();
    }
  };

  for (const ev of events) {
    switch (ev.kind) {
      case "text_delta":
        text += ev.text;
        noteId(ev.conversation_id);
        break;
      case "conversation_id":
        noteId(ev.id);
        break;
      case "result":
        sawResult = true;
        status = ev.status;
        response = ev.response;
        error = ev.error;
        noteId(ev.conversation_id);
        break;
      case "unknown":
        break;
    }
  }

  return {
    conversationId,
    text,
    response,
    status,
    error,
    sawResult,
  };
}
