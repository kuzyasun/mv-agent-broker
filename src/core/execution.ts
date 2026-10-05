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
  expireArtifact,
  getAccount,
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
  updateSnapshotState,
  updateTurnFields,
} from "../storage/repo.ts";

import { BrokerError } from "../shared/errors.ts";
import type { ArtifactKind } from "../shared/api-types.ts";
import { newId, ID_PREFIX, sha256Hex } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type {
  IntentRecord,
  Limits,
  SessionRecord,
  SnapshotManifest,
  SnapshotRecord,
  TurnRecord,
  TurnState,
} from "../shared/api-types.ts";
import {
  assertSessionTransition,
  assertTurnTransition,
  isNonterminalTurnState,
} from "./transitions.ts";
import {
  cloneFrozenPolicy,
  sanitizeAdapterEvent,
  AGENT_CONCERN_CHAR_LIMIT,
  AGENT_LIST_METADATA_LIMIT,
  AGENT_PROVENANCE_CHAR_LIMIT,
  AGENT_SUMMARY_CHAR_LIMIT,
  DEFAULT_MAX_REPORT_BYTES,
  type AdapterPreflightContext,
  type AgentReportedResult,
} from "../runtime/adapter.ts";
import type {
  DispatchGate,
  ProviderAdapter,
  TurnExecutionRequest,
  TurnExecutionResult,
} from "../runtime/adapter.ts";
import { assertQuotaScopeSendable, readSessionProviderBinding, quotaScopeForSession } from "./broker.ts";
import { recordQuotaCooldown } from "./quotaCooldown.ts";
import {
  fingerprintReadinessObservation,
  readReadinessObservation,
} from "../providers/common/readiness.ts";
import type { BlobStore } from "../snapshots/blobs.ts";
import { captureSnapshot, diffManifests, readManifest, type ManifestDelta } from "../snapshots/capture.ts";
import { diffSnapshots, renderCompleteDiffDocument } from "../snapshots/diff.ts";
import { CoverageError, matchesPrefix, type CoverageConfig } from "../workspaces/coverage.ts";
import {
  isPhysicalLeaseScope,
  readSessionPhysicalBinding,
  resolvePhysicalCheckoutIdentity,
} from "../workspaces/identity.ts";
import { gitReviewDrift, resolveGitReviewRoot } from "../workspaces/gitReview.ts";
import { loadSessionWritePolicy, sessionWriteScope, type EffectiveWritePolicy } from "./policy.ts";
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
 * The continuation ROUTE THIS TURN REQUESTS, judged from the session state at
 * dispatch time — distinct from whatever native context was merely observed
 * mid-run. A fresh initial request stays "new_native_conversation" even when
 * the turn later failed after a native ref was observed; recording
 * "native_resume" from ref presence alone would mislabel the failed first
 * turn's continuation.
 */
function requestedContinuationFor(session: SessionRecord): "new_native_conversation" | "native_resume" {
  return session.native_conversation_ref === null && session.context_status === "not_started"
    ? "new_native_conversation"
    : "native_resume";
}

/**
 * Publication abort for a lost ownership race: a newer daemon incarnation owns
 * the registry, so this executor must not mutate. Leaves the durable report
 * subjournal untouched for the owning executor's recovery — never an evidence
 * failure, never fabricated success.
 */
class StalePublicationError extends Error {
  constructor() {
    super("stale executor incarnation; report publication left for the owning executor");
  }
}

/**
 * Report publication subjournal carried inside the turn's pending launch_turn
 * intent (§14.3) alongside its ownership/continuation keys. Phases:
 * declared → allocated (artifact id + expected SHA-256/size + pending pin,
 * atomic BEFORE any blob write) → blob_written → sealed. Schema metadata and
 * the bounded summary only — never the full prose.
 */
interface ReportSubjournal {
  phase: "declared" | "allocated" | "blob_written" | "sealed";
  turn_id: string;
  session_id: string;
  project_id: string;
  kind: ArtifactKind;
  artifact_id?: string;
  content_hash?: string;
  size_bytes?: number;
  baseline_snapshot_id: string | null;
  target_snapshot_id: string | null;
  provenance: string | null;
  summary: string;
  format_status: "structured" | "text_only";
  truncated: boolean;
  claimed_checks?: unknown[];
  concerns?: string[];
}

function parseReportSubjournal(value: unknown): ReportSubjournal | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (
    r.phase !== "declared" && r.phase !== "allocated" && r.phase !== "blob_written" && r.phase !== "sealed" ||
    typeof r.turn_id !== "string" ||
    typeof r.session_id !== "string" ||
    typeof r.project_id !== "string" ||
    (r.kind !== "report" && r.kind !== "findings") ||
    typeof r.summary !== "string" ||
    (r.format_status !== "structured" && r.format_status !== "text_only") ||
    typeof r.truncated !== "boolean"
  ) {
    return null;
  }
  const sub = r as unknown as ReportSubjournal;
  if (
    (r.artifact_id !== undefined && typeof r.artifact_id !== "string") ||
    (r.content_hash !== undefined && typeof r.content_hash !== "string") ||
    (r.size_bytes !== undefined && (typeof r.size_bytes !== "number" || !Number.isFinite(r.size_bytes)))
  ) {
    return null;
  }
  return sub;
}

/** Bounded provenance/concern metadata (schema-only event payloads). */
function boundProvenance(provenance: string | undefined): string | null {
  if (typeof provenance !== "string" || provenance.length === 0) return null;
  return provenance.length > AGENT_PROVENANCE_CHAR_LIMIT
    ? provenance.slice(0, AGENT_PROVENANCE_CHAR_LIMIT)
    : provenance;
}

function boundListMetadata<T>(values: T[] | undefined): T[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const result: T[] = [];
  let budget = 8192;
  for (const value of values.slice(0, AGENT_LIST_METADATA_LIMIT)) {
    let safe: unknown;
    if (typeof value === "string") safe = value.slice(0, AGENT_CONCERN_CHAR_LIMIT);
    else if (typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) safe = value;
    else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const projected: Record<string, unknown> = {};
      for (const key of ["name", "command", "status", "result", "details", "summary", "kind"]) {
        const entry = (value as Record<string, unknown>)[key];
        if (typeof entry === "string") projected[key] = entry.slice(0, AGENT_CONCERN_CHAR_LIMIT);
        else if (typeof entry === "boolean" || typeof entry === "number" && Number.isFinite(entry)) projected[key] = entry;
      }
      if (Object.keys(projected).length === 0) continue;
      safe = projected;
    } else continue;
    const size = Buffer.byteLength(JSON.stringify(safe), "utf8");
    if (size > budget) break;
    budget -= size;
    result.push(safe as T);
  }
  return result;
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

/**
 * A Git-native review turn: bound to exact full-hex commits (git_review_binding)
 * instead of snapshots. The reviewer reads the registered bound checkout with
 * its own Git tooling; the broker captures no snapshots and synthesizes no
 * diff inputs.
 */
function isGitReviewTurn(turn: Pick<TurnRecord, "git_base_commit" | "git_target_commit">): boolean {
  return turn.git_base_commit !== null && turn.git_target_commit !== null;
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
  /** TEST-ONLY: fail report artifact publication after known native completion. */
  private readonly faultReportPublicationTurns_ = new Set<string>();
  /** TEST-ONLY: interrupt publication after durable allocation, BEFORE the blob write. */
  private readonly faultSkipReportBlobTurns_ = new Set<string>();
  /** TEST-ONLY: interrupt publication after the blob journal, BEFORE seal (crash-before-seal). */
  private readonly faultSkipReportSealTurns_ = new Set<string>();
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
        if (s) this.finalizeCancelledPreDispatch(t, s, "cancelled", requestedContinuationFor(s));
      }
      return;
    }

    const { session, turn, adapter } = started;
    // The requested continuation route, fixed at dispatch time from the
    // session state BEFORE any native evidence of THIS turn exists.
    const continuation = requestedContinuationFor(session);
    const watch: CancelWatch = { reason: null };
    this.cancelWatches.set(turnId, watch);

    // §7.2 step 7: re-check the workspace under the lease at STARTING — an
    // external write that landed after the send-time digest preflight must
    // fail the turn BEFORE dispatch (no inference), not be absorbed into
    // this turn's delta.
    if (turn.baseline_snapshot_id && session.workspace_id && session.workspace_mode !== "review_slot") {
      const drift = this.checkBaselineDrift(turn, session);
      if (drift) {
        this.finalizePreStartKnown(turn, session, "WORKSPACE_CHANGED", drift, continuation);
        return;
      }
    }

    // §7.2 step 7: re-check cancel/policy under lease before launch.
    const turnNow = getTurn(this.db, turnId);
    if (!turnNow) return;
    if (turnNow.state === "CANCELLING") {
      // Cancel accepted before dispatch permission: no inference at all.
      this.finalizeCancelledPreDispatch(turnNow, session, watch.reason ?? "cancelled", continuation);
      return;
    }
    if (turnNow.state !== "STARTING") return; // concurrent transition happened

    // A05: revalidate the physical checkout binding under the lease before
    // input preparation and dispatch — an alias retargeted (or removed)
    // between acceptance and dispatch fails closed with zero inference, even
    // when the new directory's content would still match the baseline digest
    // above. Cancel priority is preserved: the CANCELLING re-check wins first.
    const leaseDrift = this.workspaceLeaseBindingDrift(turnId, session);
    if (leaseDrift) {
      this.finalizePreStartKnown(turnNow, session, "WORKSPACE_CHANGED", leaseDrift, continuation);
      return;
    }

    // Preserve the established error priority for a corrupt caller contract,
    // even when the same provision payload also lost its policy binding.
    try {
      this.persistedTaskContext(session, turnNow);
    } catch (error) {
      this.finalizePreStartKnown(turnNow, session, "INPUT_DELIVERY_FAILED", error instanceof Error ? error.message : String(error), continuation);
      return;
    }

    // The intent may have become unreadable after admission. Every role must
    // validate the immutable grant before preparing inputs or invoking native.
    // The FULL durable binding (not just the scope) is carried into the
    // execution request; missing/corrupt grants fail closed exactly as before.
    const policyLookup = loadSessionWritePolicy(this.db, session);
    if (policyLookup.kind !== "effective") {
      const reason = policyLookup.kind === "malformed"
        ? `effective write-policy binding unusable: ${policyLookup.reason}`
        : "Legacy session has no immutable write-policy binding; spawn a replacement session.";
      this.finalizePreStartKnown(turnNow, session, "POLICY_UNSUPPORTED", reason, continuation);
      return;
    }
    // Adapters receive a frozen defensive copy: mutating the request cannot
    // touch the durable grant or the gate's fresh DB reads (§12.1).
    const effectivePolicy: EffectiveWritePolicy = cloneFrozenPolicy(policyLookup.policy);

    // A06: resolve the session's durable physical cwd binding under the held
    // lease. A physical writer turn dispatches the PINNED cwd — the exact
    // FS-resolved path bound at provisioning — never a re-resolved mutable
    // alias. Sessions provisioned without a binding (pre-package journals)
    // cannot safely reinterpret their registered alias: explicit pre-dispatch
    // incompatibility requiring a replacement session; the recorded native
    // context and history are retained (no fresh-conversation fallback).
    const pinned = this.resolvePinnedDispatchCwd(turnId, session);
    if (!pinned.ok) {
      this.finalizePreStartKnown(turnNow, session, pinned.code, pinned.message, continuation);
      return;
    }

    // Git review: revalidate the exact-commit contract under the held lease
    // BEFORE inference. A queued or restarted turn re-proves the contract at
    // dispatch time — HEAD moved off the target commit or a dirty checkout
    // (external or coordinator edit) fails closed with zero inference.
    if (isGitReviewTurn(turnNow)) {
      const drift = this.gitReviewCheckoutDrift(session, turnNow.git_target_commit!, turnNow.git_working_tree_digest, "pre-dispatch");
      if (drift) {
        this.finalizePreStartKnown(turnNow, session, "WORKSPACE_CHANGED", drift, continuation);
        return;
      }
    }

    // Required input delivery BEFORE dispatch (§7.1.1, §13.2.1): resolve →
    // plan → materialize read-only views → seal the TurnInputManifest. Any
    // failure here is a journaled pre-dispatch failure — inference never
    // starts with a missing required input.
    let envelope = `agent-broker envelope turn=${turnId} session=${session.session_id}`;
    let readOnlyInputPaths: readonly string[] = Object.freeze([]);
    try {
      const prep = this.prepareInputs(turnNow, session, adapter);
      envelope = this.buildEnvelope(session, turnNow, prep.manifest);
      // §7.1.1: ONLY the exact broker-generated materialized bindings from the
      // sealed manifest — never paths derived from goal/artifact text.
      readOnlyInputPaths = Object.freeze(
        prep.manifest.inputs
          .filter((entry) => entry.delivery === "read_only_path")
          .map((entry) => entry.binding),
      );
    } catch (e) {
      const coverageCode =
        e instanceof CoverageError &&
        (e.code === "ARTIFACT_CORRUPT" || e.code === "ARTIFACT_EXPIRED" || e.code === "ARTIFACT_NOT_READY")
          ? e.code
          : null;
      const code =
        e instanceof InputPlanError
          ? e.code
          : e instanceof BrokerError
            ? e.code
            : coverageCode ?? "INPUT_DELIVERY_FAILED";
      const message = e instanceof Error ? e.message : String(e);
      this.finalizePreStartKnown(turnNow, session, code, message, continuation);
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

        // §13.3 native dispatch recheck: verify durable lifetime binding,
        // account drift, and config/binary readiness fingerprint AFTER admission
        // BEFORE permission/native launch, including restarted accepted queue.
        const bindingLookup = readSessionProviderBinding(this.db, session.session_id);
        if (bindingLookup.kind === "malformed") {
          throw new BrokerError("POLICY_UNSUPPORTED", `Session provider binding is unusable: ${bindingLookup.reason}`, {
            executionStarted: false,
          });
        }
        const isNative = ["claude", "codex", "cursor", "antigravity", "zcode"].includes(session.provider);
        if (bindingLookup.kind !== "bound") {
          if (isNative) {
            throw new BrokerError(
              "PROVIDER_INCOMPATIBLE",
              "Native legacy session lacks durable provider binding; replacement session required (§13.3).",
              { executionStarted: false },
            );
          }
        }
        let freshObservationFingerprint: string | null = null;
        if (bindingLookup.kind === "bound" && bindingLookup.binding.readiness !== null) {
          // Establish observation OUTSIDE the authoritative transaction (§13.3):
          // runs non-inference metadata probe or config inspection.
          const account = getAccount(this.db, session.account_profile_id);
          if (!account || account.provider !== session.provider) {
            throw new BrokerError(
              "PROVIDER_INCOMPATIBLE",
              `Account profile '${session.account_profile_id}' is not available for provider '${session.provider}'.`,
              { executionStarted: false },
            );
          }
          const policyLookup = loadSessionWritePolicy(this.db, session);
          if (policyLookup.kind !== "effective") {
            throw new BrokerError("POLICY_UNSUPPORTED", "Session write policy is not effective.", { executionStarted: false });
          }
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
          freshObservationFingerprint = observation ? fingerprintReadinessObservation(observation) : null;
          if (freshObservationFingerprint !== bindingLookup.binding.readiness.fingerprint) {
            throw new BrokerError(
              "PROVIDER_INCOMPATIBLE",
              "Provider binary, config or catalog drifted between admission and dispatch; refusing native launch — replacement session required (§13.3).",
              { executionStarted: false, details: { bound_fingerprint: bindingLookup.binding.readiness.fingerprint, fresh_fingerprint: freshObservationFingerprint } },
            );
          }
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
          const scope = sessionWriteScope(this.db, session);
          if (scope.kind === "invalid") {
            throw new BrokerError("POLICY_UNSUPPORTED", scope.reason, { executionStarted: false });
          }

          // Atomic recheck of account binding drift inside the serialized boundary
          if (bindingLookup.kind === "bound") {
            const freshAccount = getAccount(this.db, session.account_profile_id);
            if (!freshAccount) {
              throw new BrokerError("INVALID_REQUEST", `Account profile '${session.account_profile_id}' is not registered.`, { executionStarted: false });
            }
            if (
              freshAccount.account_profile_id !== bindingLookup.binding.account.account_profile_id ||
              freshAccount.provider !== bindingLookup.binding.account.provider ||
              freshAccount.auth_mode !== bindingLookup.binding.account.auth_mode ||
              freshAccount.quota_scope_id !== bindingLookup.binding.account.quota_scope_id
            ) {
              throw new BrokerError(
                "PROVIDER_INCOMPATIBLE",
                "Registered account binding drifted after admission; refusing dispatch — replacement session required (§13.3).",
                { executionStarted: false },
              );
            }
            if (bindingLookup.binding.readiness !== null && freshObservationFingerprint !== bindingLookup.binding.readiness.fingerprint) {
              throw new BrokerError(
                "PROVIDER_INCOMPATIBLE",
                "Provider readiness drifted after admission; refusing dispatch — replacement session required (§13.3).",
                { executionStarted: false },
              );
            }
          }

          // A05 authoritative re-check inside the serialized boundary: the
          // durable lease must still match the workspace's live physical
          // checkout (realpath/stat syscall, never a subprocess). A retargeted
          // alias refuses dispatch before execution_started is ever recorded.
          const leaseDrift = this.workspaceLeaseBindingDrift(turnId, session);
          if (leaseDrift) {
            throw new BrokerError("WORKSPACE_CHANGED", leaseDrift, { executionStarted: false });
          }

          // Shared quota-scope pause recheck immediately before dispatch
          // (§7.2 step 7): work accepted before the pause was learned cannot
          // bypass it. Same quotaScopeFor semantics as admission; refusal
          // keeps execution_started=false because the boundary has not yet
          // recorded any dispatch for this turn.
          assertQuotaScopeSendable(this.db, quotaScopeForSession(this.db, session), now);

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
      // A06: the pinned physical cwd for bound writer sessions — exact bytes
      // from the durable binding, stable across resume and daemon restart.
      // Review slots keep the broker-owned slot path; path-less and legacy
      // ID-scoped leases keep the live registered canonical_path contract.
      workspace_path:
        session.workspace_mode === "review_slot"
          ? this.slots?.slotPath(session.session_id) ?? null
          : pinned.cwd !== null
            ? pinned.cwd
            : session.workspace_id
              ? (getWorkspace(this.db, session.workspace_id)?.canonical_path ?? null)
              : null,
      deadline_at: turn.deadline_at ?? 0,
      clock: this.clock,
      // Validated durable binding + sealed manifest bindings; both frozen so
      // adapters cannot mutate the grant or the gate policy.
      effective_policy: effectivePolicy,
      read_only_input_paths: readOnlyInputPaths,
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
      this.finalizeCancelledPreDispatch(after, session, watch.reason ?? failure.reason, continuation);
      return;
    }

    if (failure !== null) {
      const isExecutionUnknown = failure instanceof BrokerError && failure.code === "EXECUTION_UNKNOWN";
      if (isExecutionUnknown) {
        this.markUnknown(after, session, failure);
        return;
      }
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
        this.finalizeWithFailure(after, session, failure, preDispatchStartup, watch.reason, continuation);
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

    // Preserve bounded native prose before outcome/finalization. Full text is
    // sealed as a project report/findings artifact; the event payload stays
    // schema-only (summary + refs, never full prose double-stored in DB).
    if (this.expectedIncarnation !== null) {
      const daemonState = getDaemonState(this.db);
      if (daemonState && daemonState.incarnation !== this.expectedIncarnation) return;
    }
    const reported = result.agent_reported;
    // An ordinary late completion cannot publish evidence or release UNKNOWN.
    // Only authoritative reconciliation of already durable evidence may do so.
    if (after.state === "UNKNOWN") return;
    const declaredReport =
      reported !== undefined &&
      typeof reported.summary === "string" &&
      (reported.format_status === "structured" || reported.format_status === "text_only");
    const resultNativeRef = result.native_conversation_ref !== ""
      ? result.native_conversation_ref
      : (after.native_conversation_ref ?? null);

    {
      // Known native outcome is journaled BEFORE publication (§5.3, §14.3):
      // the evidence row is the authoritative recovery guard even when the
      // publication is interrupted before any durable report identity, and a
      // late UNKNOWN result stays retained but never overrides it.
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
      try {
        this.db.tx(() => {
          if (this.staleIncarnation()) return;
          this.recordOutcomeEvidence(after, {
            native_outcome: result.native_outcome,
            termination_hint,
            candidate,
            execution_started: true,
            native_conversation_ref: resultNativeRef,
          });
          // Outcome and required-final declaration share one durable commit.
          if (declaredReport) this.journalDeclaredReportLocked(after, session, reported);
        });
      } catch (error) {
        if (this.staleIncarnation()) return;
        const reason = (error instanceof Error ? error.message : String(error)).slice(0, 512);
        this.commitTerminal(after, session, {
          candidate: "FAILED", native_outcome: result.native_outcome, termination_reason: "normal",
          execution_started: true, finalization_error: `EVIDENCE_CAPTURE_FAILED: ${reason}`,
          error_code: "EVIDENCE_CAPTURE_FAILED", detail: { report_publication_failed: true },
        }, continuation, resultNativeRef ?? undefined);
        return;
      }
    }

    if (declaredReport) {
      try {
        // Durable declared-final marker before any publication mutation, then
        // the publication protocol itself (allocation → blob → verified seal).
        const pub = this.publishAgentReport(after, session, reported);
        if (!pub.sealed) {
          // Crash-window semantics: stop subsequent execution. The turn stays
          // nonterminal; recovery finalizes from the journaled outcome with
          // the SAME artifact identity and zero inference.
          return;
        }
      } catch (err) {
        if (err instanceof StalePublicationError) return; // owning executor continues
        const msg = err instanceof Error ? err.message : String(err);
        // Known native completion stands; publication failure is explicit evidence failure.
        this.commitTerminal(after, session, {
          candidate: "FAILED",
          native_outcome: result.native_outcome,
          termination_reason: "normal",
          execution_started: true,
          finalization_error: `EVIDENCE_CAPTURE_FAILED: ${msg}`,
          error_code: "EVIDENCE_CAPTURE_FAILED",
          detail: { report_publication_failed: true },
        }, continuation, resultNativeRef ?? undefined);
        return;
      }
    }

    // Definite native outcome → FINALIZING → terminal (§6.5.2).
    this.finalizeWithOutcome(after, session, result, continuation, watch.reason);
  }

  // ─── durable report publication (§5.4, §14.3) ──────────────────────────────

  /** The turn's single pending launch_turn intent, or null. */
  private launchTurnIntent(turnId: string, sessionId: string): IntentRecord | null {
    const matches = listPendingIntents(this.db, "launch_turn").filter(
      (i) => i.turn_id === turnId && i.session_id === sessionId,
    );
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  /** True when a different live daemon incarnation owns the registry. */
  private staleIncarnation(): boolean {
    if (this.expectedIncarnation === null) return false;
    const ds = getDaemonState(this.db);
    return ds !== null && ds.incarnation !== this.expectedIncarnation;
  }

  /**
   * The continuation route the turn REQUESTED, journaled in its pending
   * launch_turn intent at STARTING — authoritative for recovery because the
   * session row may since have gained a native ref the failed turn only
   * observed mid-run. Null when the journal is unreadable/absent.
   */
  private requestedContinuationFromLaunchIntent(turnId: string, sessionId: string): "new_native_conversation" | "native_resume" | null {
    const matches = listPendingIntents(this.db, "launch_turn").filter(
      (i) => i.turn_id === turnId && i.session_id === sessionId,
    );
    if (matches.length !== 1 || !matches[0]!.payload) return null;
    try {
      const payload = JSON.parse(matches[0]!.payload!) as Record<string, unknown>;
      if (payload.continuation === "new") return "new_native_conversation";
      if (payload.continuation === "resume") return "native_resume";
    } catch {
      // fall through to the session-state heuristic
    }
    return null;
  }

  /** Read the report subjournal from the turn's pending launch_turn intent. */
  private readReportSubjournal(turnId: string, sessionId: string): ReportSubjournal | null {
    const intent = this.launchTurnIntent(turnId, sessionId);
    if (!intent || !intent.payload) return null;
    try {
      const payload = JSON.parse(intent.payload) as Record<string, unknown>;
      return parseReportSubjournal(payload.report);
    } catch {
      return null;
    }
  }

  /**
   * Rewrite the launch_turn intent's report subjournal, preserving the
   * ownership/continuation keys already present. Runs inside the caller's
   * transaction; the UPDATE is conditional on the intent still being pending.
   */
  private writeReportSubjournalLocked(turnId: string, sessionId: string, report: ReportSubjournal, now: number): void {
    const intent = this.launchTurnIntent(turnId, sessionId);
    if (!intent) throw new Error("pending launch_turn intent for report publication not found");
    let payload: Record<string, unknown>;
    try {
      payload = intent.payload
        ? (JSON.parse(intent.payload) as Record<string, unknown>)
        : {};
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw new Error("corrupt payload");
      }
    } catch {
      throw new Error("corrupt launch_turn intent journal; refusing report publication");
    }
    payload.report = report;
    const res = this.db.raw
      .prepare("UPDATE intents SET payload = ?, updated_at = ? WHERE intent_id = ? AND state = 'pending'")
      .run(JSON.stringify(payload), now, intent.intent_id);
    if (res.changes !== 1) {
      throw new Error("launch_turn intent no longer pending; refusing report publication");
    }
  }

  /**
   * Journal the declared-final requirement into the launch_turn intent
   * subjournal BEFORE any publication mutation: a crash after this point
   * leaves durable proof that a bounded native final existed, so recovery
   * fails explicitly (EVIDENCE_CAPTURE_FAILED) instead of inventing success.
   */
  private journalDeclaredReportLocked(turn: TurnRecord, session: SessionRecord, reported: AgentReportedResult): void {
    const prior = this.readReportSubjournal(turn.turn_id, session.session_id);
    if (prior !== null) return; // already durably declared (idempotent)
    const now = this.clock.now();
      if (this.staleIncarnation()) throw new StalePublicationError();
      this.writeReportSubjournalLocked(turn.turn_id, session.session_id, {
        phase: "declared",
        turn_id: turn.turn_id,
        session_id: session.session_id,
        project_id: turn.project_id,
        kind: session.role === "reviewer" ? "findings" : "report",
        baseline_snapshot_id: turn.baseline_snapshot_id,
        target_snapshot_id: turn.review_target_snapshot_id,
        provenance: boundProvenance(reported.provenance),
        summary: reported.summary.slice(0, AGENT_SUMMARY_CHAR_LIMIT),
        format_status: reported.format_status,
        truncated: reported.truncated === true,
        ...(boundListMetadata(reported.claimed_checks) !== undefined
          ? { claimed_checks: boundListMetadata(reported.claimed_checks) }
          : {}),
        ...(boundListMetadata(reported.concerns) !== undefined
          ? { concerns: boundListMetadata(reported.concerns) }
          : {}),
      }, now);
  }

  /**
   * Durable report/findings publication protocol:
   * 1. allocate the stable artifact id + expected SHA-256/size/bindings and
   *    the staging/pending pin atomically BEFORE any blob write,
   * 2. write the content-addressed blob, then journal the blob_written phase
   *    (blob registry row + audit event + subjournal) in one transaction,
   * 3. after verifying blob regularity/hash/size, settle seal + pin swap +
   *    sealed event + subjournal in ONE fenced metadata transaction.
   * Returns {sealed:false} when execution must stop like a crash window (the
   * turn stays nonterminal; recovery completes it); throws only for explicit
   * evidence failures (oversize, corrupt/foreign blob, binding mismatch).
   */
  private publishAgentReport(
    turn: TurnRecord,
    session: SessionRecord,
    reported: AgentReportedResult,
  ): { artifactId: string; sealed: boolean } {
    if (this.faultReportPublicationTurns_.has(turn.turn_id)) {
      throw new Error("injected report publication disk failure");
    }

    const subPrior = this.readReportSubjournal(turn.turn_id, session.session_id);

    const fullText =
      typeof reported.full_text === "string" ? reported.full_text : reported.summary;
    const truncated =
      reported.truncated === true ||
      fullText.length > AGENT_SUMMARY_CHAR_LIMIT ||
      (typeof reported.full_text === "string" && reported.summary.length < reported.full_text.length);
    const summary =
      reported.summary.length > AGENT_SUMMARY_CHAR_LIMIT
        ? reported.summary.slice(0, AGENT_SUMMARY_CHAR_LIMIT)
        : reported.summary;
    const kind: ArtifactKind =
      subPrior && (subPrior.kind === "findings" || subPrior.kind === "report")
        ? subPrior.kind
        : session.role === "reviewer"
          ? "findings"
          : "report";
    const metadata = {
      summary,
      format_status: reported.format_status,
      truncated,
      provenance: subPrior ? subPrior.provenance : boundProvenance(reported.provenance),
      claimed_checks: subPrior ? subPrior.claimed_checks : boundListMetadata(reported.claimed_checks),
      concerns: subPrior ? subPrior.concerns : boundListMetadata(reported.concerns),
    };

    // Replay after settlement: same identity, schema-only result event.
    if (subPrior?.artifact_id) {
      const art = getArtifact(this.db, subPrior.artifact_id);
      if (art && art.project_id === turn.project_id && art.state === "sealed") {
        this.verifyReportBlob(turn, subPrior);
        if (!getTurnEventPayload(this.db, turn.turn_id, "agent_reported")) this.appendBoundedAgentReported(turn, session, {
          ...metadata,
          full_message_artifact_id: subPrior.artifact_id,
        });
        return { artifactId: subPrior.artifact_id, sealed: true };
      }
    }

    // Resume an allocated/blob_written publication: verify then settle.
    if (
      subPrior &&
      (subPrior.phase === "allocated" || subPrior.phase === "blob_written") &&
      typeof subPrior.artifact_id === "string" &&
      typeof subPrior.content_hash === "string" &&
      typeof subPrior.size_bytes === "number"
    ) {
      const sub: ReportSubjournal = { ...subPrior, artifact_id: subPrior.artifact_id };
      this.verifyReportBlob(turn, sub);
      if (this.faultSkipReportSealTurns_.has(turn.turn_id)) {
        return { artifactId: sub.artifact_id as string, sealed: false };
      }
      this.settleReportPublication(turn, session, sub);
      this.appendBoundedAgentReported(turn, session, {
        ...metadata,
        full_message_artifact_id: sub.artifact_id as string,
      });
      return { artifactId: sub.artifact_id as string, sealed: true };
    }

    const payloadBody =
      kind === "findings"
        ? JSON.stringify({
            baseline_snapshot_id: turn.baseline_snapshot_id,
            target_snapshot_id: turn.review_target_snapshot_id,
            ...(isGitReviewTurn(turn)
              ? { git_base_commit: turn.git_base_commit, git_target_commit: turn.git_target_commit, git_working_tree_digest: turn.git_working_tree_digest }
              : {}),
            turn_id: turn.turn_id,
            session_id: session.session_id,
            source: session.provider,
            provenance: metadata.provenance,
            text: fullText,
          })
        : fullText;
    const bytes = Buffer.from(payloadBody, "utf8");

    // Reject oversized declared finals BEFORE any durable allocation or blob
    // write; the known native outcome is preserved as an explicit failure.
    if (bytes.byteLength > DEFAULT_MAX_REPORT_BYTES) {
      throw new BrokerError(
        "EVIDENCE_CAPTURE_FAILED",
        `declared final report exceeds the bounded ${DEFAULT_MAX_REPORT_BYTES} UTF-8 byte limit`,
      );
    }

    // Fresh allocation — atomic, BEFORE any blob write.
    const artifactId = subPrior?.artifact_id ?? newId("art");
    const contentHash = sha256Hex(bytes);
    const sizeBytes = bytes.byteLength;
    const allocatedAt = this.clock.now();
    const sub: ReportSubjournal = {
      phase: "allocated",
      turn_id: turn.turn_id,
      session_id: session.session_id,
      project_id: turn.project_id,
      kind,
      artifact_id: artifactId,
      content_hash: contentHash,
      size_bytes: sizeBytes,
      baseline_snapshot_id: turn.baseline_snapshot_id,
      target_snapshot_id: turn.review_target_snapshot_id,
      provenance: metadata.provenance,
      summary: metadata.summary,
      format_status: metadata.format_status,
      truncated: metadata.truncated,
      ...(metadata.claimed_checks !== undefined ? { claimed_checks: metadata.claimed_checks } : {}),
      ...(metadata.concerns !== undefined ? { concerns: metadata.concerns } : {}),
    };
    this.db.tx(() => {
      if (this.staleIncarnation()) throw new StalePublicationError();
      if (!getArtifact(this.db, artifactId)) {
        insertArtifact(this.db, {
          artifact_id: artifactId,
          project_id: turn.project_id,
          kind,
          content_hash: contentHash,
          size_bytes: sizeBytes,
          state: "staging",
          created_at: allocatedAt,
          sealed_at: null,
          expired_at: null,
        });
      }
      // Pending publication pin: keeps the staging artifact/blob reference
      // accounted until settlement (swapped for the role root at seal).
      insertPin(this.db, {
        pin_id: newId("pin"),
        artifact_id: artifactId,
        root_kind: "pending_intent",
        owner_session_id: session.session_id,
        owner_turn_id: turn.turn_id,
        created_at: allocatedAt,
      });
      this.writeReportSubjournalLocked(turn.turn_id, session.session_id, sub, allocatedAt);
    });

    if (this.faultSkipReportBlobTurns_.has(turn.turn_id)) {
      // Crash window BEFORE the blob write: identity is durable, content is not.
      return { artifactId, sealed: false };
    }

    const blob = this.blobs.write(turn.project_id, bytes);
    if (blob.hash !== contentHash || blob.size !== sizeBytes) {
      throw new Error("blob store returned unexpected content identity");
    }

    const blobAt = this.clock.now();
    this.db.tx(() => {
      if (this.staleIncarnation()) throw new StalePublicationError();
      insertBlobRecord(this.db, {
        project_id: turn.project_id,
        content_hash: contentHash,
        size_bytes: sizeBytes,
        created_at: blobAt,
      });
      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "report_publication",
        payload: this.reportPublicationPayload(sub, "blob_written", blobAt),
        created_at: blobAt,
      });
      this.writeReportSubjournalLocked(
        turn.turn_id,
        session.session_id,
        { ...sub, phase: "blob_written" },
        blobAt,
      );
    });

    if (this.faultSkipReportSealTurns_.has(turn.turn_id)) {
      // Crash window AFTER the blob journal, BEFORE seal: recovery settles.
      return { artifactId, sealed: false };
    }

    this.verifyReportBlob(turn, sub);
    this.settleReportPublication(turn, session, sub);
    this.appendBoundedAgentReported(turn, session, {
      ...metadata,
      full_message_artifact_id: artifactId,
    });
    return { artifactId, sealed: true };
  }

  /** Audit payload for report_publication events (schema refs only). */
  private reportPublicationPayload(sub: ReportSubjournal, phase: "blob_written" | "sealed", at: number): Record<string, unknown> {
    return {
      artifact_id: sub.artifact_id,
      kind: sub.kind,
      content_hash: sub.content_hash,
      size_bytes: sub.size_bytes,
      phase,
      turn_id: sub.turn_id,
      session_id: sub.session_id,
      project_id: sub.project_id,
      baseline_snapshot_id: sub.baseline_snapshot_id,
      target_snapshot_id: sub.target_snapshot_id,
      provenance: sub.provenance,
      ...(phase === "sealed" ? { sealed_at: at } : {}),
    };
  }

  /**
   * Verify blob regularity/hash/size and the project/turn/kind binding before
   * any seal. Missing, symlinked/irregular, size-mismatched, hash-mismatched
   * or foreign-bound content is an explicit EVIDENCE_CAPTURE_FAILED — never
   * sealed blindly, never invented.
   */
  private verifyReportBlob(turn: TurnRecord, sub: ReportSubjournal): void {
    if (
      typeof sub.artifact_id !== "string" ||
      typeof sub.content_hash !== "string" ||
      typeof sub.size_bytes !== "number"
    ) {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report publication identity incomplete");
    }
    const session = getSession(this.db, turn.session_id);
    if (sub.turn_id !== turn.turn_id || sub.project_id !== turn.project_id ||
        sub.session_id !== turn.session_id || session?.project_id !== turn.project_id ||
        sub.kind !== (session.role === "reviewer" ? "findings" : "report") ||
        sub.baseline_snapshot_id !== turn.baseline_snapshot_id ||
        sub.target_snapshot_id !== turn.review_target_snapshot_id ||
        !/^[0-9a-f]{64}$/.test(sub.content_hash) ||
        !Number.isSafeInteger(sub.size_bytes) || sub.size_bytes < 0 ||
        sub.size_bytes > DEFAULT_MAX_REPORT_BYTES) {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report subjournal does not bind this turn/project");
    }
    const art = getArtifact(this.db, sub.artifact_id);
    if (!art || art.project_id !== turn.project_id || art.kind !== sub.kind) {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report artifact binding mismatch");
    }
    if (art.state !== "staging" && art.state !== "sealed" ||
        art.state === "staging" && art.content_hash !== null && (art.content_hash !== sub.content_hash || art.size_bytes !== sub.size_bytes) ||
        art.state === "sealed" && (art.content_hash !== sub.content_hash || art.size_bytes !== sub.size_bytes)) {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report artifact identity mismatch");
    }
    try {
      this.blobs.readVerified(turn.project_id, sub.content_hash, sub.size_bytes);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", `report blob failed verification: ${reason}`);
    }
  }

  /**
   * ONE fenced metadata transaction after verified blob regularity/hash/size:
   * sealed artifact + pending-pin swap for the deliberate bounded-lifetime
   * root (worker report → active_turn, released at terminal; reviewer
   * findings → reviewer_anchor, held until session close) + sealed audit
   * event + subjournal settlement. Stale incarnations abort without mutation.
   */
  private settleReportPublication(turn: TurnRecord, session: SessionRecord, sub: ReportSubjournal): void {
    const artifactId = sub.artifact_id;
    if (typeof artifactId !== "string" || typeof sub.content_hash !== "string" || typeof sub.size_bytes !== "number") {
      throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report publication identity incomplete");
    }
    const now = this.clock.now();
    this.db.tx(() => {
      if (this.staleIncarnation()) throw new StalePublicationError();
      const art = getArtifact(this.db, artifactId);
      if (!art || art.project_id !== turn.project_id) {
        throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report artifact vanished before seal");
      }
      if (art.state === "sealed") {
        // Idempotent replay: converge the subjournal on the sealed phase.
        if (sub.phase !== "sealed") {
          this.writeReportSubjournalLocked(turn.turn_id, session.session_id, { ...sub, phase: "sealed" }, now);
        }
        return;
      }
      if (art.state !== "staging") {
        throw new BrokerError("EVIDENCE_CAPTURE_FAILED", "report artifact is not sealable");
      }
      sealArtifact(this.db, artifactId, sub.content_hash as string, sub.size_bytes as number, now);
      for (const pin of listPinsByOwner(this.db, turn.turn_id)) {
        if (pin.artifact_id === artifactId && pin.root_kind === "pending_intent") {
          releasePin(this.db, pin.pin_id);
        }
      }
      insertPin(this.db, {
        pin_id: newId("pin"),
        artifact_id: artifactId,
        root_kind: session.role === "reviewer" ? "reviewer_anchor" : "active_turn",
        owner_session_id: session.session_id,
        owner_turn_id: turn.turn_id,
        created_at: now,
      });
      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "report_publication",
        payload: this.reportPublicationPayload(sub, "sealed", now),
        created_at: now,
      });
      this.writeReportSubjournalLocked(turn.turn_id, session.session_id, { ...sub, phase: "sealed" }, now);
    });
  }

  /** Append the bounded agent_reported event only when it is not present. */
  private ensureAgentReportedFromSubjournal(turn: TurnRecord, session: SessionRecord, sub: ReportSubjournal): void {
    if (typeof sub.artifact_id !== "string") return;
    const existing = getTurnEventPayload(this.db, turn.turn_id, "agent_reported");
    if (existing && typeof existing.full_message_artifact_id === "string") return;
    this.appendBoundedAgentReported(turn, session, {
      summary: sub.summary,
      format_status: sub.format_status,
      truncated: sub.truncated,
      full_message_artifact_id: sub.artifact_id,
      provenance: sub.provenance ?? undefined,
      claimed_checks: sub.claimed_checks,
      concerns: sub.concerns,
    });
  }

  private appendBoundedAgentReported(
    turn: TurnRecord,
    session: SessionRecord,
    report: {
      summary: string;
      format_status: "structured" | "text_only";
      truncated: boolean;
      full_message_artifact_id: string;
      provenance?: string | null;
      claimed_checks?: unknown[];
      concerns?: string[];
    },
  ): void {
    const payload: Record<string, unknown> = {
      summary: report.summary,
      format_status: report.format_status,
      truncated: report.truncated,
      full_message_artifact_id: report.full_message_artifact_id,
    };
    if (report.provenance) payload.provenance = report.provenance;
    if (report.claimed_checks !== undefined) payload.claimed_checks = report.claimed_checks;
    if (report.concerns !== undefined) payload.concerns = report.concerns;
    const bounded =
      Buffer.byteLength(JSON.stringify(payload), "utf8") <= 64 * 1024
        ? payload
        : {
            summary: report.summary,
            format_status: report.format_status,
            truncated: report.truncated,
            full_message_artifact_id: report.full_message_artifact_id,
          };
    this.db.tx(() => {
      if (this.staleIncarnation()) throw new StalePublicationError();
      appendEvent(this.db, {
      turn_id: turn.turn_id,
      session_id: session.session_id,
      type: "agent_reported",
      payload: bounded,
      created_at: this.clock.now(),
      });
    });
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

  /**
   * Every required-byte consumption validates stored SHA-256/size and a regular
   * owned inode via readVerified against sealed authoritative metadata. Corrupt,
   * missing, or linked blobs fail closed as ARTIFACT_CORRUPT before dispatch —
   * never silently re-hash, reseal, or serve EVIL under GOOD metadata.
   */
  private readRequiredVerified(
    projectId: string,
    contentHash: string,
    expectedSize: number,
    label = "Required artifact",
  ): Uint8Array {
    try {
      return this.blobs.readVerified(projectId, contentHash, expectedSize);
    } catch (e) {
      const reason = e instanceof Error ? e.message : "verification failed";
      if (
        reason === "BLOB_NOT_FOUND" ||
        reason === "BLOB_HASH_MISMATCH" ||
        reason === "BLOB_SIZE_MISMATCH" ||
        reason === "BLOB_NOT_REGULAR" ||
        reason === "INVALID_BLOB_ID"
      ) {
        throw new BrokerError("ARTIFACT_CORRUPT", `${label} content failed verification (${reason}).`, {
          executionStarted: false,
        });
      }
      throw new BrokerError("ARTIFACT_CORRUPT", `${label} content failed verification.`, {
        executionStarted: false,
      });
    }
  }

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
  private prepareInputs(
    turn: TurnRecord,
    session: SessionRecord,
    adapter?: ProviderAdapter,
  ): { manifest: TurnInputManifest } {
    const projectId = session.project_id;
    const now = this.clock.now();
    let pendingReview: { target: SnapshotManifest; diff: string; artifactId: string } | null = null;

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
        inlineCandidate = this.readRequiredVerified(
          projectId,
          artifact.content_hash,
          artifact.size_bytes,
          `Required artifact ${artifactId}`,
        );
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
      const sizeByHash = new Map<string, number>();
      for (const entry of [...baselineManifest.entries, ...targetManifest.entries]) {
        if (entry.type === "file" && entry.content_hash && entry.size !== null) {
          sizeByHash.set(entry.content_hash, entry.size);
        }
      }
      const diff = diffSnapshots(baselineManifest, targetManifest, (hash) => {
        const expectedSize = sizeByHash.get(hash);
        if (expectedSize === undefined) return null;
        try {
          return this.blobs.readVerified(projectId, hash, expectedSize);
        } catch {
          return null;
        }
      });
      // Configured complete-diff budget (limits.maxReviewDiffBytes): the diff
      // is delivered in full or the turn fails closed before dispatch — never
      // truncated, never silently substituted.
      const diffDoc = renderCompleteDiffDocument(diff, this.limits.maxReviewDiffBytes);

      const now2 = this.clock.now();
      // Plan from exact bytes without publishing provisional artifacts or
      // changing the slot when transport limits cannot be satisfied.
      const diffBlob = { hash: sha256Hex(diffDoc), size: Buffer.byteLength(diffDoc, "utf8") };
      const diffArtifactId = newId("art");
      pendingReview = { target: targetManifest, diff: diffDoc, artifactId: diffArtifactId };

      const baselineArtifact = getArtifact(this.db, baselineRecord.manifest_artifact_id);
      if (!baselineArtifact || baselineArtifact.state === "expired") {
        throw new BrokerError("ARTIFACT_EXPIRED", "Review baseline manifest artifact has expired.");
      }
      if (baselineArtifact.state !== "sealed" || !baselineArtifact.content_hash || baselineArtifact.size_bytes === null) {
        throw new BrokerError("ARTIFACT_NOT_READY", "Review baseline manifest artifact is not sealed.");
      }
      let baselineInline: Uint8Array | null = null;
      if (baselineArtifact.size_bytes <= INLINE_TOTAL_BYTE_CAP) {
        baselineInline = this.readRequiredVerified(
          projectId,
          baselineArtifact.content_hash,
          baselineArtifact.size_bytes,
          "Review baseline manifest",
        );
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
        inlineCandidate: diffBlob.size <= INLINE_TOTAL_BYTE_CAP ? Buffer.from(diffDoc, "utf8") : null,
        allowMaterialization: true,
      });
    }

    const turnRoot = this.inputViews ? this.inputViews.turnRoot(turn.turn_id) : "";
    const contentTypeById = new Map(inputs.map((i) => [i.artifact.artifact_id, i.content_type]));
    const readOnlyPathForInput = (inputId: string, artifactId: string) => {
      const ctype = contentTypeById.get(artifactId) ?? "text/plain";
      return this.inputViews ? `${turnRoot}/${inputId}${extensionFor(ctype)}` : "";
    };

    const evaluateEnvelope = (
      deliveries: Array<{
        input_id: string;
        delivery: "inline" | "read_only_path";
        inlineContent: Uint8Array | null;
      }>,
    ): { chars: number; bytes: number } => {
      const text = this.renderEnvelope(session, turn, deliveries.map((d, i) => ({
        input_id: d.input_id, content_type: inputs[i]!.content_type,
        content_hash: inputs[i]!.artifact.content_hash!,
        content: d.delivery === "inline" ? Buffer.from(d.inlineContent!).toString("utf8") : null,
        binding: readOnlyPathForInput(d.input_id, inputs[i]!.artifact.artifact_id),
      })));
      return { chars: text.length, bytes: Buffer.byteLength(text, "utf8") };
    };

    const transportEnvelopeLimit = adapter?.transportEnvelopeLimit != null
      ? typeof adapter.transportEnvelopeLimit === "number"
        ? { maxChars: adapter.transportEnvelopeLimit }
        : adapter.transportEnvelopeLimit
      : null;

    const planned = planInputDelivery({
      inputs,
      transportEnvelopeLimit,
      evaluateEnvelope,
    });
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

    const workspace_binding = isGitReviewTurn(turn)
      ? {
          git_review: {
            workspace_id: session.workspace_id ?? "",
            base_commit: turn.git_base_commit ?? "",
            target_commit: turn.git_target_commit ?? "",
            working_tree_digest: turn.git_working_tree_digest,
          },
        }
      : session.workspace_mode === "review_slot"
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

    if (pendingReview) {
      try {
        const slotSizeByHash = new Map<string, number>();
        for (const entry of pendingReview.target.entries) {
          if (entry.type === "file" && entry.content_hash && entry.size !== null) {
            slotSizeByHash.set(entry.content_hash, entry.size);
          }
        }
        this.slots!.refresh(session.session_id, pendingReview.target, (hash) => {
          const expectedSize = slotSizeByHash.get(hash);
          if (expectedSize === undefined) {
            throw new BrokerError("ARTIFACT_CORRUPT", "Review slot source hash is not in the sealed manifest.", {
              executionStarted: false,
            });
          }
          return this.readRequiredVerified(projectId, hash, expectedSize, "Review slot source");
        });
      } catch (err) {
        if (err instanceof BrokerError) throw err;
        const reason = err instanceof Error ? err.message : "refresh failed";
        throw new BrokerError("EVIDENCE_CAPTURE_FAILED", `Review slot refresh failed (${reason}).`, {
          executionStarted: false,
        });
      }
      const blob = this.blobs.write(projectId, pendingReview.diff);
      const artifactId = pendingReview.artifactId;
      this.db.tx(() => {
        insertBlobRecord(this.db, { project_id: projectId, content_hash: blob.hash, size_bytes: blob.size, created_at: now });
        insertArtifact(this.db, { artifact_id: artifactId, project_id: projectId, kind: "patch",
          content_hash: null, size_bytes: null, state: "staging", created_at: now, sealed_at: null, expired_at: null });
        sealArtifact(this.db, artifactId, blob.hash, blob.size, now);
        insertPin(this.db, { pin_id: newId("pin"), artifact_id: artifactId, root_kind: "active_turn",
          owner_session_id: session.session_id, owner_turn_id: turn.turn_id, created_at: now });
      });
    }

    // Materialize read-only views (copies, never aliases — §9.2, §12.6).
    if (this.inputViews && manifest.inputs.some((i) => i.delivery === "read_only_path")) {
      const viewSizeByHash = new Map<string, { size: number; inputId: string }>();
      for (const entry of manifest.inputs) {
        if (entry.delivery === "read_only_path") {
          viewSizeByHash.set(entry.content_hash, { size: entry.size_bytes, inputId: entry.input_id });
        }
      }
      this.inputViews.materialize(manifest, (hash) => {
        const expected = viewSizeByHash.get(hash);
        if (!expected) {
          throw new BrokerError("ARTIFACT_CORRUPT", "Materialization hash is not in the sealed manifest.", {
            executionStarted: false,
          });
        }
        return this.readRequiredVerified(
          projectId,
          hash,
          expected.size,
          `Required input ${expected.inputId}`,
        );
      });
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

  /** Validate the durable caller contract without materializing any input. */
  private persistedTaskContext(session: SessionRecord, turn: TurnRecord): { instructions: string; task: Record<string, unknown> } {
    const instructions = getSessionInstructions(this.db, session.session_id);
    const task = getTurnEventPayload(this.db, turn.turn_id, "turn_admitted")?.task as Record<string, unknown> | undefined;
    if (instructions === null || sha256Hex(instructions) !== session.instructions_hash ||
        !task || typeof task.goal !== "string" || sha256Hex(task.goal) !== turn.task_goal_hash) {
      throw new BrokerError("INPUT_DELIVERY_FAILED", "Persisted session instructions or task contract is missing or inconsistent.");
    }
    return { instructions, task };
  }

  /** Deterministic envelope: caller contract and complete required inputs. */
  private buildEnvelope(session: SessionRecord, turn: TurnRecord, manifest: TurnInputManifest): string {
    return this.renderEnvelope(session, turn, manifest.inputs.map(entry => ({
      input_id: entry.input_id, content_type: entry.content_type, content_hash: entry.content_hash,
      content: entry.delivery === "inline"
        ? Buffer.from(
            this.readRequiredVerified(
              session.project_id,
              entry.content_hash,
              entry.size_bytes,
              `Required input ${entry.input_id}`,
            ),
          ).toString("utf8")
        : null,
      binding: entry.binding,
    })));
  }

  /** The planner and dispatched prompt share one exact renderer. */
  private renderEnvelope(session: SessionRecord, turn: TurnRecord, inputs: Array<{
    input_id: string; content_type: string; content_hash: string; content: string | null; binding: string;
  }>): string {
    const { instructions, task } = this.persistedTaskContext(session, turn);
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
      // Git-native review: compact exact commit ids plus suggested diff
      // commands. The broker NEVER synthesizes or delivers diff bytes — the
      // reviewer reads the bound checkout with its own Git tooling.
      ...(turn.git_base_commit && turn.git_target_commit
        ? [
            `git_review_binding: base_commit=${turn.git_base_commit} target_commit=${turn.git_target_commit} working_tree_digest=${turn.git_working_tree_digest ?? "clean"} (review this exact commit pair and bound working-tree state in your cwd)`,
            ...(turn.git_working_tree_digest
              ? [`suggested git commands: git diff --no-ext-diff --no-textconv ${turn.git_base_commit} (tracked working content); git diff --cached --no-ext-diff --no-textconv ${turn.git_target_commit}; git diff --no-ext-diff --no-textconv; git ls-files --others --exclude-standard, then read each untracked file; external diff and textconv are disabled`]
              : [`suggested git commands: git diff --no-ext-diff --no-textconv --stat ${turn.git_base_commit}..${turn.git_target_commit}; git diff --no-ext-diff --no-textconv ${turn.git_base_commit}..${turn.git_target_commit}; git show --no-ext-diff --no-textconv ${turn.git_target_commit} --stat`]),
          ]
        : []),
      inputs.length > 0
        ? `required inputs (${inputs.length}) — every input below is required:`
        : "required inputs: none",
    ];
    for (const entry of inputs) {
      if (entry.content !== null) {
        lines.push(`[input ${entry.input_id} ${entry.content_type} sha256=${entry.content_hash}]`);
        lines.push(entry.content);
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
    // Only the project's event schema persists: thinking/reasoning, unknown
    // types and arbitrary payload extras/raw arguments are discarded here;
    // owned control receipts pass through for strict in-core validation.
    const sanitized = sanitizeAdapterEvent(ev);
    if (sanitized === null) return;

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
          // Ownership-before-resume must not ACK ResumeThread on a stale
          // incarnation — throw so the Windows helper cancels with zero resume.
          if (sanitized.type === "owned_launch") {
            throw new Error("stale executor incarnation: ownership persistence refused before resume");
          }
          return;
        }
      }
      appendEvent(this.db, {
        turn_id: turnId,
        session_id: sessionId,
        type: `adapter:${sanitized.type}`,
        payload: sanitized.payload,
        created_at: now,
      });

      // Windows managed ownership: persist launch identity into the existing
      // launch_turn intent and session.runtime_id BEFORE ResumeThread.
      // This callback binds ownership before resume; neither permission nor
      // ownership alone proves that native execution has started.
      if (sanitized.type === "owned_launch") {
        if (!sanitized.payload) {
          throw new Error("missing owned_launch payload; refusing resume");
        }
        const p = sanitized.payload;
        if (
          typeof p.launch_uuid !== "string" || !/^[0-9a-fA-F-]{1,64}$/.test(p.launch_uuid) ||
          typeof p.named_job !== "string" || !/^[0-9A-Za-z_\\:.-]{1,120}$/.test(p.named_job) ||
          typeof p.root_pid !== "number" || !Number.isInteger(p.root_pid) || p.root_pid <= 0 ||
          typeof p.root_creation_time !== "string" || !/^[1-9][0-9]{0,18}$/.test(p.root_creation_time) ||
          p.owner_pid !== process.pid ||
          typeof p.owner_creation_time !== "string" || !/^[1-9][0-9]{0,18}$/.test(p.owner_creation_time) ||
          typeof p.helper_pid !== "number" || !Number.isInteger(p.helper_pid) || p.helper_pid <= 0
        ) {
          throw new Error("strict ownership payload validation failed; refusing resume");
        }

        const ownership = {
          launch_uuid: p.launch_uuid,
          named_job: p.named_job,
          root_pid: p.root_pid,
          root_creation_time: p.root_creation_time,
          helper_pid: p.helper_pid,
          owner_pid: p.owner_pid,
          owner_creation_time: p.owner_creation_time,
        };

        const runtimeId = [
          "winjob",
          ownership.launch_uuid,
          ownership.named_job,
          String(ownership.root_pid),
          ownership.root_creation_time,
          String(ownership.helper_pid),
          String(ownership.owner_pid),
          ownership.owner_creation_time,
        ].join(":");

        // onAdapterEvent already owns the serialized transaction: nested
        // RegistryDb transactions are deliberately forbidden.
        {
          if (this.expectedIncarnation !== null) {
            const ds = getDaemonState(this.db);
            if (!ds || ds.incarnation !== this.expectedIncarnation) {
              throw new Error("stale executor incarnation: ownership persistence refused before resume");
            }
          }

          const turnForRuntime = getTurn(this.db, turnId);
          if (!turnForRuntime || turnForRuntime.state !== "STARTING" || turnForRuntime.session_id !== sessionId) {
            throw new Error("active turn not found or not in STARTING; refusing resume");
          }

          const matchingIntents = listPendingIntents(this.db, "launch_turn").filter((i) => i.turn_id === turnId);
          const intent = matchingIntents[0];
          if (matchingIntents.length !== 1 || !intent || intent.session_id !== sessionId) {
            throw new Error(`expected exactly 1 pending launch_turn intent, found ${matchingIntents.length}; refusing resume`);
          }
          let intentPayload: Record<string, unknown>;
          try {
            if (!intent.payload) throw new Error("empty intent payload");
            intentPayload = JSON.parse(intent.payload) as Record<string, unknown>;
            if (typeof intentPayload !== "object" || intentPayload === null || Array.isArray(intentPayload)) throw new Error("corrupt payload");
          } catch {
            throw new Error("corrupt launch_turn intent journal; refusing resume");
          }
          intentPayload.ownership = ownership;

          const intentUpdate = this.db.raw
            .prepare("UPDATE intents SET payload = ?, updated_at = ? WHERE intent_id = ? AND state = 'pending'")
            .run(JSON.stringify(intentPayload), now, intent.intent_id);
          if (intentUpdate.changes !== 1) {
            throw new Error("0 rows updated for launch_turn intent; refusing resume");
          }

          const session = getSession(this.db, sessionId);
          if (!session || session.state !== "ACTIVE" || session.active_turn_id !== turnId) throw new Error("session does not own active turn; refusing resume");
          updateSessionFields(this.db, sessionId, { runtime_id: runtimeId }, session.record_version, now);
          updateTurnFields(this.db, turnId, { runtime_id: runtimeId }, turnForRuntime.state_version, now);
        }
      }

      if (sanitized.type === "owned_zero_resume") {
        const t = getTurn(this.db, turnId);
        if (!t || t.session_id !== sessionId || (t.state !== "STARTING" && t.state !== "CANCELLING")) {
          throw new Error("zero-resume receipt for an inactive managed turn");
        }
        const ownsProcess = sanitized.payload.ownership !== null && sanitized.payload.ownership !== undefined;
        if (ownsProcess && sanitized.payload.quiesced !== true) throw new Error("unsettled owned process cannot establish safe zero-resume finalization");
        updateTurnFields(this.db, turnId, { execution_started: false }, t.state_version, now);
      }

      if (sanitized.type === "native_ref_obtained" && typeof sanitized.payload.ref === "string") {
        // Persist the native reference ASAP (§13.2, §14.3).
        const turn = getTurn(this.db, turnId);
        if (turn) {
          updateTurnFields(this.db, turnId, { native_conversation_ref: sanitized.payload.ref }, turn.state_version, now);
        }
        const session = getSession(this.db, sessionId);
        if (session && session.native_conversation_ref === null) {
          updateSessionFields(
            this.db,
            sessionId,
            { native_conversation_ref: sanitized.payload.ref, context_status: "available" },
            session.record_version,
            now,
          );
        }
      }
      // First NATIVE evidence confirms dispatch → RUNNING (§6.5.2). Gate on
      // the journaled dispatch permission, not on ownership receipts alone —
      // owned_launch proves durable bind before ResumeThread, not that native
      // inference has started.
      const ownershipOnly =
        sanitized.type === "owned_launch" ||
        sanitized.type === "owned_resumed" ||
        sanitized.type === "owned_root_exit" ||
        sanitized.type === "owned_quiescence" ||
        sanitized.type === "owned_unproven";
      const phaseOnly = ownershipOnly || sanitized.type === "owned_zero_resume";
      const turn = getTurn(this.db, turnId);
      if (turn && turn.state === "STARTING" && turn.execution_started === true && !phaseOnly) {
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

  private finalizeCancelledPreDispatch(
    turn: TurnRecord,
    session: SessionRecord,
    reason: string,
    continuation?: "new_native_conversation" | "native_resume",
  ): void {
    this.commitTerminal(turn, session, {
      candidate: "CANCELLED",
      native_outcome: null,
      termination_reason: "cancelled",
      execution_started: false,
      finalization_error: null,
      error_code: null,
      detail: { reason },
    }, continuation);
  }

  private finalizePreStartFailure(turn: TurnRecord, session: SessionRecord, error: BrokerError): void {
    this.finalizePreStartKnown(turn, session, error.code, error.message);
  }

  /** Known pre-dispatch failure with journaled no-dispatch evidence. */
  private finalizePreStartKnown(
    turn: TurnRecord,
    session: SessionRecord,
    code: string,
    message: string,
    continuation?: "new_native_conversation" | "native_resume",
  ): void {
    this.commitTerminal(turn, session, {
      candidate: "FAILED",
      native_outcome: "failed",
      termination_reason: "startup_failure",
      execution_started: false,
      finalization_error: null,
      error_code: code,
      detail: { message },
    }, continuation);
  }

  /**
   * A05: drift description when the session's workspace no longer resolves
   * (realpath/stat) to the durable physical checkout identity recorded in its
   * active workspace_lease — an alias retargeted or removed after admission —
   * or null when the binding still holds. Legacy workspace_id-scoped leases
   * carry no physical binding and are never re-validated here. For sessions
   * WITH a durable cwd binding, the pinned checkout must still carry the held
   * lease's identity as well (external rename/recreate detection).
   */
  private workspaceLeaseBindingDrift(turnId: string, session: SessionRecord): string | null {
    if (!session.workspace_id || session.workspace_mode === "review_slot") return null;
    const lease = listActiveReservationsByOwner(this.db, turnId).find((r) => r.kind === "workspace_lease");
    if (!lease || !isPhysicalLeaseScope(lease.scope)) return null;
    const binding = readSessionPhysicalBinding(this.db, session.session_id);
    if (binding.kind === "bound") {
      if (binding.binding.lease_scope !== lease.scope) {
        return "session physical cwd binding does not match the held workspace lease";
      }
      const pinned = resolvePhysicalCheckoutIdentity(binding.binding.canonical_cwd);
      if (!pinned || pinned.scope !== lease.scope) {
        return "pinned physical checkout no longer resolves to the held lease (renamed or recreated externally)";
      }
    }
    const workspace = getWorkspace(this.db, session.workspace_id);
    const identity = workspace?.canonical_path ? resolvePhysicalCheckoutIdentity(workspace.canonical_path) : null;
    if (!identity || identity.scope !== lease.scope) {
      return "workspace no longer resolves to the leased physical checkout (alias retargeted or removed)";
    }
    return null;
  }

  /**
   * A06: the cwd pinned by the session's durable physical binding, resolved
   * against the turn's held workspace lease — or `cwd: null` for review
   * slots, path-less workspaces and legacy ID-scoped leases (their dispatch
   * contracts are unchanged). Every failure is an explicit pre-dispatch
   * refusal; an unbound physical session is never reinterpreted as its
   * mutable registered alias.
   */
  private resolvePinnedDispatchCwd(
    turnId: string,
    session: SessionRecord,
  ): { ok: true; cwd: string | null } | { ok: false; code: string; message: string } {
    if (!session.workspace_id || session.workspace_mode === "review_slot") return { ok: true, cwd: null };
    const lease = listActiveReservationsByOwner(this.db, turnId).find((r) => r.kind === "workspace_lease");
    const lookup = readSessionPhysicalBinding(this.db, session.session_id);
    if ((!lease || !isPhysicalLeaseScope(lease.scope)) && lookup.kind === "unbound") {
      return { ok: true, cwd: null };
    }
    if (lookup.kind === "unbound") {
      return {
        ok: false,
        code: "INVALID_REQUEST",
        message: "Session has no durable physical cwd binding; its historical working directory cannot be proved — spawn a replacement session (native context is retained).",
      };
    }
    if (lookup.kind === "malformed") {
      return {
        ok: false,
        code: "POLICY_UNSUPPORTED",
        message: `Session physical cwd binding is unusable: ${lookup.reason}`,
      };
    }
    const binding = lookup.binding;
    if (!lease || binding.lease_scope !== lease.scope) {
      return {
        ok: false,
        code: "WORKSPACE_CHANGED",
        message: "Session physical cwd binding does not match the held workspace lease.",
      };
    }
    const pinnedIdentity = resolvePhysicalCheckoutIdentity(binding.canonical_cwd);
    if (!pinnedIdentity || pinnedIdentity.scope !== lease.scope) {
      return {
        ok: false,
        code: "WORKSPACE_CHANGED",
        message: "Pinned physical checkout no longer resolves to the held lease (renamed or recreated externally).",
      };
    }
    return { ok: true, cwd: binding.canonical_cwd };
  }

  /**
   * Git review drift re-check against the session's durable PINNED checkout:
   * HEAD must still equal the exact target commit and the checkout must stay
   * clean or match its working-tree digest. `phase` only labels the failure. Unresolvable/unreadable state
   * fails closed as drift.
   */
  private gitReviewCheckoutDrift(session: SessionRecord, targetCommit: string, digest: string | null, phase: "pre-dispatch" | "post-run"): string | null {
    const binding = readSessionPhysicalBinding(this.db, session.session_id);
    if (binding.kind === "malformed") {
      return `session physical cwd binding is unusable for the ${phase} drift re-check`;
    }
    if (binding.kind !== "bound") {
      return `session has no durable physical cwd binding for the ${phase} drift re-check`;
    }
    const root = resolveGitReviewRoot(binding.binding.canonical_cwd);
    if (!root) {
      return `review checkout does not resolve for the ${phase} drift re-check`;
    }
    return gitReviewDrift(root, targetCommit, digest);
  }

  /**
   * Returns a drift description when the live workspace digest no longer
   * matches the turn's baseline snapshot (§8.2), or null when it matches.
   * A06: the digest is taken from the session's PINNED checkout when bound —
   * the re-check must describe the checkout this turn will write.
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
    const binding = readSessionPhysicalBinding(this.db, session.session_id);
    const root = binding.kind === "bound" ? binding.binding.canonical_cwd : workspace.canonical_path;
    if (binding.kind === "bound") {
      const pinned = resolvePhysicalCheckoutIdentity(root);
      if (!pinned || pinned.scope !== binding.binding.lease_scope) {
        return "pinned physical checkout no longer resolves to the session's bound identity";
      }
    }
    let digest: string;
    try {
      const inventory = takeInventory(root, config);
      digest = computeSourceDigest(inventory.entries, {
        profile_id: profile.coverage_profile_id,
        version: profile.version,
        contract_hash: profile.contract_hash,
      });
    } catch {
      return "workspace source state unreadable for the baseline re-check";
    }
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
    continuation?: "new_native_conversation" | "native_resume",
  ): void {
    // §14.6: a durably recorded deadline reason survives finalization — the
    // final status may be TIMED_OUT, not CANCELLED, and the reason is kept.
    const deadlineInterrupt = cancelReason !== null && turn.termination_reason === "deadline";
    // A shared quota-scope pause is learned ONLY from a definitive native
    // QUOTA_EXHAUSTED report: execution actually started, no cancellation or
    // deadline supervision decided the outcome, and the failure is not a
    // pre-dispatch startup refusal. Timeouts, silence and UNKNOWN never
    // record a pause (no backfill, no retroactive blocking).
    const quotaExhausted = error.code === "QUOTA_EXHAUSTED"
      && cancelReason === null
      && !preDispatchStartup;
    this.commitTerminal(turn, session, {
      candidate: deadlineInterrupt ? "TIMED_OUT" : cancelReason !== null ? "CANCELLED" : "FAILED",
      native_outcome: "failed",
      termination_reason: deadlineInterrupt ? "deadline" : cancelReason !== null ? "cancelled" : preDispatchStartup ? "startup_failure" : "normal",
      execution_started: preDispatchStartup ? false : true,
      finalization_error: null,
      error_code: cancelReason !== null ? null : error.code,
      detail: { message: error.message, cancel_reason: cancelReason },
      ...(quotaExhausted ? { quotaCooldown: { detail: error.message } } : {}),
    }, continuation);
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
    // Git review turns are not writers: the exact-commit binding is the
    // evidence, no final snapshot is captured, and a checkout that drifted
    // during the review must not produce an accepted SUCCEEDED review.
    const isGitReview = isGitReviewTurn(turn);
    const isWriter = session.workspace_id !== null && session.workspace_mode !== "review_slot" && !isGitReview;
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

    if (isGitReview && !evidenceError && result.native_outcome === "completed") {
      const drift = this.gitReviewCheckoutDrift(session, turn.git_target_commit!, turn.git_working_tree_digest, "post-run");
      if (drift) evidenceError = new CoverageError(drift, "WORKSPACE_CHANGED");
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
    const leaseDrift = this.workspaceLeaseBindingDrift(turn.turn_id, session);
    if (leaseDrift) throw new CoverageError(leaseDrift, "EVIDENCE_CAPTURE_FAILED");
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

    // A06: the final capture reads the session's PINNED checkout under the
    // exact held lease — never a re-resolved mutable alias — with the pinned
    // root's identity re-verified immediately before and after the capture.
    // A root renamed/recreated mid-turn is an evidence failure for the known
    // native completion; a foreign checkout is never promoted as the final
    // source. (Arbitrary external rename/recreate still requires per-tool
    // native enforcement; this closes the capture window only.)
    const binding = readSessionPhysicalBinding(this.db, session.session_id);
    if (binding.kind === "malformed") {
      throw new CoverageError(`Session physical cwd binding is unusable: ${binding.reason}`, "EVIDENCE_CAPTURE_FAILED");
    }
    const captureRoot = binding.kind === "bound" ? binding.binding.canonical_cwd : workspace.canonical_path;
    if (binding.kind === "bound" &&
        resolvePhysicalCheckoutIdentity(captureRoot)?.scope !== binding.binding.lease_scope) {
      throw new CoverageError(
        "Pinned physical checkout does not resolve to the bound identity before final capture",
        "EVIDENCE_CAPTURE_FAILED",
      );
    }

    const captured = captureSnapshot({
      db: this.db,
      blobs: this.blobs,
      clock: this.clock,
      projectId: session.project_id,
      workspaceId: workspace.workspace_id,
      workspaceRoot: captureRoot,
      coverage,
    });

    if (binding.kind === "bound" &&
        resolvePhysicalCheckoutIdentity(captureRoot)?.scope !== binding.binding.lease_scope) {
      updateSnapshotState(this.db, captured.snapshot.snapshot_id, "FAILED", "physical-checkout-changed-during-final-capture");
      throw new CoverageError(
        "Pinned physical checkout identity changed during final capture",
        "EVIDENCE_CAPTURE_FAILED",
      );
    }

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

    // Scope enforcement (§8.5, §8.7): post-detection against the session's
    // IMMUTABLE effective write policy (§12.1 binding); a violation fails the
    // turn with evidence, no rollback is attempted. Fail-closed: an unreadable
    // binding or policy profile cannot silently disable the check, and an
    // empty scope (read_only or undeclared write_scope) permits no writes.
    const scope = sessionWriteScope(this.db, session);
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
      /** Set only for a definitive native QUOTA_EXHAUSTED (see finalizeWithFailure). */
      quotaCooldown?: { detail: string };
    },
    continuation?: "new_native_conversation" | "native_resume",
    nativeRef?: string,
    finalSnapshotId?: string | null,
    isReconciliation: boolean = false,
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
      if (!isNonterminalTurnState(t.state) || (t.state === "UNKNOWN" && !isReconciliation)) {
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
      if (t.state === "UNKNOWN" && isReconciliation) {
        const s = getSession(this.db, session.session_id);
        if (s && s.state === "BLOCKED") {
          assertSessionTransition(s.state, "unknown_turn_finalizing");
          updateSessionFields(this.db, s.session_id, { state: "ACTIVE" }, s.record_version, now);
        }
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

      // Learn the shared quota-scope pause in the SAME transaction as the
      // terminal commit: only a definitive native QUOTA_EXHAUSTED reaches
      // here (finalizeWithFailure sets quotaCooldown; journaled-evidence
      // reconciliation never does, so timeout history is never backfilled).
      if (outcome.quotaCooldown && outcome.candidate === "FAILED" &&
          outcome.error_code === "QUOTA_EXHAUSTED" && outcome.execution_started) {
        const pause = recordQuotaCooldown(this.db, {
          quotaScopeId: quotaScopeForSession(this.db, session),
          provider: session.provider,
          turnId: turn.turn_id,
          detail: outcome.quotaCooldown.detail,
          now,
        });
        appendEvent(this.db, {
          turn_id: turn.turn_id,
          session_id: session.session_id,
          type: "quota_pause_recorded",
          payload: {
            quota_scope_id: pause.quota_scope_id,
            until_ms: pause.until_ms,
            retry_after_ms: pause.retry_after_ms,
            source: pause.source,
          },
          created_at: now,
        });
      }

      // Latest-anchor pin transfer (§15.3.1): the initial baseline stays
      // pinned until close; the previous "latest" pin is atomically replaced
      // by the new sealed final snapshot's manifest. Pruning touches ONLY
      // snapshot-manifest anchors — report/finding pins are never session
      // anchors and are never removed by this transfer.
      if (finalSnapshotId) {
        const sPins = getSession(this.db, session.session_id);
        const finalRecord = getSnapshotRecord(this.db, finalSnapshotId);
        const initialArtifactId = sPins?.initial_snapshot_id
          ? (getSnapshotRecord(this.db, sPins.initial_snapshot_id)?.manifest_artifact_id ?? null)
          : null;
        for (const pin of listPinsByOwner(this.db, session.session_id)) {
          if (pin.root_kind !== "session_anchor" || pin.artifact_id === initialArtifactId) continue;
          const pinnedArt = getArtifact(this.db, pin.artifact_id);
          if (pinnedArt && pinnedArt.kind !== "snapshot_manifest") continue;
          releasePin(this.db, pin.pin_id);
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

      // An unsealed staged report at terminal is a deliberate bounded failure:
      // expire the tombstone so no staging artifact or permanent publication
      // root outlives the turn (sealed reports keep their role pin contract).
      // UNKNOWN turns never reach commitTerminal — their pins survive recovery.
      const reportSub = this.readReportSubjournal(turn.turn_id, session.session_id);
      if (reportSub?.artifact_id) {
        const reportArt = getArtifact(this.db, reportSub.artifact_id);
        if (reportArt?.project_id === turn.project_id && reportArt.state === "sealed" && reportArt.kind === "report") {
          // Preserve the latest complete report of an open worker/researcher.
          // Older report roots become eligible for explicit cleanup, not deletion.
          for (const pin of listPinsByOwner(this.db, session.session_id)) {
            if (pin.root_kind === "session_anchor" && pin.artifact_id !== reportArt.artifact_id &&
                pin.owner_turn_id !== null &&
                getTurnEventPayload(this.db, pin.owner_turn_id, "agent_reported")?.full_message_artifact_id === pin.artifact_id &&
                getArtifact(this.db, pin.artifact_id)?.kind === "report") releasePin(this.db, pin.pin_id);
          }
          insertPin(this.db, {
            pin_id: newId("pin"), artifact_id: reportArt.artifact_id, root_kind: "session_anchor",
            owner_session_id: session.session_id, owner_turn_id: turn.turn_id, created_at: now,
          });
        }
        if (reportArt && reportArt.project_id === turn.project_id && reportArt.state === "staging") {
          expireArtifact(this.db, reportArt.artifact_id, now);
        }
      }

      // Release turn-owned reservations exactly once, complete this turn's
      // journaled launch intent (§14.7), and drop its accepted-turn/pending
      // publication pins (§15.3.1: latest/session roots re-pin what survives).
      for (const res of listActiveReservationsByOwner(this.db, turn.turn_id)) {
        releaseReservation(this.db, res.reservation_id, now);
      }
      for (const pin of listPinsByOwner(this.db, turn.turn_id)) {
        if (pin.root_kind === "pending_intent") {
          const staged = getArtifact(this.db, pin.artifact_id);
          if (staged?.project_id === turn.project_id && staged.state === "staging" &&
              (staged.kind === "report" || staged.kind === "findings")) expireArtifact(this.db, staged.artifact_id, now);
        }
        if (pin.root_kind === "active_turn" || pin.root_kind === "pending_intent") releasePin(this.db, pin.pin_id);
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
    if (this.staleIncarnation()) return;
    // Finish report publications left staged by a crash window first; their
    // per-turn outcome gates how the journaled evidence may be applied.
    const reportStatus = this.reconcileReportPublications();

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

      const unrecoverableReport = reportStatus.get(turn.turn_id);
      const forceReportFailure = unrecoverableReport?.ok === false;

      // Git review turns are never writers (no final snapshot in recovery)
      // and their SUCCEEDED candidate must survive the post-run drift check:
      // a checkout that changed since the review fails closed instead.
      const isGitReview = isGitReviewTurn(turn);
      const isWriter = session.workspace_id !== null && session.workspace_mode !== "review_slot" && !isGitReview;
      let finalSnapshotId: string | null = null;
      let delta: ManifestDelta | null = null;
      let evidenceError: CoverageError | null = null;

      if (isWriter && !forceReportFailure && row.candidate === "SUCCEEDED" && row.native_outcome === "completed") {
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

      if (isGitReview && !forceReportFailure && !evidenceError &&
          row.candidate === "SUCCEEDED" && row.native_outcome === "completed") {
        const drift = this.gitReviewCheckoutDrift(session, turn.git_target_commit!, turn.git_working_tree_digest, "post-run");
        if (drift) evidenceError = new CoverageError(drift, "WORKSPACE_CHANGED");
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

      // The journaled requested continuation wins; ref presence alone is only
      // the fallback for legacy journals without the launch intent route.
      const continuation = this.requestedContinuationFromLaunchIntent(turn.turn_id, turn.session_id)
        ?? requestedContinuationFor(session);

      if (forceReportFailure) {
        // Missing/corrupt/foreign report evidence: explicit EVIDENCE_CAPTURE_FAILED
        // that PRESERVES the completed native outcome — never invented success,
        // never UNKNOWN, and never a block on unrelated turns' recovery.
        this.commitTerminal(
          turn,
          session,
          {
            candidate: "FAILED",
            native_outcome: row.native_outcome,
            termination_reason: row.termination_hint ?? (row.execution_started === 1 ? "normal" : "startup_failure"),
            execution_started: row.execution_started === 1,
            finalization_error: `EVIDENCE_CAPTURE_FAILED: ${unrecoverableReport.reason ?? "report publication unrecoverable"}`,
            error_code: "EVIDENCE_CAPTURE_FAILED",
            detail: {
              report_publication_failed: true,
              cancel_reason: row.termination_hint === "cancelled" ? "cancelled" : null,
              final_snapshot_id: null,
            },
          },
          continuation,
          nativeRef,
          null,
          true,
        );
      } else if (evidenceError) {
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
          null,
          true,
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
          true,
        );
      }

      appendEvent(this.db, {
        turn_id: turn.turn_id,
        session_id: session.session_id,
        type: "recovery_outcome_reconciled",
        payload: { candidate: forceReportFailure || evidenceError ? "FAILED" : row.candidate },
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
   * Reconcile staging report publications without inference. For every
   * nonterminal turn whose launch_turn subjournal carries an unfinished report:
   * - allocated/blob_written → verify blob regularity/hash/size AND the
   *   project/turn/kind binding, then atomically seal (fenced against stale
   *   incarnations) — or record an explicit per-turn failure;
   * - declared (never allocated) → explicit failure: the content was never
   *   made durable, so success must not be invented;
   * - sealed → converge the bounded result event from the subjournal.
   * Returns per-turn status for the evidence application pass. Failures are
   * isolated per turn: unrelated recovery is never blocked.
   */
  private reconcileReportPublications(): Map<string, { ok: boolean; reason?: string }> {
    const status = new Map<string, { ok: boolean; reason?: string }>();

    const intentRows = this.db.raw
      .prepare(
        `SELECT turn_id, session_id, payload FROM intents
         WHERE kind = 'launch_turn' AND state = 'pending' AND turn_id IS NOT NULL`,
      )
      .all() as Array<{ turn_id: string; session_id: string | null; payload: string | null }>;

    for (const row of intentRows) {
      let sub: ReportSubjournal | null = null;
      let declared = false;
      try {
        const payload = row.payload ? (JSON.parse(row.payload) as Record<string, unknown>) : null;
        declared = payload !== null && Object.prototype.hasOwnProperty.call(payload, "report");
        sub = payload ? parseReportSubjournal(payload.report) : null;
      } catch {
        status.set(row.turn_id, { ok: false, reason: "report launch journal is corrupt" });
        continue;
      }
      if (declared && !sub) {
        status.set(row.turn_id, { ok: false, reason: "declared report journal schema is corrupt" });
        continue;
      }
      if (!sub) continue;

      const turn = getTurn(this.db, row.turn_id);
      if (!turn || !isNonterminalTurnState(turn.state)) continue;
      const session = getSession(this.db, turn.session_id);
      if (!session || session.session_id !== sub.session_id || row.session_id !== sub.session_id) {
        status.set(row.turn_id, { ok: false, reason: "report session binding mismatch" });
        continue;
      }

      if (sub.phase === "sealed") {
        try {
          this.verifyReportBlob(turn, sub);
          this.ensureAgentReportedFromSubjournal(turn, session, sub);
        } catch (err) {
          if (!(err instanceof StalePublicationError)) status.set(row.turn_id, { ok: false, reason: err instanceof Error ? err.message : String(err) });
        }
        continue;
      }

      if (
        sub.phase === "declared" ||
        typeof sub.artifact_id !== "string" ||
        typeof sub.content_hash !== "string" ||
        typeof sub.size_bytes !== "number"
      ) {
        status.set(row.turn_id, { ok: false, reason: "declared report never made durable" });
        continue;
      }

      try {
        this.verifyReportBlob(turn, sub);
        this.settleReportPublication(turn, session, sub);
        this.ensureAgentReportedFromSubjournal(turn, session, sub);
        status.set(row.turn_id, { ok: true });
      } catch (err) {
        if (err instanceof StalePublicationError) continue; // owning executor's job
        status.set(row.turn_id, { ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    return status;
  }

  /**
   * TEST-ONLY fault injection (A19): configure a turn to skip terminal commit.
   */
  skipCommitForTest(turnId: string): void {
    this.faultSkipCommitTurns_.add(turnId);
  }

  /** TEST-ONLY: fail report publication after native completion. */
  failReportPublicationForTest(turnId: string): void {
    this.faultReportPublicationTurns_.add(turnId);
  }

  /**
   * TEST-ONLY: stop execution like a crash window AFTER the blob journal and
   * BEFORE seal. Never returns to a normal completion path: the turn stays
   * nonterminal and only recovery (with the same artifact identity) settles it.
   */
  skipReportSealForTest(turnId: string): void {
    this.faultSkipReportSealTurns_.add(turnId);
  }

  /** TEST-ONLY: stop execution like a crash AFTER durable allocation, BEFORE the blob write. */
  skipReportBlobForTest(turnId: string): void {
    this.faultSkipReportBlobTurns_.add(turnId);
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
