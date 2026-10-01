/**
 * Daemon lifecycle: lifetime-exclusive state-directory ownership and the
 * startup recovery barrier (spec §4.1.1, §14.7).
 *
 * Ownership model (P1, dev platform Windows; Unix variant later): an
 * exclusively-opened lock file inside the canonical state directory. A second
 * daemon cannot open it → DAEMON_ALREADY_RUNNING. The handle is held for the
 * daemon's whole life; heartbeat/socket presence is NOT ownership (§4.1.1).
 */
import { open, mkdir, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { isNonterminalTurnState } from "../core/transitions.ts";
import { BrokerError } from "../shared/errors.ts";
import { newId, ID_PREFIX } from "../shared/ids.ts";
import type { Clock } from "../shared/clock.ts";
import type { DaemonState } from "../shared/api-types.ts";
import type { RegistryDb } from "../storage/db.ts";
import { parseWorktreeJournal } from "../workspaces/worktree.ts";
import {
  appendEvent,
  getDaemonState,
  getSession,
  getTurn,
  listActiveReservations,
  listActiveReservationsByOwner,
  listPinsByOwner,
  listNonterminalTurns,
  listPendingIntents,
  releasePin,
  releaseReservation,
  setDaemonState,
  updateIntentState,
  updateSessionFields,
  updateTurnFields,
} from "../storage/repo.ts";
import type { DeadlineMonitor } from "./deadlineMonitor.ts";

export interface StateDirectoryOwnership {
  readonly directory: string;
  release(): Promise<void>;
}

/**
 * OS-backed ownership: exclusive create of `<dir>/daemon.lock` (O_EXCL-like
 * via wx flag). The open handle itself is the lock; deleting the file does
 * not steal ownership because we never delete/re-create it while held.
 * On platforms where wx+handle semantics are insufficient this is augmented
 * in the tested-platform phase (ADR-0001 §6).
 */
export async function acquireStateDirectoryOwnership(directory: string): Promise<StateDirectoryOwnership> {
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, "daemon.lock");
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new BrokerError(
        "DAEMON_ALREADY_RUNNING",
        "Another daemon owns this state directory.",
        { details: { lock_path: lockPath } },
      );
    }
    throw e;
  }
  return {
    directory,
    async release() {
      // Clean shutdown releases ownership completely (§14.2 daemon restart):
      // close the handle AND unlink the lock file. A crashed owner leaves
      // the file behind — recovering that requires an explicit operator
      // action; a new daemon must not steal a possibly-live lock (§4.1.1).
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    },
  };
}

export interface RecoveryReport {
  incarnation: string;
  restored_nonterminal_turns: number;
  restored_reservations: number;
  pending_intents: number;
  quarantined_unknown_turns: string[];
  /** §8.3: sessions whose owned worktree provision survived restart pending. */
  retained_worktree_provisions: string[];
}

export class DaemonLifecycle {
  private state: DaemonState = "RECOVERING";
  private incarnation = newId(ID_PREFIX.incarnation);
  private ownership: StateDirectoryOwnership | null = null;
  private deadlineMonitor: DeadlineMonitor | null = null;
  private drainBeforeShutdown: (() => Promise<void>) | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(
    private readonly db: RegistryDb,
    private readonly clock: Clock,
  ) {}

  attachDeadlineMonitor(monitor: DeadlineMonitor): void {
    this.deadlineMonitor = monitor;
  }

  /** Bootstrapped daemons drain accepted work before relinquishing ownership. */
  attachShutdownDrain(drain: () => Promise<void>): void {
    this.drainBeforeShutdown = drain;
  }

  get currentState(): DaemonState {
    return this.state;
  }

  get currentIncarnation(): string {
    return this.incarnation;
  }

  /**
   * Take ownership, then run the recovery barrier BEFORE readiness (§4.1.1).
   * `preAcquired` lets the caller take ownership BEFORE opening the mutable
   * registry (§4.1.1: ownership strictly precedes opening mutable state).
   * Returns the recovery report; throws BrokerError(DAEMON_ALREADY_RUNNING)
   * when another owner exists.
   */
  async start(stateDirectory: string, preAcquired?: StateDirectoryOwnership): Promise<RecoveryReport> {
    this.ownership = preAcquired ?? (await acquireStateDirectoryOwnership(stateDirectory));
    this.state = "RECOVERING";
    setDaemonState(this.db, {
      daemon_state: this.state,
      incarnation: this.incarnation,
      started_at: this.clock.now(),
      ready_at: null,
      fail_reason: null,
    });

    try {
      const report = this.runRecoveryBarrier();
      this.state = "READY";
      setDaemonState(this.db, {
        daemon_state: this.state,
        incarnation: this.incarnation,
        started_at: this.clock.now(),
        ready_at: this.clock.now(),
        fail_reason: null,
      });
      return report;
    } catch (e) {
      this.state = "FAILED";
      setDaemonState(this.db, {
        daemon_state: this.state,
        incarnation: this.incarnation,
        started_at: this.clock.now(),
        ready_at: null,
        fail_reason: String(e),
      });
      throw e;
    }
  }

  /**
   * §14.7 steps 1–4 (metadata-side): load nonterminal turns, intents,
   * reservations; protect unresolved executions conservatively; keep close
   * intents as a durable send ban. Crash-window table §14.3:
   *   - ACCEPTED with no launch intent → journaled no-dispatch failure
   *     (FINALIZING → FAILED, execution_started=false), no retry;
   *   - STARTING/RUNNING (launch may have happened, PID not durable) →
   *     UNKNOWN, session BLOCKED, reservations held;
   *   - UNKNOWN stays UNKNOWN (quarantined until reconciliation).
   */
  private runRecoveryBarrier(): RecoveryReport {
    const now = this.clock.now();
    const nonterminal = listNonterminalTurns(this.db);
    const reservations = listActiveReservations(this.db);
    const pendingIntents = listPendingIntents(this.db);
    const launchIntentsByTurn = new Set(
      pendingIntents.filter((i) => i.kind === "launch_turn" && i.turn_id).map((i) => i.turn_id!),
    );
    const unappliedEvidenceTurns = new Set(
      (
        this.db.raw
          .prepare("SELECT turn_id FROM turn_outcome_evidence WHERE applied = 0")
          .all() as Array<{ turn_id: string }>
      ).map((r) => r.turn_id),
    );

    const quarantinedUnknown: string[] = [];
    for (const turn of nonterminal) {
      if (unappliedEvidenceTurns.has(turn.turn_id)) {
        this.db.tx(() => {
          const t = getTurn(this.db, turn.turn_id);
          if (!t || !isNonterminalTurnState(t.state)) return;
          if (t.state !== "FINALIZING") {
            updateTurnFields(this.db, t.turn_id, { state: "FINALIZING" }, t.state_version, now);
          }
          appendEvent(this.db, {
            turn_id: t.turn_id,
            session_id: t.session_id,
            type: "recovery_evidence_found",
            payload: {},
            created_at: now,
          });
        });
        continue;
      }
      if (turn.state === "UNKNOWN") {
        quarantinedUnknown.push(turn.turn_id); // stays quarantined (§14.5)
        continue;
      }
      if (turn.state === "STARTING" || turn.state === "RUNNING" || turn.state === "CANCELLING" || turn.state === "FINALIZING") {
        // Undefined execution after a daemon crash: conservative UNKNOWN.
        this.db.tx(() => {
          const t = getTurn(this.db, turn.turn_id);
          if (!t) return;
          if (t.state === "UNKNOWN") {
            quarantinedUnknown.push(t.turn_id);
            return;
          }
          updateTurnFields(this.db, t.turn_id, { state: "UNKNOWN", native_outcome: "unknown" }, t.state_version, now);
          const s = getSession(this.db, t.session_id);
          if (s && s.state === "ACTIVE") {
            updateSessionFields(
              this.db,
              s.session_id,
              { state: "BLOCKED", block_reason: "daemon-restart-unknown-execution" },
              s.record_version,
              now,
            );
          }
          appendEvent(this.db, {
            turn_id: t.turn_id,
            session_id: t.session_id,
            type: "recovery_marked_unknown",
            payload: { previous_state: turn.state },
            created_at: now,
          });
          quarantinedUnknown.push(t.turn_id);
        });
        continue;
      }
      if (turn.state === "ACCEPTED" && !launchIntentsByTurn.has(turn.turn_id)) {
        // §14.3: crash after acceptance, before launch intent — journaled
        // no-dispatch failure, never an auto-retry. Recovery terminals pass
        // the same §6.5.3 release protocol as normal commits: reservations,
        // launch intents and the turn's accepted-turn pins all release here.
        this.db.tx(() => {
          const t = getTurn(this.db, turn.turn_id);
          if (!t || t.state !== "ACCEPTED") return;
          updateTurnFields(
            this.db,
            t.turn_id,
            {
              state: "FAILED",
              terminal_candidate: "FAILED",
              execution_started: false,
              native_outcome: "failed",
              termination_reason: "startup_failure",
              error_code: "DAEMON_RESTART_PRESTART",
              terminal_at: now,
            },
            t.state_version,
            now,
          );
          for (const res of listActiveReservationsByOwner(this.db, t.turn_id)) {
            releaseReservation(this.db, res.reservation_id, now);
          }
          for (const pin of listPinsByOwner(this.db, t.turn_id)) {
            if (pin.root_kind === "active_turn") releasePin(this.db, pin.pin_id);
          }
          for (const intent of listPendingIntents(this.db)) {
            if (intent.turn_id === t.turn_id && intent.kind === "launch_turn") {
              updateIntentState(this.db, intent.intent_id, "completed", now);
            }
          }
          const s = getSession(this.db, t.session_id);
          if (s && s.state === "ACTIVE") {
            updateSessionFields(this.db, s.session_id, { state: "IDLE", active_turn_id: null }, s.record_version, now);
          }
          appendEvent(this.db, {
            turn_id: t.turn_id,
            session_id: t.session_id,
            type: "recovery_prestart_failure",
            payload: {},
            created_at: now,
          });
        });
      }
      // ACCEPTED WITH a launch intent: crash window "після launch intent" —
      // conservatively UNKNOWN like the running cases above.
      if (turn.state === "ACCEPTED" && launchIntentsByTurn.has(turn.turn_id)) {
        this.db.tx(() => {
          const t = getTurn(this.db, turn.turn_id);
          if (!t || t.state !== "ACCEPTED") return;
          updateTurnFields(this.db, t.turn_id, { state: "UNKNOWN", native_outcome: "unknown" }, t.state_version, now);
          const s = getSession(this.db, t.session_id);
          if (s && s.state === "ACTIVE") {
            updateSessionFields(
              this.db,
              s.session_id,
              { state: "BLOCKED", block_reason: "daemon-restart-unknown-execution" },
              s.record_version,
              now,
            );
          }
          quarantinedUnknown.push(t.turn_id);
        });
      }
    }

    // §14.7 step 1–3 leftovers: a crash mid-provisioning must not leave a
    // PROVISIONING session holding its slot forever — finalize it as a
    // failed provisioning (BLOCKED, intent failed); the operator can then
    // safe-close it (§6.4). Orphan CAPTURING snapshots are durably FAILED.
    // §8.3 exception: a pending owned worktree provision that a Git mutation
    // may have touched (stage adding/added/ready, or any durable launch
    // receipt) is NOT inferred here — the journal is retained and bootstrap
    // reconciliation resolves it under the repository lock (no duplicate
    // add, no adoption). An owned binding that is invalid/unreadable is
    // likewise retained verbatim, never treated as an ordinary provision.
    const retainedWorktreeProvisions: string[] = [];
    for (const intent of listPendingIntents(this.db, "provision_session")) {
      if (!intent.session_id) continue;
      let retainWorktreeProvision = false;
      if (intent.payload === null || intent.payload === undefined) {
        // An accepted provision without its durable payload is unrecoverable
        // evidence — retained, never inferred into an ordinary finalization.
        retainWorktreeProvision = intent.payload === null;
      }
      if (intent.payload) {
        try {
          const parsed: unknown = JSON.parse(intent.payload);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            const raw = (parsed as Record<string, unknown>).worktree_provisioning;
            if (raw !== undefined) {
              const journal = parseWorktreeJournal(raw);
              retainWorktreeProvision =
                journal === null ||
                journal.stage !== "pending" ||
                journal.launch !== null;
            }
          } else {
            retainWorktreeProvision = true;
          }
        } catch {
          retainWorktreeProvision = true;
        }
      }
      if (retainWorktreeProvision) {
        retainedWorktreeProvisions.push(intent.session_id);
        continue;
      }
      this.db.tx(() => {
        const s = getSession(this.db, intent.session_id!);
        if (!s || s.state !== "PROVISIONING") {
          updateIntentState(this.db, intent.intent_id, "failed", now);
          return;
        }
        updateSessionFields(
          this.db,
          s.session_id,
          { state: "BLOCKED", block_reason: "provisioning-failed: daemon-restart" },
          s.record_version,
          now,
        );
        updateIntentState(this.db, intent.intent_id, "failed", now);
        appendEvent(this.db, {
          turn_id: null,
          session_id: s.session_id,
          type: "session_provisioning_failed",
          payload: { reason: "daemon-restart" },
          created_at: now,
        });
      });
    }
    const capturingRows = this.db.raw
      .prepare("SELECT snapshot_id FROM snapshot_records WHERE state = 'CAPTURING'")
      .all() as Array<{ snapshot_id: string }>;
    for (const row of capturingRows) {
      this.db.raw
        .prepare("UPDATE snapshot_records SET state = 'FAILED', fail_reason = ? WHERE snapshot_id = ? AND state = 'CAPTURING'")
        .run("daemon-restart-mid-capture", row.snapshot_id);
    }

    // Launch intents left pending by a crash are preserved, not completed
    // blindly; close intents stay as a durable send ban (§14.7 step 4).

    return {
      incarnation: this.incarnation,
      restored_nonterminal_turns: nonterminal.length,
      restored_reservations: reservations.length,
      pending_intents: pendingIntents.length,
      quarantined_unknown_turns: [...new Set(quarantinedUnknown)],
      retained_worktree_provisions: [...new Set(retainedWorktreeProvisions)],
    };
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown().catch(error => {
      // Keep ownership/supervision on failure, but permit an explicit caller
      // retry after resolving the drain failure. Never retry automatically.
      this.shutdownPromise = null;
      throw error;
    });
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    this.state = "STOPPING";
    setDaemonState(this.db, {
      daemon_state: this.state,
      incarnation: this.incarnation,
      started_at: this.clock.now(),
      ready_at: null,
      fail_reason: null,
    });
    // Keep supervision alive during drain. If drain fails, ownership and the
    // monitor remain held; callers must not close mutable state in that case.
    await this.drainBeforeShutdown?.();
    this.deadlineMonitor?.stop();
    this.deadlineMonitor = null;
    if (this.ownership) {
      await this.ownership.release();
      this.ownership = null;
    }
  }
}
