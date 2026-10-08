# Agent Broker

Agent Broker lets a coordinator use coding agents from Cursor, Antigravity,
ZCode, Codex and Claude Code through one local MCP server. You choose the
providers, models, effort and permissions. The coordinator splits the work,
selects your profiles, checks results and asks a separate agent for review.

One shared daemon serves several projects. Each project has its own folders,
sessions and artifacts; provider quotas and broker concurrency limits are shared.

## Install and start

Requirements: **Node.js 24 or newer**, Git for project worktrees, and the CLIs
of the providers you want to use. Windows is the verified host; its detached
launchers use the built-in Windows PowerShell. Sign in through each vendor CLI.
The broker reuses that login.

The npm package is prepared locally; it has not been published to the registry.
Build it from this repository:

```powershell
npm ci
npm run release:pack
npm install --global .\releases\gemslibe-agent-broker-0.3.0.tgz
agent-broker --version
```

Someone receiving the `.tgz` only needs the `npm install --global` command.
The package contains compiled JavaScript, ready-made UI styles and the provider
helper scripts. Runtime installation has no npm dependencies.

Create a configuration outside the installed package:

```powershell
$config = Join-Path $env:LOCALAPPDATA 'AgentBroker\operator.json'
agent-broker init --config $config
agent-broker ui --config $config
```

Open **http://127.0.0.1:4318/**. Keep the UI terminal open. `init` creates an
empty configuration and refuses to overwrite an existing file. The state
folder is `agent-broker-state` beside that configuration.

## Configure providers and a project

First open **Advanced settings**. Add the providers you use to **Accounts JSON**:

```json
[
  {"account_profile_id":"cursor","provider":"cursor","quota_scope_id":"cursor","auth_mode":"cli-owned"},
  {"account_profile_id":"agy","provider":"antigravity","quota_scope_id":"antigravity","auth_mode":"cli-owned"},
  {"account_profile_id":"zcode-individual","provider":"zcode","quota_scope_id":"zcode-individual","auth_mode":"cli-owned"}
]
```

Remove unused entries. An account ID is a broker label; it does not create a
vendor login or switch subscription plans. Profiles using the same real CLI
account should share its quota scope across projects.

In **Binary pins JSON**, enter the actual installed paths. Example Windows
paths below require replacing `<you>`:

```json
{
  "cursor":"C:\\Users\\<you>\\AppData\\Local\\cursor-agent\\cursor-agent.ps1",
  "antigravity":"C:\\Users\\<you>\\AppData\\Local\\agy\\bin\\agy.exe",
  "zcode":"C:\\Users\\<you>\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs"
}
```

Other pins are `codex`, `claude-code`, optional `zcode-node` and `zcode-config`.
Use **Apply advanced edits to form**, then **Save**.

Provider differences that matter:

| Provider | Setup and model selection |
| --- | --- |
| Cursor | Use the agent CLI, separate from the editor launcher. Refresh its catalogue and select the complete model ID; some IDs include the effort. |
| Antigravity | Use `agy`, sign in through its CLI, then refresh the catalogue. |
| ZCode | The Desktop bundle `zcode.cjs` works with Node. Desktop login can differ from CLI login. The adapter currently supports the Individual plan with `GLM-5.3-Flash` or `GLM-5.3`, and `low`, `high`, `max` effort. Start Plan Free is not supported by this adapter. |
| Codex | Use the Codex CLI executable and its existing CLI login. |
| Claude Code | Use the Claude Code CLI and its existing CLI login. |
| Mock | Deterministic local responses for development; no paid inference. |

If ZCode specifically reports missing CLI authentication, log in from a
separate PowerShell terminal using the Desktop bundle. These overrides keep
its login configuration separate from Desktop model defaults:

```powershell
$bundle = Join-Path $env:LOCALAPPDATA 'Programs\ZCode\resources\glm\zcode.cjs'
$env:ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = Join-Path (Split-Path $bundle) '..\config\provider\zcode-builtin.json'
$env:ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = Join-Path $env:LOCALAPPDATA 'AgentBroker\zcode-login.json'
node $bundle login --no-browser
```

Reuse a working login; credentials remain in the provider's store.

Next, use **New project wizard**, select the repository folder, and choose the
profiles to copy. On the first project there are no profiles to copy:
create profiles in the pools after adding the project.

## Pools, models and permissions

Select a project in **Show profiles for project**, expand a pool, and click
**Add profile**. Choose its name, provider, configured account, model, effort
and policy. **Refresh model catalogue** reads vendor metadata; it does not run
a coding task. A manually entered model still has to pass provider preflight.

- **Workers** implement tasks with write access to the whole project, including
  tests and documentation. Task paths are guidance, not a file allowlist.
- **Reviewers** inspect the selected checkout with files and Git, including
  uncommitted changes. They use read-only access; no snapshots are required.
- **Researchers** investigate with read-only access.

Permissions have two settings: **Read-only** and **Write all project**. A write
profile can be narrowed to read-only when creating an audit session. The broker
serializes writers in the same physical checkout. Read-only agents can run
alongside other agents; their report does not certify an unchanged checkout.
Use separate worktrees when the review needs a stable target.

Tags such as `default`, `large` and `fast` help the coordinator choose a profile.
A profile name like `cursor_large` is just a name. The broker binds a session to
its exact technical `route_id`; it does not automatically choose a provider or
replace an unavailable model. Several workers can use one profile on separate
worktrees. Disable a profile to prevent new sessions without cancelling existing ones.

**Native subagents** are children created inside a vendor agent, separate from
parallel broker sessions. **Agent decides** lets the vendor choose the child
count. Suggested counts and subagent preferences are advisory, not enforced caps.
Provider-native confinement is not fully verified; a policy is not proof of an
OS sandbox.

Save the configuration. In another terminal, start the shared daemon:

```powershell
$config = Join-Path $env:LOCALAPPDATA 'AgentBroker\operator.json'
agent-broker validate --config $config
agent-broker start --config $config
agent-broker status --config $config
```

Require `READY` and `settings_state: applied`. The daemon runs in the background,
independently of the CLI terminal and MCP client. It uses a frozen copy of its
code in the state folder. Git development runs identify a commit; installed
package runs identify the package version and content checksum.

Later edits require **Save**, then **Restart daemon** in the UI while idle.
Restart applies settings to new sessions using the same frozen code. To use
changed model/effort settings, create a new session. Restart refuses active or
unknown turns and pending intents.

## Connect a coordinator through MCP

Use **Client snippets** in the UI: copy MCP JSON or Codex TOML into your client's
MCP configuration. Or print the shared-daemon JSON:

```powershell
agent-broker mcp-config --connect --config $config
```

Start the daemon first. Enable/reconnect the MCP server in the client after
adding it. The emitted bridge attaches to the shared daemon; it does not create
another daemon. Routine daemon restarts reconnect through the existing bridge.
Without `--connect`, the snippet runs its own in-process daemon and must use a
separate state folder.

Give the coordinator this prompt, replacing the project ID shown in the UI:

> Use Agent Broker for delegated work. Call broker_status and require READY.
> Read every agents_list page for project PROJECT_ID. Show the live profiles
> with provider, model, effort, role, policy and subagent settings before paid
> work. Choose only my enabled profiles; respect their tags and quota pauses.
> Select a workspace from the route's compatible_workspace_ids. After spawn,
> verify effective_policy.access. Send session_id, idempotency_key and task.goal;
> ordinary tasks and reviews need no snapshot or special review binding.
> Use separate worktrees for parallel workers and a separate reviewer profile.
> Read result artifacts, verify actual changes and checks, and perform final
> review yourself. Record broker incidents. If the MCP tools are absent or a
> required route is blocked, report the exact problem; do not silently substitute
> another provider or delegation system.

The complete task/session protocol is in
[coordinator-instructions.md](docs/coordinator-instructions.md).

## Limits, errors and storage

**Global unfinished turns** limits simultaneous broker tasks across projects.
**Per quota scope** limits tasks sharing one account scope. These are broker
limits; the vendor's token/message quota is separate. Parallel writes need
separate physical worktrees.

The default task deadline is **60 minutes**. Change it in the UI and restart;
a coordinator can also set `deadline_ms` for a particular task. The UI shows
last observed activity. Quiet output does not prove a hang: ZCode can buffer
its response until completion.

Expand **Recent turn errors** for the cause, execution state and recovery guidance.
A confirmed quota-exhaustion diagnostic pauses that quota scope across projects.
The broker does not treat every timeout as quota exhaustion or retry failed work
automatically. After quota recovery, the coordinator submits work explicitly.

Large inputs and full reports stay in artifacts. Coordinators should read needed
pages and pass artifact references instead of repeatedly copying full transcripts.
Reviews use the selected checkout directly: name the intended Git commits or
uncommitted changes in the task. The broker neither fingerprints source files
nor rejects completed work because somebody edited the checkout. `SUCCEEDED`
means execution completed; the coordinator accepts the result after reviewing
its report and actual changes. Snapshots and snapshot `review_slot` comparison
remain optional tools for a deliberately frozen baseline/target review.

**Storage and cleanup** previews expired, unpinned registered artifacts before
confirmed deletion. It preserves pinned/retained data. Its accounting covers
registered blobs, not total disk usage; SQLite, worktrees, runtimes, provider
history and other unregistered files are separate. Keep the state folder private
and back it up before maintenance.

For a quarantined workspace, use `quarantine-inspect` and
`reconcile-workspace --workspace-id ID --note "Reason"` with the same `--config`.
First establish that its work has stopped and inspect the checkout. Do not remove
locks or edit registry rows to bypass a busy/quarantine error.

## Update or remove

Wait until all project tasks finish, stop the daemon, and close its UI terminal:

```powershell
agent-broker stop --config $config
npm install --global C:\path\to\gemslibe-agent-broker-0.3.0.tgz
agent-broker start --config $config
agent-broker ui --config $config
```

Keep the existing configuration and state folder. `init` is only for a new setup.
After updating code, regenerate client snippets if their frozen runtime path
changed. Already running bridges reconnect to the same shared state.

To remove the package, stop the daemon first, then run
`npm uninstall --global @gemslibe/agent-broker`. Configuration and state remain
until you explicitly delete their own folder.

## Development

```powershell
npm ci
npm run typecheck
npm test
npm run release:pack
```

Run source commands with `npm run --silent broker -- <command> --config PATH`.
`start --ref COMMIT` exports that committed Git tree, excluding dirty source.
`release:pack` rebuilds JS/UI, verifies the allowlisted tarball and its runtime
checksums, and writes it to `releases/`. The Windows workflow verifies source,
tests installation and uploads the `.tgz`; it does not publish to npm.

This is a pre-release project. Development formats may change directly.
Detailed provider notes are in [providers.md](docs/providers.md); operator/API
reference is in [operator-guide.md](docs/operator-guide.md).

MIT license.
