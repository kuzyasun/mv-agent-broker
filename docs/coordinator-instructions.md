# Coordinator instructions

Agent Broker runs the operator's configured agents locally. The coordinator
selects profiles, gives tasks, integrates changes and decides whether to accept
the results. The broker does not choose another provider or model for you.

## Ordinary workflow

1. Call `broker_status` and require `daemon_state: READY`.
2. Read every `agents_list` page for the allowed project until `next_cursor` is
   null. Select an enabled `route_id` by role, model, effort and tags. Choose a
   healthy workspace from `compatible_workspace_ids`.
3. Create a session in that checkout, or reuse an idle session with the same
   settings. No provider inference starts during spawn. Permissions are only
   `read_only` or `workspace_write` for the whole project. To audit using a write
   worker profile, pass `access: "read_only"` at spawn. Task wording does not
   change permissions. Verify `agent_session_status.effective_policy.access`.
4. Send `session_id`, a unique `idempotency_key`, and `task` with a concrete
   `goal`. No snapshot, source coverage, full commit ID or review binding is
   needed for ordinary `current` and `worktree` sessions, including reviewers.
5. Read bounded `agent_turn_events` with the last consumed numeric cursor and
   `wait_ms: 10000` or `20000`. Advance the cursor from returned rows. Once the
   turn is terminal, read `agent_turn_result` and any needed report artifact.
6. Inspect actual changes and relevant checks. `SUCCEEDED` means the native
   execution completed; `quality_status: unreviewed` leaves acceptance to you.

Example read-only session on an operator-authorized worker profile:

```json
{
  "project_id": "<project from discovery>",
  "route_id": "<authorized route from discovery>",
  "idempotency_key": "<unique spawn key>",
  "instructions": "Inspect the project; do not modify project files.",
  "workspace": {"mode": "current", "workspace_id": "<discovered workspace>"},
  "access": "read_only"
}
```

Example task, valid for workers, researchers and physical-checkout reviewers:

```json
{
  "session_id": "<session ID>",
  "idempotency_key": "<unique task key>",
  "task": {
    "goal": "Review the uncommitted changes using Git and project files.",
    "relevant_paths": ["src"],
    "acceptance_criteria": ["Report actionable findings with file and line."],
    "checks": ["Read-only inspection; do not run services."]
  }
}
```

`context`, `checks`, `acceptance_criteria` and `relevant_paths` are optional task
guidance. Paths never create a file allowlist. `artifact_refs` is optional; use
only this project's retained `art-...` IDs when needed. File paths are not
artifact IDs, and `snap-...` IDs belong only to explicit snapshot comparison.
Omit `deadline_ms` to use the operator's configured default, normally one hour.

## Parallel work and review

Several sessions may use the same profile. Give parallel writers separate
worktrees; the broker allows only one writer in a physical checkout at a time,
including aliases of that checkout. Read-only sessions do not take that writer
lease and can run alongside writers. Read-only is an agent instruction and
configured access level, not verified native OS confinement.

A read-only report describes what the agent inspected. It does not certify
that the checkout stayed unchanged. External or coordinator edits do not turn
native completion into a scope violation. If a stable review target matters,
coordinate edits or use a separate worktree at the intended commit. A worktree
at HEAD alone does not contain uncommitted changes. Native subagents are vendor
children, separate from broker sessions; their mode and suggested child count
are advisory. Do not silently raise effort or substitute provider/model.

## Recovery, settings and quotas

If a send response is lost or execution is `UNKNOWN`, inspect the known session
and turn before starting another paid run. Retry a lost operation only with the
original idempotency key and unchanged arguments. The bridge reconnects after
a routine daemon restart but does not replay submitted operations itself.

Close an idle session with `agent_session_stop` and recreate it on the same
route when its native context is broken or no longer useful. CLI versions and
unrelated catalogue entries do not themselves invalidate a session: the broker
checks the selected installation/model/effort at dispatch. Actual authentication,
unavailable model and launch errors remain visible.

Save configuration and restart the daemon to apply new settings. New sessions
capture the selected profile settings. A revision-number change alone is not a
reason to replace a compatible session. Do not terminate active paid jobs to
apply configuration. Respect shared provider quota pauses and broker concurrency
limits; after quota recovery submit work explicitly.

## Optional snapshot comparison

`agent_workspace_snapshot` is an optional local diagnostic capture. Ordinary
delegation never requires it. A deliberately selected `review_slot` compares
two manual sealed snapshots; only that mode requires `review_binding` with
`baseline_snapshot_id` and `target_snapshot_id`. Its complete diff and source
delivery limits apply to that comparison, not to ordinary Git review.

Keep briefs and summaries concise. Read result artifacts only as needed instead
of copying full transcripts. Record incidents with route/turn ID, error and
reproduction; keep credentials and private native output out of Git.

See [operator setup](operator-guide.md), [provider notes](providers.md), and
[pilot incidents](pilot-issues.md).
