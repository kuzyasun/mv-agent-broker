/**
 * Provider adapter for the OpenAI Codex CLI (spec §13.2).
 * Runs headless turns with session-scoped notify script bridge.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../runtime/adapter.ts";
import { BrokerError } from "../../shared/errors.ts";
import { runHeadlessCli, type HeadlessCliEvents, type HeadlessSpawnSpec } from "../common/headless.ts";
import { isTurnComplete, parseCodexNotify } from "./notifyEvents.ts";

export interface CodexAdapterOptions {
  binary?: string;
}

export const CODEX_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TERMINFO",
  "TMPDIR",
  "COLORTERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

export class CodexAdapter implements ProviderAdapter {
  readonly providerId = "codex";
  readonly adapterVersion = "0.1.0";
  private readonly binary: string;

  constructor(opts: CodexAdapterOptions = {}) {
    this.binary = opts.binary ?? "codex";
  }

  preflight(config: Record<string, unknown>): void {
    const fail = config.failPreflight;
    if (fail instanceof BrokerError) throw fail;
  }

  async executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    // 1. gate.acquireDispatchPermission() first.
    gate.acquireDispatchPermission();

    // 2. Notify bridge: before spawn, create a temp dir with notify.js runner
    let tmpDir: string | null = null;
    let pollInterval: NodeJS.Timeout | null = null;

    try {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-broker-codex-"));
      const scriptPath = path.join(tmpDir, "notify.js");
      const logPath = path.join(tmpDir, "events.log");

      writeFileSync(
        scriptPath,
        'require("fs").appendFileSync(process.argv[2] ?? "", (process.argv[1] ?? "") + "\\n");',
        "utf8",
      );

      const notifyToken = `notify=${JSON.stringify(["node", scriptPath, logPath])}`;

      // 3. Args: ["exec", "-c", `model=${req.requested_model}`, "-c", notifyToken] (+ nothing else).
      const args: string[] = ["exec"];
      if (req.requested_model && req.requested_model.trim().length > 0) {
        args.push("-c", `model=${req.requested_model.trim()}`);
      }
      args.push("-c", notifyToken);

      // 4. AbortController wired to gate: poll cancellationRequested every 100ms.
      const ac = new AbortController();
      let cancelReason: string | null = null;

      const checkCancellation = () => {
        const reason = gate.cancellationRequested();
        if (reason !== null) {
          cancelReason = reason;
          ac.abort();
        }
      };

      checkCancellation();
      pollInterval = setInterval(checkCancellation, 100);

      const spec: HeadlessSpawnSpec = {
        binary: this.binary,
        args,
        promptStdin: req.task_envelope,
        cwd: req.workspace_path ?? process.cwd(),
        envAllowlist: CODEX_ENV_ALLOWLIST,
        inheritEnv: process.env,
        firstLineTimeoutMs: 120_000,
        inactivityTimeoutMs: 120_000,
        signal: ac.signal,
      };

      const cliEvents: HeadlessCliEvents = {
        onStdoutLine: (_line: string) => {
          // Codex does not output structured stream-json on stdout in headless mode
        },
        onStderrLine: (_line: string) => {
          // Captured in stderrTail by runHeadlessCli
        },
      };

      const cliResult = await runHeadlessCli(spec, cliEvents);

      // 5. Read events.log if present
      let turnCompleteSeen = false;
      let threadId: string | null = null;
      let lastAssistantMessage: string | null = null;
      let nativeRefEmitted = false;

      if (existsSync(logPath)) {
        const content = readFileSync(logPath, "utf8");
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length === 0) continue;
          const payload = parseCodexNotify(trimmed);
          if (isTurnComplete(payload)) {
            turnCompleteSeen = true;
            if (payload?.threadId) {
              threadId = payload.threadId;
              if (!nativeRefEmitted) {
                nativeRefEmitted = true;
                onEvent({
                  type: "native_ref_obtained",
                  payload: { ref: payload.threadId },
                });
              }
            }
            if (payload?.lastAssistantMessage !== null && payload?.lastAssistantMessage !== undefined) {
              lastAssistantMessage = payload.lastAssistantMessage;
            }
          }
        }
      }

      // 6. Outcome mapping
      if (cliResult.timedOut) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "codex timed out", {
          executionStarted: true,
        });
      }

      if (cliResult.exitCode === 0 && turnCompleteSeen) {
        const nativeConversationRef =
          threadId ?? req.native_conversation_ref ?? `codex-${req.turn_id}`;
        const summary =
          (lastAssistantMessage ?? "").slice(0, 4000) || "codex turn complete";
        return {
          native_outcome: "completed",
          native_conversation_ref: nativeConversationRef,
          agent_reported: {
            summary,
            format_status: "text_only",
          },
        };
      }

      if (cliResult.exitCode === 0 && !turnCompleteSeen) {
        throw new BrokerError(
          "PROVIDER_PROTOCOL_ERROR",
          "codex exited without a turn-complete notify",
          { executionStarted: true },
        );
      }

      const msg =
        cliResult.stderrTail.trim().length > 0
          ? cliResult.stderrTail
          : cancelReason
            ? `codex cancelled: ${cancelReason}`
            : `codex process exited with code ${cliResult.exitCode}`;

      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", msg, {
        executionStarted: true,
      });
    } finally {
      if (pollInterval !== null) {
        clearInterval(pollInterval);
      }
      if (tmpDir !== null) {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }

  async shutdownIdleRuntime(_sessionId: string): Promise<void> {
    return;
  }

  inspectRuntime(_sessionId: string): RuntimeObservation | null {
    return null;
  }

  async interruptTurn(_turnId: string): Promise<boolean> {
    return false;
  }
}
