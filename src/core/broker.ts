/**
 * BrokerCore — deterministic session/turn control plane (spec §6, §7, §10).
 *
 * The authoritative admission boundary (§7.2): idempotency lookup, canonical
 * payload comparison and the final replay/conflict/reject/accept decision are
 * serialized with session/resource checks inside one metadata transaction.
 * Only ACCEPTED operations are recorded in the idempotency ledger; a mutable
 * rejection (RESOURCE_BUSY etc.) frees the key for a later attempt (§7.3).
 */
import type { RegistryDb } from "../storage/db.ts";
import {
  appendEvent,
  countActiveReservations,
  getAccount,
  getCoordinator,
  getCoverageProfile,
  getDaemonState,
  getIdempotencyRecord,
  getProject,
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
  updateTurnFields,
  SqliteConstraintError,
  type IdempotencyRow,
} from "../storage/repo.ts";
import { BrokerError, type ErrorCode } from "../shared/errors.ts";
import { canonicalRequestHash } from "../shared/canonicalize.ts";
import { newId, ID_PREFIX, sha256Hex } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type {
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
} from "../shared/api-types.ts";
import { API_VERSION, DEFAULT_LIMITS } from "../shared/api-types.ts";
import { authorizeOwner, authorizeProjectAccess } from "./authz.ts";
import { checkTurnCapacity, checkWorkspaceLeaseAvailable, reserveSessionSlot, reserveTurn } from "./capacity.ts";
import {
  assertSessionTransition,
  sessionSendAllowed,
  isTerminalTurnState,
  isNonterminalTurnState,
} from "./transitions.ts";
import type { TurnExecutor } from "./execution.ts";
import type { ProviderAdapter } from "../runtime/adapter.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import { captureSnapshot, CaptureError } from "../snapshots/capture.ts";
import { computeSourceDigest, takeInventory } from "../workspaces/inventory.ts";
import { CoverageError, normalizePrefixList, normalizeRelPath, parsePolicyWriteScope, uncoveredWriteScope, validateCoverageConfig, type CoverageConfig, type PolicyWriteScope } from "../workspaces/coverage.ts";

// ─── Request DTOs (API 0.2 §10) ─────────────────────────────────────────────

export interface SpawnRequest {
  project_id: string;
  idempotency_key: string;
  provider: string;
  account_profile_id: string;
  model: string;
  effort: string | null;
  role: AgentRole;
  instructions: string;
  workspace: { mode: WorkspaceMode; workspace_id: string | null };
  policy_profile_id: string;
  policy_restrictions?: Record<string, unknown>;
}

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

// ─── Public response shapes ─────────────────────────────────────────────────

export interface SpawnResponse {
  api_version: string;
  session_id: string;
  state: SessionState;
  initial_snapshot_id: string | null;
  replayed_request: boolean;
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
}

export class BrokerCore {
  readonly db: RegistryDb;
  readonly clock: Clock;
  readonly limits: Limits;
  readonly adapters: Map<string, ProviderAdapter>;
  readonly blobStore: BlobStore;
  private readonly deferExecution: boolean;
  private executor: TurnExecutor | null = null;
  private background: Promise<unknown>[] = [];

  constructor(opts: BrokerOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.adapters = opts.adapters;
    this.blobStore = opts.blobStore;
    this.deferExecution = opts.deferExecution ?? false;
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

  /** Wired post-construction to avoid a constructor cycle. */
  attachExecutor(executor: TurnExecutor): void {
    this.executor = executor;
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

  // ─── spawn (§6.1, §7.3) ───────────────────────────────────────────────────

  spawn(coordinatorId: string, req: SpawnRequest): SpawnResponse {
    // Step 1 (§7.2): authorization first — revoked access denies even replay.
    authorizeProjectAccess(this.db, { coordinatorId, projectId: req.project_id });

    const payloadHash = canonicalRequestHash(req);
    const namespace = {
      project_id: req.project_id,
      owner_coordinator_id: coordinatorId,
      operation_name: "agent_session_spawn" as OperationName,
      idempotency_key: req.idempotency_key,
    };

    // Fast path (step 2): committed lookup only — an optimization.
    const fast = getIdempotencyRecord(this.db, namespace);
    if (fast) return this.replaySpawn(fast, payloadHash);
    this.assertAdmissionOpen();

    // Step 3: non-authoritative preflight (no inference).
    this.spawnPreflight(req);

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
          sessionId = existing.resolved_id;
          return;
        }
        this.assertAdmissionOpen();
        this.spawnPreflight(req); // re-run: config may have changed concurrently

        const created = this.createProvisioningSession(coordinatorId, req, payloadHash);
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
    return {
      api_version: API_VERSION,
      session_id: session.session_id,
      state: session.state,
      initial_snapshot_id: session.initial_snapshot_id,
      replayed_request: true,
    };
  }

  private spawnPreflight(req: SpawnRequest): void {
    if (Buffer.byteLength(req.instructions, "utf8") > 64 * 1024) {
      throw new BrokerError("INPUT_LIMIT", "Session instructions exceed 64 KiB.");
    }
    if (!req.idempotency_key || req.idempotency_key.length > 256) {
      throw new BrokerError("INVALID_REQUEST", "Invalid idempotency key.");
    }
    if (!req.model) throw new BrokerError("INVALID_REQUEST", "Explicit provider model is required.");
    if (!this.adapters.has(req.provider)) {
      throw new BrokerError("PROVIDER_INCOMPATIBLE", `Provider '${req.provider}' is not available.`);
    }
    if (req.role === "reviewer" && req.workspace.mode !== "review_slot") {
      throw new BrokerError("INVALID_REQUEST", "role=reviewer requires workspace.mode=review_slot (§8.1).");
    }
  }

  /**
   * Creates the durable PROVISIONING session with its reservations, intent
   * and idempotency record — called INSIDE the admission transaction.
   */
  private createProvisioningSession(
    coordinatorId: string,
    req: SpawnRequest,
    payloadHash: string,
  ): { sessionId: string; provisionIntentId: string } {
    const now = this.now();
    const sessionId = newId(ID_PREFIX.session);
    const provisionIntent = newId(ID_PREFIX.intent);

    // Coverage binding resolves at spawn from the registered workspace
    // profile (§5.2) and is immutable for the session afterwards.
    const workspace = req.workspace.workspace_id ? getWorkspace(this.db, req.workspace.workspace_id) : null;
    if (req.workspace.workspace_id && !workspace) {
      throw new BrokerError("INVALID_REQUEST", "Unknown workspace reference.");
    }
    if (workspace && workspace.project_id !== req.project_id) {
      throw new BrokerError("INVALID_REQUEST", "Workspace does not belong to this project.");
    }
    const binding = this.resolveCoverageBinding(workspace);

    // Session slot cap (§15.1) checked + reserved in the same boundary.
    reserveSessionSlot(this.db, now, sessionId, req.project_id, this.sessionCap(req.project_id));
    const session: SessionRecord = {
      session_id: sessionId,
      project_id: req.project_id,
      owner_coordinator_id: coordinatorId,
      provider: req.provider,
      adapter_version: null,
      cli_version: null,
      account_profile_id: req.account_profile_id,
      auth_mode: null,
      requested_model: req.model,
      requested_effort: req.effort,
      effective_model: null,
      effective_effort: null,
      role: req.role,
      instructions_hash: sha256Hex(req.instructions),
      policy_profile_id: req.policy_profile_id,
      policy_profile_version: "1",
      workspace_id: req.workspace.workspace_id,
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
      intent_id: provisionIntent,
      kind: "provision_session",
      session_id: sessionId,
      turn_id: null,
      state: "pending",
      payload: JSON.stringify({ request_hash: payloadHash, instructions: req.instructions }),
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
    return { sessionId, provisionIntentId: provisionIntent };
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
  private completeProvisioningIfNeeded(sessionId: string): void {
    const current = getSession(this.db, sessionId);
    if (!current) throw new Error("session-vanished");
    if (current.state !== "PROVISIONING") return;

    // Review slots (P2-2) and path-less workspaces provision without capture.
    const workspace = current.workspace_id ? getWorkspace(this.db, current.workspace_id) : null;
    const needsCapture =
      workspace !== null &&
      workspace.mode !== "review_slot" &&
      workspace.canonical_path !== null &&
      current.coverage_profile_id !== null;

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
        const captured = captureSnapshot({
          db: this.db,
          blobs: this.blobStore,
          clock: this.clock,
          projectId: current.project_id,
          workspaceId: workspace.workspace_id,
          workspaceRoot: workspace.canonical_path,
          coverage: {
            profile_id: profile.coverage_profile_id,
            version: profile.version,
            contract_hash: profile.contract_hash,
            config,
          },
        });
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
    this.db.tx(() => {
      const session = getSession(this.db, sessionId);
      if (!session || session.state !== "PROVISIONING") return;
      assertSessionTransition(session.state, "provisioning_completed");
      updateSessionFields(this.db, sessionId, { state: "IDLE" }, session.record_version, now);
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
    // §7.2 step 3 preflight: expensive filesystem hashing outside the tx.
    this.sendSnapshotPreflight(session0, req);

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
        const workspaceId = session.workspace_id; // writer lease target (INV-02)

        checkTurnCapacity(this.db, this.limits, quotaScope);
        if (workspaceId && this.writerTurn(req)) checkWorkspaceLeaseAvailable(this.db, workspaceId);

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
          workspace_id: this.writerTurn(req) ? workspaceId : null,
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
   * §8.7: the coverage contract must cover the whole policy write scope. An
   * INVALID write scope (bad JSON / bad prefixes) is an operator config
   * error — reject before inference, not after the run.
   */
  private checkWriteScopeCoverage(session: SessionRecord): void {
    if (!session.coverage_profile_id || !session.coverage_profile_version) return;
    const profile = getCoverageProfile(this.db, session.coverage_profile_id, session.coverage_profile_version);
    if (!profile) return;
    const scope = this.policyWriteScope(session);
    if (scope.kind === "invalid") {
      throw new BrokerError("SNAPSHOT_COVERAGE_MISMATCH", `Policy write scope is invalid (§8.7): ${scope.reason}`);
    }
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

  /** Tri-state policy write scope from the session's bound profile (§8.1). */
  private policyWriteScope(session: SessionRecord): PolicyWriteScope {
    const row = this.db.raw
      .prepare("SELECT config FROM policy_profiles WHERE policy_profile_id = ? AND version = ?")
      .get(session.policy_profile_id, session.policy_profile_version) as { config: string } | undefined;
    if (!row) return { kind: "invalid", reason: "policy profile not found" };
    return parsePolicyWriteScope(row.config);
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

  private writerTurn(req: SendRequest): boolean {
    return "workspace_precondition" in req;
  }

  private quotaScopeFor(session: SessionRecord): string {
    // Quota scope resolution from account profiles; conservative shared
    // default per provider when unconfirmed (§12.3).
    return getAccount(this.db, session.account_profile_id)?.quota_scope_id ?? `shared:${session.provider}`;
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
    const activeWriters = countActiveReservations(this.db, "workspace_lease", workspace.workspace_id);
    if (activeWriters > 0) {
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
    offset: number; max_bytes: number; truncated: boolean; data: string | null;
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
    if (!Number.isInteger(rawOffset) || rawOffset < 0) {
      throw new BrokerError("INVALID_REQUEST", "offset must be a non-negative integer.");
    }
    const maxBytes = rawMax;
    const offset = rawOffset;

    if (!textual || !artifact.content_hash) {
      return {
        api_version: API_VERSION, artifact_id: artifact.artifact_id, kind: artifact.kind,
        state: artifact.state, size_bytes: artifact.size_bytes, content_type: "binary",
        offset: 0, max_bytes: 0, truncated: false, data: null,
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
    const slice = bytes.subarray(offset, offset + maxBytes);
    const truncated = offset + slice.byteLength < bytes.byteLength;
    return {
      api_version: API_VERSION, artifact_id: artifact.artifact_id, kind: artifact.kind,
      state: artifact.state, size_bytes: bytes.byteLength, content_type: "text",
      offset, max_bytes: maxBytes, truncated,
      data: Buffer.from(slice).toString("utf8"),
    };
  }

  // ─── read tools (§10.1) ───────────────────────────────────────────────────

  sessionStatus(coordinatorId: string, sessionId: string): SessionRecord {
    return this.authorizeSession(coordinatorId, sessionId);
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
    for (const { account_profile_id } of accounts) {
      const acct = getAccount(this.db, account_profile_id);
      if (!acct) continue;
      entries.push({
        kind: "account_profile", id: acct.account_profile_id, display_name: acct.account_profile_id,
        provider: acct.provider, auth_mode: acct.auth_mode, quota_scope_id: acct.quota_scope_id,
      });
    }
    const workspaces = this.db.raw
      .prepare("SELECT workspace_id, mode, coverage_profile_id, quarantined FROM workspaces WHERE project_id = ?")
      .all(projectId) as Array<{ workspace_id: string; mode: string; coverage_profile_id: string | null; quarantined: number }>;
    for (const ws of workspaces) {
      entries.push({
        kind: "workspace", id: ws.workspace_id, display_name: ws.workspace_id,
        mode: ws.mode, coverage_profile_id: ws.coverage_profile_id, quarantined: ws.quarantined === 1,
      });
    }
    const policies = this.db.raw
      .prepare("SELECT policy_profile_id, MAX(version) AS version FROM policy_profiles GROUP BY policy_profile_id")
      .all() as Array<{ policy_profile_id: string; version: string }>;
    for (const p of policies) {
      entries.push({ kind: "policy_profile", id: p.policy_profile_id, display_name: p.policy_profile_id, version: p.version });
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

  turnEvents(coordinatorId: string, turnId: string, afterSeq: number, limit: number) {
    this.authorizeTurn(coordinatorId, turnId);
    return listEventsByTurn(this.db, turnId, afterSeq, limit);
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

function namespaceOf(project_id: string, owner: string, op: OperationName, key: string) {
  return {
    project_id,
    owner_coordinator_id: owner,
    operation_name: op,
    idempotency_key: key,
  };
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

export { getSession as _getSession, getTurn as _getTurn };
