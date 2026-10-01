/** Non-interactive Codex CLI turns; JSONL identity and explicit native resume. */
import type { AdapterEvent, DispatchGate, ProviderAdapter, RuntimeObservation, TurnExecutionRequest, TurnExecutionResult } from "../../runtime/adapter.ts";
import { BrokerError } from "../../shared/errors.ts";
import { runHeadlessCli, type HeadlessCliResult } from "../common/headless.ts";
import { parseCodexStreamLine } from "./streamParser.ts";

export interface CodexAdapterOptions { binary?: string }
export const CODEX_ENV_ALLOWLIST = [
  "HOME", "PATH", "SHELL", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE",
  "TERM", "TERMINFO", "TMPDIR", "COLORTERM", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
  "XDG_DATA_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL",
] as const;

export class CodexAdapter implements ProviderAdapter {
  readonly providerId = "codex";
  readonly adapterVersion = "0.2.1";
  private readonly binary: string;
  constructor(opts: CodexAdapterOptions = {}) { this.binary = opts.binary ?? "codex"; }
  preflight(config: Record<string, unknown>): void {
    if (config.failPreflight instanceof BrokerError) throw config.failPreflight;
  }

  async executeTurn(req: TurnExecutionRequest, gate: DispatchGate, onEvent: (ev: AdapterEvent) => void): Promise<TurnExecutionResult> {
    if (!req.requested_model.trim()) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Codex requires an explicit model.", { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !req.native_conversation_ref.trim()) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "Codex resume requires a nonempty native reference.", { executionStarted: false });
    }
    // Parent exec owns sandbox policy; resume owns its model/JSON/config flags.
    // Ignore ambient model/MCP defaults while retaining native CODEX_HOME auth.
    const args = ["exec", "--sandbox", req.role === "reviewer" ? "read-only" : "workspace-write"];
    if (req.native_conversation_ref !== null) args.push("resume");
    args.push("--json", "--ignore-user-config", "--model", req.requested_model.trim());
    if (req.requested_effort !== null) args.push("-c", `model_reasoning_effort=${JSON.stringify(req.requested_effort)}`);
    if (req.native_conversation_ref !== null) args.push(req.native_conversation_ref);
    args.push("-");

    const ac = new AbortController();
    const checkCancellation = () => { if (gate.cancellationRequested() !== null) ac.abort(); };
    gate.acquireDispatchPermission();
    checkCancellation();
    if (ac.signal.aborted) throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "Codex cancelled before launch.", { executionStarted: false });
    const poll = setInterval(checkCancellation, 100);
    const state = { ref: null as string | null, identityMismatch: false, complete: false, failure: null as string | null, text: null as string | null };
    let cli: HeadlessCliResult;
    try {
      cli = await runHeadlessCli({
        binary: this.binary, args, promptStdin: req.task_envelope,
        cwd: req.workspace_path ?? process.cwd(), envAllowlist: CODEX_ENV_ALLOWLIST,
        inheritEnv: process.env, firstLineTimeoutMs: 120_000, inactivityTimeoutMs: 120_000, signal: ac.signal,
      }, {
        onStdoutLine(line) {
          const ev = parseCodexStreamLine(line);
          if (ev.kind === "thread") {
            if ((state.ref !== null && state.ref !== ev.ref) ||
                (req.native_conversation_ref !== null && req.native_conversation_ref !== ev.ref)) {
              state.identityMismatch = true;
            } else if (state.ref === null) {
              state.ref = ev.ref;
              onEvent({ type: "native_ref_obtained", payload: { ref: ev.ref } });
            }
          } else if (ev.kind === "message") {
            state.text = ev.text;
            onEvent({ type: "progress", payload: { label: ev.text.slice(0, 80) } });
          } else if (ev.kind === "complete") state.complete = true;
          else if (ev.kind === "failure") state.failure ??= ev.message;
        },
        onStderrLine() { /* Retained by the shared process runner. */ },
        onOwnershipEvent(ev) { onEvent(ev); },
      });
      if (cli.uncertainAfterResume) {
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
    } finally { clearInterval(poll); }

    if (cli.timedOut || cli.killed || cli.exitCode !== 0) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", cli.timedOut ? `Codex timed out (${cli.timedOut}).`
        : cli.killed ? "Codex execution interrupted." : state.failure || cli.stderrTail || `Codex exited with code ${cli.exitCode}.`, { executionStarted: true });
    }
    if (state.identityMismatch || state.ref === null) {
      throw new BrokerError(req.native_conversation_ref === null ? "PROVIDER_PROTOCOL_ERROR" : "SESSION_NOT_RESUMABLE",
        "Codex returned missing or conflicting native conversation identity.", { executionStarted: true });
    }
    if (state.failure || !state.complete || state.text === null) {
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", state.failure || "Codex stream closed without a completed turn and agent message.", { executionStarted: true });
    }
    return { native_outcome: "completed", native_conversation_ref: state.ref,
      agent_reported: { summary: state.text.slice(0, 4000), format_status: "text_only" } };
  }

  async shutdownIdleRuntime(_sessionId: string): Promise<void> { return; }
  inspectRuntime(_sessionId: string): RuntimeObservation | null { return null; }
  async interruptTurn(_turnId: string): Promise<boolean> { return false; }
}
