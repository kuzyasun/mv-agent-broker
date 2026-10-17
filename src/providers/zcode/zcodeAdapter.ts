/** ZCode standalone stream-json adapter, based on the native 0.16.9 contract. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderAdapter, AdapterEvent, DispatchGate, RuntimeObservation, TurnExecutionRequest, TurnExecutionResult } from "../../runtime/adapter.ts";
import { boundAgentReport } from "../../runtime/adapter.ts";
import { runHeadlessCli } from "../common/headless.ts";
import {
  hashFileBounded,
  resolveBinaryPath,
  sha256Canonical,
  ReadinessObservationCache,
  type ProviderReadinessObservation,
} from "../common/readiness.ts";
import { BrokerError } from "../../shared/errors.ts";
import { createZcodePersonalConfig, readZcodeInstalledCatalog, resolveZcodeBuiltinPath } from "./nativeConfig.ts";
import { zcodeFailureDiagnostic } from "./failureDiagnostic.ts";
import { ZCODE_DESKTOP_AUTH_REJECTED, ZCODE_DESKTOP_AUTH_REQUEST, ZCODE_DESKTOP_BUNDLE_SHA256, ZCODE_DESKTOP_INCOMPATIBLE } from "./desktopAuth.ts";
import { parseZcodeProjectAccessDiagnostic, zcodeProjectAccessError, type ZcodeProjectAccessDiagnostic } from "./projectAccessDiagnostic.ts";
import { parseZcodeStreamEvent } from "./streamEvents.ts";
import {
  parseZcodeResult,
  classifyZcodeError,
  classifyZcodeStderrLine,
  type ZcodeClassifiedError,
} from "./resultParser.ts";

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
  /** Desktop saves a business token; standalone login saves raw OAuth instead. */
  authSource?: "desktop" | "cli";
}

export class ZcodeAdapter implements ProviderAdapter {
  readonly providerId = "zcode";
  readonly adapterVersion = "0.2.10";
  readonly transportEnvelopeLimit = { maxChars: ZCODE_PROMPT_ARG_MAX };
  private readonly opts: ZcodeAdapterOptions;
  private readonly readinessCache = new ReadinessObservationCache();
  constructor(opts: ZcodeAdapterOptions) { this.opts = opts; }

  /**
   * Config-catalog readiness with NO metadata subprocess: the /model CLI
   * route under --prompt consumes quota and is NEVER invoked, and no
   * non-inference status command is verified for this CLI. The installed
   * built-in PROGRAM provider config IS the observed catalog; the bundle
   * version comes from adjacent bundle metadata (null = unknown); native
   * auth status stays unknown (null) — never inferred from the registered
   * auth_mode. The requested model+effort route is validated exactly against
   * the installed catalog before any session acceptance.
   *
   * A context WITHOUT a requested model (direct inspection, legacy callers)
   * keeps the historical no-throw checks and returns no observation; the
   * broker always supplies the model, so session admission always validates.
   */
  preflight(config: Record<string, unknown>): ProviderReadinessObservation | void {
    if (config.failPreflight instanceof BrokerError) throw config.failPreflight;
    if (!this.opts.bundlePath || !existsSync(this.opts.bundlePath)) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "ZCode bundle path does not exist.", { executionStarted: false });
    }
    const builtinPath = resolveZcodeBuiltinPath(this.opts.bundlePath, this.opts.builtinProviderConfigPath);
    if (this.opts.authSource === "desktop" && hashFileBounded(this.opts.bundlePath) !== ZCODE_DESKTOP_BUNDLE_SHA256) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", ZCODE_DESKTOP_INCOMPATIBLE, { executionStarted: false });
    }
    if (typeof config.model !== "string") return;
    const model = config.model.trim();
    if (!model) {
      throw new BrokerError("MODEL_UNAVAILABLE", "ZCode requires an explicit qualified model route.", { executionStarted: false });
    }
    const effort = typeof config.effort === "string" && config.effort.length > 0 ? config.effort : null;
    // Full route validation (account plan, model family, installed catalog,
    // disabled/hidden rules) with no files written.
    createZcodePersonalConfig(builtinPath, model, effort);
    const nodeExecutable = this.opts.nodeBinary ?? process.execPath;
    const resolvedNode = resolveBinaryPath(nodeExecutable);
    if (!resolvedNode) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `ZCode Node executable '${nodeExecutable}' not found.`, { executionStarted: false });
    }
    const nodeFingerprint = hashFileBounded(resolvedNode);
    const bundleCanonical = realpathSync(this.opts.bundlePath);
    const bundleFingerprint = hashFileBounded(bundleCanonical);
    const builtinCanonical = realpathSync(builtinPath);
    const builtinCatalog = readZcodeInstalledCatalog(builtinPath);

    const inputFingerprint = sha256Canonical({
      provider: this.providerId,
      node: {
        canonical_path: resolvedNode,
        file_bytes_sha256: nodeFingerprint,
      },
      bundle: {
        canonical_path: bundleCanonical,
        file_bytes_sha256: bundleFingerprint,
      },
      builtin: {
        canonical_path: builtinCanonical,
        config_sha256: builtinCatalog.config_sha256,
      },
    });
    const now = Date.now();
    const cached = this.readinessCache.get(inputFingerprint, now);
    if (cached) return cached;
    const observation: ProviderReadinessObservation = {
      provider: this.providerId,
      cli_version: null,
      model_catalog: builtinCatalog.individual_catalog,
      authenticated: null,
      input_fingerprint: inputFingerprint,
      observed_at: now,
      source: "config_catalog",
      probe_argv: null,
    };
    this.readinessCache.put(inputFingerprint, observation);
    return observation;
  }

  async executeTurn(req: TurnExecutionRequest, gate: DispatchGate, onEvent: (ev: AdapterEvent) => void): Promise<TurnExecutionResult> {
    if (req.task_envelope.length > ZCODE_PROMPT_ARG_MAX) {
      throw new BrokerError("INPUT_LIMIT", `ZCode prompt exceeds the argv transport cap (${ZCODE_PROMPT_ARG_MAX} chars) — deliver context via task artifacts instead.`, { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !/^sess_[a-zA-Z0-9_-]+$/.test(req.native_conversation_ref)) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "ZCode native conversation reference must be a sess_ ID.", { executionStarted: false });
    }
    this.preflight({ model: req.requested_model, effort: req.requested_effort });
    const builtin = resolveZcodeBuiltinPath(this.opts.bundlePath, this.opts.builtinProviderConfigPath);
    const config = createZcodePersonalConfig(builtin, req.requested_model, req.requested_effort);
    const controller = new AbortController();
    let tmpDir: string | null = null;
    let poll: NodeJS.Timeout | null = null;
    let text = "";
    let invalidStream = false;
    let nativeTurnId: string | null = null;
    let nativeSessionId: string | null = null;
    let resultMatchesTurn = false;
    let lastTextProgressAt = -Infinity;
    let outputTooLarge = false;
    let executionUnknown = false;
    let observedEarlyError: ZcodeClassifiedError | null = null;
    let desktopAuthRejected = false;
    let projectAccessDiagnostic: ZcodeProjectAccessDiagnostic | null = null;
    const checkCancel = () => { if (gate.cancellationRequested() !== null) controller.abort(); };
    try {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), "agent-broker-zcode-"));
      const personal = path.join(tmpDir, "provider_config.json");
      writeFileSync(personal, JSON.stringify(config), { encoding: "utf8", mode: 0o600 });
      const args = [this.opts.bundlePath, "--prompt", req.task_envelope, "--output-format", "stream-json", "--mode", this.opts.mode ?? "yolo"];
      if (this.opts.authSource === "desktop") {
        const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
        args.unshift("--import", new URL(`./desktopAuthPreload.${extension}`, import.meta.url).href);
      }
      if (req.workspace_path) args.push("--cwd", req.workspace_path);
      if (req.native_conversation_ref !== null) args.push("--resume", req.native_conversation_ref);
      // Single dispatch gate immediately before handing the task to the CLI.
      gate.acquireDispatchPermission();
      checkCancel();
      if (controller.signal.aborted) throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "ZCode cancelled before launch.", { executionStarted: false });
      poll = setInterval(checkCancel, 100);
      // Stream native lifecycle/tool metadata while the declared final remains
      // a separate result line. The daemon's hard deadline owns cancellation;
      // this timer is a fallback
      // for adapter callers without a live deadline supervisor.
      // Leave room for the daemon's maximum 60s deadline scan interval.
      const outputWaitMs = Math.max(1000, req.deadline_at - req.clock.now()) + 65_000;
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
          if (line.length > ZCODE_OUTPUT_MAX) { outputTooLarge = true; controller.abort(); return; }
          let obj: Record<string, unknown>;
          try { obj = JSON.parse(line); } catch { invalidStream = true; return; }
          if (!obj || typeof obj !== "object" || Array.isArray(obj)) { invalidStream = true; return; }
          if (obj.deliveryKind === "replay") return;
          const stream = parseZcodeStreamEvent(obj);
          if (stream?.started && nativeTurnId === null && (req.native_conversation_ref === null || stream.sessionId === req.native_conversation_ref)) {
            nativeTurnId = stream.turnId;
            nativeSessionId = stream.sessionId;
            onEvent({ type: "native_ref_obtained", payload: { ref: stream.sessionId } });
          }
          const current = stream && stream.turnId === nativeTurnId && stream.sessionId === nativeSessionId;
          if (current && stream.label && (!stream.textDelta || req.clock.now() - lastTextProgressAt >= 1000)) {
            onEvent({ type: "progress", payload: { label: stream.label } });
            if (stream.textDelta) lastTextProgressAt = req.clock.now();
          }
          const parsed = obj.type === "result" || obj.type === undefined ? parseZcodeResult(line) : null;
          const sessionMatches = (nativeSessionId === null || obj.sessionId === nativeSessionId) &&
            (req.native_conversation_ref === null || obj.sessionId === req.native_conversation_ref);
          const turnMatches = nativeTurnId === null || obj.turnId === nativeTurnId;
          const payload = obj.payload && typeof obj.payload === "object" ? obj.payload as Record<string, unknown> : {};
          // Model-attempt failures can recover. Only the current turn failure,
          // its final result, or an unbound standalone CLI error is terminal.
          const standaloneError = obj.type === undefined && obj.sessionId === undefined && obj.turnId === undefined;
          const boundError = nativeTurnId !== null && sessionMatches && turnMatches && (obj.type === undefined || obj.type === "result");
          const classified = current && stream.failed ? classifyZcodeError({ error: payload.error ?? payload })
            : boundError || standaloneError ? classifyZcodeError(obj) : null;
          if (!observedEarlyError && classified) { observedEarlyError = classified; controller.abort(); return; }
          if (parsed) {
            // Retain only the declared final; discard streamed text, tool I/O
            // and reasoning instead of accumulating them in the broker.
            if (nativeSessionId && (!sessionMatches || !turnMatches)) invalidStream = true;
            resultMatchesTurn = nativeTurnId !== null && sessionMatches && turnMatches;
            text = line;
          }
        },
        onStderrLine: (line) => {
          if (this.opts.authSource === "desktop") {
            if (line === ZCODE_DESKTOP_AUTH_REQUEST) { desktopAuthRejected = false; projectAccessDiagnostic = null; }
            if (line === ZCODE_DESKTOP_AUTH_REJECTED) desktopAuthRejected = true;
            const diagnostic = parseZcodeProjectAccessDiagnostic(line);
            if (diagnostic) {
              projectAccessDiagnostic = diagnostic;
              onEvent({ type: "provider_diagnostic", payload: { provider: "zcode", ...diagnostic } });
            }
          }
          if (!observedEarlyError) {
            const classified = classifyZcodeStderrLine(line);
            if (classified) {
              observedEarlyError = classified;
              controller.abort();
              return;
            }
          }
        },
        onOwnershipEvent: (ev) => onEvent(ev),
      });
      if (result.uncertainAfterResume) {
        executionUnknown = true;
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
      if (gate.cancellationRequested() !== null) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "ZCode execution interrupted.", { executionStarted: true });
      }
      if (result.timedOut) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", `ZCode timed out (${result.timedOut}).`, { executionStarted: true });
      }
      if (result.outputLimited || outputTooLarge) {
        const message = result.outputLimited ? `ZCode output limit exceeded (${result.outputLimitReason ?? "total"}).`
          : "ZCode JSON output exceeds the adapter limit.";
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", message, { executionStarted: true });
      }

      // Check classified quota / rate limit errors
      const classifiedError = observedEarlyError as ZcodeClassifiedError | null;

      if (classifiedError) {
        const details: Record<string, unknown> = {};
        if (classifiedError.vendorCode !== undefined) {
          details.vendor_code = classifiedError.vendorCode;
        }
        if (classifiedError.statusCode !== undefined) {
          details.status_code = classifiedError.statusCode;
        }
        throw new BrokerError(classifiedError.errorCode, classifiedError.safeMessage, {
          executionStarted: true,
          details,
        });
      }

      if (result.killed || result.exitCode !== 0) {
        if (!result.killed && projectAccessDiagnostic) throw zcodeProjectAccessError(projectAccessDiagnostic);
        if (!result.killed && desktopAuthRejected) {
          throw new BrokerError("AUTH_REQUIRED", "ZCode rejected the Desktop credentials (HTTP 401). Sign in to ZCode Desktop again, then explicitly retry the task.", {
            executionStarted: true, details: { status_code: 401 },
          });
        }
        const diagnostic = zcodeFailureDiagnostic(result.stderrTail, path.join(tmpDir, "log"));
        const message = result.killed ? "ZCode execution interrupted."
          : `ZCode exited with code ${result.exitCode}${diagnostic ? `: ${diagnostic}` : "; no native diagnostic available."}`;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", message, { executionStarted: true });
      }
      const parsed = parseZcodeResult(text);
      if (parsed && req.native_conversation_ref !== null && parsed.sessionId !== req.native_conversation_ref) {
        throw new BrokerError("SESSION_NOT_RESUMABLE", "ZCode returned a different native session during explicit resume.", { executionStarted: true });
      }
      if (invalidStream || !resultMatchesTurn || !parsed || (parsed.projection && parsed.projection.status !== "idle")) {
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "ZCode exited without a valid completed JSON result.", { executionStarted: true });
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
