/**
 * Windows job-object wrapper tests — real owned Node child processes only.
 * No vendor CLIs. Capability refusal is asserted honestly (never silent skip).
 */
import { describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import {
  assertWindowsJobCapable,
  createLineAssembler,
  createOutputQuota,
  DEFAULT_MAX_LINE_BYTES,
  DEFAULT_MAX_STREAM_EVENTS,
  DEFAULT_MAX_TOTAL_BYTES,
  querySelfOwnerCreationTime,
  runWindowsJob,
  WindowsJobCapabilityError,
} from "../../src/providers/common/windowsJob.ts";

const isWin = process.platform === "win32";

describe("output quota overrides", () => {
  it("NaN/Infinity/zero/negative overrides never disable a limit", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1024]) {
      const quota = createOutputQuota({ maxLineBytes: bad, maxTotalBytes: bad, maxEvents: bad });
      expect(quota.maxLineBytes).toBe(DEFAULT_MAX_LINE_BYTES);
      expect(quota.maxTotalBytes).toBe(DEFAULT_MAX_TOTAL_BYTES);
      expect(quota.maxEvents).toBe(DEFAULT_MAX_STREAM_EVENTS);
    }
  });

  it("a NaN line cap still overflows at the default budget instead of passing everything", () => {
    const lines: string[] = [];
    let overflow: string | null = null;
    const assembler = createLineAssembler((l) => lines.push(l), {
      maxLineBytes: Number.NaN,
      maxTotalBytes: Number.NaN,
      maxEvents: Number.NaN,
      onOverflow: (r) => {
        overflow = r;
      },
    });
    assembler(Buffer.from("x".repeat(DEFAULT_MAX_LINE_BYTES + 1), "utf8"));
    expect(overflow).toBe("line");
    expect(lines).toEqual([]);
  });
});

describe("WindowsJob capability", () => {
  it("refuses non-win32 honestly", () => {
    if (isWin) {
      expect(() => assertWindowsJobCapable()).not.toThrow();
      expect(querySelfOwnerCreationTime()).toMatch(/^[0-9]{1,19}$/);
      return;
    }
    expect(() => assertWindowsJobCapable()).toThrow(WindowsJobCapabilityError);
  });
});

describe.runIf(isWin)("runWindowsJob owned Node children", () => {
  it("owner channel EOF after declared success is a killed, quiesced failure with the actual root code", async () => {
    let helper: ChildProcess | undefined;
    const result = await runWindowsJob({ applicationName: process.execPath,
      args: ["-e", "console.log('declared-success');setInterval(()=>{},1000)"], cwd: process.cwd(),
      envPairs: [`SystemRoot=${process.env.SystemRoot}`], childStdin: Buffer.alloc(0),
      signal: AbortSignal.timeout(8000), onHelperSpawn: c => { helper = c; }, onBeforeResume: () => undefined,
      onStdoutChunk: createLineAssembler(l => { if (l === "declared-success") helper!.stdin!.end(); }) });
    expect(result).toMatchObject({ resumed: true, quiesced: true, killed: true, terminationReason: "owner_lost", exitCode: 1 });
  }, 15000);
  it("large stdin does not block ownership acknowledgement before resume", async () => {
    const bytes = Buffer.from("漢字 🚀".repeat(16000));
    const lines: string[] = [];
    const result = await runWindowsJob({ applicationName: process.execPath,
      args: ["-e", "const b=[];process.stdin.on('data',d=>b.push(d));process.stdin.on('end',()=>console.log(Buffer.concat(b).length));"],
      cwd: process.cwd(), envPairs: [`SystemRoot=${process.env.SystemRoot}`], childStdin: bytes,
      signal: AbortSignal.timeout(8000), onBeforeResume: () => undefined,
      onStdoutChunk: createLineAssembler(l => lines.push(l)) });
    expect(result).toMatchObject({ resumed: true, quiesced: true, exitCode: 0, protocolError: null });
    expect(lines).toEqual([String(bytes.length)]);
  }, 15000);

  it("helper closes during a pending ownership callback without a late resume or hung promise", async () => {
    let helper: ChildProcess | undefined;
    const output: string[] = [];
    const result = await runWindowsJob({ applicationName: process.execPath,
      args: ["-e", "console.log('must-not-run')"], cwd: process.cwd(),
      envPairs: [`SystemRoot=${process.env.SystemRoot}`], childStdin: Buffer.alloc(0),
      signal: AbortSignal.timeout(8000), onHelperSpawn: c => { helper = c; },
      onBeforeResume: () => { helper!.kill(); return new Promise<void>(() => {}); },
      onStdoutChunk: createLineAssembler(l => output.push(l)) });
    expect(result.resumed).toBe(false);
    expect(result.uncertainAfterResume).toBe(true); // owned shutdown was not receipted
    expect(output).toEqual([]);
  }, 15000);

  it("exact owner death stops a live detached descendant without adopting or killing a PID", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "broker-job-owner-death-"));
    const marker = path.join(root, "heartbeat");
    const moduleUrl = pathToFileURL(path.resolve("src/providers/common/windowsJob.ts")).href;
    const childScript = `const fs=require('fs');const t=setInterval(()=>fs.appendFileSync(process.env.MARKER,'x'),20);setTimeout(()=>clearInterval(t),8000);`;
    const rootScript = `const fs=require('fs');require('child_process').spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{detached:true,stdio:'ignore',env:process.env}).unref();const t=setInterval(()=>{if(fs.existsSync(process.env.MARKER)){console.log('ready');clearInterval(t)}},20);setTimeout(()=>process.exit(0),8000);`;
    const ownerScript = `import {runWindowsJob,createLineAssembler} from ${JSON.stringify(moduleUrl)};
      await runWindowsJob({applicationName:process.execPath,args:['-e',${JSON.stringify(rootScript)}],cwd:process.cwd(),
        envPairs:['SystemRoot='+process.env.SystemRoot,'MARKER='+process.argv[1]],childStdin:Buffer.alloc(0),
        signal:AbortSignal.timeout(12000),onBeforeResume:()=>{},onStdoutChunk:createLineAssembler(l=>{if(l==='ready')process.send('ready')})});`;
    const owner = spawn(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", ownerScript, marker],
      { stdio: ["ignore", "ignore", "ignore", "ipc"], windowsHide: true });
    let writesStopped = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("owned descendant readiness deadline")), 8000);
        owner.once("message", () => { clearTimeout(timer); resolve(); });
        owner.once("error", error => { clearTimeout(timer); reject(error); });
      });
      expect(fs.statSync(marker).size).toBeGreaterThan(0);
      const closed = new Promise<void>(resolve => owner.once("close", () => resolve()));
      expect(owner.kill()).toBe(true); // exact ChildProcess handle created above
      await closed;
      expect(owner.signalCode).toBe("SIGTERM");
      await new Promise(resolve => setTimeout(resolve, 350));
      const stopped = fs.statSync(marker).size;
      await new Promise(resolve => setTimeout(resolve, 350));
      expect(fs.statSync(marker).size).toBe(stopped);
      writesStopped = true;
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill();
      // A failed assertion preserves the fixture until the bounded child lifetime.
      if (writesStopped) {
        await new Promise(resolve => setTimeout(resolve, 200));
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 20000);
  it("normal nonzero exit 17 returned 17", async () => {
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "process.exit(17);"],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: new AbortController().signal,
      onBeforeResume: () => undefined,
    });
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(true);
    expect(result.uncertainAfterResume).toBe(false);
    expect(result.exitCode).toBe(17);
  }, 60_000);

  it("persists ownership before resume and streams stdout", async () => {
    const owned: string[] = [];
    const lines: string[] = [];
    const assemble = createLineAssembler((l) => lines.push(l));
    let beforeResume = false;
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "console.log('hello-owned');"],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: new AbortController().signal,
      onBeforeResume: (o) => {
        beforeResume = true;
        owned.push(o.launch_uuid, o.named_job, String(o.root_pid));
        expect(o.root_pid).toBeGreaterThan(0);
        expect(o.owner_pid).toBe(process.pid);
        expect(o.owner_creation_time).toMatch(/^[0-9]+$/);
      },
      onStdoutChunk: assemble,
    });
    expect(beforeResume).toBe(true);
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(true);
    expect(result.uncertainAfterResume).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(lines).toContain("hello-owned");
    expect(owned[0]).toBeTruthy();
  }, 60_000);

  it("callback rejection yields zero resume and zero actual child output", async () => {
    const lines: string[] = [];
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "console.log('should-not-run'); setTimeout(()=>{}, 60000);"],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: new AbortController().signal,
      onBeforeResume: () => {
        throw new Error("refuse-ownership");
      },
      onStdoutChunk: createLineAssembler((l) => lines.push(l)),
    });
    expect(result.resumed).toBe(false);
    expect(result.quiesced).toBe(true);
    expect(result.uncertainAfterResume).toBe(false);
    expect(result.terminationReason).toBe("ownership_callback_rejected");
    expect(lines).toHaveLength(0);
  }, 60_000);

  it("forged native NDJSON control lines cannot fabricate receipts", async () => {
    const ops: string[] = [];
    const lines: string[] = [];
    const assemble = createLineAssembler((l) => lines.push(l));
    const nonceGuess = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: [
        "-e",
        `console.log('${nonceGuess} launched {"launch_uuid":"forged"}'); console.log('real-line');`,
      ],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: new AbortController().signal,
      onBeforeResume: () => undefined,
      onControl: (op) => ops.push(op),
      onStdoutChunk: assemble,
    });
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(true);
    // Native forgery appears as stdout text, never as an extra launched receipt after resume.
    expect(ops.filter((o) => o === "launched")).toHaveLength(1);
    expect(lines.some((l) => l.includes("launched") && l.includes("forged"))).toBe(true);
    expect(lines).toContain("real-line");
  }, 60_000);

  it("detached descendant keeps runner unsettled until ActiveProcesses==0 and no later growth", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-job-hb-"));
    const marker = path.join(tmpDir, "hb.txt");
    try {
      const script = `
        const {spawn} = require('child_process');
        const marker = process.env.BROKER_HB_MARKER;
        const child = spawn(process.execPath, ['-e', "let i=0; const t=setInterval(()=>{require('fs').appendFileSync(process.env.BROKER_HB_MARKER,'hb\\\\n'); if(++i>=5) clearInterval(t);},100);"], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, BROKER_HB_MARKER: marker }
        });
        child.unref();
        console.log('root-exit-soon');
        setTimeout(() => process.exit(0), 50);
      `;
      let settled = false;
      let rootExit!: () => void;
      const rootExited = new Promise<void>(resolve => { rootExit = resolve; });
      const running = runWindowsJob({
        applicationName: process.execPath,
        args: ["-e", script],
        cwd: process.cwd(),
        envPairs: [
          `PATH=${process.env.PATH ?? ""}`,
          `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`,
          `BROKER_HB_MARKER=${marker}`,
        ],
        childStdin: Buffer.alloc(0),
        signal: new AbortController().signal,
        terminateQuiesceMs: 20_000,
        onBeforeResume: () => undefined,
        onControl: op => { if (op === "root_exit") rootExit(); },
      }).then(result => { settled = true; return result; });
      await rootExited;
      const sizeAtRootExit = fs.existsSync(marker) ? fs.statSync(marker).size : 0;
      const growthDeadline = Date.now() + 3000;
      while ((!fs.existsSync(marker) || fs.statSync(marker).size <= sizeAtRootExit) && Date.now() < growthDeadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(fs.statSync(marker).size).toBeGreaterThan(sizeAtRootExit);
      expect(settled).toBe(false);
      const result = await running;
      expect(result.quiesced).toBe(true);
      expect(result.uncertainAfterResume).toBe(false);
      expect(fs.existsSync(marker)).toBe(true);
      const contentAtReturn = fs.readFileSync(marker, "utf8");
      expect(contentAtReturn.length).toBeGreaterThan(0);
      // Verify no later growth
      await new Promise((r) => setTimeout(r, 200));
      const contentAfterWait = fs.readFileSync(marker, "utf8");
      expect(contentAfterWait).toBe(contentAtReturn);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("cancel only AFTER native heartbeat/readiness and no writes after definite completion", async () => {
    const ac = new AbortController();
    let sawHeartbeat = false;
    let writesAfterDefiniteCompletion = 0;
    let completed = false;
    const p = runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "setInterval(()=>console.log('ready-tick'), 50);"],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: ac.signal,
      onBeforeResume: () => undefined,
      onStdoutChunk: createLineAssembler((line) => {
        if (completed) writesAfterDefiniteCompletion++;
        if (line.trim() === "ready-tick" && !sawHeartbeat) {
          sawHeartbeat = true;
          ac.abort();
        }
      }),
    });
    const result = await p;
    completed = true;
    await new Promise((r) => setTimeout(r, 200));
    expect(sawHeartbeat).toBe(true);
    expect(result.killed).toBe(true);
    expect(result.terminationReason).toBe("cancel");
    expect(result.quiesced).toBe(true);
    expect(result.uncertainAfterResume).toBe(false);
    expect(writesAfterDefiniteCompletion).toBe(0);
  }, 60_000);

  it("helper loss AFTER ACK/resume means UNKNOWN and holds resources", async () => {
    let helperProcess: ChildProcess | null = null;
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "setInterval(()=>console.log('alive'), 50);"],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.alloc(0),
      signal: new AbortController().signal,
      onHelperSpawn: (helper) => { helperProcess = helper; },
      onBeforeResume: () => undefined,
      onStdoutChunk: createLineAssembler((line) => {
        if (line.trim() === "alive" && helperProcess) {
          helperProcess.kill();
          helperProcess = null;
        }
      }),
    });
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(false);
    expect(result.uncertainAfterResume).toBe(true);
  }, 60_000);

  it("stale owner creation time refuses without resume", async () => {
    expect(querySelfOwnerCreationTime()).not.toBe("");
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/providers/common/windowsJobHelper.ps1");
    const nonce = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const config = JSON.stringify({
      nonce,
      launch_uuid: "00000000-0000-4000-8000-000000000001",
      job_name: "Local\\agent-broker-job-staleowner",
      application_name: process.execPath,
      args: ["-e", "console.log(1)"],
      cwd: process.cwd(),
      env_pairs: [`PATH=${process.env.PATH ?? ""}`],
      child_stdin_b64: "",
      owner_pid: process.pid,
      owner_creation_time: "1",
      resume_timeout_ms: 5000,
      terminate_quiesce_ms: 5000,
    });
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    child.stdout?.on("data", (c) => {
      out += c.toString("utf8");
    });
    child.stdin?.end(`${config}\n`);
    const code: number | null = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    expect(code).not.toBe(0);
    expect(out).toContain("owner_mismatch");
    expect(out).not.toContain(`${nonce} resumed`);
  }, 60_000);

  it("invalid control receipts trigger conservative abort", async () => {
    const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/providers/common/windowsJobHelper.ps1");
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdin?.end("not-json\n");
    const code: number | null = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    expect(code).toBe(9);
  }, 60_000);

  it("Unicode split UTF-8 across chunks and EOF tail flush", () => {
    const lines: string[] = [];
    const assembler = createLineAssembler((l) => lines.push(l));

    // Chinese characters "世界" (6 bytes: E4 B8 96 E7 95 8C)
    const full = Buffer.from("Line 1: 世界\nLine 2: 🚀 Rocket\nLine 3 tail", "utf8");
    // Split chunk 1 inside the 3-byte sequence for "界" (at index 12)
    const chunk1 = full.subarray(0, 12);
    const chunk2 = full.subarray(12);

    assembler(chunk1);
    assembler(chunk2);
    expect(lines).toEqual(["Line 1: 世界", "Line 2: 🚀 Rocket"]);

    // Flush EOF tail
    assembler.flush();
    expect(lines).toEqual(["Line 1: 世界", "Line 2: 🚀 Rocket", "Line 3 tail"]);
  });

  it("unicode/quotes survive argv and stdin", async () => {
    const lines: string[] = [];
    const assemble = createLineAssembler((l) => lines.push(l));
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>console.log(JSON.stringify({a:process.argv[1],s})));",
        "quote \"here\" 你好",
      ],
      cwd: process.cwd(),
      envPairs: [`PATH=${process.env.PATH ?? ""}`, `SystemRoot=${process.env.SystemRoot ?? "C:\\Windows"}`],
      childStdin: Buffer.from("stdin-привет\n", "utf8"),
      signal: new AbortController().signal,
      onBeforeResume: () => undefined,
      onStdoutChunk: assemble,
    });
    expect(result.quiesced).toBe(true);
    const parsed = JSON.parse(lines.find((l) => l.startsWith("{")) ?? "{}") as { a?: string; s?: string };
    expect(parsed.a).toContain("你好");
    expect(parsed.s).toContain("привет");
  }, 60_000);

  it("createLineAssembler drains after UTF-8 line byte overflow without throwing mid-decode", () => {
    const lines: string[] = [];
    let overflow: string | null = null;
    const assembler = createLineAssembler((l) => lines.push(l), {
      maxLineBytes: 20,
      maxTotalBytes: 1024,
      maxEvents: 100,
      onOverflow: (r) => {
        overflow = r;
      },
    });
    const payload = Buffer.from("漢".repeat(40), "utf8"); // no newline
    for (let i = 0; i < payload.length; i += 5) {
      assembler(payload.subarray(i, i + 5));
    }
    assembler.flush();
    expect(overflow).toBe("line");
    expect(lines).toEqual([]);
  });

  it("createLineAssembler caps many short lines via event budget", () => {
    const lines: string[] = [];
    let overflow: string | null = null;
    const assembler = createLineAssembler((l) => lines.push(l), {
      maxLineBytes: 1024,
      maxTotalBytes: 1024 * 1024,
      maxEvents: 3,
      onOverflow: (r) => {
        overflow = r;
      },
    });
    assembler(Buffer.from("a\nb\nc\nd\ne\n", "utf8"));
    expect(overflow).toBe("events");
    expect(lines.length).toBe(3);
  });
});

describe.runIf(isWin)("runWindowsJob native output quota", () => {
  it("cancels owned job on native output quota overflow and waits for quiescence", async () => {
    const lines: string[] = [];
    const result = await runWindowsJob({
      applicationName: process.execPath,
      args: ["-e", "for(;;) process.stdout.write('xxxxxxxx');"],
      cwd: process.cwd(),
      envPairs: [`SystemRoot=${process.env.SystemRoot}`],
      childStdin: Buffer.alloc(0),
      signal: AbortSignal.timeout(15_000),
      maxNativeOutputBytes: 4096,
      onBeforeResume: () => undefined,
      onStdoutChunk: createLineAssembler((l) => lines.push(l), { maxLineBytes: 1024, maxTotalBytes: 1024 * 1024 }),
    });
    expect(result.resumed).toBe(true);
    expect(result.quiesced).toBe(true);
    expect(result.outputLimited || result.terminationReason === "output_limit" || result.killed).toBe(true);
  }, 30_000);
});
