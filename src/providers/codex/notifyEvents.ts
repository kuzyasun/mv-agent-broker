/**
 * Pure parser for Codex notify CLI payloads.
 */

export interface CodexNotifyPayload {
  type: string;
  threadId: string | null;
  turnId: string | null;
  lastAssistantMessage: string | null;
  cwd: string | null;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return null;
}

function pickMessage(obj: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string") {
      return v;
    }
  }
  return null;
}

export function parseCodexNotify(argvJson: string): CodexNotifyPayload | null {
  const trimmed = argvJson.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }

  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  const threadId = pickString(obj, ["thread-id", "thread_id", "threadId"]);
  const turnId = pickString(obj, ["turn-id", "turn_id", "turnId"]);
  const lastAssistantMessage = pickMessage(obj, [
    "last-assistant-message",
    "last_assistant_message",
    "lastAssistantMessage",
  ]);
  const cwd = typeof obj.cwd === "string" && obj.cwd.length > 0 ? obj.cwd : null;

  return {
    type,
    threadId,
    turnId,
    lastAssistantMessage,
    cwd,
  };
}

export function isTurnComplete(p: CodexNotifyPayload | null): boolean {
  return p?.type === "agent-turn-complete";
}
