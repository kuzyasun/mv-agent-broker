/**
 * Headless CLI infrastructure tests using node itself as the fake CLI —
 * no provider CLIs are executed.
 */
import { describe, expect, it } from "vitest";
import { prepareCommand, runHeadlessCli } from "../../src/providers/common/headless.ts";

const ENV: readonly string[] = ["HOME", "PATH", "TMPDIR", "SystemRoot", "ComSpec"];

function spec(overrides: Partial<Parameters<typeof runHeadlessCli>[0]> = {}) {
  return {
    binary: process.execPath,
    args: ["-e", "console.log('hello'); console.error('warn');"],
    promptStdin: "prompt-body",
    cwd: process.cwd(),
    envAllowlist: ENV,
    inheritEnv: process.env,
    firstLineTimeoutMs: 10_000,
    inactivityTimeoutMs: 10_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("runHeadlessCli", () => {
  it.skipIf(process.platform !== "win32").each([undefined, ".EXE;.COM;.CMD"])("keeps Windows executable lookup when PATHEXT is %s", async (pathext) => {
    const out: string[] = [];
    await runHeadlessCli(spec({
      args: ["-e", "console.log(process.env.PATHEXT);"],
      inheritEnv: { ...process.env, PATHEXT: pathext },
    }), { onStdoutLine: line => out.push(line), onStderrLine: () => undefined });
    expect(out).toEqual([pathext ?? ".COM;.EXE;.BAT;.CMD"]);
  });
  it("streams stdout/stderr lines and reports exit code 0", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const result = await runHeadlessCli(spec(), {
      onStdoutLine: (l) => out.push(l),
      onStderrLine: (l) => err.push(l),
    });
    expect(result.exitCode).toBe(0);
    expect(result.killed).toBe(false);
    expect(result.timedOut).toBeNull();
    expect(out).toEqual(["hello"]);
    expect(err).toEqual(["warn"]);
  });

  it("carries a non-zero exit code and stderr tail", async () => {
    const result = await runHeadlessCli(
      spec({ args: ["-e", "console.error('boom-details'); process.exit(3);"] }),
      { onStdoutLine: () => undefined, onStderrLine: () => undefined },
    );
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toContain("boom-details");
  });

  it("kills the process on a first-line timeout and reports it", async () => {
    const result = await runHeadlessCli(
      spec({
        args: ["-e", "setTimeout(() => console.log('late'), 60000);"],
        firstLineTimeoutMs: 250,
      }),
      { onStdoutLine: () => undefined, onStderrLine: () => undefined },
    );
    expect(result.timedOut).toBe("first-line");
    expect(result.killed).toBe(true);
  }, 15000);

  it("aborts via the external signal", async () => {
    const controller = new AbortController();
    const promise = runHeadlessCli(
      spec({ args: ["-e", "setTimeout(() => console.log('late'), 60000);"], signal: controller.signal }),
      { onStdoutLine: () => undefined, onStderrLine: () => undefined },
    );
    setTimeout(() => controller.abort(), 200);
    const result = await promise;
    expect(result.killed).toBe(true);
  }, 15000);

  it("skips stdin when promptArgv marks the prompt as already in args", async () => {
    const out: string[] = [];
    const result = await runHeadlessCli(
      spec({
        // The caller embedded the prompt as a positional argv token itself;
        // the infra must not write anything to stdin (closed pipe is fine).
        args: ["-e", "console.log(process.argv[1]);", "PROMPT-TOKEN"],
        promptArgv: "PROMPT-TOKEN",
        promptStdin: "",
      }),
      { onStdoutLine: (l) => out.push(l), onStderrLine: () => undefined },
    );
    expect(result.exitCode).toBe(0);
    expect(out).toEqual(["PROMPT-TOKEN"]);
  });

  it("forwards allowlisted env only", async () => {
    const out: string[] = [];
    await runHeadlessCli(
      spec({
        args: ["-e", "console.log(process.env.BROKER_TEST_SECRET === undefined ? 'absent' : 'leaked');"],
        inheritEnv: { ...process.env, BROKER_TEST_SECRET: "s3cret" } as NodeJS.ProcessEnv,
      }),
      { onStdoutLine: (l) => out.push(l), onStderrLine: () => undefined },
    );
    expect(out[0]).toBe("absent");
  });
});

describe("prepareCommand", () => {
  it("passes through a direct executable unchanged on win32 targets", () => {
    const prepared = prepareCommand("node", ["-e", "1"]);
    expect(prepared.args[0]).toBe("-e");
  });
});
