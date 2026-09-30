/**
 * Daemon bootstrap (§4, §16.1): assemble the registry, blob/input/slot
 * stores, adapter registry and BrokerCore, take lifetime-exclusive
 * ownership of the state directory, run the recovery barrier, and (main.ts)
 * serve the stdio MCP bridge.
 *
 * Adapter registration policy (ADR-0002): the deterministic mock is always
 * present; native adapters are registered only when the operator provides
 * their environment pin — their capabilities remain `documented`, never
 * `supported`, until the P0 spike is authorized.
 */
import path from "node:path";
import { mkdirSync } from "node:fs";
import { openRegistryDb, type RegistryDb } from "../storage/db.ts";
import { openBlobStore, type BlobStore } from "../snapshots/blobs.ts";
import { openInputViewStore } from "../inputs/views.ts";
import { openReviewSlotStore } from "../workspaces/slot.ts";
import { RealClock } from "../shared/clock.ts";
import { DEFAULT_LIMITS, type Limits } from "../shared/api-types.ts";
import { BrokerCore } from "../core/broker.ts";
import { TurnExecutor } from "../core/execution.ts";
import { DaemonLifecycle, acquireStateDirectoryOwnership, type RecoveryReport, type StateDirectoryOwnership } from "./lifecycle.ts";
import type { ProviderAdapter } from "../runtime/adapter.ts";
import { MockAdapter } from "../providers/mock/mockAdapter.ts";
import { CursorAdapter } from "../providers/cursor/cursorAdapter.ts";
import { ClaudeAdapter } from "../providers/claude/claudeAdapter.ts";
import { CodexAdapter } from "../providers/codex/codexAdapter.ts";
import { ZcodeAdapter } from "../providers/zcode/zcodeAdapter.ts";

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
  limits?: Partial<Limits>;
}

export interface Daemon {
  db: RegistryDb;
  blobs: BlobStore;
  core: BrokerCore;
  executor: TurnExecutor;
  lifecycle: DaemonLifecycle;
  recovery: RecoveryReport;
  adapters: Map<string, ProviderAdapter>;
}

export function buildAdapters(env: DaemonEnv): Map<string, ProviderAdapter> {
  const adapters = new Map<string, ProviderAdapter>();
  adapters.set("mock", new MockAdapter());
  if (env.codexBinary) adapters.set("codex", new CodexAdapter({ binary: env.codexBinary }));
  if (env.claudeBinary) adapters.set("claude-code", new ClaudeAdapter({ binary: env.claudeBinary }));
  if (env.cursorBinary) adapters.set("cursor", new CursorAdapter({ binary: env.cursorBinary }));
  if (env.zcodeBundlePath) {
    adapters.set("zcode", new ZcodeAdapter({ bundlePath: env.zcodeBundlePath, nodeBinary: env.zcodeNodeBinary }));
  }
  return adapters;
}

export async function startDaemon(env: DaemonEnv): Promise<Daemon> {
  // §4.1.1: lifetime-exclusive ownership STRICTLY BEFORE opening the
  // mutable registry — a second daemon must lose the lock before it can
  // open/migrate any state.
  const stateDir = path.resolve(env.stateDir);
  mkdirSync(stateDir, { recursive: true });
  const ownership: StateDirectoryOwnership = await acquireStateDirectoryOwnership(stateDir);
  const db = openRegistryDb(path.join(stateDir, "registry.sqlite"));
  const blobs = openBlobStore(path.join(stateDir, "blobs"));
  const clock = new RealClock();
  const adapters = buildAdapters(env);
  const limits: Limits = { ...DEFAULT_LIMITS, ...env.limits };

  const lifecycle = new DaemonLifecycle(db, clock);
  const recovery = await lifecycle.start(stateDir, ownership);

  const core = new BrokerCore({ db, clock, adapters, limits, blobStore: blobs });
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

  return { db, blobs, core, executor, lifecycle, recovery, adapters };
}

export function daemonEnvFromProcess(procEnv: NodeJS.ProcessEnv): DaemonEnv {
  return {
    stateDir: procEnv.AB_STATE_DIR ?? "./.agent-broker-state",
    coordinatorId: procEnv.AB_COORDINATOR_ID ?? "",
    codexBinary: procEnv.AB_CODEX_BIN,
    claudeBinary: procEnv.AB_CLAUDE_BIN,
    cursorBinary: procEnv.AB_CURSOR_BIN,
    zcodeBundlePath: procEnv.AB_ZCODE_BUNDLE,
    zcodeNodeBinary: procEnv.AB_ZCODE_NODE,
  };
}
