/** ZCode standalone --json adapter, based on the native 0.16.9 smoke. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderAdapter, AdapterEvent, DispatchGate, RuntimeObservation, TurnExecutionRequest, TurnExecutionResult } from "../../runtime/adapter.ts";
import { boundAgentReport } from "../../runtime/adapter.ts";
import { runHeadlessCli } from "../common/headless.ts";
import { BrokerError } from "../../shared/errors.ts";
import { createZcodePersonalConfig, resolveZcodeBuiltinPath } from "./nativeConfig.ts";
import { parseZcodeResult } from "./resultParser.ts";

const ZCODE_PROMPT_ARG_MAX = 6000;
const ZCODE_OUTPUT_MAX = 1_048_576;
const ZCODE_ENV_ALLOWLIST = [
  "HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TMPDIR", "TEMP", "TMP", "COLORTERM", "APPDATA", "LOCALAPPDATA", "USERPROFILE", "SystemRoot",
  // CLI owns account state and credential decryption; secrets are not read or copied.
  "ZCODE_DATA_BASE_DIR", "ZCODE_CREDENTIAL_SECRET",
  "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "ZCODE_LOG_DIR",
] as const;

export interface ZcodeAdapterOptions {
  bundlePath: string;
  nodeBinary?: string;
  /** Override for distributions with a different built-in config layout. */
  builtinProviderConfigPath?: string;
  /** Existing permission behavior; reviewer enforcement is not established. */
  mode?: string;
}

export class ZcodeAdapter implements ProviderAdapter {
  readonly providerId = "zcode";
  readonly adapterVersion = "0.2.4";
  readonly transportEnvelopeLimit = { maxChars: ZCODE_PROMPT_ARG_MAX };
  private readonly opts: ZcodeAdapterOptions;
  constructor(opts: ZcodeAdapterOptions) { this.opts = opts; }

  preflight(config: Record<string, unknown>): void {
    if (config.failPreflight instanceof BrokerError) throw config.failPreflight;
    if (!this.opts.bundlePath || !existsSync(this.opts.bundlePath)) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "ZCode bundle path does not exist.", { executionStarted: false });
    }
    resolveZcodeBuiltinPath(this.opts.bundlePath, this.opts.builtinProviderConfigPath);
  }

  async executeTurn(req: TurnExecutionRequest, gate: DispatchGate, onEvent: (ev: AdapterEvent) => void): Promise<TurnExecutionResult> {
    if (req.task_envelope.length > ZCODE_PROMPT_ARG_MAX) {
      throw new BrokerError("INPUT_LIMIT", `ZCode prompt exceeds the argv transport cap (${ZCODE_PROMPT_ARG_MAX} chars) — deliver context via task artifacts instead.`, { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !/^sess_[a-zA-Z0-9_-]+$/.test(req.native_conversation_ref)) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "ZCode native conversation reference must be a sess_ ID.", { executionStarted: false });
    }
    this.preflight({});
    const builtin = resolveZcodeBuiltinPath(this.opts.bundlePath, this.opts.builtinProviderConfigPath);
    const config = createZcodePersonalConfig(builtin, req.requested_model, req.requested_effort);
    const controller = new AbortController();
    let tmpDir: string | null = null;
    let poll: NodeJS.Timeout | null = null;
    let text = "";
    let outputTooLarge = false;
    let emittedRef = false;
    let executionUnknown = false;
    const checkCancel = () => { if (gate.cancellationRequested() !== null) controller.abort(); };
    try {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-broker-zcode-"));
      const personal = path.join(tmpDir, "provider_config.json");
      writeFileSync(personal, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
      const args = [this.opts.bundlePath, "--prompt", req.task_envelope, "--json", "--mode", this.opts.mode ?? "yolo"];
      if (req.workspace_path) args.push("--cwd", req.workspace_path);
      if (req.native_conversation_ref !== null) args.push("--resume", req.native_conversation_ref);
      // Single dispatch gate immediately before handing the task to the CLI.
      gate.acquireDispatchPermission();
      checkCancel();
      if (controller.signal.aborted) throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "ZCode cancelled before launch.", { executionStarted: false });
      poll = setInterval(checkCancel, 100);
      // --json may remain completely silent until the final result. Missing
      // stdout after two minutes is not startup failure for a coding turn.
      // The daemon's hard deadline owns cancellation; this timer is a fallback
      // for adapter callers without a live deadline supervisor.
      const outputWaitMs = Math.max(1000, req.deadline_at - req.clock.now());
      const result = await runHeadlessCli({
        binary: this.opts.nodeBinary ?? process.execPath, args,
        promptStdin: "", promptArgv: req.task_envelope,
        cwd: req.workspace_path ?? process.cwd(), envAllowlist: ZCODE_ENV_ALLOWLIST,
        inheritEnv: { ...process.env, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtin,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personal, ZCODE_LOG_DIR: path.join(tmpDir, "log") },
        firstLineTimeoutMs: outputWaitMs, inactivityTimeoutMs: outputWaitMs, signal: controller.signal,
      }, {
        onStdoutLine: (line) => {
          if (outputTooLarge) return;
          text += line + "\n";
          if (text.length > ZCODE_OUTPUT_MAX) { outputTooLarge = true; controller.abort(); return; }
          const parsed = parseZcodeResult(text);
          if (parsed && !emittedRef && (req.native_conversation_ref === null || parsed.sessionId === req.native_conversation_ref)) {
            emittedRef = true;
            onEvent({ type: "native_ref_obtained", payload: { ref: parsed.sessionId } });
          }
        },
        onStderrLine: () => undefined,
        onOwnershipEvent: (ev) => onEvent(ev),
      });
      if (result.uncertainAfterResume) {
        executionUnknown = true;
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
      if (result.outputLimited || outputTooLarge || result.timedOut || result.killed || result.exitCode !== 0) {
        const message = result.outputLimited ? `ZCode output limit exceeded (${result.outputLimitReason ?? "total"}).`
          : outputTooLarge ? "ZCode JSON output exceeds the adapter limit."
          : result.timedOut ? `ZCode timed out (${result.timedOut}).`
          : result.killed ? "ZCode execution interrupted."
          : result.stderrTail || `ZCode exited with code ${result.exitCode}.`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", message, { executionStarted: true });
      }
      const parsed = parseZcodeResult(text);
      if (!parsed || (parsed.projection && parsed.projection.status !== "idle")) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "ZCode exited without a valid completed JSON result.", { executionStarted: true });
      }
      if (req.native_conversation_ref !== null && parsed.sessionId !== req.native_conversation_ref) {
        throw new BrokerError("SESSION_NOT_RESUMABLE", "ZCode returned a different native session during explicit resume.", { executionStarted: true });
      }
      onEvent({ type: "progress", payload: { label: "json-run-complete" } });
      const provenance = parsed.projection ? "partial_projection" : undefined;
      return { native_outcome: "completed", native_conversation_ref: parsed.sessionId,
        agent_reported: boundAgentReport(parsed.response || "zcode turn complete", {
          format_status: "text_only",
          ...(provenance ? { provenance } : {}),
        }) };
    } catch (err) {
      if (err instanceof BrokerError && err.code === "EXECUTION_UNKNOWN") {
        executionUnknown = true;
      }
      throw err;
    } finally {
      if (poll) clearInterval(poll);
      if (tmpDir && !executionUnknown) rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  async shutdownIdleRuntime(): Promise<void> {}
  inspectRuntime(): RuntimeObservation | null { return null; }
  async interruptTurn(): Promise<boolean> { return false; }
}
