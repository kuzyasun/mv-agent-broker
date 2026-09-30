/** Pure parser for codex exec --json. Unknown future event types are ignored. */
export type CodexStreamEvent =
  | { kind: "thread"; ref: string }
  | { kind: "message"; text: string }
  | { kind: "complete" }
  | { kind: "failure"; message: string }
  | { kind: "unknown" };

export function parseCodexStreamLine(line: string): CodexStreamEvent {
  let ev: unknown;
  try { ev = JSON.parse(line); } catch { return { kind: "unknown" }; }
  if (!ev || typeof ev !== "object" || Array.isArray(ev)) return { kind: "unknown" };
  const record = ev as Record<string, unknown>;
  if (record.type === "thread.started") {
    return typeof record.thread_id === "string" && record.thread_id.trim()
      ? { kind: "thread", ref: record.thread_id }
      : { kind: "failure", message: "Codex thread.started has no valid thread_id." };
  }
  if (record.type === "turn.completed") return { kind: "complete" };
  if (record.type === "turn.failed" || record.type === "error") {
    const error = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : record;
    return { kind: "failure", message: typeof error.message === "string" && error.message ? error.message : "Codex reported a failed turn." };
  }
  if (record.type === "item.completed" && record.item && typeof record.item === "object") {
    const item = record.item as Record<string, unknown>;
    if (item.type === "agent_message") {
      return typeof item.text === "string" ? { kind: "message", text: item.text }
        : { kind: "failure", message: "Codex agent_message has no text." };
    }
  }
  return { kind: "unknown" };
}
