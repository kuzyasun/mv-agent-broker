/**
 * Daemon bootstrap (§4, §16.1): assemble the registry, blob/input/slot
 * stores, adapter registry and BrokerCore, take lifetime-exclusive
 * ownership of the state directory, run the recovery barrier, and (main.ts)
 * serve the stdio MCP bridge.
 *
 * Adapter registration policy (ADR-0002): the deterministic mock is always
 * present; native adapters are registered only when the operator provides
 * their environment pin. Verification is tracked per capability in the
 * provider matrix; short smoke runs do not establish full role support.
 */
import path from "node:path";
import { lstatSync, mkdirSync } from "node:fs";
import { openRegistryDb, type RegistryDb } from "../storage/db.ts";
import { openBlobStore, type BlobStore } from "../snapshots/blobs.ts";
import { openInputViewStore } from "../inputs/views.ts";
import { openReviewSlotStore } from "../workspaces/slot.ts";
import { RealClock, type Clock } from "../shared/clock.ts";
import { DEFAULT_LIMITS, type Limits } from "../shared/api-types.ts";
import { BrokerCore } from "../core/broker.ts";
import { TurnExecutor } from "../core/execution.ts";
import { DaemonLifecycle, acquireStateDirectoryOwnership, type RecoveryReport, type StateDirectoryOwnership } from "./lifecycle.ts";
import { DeadlineMonitor, validateDeadlinePollInterval } from "./deadlineMonitor.ts";
import type { ProviderAdapter } from "../runtime/adapter.ts";
import { MockAdapter } from "../providers/mock/mockAdapter.ts";
import { CursorAdapter } from "../providers/cursor/cursorAdapter.ts";
import { ClaudeAdapter } from "../providers/claude/claudeAdapter.ts";
import { CodexAdapter } from "../providers/codex/codexAdapter.ts";
import { ZcodeAdapter } from "../providers/zcode/zcodeAdapter.ts";
import { AntigravityAdapter } from "../providers/antigravity/antigravityAdapter.ts";
import type { OperatorRoute } from "../operator/config.ts";

export interface DaemonEnv {
  /** Canonical state directory (registry + blobs + inputs + slots). */
  stateDir: string;
  /** Bridge coordinator profile (operator-configured, §4.2). */
  coordinatorId: string;
  /** Optional provider pins; unset providers are simply not registered. */
  codexBinary?: string;
  claudeBinary?: string;
  cursorBinary?: string;
  zcodeBundlePath?: string;
  zcodeNodeBinary?: string;
  zcodeBuiltinProviderConfigPath?: string;
  antigravityBinary?: string;
  limits?: Partial<Limits>;
  clock?: Clock;
  deadlinePollIntervalMs?: number;
  /** Optional operator-owned registry application after ownership and DB open. */
  configureRegistry?: (db: RegistryDb) => void | Promise<void>;
  routes?: ReadonlyMap<string, OperatorRoute>;
}

function assertDirectoryAncestors(directory: string): void {
  const root = path.parse(directory).root;
  let current = root;
  for (const segment of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe daemon directory ancestor: ${current}`);
  }
}

function ensureOwnedStateChild(stateDir: string, name: "inputs" | "slots"): void {
  const child = path.join(stateDir, name);
  assertDirectoryAncestors(child);
  let stat = lstatSync(child, { throwIfNoEntry: false });
  if (!stat) {
    try { mkdirSync(child); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    stat = lstatSync(child, { throwIfNoEntry: false });
  }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Unsafe daemon ${name} directory.`);
  }
}

export interface Daemon {
  db: RegistryDb;
  blobs: BlobStore;
  core: BrokerCore;
  executor: TurnExecutor;
  lifecycle: DaemonLifecycle;
  recovery: RecoveryReport;
  adapters: Map<string, ProviderAdapter>;
  deadlineMonitor: DeadlineMonitor;
  /** Timer-only teardown after drain; use stop() for a live daemon. */
  stopDeadlineMonitor(): void;
  stop(): Promise<void>;
}

export function buildAdapters(env: DaemonEnv): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  adapters.set("mock", new MockAdapter());
  if (env.codexBinary) adapters.set("codex", new CodexAdapter({ binary: env.codexBinary }));
  if (env.claudeBinary) adapters.set("claude-code", new ClaudeAdapter({ binary: env.claudeBinary }));
  if (env.cursorBinary) {
    adapters.set("cursor", new CursorAdapter({
      binary: env.cursorBinary,
      stateRoot: path.join(env.stateDir, "providers", "cursor"),
    }));
  }
  if (env.zcodeBundlePath) {
    adapters.set("zcode", new ZcodeAdapter({ bundlePath: env.zcodeBundlePath, nodeBinary: env.zcodeNodeBinary, builtinProviderConfigPath: env.zcodeBuiltinProviderConfigPath }));
  }
  if (env.antigravityBinary) {
    adapters.set("antigravity", new AntigravityAdapter({ binary: env.antigravityBinary }));
  }
  return adapters;
}

export async function startDaemon(env: DaemonEnv): Promise<Daemon> {
  // Reject invalid configuration before acquiring ownership or opening state.
  const pollIntervalMs = validateDeadlinePollInterval(env.deadlinePollIntervalMs ?? 50);
  // §4.1.1: lifetime-exclusive ownership STRICTLY BEFORE opening the
  // mutable registry — a second daemon must lose the lock before it can
  // open/migrate any state.
  const stateDir = path.resolve(env.stateDir);
  assertDirectoryAncestors(stateDir);
  mkdirSync(stateDir, { recursive: true });
  assertDirectoryAncestors(stateDir);
  const ownership: StateDirectoryOwnership = await acquireStateDirectoryOwnership(stateDir);
  let db: RegistryDb | null = null;
  try {
    db = openRegistryDb(path.join(stateDir, "registry.sqlite"));
    ensureOwnedStateChild(stateDir, "inputs");
    ensureOwnedStateChild(stateDir, "slots");
    await env.configureRegistry?.(db);
  } catch (error) {
    try { db?.close(); } catch { /* database may not have opened */ }
    await ownership.release();
    throw error;
  }
  if (!db) throw new Error("registry-database-not-open");
  const blobs = openBlobStore(path.join(stateDir, "blobs"));
  const clock = env.clock ?? new RealClock();
  const adapters = buildAdapters(env);
  const limits: Limits = { ...DEFAULT_LIMITS, ...env.limits };

  const lifecycle = new DaemonLifecycle(db, clock);
  const recovery = await lifecycle.start(stateDir, ownership);

  const core = new BrokerCore({
    db,
    clock,
    adapters,
    limits,
    blobStore: blobs,
    worktreesRoot: path.join(stateDir, "worktrees"),
    routes: env.routes,
    // §8.3: durable mutation fencing binds to the lifecycle incarnation so a
    // restarted daemon never inherits a dead process's hold identity.
    incarnation: lifecycle.currentIncarnation,
  });
  const executor = new TurnExecutor({
    db,
    clock,
    limits,
    adapters,
    blobs,
    inputViews: openInputViewStore(path.join(stateDir, "inputs")),
    slots: openReviewSlotStore(path.join(stateDir, "slots")),
  });
  core.attachExecutor(executor);

  executor.attachIncarnation(lifecycle.currentIncarnation);
  try {
    await executor.reconcileJournaledOutcomes();
  } catch (err) {
    console.error("Outcome reconciliation failed:", err);
  }

  // §8.3: resolve worktree provisions the recovery barrier retained (a Git
  // mutation may have happened) BEFORE readiness is served further — owned
  // paths reconcile without duplicate creation, foreign paths quarantine
  // with evidence, uncertain outcomes stay retained for the next restart.
  try {
    core.reconcileRetainedProvisions(recovery.retained_worktree_provisions);
    await core.drain();
  } catch (err) {
    console.error("Worktree provisioning reconciliation failed:", err);
  }

  const deadlineMonitor = new DeadlineMonitor(executor, { intervalMs: pollIntervalMs });
  deadlineMonitor.start();
  lifecycle.attachDeadlineMonitor(deadlineMonitor);
  lifecycle.attachShutdownDrain(() => core.drain());

  const stopDeadlineMonitor = () => {
    deadlineMonitor.stop();
  };

  const stop = () => lifecycle.shutdown();

  return {
    db,
    blobs,
    core,
    executor,
    lifecycle,
    recovery,
    adapters,
    deadlineMonitor,
    stopDeadlineMonitor,
    stop,
  };
}

export function daemonEnvFromProcess(procEnv: NodeJS.ProcessEnv): DaemonEnv {
  const rawInterval = procEnv.AB_DEADLINE_POLL_MS;
  if (rawInterval !== undefined && !/^\d+$/.test(rawInterval)) {
    throw new RangeError("AB_DEADLINE_POLL_MS must contain an integer between 5 and 60000.");
  }
  return {
    stateDir: procEnv.AB_STATE_DIR ?? "./.agent-broker-state",
    coordinatorId: procEnv.AB_COORDINATOR_ID ?? "",
    codexBinary: procEnv.AB_CODEX_BIN,
    claudeBinary: procEnv.AB_CLAUDE_BIN,
    cursorBinary: procEnv.AB_CURSOR_BIN,
    zcodeBundlePath: procEnv.AB_ZCODE_BUNDLE,
    zcodeNodeBinary: procEnv.AB_ZCODE_NODE,
    zcodeBuiltinProviderConfigPath: procEnv.AB_ZCODE_BUILTIN_CONFIG,
    antigravityBinary: procEnv.AB_ANTIGRAVITY_BIN,
    deadlinePollIntervalMs: rawInterval === undefined ? undefined : validateDeadlinePollInterval(Number(rawInterval)),
  };
}
