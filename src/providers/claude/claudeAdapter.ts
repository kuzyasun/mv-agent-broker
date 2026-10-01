/**
 * Provider adapter for Claude Code CLI (spec §13.2).
 * Runs headless Claude Code CLI turns with stream-json event parsing.
 */
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../runtime/adapter.ts";
import { BrokerError } from "../../shared/errors.ts";
import { runHeadlessCli, type HeadlessCliResult } from "../common/headless.ts";
import { parseClaudeStreamLine } from "./hookEvents.ts";

export interface ClaudeAdapterOptions {
  binary?: string;
}

const CLAUDE_ENV_ALLOWLIST = [
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
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "COLORTERM",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export class ClaudeAdapter implements ProviderAdapter {
  readonly providerId = "claude-code";
  readonly adapterVersion = "0.2.1";
  private readonly binary: string;

  constructor(opts?: ClaudeAdapterOptions) {
    this.binary = opts?.binary ?? "claude";
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
    if (!req.requested_model.trim()) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Claude requires an explicit model.", { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !req.native_conversation_ref.trim()) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "Claude resume requires a nonempty native reference.", { executionStarted: false });
    }
    // Installed CLI requires --verbose to emit stream-json in print mode.
    const args = ["--print", "--output-format", "stream-json", "--verbose", "--model", req.requested_model.trim()];
    if (req.native_conversation_ref !== null) {
      args.push("--resume", req.native_conversation_ref);
    }

    // 3. AbortController wired to gate.cancellationRequested() polling every 100ms
    const abortController = new AbortController();
    const checkCancellation = () => {
      if (gate.cancellationRequested() !== null) {
        abortController.abort();
      }
    };
    gate.acquireDispatchPermission();
    checkCancellation();
    if (abortController.signal.aborted) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "Claude cancelled before launch.", { executionStarted: false });
    }
    const pollInterval = setInterval(checkCancellation, 100);

    const streamState: {
      sessionId: string | null;
      lastResult: { text: string; is_error: boolean } | null;
    } = {
      sessionId: null,
      lastResult: null,
    };
    let nativeRefEmitted = false;
    let identityMismatch = false;

    let cliResult: HeadlessCliResult;
    try {
      cliResult = await runHeadlessCli(
        {
          binary: this.binary,
          args,
          promptStdin: req.task_envelope,
          cwd: req.workspace_path ?? process.cwd(),
          envAllowlist: CLAUDE_ENV_ALLOWLIST,
          inheritEnv: process.env,
          firstLineTimeoutMs: 120_000,
          inactivityTimeoutMs: 120_000,
          signal: abortController.signal,
        },
        {
          onStdoutLine(line: string) {
            const ev = parseClaudeStreamLine(line);
            const ref = ev.kind === "init" || ev.kind === "session_ref" || ev.kind === "result" ? ev.session_id : null;
            if (ref) {
              if ((streamState.sessionId !== null && streamState.sessionId !== ref) ||
                  (req.native_conversation_ref !== null && req.native_conversation_ref !== ref)) {
                identityMismatch = true;
              }
              streamState.sessionId ??= ref;
              if (!nativeRefEmitted && !identityMismatch) {
                nativeRefEmitted = true;
                onEvent({
                  type: "native_ref_obtained",
                  payload: { ref },
                });
              }
            }
            if (ev.kind === "assistant_text") {
              onEvent({
                type: "progress",
                payload: { label: ev.text.slice(0, 80) },
              });
            } else if (ev.kind === "result") {
              streamState.lastResult = { text: ev.text, is_error: ev.is_error };
            }
          },
          onStderrLine(_line: string) {
            // Collected in stderrTail by runHeadlessCli
          },
          onOwnershipEvent(ev) {
            onEvent(ev);
          },
        },
      );
      if (cliResult.uncertainAfterResume) {
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
    } finally {
      clearInterval(pollInterval);
    }

    // Native output never overrides process failure or interruption.
    if (cliResult.timedOut || cliResult.killed || cliResult.exitCode !== 0) {
      const message = cliResult.timedOut ? `Claude timed out (${cliResult.timedOut}).`
        : cliResult.killed ? "Claude execution interrupted."
        : cliResult.stderrTail || streamState.lastResult?.text || `Claude exited with code ${cliResult.exitCode}.`;
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", message, { executionStarted: true });
    }
    if (identityMismatch || (req.native_conversation_ref !== null && streamState.sessionId === null)) {
      throw new BrokerError(req.native_conversation_ref !== null ? "SESSION_NOT_RESUMABLE" : "PROVIDER_PROTOCOL_ERROR",
        "Claude returned missing or conflicting native conversation identity.", { executionStarted: true });
    }
    if (streamState.lastResult !== null) {
      if (!streamState.lastResult.is_error) {
        const nativeRef =
          streamState.sessionId ?? "";
        return {
          native_outcome: "completed",
          native_conversation_ref: nativeRef,
          agent_reported: {
            summary: streamState.lastResult.text.slice(0, 4000),
            format_status: "text_only",
          },
        };
      }
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", streamState.lastResult.text, {
        executionStarted: true,
      });
    }

    throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "stream closed without result", {
      executionStarted: true,
    });
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
