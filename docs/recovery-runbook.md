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

## 2a. Observed stale worktree provisioning quarantine

The supported operator workflow is intentionally narrower than UNKNOWN-turn
recovery:

1. Close the failed provisioning session through the guarded stop operation
   while the daemon is running.
   Closing the session is an idle-only lifecycle action and intentionally does
   **not** clear its workspace quarantine.
2. Stop the daemon cleanly. An existing `<state_dir>/daemon.lock`, including a
   stale lock, is a refusal condition; never remove it automatically.
3. Inspect the bounded evidence while offline:

   ```powershell
   npm run broker -- quarantine-inspect --config C:\ops\agent-broker.json --workspace-id <workspace-id>
   ```

4. Reconcile only a fully closed failed broker worktree with no native inference:

   ```powershell
   npm run broker -- reconcile-workspace --config C:\ops\agent-broker.json --workspace-id <workspace-id> --note "Confirmed failed allocation absent, old Git processes gone, no inference."
   ```

   The exact supported quarantine reason is
   `worktree-provisioning: git-add-failed`. The generated allocation path must
   be absent and absent from `git worktree list`; the journal must match the
   registered source common directory and generated session allocation under
   `<state_dir>/worktrees`, be in `adding` with no completion receipt, and have
   exactly one failed provision intent. A Git launch receipt is allowed only
   after all recorded processes are observed absent. All
   sessions bound to the target must be `CLOSED` with completed close intents,
   with no native context or turns. There must be no UNKNOWN/nonterminal turns,
   pending intents, or active execution/workspace reservations anywhere in the
   registry. Unrelated IDLE sessions and their session slots may remain.
5. Start the daemon again only after reconciliation succeeds.

The command performs a bounded read-only Windows process probe for any
recorded root/helper/owner PIDs and refuses if the probe is unavailable or a
PID exists. It makes a private consistent SQLite backup and JSON receipt under
`<state_dir>/recovery/` before revalidating guards inside `BEGIN IMMEDIATE`.
On success it changes only `workspaces.quarantined` and
`workspaces.quarantine_reason`, then appends
`operator_workspace_quarantine_reconciled`. It never deletes or adopts a path,
unregisters Git metadata, kills a process, removes a lock, releases unrelated
reservations, or rewrites session, intent, idempotency, native, or workspace
history. Other quarantine reasons and any native-dispatched/uncertain operation remain
unsupported and must stay quarantined.

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

1. **Stop / Termination:** Clean shutdown transitions state to `STOPPING`, rejects new spawn/send admission, drains accepted work with deadline supervision active, then stops the timer and releases `<state_dir>/daemon.lock`. Accepted idempotent requests remain replayable. Use `daemon.stop()` (or the bootstrapped lifecycle shutdown) before closing the database. Concurrent stops share one promise. A failed drain retains ownership and supervision; after resolving the failure an explicit stop retry is allowed. Do not close the database after a rejected stop.
2. **Crashed Daemon:** A crashed process leaves `daemon.lock`. Starting a new daemon triggers `DAEMON_ALREADY_RUNNING`. Confirm no orphan node processes exist, then manually delete `<state_dir>/daemon.lock`.
3. **Recovery barrier (`RECOVERING`):** On startup, the daemon generates a new `daemon_incarnation`, audits pending intents, fails unfinished provisioning/capture tasks, marks running turns `UNKNOWN`, and restores reservations before entering `READY`.
4. **Post-READY state:** Quarantined workspaces and `BLOCKED` sessions stay blocked. Only unaffected workspaces accept new turns.

`AB_DEADLINE_POLL_MS` defaults to 50ms and must be an integer from 5 to 60000;
invalid configuration is rejected before creating/opening state. Deadline scan
errors produce bounded stderr diagnostics and counters, then scans retry.
Failure/recovery diagnostic pairs are capped to once per minute. A scan failure
does not release execution resources or establish process quiescence.

## 5. Storage cleanup (§15.3)

- **Semantics:** Cleanups are explicit operator operations (`previewCleanup` / `executeCleanup`).
  - *Protection:* Artifacts referenced by `artifact_pins` (active turns, anchors, holds) are never deleted.
  - *Tombstones:* Expired artifacts retain DB metadata records (`state = 'expired'`).
  - *Fail-closed:* If any retained manifest is unreadable or staging artifacts lack hashes, blob GC aborts (`gcSkippedReason`).
- **`STORAGE_LIMIT`:** The 256 MiB per-source-capture cap is enforced. The
  specification's total project storage budget is not yet enforced; cleanup
  accounting must not be mistaken for admission-time budget enforcement.
- **Action:** Inspect pins with `previewCleanup`, confirm stale historical review artifacts to expire, and invoke `executeCleanup`.

## 6. Adapter version drift (§13.3)

- **`PROVIDER_INCOMPATIBLE`:** The core currently detects adapter-version
  drift. Native CLI-version preflight/revalidation is still incomplete.
- **Revalidation:** All five providers passed limited model/resume smoke;
  complete native role/profile acceptance remains open. Recheck CLI upgrades
  explicitly and create sessions matching the validated adapter profile.

## 7. Escalation

- **Manual Intervention:** The CLI reconciliation workflow above is the only
  supported operator clearing action, and only for its exact failed
  worktree case with no native inference. There is no generic force-release or
  turn-outcome reconciliation command. Direct SQL modification remains a last
  resort for unsupported cases.
- **Backup Precaution:** The supported reconciliation creates a private,
  consistent SQLite backup and JSON receipt before its guarded transaction.
  For any unsupported manual investigation, stop the daemon and take an
  offline file-level copy of `registry.sqlite` and relevant state before SQL
  surgery.
