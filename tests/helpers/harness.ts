/**
 * Test harness: in-memory registry + real temp workspace directories +
 * seeded registry entities + mock adapter. All tests run without inference.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openRegistryDb, type RegistryDb } from "../../src/storage/db.ts";
import {
  insertAccount,
  insertArtifact as insertArtifactDirect,
  insertBlobRecord as insertBlobRecordDirect,
  insertCoordinator,
  insertCoverageProfile,
  insertPolicyProfile,
  insertProject,
  insertWorkspace,
  sealArtifact as sealArtifactDirect,
} from "../../src/storage/repo.ts";
import { ManualClock } from "../../src/shared/clock.ts";
import { DEFAULT_LIMITS, type Limits } from "../../src/shared/api-types.ts";
import { BrokerCore } from "../../src/core/broker.ts";
import { TurnExecutor } from "../../src/core/execution.ts";
import { MockAdapter } from "../../src/providers/mock/mockAdapter.ts";
import { openBlobStore } from "../../src/snapshots/blobs.ts";
import { openInputViewStore } from "../../src/inputs/views.ts";
import { openReviewSlotStore } from "../../src/workspaces/slot.ts";
import { coverageContractHash } from "../../src/workspaces/coverage.ts";
import type { OperatorRoute } from "../../src/operator/config.ts";

export const COVERAGE_CONFIG = {
  source_prefixes: ["src", "tests"],
  non_source_prefixes: ["dist"],
  excluded_prefixes: [".git", "node_modules"],
};

export interface Harness {
  db: RegistryDb;
  core: BrokerCore;
  executor: TurnExecutor;
  adapter: MockAdapter;
  clock: ManualClock;
  limits: Limits;
  /** Real on-disk workspace root for ws-main (P2 snapshots). */
  workspaceRoot: string;
  blobRoot: string;
  inputRoot: string;
  slotsRoot: string;
  cleanup(): void;
  seed: {
    projectId: string;
    coordinatorId: string;
    outsiderId: string;
    accountMock1: string;
    accountMock2SameQuota: string;
    accountMock3OtherQuota: string;
    workspaceMain: string;
    workspaceOther: string;
    coverageProfileId: string;
  };
  publishArtifact(content: string, kind?: "findings" | "report" | "patch"): { artifact_id: string; content_hash: string; size_bytes: number };
  writeWorkspaceFile(relPath: string, content: string): void;
  spawnWorkerSession(overrides?: Record<string, unknown>): Promise<ReturnType<BrokerCore["spawn"]>>;
  sendTask(sessionId: string, key: string, goal?: string, extra?: Record<string, unknown>): ReturnType<BrokerCore["send"]>;
}

export function createHarness(opts: {
  limits?: Partial<Limits>;
  sessionCap?: number;
  routes?: ReadonlyMap<string, OperatorRoute>;
  configuredWorkspaceIds?: ReadonlySet<string>;
} = {}): Harness {
  const db = openRegistryDb(":memory:");
  const clock = new ManualClock(1_000_000);

  const baseDir = mkdtempSync(path.join(tmpdir(), "agent-broker-ws-"));
  const workspaceRoot = path.join(baseDir, "ws-main");
  mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  writeFileSync(path.join(workspaceRoot, "src", "main.c"), "int main(){return 0;}\n", "utf8");
  const workspaceOtherRoot = path.join(baseDir, "ws-other");
  mkdirSync(path.join(workspaceOtherRoot, "src"), { recursive: true });

  const blobRoot = mkdtempSync(path.join(tmpdir(), "agent-broker-blobs-"));
  const inputRoot = mkdtempSync(path.join(tmpdir(), "agent-broker-inputs-"));
  const slotsRoot = mkdtempSync(path.join(tmpdir(), "agent-broker-slots-"));

  const seed = {
    projectId: "project-parser",
    coordinatorId: "coord-1",
    outsiderId: "coord-outsider",
    accountMock1: "acct-mock-1",
    accountMock2SameQuota: "acct-mock-2",
    accountMock3OtherQuota: "acct-mock-3",
    workspaceMain: "ws-main",
    workspaceOther: "ws-other",
    coverageProfileId: "cov-source",
  };

  insertProject(db, {
    project_id: seed.projectId,
    display_name: "Parser project",
    configuration_revision: 1,
    session_cap: opts.sessionCap ?? 20,
    created_at: clock.now(),
  });
  insertCoordinator(db, {
    coordinator_id: seed.coordinatorId,
    display_name: "Test coordinator",
    allowed_project_ids: [seed.projectId],
    revoked: false,
    config_revision: 1,
  });
  insertCoordinator(db, {
    coordinator_id: seed.outsiderId,
    display_name: "Outsider",
    allowed_project_ids: ["project-other"],
    revoked: false,
    config_revision: 1,
  });
  insertAccount(db, { account_profile_id: seed.accountMock1, provider: "mock", quota_scope_id: "qs-shared", auth_mode: "native" });
  insertAccount(db, { account_profile_id: seed.accountMock2SameQuota, provider: "mock", quota_scope_id: "qs-shared", auth_mode: "native" });
  insertAccount(db, { account_profile_id: seed.accountMock3OtherQuota, provider: "mock", quota_scope_id: "qs-other", auth_mode: "native" });
  insertPolicyProfile(db, {
    policy_profile_id: "pol-writer",
    version: "1",
    config: JSON.stringify({ access: "workspace_write" }),
  });
  insertCoverageProfile(db, {
    coverage_profile_id: seed.coverageProfileId,
    version: "1",
    config: JSON.stringify(COVERAGE_CONFIG),
    contract_hash: coverageContractHash(COVERAGE_CONFIG),
  });
  insertWorkspace(db, {
    workspace_id: seed.workspaceMain,
    project_id: seed.projectId,
    mode: "current",
    canonical_path: workspaceRoot,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: seed.coverageProfileId,
  });
  insertWorkspace(db, {
    workspace_id: seed.workspaceOther,
    project_id: seed.projectId,
    mode: "current",
    canonical_path: workspaceOtherRoot,
    quarantined: false,
    quarantine_reason: null,
    coverage_profile_id: seed.coverageProfileId,
  });

  const adapter = new MockAdapter();
  const adapters = new Map([["mock", adapter]]);
  const limits: Limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const blobStore = openBlobStore(blobRoot);
  const core = new BrokerCore({
    db, clock, adapters, limits, deferExecution: true, blobStore, routes: opts.routes,
    configuredWorkspaceIds: opts.configuredWorkspaceIds,
  });
  const executor = new TurnExecutor({ db, clock, limits, adapters, blobs: blobStore, inputViews: openInputViewStore(inputRoot), slots: openReviewSlotStore(slotsRoot) });
  core.attachExecutor(executor);

  const harness: Harness = {
    db,
    core,
    executor,
    adapter,
    clock,
    limits,
    workspaceRoot,
    blobRoot,
    inputRoot,
    slotsRoot,
    cleanup() {
      db.close();
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(blobRoot, { recursive: true, force: true });
      rmSync(inputRoot, { recursive: true, force: true });
      rmSync(slotsRoot, { recursive: true, force: true });
    },
    seed,
    /** Publish a sealed text artifact (findings-like) into the project store. */
    publishArtifact(content: string, kind: "findings" | "report" | "patch" = "findings"): {
      artifact_id: string;
      content_hash: string;
      size_bytes: number;
    } {
      const blobStore = openBlobStore(blobRoot);
      const written = blobStore.write(seed.projectId, content);
      insertBlobRecordDirect(db, {
        project_id: seed.projectId,
        content_hash: written.hash,
        size_bytes: written.size,
        created_at: clock.now(),
      });
      const artifactId = `art-${Math.random().toString(36).slice(2)}`;
      insertArtifactDirect(db, {
        artifact_id: artifactId,
        project_id: seed.projectId,
        kind,
        content_hash: null,
        size_bytes: null,
        state: "staging",
        created_at: clock.now(),
        sealed_at: null,
        expired_at: null,
      });
      sealArtifactDirect(db, artifactId, written.hash, written.size, clock.now());
      return { artifact_id: artifactId, content_hash: written.hash, size_bytes: written.size };
    },
    writeWorkspaceFile(relPath: string, content: string) {
      const abs = path.join(workspaceRoot, relPath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
    },
    async spawnWorkerSession(overrides: Record<string, unknown> = {}) {
      const req = {
        project_id: seed.projectId,
        idempotency_key: `spawn-${Math.random().toString(36).slice(2)}`,
        provider: "mock",
        account_profile_id: seed.accountMock1,
        model: "mock-model-1",
        effort: null,
        role: "worker" as const,
        instructions: "Implement bounded tasks.",
        workspace: { mode: "current" as const, workspace_id: seed.workspaceMain },
        policy_profile_id: "pol-writer",
        ...overrides,
      };
      return core.spawn(seed.coordinatorId, req);
    },
    sendTask(sessionId: string, key: string, goal = "Implement the parser.", extra: Record<string, unknown> = {}) {
      const req: Record<string, unknown> = {
        session_id: sessionId,
        idempotency_key: key,
        task: { goal, acceptance_criteria: ["Tests pass."], artifact_refs: [] },
      };
      return core.send(seed.coordinatorId, { ...req, ...extra } as Parameters<BrokerCore["send"]>[1]);
    },
  };
  return harness;
}

/**
 * Start deferred turns WITHOUT waiting for completion (harness defers
 * executor start so tests can plan mock scenarios first). Use for turns that
 * are planned to block on barriers/hangs.
 */
export async function start(h: Harness, ...responses: Array<{ turn_id: string }>): Promise<void> {
  for (const resp of responses) {
    h.executor.startTurn(resp.turn_id);
  }
  // Let synchronous executor/adapter prologue settle before assertions.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Drain background execution and fast-forward until all turns settle. */
export async function settle(h: Harness): Promise<void> {
  await h.core.drain();
  await h.executor.drain();
}

/** Wait for one specific turn to settle while others may still be parked. */
export async function settleTurn(h: Harness, turnId: string): Promise<void> {
  await h.executor.waitTurn(turnId);
}

export { BrokerError } from "../../src/shared/errors.ts";
