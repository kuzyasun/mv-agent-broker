# Coordinator instructions for the operator pilot

Use the operator's configured routes; keep task descriptions and final results
concise. The coordinator owns decomposition, integration and final acceptance.

1. Call `broker_status`, then page `agents_list` for the selected allowed project.
   Choose a `kind: route` entry with the desired role and model/effort. Registered
   adapters/account labels do not establish available vendor quota or a different
   vendor login. Respect known exhausted/failed routes; record an observed failure
   before explicitly choosing an allowed alternative. Do not silently escalate
   models, effort, or the number of agents.
2. Give one worker a complete bounded outcome, owned paths, required context,
   acceptance checks, and a deadline. Prefer separate worktrees for independent
   writes. Pass `route_id` with project, instructions, workspace and a unique
   idempotency key; omit raw provider/model/account/role/policy binding fields.
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
6. New route settings apply to new sessions after restarting the daemon that loads
   the operator configuration. Keep existing sessions
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
