import { describe, expect, it, vi } from "vitest";
import { runMetadataProbeWithFailFastRetry, type MetadataProbeResult } from "../../src/providers/common/readiness.ts";

const spec = { binary: "pinned-cursor", argv: ["--list-models"], cwd: ".", envAllowlist: [] };
const success: MetadataProbeResult = { ok: true, exitCode: 0, stdout: "grok-4.7-high - Grok", detail: "" };
const failFast: MetadataProbeResult = { ok: false, exitCode: 3221226505, stdout: "untrusted partial output", detail: "exit 3221226505" };

describe("bounded metadata-only Windows fail-fast recovery", () => {
  it.each([3221226505, -1073740791])("uses only the fresh successful response after exit %s", (exitCode) => {
    const probe = vi.fn().mockReturnValueOnce({ ...failFast, exitCode }).mockReturnValueOnce(success);
    expect(runMetadataProbeWithFailFastRetry(spec, probe)).toEqual({ ...success, attempts: 2 });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls.every(call => call[0] === spec)).toBe(true);
  });

  it("stops after the second failure with bounded crash context, never a catalog fallback", () => {
    const probe = vi.fn().mockReturnValue(failFast);
    const result = runMetadataProbeWithFailFastRetry(spec, probe);
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.detail).toContain("0xC0000409");
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it.each([1, null])("does not retry an ordinary failure or timeout (%s)", (exitCode) => {
    const probe = vi.fn().mockReturnValue({ ...failFast, exitCode, detail: "ordinary failure" });
    expect(runMetadataProbeWithFailFastRetry(spec, probe)).toMatchObject({ ok: false, attempts: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not retry a successful probe", () => {
    const probe = vi.fn().mockReturnValue(success);
    expect(runMetadataProbeWithFailFastRetry(spec, probe)).toEqual({ ...success, attempts: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("rejects inference arguments before any attempt", () => {
    const probe = vi.fn();
    expect(() => runMetadataProbeWithFailFastRetry({ ...spec, argv: ["--print"] }, probe)).toThrow(/metadata probe argv rejected/);
    expect(probe).not.toHaveBeenCalled();
  });
});
