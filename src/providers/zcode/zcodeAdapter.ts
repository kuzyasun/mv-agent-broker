/**
 * ZCode provider adapter — print-first headless (ADR-0002).
 *
 * Facts from the Fusion feasibility study (docs/research/2026-09-11-zcode-cli-
 * fusion-runtime-feasibility.md): no `zcode` shim on PATH; invoke via
 * `node <…>/resources/glm/zcode.cjs` with `-p "<prompt>" --mode yolo --cwd <dir>`;
 * print mode returns plain stdout with NO session id, NO stream events, and
 * resume (`--resume`/`--continue`) is UNVERIFIED. Consequently this adapter:
 * - reports NO native conversation ref ("" — every turn is honestly a fresh
 *   print run; the broker never fakes a native_resume, INV-05);
 * - refuses oversized prompts (argv transport; Windows ENAMETOOLONG risk is
 *   an open question in the study — we fail closed instead);
 * - stays `verification: configured` until an operator-authorized spike.
 */
import type { ProviderAdapter } from "../../runtime/adapter.ts";
import type { AdapterEvent, DispatchGate, RuntimeObservation, TurnExecutionRequest, TurnExecutionResult } from "../../runtime/adapter.ts";
import { runHeadlessCli } from "../common/headless.ts";
import { BrokerError } from "../../shared/errors.ts";

/** argv prompt cap: conservative until the ENAMETOOLONG question is resolved. */
const ZCODE_PROMPT_ARG_MAX = 6000;

const ZCODE_ENV_ALLOWLIST = [
  "HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TMPDIR", "COLORTERM", "APPDATA", "LOCALAPPDATA", "USERPROFILE",
  "SystemRoot",
] as const;

export interface ZcodeAdapterOptions {
  /** Absolute path to the desktop bundle (zcode.cjs). */
  bundlePath: string;
  /** Node executable (default "node"). */
  nodeBinary?: string;
  /** Effective model provider must be configured in ~/.zcode/cli/config.json (CLI-owned auth). */
  mode?: string;
}

export class ZcodeAdapter implements ProviderAdapter {
  readonly providerId = "zcode";
  readonly adapterVersion = "0.1.0";
  private readonly opts: ZcodeAdapterOptions;

  constructor(opts: ZcodeAdapterOptions) {
    this.opts = opts;
  }

  preflight(config: Record<string, unknown>): void {
    const fail = config.failPreflight;
    if (fail instanceof BrokerError) throw fail;
    if (!this.opts.bundlePath) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "ZCode bundle path is not configured.");
    }
  }

  async executeTurn(
    req: TurnExecutionRequest,
    gate: DispatchGate,
    onEvent: (ev: AdapterEvent) => void,
  ): Promise<TurnExecutionResult> {
    gate.acquireDispatchPermission();

    if (req.task_envelope.length > ZCODE_PROMPT_ARG_MAX) {
      throw new BrokerError(
        "INPUT_LIMIT",
        `ZCode prompt exceeds the argv transport cap (${ZCODE_PROMPT_ARG_MAX} chars) — deliver context via task artifacts instead.`,
        { executionStarted: false },
      );
    }

    const controller = new AbortController();
    const poll = setInterval(() => {
      const reason = gate.cancellationRequested();
      if (reason !== null) controller.abort();
    }, 100);
    const stdoutLines: string[] = [];

    try {
      const result = await runHeadlessCli(
        {
          binary: this.opts.nodeBinary ?? "node",
          args: [
            this.opts.bundlePath,
            "-p", req.task_envelope,
            "--mode", this.opts.mode ?? "yolo",
            ...(req.workspace_path ? ["--cwd", req.workspace_path] : []),
          ],
          promptStdin: "",
          promptArgv: req.task_envelope,
          cwd: req.workspace_path ?? process.cwd(),
          envAllowlist: ZCODE_ENV_ALLOWLIST,
          inheritEnv: process.env,
          firstLineTimeoutMs: 120_000,
          inactivityTimeoutMs: 300_000,
          signal: controller.signal,
        },
        {
          onStdoutLine: (line) => stdoutLines.push(line),
          onStderrLine: () => undefined,
        },
      );

      const text = stdoutLines.join("\n").trim();
      if (result.timedOut) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", `zcode timed out (${result.timedOut})`, {
          executionStarted: true,
        });
      }
      if (result.exitCode !== 0) {
        throw new BrokerError(
          "PROVIDER_PROTOCOL_ERROR",
          result.stderrTail || `zcode exited with code ${result.exitCode}`,
          { executionStarted: true },
        );
      }
      onEvent({ type: "progress", payload: { label: "print-run-complete" } });
      return {
        native_outcome: "completed",
        // No session identity exists in print mode — the empty ref is the
        // honest answer; the executor records no native conversation.
        native_conversation_ref: "",
        agent_reported: {
          summary: text.slice(0, 4000) || "zcode print run complete",
          format_status: "text_only",
        },
      };
    } finally {
      clearInterval(poll);
    }
  }

  async shutdownIdleRuntime(): Promise<void> {
    /* no persistent runtime in print-first mode */
  }

  inspectRuntime(): RuntimeObservation | null {
    return null;
  }

  async interruptTurn(): Promise<boolean> {
    return false; // abort is handled through the gate's AbortController
  }
}
