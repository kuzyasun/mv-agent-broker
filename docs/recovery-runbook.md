# Recovery Runbook (operator)

Operational runbook for triage, crash recovery, and storage maintenance in Agent Broker (spec §14, §15, §17 P4).

## 1. Quick triage

Inspect the local SQLite registry (`<state_dir>/registry.sqlite`) to determine daemon and session health:

```sql
-- Daemon liveness, incarnation, and startup errors
SELECT id, daemon_state, incarnation, started_at, ready_at, fail_reason FROM daemon_state;

-- Sessions stuck in BLOCKED with explicit reasons
SELECT session_id, project_id, provider, state, block_reason, active_turn_id FROM sessions WHERE state = 'BLOCKED';

-- Turns in nonterminal or unresolved recovery states
SELECT turn_id, session_id, state, native_outcome, termination_reason, terminal_candidate FROM turns WHERE state IN ('UNKNOWN', 'FINALIZING');

-- Unresolved lifecycle intents (launch, close, provision, capture)
SELECT intent_id, kind, session_id, turn_id, state, created_at FROM intents WHERE state = 'pending';

-- Active artifact protection pins preventing blob garbage collection
SELECT pin_id, artifact_id, root_kind, owner_session_id, owner_turn_id FROM artifact_pins;
```

## 2. UNKNOWN turn (§14.5)

- **Meaning:** A turn enters `UNKNOWN` when execution outcome or supervisor liveness cannot be authoritatively proven (e.g. daemon crashed mid-execution, process communication died). It is nonterminal.
- **Lock quarantine:** Workspace lease reservations and session capacity slots remain held indefinitely. This prevents concurrent workers from writing to dirty workspaces and fences out stale processes (INV-02).
- **Operator resolution paths:**
  1. *Authoritative terminal evidence exists:* Verify worker output files/logs and reconcile turn to `SUCCEEDED` or `FAILED`.
  2. *Confirmed quiescence:* Verify provider processes are dead, inspect disk delta, record a new workspace baseline, and transition turn to `ABANDONED` with unknown outcome.
  3. *Unresolved:* Leave quarantined while processes or disk states are uncertain.
- **Guarded session close (§6.4):** After turn reaches a terminal state (`ABANDONED`, `FAILED`, etc.), close the `BLOCKED` session via `agent_session_stop`. Close releases logical session capacity slots; it **never** deletes workspaces, transcripts, or historical records.

## 3. Crash windows table (§14.3)

| Crash Window | Spec Behavior | Current Implementation |
|---|---|---|
| 1. Pre-acceptance | No turn created; safe to retry | No DB record exists; client may resubmit |
| 2. Post-acceptance, pre-launch intent | No-dispatch failure: `FINALIZING → FAILED` (`execution_started=false`) | Startup barrier marks turn `FAILED` (`DAEMON_RESTART_PRESTART`), releases pins and leases |
| 3. Post-launch intent, unrecorded PID | Conservative `UNKNOWN`; process may have spawned | Startup barrier marks turn `UNKNOWN`, session `BLOCKED`, locks held |
| 4. Worker wrote files, unrecorded completion | Conservative `UNKNOWN`; workspace quarantined | Marked `UNKNOWN`, session `BLOCKED`, lease retained, replay rejected |
| 5. Known completion, unapplied evidence | Recovery finishes `FINALIZING` via journaled evidence | recovery transitions the nonterminal turn to FINALIZING via turn_outcome_evidence and bootstrap's reconcileJournaledOutcomes() finishes the final snapshot and commits the terminal state WITHOUT new inference |
| 6. Terminal committed, response lost | Idempotent replay returns existing result | Ledger returns stored terminal capsule by idempotency key without re-execution |

## 4. Daemon restart procedure

1. **Stop / Termination:** Clean shutdown releases `<state_dir>/daemon.lock` and transitions state to `STOPPING`.
2. **Crashed Daemon:** A crashed process leaves `daemon.lock`. Starting a new daemon triggers `DAEMON_ALREADY_RUNNING`. Confirm no orphan node processes exist, then manually delete `<state_dir>/daemon.lock`.
3. **Recovery barrier (`RECOVERING`):** On startup, the daemon generates a new `daemon_incarnation`, audits pending intents, fails unfinished provisioning/capture tasks, marks running turns `UNKNOWN`, and restores reservations before entering `READY`.
4. **Post-READY state:** Quarantined workspaces and `BLOCKED` sessions stay blocked. Only unaffected workspaces accept new turns.

## 5. Storage cleanup (§15.3)

- **Semantics:** Cleanups are explicit operator operations (`previewCleanup` / `executeCleanup`).
  - *Protection:* Artifacts referenced by `artifact_pins` (active turns, anchors, holds) are never deleted.
  - *Tombstones:* Expired artifacts retain DB metadata records (`state = 'expired'`).
  - *Fail-closed:* If any retained manifest is unreadable or staging artifacts lack hashes, blob GC aborts (`gcSkippedReason`).
- **`STORAGE_LIMIT`:** Raised if unique retained blob storage exceeds the 2 GiB project cap or a source snapshot exceeds 256 MiB.
- **Action:** Inspect pins with `previewCleanup`, confirm stale historical review artifacts to expire, and invoke `executeCleanup`.

## 6. Adapter version drift (§13.3)

- **`PROVIDER_INCOMPATIBLE`:** Thrown when CLI versions, flags, or output schemas deviate from the verified adapter contract.
- **Revalidation:** Adapters are currently `documented` pending the native P0 spike. In-place binary upgrades break running sessions; operators must register updated profiles and spawn new sessions.

## 7. Escalation

- **Manual Intervention:** No operator reconciliation MCP tool exists yet in the bridge. Direct SQL modification is a last resort.
- **Backup Precaution:** Always stop the daemon and take a file-level copy of `registry.sqlite` and the state directory before manual SQL surgery.
