/**
 * Shared Windows job-object launch wrapper (paired with windowsJobHelper.ps1).
 *
 * Spawns the helper suspended→owned→resume path, frames a private control
 * protocol (nonce never reaches native args/env/stdin), relays native IO as
 * bounded base64 chunks, and gates ResumeThread behind an ownership callback
 * so the core can persist launch identity before the root runs.
 *
 * Non-Windows callers receive an honest capability refusal (no silent fallback).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

export interface WindowsJobOwnership {
  launch_uuid: string;
  named_job: string;
  root_pid: number;
  root_creation_time: string;
  owner_pid: number;
  owner_creation_time: string;
  helper_pid: number;
}

export interface WindowsJobLaunchSpec {
  /** Absolute or PATH-resolved application name (direct .exe) — ignored when verbatimCommandLine is set. */
  applicationName: string;
  args: string[];
  /** Exact lpCommandLine for cmd-shim mode (literal safe tokens only). */
  verbatimCommandLine?: string;
  cwd: string;
  /** Scrubbed KEY=value pairs for the native environment block. */
  envPairs: string[];
  /** Bytes written to the native child's private stdin (prompt), then closed. */
  childStdin: Buffer;
  signal: AbortSignal;
  resumeTimeoutMs?: number;
  terminateQuiesceMs?: number;
  /**
   * Called after `launched` and BEFORE resume. Must persist ownership durably.
   * Throwing / rejecting cancels with zero resume.
   */
  onBeforeResume: (ownership: WindowsJobOwnership) => void | Promise<void>;
  /** Optional process-handle registration for an embedding supervisor. */
  onHelperSpawn?: (helper: ChildProcess) => void;
  onControl?: (op: string, payload: Record<string, unknown>) => void;
  onStdoutChunk?: (bytes: Buffer) => void;
  onStderrChunk?: (bytes: Buffer) => void;
}

export interface WindowsJobResult {
  exitCode: number | null;
  killed: boolean;
  /** True when helper resumed the root at least once. */
  resumed: boolean;
  /** True when ActiveProcesses==0 and pipes drained with a definite exit/terminated. */
  quiesced: boolean;
  /** Helper/process loss after resume without proven quiescence. */
  uncertainAfterResume: boolean;
  ownership: WindowsJobOwnership | null;
  terminationReason: string | null;
  stderrTail: string;
  /** Relay/ownership callback failure; never a fabricated successful stream. */
  protocolError: string | null;
}

export class WindowsJobCapabilityError extends Error {
  readonly code = "WINDOWS_JOB_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "WindowsJobCapabilityError";
  }
}

const HELPER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "windowsJobHelper.ps1");
const CONFIG_CAP = 8 * 1024 * 1024;
const CONTROL_LINE_CAP = 256 * 1024;
// The supervision runtime is an OS executable, independent of the vendor PATH.
const HOST_SYSTEM_ROOT = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows";
const POWERSHELL_EXE = path.join(HOST_SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

let cachedOwnerCreationTime: { pid: number; filetime: string } | null = null;

/** FILETIME (decimal) for the current process — required for exact owner bind. */
export function querySelfOwnerCreationTime(): string {
  if (process.platform !== "win32") {
    throw new WindowsJobCapabilityError("Windows job owner bind requires win32.");
  }
  if (cachedOwnerCreationTime && cachedOwnerCreationTime.pid === process.pid) {
    return cachedOwnerCreationTime.filetime;
  }
  const script = [
    "$ErrorActionPreference='Stop'",
    "$src=@'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class BrokerOwnerTime {",
    "  [DllImport(\"kernel32.dll\",SetLastError=true)] static extern IntPtr OpenProcess(uint a,bool i,int p);",
    "  [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u);",
    "  [DllImport(\"kernel32.dll\",SetLastError=true)] static extern bool CloseHandle(IntPtr h);",
    "  public static string FileTime(int pid) {",
    "    IntPtr h=OpenProcess(0x1000,false,pid);",
    "    if(h==IntPtr.Zero) throw new Exception(\"OpenProcess\");",
    "    long c,e,k,u;",
    "    if(!GetProcessTimes(h,out c,out e,out k,out u)){CloseHandle(h);throw new Exception(\"GetProcessTimes\");}",
    "    CloseHandle(h); return c.ToString(System.Globalization.CultureInfo.InvariantCulture);",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $src -Language CSharp | Out-Null",
    `[BrokerOwnerTime]::FileTime(${process.pid})`,
  ].join("\n");
  const probe = spawnSync(POWERSHELL_EXE, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
  });
  if (probe.status !== 0) {
    throw new WindowsJobCapabilityError(
      `Unable to bind owner creation time: ${(probe.stderr || probe.stdout || "powershell failed").trim()}`,
    );
  }
  const filetime = (probe.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
  if (!/^[0-9]{1,19}$/.test(filetime)) {
    throw new WindowsJobCapabilityError(`Invalid owner creation time from probe: ${JSON.stringify(filetime)}`);
  }
  cachedOwnerCreationTime = { pid: process.pid, filetime };
  return filetime;
}

export function assertWindowsJobCapable(): void {
  if (process.platform !== "win32") {
    throw new WindowsJobCapabilityError("Windows job-object managed execution is only available on win32.");
  }
  if (!existsSync(HELPER_PATH)) {
    throw new WindowsJobCapabilityError(`Windows job helper missing at ${HELPER_PATH}`);
  }
  const probe = spawnSync(
    POWERSHELL_EXE,
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", "exit 0"],
    { windowsHide: true, timeout: 10_000 },
  );
  if (probe.error || probe.status !== 0) {
    throw new WindowsJobCapabilityError("powershell.exe is required for Windows job-object launches.");
  }
}

function buildJobName(launchUuid: string): string {
  const compact = launchUuid.replace(/[^0-9A-Za-z]/g, "").slice(0, 32);
  return `Local\\agent-broker-job-${compact || randomBytes(8).toString("hex")}`;
}

function parseControlLine(nonce: string, line: string): { op: string; json: string } | null {
  const prefix = `${nonce} `;
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  const sp = rest.indexOf(" ");
  if (sp <= 0) return null;
  return { op: rest.slice(0, sp), json: rest.slice(sp + 1) };
}

/**
 * Launch a native child under a broker-owned Windows job.
 * Resolves only after definite quiescence, proven termination, or uncertain helper loss.
 */
export function runWindowsJob(spec: WindowsJobLaunchSpec): Promise<WindowsJobResult> {
  assertWindowsJobCapable();
  const ownerCreationTime = querySelfOwnerCreationTime();
  const nonce = randomBytes(16).toString("hex");
  const launchUuid = randomUUID();
  const jobName = buildJobName(launchUuid);

  const envPairs = spec.envPairs.filter((p) => {
    const eq = p.indexOf("=");
    if (eq <= 0) return false;
    const key = p.slice(0, eq).toUpperCase();
    // Never leak the control nonce into the native environment.
    return key !== "BROKER_JOB_NONCE" && !p.includes("\0");
  });

  const config = {
    nonce,
    launch_uuid: launchUuid,
    job_name: jobName,
    ...(spec.verbatimCommandLine !== undefined
      ? { verbatim_command_line: spec.verbatimCommandLine }
      : { application_name: spec.applicationName, args: spec.args }),
    cwd: spec.cwd,
    env_pairs: envPairs,
    child_stdin_b64: spec.childStdin.length > 0 ? spec.childStdin.toString("base64") : "",
    owner_pid: process.pid,
    owner_creation_time: ownerCreationTime,
    resume_timeout_ms: spec.resumeTimeoutMs ?? 30_000,
    terminate_quiesce_ms: spec.terminateQuiesceMs ?? 15_000,
  };
  const configLine = `${JSON.stringify(config)}\n`;
  if (Buffer.byteLength(configLine, "utf8") > CONFIG_CAP) {
    return Promise.reject(new WindowsJobCapabilityError("WINDOWS_JOB_CONFIG_TOO_LARGE"));
  }

  return new Promise((resolve) => {
    const helper = spawn(
      POWERSHELL_EXE,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", HELPER_PATH],
      {
        cwd: spec.cwd,
        env: {
          SystemRoot: HOST_SYSTEM_ROOT,
          ComSpec: process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe",
          PATH: process.env.PATH ?? "",
          PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let ownership: WindowsJobOwnership | null = null;
    let resumeGateStarted = false;
    let ackSent = false;
    let resumed = false;
    let quiesced = false;
    let killed = false;
    let uncertainAfterResume = false;
    let terminationReason: string | null = null;
    let rootExitCode: number | null = null;
    let stderrTail = "";
    let finished = false;
    let stdoutBuf = Buffer.alloc(0);
    let controlChain: Promise<void> = Promise.resolve();
    let controlError: Error | null = null;
    let helperClosed = false;
    let stopTimer: NodeJS.Timeout | null = null;
    let notifyHelperClosed!: () => void;
    const helperClosedPromise = new Promise<void>((resolveClosed) => { notifyHelperClosed = resolveClosed; });

    const finish = (helperCode: number | null) => {
      if (finished) return;
      finished = true;
      if (stopTimer) clearTimeout(stopTimer);
      spec.signal.removeEventListener("abort", onAbort);
      uncertainAfterResume ||= (ackSent || resumed || ownership !== null) && !quiesced;
      const finalExitCode = rootExitCode !== null ? rootExitCode : helperCode;
      resolve({
        exitCode: finalExitCode,
        killed,
        resumed,
        quiesced,
        uncertainAfterResume,
        ownership,
        terminationReason,
        stderrTail,
        protocolError: controlError ? "WINDOWS_JOB_PROTOCOL_FAILED" : null,
      });
    };

    const sendControl = (op: "resume" | "cancel") => {
      if (helperClosed || finished) return;
      try {
        helper.stdin?.write(`${nonce} ${op}\n`);
      } catch {
        /* helper gone */
      }
      if (op === "cancel" && !stopTimer) {
        stopTimer = setTimeout(() => {
          // ChildProcess owns the process handle; never look up/adopt a PID.
          if (!helperClosed) helper.kill();
        }, (spec.terminateQuiesceMs ?? 15_000) + 5_000);
        stopTimer.unref();
      }
    };

    const onAbort = () => {
      killed = true;
      sendControl("cancel");
    };
    spec.signal.addEventListener("abort", onAbort, { once: true });

    const handleControl = async (op: string, jsonText: string) => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(jsonText) as Record<string, unknown>;
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          throw new Error("malformed control payload");
        }
      } catch {
        killed = true;
        sendControl("cancel");
        if (!terminationReason) terminationReason = "invalid_control_receipt";
        throw new Error(`invalid control receipt JSON for op ${op}`);
      }

      const invalid = (condition: boolean) => {
        if (condition) throw new Error("invalid control schema or phase");
      };
      const exitCode = (value: unknown): value is number =>
        typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
      const relay = () => spec.onControl?.(op, payload);
      const decodeChunk = (): Buffer => {
        invalid(!ownership || !ackSent || quiesced || typeof payload.b64 !== "string");
        const value = payload.b64 as string;
        invalid(value.length > 16 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value));
        const bytes = Buffer.from(value, "base64");
        invalid(bytes.toString("base64") !== value);
        return bytes;
      };

      if (op === "stdout_chunk") {
        if (typeof payload.b64 !== "string") {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "invalid_stdout_chunk";
          throw new Error("stdout_chunk missing b64");
        }
        let bytes: Buffer;
        try {
          bytes = decodeChunk();
        } catch (err) {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "invalid_base64";
          throw err;
        }
        try {
          spec.onStdoutChunk?.(bytes);
        } catch (err) {
          killed = true;
          sendControl("cancel");
          throw err;
        }
        return;
      }

      if (op === "stderr_chunk") {
        if (typeof payload.b64 !== "string") {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "invalid_stderr_chunk";
          throw new Error("stderr_chunk missing b64");
        }
        let bytes: Buffer;
        try {
          bytes = decodeChunk();
        } catch (err) {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "invalid_base64";
          throw err;
        }
        stderrTail = (stderrTail + bytes.toString("utf8")).slice(-2000);
        try {
          spec.onStderrChunk?.(bytes);
        } catch (err) {
          killed = true;
          sendControl("cancel");
          throw err;
        }
        return;
      }

      if (op === "launched") {
        if (resumeGateStarted) {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "duplicate_launch_refused";
          throw new Error("duplicate or out-of-order launched receipt refused");
        }
        resumeGateStarted = true;

        const pLaunchUuid = payload.launch_uuid;
        const pNamedJob = payload.named_job;
        const pRootPid = payload.root_pid;
        const pRootCreationTime = payload.root_creation_time;
        const pOwnerPid = payload.owner_pid;
        const pOwnerCreationTime = payload.owner_creation_time;
        const pHelperPid = payload.helper_pid;

        if (
          typeof pLaunchUuid !== "string" || pLaunchUuid !== launchUuid ||
          typeof pNamedJob !== "string" || pNamedJob !== jobName ||
          typeof pRootPid !== "number" || !Number.isInteger(pRootPid) || pRootPid <= 0 ||
          typeof pRootCreationTime !== "string" || !/^[1-9][0-9]{0,18}$/.test(pRootCreationTime) ||
          typeof pOwnerPid !== "number" || pOwnerPid !== process.pid ||
          typeof pOwnerCreationTime !== "string" || pOwnerCreationTime !== ownerCreationTime ||
          typeof pHelperPid !== "number" || pHelperPid !== helper.pid
        ) {
          killed = true;
          sendControl("cancel");
          if (!terminationReason) terminationReason = "invalid_ownership_metadata";
          throw new Error("strict ownership validation failed; refusing resume");
        }

        ownership = {
          launch_uuid: pLaunchUuid,
          named_job: pNamedJob,
          root_pid: pRootPid,
          root_creation_time: pRootCreationTime,
          owner_pid: pOwnerPid,
          owner_creation_time: pOwnerCreationTime,
          helper_pid: pHelperPid,
        };
        relay();

        try {
          let callbackTimer: NodeJS.Timeout | undefined;
          try {
            await Promise.race([
              Promise.resolve(spec.onBeforeResume(ownership)),
              helperClosedPromise.then(() => { throw new Error("helper closed before ownership acknowledgement"); }),
              new Promise<never>((_, reject) => {
                callbackTimer = setTimeout(() => reject(new Error("ownership callback deadline")), spec.resumeTimeoutMs ?? 30_000);
                callbackTimer.unref();
              }),
            ]);
          } finally { if (callbackTimer) clearTimeout(callbackTimer); }
          if (!killed && !spec.signal.aborted && !helperClosed && !controlError) {
            ackSent = true;
            sendControl("resume");
          } else {
            sendControl("cancel");
          }
        } catch (err) {
          terminationReason = "ownership_callback_rejected";
          killed = true;
          sendControl("cancel");
          stderrTail = (stderrTail + String(err)).slice(-2000);
        }
        return;
      }

      if (op === "resumed") {
        invalid(!ownership || !ackSent || resumed || quiesced || Object.keys(payload).length !== 0);
        resumed = true;
        relay();
        return;
      }

      if (op === "root_exit") {
        invalid(!resumed || quiesced || rootExitCode !== null || !exitCode(payload.exit_code));
        rootExitCode = payload.exit_code as number;
        relay();
        return;
      }

      if (op === "exit") {
        invalid(!ownership || !resumed || quiesced || !exitCode(payload.exit_code) ||
          rootExitCode !== payload.exit_code || payload.active !== 0 || payload.drained !== true || payload.resumed !== true);
        quiesced = true;
        relay();
        return;
      }

      if (op === "terminated") {
        invalid(!ownership || quiesced || !exitCode(payload.root_exit_code) ||
          payload.active !== 0 || payload.drained !== true || typeof payload.resumed !== "boolean" ||
          payload.resumed !== resumed || typeof payload.reason !== "string");
        rootExitCode = payload.root_exit_code as number;
        killed = true;
        quiesced = true;
        relay();
        if (!terminationReason) {
          terminationReason = typeof payload.reason === "string" ? payload.reason : "terminated";
        }
        return;
      }

      if (op === "terminated_unproven") {
        invalid(!ownership || quiesced || typeof payload.reason !== "string");
        uncertainAfterResume = ackSent || resumed;
        killed = true;
        relay();
        if (!terminationReason) {
          terminationReason = typeof payload.reason === "string" ? payload.reason : "unproven";
        }
        return;
      }

      if (op === "owner_mismatch" || op === "owner_open_failed" || op === "launch_failed" || op === "helper_error") {
        invalid(quiesced || (op !== "helper_error" && ownership !== null));
        if (!terminationReason) {
          terminationReason = typeof payload.reason === "string" ? payload.reason : op;
        }
        return;
      }

      killed = true;
      sendControl("cancel");
      if (!terminationReason) terminationReason = "unknown_control_op";
      throw new Error(`unknown control op: ${op}`);
    };

    const enqueueControl = (op: string, json: string) => handleControl(op, json).catch((err) => {
      if (!controlError) controlError = err instanceof Error ? err : new Error("control callback failed");
      killed = true;
      sendControl("cancel");
    });
    const onStdoutData = (chunk: Buffer) => {
      helper.stdout?.pause();
      stdoutBuf = Buffer.concat([stdoutBuf, chunk]);
      if (stdoutBuf.length > CONTROL_LINE_CAP * 4) {
        killed = true;
        sendControl("cancel");
        stderrTail = (stderrTail + "CONTROL_STREAM_OVERFLOW").slice(-2000);
        stdoutBuf = Buffer.alloc(0);
        controlError ??= new Error("control overflow");
        helper.stdout?.destroy();
        helper.stdin?.end();
        return;
      }
      controlChain = controlChain.then(async () => {
      while (true) {
        const nl = stdoutBuf.indexOf(0x0a);
        if (nl < 0) break;
        if (nl > CONTROL_LINE_CAP) {
          killed = true;
          sendControl("cancel");
          stdoutBuf = Buffer.alloc(0);
          controlError ??= new Error("control line overflow");
          helper.stdout?.destroy();
          helper.stdin?.end();
          break;
        }
        const line = stdoutBuf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
        stdoutBuf = stdoutBuf.subarray(nl + 1);
        const parsed = parseControlLine(nonce, line);
        if (!parsed) {
          controlError ??= new Error("unauthenticated helper control frame");
          killed = true;
          sendControl("cancel");
          continue;
        }
        await enqueueControl(parsed.op, parsed.json);
      }
      }).finally(() => { if (!helperClosed) helper.stdout?.resume(); });
    };

    helper.stdout?.on("data", (c: Buffer) => onStdoutData(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    helper.stderr?.on("data", (c: Buffer | string) => {
      const text = Buffer.isBuffer(c) ? c.toString("utf8") : String(c);
      stderrTail = (stderrTail + text).slice(-2000);
    });
    helper.stdout?.on("error", () => undefined);
    helper.stderr?.on("error", () => undefined);
    helper.stdin?.on("error", () => undefined);

    helper.on("error", async (err) => {
      helperClosed = true;
      notifyHelperClosed();
      stderrTail = (stderrTail + String(err)).slice(-2000);
      try {
        await controlChain;
      } catch {}
      if (ackSent || resumed) {
        uncertainAfterResume = true;
      }
      finish(null);
    });

    helper.on("close", async (code) => {
      helperClosed = true;
      notifyHelperClosed();
      if (stdoutBuf.length > 0) {
        const line = stdoutBuf.toString("utf8").replace(/\r$/, "");
        stdoutBuf = Buffer.alloc(0);
        const parsed = parseControlLine(nonce, line);
        if (parsed) {
          controlChain = controlChain.then(() => enqueueControl(parsed.op, parsed.json));
        }
      }
      try {
        await controlChain;
      } catch (err) {
        if (!controlError) controlError = err instanceof Error ? err : new Error(String(err));
      }
      if (controlError && !stderrTail.includes(controlError.message)) {
        stderrTail = (stderrTail + "\n" + controlError.message).slice(-2000);
      }
      if ((ackSent || resumed) && !quiesced) {
        uncertainAfterResume = true;
      }
      finish(code);
    });

    try { spec.onHelperSpawn?.(helper); }
    catch { controlError = new Error("helper registration failed"); killed = true; }
    helper.stdin?.write(configLine);
    if (controlError) sendControl("cancel");
    if (spec.signal.aborted) onAbort();
  });
}

export interface LineAssembler {
  (chunk: Buffer): void;
  flush(): void;
}

/** Decode helper chunk relays into line callbacks (UTF-8 safe across chunk borders). */
export function createLineAssembler(
  onLine: (line: string) => void,
  maxLineLength: number = 256 * 1024,
): LineAssembler {
  const decoder = new StringDecoder("utf8");
  let pending = "";

  const assembler = ((chunk: Buffer) => {
    pending += decoder.write(chunk);
    if (pending.length > maxLineLength * 2) {
      throw new Error("LINE_TOO_LONG");
    }
    let idx: number;
    while ((idx = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, idx).replace(/\r$/, "");
      pending = pending.slice(idx + 1);
      if (line.length > maxLineLength) {
        throw new Error("LINE_TOO_LONG");
      }
      onLine(line);
    }
  }) as LineAssembler;

  assembler.flush = () => {
    pending += decoder.end();
    if (pending.length > 0) {
      const line = pending.replace(/\r$/, "");
      pending = "";
      if (line.length > maxLineLength) {
        throw new Error("LINE_TOO_LONG");
      }
      onLine(line);
    }
  };

  return assembler;
}

/** Test/helper: force-kill only via job close by ending the helper tree root. */
export function destroyHelperTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    /* gone */
  }
}
