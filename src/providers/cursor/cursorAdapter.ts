/**
 * Provider adapter for the Cursor agent CLI.
 *
 * Implements ProviderAdapter contract (§13.2, §14.3) using headless CLI runner.
 */
import type {
  AdapterEvent,
  DispatchGate,
  ProviderAdapter,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../runtime/adapter.ts";
import { runHeadlessCli, type HeadlessCliEvents, type HeadlessSpawnSpec } from "../common/headless.ts";
import { BrokerError } from "../../shared/errors.ts";
import {
  parseCursorStreamLine,
  summarizeCursorTurn,
  type CursorStreamEvent,
} from "./streamParser.ts";

const CURSOR_ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "COLORTERM",
] as const;

export interface CursorAdapterOptions {
  binary?: string;
  model?: string;
}

export class CursorAdapter implements ProviderAdapter {
  readonly providerId = "cursor";
  readonly adapterVersion = "0.1.0";

  private readonly binary: string;
  private readonly defaultModel: string;
  private readonly turnPermissionAcquired = new Map<string, boolean>();

  constructor(opts: CursorAdapterOptions = {}) {
    this.binary = opts.binary ?? "cursor-agent";
    this.defaultModel = opts.model ?? "claude-3-5-sonnet";
  }

  dispatchPermissionAcquired(turnId: string): boolean {
    return this.turnPermissionAcquired.get(turnId) ?? false;
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
    // 1. Acquire dispatch permission first. Throws if cancelled early.
    gate.acquireDispatchPermission();
    this.turnPermissionAcquired.set(req.turn_id, true);

    // 2. Build args per facts.
    const model = req.requested_model || this.defaultModel;
    const args = ["--print", "--output-format", "stream-json", "--model", model, "--trust"];
    if (req.workspace_path !== null && req.workspace_path !== undefined && req.workspace_path.length > 0) {
      args.push("--workspace", req.workspace_path);
    }
    if (req.native_conversation_ref !== null && req.native_conversation_ref !== undefined && req.native_conversation_ref.length > 0) {
      args.push("--resume", req.native_conversation_ref);
    }

    // 3. AbortController wired to gate: poll cancellationRequested every 100ms.
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
    const pollInterval = setInterval(checkCancellation, 100);

    // 4. Headless spawn spec and stream event handlers.
    const spec: HeadlessSpawnSpec = {
      binary: this.binary,
      args,
      promptStdin: req.task_envelope,
      cwd: req.workspace_path ?? process.cwd(),
      envAllowlist: CURSOR_ENV_ALLOWLIST,
      inheritEnv: process.env,
      firstLineTimeoutMs: 120_000,
      inactivityTimeoutMs: 120_000,
      signal: ac.signal,
    };

    const events: CursorStreamEvent[] = [];
    let nativeRefEmitted = false;

    const cliEvents: HeadlessCliEvents = {
      onStdoutLine: (line: string) => {
        const ev = parseCursorStreamLine(line);
        events.push(ev);

        switch (ev.kind) {
          case "init": {
            if (!nativeRefEmitted && ev.session_id) {
              nativeRefEmitted = true;
              onEvent({
                type: "native_ref_obtained",
                payload: { ref: ev.session_id },
              });
            }
            break;
          }
          case "assistant_text": {
            const label = ev.text.slice(0, 80);
            onEvent({
              type: "progress",
              payload: { label },
            });
            break;
          }
          case "thinking": {
            const label = ev.text.slice(0, 80);
            onEvent({
              type: "progress",
              payload: { label },
            });
            break;
          }
          case "tool_call": {
            const label = (ev.subtype ? `tool_call: ${ev.subtype}` : "tool_call").slice(0, 80);
            onEvent({
              type: "progress",
              payload: { label },
            });
            break;
          }
          case "result":
          case "unknown":
            break;
        }
      },
      onStderrLine: (_line: string) => {
        // Captured in stderrTail by runHeadlessCli
      },
    };

    try {
      const cliResult = await runHeadlessCli(spec, cliEvents);
      const summary = summarizeCursorTurn(events);

      // 6. Resolve or throw based on outcome.
      if (summary.sawResult && !summary.isError) {
        const nativeRef = summary.sessionId ?? req.native_conversation_ref ?? `cursor-${req.turn_id}`;
        const rawText = (summary.resultText && summary.resultText.trim().length > 0)
          ? summary.resultText
          : summary.assistantText;
        const boundedSummary = rawText.slice(0, 4000);

        return {
          native_outcome: "completed",
          native_conversation_ref: nativeRef,
          agent_reported: {
            summary: boundedSummary,
            format_status: "text_only",
          },
        };
      }

      if (summary.sawResult && summary.isError) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", summary.resultText || "cursor execution failed", {
          executionStarted: true,
        });
      }

      // !sawResult:
      if (cliResult.timedOut) {
        const code = cliResult.timedOut === "first-line" ? "RATE_LIMITED" : "PROVIDER_PROTOCOL_ERROR";
        throw new BrokerError(code, "cursor timed out", { executionStarted: true });
      }

      if (cliResult.exitCode !== 0) {
        const msg = cliResult.stderrTail.trim().length > 0
          ? cliResult.stderrTail
          : cancelReason
            ? `cursor cancelled: ${cancelReason}`
            : `cursor process exited with code ${cliResult.exitCode}`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", msg, { executionStarted: true });
      }

      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "stream closed without result", {
        executionStarted: true,
      });
    } finally {
      clearInterval(pollInterval);
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
