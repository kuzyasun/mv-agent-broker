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
role, policy, model, effort, and advisory native-subagent settings. A model
refresh is an explicit metadata-only action and supports manual model entry
when a provider is unavailable. Observed catalog timestamps are informational:
they do not prove authentication or quota. The Projects wizard creates unique
project, current-workspace, review-slot, policy, and coverage IDs with
explicit source/exclusion/write-scope arrays. Existing sessions retain their
old bindings; use a new project and state directory for another repository.

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

Model refresh uses saved binary pins and accounts. Save advanced account/pin
changes before refreshing; use **Apply advanced edits to form** to update
selectors while editing. Configured/manual choices are not observed catalogs.
Effort **No override** means no explicit effort, while Cursor's literal `none`
is a separate catalog variant. Cursor fast variants retain their exact ID.
Parent settings do not establish the actual model or effort of native children.

The settings process is independent of MCP: restart MCP after saving, not just
the settings page. The project wizard can add a repository to the same state
using new IDs; a separate config/state is another option. The UI does not inspect
bound-session conflicts in the registry; daemon startup remains authoritative.

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
and `max_agents` to the desired advisory count. Repository child definitions
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
