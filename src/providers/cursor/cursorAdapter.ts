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
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "CURSOR_API_KEY",
  "NODE_COMPILE_CACHE",
] as const;

export interface CursorAdapterOptions {
  binary?: string;
  model?: string;
}

export class CursorAdapter implements ProviderAdapter {
  readonly providerId = "cursor";
  readonly adapterVersion = "0.2.1";

  private readonly binary: string;
  private readonly defaultModel: string;
  private readonly turnPermissionAcquired = new Map<string, boolean>();

  constructor(opts: CursorAdapterOptions = {}) {
    this.binary = opts.binary ?? "cursor-agent";
    this.defaultModel = opts.model ?? "";
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
    // Require an operator-selected model; historical defaults can disappear.
    const model = req.requested_model || this.defaultModel;
    if (!model.trim()) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Cursor requires an explicit model from its CLI catalog.", { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !req.native_conversation_ref.trim()) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "Cursor resume requires a nonempty native conversation reference.", { executionStarted: false });
    }
    const args = ["--print", "--output-format", "stream-json", "--model", model, "--trust"];
    // Plan mode can deliver its report via CreatePlan instead of result text.
    if (req.role === "reviewer") args.push("--mode", "ask");
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

    gate.acquireDispatchPermission();
    this.turnPermissionAcquired.set(req.turn_id, true);
    checkCancellation();
    if (ac.signal.aborted) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "Cursor cancelled before launch.", { executionStarted: false });
    }
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
    let observedRef: string | null = null;
    let identityMismatch = false;

    const cliEvents: HeadlessCliEvents = {
      onStdoutLine: (line: string) => {
        const ev = parseCursorStreamLine(line);
        events.push(ev);
        const ref = ev.kind === "init" || ev.kind === "result" ? ev.session_id : null;
        if (ref) {
          if ((observedRef !== null && observedRef !== ref) ||
              (req.native_conversation_ref !== null && req.native_conversation_ref !== ref)) {
            identityMismatch = true;
          }
          observedRef ??= ref;
          if (!nativeRefEmitted && !identityMismatch) {
            nativeRefEmitted = true;
            onEvent({ type: "native_ref_obtained", payload: { ref } });
          }
        }

        switch (ev.kind) {
          case "init": {
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
      // A result record does not override an interrupted or failed process.
      if (cliResult.timedOut || cliResult.killed || cliResult.exitCode !== 0) {
        const message = cliResult.timedOut ? `Cursor timed out (${cliResult.timedOut}).`
          : cliResult.killed ? `Cursor execution interrupted: ${cancelReason ?? "cancelled"}.`
          : cliResult.stderrTail || `Cursor exited with code ${cliResult.exitCode}.`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", message, { executionStarted: true });
      }
      if (identityMismatch || (req.native_conversation_ref !== null && observedRef === null)) {
        throw new BrokerError(req.native_conversation_ref !== null ? "SESSION_NOT_RESUMABLE" : "PROVIDER_PROTOCOL_ERROR",
          "Cursor returned missing or conflicting native conversation identity.", { executionStarted: true });
      }
      if (summary.sawResult && !summary.isError) {
        const nativeRef = summary.sessionId ?? "";
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
