/**
 * BrokerCore — deterministic session/turn control plane (spec §6, §7, §10).
 *
 * The authoritative admission boundary (§7.2): idempotency lookup, canonical
 * payload comparison and the final replay/conflict/reject/accept decision are
 * serialized with session/resource checks inside one metadata transaction.
 * Only ACCEPTED operations are recorded in the idempotency ledger; a mutable
 * rejection (RESOURCE_BUSY etc.) frees the key for a later attempt (§7.3).
 */
import { isUtf8 } from "node:buffer";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { RegistryDb } from "../storage/db.ts";
import {
  appendEvent,
  getAccount,
  getCoordinator,
  getCoverageProfile,
  getDaemonState,
  getIdempotencyRecord,
  getProject,
  getPolicyProfile,
  getSession,
  getSnapshotRecord,
  getTurn,
  getTurnEventPayload,
  getWorkspace,
  getArtifact,
  insertIdempotencyRecord,
  insertIntent,
  insertPin,
  insertSession,
  insertTurn,
  insertWorkspace,
  latestCoverageProfileVersion,
  listSessionsByOwner,
  listEventsByTurn,
  listPendingIntents,
  releaseReservation,
  releasePin,
  listActiveReservationsByOwner,
  listPinsByOwner,
  updateIntentState,
  updateSessionFields,
  updateSnapshotState,
  updateTurnFields,
  updateWorkspaceQuarantine,
  SqliteConstraintError,
  type IdempotencyRow,
} from "../storage/repo.ts";
import { BrokerError, type ErrorCode } from "../shared/errors.ts";
import { canonicalRequestHash } from "../shared/canonicalize.ts";
import { newId, ID_PREFIX, sha256Hex } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type {
  AccountProfileRecord,
  AgentRole,
  ArtifactRecord,
  CloseState,
  IdempotencyRecord,
  IntentRecord,
  Limits,
  OperationName,
  SessionRecord,
  SessionState,
  TurnRecord,
  TurnState,
  WorkspaceMode,
  WorkspaceRecord,
} from "../shared/api-types.ts";
import { API_VERSION, DEFAULT_LIMITS } from "../shared/api-types.ts";
import { authorizeOwner, authorizeProjectAccess } from "./authz.ts";
import {
  checkTurnCapacity,
  checkWorkspaceLeaseAvailable,
  reserveSessionSlot,
  reserveTurn,
  workspaceHasConflictingLease,
  workspaceLeaseScope,
  workspaceLeaseTarget,
  type WorkspaceLeaseTarget,
} from "./capacity.ts";
import {
  assertSessionTransition,
  sessionSendAllowed,
  isTerminalTurnState,
  isNonterminalTurnState,
} from "./transitions.ts";
import type { TurnExecutor } from "./execution.ts";
import { activeQuotaCooldown, listActiveQuotaCooldowns } from "./quotaCooldown.ts";
import { computeEffectiveWritePolicy, loadSessionWritePolicy, sessionWriteScope, type EffectiveWritePolicy } from "./policy.ts";
import {
  cloneFrozenPolicy,
  type AdapterPreflightContext,
  type ProviderAdapter,
} from "../runtime/adapter.ts";
import {
  fingerprintReadinessObservation,
  readReadinessObservation,
  type ProviderReadinessObservation,
} from "../providers/common/readiness.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import { captureSnapshot, CaptureError } from "../snapshots/capture.ts";
import { computeSourceDigest, takeInventory } from "../workspaces/inventory.ts";
import {
  PHYSICAL_CWD_BINDING_VERSION,
  readSessionPhysicalBinding,
  resolvePhysicalCheckoutIdentity,
  type PhysicalCheckoutIdentity,
  type SessionPhysicalCwdBinding,
} from "../workspaces/identity.ts";
import { CoverageError, uncoveredWriteScope, validateCoverageConfig, type CoverageConfig } from "../workspaces/coverage.ts";
import {
  WORKTREE_PROVISION_BINDING_VERSION,
  RepositoryMutationLock,
  canonicalizeLockKey,
  computeManagedWorktreePath,
  createRealWorktreeGitRunner,
  inspectWorktreeTarget,
  parseWorktreeJournal,
  preflightSourceRepository,
  receiptsMatch,
  resolveSourceCommonDir,
  resolvesInsideRoot,
  worktreeAddDetached,
  WorktreeGitRunError,
  WorktreePreflightError,
  type RepositoryLockTicket,
  type WorktreeCompletionReceipt,
  type WorktreeGitRunner,
  type WorktreeLaunchReceipt,
  type WorktreeProvisionJournal,
  type WorktreeProvisionStage,
} from "../workspaces/worktree.ts";
import { effectiveRouteTags, type OperatorRoute } from "../operator/config.ts";

// ─── Request DTOs (API 0.2 §10) ─────────────────────────────────────────────

/**
 * Sessions bind policy profile version "1" at spawn (existing convention);
 * the binding — profile config + fingerprint + narrowed restrictions — is
 * captured immutably in the provision_session intent payload (§12.1).
 */
const POLICY_PROFILE_VERSION = "1";

export interface SpawnRequest {
  project_id: string;
  idempotency_key: string;
  route_id?: string;
  provider?: string;
  account_profile_id?: string;
  model?: string;
  effort?: string | null;
  role?: AgentRole;
  instructions: string;
  workspace: {
    mode: WorkspaceMode;
    workspace_id: string | null;
    /** §8.3 additive: registered source repository workspace (mode=worktree). */
    repository_workspace_id?: string | null;
    /** §8.3 additive: explicit full 40/64-hex commit for the detached worktree. */
    base_commit?: string | null;
  };
  policy_profile_id?: string;
  policy_restrictions?: Record<string, unknown>;
}

type ResolvedSpawnRequest = Omit<SpawnRequest, "provider" | "account_profile_id" | "model" | "effort" | "role" | "policy_profile_id"> & {
  provider: string;
  account_profile_id: string;
  model: string;
  effort: string | null;
  role: AgentRole;
  policy_profile_id: string;
};

export interface TaskContract {
  goal: string;
  acceptance_criteria?: string[];
  relevant_paths?: string[];
  context?: string;
  artifact_refs: string[];
  checks?: string[];
}

export type WorkspaceBinding =
  | { workspace_precondition: { expected_snapshot_id: string } }
  | { review_binding: { baseline_snapshot_id: string; target_snapshot_id: string } };

export type SendRequest = {
  session_id: string;
  idempotency_key: string;
  task: TaskContract;
  deadline_ms?: number;
  retry_of_turn_id?: string;
} & WorkspaceBinding;

export interface CancelRequest {
  turn_id: string;
  idempotency_key: string;
  reason?: string;
}

export interface StopRequest {
  session_id: string;
  idempotency_key: string;
}

/**
 * Everything the non-authoritative spawn preflight observed about external
 * state (§7.2 step 3): the adapter version, the registered account binding,
 * the narrowed effective policy and the adapter's optional readiness
 * observation (observed CLI version/catalog/auth — void-compatible adapters
 * leave it null). Carried into the authoritative transaction where a pure
 * fingerprint re-comparison decides whether the observations are still fresh
 * — stale observations are rejected, never admitted.
 */
interface SpawnPreflightCandidate {
  adapter: ProviderAdapter;
  provider: string;
  adapterVersion: string;
  account: AccountProfileRecord;
  policy: EffectiveWritePolicy;
  observation: ProviderReadinessObservation | null;
  fingerprint: string;
  /** §8.3: validated worktree source binding (broker-created worktrees). */
  worktreeSource?: {
    source_workspace_id: string;
    base_commit: string;
    /** realpath-resolved shared Git common dir (lock identity). */
    source_common_dir: string;
    /** Registered canonical path observed at preflight (drift check). */
    source_canonical_path: string;
    /** Coverage binding observed at preflight (drift check). */
    source_coverage_profile_id: string;
  };
}

/**
 * Durable provider binding sealed into the provision_session intent (§12.1,
 * §13.3): the REGISTERED account tuple, the adapter version and the observed
 * readiness evidence at admission. Later turns re-validate live rows against
 * this immutable grant — drift refuses instead of migrating.
 */
interface DurableReadinessMetadata {
  fingerprint: string;
  observed_at: number;
  source: string;
  authenticated: boolean | null;
  model_catalog_size: number | null;
}

export interface DurableProviderBinding {
  binding_version: number;
  account: { account_profile_id: string; provider: string; auth_mode: string; quota_scope_id: string | null };
  adapter_version: string | null;
  cli_version: string | null;
  readiness: DurableReadinessMetadata | null;
}

export type ProviderBindingLookup =
  | { kind: "unbound" }
  | { kind: "bound"; binding: DurableProviderBinding }
  | { kind: "malformed"; reason: string };

// ─── Public response shapes ─────────────────────────────────────────────────

/**
 * §8.3 additive spawn response block for broker-created detached worktrees.
 * No credential and no filesystem path is disclosed — the workspace reference
 * is the broker-generated registered id.
 */
export interface SpawnWorktreeSummary {
  workspace_id: string;
  base_commit: string;
  /** The source checkout's dirty/untracked content is never copied. */
  current_checkout_changes_copied: false;
}

export interface SpawnResponse {
  api_version: string;
  session_id: string;
  state: SessionState;
  initial_snapshot_id: string | null;
  replayed_request: boolean;
  /** §8.3 additive: present for broker-created worktree sessions, else null. */
  worktree: SpawnWorktreeSummary | null;
}

export interface SendResponse {
  api_version: string;
  session_id: string;
  turn_id: string;
  state: TurnState;
  replayed_request: boolean;
}

export interface StopResponse {
  api_version: string;
  session_id: string;
  state: SessionState;
  close_state: CloseState;
  replayed_request: boolean;
}

// ─── Core ───────────────────────────────────────────────────────────────────

export interface BrokerOptions {
  db: RegistryDb;
  clock: Clock;
  limits?: Limits;
  adapters: Map<string, ProviderAdapter>;
  /** Tests: don't auto-start the executor after send; call it explicitly. */
  deferExecution?: boolean;
  /** Content-addressed store for snapshot blobs and manifests (§14.1). */
  blobStore: BlobStore;
  /** §8.3: broker-managed root for detached worktrees (bootstrap: stateDir/worktrees). */
  worktreesRoot?: string;
  /** §8.3 test seam: Git subprocess runner for provisioning (default: real git). */
  worktreeGitRunner?: WorktreeGitRunner;
  /**
   * §8.3 broker incarnation identity for durable mutation fencing (bootstrap:
   * the lifecycle incarnation). Defaults to a fresh process-unique id.
   */
  incarnation?: string;
  /** Operator-configured named routes; routes are in-memory, sessions are durable. */
  routes?: ReadonlyMap<string, OperatorRoute>;
}

export class BrokerCore {
  readonly db: RegistryDb;
  readonly clock: Clock;
  readonly limits: Limits;
  readonly adapters: Map<string, ProviderAdapter>;
  readonly blobStore: BlobStore;
  /** §8.3 managed worktree root; null = broker-created worktrees unconfigured. */
  readonly worktreesRoot: string | null;
  readonly worktreeGitRunner: WorktreeGitRunner;
  /** §8.3 incarnation fencing identity (unique per broker process). */
  readonly worktreeIncarnation: string;
  readonly routes: ReadonlyMap<string, OperatorRoute>;
  private readonly worktreeLocks: RepositoryMutationLock;
  /**
   * §8.3 durable repository fence, mirrored in memory: common-dir keys of
   * repositories with a provision whose owned operation may still be alive
   * or whose effect is unknown. Populated from the durable journals at
   * construction and by every uncertain outcome; a fenced repository never
   * sees another Git mutation while unrelated repositories proceed.
   */
  private readonly worktreeFences = new Set<string>();
  /** Completed Git operations still awaiting authoritative provision verification. */
  private readonly worktreeVerificationFences = new Map<string, Set<string>>();
  /** Unreadable repository scope cannot authorize any new Git mutation. */
  private unknownWorktreeRepositoryScope = false;
  /** Sessions with one in-flight provision body (idempotency guard). */
  private readonly activeWorktreeProvisions = new Set<string>();
  private readonly deferExecution: boolean;
  private executor: TurnExecutor | null = null;
  private background: Promise<unknown>[] = [];

  constructor(opts: BrokerOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.adapters = opts.adapters;
    this.blobStore = opts.blobStore;
    this.worktreesRoot = opts.worktreesRoot ?? null;
    this.worktreeGitRunner = opts.worktreeGitRunner ?? createRealWorktreeGitRunner();
    this.worktreeIncarnation = opts.incarnation ?? randomUUID();
    this.routes = opts.routes ?? new Map();
    this.worktreeLocks = new RepositoryMutationLock(this.worktreeIncarnation);
    this.deferExecution = opts.deferExecution ?? false;
    this.loadWorktreeRepositoryFences();
  }

  /**
   * §8.3 durable restart fence: scan the pending provision journals and fence
   * every repository whose journal proves a dispatched-but-unresolved owned
   * operation (launch receipt present, stage still adding — or a crafted
   * receipt at any pre-completion stage). The journal is the durable fence;
   * this rebuild makes "an old operation may be alive" block new related
   * provisions immediately after ANY restart, while unrelated repositories
   * proceed.
   */
  private loadWorktreeRepositoryFences(): void {
    let rows: Array<{ session_id: string | null; payload: string | null }>;
    try {
      rows = this.db.raw
        .prepare("SELECT session_id, payload FROM intents WHERE kind = 'provision_session' AND state = 'pending'")
        .all() as Array<{ session_id: string | null; payload: string | null }>;
    } catch {
      return;
    }
    for (const row of rows) {
      const session = row.session_id ? getSession(this.db, row.session_id) : null;
      const generated = session?.workspace_id ? getWorkspace(this.db, session.workspace_id) : null;
      const fenceMalformed = (raw: unknown): void => {
        let scoped = false;
        const rawObj = raw && typeof raw === "object" && !Array.isArray(raw)
          ? raw as Record<string, unknown> : {};
        if (typeof rawObj.source_common_dir === "string" && path.isAbsolute(rawObj.source_common_dir)) {
          this.worktreeFences.add(canonicalizeLockKey(rawObj.source_common_dir));
          scoped = true;
        }
        if (typeof rawObj.source_workspace_id === "string") {
          const source = getWorkspace(this.db, rawObj.source_workspace_id);
          if (source?.canonical_path) {
            try {
              this.worktreeFences.add(canonicalizeLockKey(resolveSourceCommonDir(source.canonical_path)));
              scoped = true;
            } catch { /* retain without guessing a checkout lock key */ }
          }
        }
        if (!scoped) this.unknownWorktreeRepositoryScope = true;
        // Quarantine the session-owned row, never a raw JSON workspace id.
        if (generated?.mode === "worktree") {
          updateWorkspaceQuarantine(this.db, generated.workspace_id, true, "worktree-provisioning: malformed-journal-retained");
        }
      };
      if (!row.payload) {
        if (session?.workspace_mode === "worktree") fenceMalformed(null);
        continue;
      }
      try {
        const parsed: unknown = JSON.parse(row.payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          if (session?.workspace_mode === "worktree") fenceMalformed(null);
          continue;
        }
        const raw = (parsed as Record<string, unknown>).worktree_provisioning;
        if (raw === undefined && session?.workspace_mode !== "worktree") continue;
        const journal = parseWorktreeJournal(raw);
        if (journal) {
          const completed = (journal.stage === "added" || journal.stage === "ready") &&
            journal.launch && journal.completion && receiptsMatch(journal.launch, journal.completion);
          if (completed && !journal.failure && row.session_id) {
            this.addWorktreeVerificationFence(canonicalizeLockKey(journal.source_common_dir), row.session_id);
          }
          if (journal.failure?.reason === "uncertain-owned-operation-retained" ||
              (journal.launch && !completed) ||
              ((journal.stage === "added" || journal.stage === "ready") && !completed)) {
            this.worktreeFences.add(canonicalizeLockKey(journal.source_common_dir));
            updateWorkspaceQuarantine(
              this.db,
              journal.workspace_id,
              true,
              "worktree-provisioning: uncertain-owned-operation-retained",
            );
          }
        } else {
          fenceMalformed(raw);
        }
      } catch {
        if (session?.workspace_mode === "worktree") fenceMalformed(null);
      }
    }
  }

  private addWorktreeVerificationFence(key: string, sessionId: string): void {
    const owners = this.worktreeVerificationFences.get(key) ?? new Set<string>();
    owners.add(sessionId);
    this.worktreeVerificationFences.set(key, owners);
  }

  private clearFinishedWorktreeVerificationFence(key: string, sessionId: string): void {
    if (getSession(this.db, sessionId)?.state === "PROVISIONING") return;
    const owners = this.worktreeVerificationFences.get(key);
    owners?.delete(sessionId);
    if (owners?.size === 0) this.worktreeVerificationFences.delete(key);
  }

  /** Wait for all fire-and-forget background work (tests, graceful stop). */
  async drain(): Promise<void> {
    while (this.background.length > 0) {
      const pending = this.background.splice(0, this.background.length);
      await Promise.all(pending.map((p) => Promise.resolve(p).catch(() => undefined)));
    }
    await this.requireExecutor().drain();
  }

  /** Track a background task; drop it from the list once settled. */
  private track(p: Promise<unknown>): void {
    const entry = p.finally(() => {
      this.background = this.background.filter((x) => x !== entry);
    });
    this.background.push(entry);
  }

  /**
   * §8.3 provisioning of one broker-created detached worktree. Tracked
   * background work: acquire the repository-level mutation lock keyed by the
   * source's resolved shared common dir, claim the hold in the journal,
   * inspect the target path, create or reconcile, and — on success — run the
   * final physical binding/snapshot/session completion WHILE STILL HOLDING
   * the repository lock. Every step is staged in the durable journal.
   *
   * Recovery rules (never inference, never deletion, never adoption):
   *   - a journal with a launch receipt at stage "adding" means an owned
   *     operation was dispatched and its effect is UNKNOWN: retain the
   *     journal, quarantine the generated workspace and fence the repository
   *     durably — no re-add, no completion, no TTL;
   *   - stage "added"/"ready" carries durable completion proof (CASed only
   *     after an owned quiescence receipt) and reconciles via the strict
   *     owned-worktree verification below;
   *   - a journal WITHOUT a receipt at stage pending/adding proves the root
   *     was never resumed (the receipt is persisted BEFORE ResumeThread), so
   *     a fresh dispatch may start — and must never fabricate a receipt;
   *   - any preexisting target path on such a proofless provision is
   *     foreign, even a valid matching Git worktree.
   */
  private async provisionDetachedWorktree(sessionId: string): Promise<void> {
    const session0 = getSession(this.db, sessionId);
    if (!session0 || session0.state !== "PROVISIONING") return;
    const initial = readOwnedWorktreeJournal(this.db, sessionId);
    if (!initial) return;
    if (this.activeWorktreeProvisions.has(sessionId)) return;
    this.activeWorktreeProvisions.add(sessionId);
    const runner = this.worktreeGitRunner;
    type Outcome =
      | { kind: "ready" }
      | { kind: "retained" }
      | { kind: "retained-uncertain" }
      | { kind: "superseded" }
      | { kind: "foreign"; reason: string }
      | { kind: "git-failed"; reason: string };
    try {
      await this.worktreeLocks.withLock(initial.source_common_dir, async (ticket): Promise<void> => {
        const decide = async (): Promise<Outcome> => {
          // A prior uncertain outcome durably fences this repository: no new
          // related Git mutation may start while an old one may be alive.
          if (this.unknownWorktreeRepositoryScope || this.worktreeFences.has(ticket.key)) return { kind: "retained" };
          const verificationOwners = this.worktreeVerificationFences.get(ticket.key);
          if (verificationOwners?.size && !verificationOwners.has(sessionId)) return { kind: "retained" };
          const session = getSession(this.db, sessionId);
          if (!session || session.state !== "PROVISIONING") return { kind: "superseded" };
          const fresh = readOwnedWorktreeJournal(this.db, sessionId);
          if (!fresh) return { kind: "superseded" };
          // Claim this exact hold in the journal BEFORE any decision: every
          // later CAS transition validates the journal's lock token against
          // THIS hold (hold_id + incarnation), so a stale or reused
          // process-local sequence can never authorize an owner change.
          if (!this.claimWorktreeHold(sessionId, fresh.stage, ticket)) return { kind: "superseded" };
          const source = getWorkspace(this.db, fresh.source_workspace_id);
          if (!source?.canonical_path) {
            return { kind: "git-failed", reason: "worktree-source-workspace-missing" };
          }
          const inspect = (allowOwned: boolean) =>
            inspectWorktreeTarget({
              managedRoot: fresh.managed_root,
              worktreePath: fresh.worktree_path,
              sourceCommonDir: fresh.source_common_dir,
              baseCommit: fresh.base_commit,
              runner,
              allowOwned,
            });

          if (fresh.stage === "ready") {
            // Restarted when stage was already ready: validate completion matches launch before completing.
            if (!fresh.launch || !fresh.completion || !receiptsMatch(fresh.launch, fresh.completion)) {
              return { kind: "retained-uncertain" };
            }
            const verified = await inspect(true);
            if (verified.kind === "owned") {
              if (!this.casWorktreeJournalStage(sessionId, "ready", "ready", ticket)) return { kind: "superseded" };
              this.completeProvisioningIfNeeded(sessionId, true); // inside the lock
              return { kind: "ready" };
            }
            if (verified.kind === "absent") {
              return { kind: "git-failed", reason: "worktree-verified-state-vanished" };
            }
            if (verified.kind === "uncertain") return { kind: "retained-uncertain" };
            return { kind: "foreign", reason: verified.reason };
          }

          if (fresh.stage === "added") {
            // Stage "added": durable completion proof (quiesced) required.
            if (!fresh.launch || !fresh.completion || !receiptsMatch(fresh.launch, fresh.completion)) {
              return { kind: "retained-uncertain" };
            }
            const verified = await inspect(true);
            if (verified.kind === "owned") {
              if (!this.casWorktreeJournalStage(sessionId, "added", "ready", ticket)) return { kind: "superseded" };
              this.completeProvisioningIfNeeded(sessionId, true); // inside the lock
              return { kind: "ready" };
            }
            if (verified.kind === "absent") {
              // Known-completed state destroyed externally: fail closed with
              // evidence, never re-add and never adopt a replacement.
              return { kind: "git-failed", reason: "worktree-verified-state-vanished" };
            }
            if (verified.kind === "uncertain") return { kind: "retained-uncertain" };
            return { kind: "foreign", reason: verified.reason };
          }

          if (fresh.launch) {
            // An owned operation was dispatched; its receipt is durable.
            // Unknown effect — possibly still running or killed mid-flight:
            // retain unconditionally (the receipt content is never trusted
            // as completion; only the owned quiescence proof would be).
            return { kind: "retained-uncertain" };
          }

          // No receipt: the mutation root was never resumed (pending, or an
          // adding attempt that provably never executed). Re-dispatching is
          // safe; any preexisting path is foreign (allowOwned=false).
          if (fresh.stage === "pending") {
            if (!this.casWorktreeJournalStage(sessionId, "pending", "adding", ticket)) return { kind: "superseded" };
          }
          const found = await inspect(false);
          if (found.kind === "uncertain") return { kind: "retained" };
          if (found.kind === "foreign") return { kind: "foreign", reason: found.reason };
          let completion: WorktreeCompletionReceipt;
          try {
            completion = await worktreeAddDetached({
              sourcePath: source.canonical_path,
              worktreePath: fresh.worktree_path,
              baseCommit: fresh.base_commit,
              runner,
              onOwnership: (receipt) => {
                // A queued provision's registered alias may have been retargeted
                // since admission. Refuse before resume rather than mutating a
                // repository other than the one whose lock is held.
                if (canonicalizeLockKey(resolveSourceCommonDir(source.canonical_path!)) !== ticket.key) {
                  throw new WorktreeGitRunError("worktree-source-repository-drift", true);
                }
                this.recordWorktreeLaunchReceipt(sessionId, ticket, receipt);
              },
            });
          } catch (e) {
            if (e instanceof WorktreeGitRunError && !e.definitive) {
              // Uncertain after resume: retain the journal with its receipt
              // and fence the repository durably (no TTL, no PID release).
              return { kind: "retained-uncertain" };
            }
            // Definitive refusal/clean death: launch was refused or failed definitively.
            // Never adopt preexisting matching files without verified completion proof.
            const after = await inspect(false);
            if (after.kind === "uncertain") return { kind: "retained" };
            if (after.kind === "foreign") return { kind: "foreign", reason: after.reason };
            return { kind: "git-failed", reason: e instanceof WorktreeGitRunError ? e.reason : "git-execution-failed" };
          }
          // Owned quiescence proof received. Record the durable completion
          // stage FIRST (so a crash still reconciles without duplicate add),
          // then verify the exact allocation and complete under this hold.
          if (!this.casWorktreeJournalStage(sessionId, "adding", "added", ticket, completion)) return { kind: "superseded" };
          const verified = await inspect(true);
          if (verified.kind === "owned") {
            if (!this.casWorktreeJournalStage(sessionId, "added", "ready", ticket)) return { kind: "superseded" };
            this.completeProvisioningIfNeeded(sessionId, true); // inside the lock
            return { kind: "ready" };
          }
          if (verified.kind === "absent") {
            return { kind: "git-failed", reason: "worktree-add-did-not-produce-the-expected-worktree" };
          }
          if (verified.kind === "uncertain") return { kind: "retained-uncertain" };
          return { kind: "foreign", reason: verified.reason };
        };
        // Apply every outcome before releasing the repository lock. A queued
        // holder must observe the fence, and a late failure cannot affect a
        // replacement hold after unlock.
        try {
          const outcome = await decide();
          switch (outcome.kind) {
            case "superseded":
            case "ready":
              return; // journals stay pending on uncertainty; ready completed in-lock
            case "retained": {
              const journal = readOwnedWorktreeJournal(this.db, sessionId);
              if (journal && journal.launch && journal.stage !== "added" && journal.stage !== "ready") {
                updateWorkspaceQuarantine(
                  this.db,
                  journal.workspace_id,
                  true,
                  "worktree-provisioning: uncertain-owned-operation-retained",
                );
              }
              return;
            }
            case "retained-uncertain": {
              // Durable fence for this repository + quarantine evidence; the
              // journal keeps stage "adding" with its receipt, intent pending.
              this.worktreeFences.add(ticket.key);
              const journal = readOwnedWorktreeJournal(this.db, sessionId);
              const recorded = journal && this.updateWorktreeJournalPayload(sessionId, journal.stage, (current) =>
                current.lock?.hold_id === ticket.hold_id && current.lock.incarnation === ticket.incarnation && current.lock.key === ticket.key
                  ? { ...current, failure: { reason: "uncertain-owned-operation-retained" } } : null);
              if (journal && recorded) {
                updateWorkspaceQuarantine(
                  this.db,
                  journal.workspace_id,
                  true,
                  "worktree-provisioning: uncertain-owned-operation-retained",
                );
              }
              return;
            }
            case "foreign":
              this.failWorktreeProvisioning(sessionId, `foreign-target: ${outcome.reason}`, outcome.reason, ticket);
              return;
            case "git-failed":
              this.failWorktreeProvisioning(sessionId, `git-worktree-add-failed: ${outcome.reason}`, "git-add-failed", ticket);
              return;
          }
        } finally {
          this.clearFinishedWorktreeVerificationFence(ticket.key, sessionId);
        }
      });
    } finally {
      this.activeWorktreeProvisions.delete(sessionId);
    }
  }

  /**
   * Record the active repository-lock hold in the pending journal INSIDE a
   * transaction (fencing claim). Every later stage transition validates
   * against this exact hold token, so a live/late holder can never commit
   * under another owner and a reused process-local sequence from a dead
   * incarnation never authorizes anything.
   */
  private claimWorktreeHold(sessionId: string, expectStage: WorktreeProvisionStage, ticket: RepositoryLockTicket): boolean {
    return this.updateWorktreeJournalPayload(sessionId, expectStage, (journal) => {
      const lock = journal.lock;
      if (lock !== null && lock.incarnation === ticket.incarnation && lock.hold_id !== ticket.hold_id) {
        return null;
      }
      return {
        ...journal,
        lock: worktreeLockFence(ticket),
      };
    });
  }

  /** Persist the exact owned launch receipt durably BEFORE the root resume. */
  private recordWorktreeLaunchReceipt(
    sessionId: string,
    ticket: RepositoryLockTicket,
    receipt: WorktreeLaunchReceipt,
  ): void {
    const ok = this.updateWorktreeJournalPayload(sessionId, "adding", (journal) => {
      const lock = journal.lock;
      const exactHold =
        lock !== null &&
        lock.key === ticket.key &&
        lock.hold_id === ticket.hold_id &&
        lock.incarnation === ticket.incarnation;
      if (!exactHold || journal.launch !== null) return null;
      return {
        ...journal,
        launch: receipt,
      };
    });
    if (!ok) {
      throw new Error("worktree-launch-receipt-not-recorded");
    }
  }

  /**
   * Compare-and-set one journal stage INSIDE a transaction. Fails (false)
   * when the intent is no longer pending, the stage moved, or the journal's
   * recorded lock is not the EXACT active hold token (key + hold_id +
   * incarnation) — the caller treats the provision as superseded and never
   * transitions on someone else's hold.
   */
  private casWorktreeJournalStage(
    sessionId: string,
    expectStage: WorktreeProvisionStage,
    nextStage: WorktreeProvisionStage,
    ticket: RepositoryLockTicket,
    completion?: WorktreeCompletionReceipt,
  ): boolean {
    const updated = this.updateWorktreeJournalPayload(sessionId, expectStage, (journal) => {
      const lock = journal.lock;
      const exactHold =
        lock !== null &&
        lock.key === ticket.key &&
        lock.hold_id === ticket.hold_id &&
        lock.incarnation === ticket.incarnation;
      if (!exactHold) return null; // stale/foreign/reused token: refuse
      if (nextStage === "added") {
        if (!completion || !journal.launch) return null;
        if (!receiptsMatch(journal.launch, completion)) return null;
      }
      return {
        ...journal,
        stage: nextStage,
        lock: worktreeLockFence(ticket),
        ...(completion ? { completion } : {}),
      };
    });
    if (updated && nextStage === "added") this.addWorktreeVerificationFence(ticket.key, sessionId);
    return updated;
  }

  /**
   * Transactional journal payload update used by the claim/receipt/CAS
   * primitives. `edit` returns the new journal or null to refuse. Never
   * touches malformed journals (they stay retained verbatim).
   */
  private updateWorktreeJournalPayload(
    sessionId: string,
    expectStage: WorktreeProvisionStage,
    edit: (journal: WorktreeProvisionJournal) => WorktreeProvisionJournal | null,
  ): boolean {
    return this.db.tx(() => {
      const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
      if (!intent?.payload) return false;
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(intent.payload);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
        payload = parsed as Record<string, unknown>;
      } catch {
        return false;
      }
      const journal = parseWorktreeJournal(payload.worktree_provisioning);
      if (!journal) {
        return false;
      }
      if (journal.stage !== expectStage) {
        return false;
      }
      const next = edit(journal);
      if (!next) return false;
      payload.worktree_provisioning = next;
      const updated = this.db.raw
        .prepare("UPDATE intents SET payload = ?, updated_at = ? WHERE intent_id = ? AND state = 'pending'")
        .run(JSON.stringify(payload), this.now(), intent.intent_id);
      return Number(updated.changes) === 1;
    });
  }

  /**
   * §8.3 definitive provisioning failure: the generated workspace row is
   * quarantined with bounded evidence, the session BLOCKED, the intent failed
   * — one atomic transaction. The accepted idempotency key remains; the
   * foreign path itself is never touched.
   */
  private failWorktreeProvisioning(sessionId: string, reason: string, evidence: string, ticket: RepositoryLockTicket): void {
    const now = this.now();
    this.db.tx(() => {
      const session = getSession(this.db, sessionId);
      if (!session || session.state !== "PROVISIONING") return;
      const journal = readOwnedWorktreeJournal(this.db, sessionId);
      if (!journal || journal.lock?.hold_id !== ticket.hold_id ||
          journal.lock.incarnation !== ticket.incarnation || journal.lock.key !== ticket.key) return;
      if (journal) {
        updateWorkspaceQuarantine(this.db, journal.workspace_id, true, `worktree-provisioning: ${evidence}`);
      }
      assertSessionTransition(session.state, "provisioning_failed");
      updateSessionFields(
        this.db,
        sessionId,
        { state: "BLOCKED", block_reason: `provisioning-failed: ${reason}` },
        session.record_version,
        now,
      );
      const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
      if (intent) updateIntentState(this.db, intent.intent_id, "failed", now);
      appendEvent(this.db, {
        turn_id: null,
        session_id: sessionId,
        type: "session_provisioning_failed",
        payload: {
          reason,
          evidence,
          ...(journal ? { workspace_id: journal.workspace_id, base_commit: journal.base_commit } : {}),
        },
        created_at: now,
      });
    });
  }

  /** Wired post-construction to avoid a constructor cycle. */
  attachExecutor(executor: TurnExecutor): void {
    this.executor = executor;
  }

  /**
   * §8.3 bootstrap reconciliation entry: advance retained worktree provisions
   * (a no-op for sessions already in a defined state). Scheduling only —
   * callers drain() to await the bounded Git work.
   */
  reconcileRetainedProvisions(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.completeProvisioningIfNeeded(sessionId);
  }

  private requireExecutor(): TurnExecutor {
    if (!this.executor) throw new Error("executor-not-attached");
    return this.executor;
  }

  private now(): number {
    return this.clock.now();
  }

  private assertAdmissionOpen(): void {
    const state = getDaemonState(this.db);
    if (state && state.daemon_state !== "READY") {
      throw new BrokerError("DAEMON_NOT_READY", "Daemon is not accepting new sessions or turns.", { executionStarted: false });
    }
  }

  /**
   * Named-profile enablement is a selection control for NEW named spawns,
   * never provider/account revocation: raw explicit spawns keep their
   * existing authorization and existing bound sessions continue. Called
   * AFTER the committed replay lookup and BEFORE preflight/provisioning,
   * and repeated inside the authoritative transaction after its own replay
   * lookup — a route disabled mid-admission refuses instead of admitting.
   */
  private assertRouteAdmission(req: ResolvedSpawnRequest): void {
    if (req.route_id === undefined) return;
    const route = this.routes.get(req.route_id);
    if (route && route.enabled === false) {
      throw new BrokerError(
        "INVALID_REQUEST",
        `Route '${route.route_id}' is disabled; new sessions are refused.`,
        { executionStarted: false },
      );
    }
  }

  // ─── spawn (§6.1, §7.3) ───────────────────────────────────────────────────

  private resolveSpawnRequest(req: SpawnRequest): ResolvedSpawnRequest {
    if (typeof req.instructions !== "string") {
      throw new BrokerError("INVALID_REQUEST", "instructions must be a string.", { executionStarted: false });
    }
    const routeId = req.route_id;
    if (routeId !== undefined) {
      if (typeof routeId !== "string" || routeId.length === 0) {
        throw new BrokerError("INVALID_REQUEST", "route_id must be a non-empty string.", { executionStarted: false });
      }
      const route = this.routes.get(routeId);
      if (!route) {
        throw new BrokerError("INVALID_REQUEST", `Unknown route '${routeId}'.`, { executionStarted: false });
      }
      if (route.project_id !== req.project_id) {
        throw new BrokerError("UNAUTHORIZED", `Route '${routeId}' is not configured for this project.`, { executionStarted: false });
      }
      for (const field of ["provider", "account_profile_id", "model", "effort", "role", "policy_profile_id"] as const) {
        if (req[field] !== undefined) {
          throw new BrokerError("INVALID_REQUEST", `route_id cannot be mixed with raw binding field '${field}'.`, {
            executionStarted: false,
          });
        }
      }
      const preference = route.native_subagents ?? { mode: "off", max_agents: 1 };
      let advisory: string;
      if (preference.mode === "off") {
        advisory = `\n\n[Broker advisory: mode=off, max_agents=${preference.max_agents}. Perform this task as one agent. Do not delegate to native subagents. This preference does not enforce agent count, child models, or permissions.]`;
      } else if (preference.mode === "prefer") {
        advisory = `\n\n[Broker advisory: mode=prefer, max_agents=${preference.max_agents}. Prefer native subagents for independent pieces of large tasks when available; request at most ${preference.max_agents} children and wait for their results. Do not simulate delegation when unavailable. This preference does not enforce agent count, child models, or permissions.]`;
      } else {
        advisory = "\n\n[Broker advisory: mode=auto. Agent decides whether native delegation is useful; when useful, let the vendor choose the number of native children, wait for their results, and do not simulate children. This preference does not enforce agent count, child models, or permissions.]";
      }
      return {
        ...req,
        provider: route.provider,
        account_profile_id: route.account_profile_id,
        model: route.model,
        effort: route.effort ?? null,
        role: route.role,
        policy_profile_id: route.policy_profile_id,
        instructions: `${req.instructions}${advisory}`,
      };
    }
    const required = ["provider", "account_profile_id", "model", "role", "policy_profile_id"] as const;
    for (const field of required) {
      if (req[field] === undefined || req[field] === null || req[field] === "") {
        throw new BrokerError("INVALID_REQUEST", `Explicit provider binding field '${field}' is required.`, { executionStarted: false });
      }
    }
    if (!["worker", "reviewer", "researcher"].includes(req.role as string)) {
      throw new BrokerError("INVALID_REQUEST", "role must be worker|reviewer|researcher.", { executionStarted: false });
    }
    for (const field of ["provider", "account_profile_id", "model", "policy_profile_id"] as const) {
      if (typeof req[field] !== "string") {
        throw new BrokerError("INVALID_REQUEST", `Explicit provider binding field '${field}' must be a string.`, { executionStarted: false });
      }
    }
    if (req.effort !== undefined && req.effort !== null && typeof req.effort !== "string") {
      throw new BrokerError("INVALID_REQUEST", "effort must be a string or null.", { executionStarted: false });
    }
    return {
      ...req,
      provider: req.provider!,
      account_profile_id: req.account_profile_id!,
      model: req.model!,
      effort: req.effort ?? null,
      role: req.role!,
      policy_profile_id: req.policy_profile_id!,
    };
  }

  spawn(coordinatorId: string, request: SpawnRequest): SpawnResponse {
    // Step 1 (§7.2): authorization first — revoked access denies even replay.
    authorizeProjectAccess(this.db, { coordinatorId, projectId: request.project_id });
    const req = this.resolveSpawnRequest(request);

    const payloadHash = canonicalRequestHash(req);
    const namespace = {
      project_id: req.project_id,
      owner_coordinator_id: coordinatorId,
      operation_name: "agent_session_spawn" as OperationName,
      idempotency_key: req.idempotency_key,
    };

    // Fast path (step 2): committed lookup only — an optimization. An
    // accepted same-key replay NEVER re-runs readiness (§7.2 ordering).
    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast) return this.replaySpawn(fast, payloadHash);
    // Named-profile disablement gates NEW spawns only — AFTER the committed
    // same-key replay above (an accepted IDLE/PROVISIONING spawn survives
    // metadata edits and disablement), BEFORE fresh preflight/provisioning.
    this.assertRouteAdmission(req);
    this.assertAdmissionOpen();

    // Step 3: non-authoritative preflight (no inference): account binding,
    // policy narrowing, adapter.preflight. Any failure here creates no
    // accepted state and leaves the key free for a corrected retry (§7.3).
    const candidate = this.spawnPreflight(req);

    // Steps 4–6: authoritative serialized decision + effects in one tx.
    let sessionId: string | null = null;
    let provisionIntentId: string | null = null;
    try {
      this.db.tx(() => {
        authorizeProjectAccess(this.db, { coordinatorId, projectId: req.project_id });
        const existing = getIdempotencyRecord(this.db, namespace);
        if (existing) {
          if (existing.request_hash !== payloadHash) {
            throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.", {
              retryGuidance: "new_key_required",
            });
          }
          sessionId = existing.resolved_id; // committed winner: no readiness re-run
          return;
        }
        this.assertAdmissionOpen();
        // Metadata is excluded from the request hash, so the replay lookup
        // above already covered accepted work; this fresh named-profile
        // admission repeats the enablement check inside the authoritative
        // transaction, then revalidates the preflight candidate against
        // fresh pure reads (§7.2): config that drifted during admission is
        // rejected instead of admitting the stale preflight observation.
        // No external process runs here.
        this.assertRouteAdmission(req);
        this.revalidateSpawnCandidate(req, candidate);

        const created = this.createProvisioningSession(coordinatorId, req, payloadHash, candidate);
        sessionId = created.sessionId;
        provisionIntentId = created.provisionIntentId;
      });
    } catch (e) {
      if (e instanceof SqliteConstraintError) {
        // Idempotency unique race: converge to the committed operation (§7.2)
        // — with the same payload only; a different payload is a conflict.
        const existing = getIdempotencyRecord(this.db, namespace);
        if (existing) {
          if (existing.request_hash !== payloadHash) {
            throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.", {
              retryGuidance: "new_key_required",
            });
          }
          sessionId = existing.resolved_id;
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
    if (!sessionId) throw new Error("spawn-no-session");

    // Provisioning completion runs in its own transaction (journaled intent),
    // so a crash between the two windows recovers via the pending intent.
    this.completeProvisioningIfNeeded(sessionId);

    const session = getSession(this.db, sessionId);
    if (!session) throw new Error("unreachable");
    return {
      api_version: API_VERSION,
      session_id: session.session_id,
      state: session.state,
      initial_snapshot_id: session.initial_snapshot_id,
      replayed_request: provisionIntentId === null,
      worktree: this.worktreeSummary(sessionId),
    };
  }

  private replaySpawn(rec: IdempotencyRow, payloadHash: string): SpawnResponse {
    if (rec.request_hash !== payloadHash) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.", {
        retryGuidance: "new_key_required",
      });
    }
    const session = getSession(this.db, rec.resolved_id ?? "");
    if (!session) throw new BrokerError("INVALID_REQUEST", "Idempotent record points to a missing session.");
    // Same accepted key after a lost response (§7.3): the committed session and
    // its bound resources are returned unchanged; a provisioning window that
    // is still open is advanced (idempotently) instead of left stuck.
    if (session.state === "PROVISIONING") this.completeProvisioningIfNeeded(session.session_id);
    const fresh = getSession(this.db, session.session_id) ?? session;
    return {
      api_version: API_VERSION,
      session_id: fresh.session_id,
      state: fresh.state,
      initial_snapshot_id: fresh.initial_snapshot_id,
      replayed_request: true,
      worktree: this.worktreeSummary(fresh.session_id),
    };
  }

  /**
   * §8.3 additive response block: read from the session-owned provision
   * journal so replays and failure states report the SAME bound workspace id
   * and base commit. No credentials, no filesystem paths.
   */
  private worktreeSummary(sessionId: string): SpawnWorktreeSummary | null {
    const journal = readOwnedWorktreeJournal(this.db, sessionId);
    if (!journal) return null;
    return {
      workspace_id: journal.workspace_id,
      base_commit: journal.base_commit,
      current_checkout_changes_copied: false,
    };
  }

  /**
   * Non-authoritative spawn preflight (§7.2 step 3, §13.2): input shape,
   * provider availability, registered account binding, §12.1 policy
   * narrowing, then adapter.preflight WITHOUT inference — always OUTSIDE the
   * admission transaction (no external process inside a tx). Returns the
   * candidate binding the transaction must revalidate.
   */
  private spawnPreflight(req: ResolvedSpawnRequest): SpawnPreflightCandidate {
    if (Buffer.byteLength(req.instructions, "utf8") > 64 * 1024) {
      throw new BrokerError("INPUT_LIMIT", "Session instructions exceed 64 KiB.");
    }
    if (!req.idempotency_key || req.idempotency_key.length > 256) {
      throw new BrokerError("INVALID_REQUEST", "Invalid idempotency key.");
    }
    if (!req.model) throw new BrokerError("INVALID_REQUEST", "Explicit provider model is required.");
    const adapter = this.adapters.get(req.provider);
    if (!adapter) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `Provider '${req.provider}' is not available.`);
    }
    if (req.role === "reviewer" && req.workspace.mode !== "review_slot") {
      throw new BrokerError("INVALID_REQUEST", "role=reviewer requires workspace.mode=review_slot (§8.1).");
    }
    // §8.3 workspace field contract, decided BEFORE any accepted resource:
    // broker-created detached worktrees need a registered same-project source
    // repository reference plus an explicit full-hex commit; contradictory or
    // missing fields are rejected here and leave the idempotency key free.
    const worktreeSource = this.worktreeSpawnPreflight(req);
    // §13.3 account binding: a registered account of the matching provider is
    // required BEFORE any accepted session/reservation exists.
    const account = getAccount(this.db, req.account_profile_id);
    if (!account) {
      throw new BrokerError(
        "INVALID_REQUEST",
        `Account profile '${req.account_profile_id}' is not registered.`,
        { executionStarted: false },
      );
    }
    if (account.provider !== req.provider) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Account profile '${account.account_profile_id}' is registered for provider '${account.provider}', not '${req.provider}'.`,
        { executionStarted: false },
      );
    }
    // §12.1 policy preflight: requested restrictions validated and narrowed
    // against the operator profile BEFORE any session/reservation exists.
    const policy = cloneFrozenPolicy(this.spawnPolicyPreflight(req));
    const candidate: SpawnPreflightCandidate = {
      adapter,
      provider: req.provider,
      adapterVersion: adapter.adapterVersion,
      account,
      policy,
      observation: null,
      fingerprint: "",
    };

    // §13.2 provider readiness: the adapter decides from the broker-supplied
    // context (model/effort/role/workspace/account/policy) with zero
    // inference. Known no-dispatch failures keep their code/message with
    // executionStarted=false; anything unexpected is PROVIDER_INCOMPATIBLE.
    // A returned readiness observation is validated defensively; malformed non-void
    // returns refuse admission rather than dropping required evidence.
    try {
      const returned = adapter.preflight({
        provider: req.provider,
        model: req.model,
        effort: req.effort,
        role: req.role,
        workspace_mode: req.workspace.mode,
        account: {
          account_profile_id: account.account_profile_id,
          auth_mode: account.auth_mode,
          quota_scope_id: account.quota_scope_id,
        },
        effective_policy: candidate.policy,
      } satisfies AdapterPreflightContext);
      candidate.observation = readReadinessObservation(returned, adapter.providerId);
    } catch (e) {
      if (e instanceof BrokerError) {
        throw new BrokerError(e.code, e.message, {
          phase: e.phase,
          retryGuidance: e.retryGuidance,
          executionStarted: false,
          details: e.details,
        });
      }
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Provider preflight failed: ${e instanceof Error ? e.message : String(e)}`,
        { executionStarted: false },
      );
    }
    candidate.fingerprint = spawnCandidateFingerprint({
      provider: req.provider,
      adapterVersion: adapter.adapterVersion,
      account,
      policy,
      observation: candidate.observation,
      worktreeSource,
    });
    if (worktreeSource) candidate.worktreeSource = worktreeSource;
    return candidate;
  }

  /**
   * §8.3 worktree spawn preflight (§7.2 step 3): field-shape contradictions
   * and missing references first, then the registered source repository
   * checks (same project, repository mode, not quarantined), then the bounded
   * Git preflight — the canonical path must be a real Git repository and the
   * explicit base commit must exist. Everything here runs OUTSIDE any
   * transaction and creates no accepted state; a failure frees the key.
   * Registered worktree workspaces (mode=worktree + workspace_id) keep their
   * established contract untouched.
   */
  private worktreeSpawnPreflight(req: SpawnRequest): NonNullable<SpawnPreflightCandidate["worktreeSource"]> | null {
    const workspace = req.workspace;
    const hasSource = workspace.repository_workspace_id !== undefined && workspace.repository_workspace_id !== null;
    const hasCommit = workspace.base_commit !== undefined && workspace.base_commit !== null;
    if (workspace.mode !== "worktree") {
      if (hasSource || hasCommit) {
        throw new BrokerError(
          "INVALID_REQUEST",
          "repository_workspace_id/base_commit are only valid with workspace.mode=worktree (§8.3).",
          { executionStarted: false },
        );
      }
      return null;
    }
    if (workspace.workspace_id && (hasSource || hasCommit)) {
      throw new BrokerError(
        "INVALID_REQUEST",
        "A registered worktree workspace reference contradicts broker-created worktree fields (§8.3).",
        { executionStarted: false },
      );
    }
    if (workspace.workspace_id) return null; // registered worktree path: unchanged contract
    if (!hasSource || !hasCommit) {
      throw new BrokerError(
        "INVALID_REQUEST",
        "Broker-created worktree provisioning requires workspace.repository_workspace_id and workspace.base_commit (§8.3).",
        { executionStarted: false },
      );
    }
    const repositoryWorkspaceId = workspace.repository_workspace_id!;
    const baseCommit = workspace.base_commit!;
    if (typeof repositoryWorkspaceId !== "string" || typeof baseCommit !== "string") {
      throw new BrokerError("INVALID_REQUEST", "worktree workspace fields must be strings (§8.3).", {
        executionStarted: false,
      });
    }
    const source = getWorkspace(this.db, repositoryWorkspaceId);
    if (!source || source.project_id !== req.project_id) {
      throw new BrokerError("INVALID_REQUEST", "Unknown repository workspace reference for this project (§8.3).", {
        executionStarted: false,
      });
    }
    if (source.mode !== "current") {
      throw new BrokerError("INVALID_REQUEST", "Worktree source must be a registered repository workspace (§8.3).", {
        executionStarted: false,
      });
    }
    if (source.quarantined) {
      throw new BrokerError("WORKSPACE_BUSY", "Worktree source workspace is quarantined.", {
        executionStarted: false,
        details: { workspace_id: source.workspace_id },
      });
    }
    if (!source.canonical_path) {
      throw new BrokerError("INVALID_REQUEST", "Worktree source workspace has no registered checkout path (§8.3).", {
        executionStarted: false,
      });
    }
    if (!source.coverage_profile_id) {
      // Writer sends require a coverage binding (§8.7); a source without one
      // could never satisfy the initial snapshot contract — reject up front.
      throw new BrokerError("INVALID_REQUEST", "Worktree source workspace has no coverage binding (§8.7).", {
        executionStarted: false,
      });
    }
    if (!this.worktreesRoot) {
      throw new BrokerError(
        "INVALID_REQUEST",
        "Broker-created worktree provisioning is not configured on this daemon (§8.3).",
        { executionStarted: false },
      );
    }
    // Bounded Git reads (rev-parse common dir + verify commit) — safe
    // subprocess, outside any transaction, no optional locks, no branch or
    // HEAD guess, nothing created.
    try {
      mkdirSync(this.worktreesRoot, { recursive: true });
      const identity = preflightSourceRepository(source.canonical_path, baseCommit);
      return {
        source_workspace_id: source.workspace_id,
        base_commit: baseCommit,
        source_common_dir: identity.commonDir,
        source_canonical_path: source.canonical_path,
        source_coverage_profile_id: source.coverage_profile_id,
      };
    } catch (e) {
      if (e instanceof WorktreePreflightError) {
        throw new BrokerError("INVALID_REQUEST", e.message, {
          executionStarted: false,
          details: { reason: e.reason },
        });
      }
      throw e;
    }
  }

  /**
   * Authoritative revalidation INSIDE the admission transaction (§7.2): pure
   * record reads and in-memory adapter fields compared against the captured
   * candidate fingerprint. adapter.preflight (external process) is never
   * re-run here; drifted configuration is rejected rather than admitted with
   * stale observations.
   */
  private revalidateSpawnCandidate(req: ResolvedSpawnRequest, candidate: SpawnPreflightCandidate): void {
    const adapter = this.adapters.get(req.provider);
    if (!adapter) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `Provider '${req.provider}' is not available.`, {
        executionStarted: false,
      });
    }
    if (adapter !== candidate.adapter || adapter.adapterVersion !== candidate.adapterVersion) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Provider adapter instance or version changed during admission ('${candidate.adapterVersion}' → '${adapter.adapterVersion}'); preflight observations are stale.`,
        { executionStarted: false },
      );
    }
    const account = getAccount(this.db, req.account_profile_id);
    if (!account) {
      throw new BrokerError("INVALID_REQUEST", `Account profile '${req.account_profile_id}' is not registered.`, {
        executionStarted: false,
      });
    }
    if (account.provider !== req.provider) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Account profile '${account.account_profile_id}' is registered for provider '${account.provider}', not '${req.provider}'.`,
        { executionStarted: false },
      );
    }
    // Re-derive the effective policy from the live profile row (pure DB read);
    // a changed config yields a different fingerprint and refuses admission.
    // The readiness observation is the CAPTURED preflight return (pure
    // in-memory comparison; no external process runs here). The §8.3 worktree
    // source binding is re-read from the live registry rows — drift refuses.
    const policy = cloneFrozenPolicy(this.spawnPolicyPreflight(req));
    const worktreeSource = this.revalidateWorktreeSource(req, candidate);
    const fresh = spawnCandidateFingerprint({ provider: req.provider, adapterVersion: adapter.adapterVersion, account, policy, observation: candidate.observation, worktreeSource });
    if (fresh !== candidate.fingerprint) {
      throw new BrokerError(
        "POLICY_UNSUPPORTED",
        "Provider account or policy configuration changed during admission; refusing stale preflight observations.",
        { executionStarted: false },
      );
    }
  }

  /**
   * §8.3 authoritative revalidation of the worktree source binding (pure
   * record reads inside the admission transaction): the registered source
   * repository must still exist, belong to the project, stay unquarantined
   * and unchanged. The Git preflight is never re-run here.
   */
  private revalidateWorktreeSource(
    req: ResolvedSpawnRequest,
    candidate: SpawnPreflightCandidate,
  ): NonNullable<SpawnPreflightCandidate["worktreeSource"]> | null {
    const workspace = req.workspace;
    const hasSource = workspace.repository_workspace_id !== undefined && workspace.repository_workspace_id !== null;
    const hasCommit = workspace.base_commit !== undefined && workspace.base_commit !== null;
    if (workspace.mode !== "worktree" || workspace.workspace_id) return null;
    if (!candidate.worktreeSource) {
      if (!hasSource || !hasCommit) return null;
      throw new BrokerError("INVALID_REQUEST", "Worktree source binding vanished during admission (§8.3).", {
        executionStarted: false,
      });
    }
    const bound = candidate.worktreeSource;
    const source = getWorkspace(this.db, bound.source_workspace_id);
    if (
      !source ||
      source.project_id !== req.project_id ||
      source.mode !== "current" ||
      source.quarantined ||
      source.canonical_path !== bound.source_canonical_path ||
      source.coverage_profile_id !== bound.source_coverage_profile_id
    ) {
      throw new BrokerError("INVALID_REQUEST", "Worktree source workspace changed during admission (§8.3).", {
        executionStarted: false,
      });
    }
    if (workspace.repository_workspace_id !== bound.source_workspace_id || workspace.base_commit !== bound.base_commit) {
      throw new BrokerError("INVALID_REQUEST", "Worktree request fields changed during admission (§8.3).", {
        executionStarted: false,
      });
    }
    return bound;
  }

  /**
   * Effective write policy for a spawn (§12.1): narrow the operator profile
   * by the requested restrictions. Unknown mandatory restrictions are
   * POLICY_UNSUPPORTED, malformed values INVALID_REQUEST, widening rejected.
   * Throws instead of returning the error union — admission never continues
   * on a policy failure.
   */
  private spawnPolicyPreflight(req: ResolvedSpawnRequest): EffectiveWritePolicy {
    const profile = getPolicyProfile(this.db, req.policy_profile_id, POLICY_PROFILE_VERSION);
    if (!profile) {
      throw new BrokerError(
        "POLICY_UNSUPPORTED",
        `Policy profile '${req.policy_profile_id}' version ${POLICY_PROFILE_VERSION} is not registered.`,
        { executionStarted: false },
      );
    }
    const narrowed = computeEffectiveWritePolicy({
      policy_profile_id: req.policy_profile_id,
      policy_profile_version: POLICY_PROFILE_VERSION,
      profileConfigJson: profile.config,
      requestedRestrictions: req.policy_restrictions,
    });
    if (!narrowed.ok) throw new BrokerError(narrowed.code, narrowed.reason, { executionStarted: false });
    return narrowed.policy;
  }

  /**
   * Creates the durable PROVISIONING session with its reservations, intent
   * and idempotency record — called INSIDE the admission transaction with the
   * revalidated preflight candidate.
   */
  private createProvisioningSession(
    coordinatorId: string,
    req: ResolvedSpawnRequest,
    payloadHash: string,
    candidate: SpawnPreflightCandidate,
  ): { sessionId: string; provisionIntentId: string } {
    const now = this.now();
    const sessionId = newId(ID_PREFIX.session);
    const provisionIntentId = newId(ID_PREFIX.intent);

    // §12.1: the effective write policy was computed by the policy helpers
    // from the profile version the session binds and revalidated moments ago;
    // it is immutable for the session's lifetime (stored in the provision
    // intent payload; the live profile config never re-widens it).
    const effectivePolicy = candidate.policy;

    // Coverage binding resolves at spawn from the registered workspace
    // profile (§5.2) and is immutable for the session afterwards.
    const workspace = req.workspace.workspace_id ? getWorkspace(this.db, req.workspace.workspace_id) : null;
    if (req.workspace.workspace_id && !workspace) {
      throw new BrokerError("INVALID_REQUEST", "Unknown workspace reference.");
    }
    if (workspace && workspace.project_id !== req.project_id) {
      throw new BrokerError("INVALID_REQUEST", "Workspace does not belong to this project.");
    }
    // §8.3 broker-created worktree: the session binds a NEW broker-generated
    // workspace row (mode=worktree) placed under the managed root at a
    // hash-of-session path; the source binding and base commit are journaled
    // in the provision intent BEFORE any Git command runs.
    let worktreeRecord: {
      workspace: WorkspaceRecord;
      journal: WorktreeProvisionJournal;
    } | null = null;
    if (req.workspace.mode === "worktree" && !req.workspace.workspace_id && candidate.worktreeSource) {
      const source = getWorkspace(this.db, candidate.worktreeSource.source_workspace_id);
      if (!source || !this.worktreesRoot) {
        throw new BrokerError("INVALID_REQUEST", "Worktree source binding vanished during admission (§8.3).");
      }
      const worktreePath = computeManagedWorktreePath(this.worktreesRoot, sessionId);
      const workspaceRow: WorkspaceRecord = {
        workspace_id: newId(ID_PREFIX.workspace),
        project_id: req.project_id,
        mode: "worktree",
        canonical_path: worktreePath,
        quarantined: false,
        quarantine_reason: null,
        coverage_profile_id: source.coverage_profile_id,
      };
      worktreeRecord = {
        workspace: workspaceRow,
        journal: {
          binding_version: WORKTREE_PROVISION_BINDING_VERSION,
          source_workspace_id: source.workspace_id,
          source_common_dir: candidate.worktreeSource.source_common_dir,
          base_commit: candidate.worktreeSource.base_commit,
          workspace_id: workspaceRow.workspace_id,
          worktree_path: worktreePath,
          managed_root: this.worktreesRoot,
          stage: "pending",
          lock: null,
          launch: null,
          completion: null,
          current_checkout_changes_copied: false,
        },
      };
    }

    const bindingWorkspace = worktreeRecord ? worktreeRecord.workspace : workspace;
    const binding = this.resolveCoverageBinding(bindingWorkspace);

    // Session slot cap (§15.1) checked + reserved in the same boundary.
    reserveSessionSlot(this.db, now, sessionId, req.project_id, this.sessionCap(req.project_id));
    if (worktreeRecord) insertWorkspace(this.db, worktreeRecord.workspace);
    const session: SessionRecord = {
      session_id: sessionId,
      project_id: req.project_id,
      owner_coordinator_id: coordinatorId,
      provider: req.provider,
      // §13.3: bound to the revalidated adapter version and the REGISTERED
      // account auth_mode. cli_version is persisted ONLY from the observed
      // readiness evidence (unknown stays null). Effective model/effort stay
      // null — never fabricated from requested values before real native
      // execution evidence.
      adapter_version: candidate.adapterVersion,
      cli_version: candidate.observation?.cli_version ?? null,
      account_profile_id: req.account_profile_id,
      auth_mode: candidate.account.auth_mode,
      requested_model: req.model,
      requested_effort: req.effort,
      effective_model: null,
      effective_effort: null,
      role: req.role,
      instructions_hash: sha256Hex(req.instructions),
      policy_profile_id: req.policy_profile_id,
      policy_profile_version: POLICY_PROFILE_VERSION,
      workspace_id: worktreeRecord ? worktreeRecord.workspace.workspace_id : req.workspace.workspace_id,
      workspace_mode: req.workspace.mode,
      coverage_profile_id: binding?.profile_id ?? null,
      coverage_profile_version: binding?.version ?? null,
      coverage_contract_hash: binding?.contract_hash ?? null,
      native_conversation_ref: null,
      context_status: "not_started",
      state: "PROVISIONING",
      active_turn_id: null,
      block_reason: null,
      runtime_id: null,
      close_state: "none",
      close_intent_id: null,
      initial_snapshot_id: null,
      latest_snapshot_id: null,
      record_version: 1,
      created_at: now,
      updated_at: now,
    };
    insertSession(this.db, session);
    insertIntent(this.db, {
      intent_id: provisionIntentId,
      kind: "provision_session",
      session_id: sessionId,
      turn_id: null,
      state: "pending",
      // §12.1 durable binding: requested restrictions + profile config/
      // fingerprint + normalized effective policy, captured at admission —
      // plus the §13.3 provider binding (registered account tuple, adapter
      // version, observed readiness evidence). Immutable afterwards; later
      // turns refuse on drift instead of migrating.
      payload: JSON.stringify({
        request_hash: payloadHash,
        instructions: req.instructions,
        effective_policy: effectivePolicy,
        provider_binding: durableProviderBinding(candidate),
        // §8.3: the generated workspace row/path, source binding and base
        // commit are durable BEFORE any Git mutation (worktree add runs only
        // after this transaction commits, staged via the journal).
        ...(worktreeRecord ? { worktree_provisioning: worktreeRecord.journal } : {}),
      }),
      created_at: now,
      updated_at: now,
    });
    insertIdempotencyRecord(this.db, {
      ...namespaceOf(req.project_id, coordinatorId, "agent_session_spawn", req.idempotency_key),
      request_hash: payloadHash,
      outcome: "accepted",
      resolved_kind: "session",
      resolved_id: sessionId,
      rejection_code: null,
      created_at: now,
    });
    appendEvent(this.db, {
      turn_id: null,
      session_id: sessionId,
      type: "session_spawned",
      payload: { state: "PROVISIONING" },
      created_at: now,
    });
    return { sessionId, provisionIntentId };
  }

  /** Resolve the workspace's coverage profile binding (latest version). */
  private resolveCoverageBinding(
    workspace: ReturnType<typeof getWorkspace>,
  ): { profile_id: string; version: string; contract_hash: string } | null {
    if (!workspace?.coverage_profile_id) return null;
    const version = latestCoverageProfileVersion(this.db, workspace.coverage_profile_id);
    if (!version) return null;
    const profile = getCoverageProfile(this.db, workspace.coverage_profile_id, version);
    if (!profile) return null;
    return {
      profile_id: profile.coverage_profile_id,
      version: profile.version,
      contract_hash: profile.contract_hash,
    };
  }

  /**
   * PROVISIONING → IDLE with a sealed initial snapshot. For a current-mode
   * workspace this is a REAL capture (independent inventory + content blobs,
   * §8.2: baseline ≠ HEAD — existing dirty state is included). Capture
   * failure is a provisioning failure → BLOCKED with retained state (§6.1);
   * the intent journal records which side effects happened.
   * Idempotent: a session already in a defined state is left as-is.
   */
  private completeProvisioningIfNeeded(sessionId: string, insideLock = false): void {
    const current = getSession(this.db, sessionId);
    if (!current) throw new Error("session-vanished");
    if (current.state !== "PROVISIONING") return;

    // §8.3: a broker-created detached worktree is provisioned as tracked
    // background work — the long Git child runs OUTSIDE the event loop and
    // outside any transaction, serialized per repository common dir. The
    // journal drives staging/reconciliation; once stage "ready" is durable
    // the normal binding/capture completion below runs unchanged. A journal
    // that exists but is invalid/unreadable is RETAINED (never interpreted
    // as an ordinary provision, never completed, never failed by guesswork).
    const worktreePayload = readProvisionIntentPayload(this.db, sessionId);
    let worktreeJournal: WorktreeProvisionJournal | null = null;
    let worktreeBindingMalformed = false;
    if (worktreePayload?.payload) {
      try {
        const parsed: unknown = JSON.parse(worktreePayload.payload);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const raw = (parsed as Record<string, unknown>).worktree_provisioning;
          if (raw !== undefined) {
            worktreeJournal = parseWorktreeJournal(raw);
            worktreeBindingMalformed = worktreeJournal === null;
          }
        } else {
          worktreeBindingMalformed = true;
        }
      } catch {
        worktreeBindingMalformed = true;
      }
    }
    if (worktreeBindingMalformed) return; // retained verbatim for the operator
    if (worktreeJournal && !insideLock) {
      this.track(this.provisionDetachedWorktree(sessionId));
      return;
    }

    // Review slots (P2-2) and path-less workspaces provision without capture.
    const workspace = current.workspace_id ? getWorkspace(this.db, current.workspace_id) : null;
    const needsCapture =
      workspace !== null &&
      workspace.mode !== "review_slot" &&
      workspace.canonical_path !== null &&
      current.coverage_profile_id !== null;

    // A06: durably bind the session to the FS-resolved physical checkout of
    // its future native cwd. Resolution happens OUTSIDE the transaction
    // (realpath/stat) and the binding is written into the session-owned
    // provision intent payload in the SAME transaction that completes
    // provisioning — immutable afterwards. Only physical writer sessions
    // bind; review slots and path-less workspaces keep their contracts. A
    // registered checkout without a stable physical identity fails
    // provisioning: the session must never dispatch a cwd it cannot pin, and
    // an unsupported native filesystem is refused, never faked as supported.
    let physical: PhysicalCheckoutIdentity | null = null;
    if (current.workspace_id && current.workspace_mode !== "review_slot" && workspace?.canonical_path) {
      physical = resolvePhysicalCheckoutIdentity(workspace.canonical_path);
      if (!physical) {
        this.failProvisioning(sessionId, "checkout-path-has-no-stable-physical-identity");
        return;
      }
      // §8.3 containment: the FS-resolved worktree cwd must stay inside the
      // managed root it was allocated from — a link escape fails closed.
      if (worktreeJournal && !resolvesInsideRoot(worktreeJournal.managed_root, physical.resolvedPath)) {
        this.failProvisioning(sessionId, "worktree-path-escapes-managed-root");
        return;
      }
    }
    const physicalBinding: SessionPhysicalCwdBinding | null = physical
      ? {
          binding_version: PHYSICAL_CWD_BINDING_VERSION,
          canonical_cwd: physical.resolvedPath,
          lease_scope: physical.scope,
          bound_at: this.now(),
        }
      : null;

    if (needsCapture && workspace?.canonical_path && current.coverage_profile_id && current.coverage_profile_version) {
      const profile = getCoverageProfile(this.db, current.coverage_profile_id, current.coverage_profile_version);
      if (!profile) {
        this.failProvisioning(sessionId, "coverage-profile-missing");
        return;
      }
      let config: CoverageConfig;
      try {
        config = JSON.parse(profile.config) as CoverageConfig;
        validateCoverageConfig(config);
      } catch {
        this.failProvisioning(sessionId, "coverage-config-invalid");
        return;
      }
      try {
        if (physicalBinding && resolvePhysicalCheckoutIdentity(physicalBinding.canonical_cwd)?.scope !== physicalBinding.lease_scope) {
          throw new Error("physical-checkout-changed-before-provision-capture");
        }
        const captured = captureSnapshot({
          db: this.db,
          blobs: this.blobStore,
          clock: this.clock,
          projectId: current.project_id,
          workspaceId: workspace.workspace_id,
          // The baseline describes the PINNED checkout, not the alias spelling.
          workspaceRoot: physicalBinding?.canonical_cwd ?? workspace.canonical_path,
          coverage: {
            profile_id: profile.coverage_profile_id,
            version: profile.version,
            contract_hash: profile.contract_hash,
            config,
          },
        });
        if (physicalBinding && resolvePhysicalCheckoutIdentity(physicalBinding.canonical_cwd)?.scope !== physicalBinding.lease_scope) {
          updateSnapshotState(this.db, captured.snapshot.snapshot_id, "FAILED", "physical-checkout-changed-during-provision-capture");
          throw new Error("physical-checkout-changed-during-provision-capture");
        }
        const now = this.now();
        this.db.tx(() => {
          const session = getSession(this.db, sessionId);
          if (!session || session.state !== "PROVISIONING") return;
          assertSessionTransition(session.state, "provisioning_completed");
          updateSessionFields(
            this.db,
            sessionId,
            {
              state: "IDLE",
              initial_snapshot_id: captured.snapshot.snapshot_id,
              latest_snapshot_id: captured.snapshot.snapshot_id,
            },
            session.record_version,
            now,
          );
          // §15.3.1: the initial baseline stays pinned until close.
          insertPin(this.db, {
            pin_id: newId("pin"),
            artifact_id: captured.snapshot.manifest_artifact_id,
            root_kind: "session_anchor",
            owner_session_id: sessionId,
            owner_turn_id: null,
            created_at: now,
          });
          if (physicalBinding) this.recordProvisionPhysicalBinding(sessionId, physicalBinding, now);
          const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
          if (intent) updateIntentState(this.db, intent.intent_id, "completed", now);
          appendEvent(this.db, {
            turn_id: null,
            session_id: sessionId,
            type: "session_provisioned",
            payload: { initial_snapshot_id: captured.snapshot.snapshot_id },
            created_at: now,
          });
        });
        return;
      } catch (e) {
        const reason = e instanceof CoverageError ? `${e.code}: ${e.message}` : String(e);
        this.failProvisioning(sessionId, reason);
        return;
      }
    }

    // No capture needed (review slot / path-less) — metadata-only completion.
    const now = this.now();
    try {
      this.db.tx(() => {
        const session = getSession(this.db, sessionId);
        if (!session || session.state !== "PROVISIONING") return;
        assertSessionTransition(session.state, "provisioning_completed");
        updateSessionFields(this.db, sessionId, { state: "IDLE" }, session.record_version, now);
        if (physicalBinding) this.recordProvisionPhysicalBinding(sessionId, physicalBinding, now);
        const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
        if (intent) updateIntentState(this.db, intent.intent_id, "completed", now);
        appendEvent(this.db, {
          turn_id: null,
          session_id: sessionId,
          type: "session_provisioned",
          payload: { initial_snapshot_id: null },
          created_at: now,
        });
      });
    } catch (error) {
      this.failProvisioning(sessionId, String(error));
    }
  }

  /**
   * A06: write the physical cwd binding into the pending provision intent —
   * called INSIDE the completion transaction, so the binding becomes durable
   * atomically with the session leaving PROVISIONING and is immutable after.
   */
  private recordProvisionPhysicalBinding(sessionId: string, binding: SessionPhysicalCwdBinding, now: number): void {
    const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
    if (!intent?.payload) throw new Error("physical-cwd-binding-journal-unavailable");
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(intent.payload);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid-binding-journal");
      payload = parsed as Record<string, unknown>;
    } catch {
      throw new Error("physical-cwd-binding-journal-invalid");
    }
    payload.physical_workspace = binding;
    const updated = this.db.raw
      .prepare("UPDATE intents SET payload = ?, updated_at = ? WHERE intent_id = ? AND state = 'pending'")
      .run(JSON.stringify(payload), now, intent.intent_id);
    if (Number(updated.changes) !== 1) throw new Error("physical-cwd-binding-journal-not-written");
  }

  /** §6.1: failed provisioning → BLOCKED with recorded reason; no deletion. */
  private failProvisioning(sessionId: string, reason: string): void {
    const now = this.now();
    this.db.tx(() => {
      const session = getSession(this.db, sessionId);
      if (!session || session.state !== "PROVISIONING") return;
      assertSessionTransition(session.state, "provisioning_failed");
      updateSessionFields(
        this.db,
        sessionId,
        { state: "BLOCKED", block_reason: `provisioning-failed: ${reason}` },
        session.record_version,
        now,
      );
      const intent = listPendingIntents(this.db, "provision_session").find((i) => i.session_id === sessionId);
      if (intent) updateIntentState(this.db, intent.intent_id, "failed", now);
      appendEvent(this.db, {
        turn_id: null,
        session_id: sessionId,
        type: "session_provisioning_failed",
        payload: { reason },
        created_at: now,
      });
    });
  }

  private sessionCap(projectId: string): number {
    const project = getProject(this.db, projectId);
    return project?.session_cap ?? this.limits.openSessionsPerProject;
  }

  /** Preflight snapshot checks outside the admission tx (§7.2 step 3). */
  private sendSnapshotPreflight(session: SessionRecord, req: SendRequest): void {
    // Required task artifacts: ACL/sealed/retained checks before inference
    // (§7.1.1) — every entry is required; nothing is silently dropped.
    this.resolveTaskArtifacts(session.project_id, req.task.artifact_refs ?? []);
    if ("workspace_precondition" in req) {
      const expected = req.workspace_precondition.expected_snapshot_id;
      this.checkSnapshotBinding(session, expected, "expected");
      // Digest comparison only for writer sessions with a real workspace.
      if (session.workspace_mode !== "review_slot" && session.workspace_id) {
        this.checkWorkspaceDigest(session, expected);
      }
    } else {
      const { baseline_snapshot_id, target_snapshot_id } = req.review_binding;
      this.checkSnapshotBinding(session, baseline_snapshot_id, "review baseline");
      this.checkSnapshotBinding(session, target_snapshot_id, "review target");
      const b = getSnapshotRecord(this.db, baseline_snapshot_id);
      const t = getSnapshotRecord(this.db, target_snapshot_id);
      if (
        b &&
        t &&
        (b.coverage_profile_id !== t.coverage_profile_id ||
          b.coverage_profile_version !== t.coverage_profile_version ||
          b.coverage_contract_hash !== t.coverage_contract_hash)
      ) {
        throw new BrokerError(
          "SNAPSHOT_COVERAGE_MISMATCH",
          "Review baseline and target have different coverage bindings (§9.5).",
        );
      }
    }
  }

  /**
   * Resolve required task artifacts (§7.1.1): ACL (same project), SEALED
   * state, hash+size present. Unknown/foreign ids do not disclose existence.
   */
  private resolveTaskArtifacts(projectId: string, refs: string[]): ArtifactRecord[] {
    const out: ArtifactRecord[] = [];
    for (const ref of refs) {
      const artifact = getArtifact(this.db, ref);
      if (!artifact || artifact.project_id !== projectId) {
        // §7.1.1: unknown/disallowed id → UNAUTHORIZED without disclosure.
        throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
      }
      if (artifact.state === "expired") {
        throw new BrokerError("ARTIFACT_EXPIRED", `Required artifact ${ref} has expired.`);
      }
      if (artifact.state !== "sealed" || !artifact.content_hash || artifact.size_bytes === null) {
        throw new BrokerError("ARTIFACT_NOT_READY", `Required artifact ${ref} is not sealed.`);
      }
      out.push(artifact);
    }
    return out;
  }

  // ─── send (§7.1, §7.2) ────────────────────────────────────────────────────

  send(coordinatorId: string, req: SendRequest): SendResponse {
    // Step 1: authz — session owner check denies before anything else.
    const session0 = this.authorizeSession(coordinatorId, req.session_id);

    const payloadHash = canonicalRequestHash(req);
    const namespace = namespaceOf(
      session0.project_id,
      coordinatorId,
      "agent_session_send",
      req.idempotency_key,
    );

    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast) return this.replaySend(fast, payloadHash);

    this.sendPreflight(req);
    if (session0.close_state === "pending") {
      throw new BrokerError("SESSION_CLOSING", "A close intent is pending for this session (§6.4).");
    }
    if (session0.state === "CLOSED") {
      throw new BrokerError("SESSION_CLOSED", "Session is closed.");
    }
    if (session0.state === "BLOCKED") {
      throw new BrokerError("SESSION_BLOCKED", session0.block_reason ?? "Session is blocked.");
    }
    this.assertAdmissionOpen();
    // §13.3 later-turn readiness revalidation (outside the tx): a session with
    // a durably bound readiness fingerprint refuses on observed CLI/profile/
    // catalog drift BEFORE any accepted state. Authorization and idempotent
    // replay already ran; the authoritative transaction below never probes.
    this.sendReadinessRevalidation(session0);
    // §7.2 step 3 preflight: expensive filesystem hashing outside the tx.
    this.sendSnapshotPreflight(session0, req);
    // A05 preflight: the writer lease target's physical checkout identity is
    // resolved with realpath/stat OUTSIDE the admission tx; an unresolved or
    // retargeted-away alias fails closed here, before any accepted state
    // exists. The conflict decision itself stays in the authoritative tx
    // below so the established error priority is preserved (SESSION_BUSY and
    // RESOURCE_BUSY are decided before any lease refusal, as before).
    const preflightLeaseTarget = this.writerTurn(req) && session0.workspace_id
      ? this.writerLeaseTargetOrThrow(session0.workspace_id)
      : null;
    // A06 preflight: a session with a durable physical cwd binding may only
    // send while the registered alias still resolves to exactly that bound
    // physical root (checked with realpath/stat OUTSIDE the tx). A retargeted
    // alias, an externally replaced root or a byte-identical copy is refused
    // here — before any accepted state or inference exists. Unbound or
    // malformed bindings are not reinterpreted here: their explicit fail-closed
    // refusals happen pre-dispatch in the executor, after the established
    // contract/policy priorities.
    const preflightPhysical = preflightLeaseTarget?.physical
      ? this.validateSessionPhysicalBinding(session0, preflightLeaseTarget.physical)
      : null;

    let response: SendResponse;
    try {
      response = this.db.tx(() => {
        const session = this.authorizeSessionRaw(coordinatorId, req.session_id);
        const existing = getIdempotencyRecord(this.db, namespace);
        // §7.2 step 4: existing same-payload operation wins over any mutable
        // rejection (SESSION_BUSY etc.).
        if (existing) return this.replaySend(existing, payloadHash);

        this.sendPreflight(req);
        this.sendAdmissionChecks(session, req);
        // §13.3 durable provider binding re-check: live account rows must
        // still match the immutable spawn-time grant (registered account
        // tuple). Drift refuses with zero accepted resources — no migration,
        // no fresh-session fallback; historical grants/leases are preserved.
        this.assertDurableProviderBinding(session);
        this.assertAdmissionOpen();
        // Re-validate immutable snapshot records inside the authoritative
        // boundary (cheap record reads; §9.5 binding rules).
        if ("workspace_precondition" in req) {
          this.checkSnapshotBinding(session, req.workspace_precondition.expected_snapshot_id, "expected");
        } else {
          this.checkSnapshotBinding(session, req.review_binding.baseline_snapshot_id, "review baseline");
          this.checkSnapshotBinding(session, req.review_binding.target_snapshot_id, "review target");
        }
        this.checkWriteScopeCoverage(session);

        const now = this.now();
        const turnId = newId(ID_PREFIX.turn);
        const quotaScope = this.quotaScopeFor(session);
        // A learned shared quota-scope pause blocks new sends across projects
        // (QUOTA_EXHAUSTED, executionStarted:false) AFTER ownership/state
        // priorities; an existing accepted operation already replayed above
        // keeps its successful outcome regardless of a later pause.
        assertQuotaScopeSendable(this.db, quotaScope, now);
        const workspaceId = session.workspace_id; // writer lease target (INV-02)

        checkTurnCapacity(this.db, this.limits, quotaScope);
        // A05: the writer lease scope is the authoritative physical checkout
        // identity, re-resolved INSIDE the boundary (realpath/stat syscalls —
        // never a subprocess). Registered/junction/symlink/case aliases of one
        // checkout share one exclusive writer; path-less workspaces keep the
        // legacy ID-scoped lease. A conflicting or quarantined alias is a
        // mutable refusal: the transaction rolls back and frees the key.
        let leaseTarget: WorkspaceLeaseTarget | null = null;
        if (workspaceId && this.writerTurn(req)) {
          leaseTarget = this.writerLeaseTargetOrThrow(workspaceId);
          if (!preflightLeaseTarget || preflightLeaseTarget.project_id !== leaseTarget.project_id ||
              workspaceLeaseScope(preflightLeaseTarget) !== workspaceLeaseScope(leaseTarget)) {
            throw new BrokerError("WORKSPACE_CHANGED", "Checkout identity changed after admission preflight.", {
              executionStarted: false,
            });
          }
          // A06 authoritative cheap recheck (§7.2): the immutable session
          // binding must still pin exactly the physical checkout the alias
          // resolves to. Record reads plus realpath/stat syscalls only —
          // never a subprocess inside the boundary.
          if (preflightLeaseTarget.physical && preflightPhysical) {
            const lookup = readSessionPhysicalBinding(this.db, session.session_id);
            if (lookup.kind !== "bound" ||
                lookup.binding.canonical_cwd !== preflightPhysical.canonical_cwd ||
                lookup.binding.lease_scope !== preflightPhysical.lease_scope) {
              throw new BrokerError("WORKSPACE_CHANGED", "Session physical cwd binding changed during admission.", {
                executionStarted: false,
              });
            }
            if (lookup.binding.lease_scope !== leaseTarget.physical?.scope) {
              throw new BrokerError(
                "WORKSPACE_CHANGED",
                "Registered workspace alias no longer resolves to the session's bound physical checkout (retargeted or replaced).",
                { executionStarted: false },
              );
            }
          }
          checkWorkspaceLeaseAvailable(this.db, leaseTarget);
        }

        // Required artifacts re-resolved inside the boundary (§7.1.1): a
        // stale preflight observation cannot admit an expired/unsealed input.
        const refs = req.task.artifact_refs ?? [];
        const resolvedArtifacts = this.resolveTaskArtifacts(session.project_id, refs);

        const expectedSnapshot = "workspace_precondition" in req
          ? req.workspace_precondition.expected_snapshot_id
          : req.review_binding.target_snapshot_id;
        const baselineSnapshot = "workspace_precondition" in req
          ? req.workspace_precondition.expected_snapshot_id
          : req.review_binding.baseline_snapshot_id;

        const turn: TurnRecord = {
          turn_id: turnId,
          session_id: session.session_id,
          project_id: session.project_id,
          owner_coordinator_id: coordinatorId,
          idempotency_key: req.idempotency_key,
          request_hash: payloadHash,
          task_goal_hash: sha256Hex(req.task.goal),
          state: "ACCEPTED",
          state_version: 1,
          execution_started: null,
          native_outcome: null,
          termination_reason: null,
          finalization_error: null,
          terminal_candidate: null,
          retry_of_turn_id: req.retry_of_turn_id ?? null,
          deadline_at: now + (req.deadline_ms ?? this.limits.hardTurnDeadlineMs),
          native_conversation_ref: null,
          continuation: null,
          input_manifest_id: null,
          task_artifact_refs: refs,
          baseline_snapshot_id: baselineSnapshot,
          review_target_snapshot_id: "review_binding" in req ? req.review_binding.target_snapshot_id : null,
          final_snapshot_id: null,
          runtime_id: null,
          error_code: null,
          created_at: now,
          accepted_at: now,
          terminal_at: null,
          updated_at: now,
        };
        insertTurn(this.db, turn);
        insertIdempotencyRecord(this.db, {
          ...namespace,
          request_hash: payloadHash,
          outcome: "accepted",
          resolved_kind: "turn",
          resolved_id: turnId,
          rejection_code: null,
          created_at: now,
        });
        reserveTurn(this.db, now, {
          session_id: session.session_id,
          turn_id: turnId,
          quota_scope_id: quotaScope,
          workspace_id: leaseTarget ? leaseTarget.workspace_id : null,
          workspace_lease_scope: leaseTarget ? workspaceLeaseScope(leaseTarget) : null,
        });
        // §15.3.1 accepted-turn pins: the snapshots this turn depends on stay
        // retained while it is nonterminal; released at terminal commit.
        const pinnedSnapshotIds = "workspace_precondition" in req
          ? [req.workspace_precondition.expected_snapshot_id]
          : [req.review_binding.baseline_snapshot_id, req.review_binding.target_snapshot_id];
        for (const snapId of pinnedSnapshotIds) {
          const rec = getSnapshotRecord(this.db, snapId);
          if (rec) {
            insertPin(this.db, {
              pin_id: newId("pin"),
              artifact_id: rec.manifest_artifact_id,
              root_kind: "active_turn",
              owner_session_id: session.session_id,
              owner_turn_id: turnId,
              created_at: now,
            });
          }
        }
        // Required task artifacts are pinned with the turn (§5.7: an artifact
        // accepted as required input must survive until terminal commit).
        for (const artifact of resolvedArtifacts) {
          insertPin(this.db, {
            pin_id: newId("pin"),
            artifact_id: artifact.artifact_id,
            root_kind: "active_turn",
            owner_session_id: session.session_id,
            owner_turn_id: turnId,
            created_at: now,
          });
        }
        // Session slot: IDLE → ACTIVE (§6.5.1 send_accepted).
        assertSessionTransition(session.state, "send_accepted");
        updateSessionFields(
          this.db,
          session.session_id,
          { state: "ACTIVE", active_turn_id: turnId },
          session.record_version,
          now,
        );
        appendEvent(this.db, {
          turn_id: turnId,
          session_id: session.session_id,
          type: "turn_admitted",
          payload: { expected_snapshot_id: expectedSnapshot, task: req.task },
          created_at: now,
        });
        return {
          api_version: API_VERSION,
          session_id: session.session_id,
          turn_id: turnId,
          state: "ACCEPTED" as TurnState,
          replayed_request: false,
        };
      });
    } catch (e) {
      if (e instanceof SqliteConstraintError) {
        const existing = getIdempotencyRecord(this.db, namespace);
        if (existing) return this.replaySend(existing, payloadHash);
      }
      throw e;
    }

    // Step 7: STARTING + side effects happen off the caller's critical path;
    // execution continues regardless of the MCP connection (INV-10).
    if (!this.deferExecution) {
      this.requireExecutor().startTurn(response.turn_id);
    }
    return response;
  }

  private replaySend(rec: IdempotencyRow, payloadHash: string): SendResponse {
    if (rec.request_hash !== payloadHash) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.", {
        retryGuidance: "new_key_required",
      });
    }
    const turn = getTurn(this.db, rec.resolved_id ?? "");
    if (!turn) throw new BrokerError("INVALID_REQUEST", "Idempotent record points to a missing turn.");
    return {
      api_version: API_VERSION,
      session_id: turn.session_id,
      turn_id: turn.turn_id,
      state: turn.state,
      replayed_request: true,
    };
  }

  private sendPreflight(req: SendRequest): void {
    if (!req.task?.goal || typeof req.task.goal !== "string" || req.task.goal.trim().length === 0) {
      throw new BrokerError("INVALID_REQUEST", "Task goal is required (§7.1).");
    }
    const taskText = JSON.stringify(req.task);
    if (Buffer.byteLength(taskText, "utf8") > 64 * 1024) {
      throw new BrokerError("INPUT_LIMIT", "Task/context input exceeds 64 KiB (§15.1).");
    }
    const refs = req.task.artifact_refs ?? [];
    if (new Set(refs).size !== refs.length) {
      throw new BrokerError("INVALID_REQUEST", "artifact_refs must be unique (§7.1).");
    }
    if (refs.length > 32) {
      throw new BrokerError("INPUT_LIMIT", "artifact_refs exceeds 32 entries (§15.1).");
    }
    const hasPrecond = "workspace_precondition" in req;
    const hasReview = "review_binding" in req;
    if (hasPrecond === hasReview) {
      throw new BrokerError(
        "INVALID_REQUEST",
        "Exactly one of workspace_precondition / review_binding is required (§10.3).",
      );
    }
  }

  /**
   * Snapshot binding checks (§7.1, §9.5): sealed, retained, same project,
   * same coverage binding as the session; a review pair must share one
   * binding. Cheap record reads — safe to repeat inside the admission tx.
   */
  private checkSnapshotBinding(session: SessionRecord, snapshotId: string, label: string): void {
    const snap = getSnapshotRecord(this.db, snapshotId);
    if (!snap || snap.project_id !== session.project_id) {
      throw new BrokerError("INVALID_REQUEST", `Unknown ${label} snapshot for this project.`);
    }
    if (snap.state === "CAPTURING") {
      throw new BrokerError("ARTIFACT_NOT_READY", `${label} snapshot is still capturing.`);
    }
    if (snap.state === "FAILED") {
      throw new BrokerError("INVALID_REQUEST", `${label} snapshot capture failed.`);
    }
    if (
      snap.coverage_profile_id !== session.coverage_profile_id ||
      snap.coverage_profile_version !== session.coverage_profile_version ||
      snap.coverage_contract_hash !== session.coverage_contract_hash
    ) {
      throw new BrokerError(
        "SNAPSHOT_COVERAGE_MISMATCH",
        `${label} snapshot has a different coverage binding than the session (§9.5).`,
      );
    }
  }

  /**
   * Workspace precondition digest check (§8.2, §7.2 step 3): expensive
   * filesystem hashing runs OUTSIDE the admission transaction; the result is
   * a candidate observation re-validated at final admission by record checks.
   */
  private checkWorkspaceDigest(session: SessionRecord, expectedSnapshotId: string): void {
    const snap = getSnapshotRecord(this.db, expectedSnapshotId);
    if (!snap) return; // unknown snapshot is reported by binding checks
    const workspace = session.workspace_id ? getWorkspace(this.db, session.workspace_id) : null;
    if (!workspace?.canonical_path) {
      throw new BrokerError("INVALID_REQUEST", "Session workspace has no resolvable path.");
    }
    if (!session.coverage_profile_id || !session.coverage_profile_version) {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Session has no coverage binding.");
    }
    const profile = getCoverageProfile(this.db, session.coverage_profile_id, session.coverage_profile_version);
    if (!profile) {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Coverage profile missing.");
    }
    const config = JSON.parse(profile.config) as CoverageConfig;
    const inventory = takeInventory(workspace.canonical_path, config);
    const digest = computeSourceDigest(inventory.entries, {
      profile_id: profile.coverage_profile_id,
      version: profile.version,
      contract_hash: profile.contract_hash,
    });
    if (digest !== snap.source_digest) {
      throw new BrokerError("WORKSPACE_CHANGED", "Workspace source state no longer matches the expected snapshot (§8.2).", {
        details: { expected_snapshot_id: expectedSnapshotId },
      });
    }
  }

  /**
   * §8.7: the coverage contract must cover the whole effective policy write
   * scope. An INVALID scope (missing or unreadable session binding)
   * is an operator/config error — reject before inference, not after
   * the run.
   */
  private checkWriteScopeCoverage(session: SessionRecord): void {
    const scope = sessionWriteScope(this.db, session);
    if (scope.kind === "invalid") {
      throw new BrokerError("POLICY_UNSUPPORTED", `Session policy binding is unusable: ${scope.reason}`, { executionStarted: false });
    }
    if (!session.coverage_profile_id || !session.coverage_profile_version) return;
    const profile = getCoverageProfile(this.db, session.coverage_profile_id, session.coverage_profile_version);
    if (!profile) return;
    if (scope.kind === "absent") return;
    const config = JSON.parse(profile.config) as CoverageConfig;
    const uncovered = uncoveredWriteScope(scope.prefixes, config);
    if (uncovered.length > 0) {
      throw new BrokerError(
        "SNAPSHOT_COVERAGE_MISMATCH",
        `Policy write scope is not covered by the source selector (§8.7): ${uncovered.join(", ")}`,
      );
    }
  }

  /** Mutable session-level checks — run inside the authoritative tx. */
  private sendAdmissionChecks(session: SessionRecord, req: SendRequest): void {
    if (session.close_state === "pending") {
      throw new BrokerError("SESSION_CLOSING", "A close intent is pending for this session (§6.4).");
    }
    // A review binding belongs to review-slot sessions only (§8.1): a
    // current/worktree writer must use a workspace precondition, otherwise it
    // would bypass both the exclusive lease and the digest precondition.
    if ("review_binding" in req && session.workspace_mode !== "review_slot") {
      throw new BrokerError("INVALID_REQUEST", "review_binding requires a review_slot session (§8.1).");
    }
    if ("workspace_precondition" in req && session.workspace_mode !== "review_slot") {
      // Writer sessions need a coverage binding to make the precondition
      // checkable at all — reject before inference (§8.7).
      if (session.workspace_id && !session.coverage_profile_id) {
        throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Writer session has no coverage binding (§8.7).");
      }
    }
    switch (session.state) {
      case "IDLE":
        if (!sessionSendAllowed(session.state)) {
          throw new BrokerError("SESSION_BUSY", "Session cannot accept a turn now.");
        }
        break;
      case "ACTIVE":
        throw new BrokerError("SESSION_BUSY", "Session already has an unfinished turn (INV-01).");
      case "PROVISIONING":
        throw new BrokerError("SESSION_NOT_READY", "Session provisioning is not complete.");
      case "CLOSED":
        throw new BrokerError("SESSION_CLOSED", "Session is closed.");
      case "BLOCKED":
        throw new BrokerError(
          "SESSION_BLOCKED",
          session.block_reason ?? "Session is blocked.",
        );
      default:
        throw new BrokerError("SESSION_BLOCKED", "Session cannot accept a turn now.");
    }

    const adapter = this.adapters.get(session.provider);
    const recorded = session.adapter_version;
    if (adapter && recorded && recorded !== adapter.adapterVersion) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Session adapter version '${recorded}' does not match the registered adapter '${adapter.adapterVersion}'; revalidation required (§13.3).`,
      );
    }
  }

  /**
   * §13.3 durable provider binding re-check (inside the authoritative tx):
   * pure record reads only. A live account row that no longer matches the
   * immutable spawn-time tuple (provider/auth_mode/quota scope) refuses the
   * turn before acceptance — zero accepted resources, key freed as a mutable
   * rejection, no migration and no fresh-session fallback.
   */
  private assertDurableProviderBinding(session: SessionRecord): void {
    const lookup = readSessionProviderBinding(this.db, session.session_id);
    if (lookup.kind === "malformed") {
      throw new BrokerError("POLICY_UNSUPPORTED", `Session provider binding is unusable: ${lookup.reason}`, {
        executionStarted: false,
      });
    }
    const isNative = ["claude", "codex", "cursor", "antigravity", "zcode"].includes(session.provider);
    if (lookup.kind !== "bound") {
      if (isNative) {
        throw new BrokerError(
          "PROVIDER_INCOMPATIBLE",
          "Native legacy session lacks durable provider binding; replacement session required (§13.3).",
          { executionStarted: false },
        );
      }
      return; // legacy sessions keep their established contract
    }
    const binding = lookup.binding;
    const account = getAccount(this.db, session.account_profile_id);
    if (!account) {
      throw new BrokerError("INVALID_REQUEST", `Account profile '${session.account_profile_id}' is not registered.`, {
        executionStarted: false,
      });
    }
    if (
      account.account_profile_id !== binding.account.account_profile_id ||
      account.provider !== binding.account.provider ||
      account.auth_mode !== binding.account.auth_mode ||
      account.quota_scope_id !== binding.account.quota_scope_id
    ) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        "Registered account binding drifted from the session's durable grant (account profile ID, provider, auth mode or quota scope); refusing the turn — spawn a replacement session (historical grants are preserved).",
        { executionStarted: false },
      );
    }
  }

  /**
   * §13.3 later-turn readiness revalidation (OUTSIDE the tx, §7.2 step 3):
   * sessions with a durably bound readiness fingerprint re-run the adapter's
   * (adapter-side cached, freshness-bounded) preflight and compare the pure
   * observation fingerprint. Observed CLI/profile/catalog drift refuses
   * BEFORE acceptance. Sessions without observed readiness (void-compatible
   * adapters, legacy sessions) are unchanged.
   */
  private sendReadinessRevalidation(session: SessionRecord): void {
    const lookup = readSessionProviderBinding(this.db, session.session_id);
    if (lookup.kind !== "bound" || lookup.binding.readiness === null) return;
    const adapter = this.adapters.get(session.provider);
    if (!adapter) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `Provider '${session.provider}' is not available.`, {
        executionStarted: false,
      });
    }
    const account = getAccount(this.db, session.account_profile_id);
    if (!account || account.provider !== session.provider) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        `Account profile '${session.account_profile_id}' is not available for provider '${session.provider}'.`,
        { executionStarted: false },
      );
    }
    const policyLookup = loadSessionWritePolicy(this.db, session);
    if (policyLookup.kind !== "effective") return; // execution's established fail-closed path owns this refusal
    const returned = adapter.preflight({
      provider: session.provider,
      model: session.requested_model,
      effort: session.requested_effort,
      role: session.role,
      workspace_mode: session.workspace_mode,
      account: {
        account_profile_id: account.account_profile_id,
        auth_mode: account.auth_mode,
        quota_scope_id: account.quota_scope_id,
      },
      effective_policy: cloneFrozenPolicy(policyLookup.policy),
    } satisfies AdapterPreflightContext);
    const observation = readReadinessObservation(returned, adapter.providerId);
    const fingerprint = observation ? fingerprintReadinessObservation(observation) : null;
    if (fingerprint !== lookup.binding.readiness.fingerprint) {
      throw new BrokerError(
        "PROVIDER_INCOMPATIBLE",
        "Observed provider readiness drifted from the session's durable binding (CLI version, catalog or config changed); refusing before acceptance — replacement session with revalidation required.",
        { executionStarted: false, details: { bound_fingerprint: lookup.binding.readiness.fingerprint } },
      );
    }
  }

  private writerTurn(req: SendRequest): boolean {
    return "workspace_precondition" in req;
  }

  /**
   * A05 writer lease target for a registered workspace id: the physical
   * checkout identity resolved fresh from the live row (realpath/stat — pure
   * filesystem syscalls, safe inside the admission tx; no CLI/shell/Git
   * subprocess ever runs there). A registered path that does not resolve fails
   * closed instead of falling back to an ownership-bypassing ID scope.
   */
  private writerLeaseTargetOrThrow(workspaceId: string): WorkspaceLeaseTarget {
    const workspace = getWorkspace(this.db, workspaceId);
    if (!workspace) throw new BrokerError("INVALID_REQUEST", "Unknown workspace reference.");
    return workspaceLeaseTarget(workspace, { requireResolvable: true });
  }

  /**
   * A06 send preflight (§7.2 step 3): validate the session's durable physical
   * cwd binding against the freshly resolved checkout identity — all
   * filesystem resolution OUTSIDE the admission tx. Returns the bound binding
   * the authoritative transaction must recheck, or null when the session
   * carries no usable binding (unbound pre-package journals and malformed
   * payloads keep their established fail-closed refusals further along the
   * send/execution pipeline — they are never reinterpreted as the alias).
   */
  private validateSessionPhysicalBinding(session: SessionRecord, target: PhysicalCheckoutIdentity): SessionPhysicalCwdBinding | null {
    const lookup = readSessionPhysicalBinding(this.db, session.session_id);
    if (lookup.kind !== "bound") return null;
    if (lookup.binding.lease_scope !== target.scope) {
      throw new BrokerError(
        "WORKSPACE_CHANGED",
        "Registered workspace alias no longer resolves to the session's bound physical checkout (retargeted or replaced).",
        { executionStarted: false },
      );
    }
    const pinned = resolvePhysicalCheckoutIdentity(lookup.binding.canonical_cwd);
    if (!pinned || pinned.scope !== lookup.binding.lease_scope) {
      throw new BrokerError(
        "WORKSPACE_CHANGED",
        "Session's pinned physical checkout no longer resolves to its bound identity (renamed or recreated externally).",
        { executionStarted: false },
      );
    }
    return lookup.binding;
  }

  private quotaScopeFor(session: SessionRecord): string {
    return quotaScopeForSession(this.db, session);
  }

  // ─── cancel (§14.6) ───────────────────────────────────────────────────────

  cancel(coordinatorId: string, req: CancelRequest): SendResponse {
    const turn0 = this.authorizeTurn(coordinatorId, req.turn_id);
    const payloadHash = canonicalRequestHash({ turn_id: req.turn_id, reason: req.reason ?? null });
    const namespace = namespaceOf(turn0.project_id, coordinatorId, "agent_turn_cancel", req.idempotency_key);

    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast && fast.request_hash === payloadHash) return this.replaySend(fast, payloadHash);
    if (fast) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.");
    }

    let interruptNeeded = false;
    let response: SendResponse;
    response = this.db.tx(() => {
      const turn = this.authorizeTurn(coordinatorId, req.turn_id);
      const existing = getIdempotencyRecord(this.db, namespace);
      if (existing) return this.replaySend(existing, payloadHash);

      if (isTerminalTurnState(turn.state)) {
        // §14.6: terminal result stands; cancel is recorded as a no-op replay.
        insertIdempotencyRecord(this.db, {
          ...namespace,
          request_hash: payloadHash,
          outcome: "accepted",
          resolved_kind: "turn",
          resolved_id: turn.turn_id,
          rejection_code: null,
          created_at: this.now(),
        });
        appendEvent(this.db, {
          turn_id: turn.turn_id,
          session_id: turn.session_id,
          type: "late_cancel_observed",
          payload: { observed_state: turn.state },
          created_at: this.now(),
        });
        return {
          api_version: API_VERSION,
          session_id: turn.session_id,
          turn_id: turn.turn_id,
          state: turn.state,
          replayed_request: false,
        };
      }

      if (turn.state === "UNKNOWN") {
        throw new BrokerError("EXECUTION_UNKNOWN", "Turn outcome is unresolved; cancel requires reconciliation (§6.5.2).");
      }

      // ACCEPTED | STARTING | RUNNING | CANCELLING → CANCELLING (§6.5.2).
      assertTurnTransitionSafe(turn.state, "cancel_or_deadline");
      const now = this.now();
      updateTurnFields(
        this.db,
        turn.turn_id,
        { state: "CANCELLING", termination_reason: "cancelled" },
        turn.state_version,
        now,
      );
      insertIdempotencyRecord(this.db, {
        ...namespace,
        request_hash: payloadHash,
        outcome: "accepted",
        resolved_kind: "turn",
        resolved_id: turn.turn_id,
        rejection_code: null,
        created_at: now,
      });
      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: turn.session_id,
        type: "cancel_requested",
        payload: { reason: req.reason ?? null },
        created_at: now,
      });
      interruptNeeded = turn.state !== "ACCEPTED";
      return {
        api_version: API_VERSION,
        session_id: turn.session_id,
        turn_id: turn.turn_id,
        state: "CANCELLING",
        replayed_request: false,
      };
    });

    // External interrupt AFTER the durable intent (§14.6): if the dispatch
    // permission was not granted yet, the executor's gate will refuse and no
    // inference happens at all.
    if (interruptNeeded) this.requireExecutor().notifyCancel(req.turn_id, req.reason ?? "cancel");
    return response;
  }

  // ─── stop / guarded close (§6.4) ──────────────────────────────────────────

  stop(coordinatorId: string, req: StopRequest): StopResponse {
    const session0 = this.authorizeSession(coordinatorId, req.session_id);
    const payloadHash = canonicalRequestHash({ session_id: req.session_id });
    const namespace = namespaceOf(session0.project_id, coordinatorId, "agent_session_stop", req.idempotency_key);

    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast && fast.request_hash === payloadHash) return this.replayStop(fast, payloadHash);
    if (fast) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.");
    }

    let alreadyClosed = false;
    // Phase 1 (§6.4): durable close intent + guard checks — atomic with the
    // send ban so a concurrent send cannot be accepted after close intent.
    this.db.tx(() => {
      const session = this.authorizeSessionRaw(coordinatorId, req.session_id);
      const existing = getIdempotencyRecord(this.db, namespace);
      if (existing) return this.replayStop(existing, payloadHash);

      if (session.state === "CLOSED") {
        // Already closed: return existing closed state without re-stopping.
        alreadyClosed = true;
        insertIdempotencyRecord(this.db, {
          ...namespace,
          request_hash: payloadHash,
          outcome: "accepted",
          resolved_kind: "session",
          resolved_id: session.session_id,
          rejection_code: null,
          created_at: this.now(),
        });
        return null;
      }
      if (session.close_state === "pending") {
        throw new BrokerError("SESSION_CLOSING", "A close intent is already pending (§10.3.2).");
      }
      const active = session.active_turn_id ? getTurn(this.db, session.active_turn_id) : null;
      if (active && isNonterminalTurnState(active.state)) {
        if (active.state === "UNKNOWN") {
          throw new BrokerError("EXECUTION_UNKNOWN", "Turn outcome unresolved; reconciliation required before close (§6.4).", {
            details: { turn_id: active.turn_id },
          });
        }
        throw new BrokerError("ACTIVE_TURN", "Session has an unfinished turn (§6.4).", {
          details: { turn_id: active.turn_id },
        });
      }
      if (session.state === "PROVISIONING") {
        throw new BrokerError("SESSION_NOT_READY", "Provisioning must reach a defined state before close (§6.4).");
      }
      // Guard 3: session-owned mutating intents must be reconciled.
      const pendingIntent = this.findPendingSessionIntent(session.session_id);
      if (pendingIntent) {
        throw new BrokerError("SESSION_BLOCKED", "Unresolved session-owned intent prevents close.", {
          details: { intent_id: pendingIntent.intent_id, kind: pendingIntent.kind },
        });
      }
      // Guards 1–2 pass; accept durable close intent; ban new sends.
      const now = this.now();
      const intentId = newId(ID_PREFIX.intent);
      insertIntent(this.db, {
        intent_id: intentId,
        kind: "close_session",
        session_id: session.session_id,
        turn_id: null,
        state: "pending",
        payload: null,
        created_at: now,
        updated_at: now,
      });
      updateSessionFields(
        this.db,
        session.session_id,
        { close_state: "pending", close_intent_id: intentId },
        session.record_version,
        now,
      );
      insertIdempotencyRecord(this.db, {
        ...namespace,
        request_hash: payloadHash,
        outcome: "accepted",
        resolved_kind: "session",
        resolved_id: session.session_id,
        rejection_code: null,
        created_at: now,
      });
      appendEvent(this.db, {
        turn_id: null,
        session_id: session.session_id,
        type: "close_intent_accepted",
        payload: { close_intent_id: intentId },
        created_at: now,
      });
      return null;
    });

    if (alreadyClosed) {
      const session = getSession(this.db, req.session_id);
      return {
        api_version: API_VERSION,
        session_id: session?.session_id ?? req.session_id,
        state: "CLOSED",
        close_state: session?.close_state ?? "completed",
        replayed_request: true,
      };
    }

    // Phase 2: guarded idle-runtime shutdown may complete outside the MCP
    // request; acknowledgement `pending` is not a CLOSED claim (§10.3.2).
    this.enqueueClose(req.session_id);
    const session = getSession(this.db, req.session_id);
    return {
      api_version: API_VERSION,
      session_id: req.session_id,
      state: session?.state ?? "BLOCKED",
      close_state: "pending",
      replayed_request: false,
    };
  }

  /** Phase 2 of guarded close: shutdown → atomic CLOSED commit, or BLOCKED/failed. */
  private async runClosePhase(sessionId: string): Promise<void> {
    const session = getSession(this.db, sessionId);
    if (!session || session.close_state !== "pending") return;
    const adapter = this.adapters.get(session.provider);
    try {
      if (adapter) await adapter.shutdownIdleRuntime(sessionId);
    } catch (e) {
      // Unknown shutdown outcome → BLOCKED, close_state=failed, cap retained (§6.4).
      const now = this.now();
      this.db.tx(() => {
        const s = getSession(this.db, sessionId);
        if (!s || s.state === "CLOSED" || s.close_state !== "pending") return;
        assertSessionTransition(s.state, "close_failed");
        updateSessionFields(
          this.db,
          sessionId,
          { state: "BLOCKED", close_state: "failed", block_reason: `idle-runtime-shutdown-failed: ${String(e)}` },
          s.record_version,
          now,
        );
        if (s.close_intent_id) updateIntentState(this.db, s.close_intent_id, "failed", now);
        appendEvent(this.db, {
          turn_id: null,
          session_id: sessionId,
          type: "close_failed",
          payload: { error: String(e) },
          created_at: now,
        });
      });
      return;
    }
    this.commitClose(sessionId);
  }

  private commitClose(sessionId: string): StopResponse {
    const now = this.now();
    return this.db.tx(() => {
      const session = getSession(this.db, sessionId);
      if (!session) throw new Error("session-vanished");
      if (session.state === "CLOSED") {
        return {
          api_version: API_VERSION,
          session_id: session.session_id,
          state: "CLOSED",
          close_state: session.close_state,
          replayed_request: true,
        };
      }
      // §6.5.1 close_completed: single atomic commit releases cap + session pins.
      assertSessionTransition(session.state, "close_completed");
      for (const res of listActiveReservationsByOwner(this.db, sessionId)) {
        releaseReservation(this.db, res.reservation_id, now);
      }
      for (const pin of listPinsByOwner(this.db, sessionId)) {
        if (pin.root_kind === "session_anchor" || pin.root_kind === "reviewer_anchor") releasePin(this.db, pin.pin_id);
      }
      if (session.close_intent_id) {
        updateIntentState(this.db, session.close_intent_id, "completed", now);
      }
      updateSessionFields(
        this.db,
        sessionId,
        { state: "CLOSED", close_state: "completed" },
        session.record_version,
        now,
      );
      appendEvent(this.db, {
        turn_id: null,
        session_id: sessionId,
        type: "session_closed",
        payload: {},
        created_at: now,
      });
      return {
        api_version: API_VERSION,
        session_id: sessionId,
        state: "CLOSED",
        close_state: "completed",
        replayed_request: false,
      };
    });
  }

  private replayStop(rec: IdempotencyRow, payloadHash: string): StopResponse {
    if (rec.request_hash !== payloadHash) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.");
    }
    const session = getSession(this.db, rec.resolved_id ?? "");
    if (!session) throw new BrokerError("INVALID_REQUEST", "Idempotent record points to a missing session.");
    return {
      api_version: API_VERSION,
      session_id: session.session_id,
      state: session.state,
      close_state: session.close_state,
      replayed_request: true,
    };
  }

  private findPendingSessionIntent(sessionId: string): IntentRecord | null {
    for (const intent of listPendingIntents(this.db)) {
      if (intent.session_id === sessionId) return intent;
    }
    return null;
  }

  private enqueueClose(sessionId: string): void {
    this.track(this.runClosePhase(sessionId));
  }

  // ─── explicit snapshot refresh (§10.1.1) ─────────────────────────────────

  /**
   * `agent_workspace_snapshot`: explicit capture under a read admission — no
   * inference, no writer, no quarantine. Lets the coordinator consciously
   * accept a new baseline after external changes (§16.3) without resetting
   * the native conversation. Idempotent per §7.3.
   */
  snapshot(
    coordinatorId: string,
    req: { project_id: string; workspace_id: string; idempotency_key: string },
  ): { api_version: string; snapshot_id: string; capture_state: "SEALED" | "FAILED"; source_digest: string | null; replayed_request: boolean } {
    authorizeProjectAccess(this.db, { coordinatorId, projectId: req.project_id });
    const payloadHash = canonicalRequestHash(req);
    const namespace = namespaceOf(req.project_id, coordinatorId, "agent_workspace_snapshot", req.idempotency_key);

    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast && fast.request_hash === payloadHash) {
      const snap = fast.resolved_id ? getSnapshotRecord(this.db, fast.resolved_id) : null;
      if (!snap) throw new BrokerError("INVALID_REQUEST", "Idempotent record points to a missing snapshot.");
      return {
        api_version: API_VERSION,
        snapshot_id: snap.snapshot_id,
        capture_state: snap.state === "SEALED" ? "SEALED" : "FAILED",
        source_digest: snap.state === "SEALED" ? snap.source_digest : null,
        replayed_request: true,
      };
    }
    if (fast) {
      throw new BrokerError("IDEMPOTENCY_CONFLICT", "This idempotency key was used with a different payload.");
    }

    // Preflight (outside tx): registered, unquarantined, writer-free.
    const workspace = getWorkspace(this.db, req.workspace_id);
    if (!workspace || workspace.project_id !== req.project_id) {
      throw new BrokerError("INVALID_REQUEST", "Unknown workspace for this project.");
    }
    if (workspace.quarantined) {
      throw new BrokerError("WORKSPACE_BUSY", "Workspace is quarantined.", {
        details: { workspace_id: workspace.workspace_id, reason: workspace.quarantine_reason },
      });
    }
    if (!workspace.canonical_path) {
      throw new BrokerError("INVALID_REQUEST", "Workspace has no resolvable path.");
    }
    // A05: alias-aware writer-free precondition — a lease held by any alias
    // of this physical checkout (including the same workspace id) blocks the
    // read capture (§10.1.1).
    if (workspaceHasConflictingLease(this.db, workspaceLeaseTarget(workspace))) {
      throw new BrokerError("WORKSPACE_BUSY", "Workspace currently has a broker-owned writer (§10.1.1).");
    }
    const binding = this.resolveCoverageBinding(workspace);
    if (!binding) {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Workspace has no registered coverage binding.");
    }
    const profile = getCoverageProfile(this.db, binding.profile_id, binding.version);
    if (!profile) {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Coverage profile missing.");
    }
    let config: CoverageConfig;
    try {
      config = JSON.parse(profile.config) as CoverageConfig;
      validateCoverageConfig(config);
    } catch {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", "Coverage config invalid.");
    }

    try {
      const captured = captureSnapshot({
        db: this.db,
        blobs: this.blobStore,
        clock: this.clock,
        projectId: req.project_id,
        workspaceId: workspace.workspace_id,
        workspaceRoot: workspace.canonical_path,
        coverage: { ...binding, config },
      });
      const now = this.now();
      this.db.tx(() => {
        insertIdempotencyRecord(this.db, {
          ...namespace,
          request_hash: payloadHash,
          outcome: "accepted",
          resolved_kind: "artifact",
          resolved_id: captured.snapshot.snapshot_id,
          rejection_code: null,
          created_at: now,
        });
      });
      return {
        api_version: API_VERSION,
        snapshot_id: captured.snapshot.snapshot_id,
        capture_state: "SEALED",
        source_digest: captured.snapshot.source_digest,
        replayed_request: false,
      };
    } catch (e) {
      // §10.1.1: a capture that RAN and failed is a durable operation — the
      // same key replays to the same FAILED capture, never a silent re-run
      // (§7.3: old failed operation + same key → the old operation). Only
      // pre-capture rejections (above) leave the key free.
      if (e instanceof CaptureError) {
        const now = this.now();
        this.db.tx(() => {
          insertIdempotencyRecord(this.db, {
            ...namespace,
            request_hash: payloadHash,
            outcome: "accepted",
            resolved_kind: "artifact",
            resolved_id: e.snapshotId,
            rejection_code: null,
            created_at: now,
          });
        });
        const code: ErrorCode =
          e.code === "SNAPSHOT_UNSTABLE" || e.code === "SNAPSHOT_UNSUPPORTED" || e.code === "INPUT_LIMIT"
            ? e.code
            : "EVIDENCE_CAPTURE_FAILED";
        throw new BrokerError(code, e.message, { details: { snapshot_id: e.snapshotId, capture_state: "FAILED" } });
      }
      throw e;
    }
  }

  /** Textual artifact kinds readable via agent_artifact_read (§10.1). */
  private static readonly TEXTUAL_ARTIFACT_KINDS: ReadonlySet<string> = new Set([
    "findings", "report", "patch", "normalized_events", "result_capsule",
    "input_manifest", "source_inventory", "snapshot_manifest",
  ]);

  /**
   * agent_artifact_read: a bounded, authorized page of a textual artifact
   * (§10.1, §15.1: 64 KiB page). Binary artifacts return metadata only —
   * expired content is an explicit ARTIFACT_EXPIRED, never a fabricated
   * empty read (§15.3.3).
   */
  artifactRead(
    coordinatorId: string,
    artifactId: string,
    opts: { offset?: number; max_bytes?: number } = {},
  ): {
    api_version: string; artifact_id: string; kind: string; state: string;
    size_bytes: number | null; content_type: "text" | "binary";
    offset: number; max_bytes: number; bytes_read: number; next_offset: number; truncated: boolean; data: string | null;
  } {
    const artifact = getArtifact(this.db, artifactId);
    if (!artifact) {
      throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
    }
    authorizeProjectAccess(this.db, { coordinatorId, projectId: artifact.project_id });

    if (artifact.state === "expired") {
      throw new BrokerError("ARTIFACT_EXPIRED", "Artifact content has expired.");
    }
    if (artifact.state !== "sealed") {
      throw new BrokerError("ARTIFACT_NOT_READY", "Artifact is not sealed.");
    }

    const textual = BrokerCore.TEXTUAL_ARTIFACT_KINDS.has(artifact.kind);
    // Validate paging args: zero/negative/non-integer/NaN values are
    // INVALID_REQUEST, not silently clamped (§10.1 bounded page).
    const rawMax = opts.max_bytes ?? 64 * 1024;
    const rawOffset = opts.offset ?? 0;
    if (!Number.isInteger(rawMax) || rawMax < 1 || rawMax > 64 * 1024) {
      throw new BrokerError("INVALID_REQUEST", "max_bytes must be an integer in [1, 65536].");
    }
    if (!Number.isSafeInteger(rawOffset) || rawOffset < 0) {
      throw new BrokerError("INVALID_REQUEST", "offset must be a non-negative integer.");
    }
    const maxBytes = rawMax;
    const offset = rawOffset;

    if (!textual || !artifact.content_hash) {
      return {
        api_version: API_VERSION, artifact_id: artifact.artifact_id, kind: artifact.kind,
        state: artifact.state, size_bytes: artifact.size_bytes, content_type: "binary",
        offset: 0, max_bytes: 0, bytes_read: 0, next_offset: 0, truncated: false, data: null,
      };
    }

    let bytes: Uint8Array;
    try {
      bytes = this.blobStore.read(artifact.project_id, artifact.content_hash);
    } catch {
      throw new BrokerError("ARTIFACT_CORRUPT", "Artifact content is missing.");
    }
    // Hash verification (§10.4 ARTIFACT_CORRUPT): a blob corrupted at rest
    // is never served as data.
    if (sha256Hex(bytes) !== artifact.content_hash) {
      throw new BrokerError("ARTIFACT_CORRUPT", "Artifact content does not match its recorded hash.");
    }
    if (!isUtf8(bytes)) {
      throw new BrokerError("ARTIFACT_CORRUPT", "Textual artifact is not valid UTF-8.");
    }
    // Offsets are bytes. Do not emit replacement characters at page boundaries.
    const continuation = (index: number): boolean =>
      index < bytes.byteLength && (bytes[index]! & 0xc0) === 0x80;
    if (offset < bytes.byteLength && continuation(offset)) {
      throw new BrokerError("INVALID_REQUEST", "offset must be a UTF-8 character boundary.");
    }
    let end = Math.min(bytes.byteLength, offset + maxBytes);
    while (end > offset && continuation(end)) end--;
    if (offset < bytes.byteLength && end === offset) {
      throw new BrokerError("INVALID_REQUEST", "max_bytes cannot fit the next UTF-8 character.");
    }
    const slice = bytes.subarray(offset, end);
    const nextOffset = offset + slice.byteLength;
    const truncated = nextOffset < bytes.byteLength;
    return {
      api_version: API_VERSION, artifact_id: artifact.artifact_id, kind: artifact.kind,
      state: artifact.state, size_bytes: bytes.byteLength, content_type: "text",
      offset, max_bytes: maxBytes, bytes_read: slice.byteLength, next_offset: nextOffset, truncated,
      data: Buffer.from(slice).toString("utf8"),
    };
  }

  // ─── read tools (§10.1) ───────────────────────────────────────────────────

  sessionStatus(coordinatorId: string, sessionId: string): SessionRecord {
    return this.authorizeSession(coordinatorId, sessionId);
  }

  /**
   * Additive session_status binding/readiness metadata (§10.1): the durable
   * provider binding (registered account tuple, adapter version, observed
   * readiness evidence). NO credentials, NO native history, NO settings —
   * unknown stays null, never false, never a request echo. Legacy/unbound
   * sessions report nulls with the session row's own observed values.
   */
  sessionProviderBinding(coordinatorId: string, sessionId: string): {
    binding_version: number | null;
    account: { account_profile_id: string; provider: string; auth_mode: string; quota_scope_id: string | null } | null;
    adapter_version: string | null;
    cli_version: string | null;
    authenticated: boolean | null;
    readiness_fingerprint: string | null;
    readiness_observed_at: number | null;
    readiness_source: string | null;
    model_catalog_size: number | null;
  } {
    const session = this.authorizeSession(coordinatorId, sessionId);
    const lookup = readSessionProviderBinding(this.db, session.session_id);
    if (lookup.kind !== "bound") {
      return {
        binding_version: null,
        account: null,
        adapter_version: session.adapter_version,
        cli_version: session.cli_version,
        authenticated: null,
        readiness_fingerprint: null,
        readiness_observed_at: null,
        readiness_source: null,
        model_catalog_size: null,
      };
    }
    const binding = lookup.binding;
    return {
      binding_version: binding.binding_version,
      account: { ...binding.account },
      adapter_version: binding.adapter_version ?? session.adapter_version,
      cli_version: binding.cli_version ?? session.cli_version,
      // CLI-owned auth status as OBSERVED at admission; null = unknown —
      // distinct from a registered auth_mode and never reported as false.
      authenticated: binding.readiness?.authenticated ?? null,
      readiness_fingerprint: binding.readiness?.fingerprint ?? null,
      readiness_observed_at: binding.readiness?.observed_at ?? null,
      readiness_source: binding.readiness?.source ?? null,
      model_catalog_size: binding.readiness?.model_catalog_size ?? null,
    };
  }

  sessionsList(coordinatorId: string, projectId: string): SessionRecord[] {
    authorizeProjectAccess(this.db, { coordinatorId, projectId });
    return listSessionsByOwner(this.db, projectId, coordinatorId);
  }

  /**
   * `broker_status` data (§10.1.2): allowed projects for THIS bridge profile,
   * bounded; plus daemon/incarnation info supplied by the caller (the bridge
   * layer owns the lifecycle handle, the daemon owns the decision).
   */
  statusOverview(
    coordinatorId: string,
    opts: { limit: number; offset?: number; daemonState?: string; incarnation?: string },
  ): {
    api_version: string;
    daemon_state: string;
    incarnation: string | null;
    allowed_projects: Array<{ project_id: string; display_name: string; default: boolean }>;
    next_cursor: string | null;
    limits: Limits;
    pending_intents: number;
  } {
    const coordinator = getCoordinator(this.db, coordinatorId);
    const all = ((coordinator?.allowed_project_ids ?? []) as string[])
      .map((id: string) => {
        const project = getProject(this.db, id);
        return { project_id: id, display_name: project?.display_name ?? id, default: false };
      });
    const offset = opts.offset ?? 0;
    const page = all.slice(offset, offset + opts.limit);
    if (page.length > 0) page[0]!.default = offset === 0;
    return {
      api_version: API_VERSION,
      daemon_state: opts.daemonState ?? "READY",
      incarnation: opts.incarnation ?? null,
      allowed_projects: page,
      next_cursor: offset + opts.limit < all.length ? String(offset + opts.limit) : null,
      limits: this.limits,
      pending_intents: listPendingIntents(this.db).length,
    };
  }

  /**
   * `agents_list` discovery (§10.1.2): project-scoped bootstrap manifest.
   * The cursor is bound to the configuration revision ("r<rev>:<offset>"):
   * a stale cursor raises DISCOVERY_CHANGED and the caller restarts paging.
   */
  discovery(
    coordinatorId: string,
    projectId: string,
    cursor: string | null,
    limit: number,
  ): {
    project_id: string;
    configuration_revision: number;
    entries: Array<Record<string, unknown>>;
    next_cursor: string | null;
  } {
    authorizeProjectAccess(this.db, { coordinatorId, projectId });
    const project = getProject(this.db, projectId);
    if (!project) throw new BrokerError("UNAUTHORIZED", "Access denied for this coordinator/project binding.");
    const revision = project.configuration_revision;

    let offset = 0;
    if (cursor !== null && cursor !== undefined) {
      const match = /^r(\d+):(\d+)$/.exec(cursor);
      if (!match) {
        throw new BrokerError("INVALID_REQUEST", "Malformed discovery cursor.");
      }
      const cursorRevision = Number(match[1]);
      offset = Number(match[2]);
      if (cursorRevision !== revision) {
        throw new BrokerError("DISCOVERY_CHANGED", "Configuration changed during pagination; restart from the first page.", {
          details: { cursor_revision: cursorRevision, current_revision: revision },
        });
      }
    }

    const entries: Array<Record<string, unknown>> = [];
    for (const [id, adapter] of this.adapters) {
      entries.push({
        kind: "adapter", id, display_name: id,
        adapter_version: adapter.adapterVersion,
        capability_status: "documented", // §13.1: never "supported" before the native spike
      });
    }
    const accounts = this.db.raw.prepare("SELECT account_profile_id FROM account_profiles").all() as Array<{ account_profile_id: string }>;
    const pauses = new Map(listActiveQuotaCooldowns(this.db, this.now()).map(row => [row.quota_scope_id, row]));
    for (const { account_profile_id } of accounts) {
      const acct = getAccount(this.db, account_profile_id);
      if (!acct) continue;
      const pause = pauses.get(acct.quota_scope_id);
      entries.push({
        kind: "account_profile", id: acct.account_profile_id, display_name: acct.account_profile_id,
        provider: acct.provider, auth_mode: acct.auth_mode, quota_scope_id: acct.quota_scope_id,
        ...(pause ? {
          quota_pause: {
            quota_scope_id: pause.quota_scope_id,
            until_ms: pause.until_ms,
            source: pause.source,
          },
        } : {}),
      });
    }
    const workspaces = this.db.raw
      .prepare("SELECT workspace_id, mode, coverage_profile_id, quarantined FROM workspaces WHERE project_id = ?")
      .all(projectId) as Array<{ workspace_id: string; mode: string; coverage_profile_id: string | null; quarantined: number }>;
    for (const ws of workspaces) {
      entries.push({
        kind: "workspace", id: ws.workspace_id, display_name: ws.workspace_id,
        mode: ws.mode, coverage_profile_id: ws.coverage_profile_id, quarantined: ws.quarantined === 1,
        // §8.3 additive: eligible registered repository workspace reference
        // for broker-created detached worktrees. Only REGISTERED ids are
        // exposed — never a guessed or caller-supplied path.
        eligible_worktree_source: ws.mode === "current" && ws.quarantined !== 1 && ws.coverage_profile_id !== null,
      });
    }
    const policies = this.db.raw
      .prepare("SELECT policy_profile_id, MAX(version) AS version FROM policy_profiles GROUP BY policy_profile_id")
      .all() as Array<{ policy_profile_id: string; version: string }>;
    for (const p of policies) {
      entries.push({ kind: "policy_profile", id: p.policy_profile_id, display_name: p.policy_profile_id, version: p.version });
    }
    for (const route of this.routes.values()) {
      if (route.project_id !== projectId) continue;
      entries.push({
        kind: "route",
        id: route.route_id,
        route_id: route.route_id,
        display_name: route.display_name ?? route.route_id,
        enabled: route.enabled !== false,
        tags: effectiveRouteTags(route),
        project_id: route.project_id,
        provider: route.provider,
        account_profile_id: route.account_profile_id,
        model: route.model,
        effort: route.effort ?? null,
        role: route.role,
        policy_profile_id: route.policy_profile_id,
        native_subagents: route.native_subagents ?? { mode: "off", max_agents: 1 },
        native_subagents_enforcement: "advisory",
      });
    }

    entries.sort((a, b) => (String(a.kind) + String(a.id) < String(b.kind) + String(b.id) ? -1 : 1));
    const page = entries.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    return {
      project_id: projectId,
      configuration_revision: revision,
      entries: page,
      next_cursor: nextOffset < entries.length ? `r${revision}:${nextOffset}` : null,
    };
  }

  turnStatus(coordinatorId: string, turnId: string): TurnRecord {
    return this.authorizeTurn(coordinatorId, turnId);
  }

  turnAgentReported(coordinatorId: string, turnId: string) {
    this.turnStatus(coordinatorId, turnId); // Apply the same turn ownership check.
    return getTurnEventPayload(this.db, turnId, "agent_reported");
  }

  /** Schema-only report/findings artifact descriptor for the public result DTO. */
  turnReportArtifact(coordinatorId: string, turnId: string): { artifact_id: string; kind: string } | null {
    this.turnStatus(coordinatorId, turnId);
    const pub = getTurnEventPayload(this.db, turnId, "report_publication");
    if (!pub || typeof pub.artifact_id !== "string") return null;
    const kind = pub.kind === "findings" || pub.kind === "report" ? pub.kind : "report";
    return { artifact_id: pub.artifact_id, kind };
  }

  turnEvents(coordinatorId: string, turnId: string, afterSeq: number, limit: number) {
    this.authorizeTurn(coordinatorId, turnId);
    return listEventsByTurn(this.db, turnId, afterSeq, limit);
  }

  /**
   * Return a durable event page, waiting only on short metadata polls. Each
   * poll reauthorizes the turn before reading events so revocation cannot turn
   * an outstanding wait into an event disclosure.
   */
  async waitForTurnEvents(
    coordinatorId: string,
    turnId: string,
    afterSeq: number,
    limit: number,
    waitMs: number,
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      throwIfAborted(signal);
      const turn = this.authorizeTurn(coordinatorId, turnId);
      const rows = listEventsByTurn(this.db, turnId, afterSeq, limit);
      if (rows.length > 0 || isTerminalTurnState(turn.state) || waitMs === 0) return rows;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return rows;
      await waitForEventPoll(signal, Math.min(100, remaining));
    }
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private authorizeSession(coordinatorId: string, sessionId: string): SessionRecord {
    const s = this.authorizeSessionRaw(coordinatorId, sessionId);
    return s;
  }

  private authorizeSessionRaw(coordinatorId: string, sessionId: string): SessionRecord {
    const session = getSession(this.db, sessionId);
    if (!session) {
      throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
    }
    authorizeProjectAccess(this.db, { coordinatorId, projectId: session.project_id });
    authorizeOwner(session.owner_coordinator_id, coordinatorId);
    return session;
  }

  private authorizeTurn(coordinatorId: string, turnId: string): TurnRecord {
    const turn = getTurn(this.db, turnId);
    if (!turn) {
      throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
    }
    authorizeProjectAccess(this.db, { coordinatorId, projectId: turn.project_id });
    authorizeOwner(turn.owner_coordinator_id, coordinatorId);
    return turn;
  }
}

// ─── small module-local helpers (kept out of class for testability) ─────────

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new Error("Event wait aborted.");
}

function waitForEventPoll(signal: AbortSignal | undefined, delayMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Event wait aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Event wait aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function namespaceOf(project_id: string, owner: string, op: OperationName, key: string) {
  return {
    project_id,
    owner_coordinator_id: owner,
    operation_name: op,
    idempotency_key: key,
  };
}

/**
 * Read the session-owned §8.3 worktree provision journal from its provision
 * intent (any state — replays and failures report the same binding). Null
 * when the session has no broker-created worktree journal or it is malformed.
 */
function readOwnedWorktreeJournal(db: RegistryDb, sessionId: string): WorktreeProvisionJournal | null {
  const row = readProvisionIntentPayload(db, sessionId);
  if (!row?.payload) return null;
  try {
    const parsed: unknown = JSON.parse(row.payload);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parseWorktreeJournal((parsed as Record<string, unknown>).worktree_provisioning);
  } catch {
    return null;
  }
}

/**
 * Strict journal read distinguishing "no owned worktree binding" from a
 * binding that EXISTS but is invalid/unreadable. A malformed owned binding
 * must retain its journal (never be interpreted as an ordinary provision),
 * so the ambiguity is surfaced to the caller instead of collapsed to null.
 */
function readProvisionIntentPayload(
  db: RegistryDb,
  sessionId: string,
): { payload: string | null } | undefined {
  try {
    return db.raw
      .prepare("SELECT payload FROM intents WHERE kind = 'provision_session' AND session_id = ? ORDER BY created_at LIMIT 1")
      .get(sessionId) as { payload: string | null } | undefined;
  } catch {
    return undefined;
  }
}

/** Durable §8.3 fence fields of one repository-lock hold (exact owner token). */
function worktreeLockFence(ticket: RepositoryLockTicket): {
  key: string;
  seq: number;
  acquired_at: number;
  hold_id: string;
  incarnation: string;
} {
  return {
    key: ticket.key,
    seq: ticket.seq,
    acquired_at: ticket.acquired_at,
    hold_id: ticket.hold_id,
    incarnation: ticket.incarnation,
  };
}

/**
 * Pure comparable fingerprint over every externally-observed spawn input
 * (§7.2): provider, adapter version, registered account binding, the narrowed
 * effective policy and the captured readiness observation (null for
 * void-compatible adapters). Recomputed inside the admission transaction from
 * fresh pure reads — an unequal fingerprint rejects the spawn instead of
 * admitting stale preflight observations. The profile config itself is
 * covered by its `profile_fingerprint` (sha256 over the config text).
 */
function spawnCandidateFingerprint(parts: {
  provider: string;
  adapterVersion: string;
  account: Pick<AccountProfileRecord, "account_profile_id" | "provider" | "auth_mode" | "quota_scope_id">;
  policy: EffectiveWritePolicy;
  observation: ProviderReadinessObservation | null;
  worktreeSource: { source_workspace_id: string; base_commit: string; source_common_dir: string; source_canonical_path: string; source_coverage_profile_id: string } | null;
}): string {
  return sha256Hex(JSON.stringify({
    provider: parts.provider,
    adapter_version: parts.adapterVersion,
    account: {
      account_profile_id: parts.account.account_profile_id,
      provider: parts.account.provider,
      auth_mode: parts.account.auth_mode,
      quota_scope_id: parts.account.quota_scope_id,
    },
    policy: {
      binding_version: parts.policy.binding_version,
      access: parts.policy.access,
      write_scope: parts.policy.write_scope,
      policy_profile_id: parts.policy.policy_profile_id,
      policy_profile_version: parts.policy.policy_profile_version,
      profile_fingerprint: parts.policy.profile_fingerprint,
      requested_restrictions: parts.policy.requested_restrictions,
    },
    readiness_fingerprint: parts.observation ? fingerprintReadinessObservation(parts.observation) : null,
    // §8.3: the validated source binding participates — a changed source row
    // or base commit yields a different fingerprint and refuses admission.
    worktree_source: parts.worktreeSource,
  }));
}

/** Seal the spawn candidate's durable provider binding (§12.1/§13.3 intent). */
function durableProviderBinding(candidate: SpawnPreflightCandidate): {
  binding_version: number;
  account: { account_profile_id: string; provider: string; auth_mode: string; quota_scope_id: string | null };
  adapter_version: string;
  cli_version: string | null;
  readiness: {
    fingerprint: string;
    observed_at: number;
    source: string;
    authenticated: boolean | null;
    model_catalog_size: number | null;
  } | null;
} {
  return {
    binding_version: 1,
    account: {
      account_profile_id: candidate.account.account_profile_id,
      provider: candidate.account.provider,
      auth_mode: candidate.account.auth_mode,
      quota_scope_id: candidate.account.quota_scope_id,
    },
    adapter_version: candidate.adapterVersion,
    cli_version: candidate.observation?.cli_version ?? null,
    readiness: candidate.observation
      ? {
          fingerprint: fingerprintReadinessObservation(candidate.observation),
          observed_at: candidate.observation.observed_at,
          source: candidate.observation.source,
          authenticated: candidate.observation.authenticated,
          model_catalog_size: candidate.observation.model_catalog?.length ?? null,
        }
      : null,
  };
}

/**
 * Read a session's durable provider binding from its provision_session
 * intent. Missing legacy keys are unbound; native callers refuse replacement.
 * A corrupt or unknown binding version fails closed as malformed.
 */
export function readSessionProviderBinding(db: RegistryDb, sessionId: string): ProviderBindingLookup {
  let row: { payload: string | null } | undefined;
  try {
    row = db.raw
      .prepare("SELECT payload FROM intents WHERE kind='provision_session' AND session_id=? ORDER BY created_at LIMIT 1")
      .get(sessionId) as { payload: string | null } | undefined;
  } catch {
    return { kind: "unbound" };
  }
  if (!row || !row.payload) return { kind: "unbound" };
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const raw = payload.provider_binding;
    if (raw === undefined) return { kind: "unbound" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { kind: "malformed", reason: "provider binding is not an object" };
    }
    const b = raw as Record<string, unknown>;
    if (b.binding_version !== 1 || typeof b.adapter_version !== "string" || b.adapter_version.length === 0 || b.adapter_version.length > 128 || (b.cli_version !== null && (typeof b.cli_version !== "string" || b.cli_version.length > 128))) {
      return {kind:"malformed",reason:"provider binding version metadata is invalid"};
    }
    const account = b.account;
    if (!account || typeof account !== "object" || Array.isArray(account)) {
      return { kind: "malformed", reason: "provider binding account is missing" };
    }
    const a = account as Record<string, unknown>;
    if (typeof a.account_profile_id !== "string" || typeof a.provider !== "string" || typeof a.auth_mode !== "string") {
      return { kind: "malformed", reason: "provider binding account tuple is invalid" };
    }
    if (a.quota_scope_id !== null && typeof a.quota_scope_id !== "string") {
      return { kind: "malformed", reason: "provider binding quota scope is invalid" };
    }
    if (b.readiness === undefined || (["cursor","antigravity","zcode"].includes(String(a.provider)) && b.readiness === null)) return {kind:"malformed",reason:"provider binding required readiness is missing"};
    let readiness: DurableReadinessMetadata | null = null;
    if (b.readiness !== undefined && b.readiness !== null) {
      if (typeof b.readiness !== "object" || Array.isArray(b.readiness)) {
        return { kind: "malformed", reason: "provider binding readiness is invalid" };
      }
      const r = b.readiness as Record<string, unknown>;
      if (typeof r.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(r.fingerprint)) {
        return { kind: "malformed", reason: "provider binding readiness fingerprint is invalid" };
      }
      if (typeof r.observed_at !== "number" || !Number.isSafeInteger(r.observed_at) || r.observed_at < 0 || (r.source !== "cli_metadata_probe" && r.source !== "config_catalog") || (r.authenticated !== null && typeof r.authenticated !== "boolean") || (r.model_catalog_size !== null && (typeof r.model_catalog_size !== "number" || !Number.isSafeInteger(r.model_catalog_size) || r.model_catalog_size < 0 || r.model_catalog_size > 4096))) return {kind:"malformed",reason:"provider readiness metadata is invalid"};
      readiness = {
        fingerprint: r.fingerprint,
        observed_at: r.observed_at,
        source: r.source,
        authenticated: typeof r.authenticated === "boolean" ? r.authenticated : null,
        model_catalog_size: typeof r.model_catalog_size === "number" && Number.isSafeInteger(r.model_catalog_size) ? r.model_catalog_size : null,
      };
    }
    return {
      kind: "bound",
      binding: {
        binding_version: 1,
        account: {
          account_profile_id: a.account_profile_id,
          provider: a.provider,
          auth_mode: a.auth_mode,
          quota_scope_id: typeof a.quota_scope_id === "string" ? a.quota_scope_id : null,
        },
        adapter_version: typeof b.adapter_version === "string" ? b.adapter_version : null,
        cli_version: typeof b.cli_version === "string" ? b.cli_version : null,
        readiness,
      },
    };
  } catch (e) {
    return { kind: "malformed", reason: e instanceof Error ? e.message : String(e) };
  }
}

function assertTurnTransitionSafe(from: TurnState, trigger: string): void {
  // Full normative validation lives in transitions.ts; the executor uses the
  // same tables. This guard keeps cancel admission honest without duplicating
  // trigger types here.
  if (from === "FINALIZING" || from === "UNKNOWN") {
    throw new BrokerError("INVALID_REQUEST", `Cancel is not a legal transition from ${from} (§6.5.2).`);
  }
  void trigger;
}

/**
 * Quota scope for a session, shared by admission and the executor's
 * pre-dispatch recheck so both decide cooldowns with the SAME semantics:
 * §13.3 — the DURABLE account tuple bound at spawn decides quota scope (a
 * later live account-row change must never retarget an existing grant);
 * conservative shared default per provider when unconfirmed (§12.3).
 */
export function quotaScopeForSession(db: RegistryDb, session: SessionRecord): string {
  const lookup = readSessionProviderBinding(db, session.session_id);
  if (lookup.kind === "bound") {
    return lookup.binding.account.quota_scope_id ?? `shared:${lookup.binding.account.provider}`;
  }
  return getAccount(db, session.account_profile_id)?.quota_scope_id ?? `shared:${session.provider}`;
}

/**
 * A learned quota-scope pause blocks NEW work for the scope: shared across
 * projects and accounts bound to the same scope, with QUOTA_EXHAUSTED and
 * executionStarted:false (nothing was dispatched for THIS request).
 */
export function assertQuotaScopeSendable(db: RegistryDb, quotaScopeId: string, now: number): void {
  const pause = activeQuotaCooldown(db, quotaScopeId, now);
  if (!pause) return;
  throw new BrokerError("QUOTA_EXHAUSTED", "Quota scope is cooling down after a definitive provider quota exhaustion; no new work is admitted until the pause expires.", {
    executionStarted: false,
    details: {
      quota_scope_id: pause.quota_scope_id,
      blocked_until: pause.until_ms,
      retry_after_ms: Math.max(0, pause.until_ms - now),
      source: pause.source,
    },
  });
}

export { getSession as _getSession, getTurn as _getTurn };
