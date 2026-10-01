/**
 * Provider adapter for the Antigravity agent CLI (`agy`).
 *
 * Implements ProviderAdapter contract (§13.2, §14.3) using headless CLI runner.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
import { runHeadlessCli, type HeadlessCliEvents, type HeadlessSpawnSpec } from "../common/headless.ts";
import { BrokerError } from "../../shared/errors.ts";
import {
  parseAntigravityStreamLine,
  summarizeAntigravityTurn,
  type AntigravityStreamEvent,
} from "./streamParser.ts";

export const ANTIGRAVITY_ENV_ALLOWLIST = [
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
  "COLORTERM",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "SystemRoot",
] as const;

export interface AntigravityAdapterOptions {
  binary?: string;
  model?: string;
}

const VALID_ANTIGRAVITY_EFFORTS = new Set(["low", "medium", "high", "max"]);

export class AntigravityAdapter implements ProviderAdapter {
  readonly providerId = "antigravity";
  readonly adapterVersion = "0.2.1";

  private readonly binary: string;
  private readonly defaultModel?: string;
  private readonly turnPermissionAcquired = new Map<string, boolean>();

  constructor(opts: AntigravityAdapterOptions = {}) {
    this.binary = opts.binary ?? "agy";
    this.defaultModel = opts.model;
  }

  dispatchPermissionAcquired(turnId: string): boolean {
    return this.turnPermissionAcquired.get(turnId) ?? false;
  }

  preflight(config: Record<string, unknown>): void {
    const fail = config.failPreflight;
    if (fail instanceof BrokerError) throw fail;
    if (!this.binary || this.binary.trim().length === 0) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "Antigravity binary is not configured.");
    }
  }

  async executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    const model = (req.requested_model || this.defaultModel || "").trim();
    if (!model) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Antigravity requires an explicit model.", { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !req.native_conversation_ref.trim()) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "Antigravity resume requires a nonempty native conversation reference.", { executionStarted: false });
    }
    if (req.requested_effort !== null && !VALID_ANTIGRAVITY_EFFORTS.has(req.requested_effort)) {
      throw new BrokerError("INVALID_REQUEST", `Antigravity effort must be low, medium, high, or max; received ${JSON.stringify(req.requested_effort)}.`, { executionStarted: false });
    }

    const args = [
      "--dangerously-skip-permissions",
      "--output-format",
      "stream-json",
      "--print-timeout",
      "0",
      "--model",
      model,
    ];

    if (req.requested_effort !== null) {
      args.push("--effort", req.requested_effort);
    }

    if (
      req.native_conversation_ref !== null &&
      req.native_conversation_ref !== undefined &&
      req.native_conversation_ref.trim().length > 0
    ) {
      args.push("--conversation", req.native_conversation_ref.trim());
    }

    let tmpDir: string | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    let executionUnknown = false;

    try {
      let promptArg: string;
      if (req.task_envelope.length > 2000) {
        tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-broker-agy-"));
        const promptFile = path.join(tmpDir, "prompt.txt");
        writeFileSync(promptFile, req.task_envelope, "utf8");
        promptArg = `Open and follow the instructions in ${promptFile}`;
      } else {
        promptArg = req.task_envelope;
      }
      args.push("-p", promptArg);

      // Gate acquired after argument validation and prompt-file preparation
      gate.acquireDispatchPermission();
      this.turnPermissionAcquired.set(req.turn_id, true);

      // AbortController wired to gate: poll cancellationRequested every 100ms.
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
      if (ac.signal.aborted) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "Antigravity cancelled before launch.", { executionStarted: false });
      }
      pollInterval = setInterval(checkCancellation, 100);

      // Headless spawn spec and stream event handlers.
      const spec: HeadlessSpawnSpec = {
        binary: this.binary,
        args,
        promptStdin: "",
        promptArgv: promptArg,
        cwd: req.workspace_path ?? process.cwd(),
        envAllowlist: ANTIGRAVITY_ENV_ALLOWLIST,
        inheritEnv: process.env,
        firstLineTimeoutMs: 120_000,
        // --print-timeout 0 waits the full turn; do not invent a 900s inactivity cut.
        inactivityTimeoutMs: Math.max(60_000, req.deadline_at > 0 ? req.deadline_at - req.clock.now() : 24 * 60 * 60_000),
        signal: ac.signal,
      };

      const events: AntigravityStreamEvent[] = [];
      let nativeRefEmitted = false;

      const cliEvents: HeadlessCliEvents = {
        onStdoutLine: (line: string) => {
          const ev = parseAntigravityStreamLine(line);
          events.push(ev);

          switch (ev.kind) {
            case "text_delta": {
              const label = ev.text.slice(0, 80);
              onEvent({
                type: "progress",
                payload: { label },
              });
              break;
            }
            case "conversation_id": {
              if (!nativeRefEmitted && ev.id) {
                nativeRefEmitted = true;
                onEvent({
                  type: "native_ref_obtained",
                  payload: { ref: ev.id },
                });
              }
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
        onOwnershipEvent: (ev) => onEvent(ev),
      };

      const cliResult = await runHeadlessCli(spec, cliEvents);
      if (cliResult.uncertainAfterResume) {
        executionUnknown = true;
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
      const summary = summarizeAntigravityTurn(events);

      // 5. Resolve or throw based on outcome.
      if (summary.sawResult) {
        if (summary.status === "SUCCESS") {
          const nativeRef = summary.conversationId ?? req.native_conversation_ref ?? "";
          const rawText = (summary.response && summary.response.trim().length > 0)
            ? summary.response
            : summary.text;
          const boundedSummary = rawText.slice(0, 4000) || "antigravity turn complete";

          return {
            native_outcome: "completed",
            native_conversation_ref: nativeRef,
            agent_reported: {
              summary: boundedSummary,
              format_status: "text_only",
            },
          };
        }

        if (summary.status === "FAILED") {
          const msg = summary.error || summary.response || "antigravity execution failed";
          throw new BrokerError("PROVIDER_PROTOCOL_ERROR", msg, {
            executionStarted: true,
          });
        }

        const msg = summary.error || summary.response || `antigravity turn ended with status: ${summary.status}`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", msg, {
          executionStarted: true,
        });
      }

      // !summary.sawResult:
      if (cliResult.timedOut) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "antigravity timed out", {
          executionStarted: true,
        });
      }

      if (cliResult.exitCode !== 0) {
        const msg = cliResult.stderrTail.trim().length > 0
          ? cliResult.stderrTail
          : cancelReason
            ? `antigravity cancelled: ${cancelReason}`
            : `antigravity process exited with code ${cliResult.exitCode}`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", msg, {
          executionStarted: true,
        });
      }

      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "stream closed without result", {
        executionStarted: true,
      });
    } catch (err) {
      if (err instanceof BrokerError && err.code === "EXECUTION_UNKNOWN") {
        executionUnknown = true;
      }
      throw err;
    } finally {
      if (pollInterval !== null) {
        clearInterval(pollInterval);
      }
      if (tmpDir !== null && !executionUnknown) {
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
