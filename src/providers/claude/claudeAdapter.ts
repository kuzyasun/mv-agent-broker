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
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export class ClaudeAdapter implements ProviderAdapter {
  readonly providerId = "claude-code";
  readonly adapterVersion = "0.1.0";
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
    // 1. gate.acquireDispatchPermission() first.
    gate.acquireDispatchPermission();

    // 2. Headless arguments: --print --output-format stream-json (+ optional --model, + --resume when non-null)
    const args = ["--print", "--output-format", "stream-json"];
    if (req.requested_model && req.requested_model.trim().length > 0) {
      args.push("--model", req.requested_model.trim());
    }
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
    checkCancellation();
    const pollInterval = setInterval(checkCancellation, 100);

    const streamState: {
      sessionId: string | null;
      lastResult: { text: string; is_error: boolean } | null;
    } = {
      sessionId: null,
      lastResult: null,
    };
    let nativeRefEmitted = false;

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
            if (ev.kind === "init") {
              streamState.sessionId = ev.session_id;
              if (!nativeRefEmitted) {
                nativeRefEmitted = true;
                onEvent({
                  type: "native_ref_obtained",
                  payload: { ref: ev.session_id },
                });
              }
            } else if (ev.kind === "assistant_text") {
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
        },
      );
    } finally {
      clearInterval(pollInterval);
    }

    // 6. Settle outcome
    if (streamState.lastResult !== null) {
      if (!streamState.lastResult.is_error) {
        const nativeRef =
          streamState.sessionId ?? req.native_conversation_ref ?? `claude-${req.turn_id}`;
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

    if (cliResult.timedOut) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "claude timed out", {
        executionStarted: true,
      });
    }

    if (cliResult.exitCode !== 0) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", cliResult.stderrTail, {
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
