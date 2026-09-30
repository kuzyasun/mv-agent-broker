/**
 * Pure parsers for Claude Code stream-json line events and hook payloads.
 */

export type ClaudeStreamEvent =
  | { kind: "init"; session_id: string }
  | { kind: "session_ref"; session_id: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "result"; session_id: string | null; text: string; is_error: boolean }
  | { kind: "unknown" };

export function parseClaudeStreamLine(line: string): ClaudeStreamEvent {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { kind: "unknown" };
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { kind: "unknown" };
    }

    const obj = parsed as Record<string, unknown>;

    // Native startup hooks can expose identity before system/init (§14.3).
    if (obj.type === "system" && typeof obj.subtype === "string" &&
        ["hook_started", "hook_progress", "hook_response", "commands_changed"].includes(obj.subtype) &&
        typeof obj.session_id === "string" && obj.session_id.trim()) {
      return { kind: "session_ref", session_id: obj.session_id };
    }

    // Init: {"type":"system","subtype":"init","session_id":"..."}
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string" &&
      obj.session_id.trim().length > 0
    ) {
      return { kind: "init", session_id: obj.session_id };
    }

    // Assistant: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
    if (obj.type === "assistant" && obj.message && typeof obj.message === "object") {
      const msg = obj.message as Record<string, unknown>;
      if (Array.isArray(msg.content)) {
        const textParts: string[] = [];
        for (const item of msg.content) {
          if (item && typeof item === "object") {
            const block = item as Record<string, unknown>;
            if (block.type === "text" && typeof block.text === "string") {
              textParts.push(block.text);
            }
          }
        }
        if (textParts.length > 0) {
          return { kind: "assistant_text", text: textParts.join("") };
        }
      } else if (typeof msg.content === "string") {
        return { kind: "assistant_text", text: msg.content };
      }
    }

    // Result: {"type":"result","subtype":"success"|"error_*","result":"text","is_error":false}
    if (obj.type === "result") {
      // Fail closed for unknown success shapes; native error records may use errors[].
      const errorSubtype = typeof obj.subtype === "string" && obj.subtype.startsWith("error");
      const isError = obj.is_error === true || errorSubtype;
      if (!isError && (obj.is_error !== false || typeof obj.result !== "string" || obj.subtype !== "success")) {
        return { kind: "unknown" };
      }
      const text = typeof obj.result === "string" ? obj.result
        : Array.isArray(obj.errors) ? obj.errors.filter((item): item is string => typeof item === "string").join("\n") : "";
      const sessionId = typeof obj.session_id === "string" && obj.session_id.trim() ? obj.session_id : null;
      return { kind: "result", session_id: sessionId, text, is_error: isError };
    }

    return { kind: "unknown" };
  } catch {
    return { kind: "unknown" };
  }
}

export function parseHookPayload(
  json: string,
): { event: string; session_id: string | null; stop_reason: string | null } | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const event =
      typeof obj.hook_event_name === "string"
        ? obj.hook_event_name
        : typeof obj.event === "string"
          ? obj.event
          : null;

    if (!event) {
      return null;
    }

    const sessionId = typeof obj.session_id === "string" ? obj.session_id : null;
    const stopReason = typeof obj.stop_reason === "string" ? obj.stop_reason : null;

    return {
      event,
      session_id: sessionId,
      stop_reason: stopReason,
    };
  } catch {
    return null;
  }
}

const NON_TERMINAL_STOP_RE = /error|fail|abort|cancel|interrupt/i;

export function isTerminalStop(stopReason: string | null): boolean {
  if (stopReason === null) {
    return true;
  }
  return !NON_TERMINAL_STOP_RE.test(stopReason);
}
