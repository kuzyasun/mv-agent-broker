# Coordinator instructions for the operator pilot

Use the operator's configured routes; keep task descriptions and final results
concise. The coordinator owns decomposition, integration and final acceptance.

1. Call `broker_status` first and require `daemon_state: READY`. Then call
   `agents_list` for the exact selected allowed `project_id`, following every
   `next_cursor` until it is `null`; never choose from a partial page. Choose
   the exact `kind: route` entry with the desired role and model/effort, and
   record its `route_id`. Registered adapters/account labels do not establish
   available vendor quota or a different vendor login. Respect known
   exhausted/failed routes; record an observed failure before explicitly
   choosing an allowed alternative. Do not silently escalate models, effort,
   or the number of agents.
   Account entries may carry an active `quota_pause` with scope, end time and
   source. Respect the shared pause across projects. A rejected send returns
   remaining wait metadata; after expiry explicitly submit the task, reusing
   the rejected operation's unchanged arguments/key if no turn was created.
   Only choose alternative routes already authorized by the operator.
   The ready project example is
   [DMP protocol](coordinator-projects/dmp-protocol.md).
2. Give one worker a complete bounded outcome, owned paths, required context,
   acceptance checks, and a deadline. Prefer separate worktrees for independent
   writes. Pass `route_id` with project, instructions, workspace and a unique
   idempotency key; omit raw provider/model/account/role/policy binding fields.
   Worker access defaults to the whole covered project. Treat assigned paths
   and `relevant_paths` as task guidance, never as an inferred edit allowlist.
   Supply narrower `policy_restrictions.write_scope` only when the operator
   explicitly requests that restriction; reviewers remain read-only.
   Omit `deadline_ms` to use the operator's configured default (one hour unless
   changed), or supply an explicit duration for this task. Do not hardcode the
   old 15-minute default. Quiet output alone is not evidence of a hung agent;
   ZCode may buffer output until completion. Use event deltas and the UI's last
   observed activity/deadline before deciding whether cancellation is needed.
3. Use the single-agent route for small work. A large-task route may request native
   subagents for independent pieces; the configured model/effort and any child
   count are operator-selected preferences, not proof of enforcement. Native
   subagent smoke evidence exists for Antigravity and Cursor; see
   [native subagent evidence](native-subagents.md). Avoid delegation chains and
   duplicate source investigations.
4. Send the task with its workspace precondition. Read event deltas with the last
   consumed numeric cursor and `wait_ms: 10000` (or `20000` for a longer bounded
   wait), advancing the cursor from returned rows. Check status as needed; once
   it is terminal, call `agent_turn_result` once. Do not poll a full transcript.
   A successful turn proves execution, while its reported checks and quality
   remain claims. Inspect the actual changes and run the smallest relevant
   acceptance check; broaden checks for a concrete integration risk.
5. For substantive changes, use a separate reviewer route with `review_slot` and
   the worker's original baseline/final target snapshot in `review_binding`.
   Request findings first with file/line, impact and reason. Deliver actual findings
   artifacts to follow-up worker tasks. The original coordinator verifies confirmed
   findings and reviews the final diff. Do not repeat vendor reviews for unchanged
   mechanical details.
6. New route settings apply to new sessions after restarting the daemon that
   loads the operator configuration. In shared-daemon mode, save the file,
   stop only when there are no active turns or pending intents, then start the
   daemon before rediscovering routes. The UI distinguishes saved settings that
   are applied, settings needing a daemon restart, and unknown application
   state; **Unsaved changes** is only a draft indicator. Keep existing sessions
   and evidence; replace a native session when its durable context is incompatible.
   An `UNKNOWN` execution does not authorize a replacement paid launch.
7. Record observed blockers in a short issue log: provider/model/version, route and
   turn IDs, error, reproduction, impact, workaround, status. Keep native thinking
   and credentials out of reports. Prioritize lost work, runaway paid execution,
   false completion and everyday workflow blockers; defer rare recoverable cases.

After a daemon restart, an updated stdio bridge reconnects on its next call.
Confirm `broker_status` is READY and rediscover the project's routes before
resuming. If transport failed during a submitted operation, inspect the known
session/turn first; the bridge never replays that call automatically. Resolve
the original operation using its original idempotency key rather than creating
a replacement paid turn merely because its response was lost. Bridges already
running an older version need one client reload to load the new reconnect code.

See [operator setup](operator-guide.md), [native child evidence](native-subagents.md),
and [the current pilot issue log](pilot-issues.md). These instructions can be copied
into a coordinator project's local guidance without changing the broker API.

## Resuming a checkpoint

Record session and turn IDs, original spawn/send idempotency keys, exact
baseline/target snapshots, findings artifacts and selected route fields.
After a pause, check live readiness and paginate discovery. A changed config
revision alone does not require replacement: compare the actual route and
bound session. Repeat a lost operation only with its original key and unchanged
arguments. `replayed_request: false` means no successful operation for that key
was retained; it does not prove there are no historical sessions or reviews.
Resolve known IDs and inspect the actual review binding instead of relying on
a stale pause note. A prior review applies to its exact target.

Do not silently change a baseline to bypass an input limit. A findings-closure
review between an already reviewed target and a new target is a deliberate
follow-up with those findings as its checklist. A full checkpoint review keeps
its intended baseline and target. The complete diff budget is now 32 MiB by
default and can be changed in the operator UI; provider envelope limits still
apply. Complete byte delivery does not establish review acceptance.
