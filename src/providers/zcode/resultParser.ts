/** Native --json result is transport metadata; response remains agent prose. */
export interface ZcodeJsonResult {
  sessionId: string;
  response: string;
  projection?: { status: string };
}

export function parseZcodeResult(text: string): ZcodeJsonResult | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (typeof result.sessionId !== "string" || !/^sess_[a-zA-Z0-9_-]+$/.test(result.sessionId) || typeof result.response !== "string") return null;
  if (result.projection !== undefined) {
    if (result.projection === null || typeof result.projection !== "object" || Array.isArray(result.projection)) return null;
    const projection = result.projection as Record<string, unknown>;
    if (typeof projection.status !== "string") return null;
    return { sessionId: result.sessionId, response: result.response, projection: { status: projection.status } };
  }
  return { sessionId: result.sessionId, response: result.response };
}
