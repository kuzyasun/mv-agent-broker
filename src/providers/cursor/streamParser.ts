/**
 * Stream JSON parser for the Cursor agent CLI.
 *
 * Emits typed events from line-delimited JSON stream output.
 */

export type CursorStreamEvent =
  | { kind: "init"; session_id: string; model: string | null }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; subtype: string }
  | { kind: "result"; session_id: string | null; text: string; is_error: boolean; usage: unknown }
  | { kind: "unknown" };

export interface CursorTurnSummary {
  sessionId: string | null;
  assistantText: string;
  resultText: string | null;
  isError: boolean;
  sawResult: boolean;
}

export function parseCursorStreamLine(line: string): CursorStreamEvent {
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
  const type = obj.type;

  if (type === "system") {
    if (obj.subtype === "init" && typeof obj.session_id === "string") {
      return {
        kind: "init",
        session_id: obj.session_id,
        model: typeof obj.model === "string" ? obj.model : null,
      };
    }
    return { kind: "unknown" };
  }

  if (type === "thinking") {
    if (typeof obj.text === "string") {
      return { kind: "thinking", text: obj.text };
    }
    return { kind: "unknown" };
  }

  if (type === "assistant") {
    if (obj.message && typeof obj.message === "object") {
      const msg = obj.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        const pieces: string[] = [];
        for (const item of msg.content) {
          if (item && typeof item === "object") {
            const part = item as Record<string, unknown>;
            if (part.type === "text" && typeof part.text === "string") {
              pieces.push(part.text);
            }
          }
        }
        if (pieces.length > 0) {
          return { kind: "assistant_text", text: pieces.join("") };
        }
      } else if (typeof msg.content === "string") {
        return { kind: "assistant_text", text: msg.content };
      }
    }
    return { kind: "unknown" };
  }

  if (type === "tool_call") {
    const subtype = typeof obj.subtype === "string" ? obj.subtype : "";
    return { kind: "tool_call", subtype };
  }

  if (type === "result") {
    const sessionId = typeof obj.session_id === "string" ? obj.session_id : null;
    const text = typeof obj.result === "string" ? obj.result : "";
    const isError = obj.is_error === true;
    const usage = obj.usage ?? null;
    return {
      kind: "result",
      session_id: sessionId,
      text,
      is_error: isError,
      usage,
    };
  }

  return { kind: "unknown" };
}

export function summarizeCursorTurn(events: CursorStreamEvent[]): CursorTurnSummary {
  let sessionId: string | null = null;
  let assistantText = "";
  let resultText: string | null = null;
  let isError = false;
  let sawResult = false;

  for (const ev of events) {
    switch (ev.kind) {
      case "init":
        if (sessionId === null) {
          sessionId = ev.session_id;
        }
        break;
      case "assistant_text":
        assistantText += ev.text;
        break;
      case "result":
        sawResult = true;
        if (sessionId === null && ev.session_id !== null) {
          sessionId = ev.session_id;
        }
        resultText = ev.text;
        isError = ev.is_error;
        break;
      case "thinking":
      case "tool_call":
      case "unknown":
        break;
    }
  }

  return {
    sessionId,
    assistantText,
    resultText,
    isError,
    sawResult,
  };
}
