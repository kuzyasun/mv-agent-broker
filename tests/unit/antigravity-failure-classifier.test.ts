import { describe, expect, it } from "vitest";
import { classifyAntigravityFailure } from "../../src/providers/antigravity/failureClassifier.ts";

describe("classifyAntigravityFailure", () => {
  it("classifies the observed current-turn quota diagnostic and valid reset suffix", () => {
    expect(classifyAntigravityFailure(
      "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54m59s.",
    )).toEqual({
      code: "QUOTA_EXHAUSTED",
      message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 54m59s.",
      retry_after_ms: 54 * 60_000 + 59_000,
    });
    expect(classifyAntigravityFailure(
      "  individual quota reached. Please upgrade your subscription. Resets in 45s.",
    )).toMatchObject({ code: "QUOTA_EXHAUSTED", retry_after_ms: 45_000 });
  });

  it("does not invent a retry delay when the quota reset suffix is absent or invalid", () => {
    for (const message of [
      "Individual quota reached. Please upgrade your subscription.",
      "Individual quota reached. Resets in 25h.",
      "Individual quota reached. Resets in 0s.",
    ]) {
      expect(classifyAntigravityFailure(message)).toEqual({ code: "QUOTA_EXHAUSTED", message });
    }
  });

  it.each([
    ["The stream was interrupted. Please continue the task you were working on.", "PROVIDER_STREAM_INTERRUPTED"],
    ["Your previous response was cut off because it exceeded the output token limit (8192 tokens).", "PROVIDER_OUTPUT_LIMIT"],
    ["API error (attempt 1): INTERNAL (code 500): Internal error encountered.", "PROVIDER_UNAVAILABLE"],
    ["API error (attempt 1): UNAVAILABLE (code 503): The service is currently unavailable.", "PROVIDER_UNAVAILABLE"],
    ["API error (attempt 1): RESOURCE_EXHAUSTED (code 429): Request rate limit exceeded.", "RATE_LIMITED"],
    ["You are not logged into Antigravity.", "AUTH_REQUIRED"],
    ["API error (attempt 2): UNAUTHENTICATED (code 401): Request had invalid authentication credentials.", "AUTH_REQUIRED"],
    [
      'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": read tcp 10.0.0.1:50000->142.250.1.1:443: wsarecv: An existing connection was forcibly closed by the remote host (connection reset)',
      "PROVIDER_NETWORK_ERROR",
    ],
    [
      'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent": read tcp 10.0.0.1:50000->142.250.1.1:443: wsarecv: A connection attempt failed because the connected party did not properly respond after a period of time, or established connection failed because connected host has failed to respond.',
      "PROVIDER_NETWORK_ERROR",
    ],
  ] as const)("classifies explicit diagnostic %s", (message, code) => {
    expect(classifyAntigravityFailure(message).code).toBe(code);
  });

  it.each([
    'The response said "Individual quota reached. Resets in 5m."',
    "Storage quota reached. Resets in 5m.",
    "The task discusses API error (attempt 1): RESOURCE_EXHAUSTED (code 429): limit.",
    "API error (attempt 1): PERMISSION_DENIED (code 429): arbitrary error.",
    "curl returned HTTP 429 Too Many Requests while running a tool.",
    "The provider said the network connection reset; the task completed anyway.",
    'API error (attempt 1): request failed: Post "https://example.test": read tcp: connection reset',
    "API error (attempt 1): INTERNAL (code 500): Internal error encountered. extra text",
  ])("does not infer a classification from non-matching prose: %s", (message) => {
    expect(classifyAntigravityFailure(message).code).toBe("PROVIDER_EXECUTION_ERROR");
  });

  it("sanitizes control characters and bounds returned detail", () => {
    const result = classifyAntigravityFailure(`failure\n${"x".repeat(1000)}`);
    expect(result.code).toBe("PROVIDER_EXECUTION_ERROR");
    expect(result.message.length).toBeLessThanOrEqual(513); // 512 chars plus truncation marker.
    expect(result.message).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
    expect(result.message.endsWith("…")).toBe(true);
  });

  it("returns a fixed generic error when no explicit native error is supplied", () => {
    expect(classifyAntigravityFailure(null)).toEqual({
      code: "PROVIDER_EXECUTION_ERROR",
      message: "Antigravity execution failed.",
    });
  });
});
