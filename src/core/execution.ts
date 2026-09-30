/**
 * TurnExecutor — turn lifecycle runtime side (spec §6.5.2, §6.5.3, §14.3, §14.6).
 *
 * Responsibilities:
 * - ACCEPTED → STARTING with a journaled launch intent,
 * - a serialized dispatch-permission gate: a cancellation accepted before
 *   permission forbids native dispatch entirely (zero inference, §14.6),
 * - durable persistence of the native conversation reference as soon as the
 *   adapter reports it (§13.2, §14.3),
 * - terminal commit / release protocol in ONE metadata transaction (§6.5.3),
 * - UNKNOWN on undefined execution (never fabricated as failed/succeeded).
 */
import type { RegistryDb } from "../storage/db.ts";
import {
  appendEvent,
  getArtifact,
  getCoverageProfile,
  getDaemonState,
  getSession,
  getSnapshotRecord,
  getTurn,
  getTurnEventPayload,
  getSessionInstructions,
  getWorkspace,
  insertArtifact,
  insertBlobRecord,
  insertIntent,
  insertPin,
  listActiveReservationsByOwner,
  listPendingIntents,
  listPinsByOwner,
  releasePin,
  releaseReservation,
  sealArtifact,
  updateIntentState,
  updateSessionFields,
  updateTurnFields,
} from "../storage/repo.ts";
import { BrokerError } from "../shared/errors.ts";
import type { ArtifactKind } from "../shared/api-types.ts";
import { newId, ID_PREFIX, sha256Hex } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type { Limits, SessionRecord, SnapshotManifest, SnapshotRecord, TurnRecord, TurnState } from "../shared/api-types.ts";
import {
  assertSessionTransition,
  assertTurnTransition,
  isNonterminalTurnState,
} from "./transitions.ts";
import type {
  DispatchGate,
  ProviderAdapter,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../runtime/adapter.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import { captureSnapshot, diffManifests, readManifest, type ManifestDelta } from "../snapshots/capture.ts";
import { diffSnapshots, renderDiffDocument } from "../snapshots/diff.ts";
import { CoverageError, matchesPrefix, normalizePrefixList, parsePolicyWriteScope, type CoverageConfig } from "../workspaces/coverage.ts";
import { computeSourceDigest, takeInventory } from "../workspaces/inventory.ts";
import {
  buildTurnInputManifest,
  INLINE_TOTAL_BYTE_CAP,
  InputPlanError,
  planInputDelivery,
  verifyTurnInputManifest,
  type TurnInputManifest,
} from "../inputs/manifest.ts";
import { extensionFor, type InputViewStore } from "../inputs/views.ts";
import type { ReviewSlotStore } from "../workspaces/slot.ts";

/** Raised by the gate when a cancellation was accepted pre-dispatch. */
class DispatchRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`dispatch refused: cancellation accepted (${reason})`);
  }
}

/**
 * Normative FINALIZING entry edge per source state (§6.5.2). `null` means the
 * source state cannot reach FINALIZING for this outcome shape.
 */
function enterFinalizingTrigger(
  from: TurnState,
  outcome: { candidate: string; execution_started: boolean },
): "prestart_failure_known" | "startup_failure_or_fast_completion" | "native_outcome_established" | "shutdown_confirmed" | "reconciliation_outcome" | null {
  switch (from) {
    case "ACCEPTED":
      return "prestart_failure_known";
    case "STARTING":
      return "startup_failure_or_fast_completion";
    case "RUNNING":
      return "native_outcome_established";
    case "CANCELLING":
      return "shutdown_confirmed";
    case "UNKNOWN":
      return "reconciliation_outcome";
    default:
      void outcome;
      return null;
  }
}

interface CancelWatch {
  reason: string | null;
}

export class TurnExecutor {
  private readonly db: RegistryDb;
  private readonly clock: Clock;
  private readonly limits: Limits;
  private readonly adapters: Map<string, ProviderAdapter>;
  private readonly blobs: BlobStore;
  private readonly inputViews: InputViewStore | null;
  private readonly slots: ReviewSlotStore | null;
  private readonly running = new Map<string, Promise<void>>();
  private readonly cancelWatches = new Map<string, CancelWatch>();
  private readonly faultSkipCommitTurns_ = new Set<string>();
  private expectedIncarnation: string | null = null;

  constructor(args: {
    db: RegistryDb;
    clock: Clock;
    limits: Limits;
    adapters: Map<string, ProviderAdapter>;
    blobs: BlobStore;
    inputViews?: InputViewStore | null;
    slots?: ReviewSlotStore | null;
  }) {
    this.db = args.db;
    this.clock = args.clock;
    this.limits = args.limits;
    this.adapters = args.adapters;
    this.blobs = args.blobs;
    this.inputViews = args.inputViews ?? null;
    this.slots = args.slots ?? null;
  }

  /**
   * Attach expected daemon incarnation (§4.1.1).
   * Called once by the bootstrap after ownership.
   */
  attachIncarnation(inc: string): void {
    this.expectedIncarnation = inc;
  }

  async drain(): Promise<void> {
    while (this.running.size > 0) {
      const pending = [...this.running.values()];
      await Promise.all(pending.map((p) => p.catch(() => undefined)));
    }
  }

  /** Wait for one specific turn to settle (tests). */
  async waitTurn(turnId: string): Promise<void> {
    while (this.running.has(turnId)) {
      const p = this.running.get(turnId)!;
      await p.catch(() => undefined);
    }
  }

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Begin the turn lifecycle without waiting for its completion: the promise
   * is tracked in `running` for drain(); callers observe progress via DB
   * state and events (INV-10). The synchronous part runs up to the first
   * adapter await, so the STARTING state and mock barriers are in place
   * when this returns.
   */
  startTurn(turnId: string): void {
    if (this.running.has(turnId)) return;
    const task = this.runTurn(turnId).finally(() => {
      this.running.delete(turnId);
      this.cancelWatches.delete(turnId);
    });
    this.running.set(turnId, task);
    // Prevent unhandled-rejection noise when no one drains; drain() still
    // observes the original task.
    void task.catch(() => undefined);
  }

  private async runTurn(turnId: string): Promise<void> {
    // STARTING with a journaled launch intent (§6.5.2 startup_begin, §14.3).
    const started = this.beginStarting(turnId);
    if (!started) {
      // Cancel may have been accepted while the turn was still ACCEPTED:
      // finalize CANCELLED with journaled no-dispatch evidence (§14.6).
      const t = getTurn(this.db, turnId);
      if (t && t.state === "CANCELLING" && t.execution_started !== true) {
        const s = getSession(this.db, t.session_id);
        if (s) this.finalizeCancelledPreDispatch(t, s, "cancelled");
      }
      return;
    }

    const { session, turn, adapter } = started;
    const watch: CancelWatch = { reason: null };
    this.cancelWatches.set(turnId, watch);

    // §7.2 step 7: re-check the workspace under the lease at STARTING — an
    // external write that landed after the send-time digest preflight must
    // fail the turn BEFORE dispatch (no inference), not be absorbed into
    // this turn's delta.
    if (turn.baseline_snapshot_id && session.workspace_id && session.workspace_mode !== "review_slot") {
      const drift = this.checkBaselineDrift(turn, session);
      if (drift) {
        this.finalizePreStartKnown(turn, session, "WORKSPACE_CHANGED", drift);
        return;
      }
    }

    // §7.2 step 7: re-check cancel/policy under lease before launch.
    const turnNow = getTurn(this.db, turnId);
    if (!turnNow) return;
    if (turnNow.state === "CANCELLING") {
      // Cancel accepted before dispatch permission: no inference at all.
      this.finalizeCancelledPreDispatch(turnNow, session, watch.reason ?? "cancelled");
      return;
    }
    if (turnNow.state !== "STARTING") return; // concurrent transition happened

    // Required input delivery BEFORE dispatch (§7.1.1, §13.2.1): resolve →
    // plan → materialize read-only views → seal the TurnInputManifest. Any
    // failure here is a journaled pre-dispatch failure — inference never
    // starts with a missing required input.
    let envelope = `agent-broker envelope turn=${turnId} session=${session.session_id}`;
    try {
      const prep = this.prepareInputs(turnNow, session);
      envelope = this.buildEnvelope(session, turnNow, prep.manifest);
    } catch (e) {
      const code =
        e instanceof InputPlanError
          ? e.code
          : e instanceof BrokerError
            ? e.code
            : "INPUT_DELIVERY_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      this.finalizePreStartKnown(turnNow, session, code, message);
      return;
    }

    const gate: DispatchGate = {
      acquireDispatchPermission: () => {
        // Serialized with cancellation intents in the same metadata boundary
        // (§14.6): if a cancel was accepted first, refuse dispatch.
        const current = getTurn(this.db, turnId);
        if (!current || current.state === "CANCELLING") {
          throw new DispatchRefusedError(watch.reason ?? "cancelled");
        }
        // Durable dispatch-permission record before native handoff (§14.3).
        const now = this.clock.now();
        this.db.tx(() => {
          if (this.expectedIncarnation !== null) {
            const ds = getDaemonState(this.db);
            if (ds && ds.incarnation !== this.expectedIncarnation) {
              throw new DispatchRefusedError("stale executor incarnation");
            }
          }
          const t = getTurn(this.db, turnId);
          if (!t) throw new Error("turn-vanished");
          if (t.state === "CANCELLING") throw new DispatchRefusedError(watch.reason ?? "cancelled");
          if (t.state !== "STARTING" && t.state !== "RUNNING") {
            throw new DispatchRefusedError(`turn state is ${t.state}`);
          }
          updateTurnFields(this.db, turnId, { execution_started: true }, t.state_version, now);
          appendEvent(this.db, {
            turn_id: turnId,
            session_id: session.session_id,
            type: "dispatch_permission_granted",
            payload: {},
            created_at: now,
          });
        });
      },
      cancellationRequested: () => watch.reason,
    };

    const continuation = session.native_conversation_ref === null && session.context_status === "not_started"
      ? "new_native_conversation"
      : "native_resume";

    const request: TurnExecutionRequest = {
      turn_id: turnId,
      session_id: session.session_id,
      role: session.role,
      provider: session.provider,
      account_profile_id: session.account_profile_id,
      requested_model: session.requested_model,
      requested_effort: session.requested_effort,
      instructions_hash: session.instructions_hash,
      native_conversation_ref: session.native_conversation_ref,
      task_envelope: envelope,
      workspace_mode: session.workspace_mode,
      workspace_path:
        session.workspace_mode === "review_slot"
          ? this.slots?.slotPath(session.session_id) ?? null
          : session.workspace_id
            ? (getWorkspace(this.db, session.workspace_id)?.canonical_path ?? null)
            : null,
      deadline_at: turn.deadline_at ?? 0,
      clock: this.clock,
    };

    let result: TurnExecutionResult | null = null;
    let failure: unknown = null;

    try {
      result = await adapter.executeTurn(request, gate, (ev) => this.onAdapterEvent(turnId, session.session_id, ev));
    } catch (e) {
      failure = e;
    }

    const after = getTurn(this.db, turnId);
    if (!after) return;

    if (failure instanceof DispatchRefusedError) {
      if (after.state !== "UNKNOWN") {
        this.recordOutcomeEvidence(after, {
          native_outcome: "failed",
          termination_hint: "cancelled",
          candidate: "CANCELLED",
          execution_started: false,
          native_conversation_ref: after.native_conversation_ref,
        });
      }
      // Cancel accepted before dispatch: FINALIZING → CANCELLED with
      // execution_started=false (journal proves no dispatch, §14.6).
      this.finalizeCancelledPreDispatch(after, session, watch.reason ?? failure.reason);
      return;
    }

    if (failure !== null) {
      if (failure instanceof BrokerError) {
        // No-dispatch evidence comes from the journal, never from the
        // adapter's self-declaration: only the gate writes
        // execution_started=true (§5.3 evidence integrity).
        const preDispatchStartup = after.execution_started !== true;
        if (!preDispatchStartup && after.state !== "UNKNOWN") {
          const deadlineInterrupt = watch.reason !== null && after.termination_reason === "deadline";
          this.recordOutcomeEvidence(after, {
            native_outcome: "failed",
            termination_hint: deadlineInterrupt ? "deadline" : watch.reason !== null ? "cancelled" : "normal",
            candidate: deadlineInterrupt ? "TIMED_OUT" : watch.reason !== null ? "CANCELLED" : "FAILED",
            execution_started: true,
            native_conversation_ref: after.native_conversation_ref,
          });
        }
        this.finalizeWithFailure(after, session, failure, preDispatchStartup, watch.reason);
        return;
      }
      // Non-contract failure (process crash window, supervisor death):
      // execution outcome UNDEFINED → UNKNOWN, session blocked (§6.5.2).
      this.markUnknown(after, session, failure);
      return;
    }

    if (!result) {
      this.markUnknown(after, session, new Error("adapter resolved without result"));
      return;
    }

    // Preserve bounded native prose before outcome/finalization. Recovery can
    // then expose it through the existing agent_reported result field.
    if (this.expectedIncarnation !== null) {
      const daemonState = getDaemonState(this.db);
      if (daemonState && daemonState.incarnation !== this.expectedIncarnation) return;
    }
    if (result.agent_reported && typeof result.agent_reported.summary === "string" &&
        (result.agent_reported.format_status === "structured" || result.agent_reported.format_status === "text_only")) {
      const report = { ...result.agent_reported, summary: result.agent_reported.summary.slice(0, 4000) };
      const bounded = Buffer.byteLength(JSON.stringify(report), "utf8") <= 64 * 1024
        ? report : { summary: report.summary, format_status: report.format_status };
      appendEvent(this.db, { turn_id: turnId, session_id: session.session_id,
        type: "agent_reported", payload: bounded, created_at: this.clock.now() });
    }

    if (after.state !== "UNKNOWN") {
      const timedOut = after.deadline_at !== null && this.clock.now() > after.deadline_at && watch.reason === "deadline";
      const candidate = result.native_outcome === "completed"
        ? "SUCCEEDED"
        : timedOut
          ? "TIMED_OUT"
          : watch.reason !== null && result.native_outcome === "failed"
            ? "CANCELLED"
            : "FAILED";
      const termination_hint = timedOut
        ? "deadline"
        : watch.reason !== null && result.native_outcome === "failed"
          ? "cancelled"
          : "normal";
      const nativeRef = result.native_conversation_ref !== "" ? result.native_conversation_ref : (after.native_conversation_ref ?? null);

      this.recordOutcomeEvidence(after, {
        native_outcome: result.native_outcome,
        termination_hint,
        candidate,
        execution_started: true,
        native_conversation_ref: nativeRef,
      });
    }

    // Definite native outcome → FINALIZING → terminal (§6.5.2).
    this.finalizeWithOutcome(after, session, result, continuation, watch.reason);
  }

  private recordOutcomeEvidence(
    turn: TurnRecord,
    outcome: {
      native_outcome: "completed" | "failed";
      termination_hint: "normal" | "cancelled" | "deadline" | null;
      candidate: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
      execution_started: boolean;
      native_conversation_ref: string | null;
    },
  ): void {
    if (this.expectedIncarnation !== null) {
      const ds = getDaemonState(this.db);
      if (ds && ds.incarnation !== this.expectedIncarnation) return;
    }
    const now = this.clock.now();
    this.db.raw
      .prepare(
        `INSERT OR IGNORE INTO turn_outcome_evidence (
          turn_id,
          native_outcome,
          termination_hint,
          candidate,
          execution_started,
          native_conversation_ref,
          recorded_at,
          incarnation,
          applied
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        turn.turn_id,
        outcome.native_outcome,
        outcome.termination_hint,
        outcome.candidate,
        outcome.execution_started ? 1 : 0,
        outcome.native_conversation_ref,
        now,
        this.expectedIncarnation ?? "unattached",
      );
  }

  // ─── required input delivery (§7.1.1, §5.6, §13.2.1) ───────────────────────

  /** Content-type mapping for delivery channels (default profile, §7.1.1). */
  private static contentTypeForArtifact(kind: ArtifactKind): string {
    switch (kind) {
      case "findings":
      case "report":
      case "patch":
      case "normalized_events":
      case "result_capsule":
        return "text/plain";
      case "input_manifest":
      case "source_inventory":
        return "application/json";
      case "snapshot_manifest":
        return "application/x-snapshot-tree-manifest";
      default:
        // snapshot_content: arbitrary binary — no tested channel in the
        // default profile → INPUT_UNSUPPORTED at planning time.
        return "application/octet-stream";
    }
  }

  /**
   * Resolve required artifacts, plan delivery (deterministic channel
   * selection), materialize read-only views, and seal the TurnInputManifest
   * — all BEFORE dispatch permission. Returns the manifest for the envelope.
   */
  private prepareInputs(turn: TurnRecord, session: SessionRecord): { manifest: TurnInputManifest } {
    const projectId = session.project_id;
    const now = this.clock.now();

    const inputs: Array<{
      origin: "task_artifact" | "review_baseline" | "review_diff";
      artifact: import("../shared/api-types.ts").ArtifactRecord;
      content_type: string;
      inlineCandidate: Uint8Array | null;
      allowMaterialization: boolean;
    }> = turn.task_artifact_refs.map((artifactId) => {
      const artifact = getArtifact(this.db, artifactId);
      if (!artifact || artifact.project_id !== projectId) {
        // §7.1.1: unknown/disallowed id → UNAUTHORIZED without disclosure.
        throw new BrokerError("UNAUTHORIZED", "Access denied for this resource.");
      }
      if (artifact.state === "expired") {
        throw new BrokerError("ARTIFACT_EXPIRED", `Required artifact ${artifactId} has expired.`);
      }
      if (artifact.state !== "sealed" || !artifact.content_hash || artifact.size_bytes === null) {
        throw new BrokerError("ARTIFACT_NOT_READY", `Required artifact ${artifactId} is not sealed.`);
      }
      let inlineCandidate: Uint8Array | null = null;
      if (artifact.size_bytes <= INLINE_TOTAL_BYTE_CAP) {
        try {
          inlineCandidate = this.blobs.read(projectId, artifact.content_hash);
        } catch {
          throw new BrokerError("ARTIFACT_CORRUPT", `Required artifact ${artifactId} content is missing.`);
        }
      }
      return {
        origin: "task_artifact" as const,
        artifact,
        content_type: TurnExecutor.contentTypeForArtifact(artifact.kind),
        inlineCandidate,
        allowMaterialization: true,
      };
    });

    // Broker-derived review inputs (§7.1.1): for a review turn, derive the
    // baseline→target diff NOW (after acceptance, before dispatch) and
    // deliver it plus the baseline tree manifest as REQUIRED inputs — the
    // reviewer never reviews a moving checkout (INV-07).
    if (turn.review_target_snapshot_id && turn.baseline_snapshot_id) {
      // Fail-closed: a reviewer turn without a slot store would silently
      // dispatch with no target source - refuse before inference.
      if (!this.slots) {
        throw new BrokerError("INVALID_REQUEST", "Review slot store is not configured.");
      }
      const baselineRecord = getSnapshotRecord(this.db, turn.baseline_snapshot_id);
      const targetRecord = getSnapshotRecord(this.db, turn.review_target_snapshot_id);
      if (!baselineRecord || baselineRecord.state !== "SEALED" || !targetRecord || targetRecord.state !== "SEALED") {
        throw new BrokerError("ARTIFACT_NOT_READY", "Review baseline/target snapshot is not sealed.");
      }
      const baselineManifest = readManifest({ db: this.db, blobs: this.blobs, projectId, snapshot: baselineRecord });
      const targetManifest = readManifest({ db: this.db, blobs: this.blobs, projectId, snapshot: targetRecord });
      const diff = diffSnapshots(baselineManifest, targetManifest, (hash) => {
        try {
          return this.blobs.read(projectId, hash);
        } catch {
          return null;
        }
      });
      const diffDoc = renderDiffDocument(diff, 256 * 1024);

      // §9.3 stable review slot: refresh the broker-owned slot to exactly the
      // TARGET tree between quiescent turns (this turn is not dispatched yet,
      // the previous one is terminal). Stale files are cleared ONLY inside
      // the slot — never in a worker checkout.
      if (this.slots) {
        try {
          this.slots.refresh(session.session_id, targetManifest, (hash) => this.blobs.read(projectId, hash));
        } catch (err) {
          throw new BrokerError("EVIDENCE_CAPTURE_FAILED", `Review slot refresh failed: ${String(err)}`);
        }
      }

      const now2 = this.clock.now();
      const diffBlob = this.blobs.write(projectId, diffDoc);
      insertBlobRecord(this.db, {
        project_id: projectId,
        content_hash: diffBlob.hash,
        size_bytes: diffBlob.size,
        created_at: now2,
      });
      const diffArtifactId = newId("art");
      insertArtifact(this.db, {
        artifact_id: diffArtifactId,
        project_id: projectId,
        kind: "patch",
        content_hash: null,
        size_bytes: null,
        state: "staging",
        created_at: now2,
        sealed_at: null,
        expired_at: null,
      });
      sealArtifact(this.db, diffArtifactId, diffBlob.hash, diffBlob.size, now2);
      insertPin(this.db, {
        pin_id: newId("pin"),
        artifact_id: diffArtifactId,
        root_kind: "active_turn",
        owner_session_id: session.session_id,
        owner_turn_id: turn.turn_id,
        created_at: now2,
      });

      const baselineArtifact = getArtifact(this.db, baselineRecord.manifest_artifact_id);
      if (!baselineArtifact || baselineArtifact.state === "expired") {
        throw new BrokerError("ARTIFACT_EXPIRED", "Review baseline manifest artifact has expired.");
      }
      if (baselineArtifact.state !== "sealed" || !baselineArtifact.content_hash) {
        throw new BrokerError("ARTIFACT_NOT_READY", "Review baseline manifest artifact is not sealed.");
      }
      let baselineInline: Uint8Array | null = null;
      if (baselineArtifact.size_bytes !== null && baselineArtifact.size_bytes <= INLINE_TOTAL_BYTE_CAP) {
        baselineInline = this.blobs.read(projectId, baselineArtifact.content_hash);
      }
      inputs.push({
        origin: "review_baseline",
        artifact: baselineArtifact,
        content_type: "application/x-snapshot-tree-manifest",
        inlineCandidate: baselineInline,
        allowMaterialization: true,
      });
      inputs.push({
        origin: "review_diff",
        artifact: {
          artifact_id: diffArtifactId,
          project_id: projectId,
          kind: "patch",
          content_hash: diffBlob.hash,
          size_bytes: diffBlob.size,
          state: "sealed",
          created_at: now2,
          sealed_at: now2,
          expired_at: null,
        },
        content_type: "text/plain",
        inlineCandidate: diffDoc.length <= INLINE_TOTAL_BYTE_CAP ? Buffer.from(diffDoc, "utf8") : null,
        allowMaterialization: true,
      });
    }

    const planned = planInputDelivery({ inputs });
    const turnRoot = this.inputViews ? this.inputViews.turnRoot(turn.turn_id) : "";
    const contentTypeById = new Map(inputs.map((i) => [i.artifact.artifact_id, i.content_type]));
    const plannedFull = planned.map((p) => ({
      input_id: p.input_id,
      origin: p.origin,
      artifact: p.artifact,
      content_type: contentTypeById.get(p.artifact.artifact_id) ?? "text/plain",
      delivery: p.delivery,
      inlineContent: p.inlineContent,
      readOnlyPath:
        p.delivery === "read_only_path" && this.inputViews
          ? `${turnRoot}/${p.input_id}${extensionFor(contentTypeById.get(p.artifact.artifact_id) ?? "text/plain")}`
          : null,
    }));

    const workspace_binding =
      session.workspace_mode === "review_slot"
        ? { review: { baseline_snapshot_id: turn.baseline_snapshot_id ?? "", target_snapshot_id: turn.review_target_snapshot_id ?? "" } }
        : { workspace_id: session.workspace_id, expected_snapshot_id: turn.baseline_snapshot_id };

    const manifest = buildTurnInputManifest({
      turn_id: turn.turn_id,
      session_id: session.session_id,
      policy_profile_id: session.policy_profile_id,
      policy_profile_version: session.policy_profile_version,
      workspace_binding,
      planned: plannedFull,
      now,
    });

    const violations = verifyTurnInputManifest(manifest);
    if (violations.length > 0) {
      throw new BrokerError("INPUT_DELIVERY_FAILED", `Input manifest invalid: ${violations[0]}`);
    }

    // Materialize read-only views (copies, never aliases — §9.2, §12.6).
    if (this.inputViews && manifest.inputs.some((i) => i.delivery === "read_only_path")) {
      this.inputViews.materialize(manifest, (hash) => this.blobs.read(projectId, hash));
    }

    // Publish the sealed manifest as a durable artifact with a journaled
    // input_publication intent (§14.3: sealed before task dispatch).
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const manifestBlob = this.blobs.write(projectId, manifestBytes);
    insertBlobRecord(this.db, {
      project_id: projectId,
      content_hash: manifestBlob.hash,
      size_bytes: manifestBlob.size,
      created_at: now,
    });
    const artifactId = newId("art");
    const intentId = newId("intent");
    insertArtifact(this.db, {
      artifact_id: artifactId,
      project_id: projectId,
      kind: "input_manifest",
      content_hash: null,
      size_bytes: null,
      state: "staging",
      created_at: now,
      sealed_at: null,
      expired_at: null,
    });
    insertIntent(this.db, {
      intent_id: intentId,
      kind: "input_publication",
      session_id: session.session_id,
      turn_id: turn.turn_id,
      state: "pending",
      payload: JSON.stringify({ inputs: manifest.inputs.length, manifest_artifact_id: artifactId }),
      created_at: now,
      updated_at: now,
    });
    sealArtifact(this.db, artifactId, manifestBlob.hash, manifestBlob.size, now);
    insertPin(this.db, {
      pin_id: newId("pin"),
      artifact_id: artifactId,
      root_kind: "active_turn",
      owner_session_id: session.session_id,
      owner_turn_id: turn.turn_id,
      created_at: now,
    });
    this.db.tx(() => {
      const t = getTurn(this.db, turn.turn_id);
      if (t) {
        updateTurnFields(this.db, turn.turn_id, { input_manifest_id: artifactId }, t.state_version, now);
      }
      updateIntentState(this.db, intentId, "completed", now);
    });
    appendEvent(this.db, {
      turn_id: turn.turn_id,
      session_id: session.session_id,
      type: "input_manifest_sealed",
      payload: { artifact_id: artifactId, inputs: manifest.inputs.length },
      created_at: now,
    });
    return { manifest };
  }

  /**
   * Deterministic context envelope (§7.1): session/turn binding, workspace
   * precondition, and clearly-delimited REQUIRED INPUT sections — inline
   * data inline (within the shared budget), path inputs as exact locations.
   */
  private buildEnvelope(session: SessionRecord, turn: TurnRecord, manifest: TurnInputManifest): string {
    const instructions = getSessionInstructions(this.db, session.session_id);
    const task = getTurnEventPayload(this.db, turn.turn_id, "turn_admitted")?.task as Record<string, unknown> | undefined;
    if (instructions === null || sha256Hex(instructions) !== session.instructions_hash ||
        !task || typeof task.goal !== "string" || sha256Hex(task.goal) !== turn.task_goal_hash) {
      throw new BrokerError("INPUT_DELIVERY_FAILED", "Persisted session instructions or task contract is missing or inconsistent.");
    }
    const lines: string[] = [
      "agent-broker context envelope (deterministic, broker-generated)",
      `turn=${turn.turn_id} session=${session.session_id} role=${session.role}`,
      `workspace=${session.workspace_id ?? "none"} baseline_snapshot=${turn.baseline_snapshot_id ?? "none"}`,
      "[session instructions]", instructions, "[/session instructions]",
      "[task contract JSON]", JSON.stringify(task), "[/task contract JSON]",
      // §9.3: the prompt states which snapshot replaced the previous code.
      ...(turn.review_target_snapshot_id
        ? [`review_target_snapshot=${turn.review_target_snapshot_id} (this replaced the previous code in your cwd)`]
        : []),
      manifest.inputs.length > 0
        ? `required inputs (${manifest.inputs.length}) — every input below is required:`
        : "required inputs: none",
    ];
    for (const entry of manifest.inputs) {
      if (entry.delivery === "inline") {
        const bytes = this.blobs.read(session.project_id, entry.content_hash);
        lines.push(`[input ${entry.input_id} ${entry.content_type} sha256=${entry.content_hash}]`);
        lines.push(Buffer.from(bytes).toString("utf8"));
        lines.push(`[/input ${entry.input_id}]`);
      } else {
        lines.push(
          `[input ${entry.input_id} ${entry.content_type} sha256=${entry.content_hash} read_only_path=${entry.binding}]`,
        );
      }
    }
    lines.push("instruction: re-read changed files before editing; do not modify input views.");
    return lines.join("\n");
  }

  // ─── phases ────────────────────────────────────────────────────────────────

  private beginStarting(turnId: string): { session: SessionRecord; turn: TurnRecord; adapter: ProviderAdapter } | null {
    try {
      const out = this.db.tx((): { session: SessionRecord; turn: TurnRecord; adapter: ProviderAdapter } | null => {
        const turn = getTurn(this.db, turnId);
        if (!turn) throw new Error("turn-vanished");
        const session = getSession(this.db, turn.session_id);
        if (!session) throw new Error("session-vanished");
        const adapter = this.adapters.get(session.provider);
        if (!adapter) {
          throw new BrokerError("PROVIDER_INCOMPATIBLE", `Adapter missing for provider '${session.provider}'.`);
        }
        if (turn.state === "CANCELLING") return null; // handled by caller
        if (turn.state !== "ACCEPTED") return null; // already started elsewhere
        assertTurnTransition(turn.state, "startup_begin");
        const now = this.clock.now();
        insertIntent(this.db, {
          intent_id: newId(ID_PREFIX.intent),
          kind: "launch_turn",
          session_id: session.session_id,
          turn_id: turnId,
          state: "pending",
          payload: JSON.stringify({ continuation: session.native_conversation_ref === null ? "new" : "resume" }),
          created_at: now,
          updated_at: now,
        });
        updateTurnFields(this.db, turnId, { state: "STARTING" }, turn.state_version, now);
        appendEvent(this.db, {
          turn_id: turnId,
          session_id: session.session_id,
          type: "turn_starting",
          payload: {},
          created_at: now,
        });
        const updated = getTurn(this.db, turnId);
        if (!updated) return null;
        return { session, turn: updated, adapter };
      });
      return out;
    } catch (e) {
      if (e instanceof BrokerError) {
        // Known pre-start failure: task never dispatched (§6.5.2).
        const turn = getTurn(this.db, turnId);
        const session = turn ? getSession(this.db, turn.session_id) : null;
        if (turn && session) {
          this.finalizePreStartFailure(turn, session, e);
        }
        return null;
      }
      throw e;
    }
  }

  private onAdapterEvent(turnId: string, sessionId: string, ev: { type: string; payload?: Record<string, unknown> }): void {
    const now = this.clock.now();
    this.db.tx(() => {
      if (this.expectedIncarnation !== null) {
        const daemonState = getDaemonState(this.db);
        if (daemonState && daemonState.incarnation !== this.expectedIncarnation) {
          appendEvent(this.db, {
            turn_id: turnId,
            session_id: sessionId,
            type: "stale_write_rejected",
            payload: { executor_incarnation: this.expectedIncarnation },
            created_at: now,
          });
          return;
        }
      }
      appendEvent(this.db, {
        turn_id: turnId,
        session_id: sessionId,
        type: `adapter:${ev.type}`,
        payload: ev.payload ?? {},
        created_at: now,
      });
      if (ev.type === "native_ref_obtained" && ev.payload && typeof ev.payload.ref === "string") {
        // Persist the native reference ASAP (§13.2, §14.3).
        const turn = getTurn(this.db, turnId);
        if (turn) {
          updateTurnFields(this.db, turnId, { native_conversation_ref: ev.payload.ref }, turn.state_version, now);
        }
        const session = getSession(this.db, sessionId);
        if (session && session.native_conversation_ref === null) {
          updateSessionFields(
            this.db,
            sessionId,
            { native_conversation_ref: ev.payload.ref, context_status: "available" },
            session.record_version,
            now,
          );
        }
      }
      // First NATIVE evidence confirms dispatch → RUNNING (§6.5.2). Gate on
      // the journaled dispatch permission, not on any adapter chatter.
      const turn = getTurn(this.db, turnId);
      if (turn && turn.state === "STARTING" && turn.execution_started === true) {
        assertTurnTransition("STARTING", "dispatch_confirmed");
        updateTurnFields(this.db, turnId, { state: "RUNNING" }, turn.state_version, now);
        appendEvent(this.db, {
          turn_id: turnId,
          session_id: sessionId,
          type: "turn_running",
          payload: {},
          created_at: now,
        });
      }
    });
  }

  // ─── terminal paths ────────────────────────────────────────────────────────

  private finalizeCancelledPreDispatch(turn: TurnRecord, session: SessionRecord, reason: string): void {
    this.commitTerminal(turn, session, {
      candidate: "CANCELLED",
      native_outcome: null,
      termination_reason: "cancelled",
      execution_started: false,
      finalization_error: null,
      error_code: null,
      detail: { reason },
    });
  }

  private finalizePreStartFailure(turn: TurnRecord, session: SessionRecord, error: BrokerError): void {
    this.finalizePreStartKnown(turn, session, error.code, error.message);
  }

  /** Known pre-dispatch failure with journaled no-dispatch evidence. */
  private finalizePreStartKnown(turn: TurnRecord, session: SessionRecord, code: string, message: string): void {
    this.commitTerminal(turn, session, {
      candidate: "FAILED",
      native_outcome: "failed",
      termination_reason: "startup_failure",
      execution_started: false,
      finalization_error: null,
      error_code: code,
      detail: { message },
    });
  }

  /**
   * Returns a drift description when the live workspace digest no longer
   * matches the turn's baseline snapshot (§8.2), or null when it matches.
   */
  private checkBaselineDrift(turn: TurnRecord, session: SessionRecord): string | null {
    const baseline = getSnapshotRecord(this.db, turn.baseline_snapshot_id!);
    if (!baseline || baseline.state !== "SEALED") {
      return "baseline snapshot is not sealed";
    }
    const workspace = getWorkspace(this.db, session.workspace_id!);
    if (!workspace?.canonical_path) return "workspace path unresolvable";
    const profile = getCoverageProfile(this.db, session.coverage_profile_id!, session.coverage_profile_version!);
    if (!profile) return "coverage profile missing";
    const config = JSON.parse(profile.config) as CoverageConfig;
    const inventory = takeInventory(workspace.canonical_path, config);
    const digest = computeSourceDigest(inventory.entries, {
      profile_id: profile.coverage_profile_id,
      version: profile.version,
      contract_hash: profile.contract_hash,
    });
    if (digest !== baseline.source_digest) {
      return "workspace source state changed since the expected snapshot (§8.2)";
    }
    return null;
  }

  private finalizeWithFailure(
    turn: TurnRecord,
    session: SessionRecord,
    error: BrokerError,
    preDispatchStartup: boolean,
    cancelReason: string | null,
  ): void {
    // §14.6: a durably recorded deadline reason survives finalization — the
    // final status may be TIMED_OUT, not CANCELLED, and the reason is kept.
    const deadlineInterrupt = cancelReason !== null && turn.termination_reason === "deadline";
    this.commitTerminal(turn, session, {
      candidate: deadlineInterrupt ? "TIMED_OUT" : cancelReason !== null ? "CANCELLED" : "FAILED",
      native_outcome: "failed",
      termination_reason: deadlineInterrupt ? "deadline" : cancelReason !== null ? "cancelled" : preDispatchStartup ? "startup_failure" : "normal",
      execution_started: preDispatchStartup ? false : true,
      finalization_error: null,
      error_code: cancelReason !== null ? null : error.code,
      detail: { message: error.message, cancel_reason: cancelReason },
    });
  }

  private finalizeWithOutcome(
    turn: TurnRecord,
    session: SessionRecord,
    result: TurnExecutionResult,
    continuation: "new_native_conversation" | "native_resume",
    cancelReason: string | null,
  ): void {
    // §14.6: a completion that verifiably happened stands, even with a late
    // cancel request; the cancellation stays in the audit trail.
    const timedOut = turn.deadline_at !== null && this.clock.now() > turn.deadline_at && cancelReason === "deadline";

    // Final evidence capture for writer turns (§9.2): a SUCCEEDED candidate
    // requires a sealed final snapshot + complete observed delta + scope
    // check. A known capture/scope failure is a finalization failure — the
    // native outcome is preserved separately (§5.3).
    const isWriter = session.workspace_id !== null && session.workspace_mode !== "review_slot";
    let finalSnapshotId: string | null = null;
    let delta: ManifestDelta | null = null;
    let evidenceError: CoverageError | null = null;

    if (isWriter && result.native_outcome === "completed") {
      try {
        const captured = this.finalCapture(turn, session);
        finalSnapshotId = captured.snapshot.snapshot_id;
        delta = captured.delta;
      } catch (e) {
        if (e instanceof CoverageError) {
          evidenceError = e;
        } else {
          evidenceError = new CoverageError(String(e), "EVIDENCE_CAPTURE_FAILED");
        }
      }
    }

    if (evidenceError) {
      this.commitTerminal(turn, session, {
        candidate: "FAILED",
        native_outcome: result.native_outcome,
        termination_reason: timedOut ? "deadline" : cancelReason !== null && result.native_outcome === "failed" ? "cancelled" : "normal",
        execution_started: true,
        finalization_error: `${evidenceError.code}: ${evidenceError.message}`,
        error_code: evidenceError.code,
        detail: { malformed: result.malformed === true, cancel_reason: cancelReason, final_snapshot_id: null },
      }, continuation, result.native_conversation_ref !== "" ? result.native_conversation_ref : undefined);
      return;
    }

    this.commitTerminal(turn, session, {
      candidate: result.native_outcome === "completed" ? "SUCCEEDED" : timedOut ? "TIMED_OUT" : cancelReason !== null && result.native_outcome === "failed" ? "CANCELLED" : "FAILED",
      native_outcome: result.native_outcome,
      termination_reason: timedOut ? "deadline" : cancelReason !== null && result.native_outcome === "failed" ? "cancelled" : "normal",
      execution_started: true,
      finalization_error: null,
      error_code: null,
      detail: {
        malformed: result.malformed === true,
        cancel_reason: cancelReason,
        observed_workspace_delta: delta ? { added: delta.added, modified: delta.modified, deleted: delta.deleted } : null,
      },
    }, continuation, result.native_conversation_ref !== "" ? result.native_conversation_ref : undefined, finalSnapshotId);
  }

  /**
   * Final writer snapshot under the turn's workspace lease (§9.2): capture,
   * diff against the baseline manifest, and enforce scope policy (§8.7) —
   * every source change must be inside the policy write scope, and no new
   * files may appear in undeclared/protected areas.
   */
  private finalCapture(turn: TurnRecord, session: SessionRecord): { snapshot: SnapshotRecord; delta: ManifestDelta } {
    const workspace = session.workspace_id ? getWorkspace(this.db, session.workspace_id) : null;
    if (!workspace || !workspace.canonical_path) {
      throw new CoverageError("Writer session has no resolvable workspace path", "EVIDENCE_CAPTURE_FAILED");
    }
    if (!session.coverage_profile_id || !session.coverage_profile_version || !session.coverage_contract_hash) {
      throw new CoverageError("Session has no coverage binding", "SNAPSHOT_COVERAGE_MISMATCH");
    }
    const profile = getCoverageProfile(this.db, session.coverage_profile_id, session.coverage_profile_version);
    if (!profile) {
      throw new CoverageError("Coverage profile not found", "SNAPSHOT_COVERAGE_MISMATCH");
    }
    const config = JSON.parse(profile.config) as CoverageConfig;
    const coverage = {
      profile_id: profile.coverage_profile_id,
      version: profile.version,
      contract_hash: profile.contract_hash,
      config,
    };

    const captured = captureSnapshot({
      db: this.db,
      blobs: this.blobs,
      clock: this.clock,
      projectId: session.project_id,
      workspaceId: workspace.workspace_id,
      workspaceRoot: workspace.canonical_path,
      coverage,
    });

    if (!turn.baseline_snapshot_id) {
      throw new CoverageError("Writer turn has no baseline snapshot", "EVIDENCE_CAPTURE_FAILED");
    }
    const baselineRecord = getSnapshotRecord(this.db, turn.baseline_snapshot_id);
    if (!baselineRecord || baselineRecord.state !== "SEALED") {
      throw new CoverageError("Baseline snapshot is not sealed", "EVIDENCE_CAPTURE_FAILED");
    }
    const baselineManifest = readManifest({
      db: this.db,
      blobs: this.blobs,
      projectId: session.project_id,
      snapshot: baselineRecord,
    });
    const delta = diffManifests(baselineManifest, captured.manifest);

    // Scope enforcement (§8.5, §8.7): post-detection for write scopes in P2;
    // a violation fails the turn with evidence, no rollback is attempted.
    // Fail-closed: an unreadable policy profile cannot silently disable the
    // check, and a policy without a declared write scope permits no writes.
    const scope = this.policyWriteScope(session);
    if (scope.kind === "invalid") {
      throw new CoverageError("Policy write scope invalid: " + scope.reason, "EVIDENCE_CAPTURE_FAILED");
    }
    const writeScope = scope.kind === "declared" ? scope.prefixes : []; // absent → nothing permitted
    const changed = [...delta.added, ...delta.modified, ...delta.deleted];
    const outsideScope = changed.filter((p) => !writeScope.some((prefix) => matchesPrefix(p, prefix)));
    if (outsideScope.length > 0) {
      throw new CoverageError(
        `Source changes outside policy write scope: ${outsideScope.slice(0, 10).join(", ")}`,
        "SCOPE_VIOLATION",
      );
    }
    const baselineProtected = new Set(baselineManifest.protected_observed);
    const newProtected = captured.manifest.protected_observed.filter((p) => !baselineProtected.has(p));
    if (newProtected.length > 0) {
      throw new CoverageError(
        `Writes into undeclared/protected paths: ${newProtected.slice(0, 10).join(", ")}`,
        "SCOPE_VIOLATION",
      );
    }
    // Git metadata and broker state are protected areas too (§8.7): a new
    // top-level entry inside an excluded subtree (e.g. .git) is a violation.
    const baselineExcluded = new Set(baselineManifest.excluded_observed ?? []);
    const newExcluded = (captured.manifest.excluded_observed ?? []).filter((p) => !baselineExcluded.has(p));
    if (newExcluded.length > 0) {
      throw new CoverageError(
        `Writes into excluded/protected subtrees: ${newExcluded.slice(0, 10).join(", ")}`,
        "SCOPE_VIOLATION",
      );
    }
    return { snapshot: captured.snapshot, delta };
  }

  private policyWriteScope(session: SessionRecord): { kind: "declared"; prefixes: string[] } | { kind: "absent" } | { kind: "invalid"; reason: string } {
    const row = this.db.raw
      .prepare("SELECT config FROM policy_profiles WHERE policy_profile_id = ? AND version = ?")
      .get(session.policy_profile_id, session.policy_profile_version) as { config: string } | undefined;
    if (!row) return { kind: "invalid", reason: "policy profile not found" };
    return parsePolicyWriteScope(row.config);
  }

  private markUnknown(turn: TurnRecord, session: SessionRecord, cause: unknown): void {
    const now = this.clock.now();
    this.db.tx(() => {
      const t = getTurn(this.db, turn.turn_id);
      if (!t || !isNonterminalTurnState(t.state) || t.state === "UNKNOWN") return;
      assertTurnTransition(t.state, "execution_unknown");
      updateTurnFields(this.db, turn.turn_id, { state: "UNKNOWN", native_outcome: "unknown" }, t.state_version, now);
      const s = getSession(this.db, session.session_id);
      if (s && s.state === "ACTIVE") {
        assertSessionTransition(s.state, "turn_unknown");
        updateSessionFields(
          this.db,
          s.session_id,
          { state: "BLOCKED", block_reason: "execution-unknown" },
          s.record_version,
          now,
        );
      }
      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "turn_unknown",
        payload: { cause: String(cause) },
        created_at: now,
      });
    });
  }

  /**
   * Single terminal commit / release protocol (§6.5.3): terminal state, active
   * turn ref removal, reservation release and next session state — all in one
   * metadata transaction. Workspace lease frees only when no owned execution
   * can still write (P1: adapter promise settled before this runs).
   */
  private commitTerminal(
    turn: TurnRecord,
    session: SessionRecord,
    outcome: {
      candidate: Exclude<TurnState, "UNKNOWN">;
      native_outcome: "completed" | "failed" | null;
      termination_reason: "normal" | "cancelled" | "deadline" | "abandoned" | "startup_failure" | "input_delivery_failure" | null;
      execution_started: boolean;
      finalization_error: string | null;
      error_code: string | null;
      detail: Record<string, unknown>;
    },
    continuation?: "new_native_conversation" | "native_resume",
    nativeRef?: string,
    finalSnapshotId?: string | null,
  ): void {
    if (this.faultSkipCommitTurns_.has(turn.turn_id)) {
      return;
    }
    const now = this.clock.now();
    let committed = false;
    this.db.tx(() => {
      if (this.expectedIncarnation !== null) {
        const daemonState = getDaemonState(this.db);
        if (daemonState && daemonState.incarnation !== this.expectedIncarnation) {
          appendEvent(this.db, {
            turn_id: turn.turn_id,
            session_id: session.session_id,
            type: "stale_write_rejected",
            payload: { executor_incarnation: this.expectedIncarnation },
            created_at: now,
          });
          return;
        }
      }
      const t = getTurn(this.db, turn.turn_id);
      if (!t) throw new Error("turn-vanished");
      if (!isNonterminalTurnState(t.state) || t.state === "UNKNOWN") {
        // Late terminal event after a committed terminal: audit only (§6.5.2).
        appendEvent(this.db, {
          turn_id: turn.turn_id,
          session_id: session.session_id,
          type: "late_terminal_ignored",
          payload: { candidate: outcome.candidate, observed_state: t.state },
          created_at: now,
        });
        return;
      }
      // FINALIZING is mandatory before any terminal state (§6.2): encode the
      // normative entry edge from §6.5.2, then FINALIZING → terminal.
      if (t.state !== "FINALIZING") {
        const enterTrigger = enterFinalizingTrigger(t.state, outcome);
        if (enterTrigger) assertTurnTransition(t.state, enterTrigger);
        assertTurnTransition("FINALIZING", "finalization_checks_done");
      } else {
        assertTurnTransition("FINALIZING", "finalization_checks_done");
      }

      const continuationValue =
        continuation ?? (t.native_conversation_ref !== null ? "native_resume" : null);

      updateTurnFields(this.db, turn.turn_id, {
        state: outcome.candidate,
        terminal_candidate: outcome.candidate,
        native_outcome: outcome.native_outcome,
        termination_reason: outcome.termination_reason,
        finalization_error: outcome.finalization_error,
        execution_started: outcome.execution_started,
        error_code: outcome.error_code,
        terminal_at: now,
        continuation: continuationValue,
        native_conversation_ref: nativeRef ?? t.native_conversation_ref,
        final_snapshot_id: finalSnapshotId ?? null,
      }, t.state_version, now);

      // Latest-anchor pin transfer (§15.3.1): the initial baseline stays
      // pinned until close; the previous "latest" pin is atomically replaced
      // by the new sealed final snapshot's manifest.
      if (finalSnapshotId) {
        const sPins = getSession(this.db, session.session_id);
        const finalRecord = getSnapshotRecord(this.db, finalSnapshotId);
        const initialArtifactId = sPins?.initial_snapshot_id
          ? (getSnapshotRecord(this.db, sPins.initial_snapshot_id)?.manifest_artifact_id ?? null)
          : null;
        for (const pin of listPinsByOwner(this.db, session.session_id)) {
          if (pin.root_kind === "session_anchor" && pin.artifact_id !== initialArtifactId) {
            releasePin(this.db, pin.pin_id);
          }
        }
        if (finalRecord) {
          insertPin(this.db, {
            pin_id: newId("pin"),
            artifact_id: finalRecord.manifest_artifact_id,
            root_kind: "session_anchor",
            owner_session_id: session.session_id,
            owner_turn_id: turn.turn_id,
            created_at: now,
          });
        }
      }

      // Release turn-owned reservations exactly once, complete this turn's
      // journaled launch intent (§14.7), and drop its accepted-turn pins
      // (§15.3.1: latest/session roots re-pin what must survive).
      for (const res of listActiveReservationsByOwner(this.db, turn.turn_id)) {
        releaseReservation(this.db, res.reservation_id, now);
      }
      for (const pin of listPinsByOwner(this.db, turn.turn_id)) {
        if (pin.root_kind === "active_turn") releasePin(this.db, pin.pin_id);
      }
      for (const intent of listPendingIntents(this.db)) {
        if (intent.turn_id === turn.turn_id && intent.kind === "launch_turn") {
          updateIntentState(this.db, intent.intent_id, "completed", now);
        }
      }

      // Session next state (§6.5.1 terminal_turn_committed_*). "context
      // usable" is judged on the SESSION's own context (available, or
      // not_started when execution definitely never started) — a pre-dispatch
      // CANCELLED turn must not discard an already-established native
      // conversation, but a dispatched turn without an available native ref
      // makes reuse unsafe (spec §6.5.1, INV-05).
      const s = getSession(this.db, session.session_id);
      if (s) {
        if (s.state === "ACTIVE") {
          const contextUsable =
            (s.native_conversation_ref !== null && s.context_status === "available") ||
            (s.context_status === "not_started" && outcome.execution_started === false);
          // A failed native resume invalidates the recorded context (§14.2):
          // never silently fall back to a fresh conversation (INV-05).
          const resumeBroken = outcome.error_code === "SESSION_NOT_RESUMABLE" && s.context_status === "available";
          if (resumeBroken) {
            this.db.raw
              .prepare("UPDATE sessions SET context_status = 'unverified' WHERE session_id = ?")
              .run(s.session_id);
          }
          const reusable = contextUsable && !resumeBroken && s.close_state !== "pending";
          const trigger = reusable ? "terminal_turn_committed_reusable" : "terminal_turn_committed_unsafe";
          assertSessionTransition(s.state, trigger);
          updateSessionFields(
            this.db,
            s.session_id,
            reusable
              ? { state: "IDLE", active_turn_id: null }
              : { state: "BLOCKED", active_turn_id: null, block_reason: resumeBroken ? "session-not-resumable" : "reuse-unsafe" },
            s.record_version,
            now,
          );
        }
      }

      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "turn_terminal",
        payload: { state: outcome.candidate, ...outcome.detail },
        created_at: now,
      });
      this.db.raw.prepare("UPDATE turn_outcome_evidence SET applied = 1 WHERE turn_id = ?").run(turn.turn_id);
      committed = true;
    });

    // §7.1.1 lifetime: read grants for per-turn input views are removed only
    // after a CONFIRMED terminal commit (quiescence). A late outcome on an
    // UNKNOWN turn bails out of the tx as audit-only — views and pins must
    // survive until reconciliation (§14.5).
    if (committed && this.inputViews) {
      try {
        this.inputViews.cleanup(turn.turn_id);
        appendEvent(this.db, {
          turn_id: turn.turn_id,
          session_id: session.session_id,
          type: "input_views_released",
          payload: {},
          created_at: this.clock.now(),
        });
      } catch {
        /* best-effort cleanup; leftovers are journaled via the intent log */
      }
    }
  }

  /**
   * Reconcile durable outcome evidence for nonterminal turns (spec §14.3, §18 A19).
   * Finishes sealing/finalizing without dispatching new inference.
   */
  async reconcileJournaledOutcomes(): Promise<void> {
    const rows = this.db.raw
      .prepare(
        `SELECT e.* FROM turn_outcome_evidence e
         JOIN turns t ON e.turn_id = t.turn_id
         WHERE e.applied = 0
           AND t.state IN ('ACCEPTED','STARTING','RUNNING','CANCELLING','FINALIZING','UNKNOWN')`,
      )
      .all() as Array<{
        turn_id: string;
        native_outcome: "completed" | "failed";
        termination_hint: "normal" | "cancelled" | "deadline" | null;
        candidate: "SUCCEEDED" | "FAILED" | "CANCELLED" | "TIMED_OUT";
        execution_started: number;
        native_conversation_ref: string | null;
        recorded_at: number;
        incarnation: string;
        applied: number;
      }>;

    for (const row of rows) {
      const turn = getTurn(this.db, row.turn_id);
      if (!turn || !isNonterminalTurnState(turn.state)) {
        this.db.raw.prepare("UPDATE turn_outcome_evidence SET applied = 1 WHERE turn_id = ?").run(row.turn_id);
        continue;
      }
      let session = getSession(this.db, turn.session_id);
      if (!session) continue;

      this.faultSkipCommitTurns_.delete(turn.turn_id);

      const isWriter = session.workspace_id !== null && session.workspace_mode !== "review_slot";
      let finalSnapshotId: string | null = null;
      let delta: ManifestDelta | null = null;
      let evidenceError: CoverageError | null = null;

      if (isWriter && row.candidate === "SUCCEEDED" && row.native_outcome === "completed") {
        try {
          const captured = this.finalCapture(turn, session);
          finalSnapshotId = captured.snapshot.snapshot_id;
          delta = captured.delta;
        } catch (e) {
          if (e instanceof CoverageError) {
            evidenceError = e;
          } else {
            evidenceError = new CoverageError(String(e), "EVIDENCE_CAPTURE_FAILED");
          }
        }
      }

      const nativeRef = row.native_conversation_ref ?? undefined;
      if (nativeRef && session.native_conversation_ref === null) {
        this.db.tx(() => {
          const s = getSession(this.db, session!.session_id);
          if (s && s.native_conversation_ref === null) {
            updateSessionFields(
              this.db,
              s.session_id,
              { native_conversation_ref: nativeRef, context_status: "available" },
              s.record_version,
              this.clock.now(),
            );
          }
        });
        session = getSession(this.db, session.session_id)!;
      }

      const continuation = session.native_conversation_ref === null && session.context_status === "not_started"
        ? "new_native_conversation"
        : "native_resume";

      if (evidenceError) {
        this.commitTerminal(
          turn,
          session,
          {
            candidate: "FAILED",
            native_outcome: row.native_outcome,
            termination_reason: row.termination_hint ?? "normal",
            execution_started: row.execution_started === 1,
            finalization_error: `${evidenceError.code}: ${evidenceError.message}`,
            error_code: evidenceError.code,
            detail: { cancel_reason: row.termination_hint === "cancelled" ? "cancelled" : null, final_snapshot_id: null },
          },
          continuation,
          nativeRef,
        );
      } else {
        this.commitTerminal(
          turn,
          session,
          {
            candidate: row.candidate,
            native_outcome: row.native_outcome,
            termination_reason: row.termination_hint ?? (row.execution_started === 0 ? "startup_failure" : "normal"),
            execution_started: row.execution_started === 1,
            finalization_error: null,
            error_code: null,
            detail: {
              cancel_reason: row.termination_hint === "cancelled" ? "cancelled" : null,
              observed_workspace_delta: delta ? { added: delta.added, modified: delta.modified, deleted: delta.deleted } : null,
            },
          },
          continuation,
          nativeRef,
          finalSnapshotId,
        );
      }

      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "recovery_outcome_reconciled",
        payload: { candidate: evidenceError ? "FAILED" : row.candidate },
        created_at: this.clock.now(),
      });
    }
  }

  // ─── cancellation / deadlines ──────────────────────────────────────────────

  notifyCancel(turnId: string, reason: string): void {
    const watch = this.cancelWatches.get(turnId);
    if (watch) watch.reason = reason;
    const turn = getTurn(this.db, turnId);
    const provider = turn ? getSession(this.db, turn.session_id)?.provider : undefined;
    const adapter = provider ? this.adapters.get(provider) : undefined;
    if (adapter) void adapter.interruptTurn(turnId).catch(() => undefined);
  }

  /**
   * Fault-injection hook (tests only): force a nonterminal turn into UNKNOWN
   * as if the supervisor died in a crash window (§14.3). The hanging adapter
   * execution is interrupted so the tracked promise can settle (its late
   * outcome lands as an audit-only late_terminal_ignored event).
   */
  async forceUnknownForTest(turnId: string, cause: Error): Promise<void> {
    const turn = getTurn(this.db, turnId);
    if (!turn) throw new Error("turn-not-found");
    const session = getSession(this.db, turn.session_id);
    if (!session) throw new Error("session-not-found");
    this.markUnknown(turn, session, cause);
    const adapter = this.adapters.get(session.provider);
    if (adapter) await adapter.interruptTurn(turnId).catch(() => undefined);
    await this.drain();
  }

  /**
   * TEST-ONLY fault injection (A19): configure a turn to skip terminal commit.
   */
  skipCommitForTest(turnId: string): void {
    this.faultSkipCommitTurns_.add(turnId);
  }

  /**
   * TEST-ONLY fault injection (A19): run the adapter to completion but skip the
   * terminal commit, leaving the turn in STARTING/RUNNING with a completed adapter.
   */
  async completeWithoutCommitForTest(turnId: string): Promise<void> {
    this.faultSkipCommitTurns_.add(turnId);
    try {
      if (!this.running.has(turnId)) {
        this.startTurn(turnId);
      }
      await this.waitTurn(turnId);
    } finally {
      this.faultSkipCommitTurns_.delete(turnId);
    }
  }

  /** Hard deadline scan (§14.6): TIMED_OUT only after definite quiescence. */
  scanDeadlines(): void {
    const now = this.clock.now();
    for (const [turnId, watch] of this.cancelWatches) {
      const turn = getTurn(this.db, turnId);
      if (!turn || turn.deadline_at === null) continue;
      if (turn.state === "RUNNING" || turn.state === "STARTING") {
        if (now >= turn.deadline_at) {
          watch.reason = "deadline";
          const provider = getSession(this.db, turn.session_id)?.provider;
          const adapter = provider ? this.adapters.get(provider) : undefined;
          this.db.tx(() => {
            const t = getTurn(this.db, turnId);
            if (!t || (t.state !== "RUNNING" && t.state !== "STARTING")) return;
            assertTurnTransition(t.state, "cancel_or_deadline");
            updateTurnFields(this.db, turnId, { state: "CANCELLING", termination_reason: "deadline" }, t.state_version, now);
            appendEvent(this.db, {
              turn_id: turnId,
              session_id: t.session_id,
              type: "deadline_reached",
              payload: {},
              created_at: now,
            });
          });
          if (adapter) void adapter.interruptTurn(turnId).catch(() => undefined);
        }
      }
    }
  }
}
