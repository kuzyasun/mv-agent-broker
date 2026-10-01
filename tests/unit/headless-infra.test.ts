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
  it.each(["stdout", "stderr"])("active %s chunks without newlines do not trigger false inactivity", async (channel) => {
    const out: string[] = [];
    const err: string[] = [];
    const script = `const stream = process.${channel}; ${channel === "stderr" ? "process.stdout.write('ready\\n');" : ""}
      stream.write('x'); let count=0; const tick=setInterval(()=>{stream.write('x'); if(++count===8) clearInterval(tick);},75);`;
    const result = await runHeadlessCli(spec({ args: ["-e", script], firstLineTimeoutMs: 500, inactivityTimeoutMs: 200 }),
      { onStdoutLine: line => out.push(line), onStderrLine: line => err.push(line) });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeNull();
    expect(channel === "stdout" ? out : err).toContain("x".repeat(9));
    if (process.platform === "win32") expect(result.quiesced).toBe(true);
  }, 30_000);
  it.skipIf(process.platform !== "win32").each([undefined, "D:"])("preserves structural SystemDrive without ambient secrets (%s)", async (drive) => {
    const out: string[] = [];
    const result = await runHeadlessCli(spec({
      args: ["-e", "console.log(JSON.stringify({drive:process.env.SystemDrive,secret:process.env.BROKER_TEST_SECRET}));"],
      inheritEnv: { SYSTEMROOT: "C:\\Windows", systemdrive: drive, BROKER_TEST_SECRET: "private" },
      envAllowlist: [],
    }), { onStdoutLine: line => out.push(line), onStderrLine: () => {} });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual({ drive: drive ?? "C:" });
  });
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

describe("runHeadlessCli output bounds", () => {
  it("caps a no-newline UTF-8 flood by line byte budget and drains after overflow", async () => {
    const lines: string[] = [];
    // Emit a long UTF-8 string with no newlines across multiple writes.
    const result = await runHeadlessCli(
      spec({
        args: [
          "-e",
          "const s='漢'.repeat(200); const b=Buffer.from(s,'utf8'); for(let i=0;i<b.length;i+=7) process.stdout.write(b.subarray(i,i+7));",
        ],
        maxLineBytes: 64,
        maxTotalBytes: 8 * 1024 * 1024,
        maxStreamEvents: 1000,
        firstLineTimeoutMs: 10_000,
        inactivityTimeoutMs: 10_000,
      }),
      { onStdoutLine: (l) => lines.push(l), onStderrLine: () => undefined },
    );
    expect(result.outputLimited).toBe(true);
    expect(result.outputLimitReason).toBe("line");
    expect(result.killed).toBe(true);
    // Only the Windows owned-job path proves whole-domain quiescence; the
    // POSIX child close never claims it.
    if (process.platform === "win32") expect(result.quiesced).toBe(true);
    else expect(result.quiesced).toBeUndefined();
    expect(lines.length).toBe(0);
  }, 30_000);

  it("caps many short lines via the stream event budget", async () => {
    const lines: string[] = [];
    const result = await runHeadlessCli(
      spec({
        args: ["-e", "for (let i=0;i<200;i++) console.log('x'+i);"],
        maxLineBytes: 1024,
        maxTotalBytes: 8 * 1024 * 1024,
        maxStreamEvents: 5,
        firstLineTimeoutMs: 10_000,
        inactivityTimeoutMs: 10_000,
      }),
      { onStdoutLine: (l) => lines.push(l), onStderrLine: () => undefined },
    );
    expect(result.outputLimited).toBe(true);
    expect(result.outputLimitReason).toBe("events");
    expect(lines.length).toBeLessThanOrEqual(5);
    if (process.platform === "win32") expect(result.quiesced).toBe(true);
    else expect(result.quiesced).toBeUndefined();
  }, 30_000);

  it("settles conservatively when a stdout callback throws", async () => {
    await expect(
      runHeadlessCli(
        spec({ args: ["-e", "console.log('boom-line');"] }),
        {
          onStdoutLine: () => {
            throw new Error("callback-failed");
          },
          onStderrLine: () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: process.platform === "win32" ? "EVIDENCE_CAPTURE_FAILED" : "EXECUTION_UNKNOWN" });
  }, 30_000);

  it("a failed callback stops further delivery of buffered lines", async () => {
    let deliveries = 0;
    const run = runHeadlessCli(
      spec({ args: ["-e", "for (let i=0;i<50;i++) console.log('line-'+i);"] }),
      {
        onStdoutLine: () => {
          deliveries += 1;
          throw new Error("stop-delivery");
        },
        onStderrLine: () => undefined,
      },
    );
    // Windows owned-job path surfaces the failed callback as a definite
    // evidence failure after quiescence; POSIX resolves with a bounded result.
    if (process.platform === "win32") {
      await expect(run).rejects.toMatchObject({ code: "EVIDENCE_CAPTURE_FAILED" });
    } else {
      const result = await run;
      expect(result.outputLimited).toBe(true);
      expect(result.terminationReason).toBe("stream_callback_failed");
    }
    expect(deliveries).toBe(1); // never re-invoked for buffered lines
  }, 30_000);

  it("NaN/Infinity quota overrides cannot disable limits", async () => {
    const { createOutputQuota, DEFAULT_MAX_LINE_BYTES, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_MAX_STREAM_EVENTS } =
      await import("../../src/providers/common/headless.ts");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
      const quota = createOutputQuota({ maxLineBytes: bad, maxTotalBytes: bad, maxEvents: bad });
      expect(quota.maxLineBytes).toBe(DEFAULT_MAX_LINE_BYTES);
      expect(quota.maxTotalBytes).toBe(DEFAULT_MAX_TOTAL_BYTES);
      expect(quota.maxEvents).toBe(DEFAULT_MAX_STREAM_EVENTS);
    }
    // Valid overrides still apply.
    const quota = createOutputQuota({ maxLineBytes: 64, maxTotalBytes: 128, maxEvents: 2 });
    expect(quota.maxLineBytes).toBe(64);
    expect(quota.maxTotalBytes).toBe(128);
    expect(quota.maxEvents).toBe(2);
  });
});
