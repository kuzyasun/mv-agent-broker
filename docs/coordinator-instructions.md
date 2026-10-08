# Coordinator instructions for the operator pilot

Use the operator's configured routes; keep task descriptions and final results
concise. The coordinator owns decomposition, integration and final acceptance.

1. Call `broker_status` first and require `daemon_state: READY`. Then call
   `agents_list` for the exact selected allowed `project_id`, following every
   `next_cursor` until it is `null`; never choose from a partial page. Choose
   the exact `kind: route` entry with the desired role, model/effort, and
   tags, and record its `route_id`. Route entries carry the operator's
   readable `display_name`, an `enabled` flag, and effective `tags`
   (including the derived `multi-agent` tag); they are selection hints, not
   permissions, and never appear in worker prompts. Skip `enabled: false`
   entries: a disabled profile refuses new spawns before any provider work,
   while its existing sessions keep running. Several sessions may share one
   profile on distinct physical workspaces; the operator's pools constrain
   your selection, they do not add a new sandbox. Respect the two separate
   levels of parallelism: broker-level simultaneous worker sessions, and the
   vendor-internal native subagents a route's `native_subagents` preference
   requests — the latter stays advisory and unverified.
   Registered adapters/account labels do not establish
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
3. Use the single-agent route for small work. A large-task route — usually
   the one carrying the operator's `large` tag or the derived `multi-agent`
   tag — may request native
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
5. For substantive Git changes, use a separate reviewer profile in the same
   registered physical checkout (`current` or `worktree`). Pause all edits until
   the review finishes; the broker takes an exclusive checkout lease for its
   own turns, but cannot stop your editor or an external process. Send only
   `git_review_binding` with full `base_commit` and `target_commit` object IDs;
   `HEAD` must equal the target. Add `include_working_tree: true` to inspect
   staged, unstaged and nonignored untracked files without committing. For a
   purely uncommitted review, both commit IDs can be the current HEAD.
   The broker records a local fingerprint and checks for drift before dispatch
   and after completion. Git review creates no snapshots, source copies or
   full diff input: the reviewer uses Git and reads files in that checkout.
   To continue authoring in parallel, use a separate reviewer worktree at the
   committed target. For non-Git sources, explicitly use `review_slot` with
   `review_binding` (baseline/target snapshots). Never combine binding types.
   Request findings first with file/line, impact and reason. Deliver findings
   artifacts to follow-up worker tasks, then inspect the final diff yourself.
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
Git base/target IDs and working-tree fingerprint (or snapshot IDs), findings
artifacts and selected route fields.
After a pause, check live readiness and paginate discovery. A changed config
revision alone does not require replacement: compare the actual route and
bound session. Repeat a lost operation only with its original key and unchanged
arguments. `replayed_request: false` means no successful operation for that key
was retained; it does not prove there are no historical sessions or reviews.
Resolve known IDs and inspect the actual review binding instead of relying on
a stale pause note. A prior review applies to its exact target.

Unrelated provider catalogue changes do not require replacing a session:
preflight checks the selected model and effort. If the broker reports actual
CLI, launch-input, authentication or account-binding drift before acceptance,
create a new session with the same authorized route and task settings. This
does not require another operator approval or a different provider. Inspect
known turns first if execution status is uncertain. After upgrading from the
full-catalogue fingerprint implementation, old sessions need replacement;
do not rewrite their stored bindings.

Do not silently change a baseline to bypass an input limit. A findings-closure
review between an already reviewed target and a new target is a deliberate
follow-up with those findings as its checklist. A full checkpoint review keeps
its intended baseline and target. The complete diff budget is now 32 MiB by
default and can be changed in the operator UI; provider envelope limits still
apply. Compact hunks omit unchanged lines beyond three lines of context and
still contain every changed line for that original binding. Full source stays
in the baseline and target snapshots. The reduction is UTF-8 bytes, not tokens
or cost. Complete byte delivery does not establish review acceptance.

## Context efficiency (CE-01–CE-06)

Coordinator-side practices for less wasted context and fewer needless calls.
They use the existing API as-is and extend — never replace — the numbered
rules above; none of them widens worker permissions.

- **CE-01 — Bounded tasks keep required substance.** Every delegation states
  a concrete goal, acceptance criteria, change boundaries, the current
  workspace/review binding, needed sources and expected checks through the
  existing `task` fields (`goal`, `acceptance_criteria`, `relevant_paths`,
  `context`, `artifact_refs`, `checks`). Short context still preserves what
  defines correctness: API compatibility, invariants, known findings,
  dependencies, forbidden changes and open questions. `relevant_paths` is
  reading guidance, never an edit allowlist: worker access defaults to the
  whole project and only an explicitly configured `write_scope` narrows it.
  Never shrink snapshot coverage to named paths and never drop or summarize
  away a required `artifact_refs` entry to save tokens.
- **CE-02 — Result-first reading, cursor reuse.** Read the bounded
  `agent_turn_result` first — execution status, actual snapshot bindings,
  summary, concerns, checks and artifact references — then open specific
  diffs, findings or diagnostics only as a decision needs them (rule 4).
  Keep one numeric event cursor per turn, advance it from returned rows, and
  do not reread a committed prefix or poll a full transcript. A suspicious
  summary, truncation, failed check or evidence gap is a reason to read
  more, not to accept the work sooner; a missing or expired artifact is not
  an empty diff or a passed check.
- **CE-03 — Exact route, immutable session choices.** Spawn from the exact
  discovered `route_id` for the intended role/model/effort (rule 1), omit
  raw provider/model/account/role/policy fields, and do not silently
  escalate model or effort. Session configuration is immutable: changing
  model, effort, provider, account, role or policy profile means explicitly
  spawning a new session, never raising effort on the next turn of the same
  session.
- **CE-04 — Continue or hand off deliberately.** For implement → fix →
  verify, return fixes to the same fit worker with a fresh snapshot
  precondition and the sealed findings artifact as a required input, and
  reuse the same fit reviewer session with a new explicit `git_review_binding`
  (or snapshot `review_binding` for non-Git sources)
  for re-review (rules 4–5). Prefer an explicit fresh session with compact
  handoff only when the next topic is independent, prior history misleads,
  an immutable binding must change, or durable context is unavailable. A fresh
  session never bypasses an `UNKNOWN` turn or a quarantine; resolve those
  through the [recovery runbook](recovery-runbook.md) first. No automatic
  reset threshold ("fresh after N turns") without measured cause.
- **CE-05 — Claims versus observed evidence.** `SUCCEEDED` proves execution
  only; the agent-reported summary and its checks are claims. Decide from
  broker-observed fields (snapshot IDs, input manifest, error codes) plus
  your own inspection of the actual diff. Require summaries to reference
  versions: snapshot/turn/artifact IDs and source paths; a line number
  without a version is not a stable address. Keep contract requirements,
  broker-observed evidence, agent claims, assumptions and unknowns separate;
  never promote a worker's "checks passed" into independently verified.
- **CE-06 — Context, artifact storage and native memory differ.** The
  coordinator context, the executor's native conversation and broker
  artifacts/snapshots shrink independently: a small MCP response does not
  prove a small native context, and saving text on disk does not prove the
  model never read it. Each new send re-delivers required artifact IDs and
  receives fresh input bindings; never reuse a previous turn's materialized
  input paths, and a historical artifact mention does not guarantee its
  bytes are still retained (cleanup and operator holds keep applying).

### Bounded-task template

Template text the coordinator fills in — not a new schema. The request shape
stays closed (`additionalProperties: false`), so map every item onto the
existing `task` fields:

```markdown
Goal: <single concrete outcome to accept>          -> task.goal
Acceptance: <conditions to accept the work>        -> task.acceptance_criteria
Boundaries: <what to change; APIs/invariants kept> -> task.context
Starting sources: <paths, contracts, artifacts>    -> task.relevant_paths
Required inputs: <retained artifact IDs>           -> task.artifact_refs
Context: <decisions and dependencies this task needs> -> task.context
Unknowns: <to establish, not assume>               -> task.context
Checks: <existing checks; evidence to return>      -> task.checks
```

Ready-to-adapt payloads with placeholder IDs:
[coordinator examples](examples/coordinator/README.md).

### Compact handoff and safe fresh-session recipe

Use only after an explicit coordinator decision. This applies the spec §19
context-reuse scenario through the ordinary tools: no automatic compaction,
no native fork, no new API fields.

1. **Settle the old execution.** Require a terminal result, managed
   quiescence and a usable workspace before continuing the same mutation.
   Resolve `UNKNOWN` or quarantine through recovery first; a fresh session
   never bypasses them.
2. **Pin the current source state.** Use the valid final snapshot or an
   explicit `agent_workspace_snapshot` after checking drift. List
   outstanding findings, already-performed actions and evidence gaps.
3. **Write the compact handoff** from existing results and sources
   (template below). An extra summarizer call is optional; its cost and
   mistakes belong to the workflow. A coordinator-authored summary is
   navigation, not evidence.
4. **Spawn the new session explicitly** with an allowed route/profile and a
   new idempotency key. It is a new conversation — not `native_resume` of
   the old session — and its immutable configuration is fixed at spawn.
5. **Send the handoff** as bounded `task.context` text plus retained
   artifact IDs in `task.artifact_refs` and the correct binding
   (`workspace_precondition` for a physical worker). Do not reuse old
   materialized input paths; the new turn receives fresh bindings.
6. **Verify the new turn like any other**, then optionally guarded-stop the
   old idle session with `agent_session_stop`. Handoff deletes neither the
   old history/workspace nor retention obligations.

**Checkout caveat.** A fresh native session and a fresh worktree are
different operations. A broker-created worktree from `base_commit` does not
receive the previous worker's uncommitted changes; continue on a workspace
that the existing registration/spawn mechanisms can bind, or record the
blocker. Never invent an attach/restore API and never auto-commit, merge or
reset just to make a handoff look clean.

**Handoff template** (these labels live only inside `task.context`):

```markdown
# Compact handoff
Reason for a new session: ...
Previous session/turn IDs: ...
Current workspace and snapshot binding: ...
Next goal and acceptance criteria: ...
## Fixed decisions and constraints (with sources/versions)
## Work state
- Broker-observed: outcome, snapshots, available evidence
- Agent-reported (unverified): ...
- Already done (do not repeat): ...
## Remaining work: finding IDs, open questions, needed checks
## Sources for the new turn: retained artifact IDs; old input paths are invalid
## Boundaries: what not to change; what needs a separate coordinator decision
```

Gap mapping, verification status and the deferred benchmark protocol:
[post-v0.2 efficiency check](validation/post-v0.2-efficiency-check.md).

### Optional read-only researcher — deferred

The spawn schema accepts `role: "researcher"`, but role/schema presence is
not a tested native profile or a registered route in this pilot. Delegating
source mapping to a cheaper read-only executor stays a deferred experiment:
it is not a default stage of any task, and no profile or route is added for
it until the operator configures and verifies one. Even then, a researcher
summary remains a claim, its source map stays historical input, and the
researcher never receives broker tools.

## Operator storage cleanup

Storage preview and confirmed cleanup belong to the operator UI/private RPC,
not coordinator MCP tools or worker file cleanup. Keep open sessions and
required evidence pinned while they are needed; do not close sessions solely
to make historical content eligible. After explicit operator expiry,
ARTIFACT_EXPIRED means content is unavailable: preserve the recorded tombstone,
request a fresh required snapshot/input where appropriate, and never fabricate
an empty report or reset native history to hide it. A retry of a completed
cleanup handle does not run agents or spend inference quota.
