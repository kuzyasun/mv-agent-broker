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
  ProviderFailure,
  RuntimeObservation,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../../runtime/adapter.ts";
import { boundAgentReport } from "../../runtime/adapter.ts";
import { runHeadlessCli, type HeadlessCliEvents, type HeadlessSpawnSpec } from "../common/headless.ts";
import {
  boundedSanitizedDetail,
  fingerprintBinaryTarget,
  resolveBinaryPath,
  runMetadataProbe,
  sha256Canonical,
  ReadinessObservationCache,
  type ProviderReadinessObservation,
} from "../common/readiness.ts";
import { BrokerError } from "../../shared/errors.ts";
import { classifyAntigravityFailure } from "./failureClassifier.ts";
import { captureAntigravityConversation, readAntigravityTurnEvidence } from "./nativeTurnEvidence.ts";
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
  /** Optional native-store location; defaults to agy's per-user conversation directory. */
  conversationsDir?: string;
}

const VALID_ANTIGRAVITY_EFFORTS = new Set(["low", "medium", "high", "max"]);
const MAX_RETAINED_EVENTS = 10_000;

/**
 * Observed `agy models` catalog ids (verified output scheme: "id\tName",
 * effort-suffixed Gemini ids like gemini-3.8-flash-high).
 */
export function parseAntigravityModelCatalog(stdout: string): string[] {
  const ids: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^([a-z0-9][a-z0-9.-]*)\t.+$/i.exec(line.trim());
    if (match) ids.push(match[1]!);
    if (ids.length >= 4096) break;
  }
  return ids;
}

/** Exact requested model+effort route in the observed catalog — no fallback. */
function assertAntigravityRouteObserved(
  observation: ProviderReadinessObservation,
  model: string,
  effort: string | null,
): void {
  const candidate = effort !== null ? `${model}-${effort}` : model;
  if (!observation.model_catalog?.includes(candidate)) {
    throw new BrokerError(
      "MODEL_UNAVAILABLE",
      `Requested Antigravity model route '${candidate}' is not in the observed agy catalog (${observation.model_catalog?.length ?? 0} entries).`,
      { executionStarted: false },
    );
  }
}

function agyProvenance(response: string | null, text: string): string | undefined {
  const sample = `${response ?? ""}\n${text}`;
  if (/agent-broker context envelope|\[session instructions\]|\[task contract JSON\]|broker-eor/i.test(sample)) {
    return "partial_projection";
  }
  return undefined;
}

export class AntigravityAdapter implements ProviderAdapter {
  readonly providerId = "antigravity";
  readonly adapterVersion = "0.2.5";

  private readonly binary: string;
  private readonly defaultModel?: string;
  private readonly conversationsDir?: string;
  private readonly turnPermissionAcquired = new Map<string, boolean>();
  private readonly readinessCache = new ReadinessObservationCache();

  constructor(opts: AntigravityAdapterOptions = {}) {
    this.binary = opts.binary ?? "agy";
    this.defaultModel = opts.model;
    this.conversationsDir = opts.conversationsDir;
  }

  dispatchPermissionAcquired(turnId: string): boolean {
    return this.turnPermissionAcquired.get(turnId) ?? false;
  }

  /**
   * Pinned non-inference metadata probe ONLY: `agy models` (the one metadata
   * subcommand verified as actually supported). No --version/status probes
   * are invented, no prompt, no login/logout, no inference; the requested
   * model+effort route must appear EXACTLY in the observed catalog (effort
   * suffixed, e.g. gemini-3.8-flash-high) — no fallback. CLI version and auth
   * status have no verified non-inference channel and stay unknown (null).
   *
   * A context WITHOUT a requested model (direct inspection, legacy callers)
   * keeps the historical no-throw checks and returns no observation; the
   * broker always supplies the model, so session admission always validates.
   */
  preflight(config: Record<string, unknown>): ProviderReadinessObservation | void {
    const fail = config.failPreflight;
    if (fail instanceof BrokerError) throw fail;
    if (!this.binary || this.binary.trim().length === 0) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "Antigravity binary is not configured.");
    }
    if (typeof config.model !== "string") return;
    const model = config.model.trim();
    if (!model) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Antigravity requires an explicit model.", { executionStarted: false });
    }
    const effort = typeof config.effort === "string" && config.effort.length > 0 ? config.effort : null;
    if (effort !== null && !VALID_ANTIGRAVITY_EFFORTS.has(effort)) {
      throw new BrokerError("INVALID_REQUEST", `Antigravity effort must be low, medium, high, or max; received ${JSON.stringify(effort)}.`, { executionStarted: false });
    }
    const resolvedBinary = resolveBinaryPath(this.binary);
    if (!resolvedBinary) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `Antigravity binary '${this.binary}' not found.`, { executionStarted: false });
    }
    const binaryFingerprint = fingerprintBinaryTarget(resolvedBinary);
    const inputFingerprint = sha256Canonical({
      provider: this.providerId,
      binary_fingerprint: binaryFingerprint,
      probe: ["models"],
    });
    const cached = this.readinessCache.get(inputFingerprint, Date.now());
    if (cached) {
      assertAntigravityRouteObserved(cached, model, effort);
      return cached;
    }
    const probe = runMetadataProbe({ binary: resolvedBinary, argv: ["models"], cwd: process.cwd(), envAllowlist: ANTIGRAVITY_ENV_ALLOWLIST });
    if (!probe.ok) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Antigravity model catalog probe (agy models) failed: ${probe.detail || "no output"}`,
        { executionStarted: false },
      );
    }
    const catalog = parseAntigravityModelCatalog(probe.stdout);
    if (catalog.length === 0) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "Antigravity model catalog probe returned no models.", { executionStarted: false });
    }
    const observation: ProviderReadinessObservation = {
      provider: this.providerId,
      cli_version: null,
      model_catalog: catalog,
      authenticated: null,
      input_fingerprint: inputFingerprint,
      observed_at: Date.now(),
      source: "cli_metadata_probe",
      probe_argv: ["models"],
    };
    assertAntigravityRouteObserved(observation, model, effort);
    this.readinessCache.put(inputFingerprint, observation);
    return observation;
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

      // Observe history before this launch, so an agy result cannot turn an old
      // conversation error into a current error or a new quota pause.
      const checkpoint = req.native_conversation_ref
        ? captureAntigravityConversation(req.native_conversation_ref, this.conversationsDir)
        : null;

      // Gate acquired after argument validation and prompt-file preparation
      gate.acquireDispatchPermission();
      const launchBinary = resolveBinaryPath(this.binary);
      if (!launchBinary) throw new BrokerError("PROVIDER_INCOMPATIBLE", "Antigravity launched binary identity unavailable", {executionStarted:false});
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
        binary: launchBinary,
        args,
        promptStdin: "",
        promptArgv: promptArg,
        cwd: req.workspace_path ?? process.cwd(),
        envAllowlist: ANTIGRAVITY_ENV_ALLOWLIST,
        inheritEnv: process.env,
        // Allow the daemon's deadline scan (up to 60s) to interrupt first.
        firstLineTimeoutMs: Math.max(1_000, req.deadline_at - req.clock.now()) + 65_000,
        // --print-timeout 0 waits the full turn; do not invent a 900s inactivity cut.
        inactivityTimeoutMs: Math.max(1_000, req.deadline_at - req.clock.now()) + 65_000,
        signal: ac.signal,
      };

      const events: AntigravityStreamEvent[] = [];
      let nativeRefEmitted = false;
      let eventsCapped = false;

      const noteNativeRef = (id: string | undefined) => {
        if (!id || nativeRefEmitted) return;
        nativeRefEmitted = true;
        onEvent({ type: "native_ref_obtained", payload: { ref: id } });
      };

      const cliEvents: HeadlessCliEvents = {
        onStdoutLine: (line: string) => {
          const ev = parseAntigravityStreamLine(line);
          if (events.length < MAX_RETAINED_EVENTS) {
            events.push(ev);
          } else {
            eventsCapped = true;
          }

          switch (ev.kind) {
            case "step": {
              if (ev.stepType === "agent_response" && ev.text !== null) {
                onEvent({ type: "progress", payload: { label: "status:text_delta" } });
              }
              noteNativeRef(ev.conversation_id);
              break;
            }
            case "text_delta": {
              // Discard raw text progress; retain only status labels.
              onEvent({ type: "progress", payload: { label: "status:text_delta" } });
              noteNativeRef(ev.conversation_id);
              break;
            }
            case "conversation_id": {
              noteNativeRef(ev.id);
              break;
            }
            case "result": {
              noteNativeRef(ev.conversation_id);
              onEvent({ type: "progress", payload: { label: "status:result" } });
              break;
            }
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
      const nativeRef = summary.conversationId ?? req.native_conversation_ref ?? "";
      const rawText = summary.response?.trim() ? summary.response : summary.text;
      const report = (text: string, provenance?: string, concerns?: string[]) => text.trim()
        ? boundAgentReport(text, { format_status: "text_only", provenance, concerns }) : undefined;
      const failed = (failure: ProviderFailure, text = rawText): TurnExecutionResult => {
        const agent_reported = report(text, eventsCapped ? "partial_projection" : "failed_turn_response");
        return { native_outcome: "failed", native_conversation_ref: nativeRef, failure,
          ...(agent_reported ? { agent_reported } : {}) };
      };

      if (summary.identityMismatch || (req.native_conversation_ref && nativeRef !== req.native_conversation_ref)) {
        return failed({ code: "PROVIDER_PROTOCOL_ERROR", message: "Antigravity returned a different native conversation identity." }, "");
      }
      if (cliResult.outputLimited) {
        return failed({ code: "PROVIDER_OUTPUT_LIMIT", message: `Antigravity output limit exceeded (${cliResult.outputLimitReason ?? "total"}).` });
      }
      // An explicit completion stands even if cancellation arrived afterwards.
      if (summary.sawResult && summary.status === "SUCCESS") {
        if (cliResult.exitCode !== 0) {
          return failed({ code: "PROVIDER_EXECUTION_ERROR", message: `Antigravity exited with code ${cliResult.exitCode} after its result.` });
        }
        const provenance = eventsCapped ? "partial_projection" : agyProvenance(summary.response, summary.text);
        return {
          native_outcome: "completed", native_conversation_ref: nativeRef,
          agent_reported: boundAgentReport(rawText || "antigravity turn complete", {
            format_status: "text_only", ...(provenance ? { provenance } : {}),
          }),
        };
      }

      // Abort/deadline results cannot be corrected from an historical error.
      if (cancelReason !== null || cliResult.timedOut || cliResult.killed) {
        return failed({ code: "PROVIDER_EXECUTION_ERROR", message: cancelReason
          ? `Antigravity cancelled: ${cancelReason}` : "Antigravity execution was interrupted before completion." });
      }

      if (summary.sawResult) {
        if (summary.status !== "FAILED" && summary.status !== "ERROR") {
          return failed({ code: "PROVIDER_PROTOCOL_ERROR", message: "Antigravity returned an unrecognized result status." });
        }

        // New conversations have no earlier errors. A resumed conversation must
        // instead attribute the diagnostic to steps created after its checkpoint.
        if (!req.native_conversation_ref) return failed(classifyAntigravityFailure(summary.error));
        const evidence = checkpoint ? readAntigravityTurnEvidence(nativeRef, checkpoint, this.conversationsDir) : null;
        if (evidence && evidence.errors.length > 0) {
          const currentError = summary.error && evidence.errors.includes(summary.error)
            ? summary.error : evidence.errors.at(-1)!;
          return failed(classifyAntigravityFailure(currentError), evidence.response ?? rawText);
        }
        const historical = !!summary.error && !!checkpoint?.errors.includes(summary.error);
        const latestSteps = new Map(summary.steps?.map(step => [step.index, step]));
        const user = evidence ? latestSteps.get(evidence.userIndex) : undefined;
        // A late tool update need not be the final response. Native polling can
        // also skip ACTIVE background steps without emitting their later DONE;
        // the error-free native segment must still prove every step completed.
        const final = evidence ? latestSteps.get(evidence.lastIndex) : undefined;
        const completionChecks = {
          historical_error_known: historical,
          native_segment_available: evidence !== null,
          native_segment_completed: evidence?.completedResponse === true,
          native_segment_error_free: evidence?.errors.length === 0,
          final_response_matches: !!evidence?.response?.trim() && evidence.response === summary.response,
          process_exit_zero: cliResult.exitCode === 0,
          owned_quiescence: process.platform !== "win32" || cliResult.quiesced === true,
          stream_not_truncated: !eventsCapped,
          stream_user_matches: !!evidence && summary.currentUserStepIndex === evidence.userIndex,
          stream_user_done: user?.stepType === "user_input" && user.state === "DONE",
          stream_final_done: final?.stepType === "agent_response" && final.state === "DONE",
          stream_error_free: !summary.steps?.some(step => step.stepType === "error" || step.state === "ERROR" || step.state === "FAILED"),
        };
        const missing = Object.entries(completionChecks).filter(([, passed]) => !passed).map(([name]) => name);
        if (missing.length === 0 && evidence?.response) {
          return {
            native_outcome: "completed", native_conversation_ref: nativeRef,
            agent_reported: report(evidence.response, "recovered_current_turn", ["Ignored a native error recorded before the current turn."]),
          };
        }
        // No source binding means no inferred quota/current failure. Retain the
        // answer for review without pretending this ambiguous result succeeded.
        const explanation = historical
          ? "Antigravity repeated an historical error; current-turn completion could not be established."
          : "Antigravity's resumed result error could not be attributed to the current turn.";
        return failed({ code: "PROVIDER_RESULT_AMBIGUOUS", message: `${explanation} Missing completion evidence: ${missing.join(", ")}.` }, evidence?.response ?? rawText);
      }

      // !summary.sawResult:
      if (cliResult.exitCode !== 0) {
        const msg = cliResult.stderrTail.trim().length > 0
          ? boundedSanitizedDetail(cliResult.stderrTail)
          : cancelReason
            ? `antigravity cancelled: ${cancelReason}`
            : `antigravity process exited with code ${cliResult.exitCode}`;
        return failed({ code: "PROVIDER_EXECUTION_ERROR", message: msg });
      }

      return failed({ code: "PROVIDER_PROTOCOL_ERROR", message: "Antigravity stream closed without a result." });
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
