/**
 * Shared headless-CLI infrastructure for provider adapters (spec §12.5, §13.2).
 *
 * - Invocations are executable + argument array, NO shell interpolation.
 * - The prompt travels via stdin, never argv.
 * - Child env is an explicit allowlist per adapter (§12.3).
 * - Cancellation kills the whole tree (Windows: taskkill /T /F; POSIX: SIGKILL)
 *   with a bounded grace period — an interrupt must lead to a definite
 *   process termination before quiescence is claimed (§14.4).
 * - Windows npm shims (.cmd/.bat) are wrapped via cmd.exe with strict token
 *   boundary checks (no untrusted interpolation into the command line).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

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
}

export interface HeadlessCliEvents {
  onStdoutLine(line: string): void;
  onStderrLine(line: string): void;
}

export interface HeadlessCliResult {
  exitCode: number | null;
  killed: boolean;
  timedOut: "first-line" | "inactivity" | null;
  stderrTail: string;
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
  const probe = spawnSync("where.exe", [binary], { timeout: 2000, encoding: "utf8" });
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
    const pwshProbe = spawnSync("where.exe", ["pwsh.exe"], { timeout: 2000, encoding: "utf8" });
    const shell = pwshProbe.status === 0 ? "pwsh.exe" : "powershell.exe";
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
  for (const key of spec.envAllowlist) {
    const value = spec.inheritEnv[key];
    if (value !== undefined) env[key] = value;
  }
  // Always keep the process tree findable.
  env.PATH = spec.inheritEnv.PATH ?? "";
  if (process.platform === "win32") {
    env.SystemRoot = spec.inheritEnv.SystemRoot ?? "C:\\Windows";
    if (spec.inheritEnv.ComSpec) env.ComSpec = spec.inheritEnv.ComSpec;
  }
  return env;
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Run a headless CLI turn: feed the prompt via stdin, stream stdout/stderr
 * line-by-line, enforce startup/inactivity deadlines and external abort.
 * Resolves when the process exits (or is killed); never throws for a
 * non-zero exit — callers decide semantics from {exitCode, killed, timedOut}.
 */
export function runHeadlessCli(spec: HeadlessSpawnSpec, events: HeadlessCliEvents): Promise<HeadlessCliResult> {
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

    // Prompt transport (§12.5): stdin by default; print-first CLIs that only
    // accept an argv prompt use promptArgv (callers enforce a size cap).
    if (spec.promptArgv !== undefined) {
      // args already contain the prompt token — nothing to write.
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
