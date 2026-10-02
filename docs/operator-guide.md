# Operator guide

The operator entrypoint is a config-driven MCP server. It never stores
credentials: authentication remains owned by each installed CLI.

## Quick start with the mock provider

From a clean checkout:

```powershell
npm install
npm run --silent broker -- mcp-config --config docs/examples/operator.mock.json
```

Copy the emitted `mcpServers` entry into your MCP client. The client starts the
stdio server; its first start creates the state directory. For a manual protocol
diagnostic, use `npm run --silent broker -- stdio --config ...` and send JSON-RPC
to that process's stdin. Avoid starting two owners of the same state directory.

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
backup, and atomically replaces the config. A save reports that the operator
must be restarted; it never starts a daemon, edits the registry, runs
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
**Save** writes the configuration, then restart MCP to use the new project.
Existing sessions retain their bindings. The new project can share the current
configuration and state; a separate configuration/state is optional.

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
profile ID for future sessions and keep the historical evidence. Restart the
shared daemon after saving. Verify `agent_workspace_snapshot` before paying
for a worker or reviewer turn.

Broker-managed Windows Git operations enable `core.longpaths` for each
invocation; they do not change repository or global Git configuration. A
detached worktree contains the selected commit only. To review unfinished
changes, use a current-checkout snapshot with a sealed baseline/target review
binding, or explicitly transfer only the intended changes into an isolated
checkout before capturing it.

The Connection section emits MCP JSON and Codex TOML using the same absolute
config path, node executable, and operator script. Restart a client after
copying a snippet so new sessions use the saved routes.

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

The settings process is independent of MCP. After saving, restart the process
that loads the configuration: the MCP server for direct stdio mode, or the
shared daemon for `--connect` mode. Restarting only the settings page or only
a shared-daemon bridge does not apply saved route settings. An updated bridge
reconnects after the shared daemon returns. The project wizard can add a
repository to the same state
using new IDs; a separate config/state is another option. The UI does not inspect
bound-session conflicts in the registry; daemon startup remains authoritative.

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
restart the operator. New sessions use the new route; existing sessions keep
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
npm run broker -- daemon --config C:\ops\agent-broker.json
npm run --silent broker -- mcp-config --connect --config C:\ops\agent-broker.json
```

For a Codex TOML client, put the emitted `command` and `args` under
`[mcp_servers.agent_broker]`; copy emitted bridge environment values to
`[mcp_servers.agent_broker.env]` when using `--connect`.

### Reproducible operator runtime

Use `start` for a detached daemon launched from a private runtime exported
from a Git commit. The runtime is separate from the development checkout:
dirty or untracked source is never copied, and the original absolute config
path remains the source of relative configuration paths.

```powershell
npm run broker -- start --config C:\ops\agent-broker.json
npm run broker -- start --config C:\ops\agent-broker.json --ref <accepted-commit>
npm run broker -- status --config C:\ops\agent-broker.json
npm run broker -- stop --config C:\ops\agent-broker.json
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
