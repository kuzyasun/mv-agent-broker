import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { prepareCommand, resolveWindowsPowerShell } from "../../src/providers/common/headless.ts";
import { fingerprintBinaryTarget } from "../../src/providers/common/readiness.ts";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn() };
});

const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "broker-shell-"));
  roots.push(root);
  vi.stubEnv("SystemRoot", root);
  const systemShell = path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  mkdirSync(path.dirname(systemShell), { recursive: true });
  writeFileSync(systemShell, "system-shell");
  const wrapper = path.join(root, "agent.ps1");
  writeFileSync(wrapper, "# fixture wrapper\n");
  return { root, systemShell, wrapper };
}

function whereResult(filename: string) {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: filename + "\r\n", stderr: "", pid: 1, signal: null, output: [] });
}

describe.skipIf(process.platform !== "win32")("Windows wrapper shell resolution", () => {
  it("skips an unreadable WindowsApps alias and pins the same shell used for launch", () => {
    const { root, systemShell, wrapper } = fixture();
    whereResult(path.join(root, "WindowsApps", "pwsh.exe"));
    const expected = realpathSync(systemShell);
    expect(prepareCommand(wrapper, ["--version"]).command).toBe(expected);
    const fingerprint = fingerprintBinaryTarget(wrapper);
    expect(fingerprint.shell_identity).toBe(expected);
    expect(fingerprint.shell_file_bytes_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("prefers a readable PowerShell 7 executable for both launch and fingerprint", () => {
    const { root, wrapper } = fixture();
    const pwsh = path.join(root, "pwsh.exe");
    writeFileSync(pwsh, "readable-pwsh");
    whereResult(pwsh);
    expect(prepareCommand(wrapper, []).command).toBe(realpathSync(pwsh));
    expect(fingerprintBinaryTarget(wrapper).shell_identity).toBe(realpathSync(pwsh));
  });

  it("uses the system executable when where.exe cannot resolve PowerShell 7", () => {
    const { systemShell } = fixture();
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: "", stderr: "", pid: 1, signal: null, output: [] });
    expect(resolveWindowsPowerShell()).toBe(realpathSync(systemShell));
  });

  it("refuses before execution when neither shell is a readable regular file", () => {
    const { root, systemShell, wrapper } = fixture();
    rmSync(systemShell);
    mkdirSync(systemShell);
    whereResult(path.join(root, "missing-pwsh.exe"));
    expect(() => prepareCommand(wrapper, [])).toThrow(/No readable PowerShell/);
    try { fingerprintBinaryTarget(wrapper); throw new Error("Expected preflight refusal"); }
    catch (error) { expect(error).toMatchObject({ code: "PROVIDER_INCOMPATIBLE", executionStarted: false }); }
  });
});
