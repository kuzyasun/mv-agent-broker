import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { zcodeFailureDiagnostic } from "../../src/providers/zcode/failureDiagnostic.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "zcode-diagnostic-")); roots.push(root);
  const logs = path.join(root, "log"); mkdirSync(logs);
  return { root, logs, file: path.join(logs, "zcode-2026-10-15.jsonl") };
}

describe("ZCode retained failure detail", () => {
  it("keeps the underlying native cause instead of Turn execution failed", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ level: "error", message: "Turn execution failed", context: {
      error: { message: "Turn execution failed", underlyingErrorMessage: "project_token_request_failed" },
    } }));
    expect(zcodeFailureDiagnostic("Turn execution failed", f.logs)).toBe("project_token_request_failed");
  });
  it("extracts the latest explicit log error before cleanup without retaining request bodies", () => {
    const f = fixture();
    writeFileSync(f.file, [
      { level: "error", message: "older error" },
      { level: "error", message: "Model request failed", context: { error: { message: "project_token_login_failed" }, request: { body: "PRIVATE_REQUEST" } } },
      { level: "info", message: "shutdown complete" },
    ].map(row => JSON.stringify(row)).join("\n"));
    expect(zcodeFailureDiagnostic("generic CLI failure", f.logs)).toBe("project_token_login_failed");
    expect(readFileSync(f.file, "utf8")).toContain("PRIVATE_REQUEST");
  });

  it("uses stderr when logs are missing or contain no error and has no invented fallback", () => {
    const f = fixture();
    expect(zcodeFailureDiagnostic("Error: project_token_login_failed", path.join(f.root, "missing"))).toBe("Error: project_token_login_failed");
    writeFileSync(f.file, '{bad json}\n{"level":"info","message":"ignore"}');
    expect(zcodeFailureDiagnostic("native process failed", f.logs)).toBe("native process failed");
    expect(zcodeFailureDiagnostic("", f.logs)).toBeNull();
  });

  it("redacts plain and JSON credentials before bounding the retained detail", () => {
    const f = fixture();
    const text = 'Error: project_token_login_failed\nAuthorization: Bearer PRIVATE_AUTH\nSet-Cookie: session=PRIVATE_COOKIE\nrefresh_token="PRIVATE_REFRESH"\nZCODE_CREDENTIAL_SECRET=PRIVATE_SECRET\npassword=PRIVATE_PASSWORD';
    const detail = zcodeFailureDiagnostic(text, f.logs)!;
    expect(detail).toContain("project_token_login_failed");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toMatch(/PRIVATE_|Authorization|Set-Cookie/);
    const json = JSON.stringify({ error: { message: 'failure "refresh_token":"PRIVATE_JSON"' }, headers: { "Set-Cookie": "PRIVATE_HEADER" }, body: "PRIVATE_BODY" });
    expect(zcodeFailureDiagnostic(json, f.logs)).not.toMatch(/PRIVATE_|Set-Cookie/);
    expect(zcodeFailureDiagnostic("Invalid JWT eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwcml2YXRlIn0.private_signature", f.logs))
      .toBe("Invalid JWT [redacted]");
  });

  it("reads a bounded tail and returns only a single short sanitized error", () => {
    const f = fixture();
    writeFileSync(f.file, JSON.stringify({ level: "info", message: "x".repeat(100_000) }) + "\n" + JSON.stringify({ level: "error", message: "project_token_login_failed\n" + "y".repeat(1000) }));
    const detail = zcodeFailureDiagnostic("", f.logs)!;
    expect(detail).toMatch(/^project_token_login_failed /);
    expect(detail.length).toBeLessThanOrEqual(513);
    expect(detail).not.toMatch(/[\r\n]/);
  });
});
