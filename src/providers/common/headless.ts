/**
 * Shared headless-CLI infrastructure for provider adapters (spec §12.5, §13.2).
 *
 * - Invocations are executable + argument array, NO shell interpolation.
 * - The prompt travels via stdin, never argv.
 * - Child env is an explicit allowlist per adapter (§12.3).
 * - Cancellation / deadlines must stop descendant writes before definite return:
 *   Windows uses the broker-owned job object (KILL_ON_JOB_CLOSE); POSIX uses SIGKILL.
 * - Windows npm shims (.cmd/.bat) are wrapped via cmd.exe with strict token
 *   boundary checks (no untrusted interpolation into the command line).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { BrokerError } from "../../shared/errors.ts";
import {
  assertWindowsJobCapable,
  createLineAssembler,
  runWindowsJob,
  WindowsJobCapabilityError,
  type WindowsJobOwnership,
} from "./windowsJob.ts";

export interface HeadlessSpawnSpec {
  binary: string;
  args: string[];
  /** Prompt via stdin; when promptArgv is set, the prompt travels as an argv token instead (print-first CLIs). */
  promptStdin: string;
  promptArgv?: string;
  cwd: string;
  envAllowlist: readonly string[];
  inheritEnv: NodeJS.ProcessEnv;
  /** First-line timeout (startup deadline) and inactivity timeout, ms. */
  firstLineTimeoutMs: number;
  inactivityTimeoutMs: number;
  signal: AbortSignal;
  /**
   * Durable ownership-before-resume gate (Windows managed path). Core persists
   * launch identity here; throwing refuses ResumeThread (zero resume).
   * Optional so direct fake-adapter tests stay compatible on any platform.
   */
  onBeforeResume?: (ownership: WindowsJobOwnership) => void | Promise<void>;
}

export interface HeadlessCliEvents {
  onStdoutLine(line: string): void;
  onStderrLine(line: string): void;
  /** Optional ownership / resume / quiescence signals for adapter→core forwarding. */
  onOwnershipEvent?(ev: { type: string; payload?: Record<string, unknown> }): void;
}

export interface HeadlessCliResult {
  exitCode: number | null;
  killed: boolean;
  timedOut: "first-line" | "inactivity" | null;
  stderrTail: string;
  /** Windows: helper resumed the owned root. */
  resumed?: boolean;
  /** Windows: ActiveProcesses==0 and pipes drained. */
  quiesced?: boolean;
  /**
   * Windows: native execution started (or was resumed) but helper loss /
   * missing quiescence left the outcome undefined — adapters must retain
   * leases/pins/views/config and surface EXECUTION_UNKNOWN.
   */
  uncertainAfterResume?: boolean;
  ownership?: WindowsJobOwnership | null;
  terminationReason?: string | null;
}

const CMD_UNSAFE = /["%!^&|<>()\r\n\0]/;

function assertCmdBoundarySafe(tokens: string[]): void {
  for (const t of tokens) {
    if (CMD_UNSAFE.test(t)) {
      throw new Error(`CMD_SHIM_UNSAFE_TOKEN: ${JSON.stringify(t)}`);
    }
  }
}

type WindowsLaunchTarget =
  | { kind: "direct"; binary: string }
  | { kind: "cmd-shim"; binary: string }
  | { kind: "powershell-shim"; binary: string }
  | { kind: "unsupported"; binary: string };

function classifyWindowsTarget(binary: string): WindowsLaunchTarget {
  const lower = binary.toLowerCase();
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) return { kind: "cmd-shim", binary };
  if (lower.endsWith(".ps1")) return { kind: "powershell-shim", binary };
  if (lower.endsWith(".exe") || lower.endsWith(".com") || !lower.includes(".")) {
    return { kind: "direct", binary };
  }
  return { kind: "unsupported", binary };
}

/** Resolve a bare command via where.exe on Windows (PATH + PATHEXT aware). */
function resolveWindowsBinary(binary: string): string {
  if (path.isAbsolute(binary)) return binary;
  const root = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows";
  const probe = spawnSync(path.join(root, "System32", "where.exe"), [binary], { timeout: 2000, encoding: "utf8" });
  if (probe.status === 0) {
    const first = probe.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    if (first) return first.trim();
  }
  return binary;
}

/** Build the final {command, args} pair, wrapping Windows shims safely. */
export function prepareCommand(binary: string, args: string[]): { command: string; args: string[]; windowsVerbatim: boolean } {
  if (process.platform !== "win32") return { command: binary, args, windowsVerbatim: false };
  const resolved = resolveWindowsBinary(binary);
  const target = classifyWindowsTarget(resolved);
  if (target.kind === "direct") {
    return { command: resolved, args, windowsVerbatim: false };
  }
  if (target.kind === "cmd-shim") {
    // cmd /d /s /c "cmdline" with strict token safety and a length cap.
    assertCmdBoundarySafe([resolved, ...args]);
    const quoted = [resolved, ...args].map((t) => `"${t}"`).join(" ");
    const cmdline = `${quoted}`;
    if (cmdline.length > 8000) throw new Error("CMD_SHIM_LINE_TOO_LONG");
    const comspec = process.env.ComSpec ?? "cmd.exe";
    return { command: comspec, args: ["/d", "/s", "/c", cmdline], windowsVerbatim: true };
  }
  if (target.kind === "powershell-shim") {
    const pwsh = resolveWindowsBinary("pwsh.exe");
    const root = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1] ?? "C:\\Windows";
    const shell = path.isAbsolute(pwsh) ? pwsh : path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      command: shell,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
      windowsVerbatim: false,
    };
  }
  throw new Error(`UNSUPPORTED_WINDOWS_TARGET: ${resolved}`);
}

function buildEnv(spec: HeadlessSpawnSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // A spread of process.env is an ordinary case-sensitive object. Windows
  // commonly supplies Path rather than PATH; preserve native key semantics.
  const inherited = (key: string): string | undefined => {
    if (Object.hasOwn(spec.inheritEnv, key)) return spec.inheritEnv[key];
    if (process.platform !== "win32") return undefined;
    const actual = Object.keys(spec.inheritEnv).find(name => name.toUpperCase() === key.toUpperCase());
    return actual === undefined ? undefined : spec.inheritEnv[actual];
  };
  for (const key of spec.envAllowlist) {
    const value = inherited(key);
    if (value !== undefined) env[key] = value;
  }
  // Always keep the process tree findable.
  env.PATH = inherited("PATH") ?? "";
  if (process.platform === "win32") {
    env.SystemRoot = inherited("SystemRoot") ?? "C:\\Windows";
    // PowerShell needs PATHEXT even for native .exe calls inside a .ps1 shim.
    env.PATHEXT = inherited("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
    if (inherited("ComSpec")) env.ComSpec = inherited("ComSpec");
  }
  return env;
}

function envToPairs(env: NodeJS.ProcessEnv): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.includes("=") || k.includes("\0") || v.includes("\0")) continue;
    pairs.push(`${k}=${v}`);
  }
  return pairs;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone; this function is only used by the POSIX runner */
  }
}

function runHeadlessCliPosix(spec: HeadlessSpawnSpec, events: HeadlessCliEvents): Promise<HeadlessCliResult> {
  return new Promise((resolve) => {
    const { command, args, windowsVerbatim } = prepareCommand(spec.binary, spec.args);
    const child = spawn(command, args, {
      cwd: spec.cwd,
      env: buildEnv(spec),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: windowsVerbatim,
    });

    let killed = false;
    let timedOut: HeadlessCliResult["timedOut"] = null;
    let sawFirstLine = false;
    let stderrTail = "";
    let finished = false;

    let timer: NodeJS.Timeout | null = null;
    const armTimer = () => {
      if (timer) clearTimeout(timer);
      const ms = sawFirstLine ? spec.inactivityTimeoutMs : spec.firstLineTimeoutMs;
      timer = setTimeout(() => {
        timedOut = sawFirstLine ? "inactivity" : "first-line";
        killed = true;
        killTree(child);
      }, ms);
    };

    const onAbort = () => {
      killed = true;
      killTree(child);
    };
    spec.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      spec.signal.removeEventListener("abort", onAbort);
      resolve({ exitCode, killed, timedOut, stderrTail });
    };

    const wireLines = (stream: NodeJS.ReadableStream, handler: (line: string) => void, isStderr: boolean) => {
      let buffer = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        if (!sawFirstLine) {
          sawFirstLine = true;
          armTimer();
        } else {
          armTimer();
        }
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          handler(line);
        }
        if (isStderr) {
          stderrTail = (stderrTail + chunk).slice(-2000);
        }
      });
      stream.on("end", () => {
        if (buffer.length > 0) handler(buffer.replace(/\r$/, ""));
      });
    };

    child.stdout?.on("error", () => undefined);
    child.stderr?.on("error", () => undefined);
    if (child.stdout) wireLines(child.stdout, events.onStdoutLine, false);
    if (child.stderr) wireLines(child.stderr, events.onStderrLine, true);

    child.on("error", (err) => {
      stderrTail = (stderrTail + String(err)).slice(-2000);
      finish(null);
    });
    child.on("close", (code) => finish(code));

    if (spec.promptArgv !== undefined) {
      void spec.promptStdin;
    } else {
      const tag = `agent-broker:${randomUUID().slice(0, 8)}`;
      const payload = `${spec.promptStdin}\n[broker-eor ${tag}]\n`;
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(payload, "utf8");
    }

    armTimer();
  });
}

async function runHeadlessCliWindows(spec: HeadlessSpawnSpec, events: HeadlessCliEvents): Promise<HeadlessCliResult> {
  // Honest refusal — never silently fall back to unmanaged spawn/taskkill.
  try {
    assertWindowsJobCapable();
  } catch (e) {
    events.onOwnershipEvent?.({ type: "owned_zero_resume", payload: { ownership: null, quiesced: false, reason: "capability_refused" } });
    const message = e instanceof Error ? e.message : String(e);
    throw new BrokerError("PROVIDER_INCOMPATIBLE", message, { executionStarted: false });
  }

  let prepared: ReturnType<typeof prepareCommand>;
  try { prepared = prepareCommand(spec.binary, spec.args); }
  catch {
    events.onOwnershipEvent?.({ type: "owned_zero_resume", payload: { ownership: null, quiesced: false, reason: "launch_configuration_refused" } });
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Windows launch configuration refused before native execution.", { executionStarted: false });
  }
  const env = buildEnv(spec);
  const childStdin = spec.promptArgv !== undefined
    ? Buffer.alloc(0)
    : Buffer.from(`${spec.promptStdin}\n[broker-eor agent-broker:${randomUUID().slice(0, 8)}]\n`, "utf8");

  let killed = false;
  let timedOut: HeadlessCliResult["timedOut"] = null;
  let sawFirstLine = false;
  let resumed = false;
  let stderrTail = "";
  let timer: NodeJS.Timeout | null = null;
  const ac = new AbortController();

  const armTimer = () => {
    // Deadlines apply to native IO after ResumeThread — not helper Add-Type/startup.
    if (!resumed) return;
    if (timer) clearTimeout(timer);
    const ms = sawFirstLine ? spec.inactivityTimeoutMs : spec.firstLineTimeoutMs;
    timer = setTimeout(() => {
      timedOut = sawFirstLine ? "inactivity" : "first-line";
      killed = true;
      ac.abort();
    }, ms);
  };

  const onOuterAbort = () => {
    killed = true;
    ac.abort();
  };
  spec.signal.addEventListener("abort", onOuterAbort, { once: true });
  if (spec.signal.aborted) onOuterAbort();

  const noteActivity = () => {
    if (!sawFirstLine) sawFirstLine = true;
    armTimer();
  };

  const onStdout = createLineAssembler((line) => {
    noteActivity();
    events.onStdoutLine(line);
  });
  const onStderr = createLineAssembler((line) => {
    noteActivity();
    events.onStderrLine(line);
  });

  try {
    const result = await runWindowsJob({
      applicationName: prepared.command,
      args: prepared.windowsVerbatim ? [] : prepared.args,
      verbatimCommandLine: prepared.windowsVerbatim
        ? [
            /[\s"]/.test(prepared.command) ? `"${prepared.command.replace(/"/g, "")}"` : prepared.command,
            ...prepared.args,
          ].join(" ")
        : undefined,
      cwd: spec.cwd,
      envPairs: envToPairs(env),
      childStdin,
      signal: ac.signal,
      onBeforeResume: async (ownership) => {
        events.onOwnershipEvent?.({ type: "owned_launch", payload: { ...ownership } });
        if (spec.onBeforeResume) await spec.onBeforeResume(ownership);
      },
      onControl: (op, payload) => {
        if (op === "resumed") {
          resumed = true;
          armTimer();
          events.onOwnershipEvent?.({ type: "owned_resumed", payload });
        } else if (op === "root_exit") {
          events.onOwnershipEvent?.({ type: "owned_root_exit", payload });
        } else if (op === "exit" || op === "terminated") {
          events.onOwnershipEvent?.({ type: "owned_quiescence", payload: { op, ...payload } });
        } else if (op === "terminated_unproven") {
          events.onOwnershipEvent?.({ type: "owned_unproven", payload });
        }
      },
      onStdoutChunk: onStdout,
      onStderrChunk: (bytes) => {
        stderrTail = (stderrTail + bytes.toString("utf8")).slice(-2000);
        onStderr(bytes);
      },
    });

    if (result.uncertainAfterResume) {
      throw new BrokerError("EXECUTION_UNKNOWN", "Owned Windows execution has no authoritative quiescence receipt.", { executionStarted: null });
    }
    if (!result.resumed) {
      events.onOwnershipEvent?.({ type: "owned_zero_resume", payload: { quiesced: result.quiesced,
        reason: result.terminationReason ?? "helper_refused", ownership: result.ownership } });
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "Windows helper refused execution before resume.", { executionStarted: false });
    }
    if (result.protocolError) {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", result.protocolError, { executionStarted: true });
    }
    try { onStdout.flush(); onStderr.flush(); }
    catch {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "Final native stream callback failed after owned quiescence.", { executionStarted: true });
    }

    if (timer) clearTimeout(timer);
    spec.signal.removeEventListener("abort", onOuterAbort);

    return {
      exitCode: result.exitCode,
      killed: killed || result.killed,
      timedOut,
      stderrTail: (stderrTail + result.stderrTail).slice(-2000),
      resumed: result.resumed,
      quiesced: result.quiesced,
      uncertainAfterResume: result.uncertainAfterResume,
      ownership: result.ownership,
      terminationReason: result.terminationReason,
    };
  } catch (e) {
    if (timer) clearTimeout(timer);
    spec.signal.removeEventListener("abort", onOuterAbort);
    if (e instanceof WindowsJobCapabilityError) {
      events.onOwnershipEvent?.({ type: "owned_zero_resume", payload: { ownership: null, quiesced: false, reason: "prelaunch_capability_refused" } });
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "Windows managed launch capability refused before native execution.", { executionStarted: false });
    }
    throw e;
  }
}

/**
 * Run a headless CLI turn: feed the prompt via stdin, stream stdout/stderr
 * line-by-line, enforce startup/inactivity deadlines and external abort.
 * Resolves when the process exits (or is killed); never throws for a
 * non-zero exit — callers decide semantics from {exitCode, killed, timedOut}.
 * On Windows, launches through the owned job helper (capability refusal is
 * thrown, never a silent unmanaged fallback).
 */
export function runHeadlessCli(spec: HeadlessSpawnSpec, events: HeadlessCliEvents): Promise<HeadlessCliResult> {
  if (process.platform === "win32") {
    return runHeadlessCliWindows(spec, events);
  }
  return runHeadlessCliPosix(spec, events);
}

export { WindowsJobCapabilityError, type WindowsJobOwnership };
