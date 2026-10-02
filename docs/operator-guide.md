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

The optional `limits` block controls concurrency and the default turn deadline:

```json
"limits": {
  "globalUnfinishedTurns": 6,
  "quotaScopeUnfinishedTurns": 2,
  "hardTurnDeadlineMs": 3600000
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

The Profiles section edits routes with explicit project, configured account,
role, policy, model, effort, and advisory native-subagent settings. Route IDs
are editable profile names: the fields in each profile select its behavior.
A `*_worker` name normally describes one agent, `*_large` is a convention
that encourages native children, and `*_reviewer` describes an independent
review; explicit policy still controls permissions. A model refresh is an
explicit metadata-only action and supports manual model entry when a provider
is unavailable. Observed catalog timestamps are informational:
they do not prove authentication or quota. Use **New project wizard** to add
another repository. Browse local folders, select the repository folder, choose
file coverage and worker permissions, and copy agent profiles from an existing
project. Models, efforts, accounts, and native-subagent preferences are copied;
reviewers receive a separate read-only policy. You can also start without
profiles and add them afterwards.

The recommended coverage includes existing top-level files and folders, except
generated folders and broker/Git state. The narrower code-folder preset includes
common code folders and root files. Advanced fields allow explicit coverage
and write scopes. Newly introduced top-level files or folders need adding to
coverage; the presets are a snapshot of the folder, not an unrestricted wildcard.
Folder browsing lists names only and does not run an agent or spend quota.
Creation stages new project, workspace, policy, and coverage IDs locally;
**Save** writes the configuration. In shared-daemon mode, stop the daemon only
when there are no active turns or pending intents, then start it again to use
the new project. Existing sessions retain their bindings. The new project can
share the current configuration and state; a separate configuration/state is
optional.

### Snapshot size and build caches

A snapshot captures the declared source files, including untracked files. Git
ignore rules do not remove files from that contract. The source byte limit is
256 MiB (spec section 15.1), independent of provider token quota. Do not raise
the limit to accommodate disposable build caches.

The presets exclude known top-level output folders, including `artifacts`,
`node_modules`, `.dart_tool`, and `.angular`. Inspect nested output folders too.
Coverage prefixes must be disjoint: instead of source `web` plus exclusion
`web/node_modules`, declare source `web/src` and the root files inside `web`,
then exclude `web/node_modules`, `web/.angular`, and `web/dist`. Match the
worker policy's `write_scope` to the resulting source prefixes. Add new source
files or folders directly under `web` later; new files inside `web/src` are
already covered.

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

Use the project selector to filter profiles. Duplicate a profile to create a
different model/effort or review preset, then give it a unique ID using letters,
numbers, dot, underscore, or hyphen. Select permissions separately from the
role; choosing `reviewer` does not change a shared worker policy. The selected
policy's access is displayed, while the wizard creates a separate read-only
review policy. Changing shared bound policies requires new IDs/versions through
configuration rather than changing privileges of old sessions.

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
`auth_mode`). A route selects one account, model, effort, role, policy profile,
and project. The caller supplies the project, instructions, workspace, and
idempotency key. `agents_list` exposes routes with the same bounded paging as
the other discovery entries.

Account labels and quota scopes do not select a different vendor login or
subscription plan. They must reflect the CLI account actually in use. ZCode
Start Plan selection remains unverified; the current standalone route uses
Individual. Never put access tokens or API keys in this config.

Route roles are `worker`, `reviewer`, and `researcher`. Reviewers should use a
`review_slot` workspace and a review policy; workers normally use a current or
detached worktree. `native_subagents` is advisory prompt text only: it cannot
guarantee child count, child model, or permissions. The default is one broker
session with no native delegation preference.

To change a route, edit its JSON `model`, `effort`, or `native_subagents` and
restart the process that owns the settings: direct stdio mode itself, or the
idle shared daemon. New sessions use the new route; existing sessions keep
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
