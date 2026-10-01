/**
 * Provider adapter for the Cursor agent CLI.
 *
 * Implements ProviderAdapter contract (§13.2, §14.3) using headless CLI runner.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  parseCursorStreamLine,
  summarizeCursorTurn,
  type CursorStreamEvent,
} from "./streamParser.ts";
import { buildCursorReviewerConfig } from "./reviewerProfile.ts";
import {
  atomicWriteFile,
  buildReviewerHookPolicy,
  readAuditLog,
  writeReviewerHooksConfig,
} from "./reviewerHooks.ts";

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
  stateRoot?: string;
}

/** Native chat-store layout from PROGRAM 2026.09.28-64d2043 (paths.js WI + state/index.ts). */
export function cursorNativeChatStorePath(configDir: string, workspaceCwd: string, nativeConversationId: string): string {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(nativeConversationId)) {
    throw new BrokerError("SESSION_NOT_RESUMABLE", "Cursor native reference is not a safe opaque path component.", { executionStarted: false });
  }
  const workspaceKey = createHash("md5").update(path.resolve(workspaceCwd)).digest("hex");
  return path.join(configDir, "chats", workspaceKey, nativeConversationId, "store.db");
}

function hasSafeNativeStore(storePath: string): boolean {
  const root = path.parse(storePath).root;
  let current = root;
  const components = storePath.slice(root.length).split(path.sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = path.join(current, component);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || (index === components.length - 1 ? !stat.isFile() : !stat.isDirectory())) return false;
    const resolved = path.resolve(realpathSync(current));
    if (process.platform === "win32" ? resolved.toLowerCase() !== current.toLowerCase() : resolved !== current) return false;
  }
  return true;
}

/** Check every existing component before creating descendants or following links. */
function ensurePrivateDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  try {
    for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      const stat = lstatSync(current, { throwIfNoEntry: false });
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
        throw new Error("Directory component is a link or is not a directory");
      }
      if (!stat) {
        try { mkdirSync(current, { mode: 0o700 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const fresh = lstatSync(current);
      if (!fresh.isDirectory() || fresh.isSymbolicLink()) throw new Error("Unsafe directory after creation");
      const observed = path.resolve(realpathSync(current));
      const same = process.platform === "win32"
        ? observed.toLowerCase() === current.toLowerCase()
        : observed === current;
      if (!same) throw new Error("Directory component resolves outside its expected path");
    }
  } catch {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cursor private history directory is unavailable or contains a link.", { executionStarted: false });
  }
}

function assertRegularOwnedFileOrAbsent(filePath: string, fieldName: string): void {
  const stat = lstatSync(filePath, { throwIfNoEntry: false });
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new BrokerError("PROVIDER_INCOMPATIBLE", `Cursor ${fieldName} is a symlink or unsupported file type.`, { executionStarted: false });
  }
}

export class CursorAdapter implements ProviderAdapter {
  readonly providerId = "cursor";
  readonly adapterVersion = "0.2.6";

  readonly stateRoot?: string;
  private readonly binary: string;
  private readonly defaultModel: string;
  private readonly turnPermissionAcquired = new Map<string, boolean>();
  private readonly sessionConfigOwners = new Map<string, string>();
  private fallbackStateRoot: string | null = null;

  constructor(opts: CursorAdapterOptions = {}) {
    this.binary = opts.binary ?? "cursor-agent";
    this.defaultModel = opts.model ?? "";
    this.stateRoot = opts.stateRoot;
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
    const requestSessionHash = createHash("sha256").update(req.session_id).digest("hex");
    const knownRoot = this.stateRoot ?? this.fallbackStateRoot;
    if (this.sessionConfigOwners.has(requestSessionHash) || (knownRoot !== null && knownRoot !== undefined &&
        lstatSync(path.join(path.resolve(knownRoot), "sessions", requestSessionHash, "unsettled-unknown"), { throwIfNoEntry: false }))) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cursor session configuration is busy or execution is unsettled.", { executionStarted: false });
    }
    // Require an operator-selected model; historical defaults can disappear.
    const model = req.requested_model || this.defaultModel;
    if (!model.trim()) {
      throw new BrokerError("MODEL_UNAVAILABLE", "Cursor requires an explicit model from its CLI catalog.", { executionStarted: false });
    }
    if (req.native_conversation_ref !== null && !req.native_conversation_ref.trim()) {
      throw new BrokerError("SESSION_NOT_RESUMABLE", "Cursor resume requires a nonempty native conversation reference.", { executionStarted: false });
    }
    const args = ["--print", "--output-format", "stream-json", "--model", model, "--trust"];
    // Explicitly writable operator-approved workers must execute their checks
    // without an interactive approval prompt. Native explicit denies still win.
    // This is not a claim that the writer scope is a native sandbox.
    if (req.role === "worker" && req.effective_policy?.access === "workspace_write" &&
        Array.isArray(req.effective_policy.write_scope) && req.effective_policy.write_scope.length > 0) args.push("--force");
    // Plan mode can deliver its report via CreatePlan instead of result text.
    if (req.role === "reviewer") args.push("--mode", "ask");
    if (req.workspace_path !== null && req.workspace_path !== undefined && req.workspace_path.length > 0) {
      args.push("--workspace", req.workspace_path);
    }
    if (req.native_conversation_ref !== null && req.native_conversation_ref !== undefined && req.native_conversation_ref.length > 0) {
      args.push("--resume", req.native_conversation_ref);
    }

    let stableConfigDir: string | null = null;
    let turnPolicyDir: string | null = null;
    let auditLogFile: string | null = null;
    let reviewerEnv: NodeJS.ProcessEnv | null = null;
    let pollInterval: NodeJS.Timeout | null = null;
    let sessionLockKey: string | null = null;
    // Typed EXECUTION_UNKNOWN only: blocks later cli-config refresh until reconcile.
    // Known local failures may retain per-turn policy/audit evidence separately.
    let executionUnknown = false;
    let retainTurnEvidence = false;

    try {
      if (req.role === "reviewer") {
        const reviewerConfig = buildCursorReviewerConfig({
          workspace_path: req.workspace_path,
          read_only_input_paths: req.read_only_input_paths,
        });

        const stateRoot = path.resolve(this.stateRoot ??
          (this.fallbackStateRoot ??= mkdtempSync(path.join(realpathSync(os.tmpdir()), "agent-broker-cursor-history-"))));
        const sessionHash = createHash("sha256").update(req.session_id).digest("hex");
        const sessionDir = path.join(stateRoot, "sessions", sessionHash);

        ensurePrivateDirectory(sessionDir);

        const homeDir = path.join(sessionDir, "home");
        const dataDir = path.join(sessionDir, "data");
        const xdgConfigHome = path.join(sessionDir, "xdg-config");
        const xdgCacheHome = path.join(sessionDir, "xdg-cache");
        const xdgDataHome = dataDir;
        stableConfigDir = path.join(sessionDir, "config");
        const turnsRoot = path.join(sessionDir, "turns");

        for (const directory of [homeDir, dataDir, xdgConfigHome, xdgCacheHome, stableConfigDir, turnsRoot]) {
          ensurePrivateDirectory(directory);
        }

        const unsettledMarker = path.join(sessionDir, "unsettled-unknown");
        if (lstatSync(unsettledMarker, { throwIfNoEntry: false })) {
          throw new BrokerError(
            "PROVIDER_INCOMPATIBLE",
            "Cursor session has unsettled unknown execution; config refresh is blocked until reconcile.",
            { executionStarted: false },
          );
        }

        const existingOwner = this.sessionConfigOwners.get(sessionHash);
        if (existingOwner !== undefined) {
          throw new BrokerError(
            "PROVIDER_INCOMPATIBLE",
            "Cursor session config update already in progress for another turn.",
            { executionStarted: false },
          );
        }
        this.sessionConfigOwners.set(sessionHash, req.turn_id);
        sessionLockKey = sessionHash;

        const turnHash = createHash("sha256").update(req.turn_id).digest("hex");
        const candidatePolicyDir = path.join(turnsRoot, turnHash);
        if (lstatSync(candidatePolicyDir, { throwIfNoEntry: false })) {
          throw new BrokerError("PROVIDER_INCOMPATIBLE", "Cursor immutable turn policy already exists.", { executionStarted: false });
        }
        turnPolicyDir = candidatePolicyDir;
        ensurePrivateDirectory(turnPolicyDir);

        const spawnCwd = req.workspace_path ?? process.cwd();
        if (req.native_conversation_ref !== null && req.native_conversation_ref !== undefined && req.native_conversation_ref.length > 0) {
          // Metadata-only availability: exact PROGRAM path contract, immutable cwd bytes, never read store contents.
          const storePath = cursorNativeChatStorePath(stableConfigDir, spawnCwd, req.native_conversation_ref);
          if (!hasSafeNativeStore(storePath)) {
            throw new BrokerError(
              "SESSION_NOT_RESUMABLE",
              "Cursor resume store is unavailable under the owned private chat path.",
              { executionStarted: false },
            );
          }
        }

        const configFile = path.join(stableConfigDir, "cli-config.json");
        assertRegularOwnedFileOrAbsent(configFile, "cli-config.json");
        // Refresh only after prior managed quiescence (serial core turns + no unsettled marker).
        atomicWriteFile(configFile, JSON.stringify(reviewerConfig, null, 2));

        auditLogFile = path.join(turnPolicyDir, "reviewer-audit.jsonl");
        const policyFile = path.join(turnPolicyDir, "reviewer-policy.json");
        assertRegularOwnedFileOrAbsent(policyFile, "reviewer-policy.json");
        // Private exclusions stay precise: the sessions tree (home/data/config/turns
        // for every session) covers stable history and per-turn policy/audit.
        // The broker state root itself is never blanket-forbidden — reviewer slots
        // and bound inputs live under it and must stay readable.
        const hookPolicy = buildReviewerHookPolicy({
          workspace_path: req.workspace_path,
          read_only_input_paths: req.read_only_input_paths,
          forbidden_paths: [path.join(stateRoot, "sessions")],
          audit_log_path: auditLogFile,
          session_id: req.session_id,
          turn_id: req.turn_id,
        });
        atomicWriteFile(policyFile, JSON.stringify(hookPolicy, null, 2));

        writeReviewerHooksConfig({
          homeDir,
          policyPath: policyFile,
        });

        reviewerEnv = {
          ...process.env,
          HOME: homeDir,
          USERPROFILE: homeDir,
          XDG_CONFIG_HOME: xdgConfigHome,
          XDG_CACHE_HOME: xdgCacheHome,
          XDG_DATA_HOME: xdgDataHome,
          CURSOR_CONFIG_DIR: stableConfigDir,
          CURSOR_DATA_DIR: dataDir,
        };
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
      pollInterval = setInterval(checkCancellation, 100);

      const envAllowlist = reviewerEnv !== null
        ? [...CURSOR_ENV_ALLOWLIST, "CURSOR_CONFIG_DIR", "CURSOR_DATA_DIR"]
        : CURSOR_ENV_ALLOWLIST;
      const inheritEnv = reviewerEnv !== null
        ? reviewerEnv
        : process.env;

      // 4. Headless spawn spec and stream event handlers.
      const spec: HeadlessSpawnSpec = {
        binary: this.binary,
        args,
        promptStdin: req.task_envelope,
        cwd: req.workspace_path ?? process.cwd(),
        envAllowlist,
        inheritEnv,
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
            break;
          }
          case "tool_call": {
            const label = (ev.subtype ? `tool_call: ${ev.subtype}` : "tool_call").slice(0, 80);
            onEvent({
              type: "progress",
              payload: { label },
            });
            if (ev.receipt) {
              onEvent({
                type: "tool_receipt",
                payload: {
                  toolkind: ev.receipt.toolkind,
                  status: ev.receipt.status,
                  decision: ev.receipt.decision,
                  pathhash: ev.receipt.pathhash,
                  callid: ev.receipt.callid,
                },
              });
              if (ev.receipt.decision === "deny") {
                onEvent({
                  type: "denial",
                  payload: {
                    toolkind: ev.receipt.toolkind,
                    status: ev.receipt.status,
                    decision: ev.receipt.decision,
                    pathhash: ev.receipt.pathhash,
                    callid: ev.receipt.callid,
                    source: "native",
                  },
                });
              }
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
        retainTurnEvidence = true;
        throw new BrokerError("EXECUTION_UNKNOWN", "Windows managed execution has no quiescence receipt.", { executionStarted: null });
      }
      const summary = summarizeCursorTurn(events);
      // A result record does not override an interrupted or failed process.
      if (cliResult.timedOut || cliResult.killed || cliResult.exitCode !== 0) {
        // Keep private policy/audit evidence even after a known local failure.
        // This retention flag does not classify the broker outcome as UNKNOWN.
        retainTurnEvidence = true;
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
        retainTurnEvidence = true;
        throw new BrokerError("PROVIDER_PROTOCOL_ERROR", summary.resultText || "cursor execution failed", {
          executionStarted: true,
        });
      }

      retainTurnEvidence = true;
      throw new BrokerError("PROVIDER_PROTOCOL_ERROR", "stream closed without result", {
        executionStarted: true,
      });
    } catch (err) {
      if (err instanceof BrokerError && err.code === "EXECUTION_UNKNOWN") {
        executionUnknown = true;
        retainTurnEvidence = true;
      }
      throw err;
    } finally {
      if (pollInterval !== null) {
        clearInterval(pollInterval);
      }
      if (auditLogFile !== null && existsSync(auditLogFile)) {
        try {
          const records = readAuditLog(auditLogFile);
          for (const rec of records) {
            onEvent({
              type: "hook_audit",
              payload: {
                toolkind: rec.toolkind,
                status: rec.status,
                decision: rec.decision,
                pathhash: rec.pathhash,
                callid: rec.callid,
                timestamp_ms: rec.timestamp_ms,
              },
            });
            if (rec.decision === "deny") {
              onEvent({
                type: "denial",
                payload: {
                  toolkind: rec.toolkind,
                  status: rec.status,
                  decision: rec.decision,
                  pathhash: rec.pathhash,
                  callid: rec.callid,
                  source: "hook",
                },
              });
            }
          }
        } catch {
          // ignore audit read failures
        }
      }
      // Never remove stable config/chats/home/data. Only the per-turn policy/audit
      // directory may be removed after definitive completion (not UNKNOWN).
      if (turnPolicyDir !== null && !retainTurnEvidence && !executionUnknown) {
        try {
          rmSync(turnPolicyDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup failures
        }
      }
      if (executionUnknown && stableConfigDir !== null) {
        try {
          const sessionDir = path.dirname(stableConfigDir);
          const marker = path.join(sessionDir, "unsettled-unknown");
          assertRegularOwnedFileOrAbsent(marker, "unsettled-unknown");
          writeFileSync(marker, req.turn_id, { encoding: "utf8", mode: 0o600, flag: "wx" });
        } catch {
          // Core retains the durable unknown launch; keep the in-memory owner
          // blocked as well, even if writing this extra marker failed.
        }
      }
      if (sessionLockKey !== null && !executionUnknown) {
        const owner = this.sessionConfigOwners.get(sessionLockKey);
        if (owner === req.turn_id) this.sessionConfigOwners.delete(sessionLockKey);
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
