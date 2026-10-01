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
  it.skipIf(process.platform !== "win32")("preserves mixed-case Windows environment keys from a plain object", async () => {
    const out: string[] = [];
    await runHeadlessCli(spec({
      args: ["-e", "console.log(JSON.stringify({path:process.env.PATH,root:process.env.SystemRoot,ext:process.env.PATHEXT,profile:process.env.USERPROFILE,secret:process.env.BROKER_TEST_SECRET}));"],
      inheritEnv: { Path: "C:\\nvm4w\\nodejs", SYSTEMROOT: process.env.SystemRoot, Pathext: ".EXE;.CMD", UserProfile: "C:\\test-profile", broker_test_secret: "private" },
      envAllowlist: [...ENV, "USERPROFILE"],
    }), { onStdoutLine: line => out.push(line), onStderrLine: () => {} });
    expect(JSON.parse(out[0]!)).toEqual({path:"C:\\nvm4w\\nodejs",root:process.env.SystemRoot,ext:".EXE;.CMD",profile:"C:\\test-profile"});
  });
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
  }, 60_000);

  it("aborts via the external signal after native readiness", async () => {
    const controller = new AbortController();
    const promise = runHeadlessCli(
      spec({ args: ["-e", "console.log('ready');setTimeout(() => console.log('late'), 60000);"], signal: controller.signal }),
      { onStdoutLine: line => { if (line === "ready") controller.abort(); }, onStderrLine: () => undefined },
    );
    const result = await promise;
    expect(result.killed).toBe(true);
  }, 60_000);

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

  it.runIf(process.platform === "win32")("emits owned_launch before native stdout on Windows job path", async () => {
    const events: string[] = [];
    const out: string[] = [];
    const result = await runHeadlessCli(
      spec({
        args: ["-e", "console.log('after-resume');"],
        firstLineTimeoutMs: 30_000,
        inactivityTimeoutMs: 30_000,
      }),
      {
        onStdoutLine: (l) => {
          events.push("stdout");
          out.push(l);
        },
        onStderrLine: () => undefined,
        onOwnershipEvent: (ev) => events.push(ev.type),
      },
    );
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(true);
    expect(result.uncertainAfterResume).toBe(false);
    expect(events[0]).toBe("owned_launch");
    expect(events).toContain("owned_resumed");
    expect(out).toContain("after-resume");
  }, 60_000);

  it.runIf(process.platform !== "win32")("Windows job integration is not silently skipped off win32", async () => {
    // Off Windows the POSIX runner is used; capability module still refuses.
    const { assertWindowsJobCapable, WindowsJobCapabilityError } = await import("../../src/providers/common/windowsJob.ts");
    expect(() => assertWindowsJobCapable()).toThrow(WindowsJobCapabilityError);
  });
});

describe("prepareCommand", () => {
  it("passes through a direct executable unchanged on win32 targets", () => {
    const prepared = prepareCommand("node", ["-e", "1"]);
    expect(prepared.args[0]).toBe("-e");
  });
});
