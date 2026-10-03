# Operator guide

The operator entrypoint is a config-driven MCP server. It never stores
credentials: authentication remains owned by each installed CLI.

## Quick start with the mock provider

From a clean checkout:

```powershell
npm install
npm run --silent broker -- mcp-config --config docs/examples/operator.mock.json
```

Copy the emitted `mcpServers` entry into your MCP client for deliberate direct
stdio mode. That mode starts its own daemon in the same process and is separate
from shared-daemon operation. Its first start creates the state directory. For
a manual protocol diagnostic, use `npm run --silent broker -- stdio --config ...`
and send JSON-RPC to that process's stdin. Avoid starting two owners of the
same state directory.

```powershell
npm run --silent broker -- mcp-config --config C:\path\to\operator.json
```

The snippet uses absolute node, script, and config paths:

```json
{
  "mcpServers": {
    "agent-broker": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": ["--experimental-transform-types", "C:\\path\\to\\src\\operator\\main.ts", "stdio", "--config", "C:\\path\\to\\operator.json"]
    }
  }
}
```

`validate` only parses and checks the file:

```powershell
npm run broker -- validate --config docs/examples/operator.mock.json
```

The optional `limits` block controls concurrency, turn deadline and review delivery:

```json
"limits": {
  "globalUnfinishedTurns": 6,
  "quotaScopeUnfinishedTurns": 2,
  "hardTurnDeadlineMs": 3600000,
  "maxReviewDiffBytes": 33554432
}
```

These are unfinished broker turns across projects and the configured account
quota scope, not vendor token quotas or native child count. One unfinished
turn per logical session remains; native child preference is independent. The
defaults are `3` globally and `1` per quota scope. Values must be positive
finite safe integers. Save the file and restart the owning daemon while idle
before new sessions use changed limits.

The default turn deadline is **60 minutes**, measured from acceptance, including
startup and execution. Set **Default turn deadline (minutes)** in the UI, then
save and restart the idle daemon. `limits.hardTurnDeadlineMs` is stored in
milliseconds and accepts 1000–86400000 (up to 24 hours). The coordinator can
override the default for a particular `agent_session_send` with `deadline_ms`;
the configured default is not a ceiling on that explicit override. Standalone
daemon launches also accept `AB_TURN_DEADLINE_MS`.

Active jobs show elapsed time, the deadline, whether execution began, and the
last retained provider event. While the page is visible, status refreshes every
15 seconds without replacing form drafts or unchanged error disclosures. After
10 minutes without observed output, the UI displays a caution, not an automatic
cancellation. ZCode can buffer all output until completion; reasoning events
are not retained. Silence therefore cannot prove a hang. Cursor, Antigravity
and ZCode can wait for output until the turn deadline; the daemon still owns
deadline cancellation and waits for execution cleanup before releasing the job.
Recent turn errors also includes failed, timed-out, and unknown turns when no
provider error code was recorded. Expand a timed-out turn to inspect its cause
and partial-work guidance before submitting more paid work.
On a failed background refresh, open error details stay mounted and are labeled
as last observed data. Cursor, Antigravity and ZCode output timers have a 65-second
reserve beyond the deadline so the daemon's maximum 60-second scan interval can
cancel first. This reserve does not extend the accepted turn deadline.

**Complete review diff budget (MiB)** defaults to 32 MiB. The saved
`limits.maxReviewDiffBytes` accepts positive safe integer bytes up to 256 MiB.
Save and restart the idle daemon to apply it. This is the complete rendered
baseline-to-target diff budget, separate from snapshot size and each provider's
full input envelope limit. Over-budget delivery fails before inference; the
broker never truncates the required diff or changes the review binding.
The rendered diff keeps every added and deleted line, in order, with file
identity, line numbers and no-newline markers. Unchanged lines are limited to
three around each change; overlapping windows merge. Full unchanged source
stays in the sealed baseline and target snapshots. The smaller text is a UTF-8
byte reduction of unchanged context, not a token count, a cost figure, or a
measured native-reviewer saving. A compact complete diff that still exceeds
the budget is refused before inference.
Large inputs use the existing read-only file transport. Delivery establishes
the bytes supplied, not that a reviewer read or accepted every byte.

Dates throughout the UI use the broker host's regional locale, local timezone
and hour cycle, independent of the browser's interface language. With the
observed Ukrainian Windows regional settings this is `02.10.2026, 18:40:18`.
Display preferences are read-only metadata, never saved into operator config.

### Shared quota pauses

A definitive `QUOTA_EXHAUSTED` after native execution starts creates a persistent
pause for that account's quota scope across projects. New sends and the final
dispatch gate refuse with `execution_started: false`, scope, `blocked_until`,
remaining `retry_after_ms` and source. Other scopes keep working; existing paid
jobs are not cancelled. Successfully recorded operations still replay by their
original keys. Expiry admits an explicit new task; it never retries a failed turn.

A validated Antigravity diagnostic suffix such as `Resets in 54m59s.` supplies
the pause duration (positive, at most 24 hours). Without a usable suffix the
broker uses a **15-minute conservative policy**, explicitly labeled as policy
rather than a confirmed vendor reset. Timeouts, silence, cancellation and unknown
execution do not establish exhausted quota and never backfill a pause.

Runtime overview shows **Quota pauses** and their local end times. If you know
quota has recovered, **Clear quota pause** removes only that scope's active
pause through an authenticated, operator-only audited action. It runs no
inference, cancels no jobs, and changes no saved settings. A new provider error
can establish a new pause. This is observed failure handling, not a subscription
or remaining-token meter.

## Local settings UI

Start the settings page without starting a broker daemon or running a provider:

```powershell
npm run --silent broker -- ui --config C:\ops\agent-broker.json
npm run --silent broker -- ui --config C:\ops\agent-broker.json --port 0
```

The operator prints the actual loopback URL to stderr. The page is bound only
to `127.0.0.1`, uses a per-process token for API reads and writes, and serves
only its fixed UI assets. It loads the raw JSON so unknown fields and relative
paths remain visible and intact. Saving validates a clone with the same
operator validator, rejects stale revisions, writes an exact same-directory
backup, and atomically replaces the config. In shared-daemon mode, stop the
daemon only while idle and start it again to apply settings to new sessions;
reconnecting the bridge or settings page alone does not reload the daemon. The
UI can restart the same accepted daemon runtime while idle. It never runs
inference, exports credentials, or terminates existing paid jobs.

To run an independent background UI process that survives closing Codex or the
parent shell, launch the settings page via the tracked launcher script:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-ui.ps1 -ConfigPath C:\ops\agent-broker.json
```

Optional `-Port` (default `4318`, range `1..65535`) and `-NodePath` (defaults to
`node` on `PATH`) are accepted. The launcher verifies the accepted frozen
runtime from `operator-runtime.json` under `state_dir`, verifies runtime manifest
commit and config-path identity before launch, refuses an already-owned port,
and spawns only the UI via hidden `Win32_Process.Create`. It checks that the
launched process owns the loopback listener and serves HTTP 200 before returning
success (up to 10 seconds). Failed startup produces no success receipt and stops
only the launcher's own still-identified process. It emits a JSON receipt with
`url`, `pid`, UTC `creation_date` and `runtime_commit`, and saves one
`operator-ui-<port>.json` sidecar in `state_dir` without credentials. Sidecars are
informational: stale metadata does not reserve a port. Because it runs as an
independent process decoupled from the caller's process tree, closing Codex
leaves the UI process running. Closing Codex differs
from restarting Windows: the launcher does not install a service supervisor or
autostart scheduler, so a Windows reboot terminates the process. The interactive
foreground `ui` command remains available whenever direct console logging or
ephemeral execution is desired.

The Profiles page shows three pools — Workers, Reviewers, Researchers — holding
this project's agent profiles. Each profile card has a readable name, an
enabled switch, provider/account/model/effort, an explicit policy, tags, and
advisory native-subagent settings. Add profiles per pool; duplicate, delete,
move a profile to another role, or change its project at any time — a
duplicate always receives a new technical route ID. Disabled profiles stay
visible and editable: the broker refuses new sessions started by route ID
from them, existing sessions keep working, and replaying an accepted
idempotency key still returns its accepted session. Disabling is a named
profile selection control, not provider or account revocation. Route IDs are
the internal MCP binding and stay in each card's advanced details. A model
refresh is an explicit metadata-only action and supports manual model entry
when a provider is unavailable. Observed catalog timestamps are
informational: they do not prove authentication or quota. Use **New project
wizard** to add another repository. Browse local folders, select the
repository folder, choose file coverage and worker permissions, and copy
agent profiles from an existing project. Readable names, tags, enablement,
models, efforts, accounts, and native-subagent preferences are copied to new
route IDs; reviewer and researcher copies receive the separate read-only
policy. You can also start without profiles and add them afterwards.

Tags are coordinator selection hints, never permissions: toggle the
`default` and `large` chips or enter custom lower-case tags (letters,
numbers, hyphen, underscore; 1-32 characters each, at most 12 stored).
Several profiles may carry `default`; it is a preference, not an exclusive
choice or a concurrency cap. The `multi-agent` tag is derived from the
native-subagents mode (`prefer` or `auto`) and shown for context in the UI
and discovery, but it cannot be stored or toggled — saving rejects it. The
tag filter includes the derived tag; filtering never hides the other pools'
Add-profile controls and disabled cards stay editable.

The recommended coverage is the whole project folder: `source_prefixes: ["."]`
covers every current and future top-level file and folder, except generated
folders and broker/Git state that the preset excludes. The default worker
policy then carries no `write_scope`: workers may write the whole covered
project, including entries created after the project was added. The narrower
code-folder preset and the advanced fields are deliberate restrictions that
enumerate explicit coverage and write scopes; use them only when a project
really must stay narrow. Folder browsing lists names only and does not run an
agent or spend quota.
Creation stages new project, workspace, policy, and coverage IDs locally;
**Save** writes the configuration. In shared-daemon mode, stop the daemon only
when there are no active turns or pending intents, then start it again to use
the new project. Existing sessions retain their bindings. The new project can
share the current configuration and state; a separate configuration/state is
optional.

### Storage and cleanup

**Storage and cleanup** operates on the selected project's broker data through
the owning daemon. Choose **Storage project**, set **Keep data at least (days)**
(default 7), then **Preview cleanup**. This is a per-action retention choice,
not automatic deletion or a saved background schedule. Use 0 only when you
intend to include all unpinned historical data.

The preview counts registered blobs, old eligible artifacts, protected objects,
protection reasons and unique reclaimable registered bytes. It retains newer
artifacts, recent publications and every referenced blob in retained snapshot
manifests. Shared blobs count once. SQLite, working copies, materialized inputs,
provider history and unregistered files are excluded: the figure is not total
physical disk usage, a storage-pressure admission gate or vendor quota.

**Clear previewed data** asks for confirmation naming the project and previewed
amount. A five-minute daemon-owned preview handle binds the exact candidates;
execution rechecks live pins, authorization, manifest references and in-flight
publications. Active work, open-session roots, unknown-execution recovery and
operator-held data remain protected. Newly protected candidates are skipped,
and newly created objects are not silently added. Retained unreadable manifests
or an in-flight publication block deletion; their storage totals still appear.
Old unpinned staging manifests owned only by terminal `FAILED` snapshots are
eligible under the same retention cutoff. Their failed snapshot record and
error stay in the registry. A live `CAPTURING` owner, unknown owner, newer data
or a recovery pin remains protected; retained unpublished data blocks cleanup.
No control clears a quarantine, closes an agent, deletes a repository/worktree,
removes provider state or runs inference.

Changing project/retention, reload or saving configuration clears the UI preview.
An expired or displaced preview, or a daemon restart, requires a fresh preview.
The daemon keeps at most 20 handles; creating more displaces the oldest. There is no
automatic retry; a repeated execute request with the same still-valid completed
handle replays its recorded result without another mutation. The daemon records
an operator audit event with project/counts, not prompts or preview tokens.

Historical expired artifacts retain metadata tombstones. Their content is no
longer available (`ARTIFACT_EXPIRED`); choose retention accordingly if you need
old reports or unpinned snapshots later. Cleanup does not purge turn metadata,
idempotency history or native conversations. Current native sessions keep their
bindings and protected evidence. Preview again after cleanup for current totals.

### Snapshot size and build caches

A snapshot captures the declared source files, including untracked files. Git
ignore rules do not remove files from that contract. The source byte limit is
256 MiB (spec section 15.1), independent of provider token quota. Do not raise
the limit to accommodate disposable build caches.

The presets exclude known top-level output folders, including `artifacts`,
`node_modules`, `.dart_tool`, and `.angular`; these exclusions intentionally
override the whole-project source. Inspect nested output folders too. For a
nested cache such as `web/node_modules`, either exclude `web/node_modules`
explicitly alongside the root source, or restrict coverage and the worker
policy's `write_scope` to `web/src` plus the root files inside `web`. New
files inside `web/src` are then already covered; under the whole-project
preset every new location is covered automatically.

When replacing a coverage or policy already bound to a session, use a new
profile ID for future sessions and keep the historical evidence. After saving,
stop and start the shared daemon only when there are no active turns or pending
intents. Verify `agent_workspace_snapshot` before paying for a worker or
reviewer turn.

Broker-managed Windows Git operations enable `core.longpaths` for each
invocation; they do not change repository or global Git configuration. A
detached worktree contains the selected commit only. To review unfinished
changes, use a current-checkout snapshot with a sealed baseline/target review
binding, or explicitly transfer only the intended changes into an isolated
checkout before capturing it.

The Connection section emits MCP JSON and Codex TOML that attach to the shared
daemon through `src/bridge/main-stdio.ts`, with `AB_STATE_DIR` and
`AB_COORDINATOR_ID`. It reuses the accepted runtime path when one exists;
otherwise it points at the available bridge source. Start the daemon before
attaching. Reload a client after copying a snippet if its bridge process is
already running; this reconnects the bridge but does not reload daemon settings.

Use the project selector to filter profiles, and the tag filter to narrow by
an effective tag including the derived `multi-agent` tag. Duplicate a profile
to create a different model/effort or review preset, give it a readable name
and a unique technical ID using letters, numbers, dot, underscore, or hyphen.
Select permissions separately from the role: choosing `reviewer` does not
change a shared worker policy, while the role switch and the wizard give
reviewer and researcher profiles only read-only policy choices — an already
suitable read-only policy is retained, otherwise the single unambiguous
read-only policy is selected, otherwise the choice stays explicitly
unresolved. Config validation rejects a named reviewer or researcher profile
with a non-read-only policy, so saving through JSON cannot silently
reintroduce that mistake; workers may intentionally be read-only. The
selected policy's access is displayed, while the wizard creates a separate
read-only review policy. Changing shared bound policies requires new
IDs/versions through configuration rather than changing privileges of old
sessions.

Click **Refresh model catalogue**, then choose from the **Model** dropdown.
**Search models** filters by part of a model ID, independently of the selected
model. Each card shows the catalogue entry count and refresh time. Antigravity
effort variants are grouped under their base model. **Enter a model ID manually**
allows a configured or custom ID; an ID absent from the catalogue is labelled
unobserved. Refresh does not change the selected model. Selecting a different
model keeps a compatible effort or selects an effort offered by that model.

Model refresh uses saved binary pins and accounts. Save advanced account/pin
changes before refreshing; use **Apply advanced edits to form** to update
selectors while editing. Configured/manual choices are not observed catalogs.
Effort **No override** means no explicit effort, while Cursor's literal `none`
is a separate catalog variant. Cursor fast variants retain their exact ID.
Parent settings do not establish the actual model or effort of native children.

Native-subagent settings have three modes. `off` requests one agent,
`prefer` suggests native children for independent pieces, and `auto` lets the
agent decide whether delegation is useful while the vendor chooses the number
of children. The suggested maximum children field is advisory, not an exact
desired count or an enforced cap; it guides delegation only in `prefer` mode.
`auto` stores no numeric count. There is no `zcode_large`
preset because ZCode native children are not verified; a ZCode worker can
still implement a large task. Duplicate a profile to make another preset.

The settings process is independent of MCP. After saving, direct stdio mode
must be started again, while shared-daemon mode requires stopping the daemon
only when idle and starting it again. Stop refuses active turns and pending
intents; it never kills paid work. Restarting only the settings page or only a
shared-daemon bridge does not apply saved route settings. An updated bridge
reconnects after the shared daemon returns. The project wizard can add a
repository to the same state
using new IDs; a separate config/state is another option. The UI does not inspect
bound-session conflicts in the registry; daemon startup remains authoritative.

The UI exposes the same global and quota-scope unfinished-turn controls. Its
explanation refers to broker turns rather than vendor token quotas or native
child count; the advanced JSON editor remains available for the full config.

The shared daemon and each client's stdio bridge are separate processes. An
updated bridge reconnects before its next discovery or tool call after the
daemon restarts, rereads the bridge token, and authenticates the same
coordinator. If the daemon is unavailable, the call fails; a later call can
connect once it returns. A tool call interrupted after dispatch is reported as
an error and is never automatically replayed. Inspect its session/turn or reuse
the original idempotency key explicitly when resolving an uncertain outcome.
Reload an already running older bridge once to load this behavior; updating
files on disk cannot change code already loaded by that process.

## Accounts, roles, and routes

Each account is a provider binding (`provider`, quota scope, and CLI-owned
`auth_mode`). A route is one project agent profile: an account, model, effort,
role, policy profile, and project, plus optional coordinator-selection
metadata — `display_name` (readable name; absent shows the ID), `enabled`
(omitted means enabled), and `tags` (at most 12 stored lower-case tokens of
letters, numbers, hyphen, underscore, beginning with a letter or number).
`default` and `large` are ordinary hints; several profiles may carry
`default`. The reserved `multi-agent` tag is derived from
`native_subagents.mode` (`prefer` or `auto`), published with the effective
tags, and rejected if stored. Tags never change permissions, model, effort,
or deadlines, and metadata is never appended to worker prompts — the
coordinator consumes it. Discovery publishes name, enabled flag, and
effective tags in every route entry, including disabled entries, so
selection works from live metadata.

Setting `"enabled": false` refuses NEW spawns that select the route by
`route_id` with `INVALID_REQUEST` and `execution_started: false`, checked
after the committed idempotency replay and before any preflight,
provisioning, or inference, and repeated inside the authoritative admission
transaction. It is a named-profile selection control, not provider or
account revocation: project authorization and the route/project match are
checked first (a foreign-project route stays `UNAUTHORIZED`), existing bound
sessions continue, raw explicit spawns without `route_id` keep their
existing validation, and replaying an accepted key returns the accepted
session unchanged — an open PROVISIONING window still completes. Metadata
edits never invalidate a committed same-key replay, while genuinely
conflicting arguments still conflict.

The caller supplies the project, instructions, workspace, and
idempotency key. `agents_list` exposes routes with the same bounded paging as
the other discovery entries. Multiple sessions may run from the same profile
on distinct physical workspaces — a profile is not an execution slot; the
existing concurrency, quota-scope, session-cap, and physical checkout lease
guards remain in effect.

Account labels and quota scopes do not select a different vendor login or
subscription plan. They must reflect the CLI account actually in use. ZCode
Start Plan selection remains unverified; the current standalone route uses
Individual. Never put access tokens or API keys in this config.

Route roles are `worker`, `reviewer`, and `researcher`. Reviewers should use a
`review_slot` workspace and a review policy; workers normally use a current or
detached worktree. `native_subagents` is advisory prompt text only: it cannot
guarantee child count, child model, or permissions. The default is one broker
session with no native delegation preference.

To change a route's behavior, edit its JSON `model`, `effort`, or
`native_subagents` and restart the process that owns the settings: direct
stdio mode itself, or the idle shared daemon. Name, enabled flag, and tags
are selection metadata that also take effect on restart. New sessions use
the new route; existing sessions keep
their immutable provider, account, model, effort, role, policy, and workspace
settings. A raw `agent_session_spawn` may select `route_id`, or may continue
using the existing explicit provider/account/model/role/policy fields. Mixing
the two forms is rejected.

Cursor effort is part of the catalog model ID: for example
`gpt-5.6-sol` plus `high` resolves to `gpt-5.6-sol-high`. An already-suffixed
exact ID is retained. Unsupported or contradictory combinations fail before
inference; Cursor has no `--effort` flag.

Cursor adapter 0.2.9 changes the durable provider-binding version. Retain old
sessions/artifacts, but create replacement native sessions when an older bound
context fails revalidation; the broker does not silently substitute settings.

The economical Cursor worker example is explicitly
`gpt-5.6-luna-high` with `high`. The larger
`gpt-5.6-sol-high`/`high` route is an editable example, not an operator
selected default. The Windows example also shows Antigravity
`gemini-3.8-flash`/`medium` and ZCode Individual `GLM-5.3-Flash`/`max`, plus
`GLM-5.3`/`high` for review. Antigravity high author turns currently have a
retained server-500 incident in the pilot issue log.
Claude Code and Codex are intentionally not used by these examples.

## Windows and another repository

Copy `docs/examples/operator.windows.json`, replace the `C:\\...` paths, and
set each binary pin to an installed executable. `state_dir` should be short
and owned by the operator. To operate on another repository, change that
repository's workspace `canonical_path` before its first session. To add a new
repository after sessions exist, add a new project/workspace ID (and allow the
project for the coordinator), or use a separate config/state directory. Reusing
a bound workspace ID for another path is rejected. Declare the repository's
source folders in its coverage profile and exclude its state/build directories.

The `daemon` command keeps one owned state directory and serves the existing
private RPC. Generate an existing-daemon bridge snippet with `--connect`;
shutdown drains accepted work:

```powershell
npm run --silent broker -- daemon --config 'C:\ops\agent-broker.json'
npm run --silent broker -- mcp-config --connect --config 'C:\ops\agent-broker.json'
```

For a Codex TOML client, put the emitted `command` and `args` under
`[mcp_servers.agent_broker]`; copy emitted bridge environment values to
`[mcp_servers.agent_broker.env]` when using `--connect`.

The raw `src/daemon/main.ts` entry point (including self-development copies)
may also set
`AB_GLOBAL_UNFINISHED_TURNS=6` and
`AB_QUOTA_SCOPE_UNFINISHED_TURNS=2`; these raw environment overrides use the
same positive safe-integer validation and do not change other daemon defaults.
Operator `start`, `daemon`, and direct `stdio` use the JSON `limits` block.

### Reproducible operator runtime

Use `start` for a detached daemon launched from a private runtime exported
from a Git commit. The runtime is separate from the development checkout:
dirty or untracked source is never copied, and the original absolute config
path remains the source of relative configuration paths.

```powershell
npm run --silent broker -- start --config 'C:\ops\agent-broker.json'
npm run --silent broker -- start --config 'C:\ops\agent-broker.json' --ref '<accepted-commit>'
npm run --silent broker -- status --config 'C:\ops\agent-broker.json'
npm run --silent broker -- stop --config 'C:\ops\agent-broker.json'
```

`start` waits for an authenticated `READY` response and reports the pinned
commit, runtime path, state directory, and daemon PID. A second owner is
refused by the state-directory lock. `status` reports live readiness, active
turns, and pending intents. The commit comes from the responding daemon's
exported manifest. An absent connection reports `stopped` only when there is
no ownership lock; an unresolved lock or RPC failure reports `unavailable`.
Authentication refusals remain explicit errors. After `start`, generate the
client snippet with `mcp-config --connect`: it uses the exported bridge path.
`stop` is graceful and idle-only: any active or unknown
turn, or any pending lifecycle intent, causes a refusal and leaves the daemon
running. It never kills a PID, removes a lock, cancels work, or clears a
quarantine. A new version requires an explicit new accepted commit/runtime;
there is no hot reload or automatic service installation.

### Stale failed worktree quarantine

The operator has one deliberately narrow offline recovery workflow for a
broker-created worktree that failed with the exact reason
`worktree-provisioning: git-add-failed`. Close the failed provisioning session
through the normal guarded session-stop flow while the daemon is running,
then stop the daemon cleanly. A
session close intentionally preserves its workspace quarantine; it does not
delete the allocation, unregister Git metadata, or rewrite the failed session
or provision intent.

Inspect the registry without applying configuration or trusting `READY` as an
admission proof:

```powershell
npm run broker -- quarantine-inspect --config C:\ops\agent-broker.json
npm run broker -- quarantine-inspect --config C:\ops\agent-broker.json --workspace-id <workspace-id>
```

After confirming the output and the operator explanation, reconcile the one
supported case:

```powershell
npm run broker -- reconcile-workspace --config C:\ops\agent-broker.json --workspace-id <workspace-id> --note "Confirmed failed allocation absent, old Git processes gone, no inference."
```

Reconciliation refuses an existing state-directory lock, active or unknown
turns, pending intents, active execution/workspace reservations, open target sessions, native context,
existing or registered allocation paths, mismatched journals, live recorded
Windows PIDs, and every other quarantine reason. Unrelated IDLE sessions and
their session-capacity slots may remain. Git may have launched; no native
inference may have started. It takes a private consistent
SQLite backup and writes a JSON receipt under `<state_dir>/recovery/`, then
atomically clears only the target quarantine and appends an audit event. It
never stops or kills a process, removes a lock, deletes workspace contents,
prunes Git metadata, adopts a path, or releases unrelated resources. Start
the daemon again only after the command succeeds.

## Coordinator startup and new projects

After attaching a bridge, call `broker_status` first and require `daemon_state`
`READY`. For the exact project, call `agents_list` with a deliberate
`project_id` and `limit` (for example `100`), then repeat with each returned
`next_cursor` until it is `null`; do not choose from a partial page. Select the
exact `kind: "route"` and record its `route_id`, then use the exact registered
workspace ID in `agent_session_spawn`. The UI's **Saved settings applied**,
**Saved settings need daemon restart**, and **Application state unknown** are
separate from the draft's **Unsaved changes** label; saving alone is not proof
that the daemon loaded the file.

For a ready project configuration and coordinator example, see
[docs/coordinator-projects/dmp-protocol.md](coordinator-projects/dmp-protocol.md).
The new-project wizard only stages IDs and bindings locally. Save them, then
use **Restart daemon** while the shared daemon is idle before discovering the
new project.

## Restarting and inspecting failures in the UI

Save the configuration, then click **Restart daemon** in Runtime overview.
The button requires a saved draft and a fresh observed idle status; use
**Refresh status** after another coordinator finishes work. The daemon also
checks activity at stop time and refuses active, unknown, or pending work.
The restart reuses the current accepted runtime, including when the UI runs
from a frozen copy without Git. It applies saved settings to new sessions;
existing sessions retain their bound models. This button does not upgrade code.
Failures remain visible and require status refresh before another attempt.

Expand **Show error details** under Recent turn errors to read the retained
failure message, execution flag, session/context state, current quarantine,
timestamps, and snapshot IDs. **Suggested next step** is guidance based on
the code, separate from recorded facts. Missing retained history stays
unavailable. **Retry details** repeats only the metadata request.
No detail control runs inference, resumes a turn, or clears quarantine.
Unknown execution or quarantine requires coordinator/operator recovery first.

Details use authenticated private operator RPC and allowlisted metadata.
Error text is bounded and common credential patterns are masked; full prompts,
provider logs, native conversation references, and artifacts are not returned.

## Selecting a route from a coordinator

Use [these short coordinator instructions](coordinator-instructions.md) in the
client's project guidance to establish the worker/reviewer workflow.

Page `agents_list` for the project and choose an entry with `kind: "route"`.
Entries carry the readable `display_name`, the `enabled` flag, and the
effective `tags` (including the derived `multi-agent` tag), including
disabled entries so selection can avoid them up front; a disabled profile
refuses new spawns with `INVALID_REQUEST` even though it stays discoverable.
For example, call `agent_session_spawn` with:

```json
{
  "project_id": "repo-a", "idempotency_key": "unique-spawn-key",
  "route_id": "cursor-economical-worker", "instructions": "Implement the assigned task.",
  "workspace": { "mode": "current", "workspace_id": "repo-a-current" }
}
```

Choose the large-task example for independent parallel work only after editing
its model/effort to your preference. Set `native_subagents.mode` to `prefer`
with a positive `max_agents` when an advisory count is useful, or to `auto` to
let the agent and vendor decide. Repository child definitions
can select separate models: Cursor reads `.cursor/agents/*.md` with YAML
`name`, `description`, `model`, `readonly`, `is_background`; Antigravity reads
`.agents/agents/*.md` with `name`, `description`, `tools`, `model: inherit`,
`mainAgent`, and `subagent`. Include definitions in coverage when reviewing
their edits. See the linked native-subagent documentation for tested examples
and limits. Changing the parent route does not guarantee child settings.

## Review workflow and limitations

Use a worker route to make changes in a worktree, capture the resulting
snapshot, then create a reviewer session with a review-slot route and the
baseline/target binding. Native subagents do not replace the independent
broker reviewer.

See [native subagent notes](native-subagents.md), [pilot issues](pilot-issues.md),
and the [provider capability matrix](provider-capabilities.md). No guide
command performs live authentication or CLI probes; native readiness happens
only when a pinned provider route is admitted.
