# Coordinator tool-call examples

Small, ready-to-adapt MCP payloads for the rules in
[coordinator instructions](../../coordinator-instructions.md) (CE-01–CE-06).
Each file is one call in the obvious `{"tool": ..., "arguments": ...}`
wrapper; all IDs and paths are placeholders — replace them with data from
`agents_list`, `agent_session_status`, `agent_turn_status` and
`agent_turn_result` before use. Only fields of the advertised API 0.2 tools
appear here; the request schemas are closed (`additionalProperties: false`),
so do not add fields like tier, routing strategy or handoff markers.
Only `arguments` is the tool payload: `tool` and `note` belong to the example
wrapper and must not be passed as request fields.

| File | Tool | Scenario |
|---|---|---|
| [01-spawn-route-worker.json](01-spawn-route-worker.json) | `agent_session_spawn` | Route-based worker spawn: exact discovered `route_id`, no raw provider/model/role fields, new unique idempotency key |
| [02-send-worker-fix.json](02-send-worker-fix.json) | `agent_session_send` | Fix task to the same worker: fresh snapshot precondition, sealed findings artifact as a required input |
| [03-send-reviewer-binding.json](03-send-reviewer-binding.json) | `agent_session_send` | Git reviewer turn: `git_review_binding` only; includes uncommitted work, no snapshots or full diff input |
| [04-send-fresh-handoff.json](04-send-fresh-handoff.json) | `agent_session_send` | Optional explicit fresh-session handoff: compact handoff text in `task.context`, retained artifact IDs, new bindings |
| [05-spawn-reviewer-worktree.json](05-spawn-reviewer-worktree.json) | `agent_session_spawn` | Separate reviewer worktree at a committed target for parallel author progress |
| [06-send-reviewer-snapshot-fallback.json](06-send-reviewer-snapshot-fallback.json) | `agent_session_send` | Explicit snapshot review for non-Git sources |

Rules that hold for every example: the idempotency key marks one new logical
request (a transport replay reuses the same key and unchanged arguments);
`checks` are instructions to the worker, not a broker test runner; and no
example may run with invented IDs — resolve real sessions, snapshots and
sealed artifacts first.

Before example 03, spawn a separate reviewer route in the author's registered
physical workspace (reuse its workspace_id and mode). Pause writes through
completion. Omit include_working_tree for a clean committed target; use true
for staged, unstaged and nonignored new files. Snapshot review is explicit:
spawn review_slot and send only review_binding with baseline_snapshot_id and
target_snapshot_id.
