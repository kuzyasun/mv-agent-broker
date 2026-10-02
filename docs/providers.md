# Provider operations and implementation notes

This is the operator guide for the five native providers and deterministic
mock registered by this checkout. It describes **current adapter behavior**,
not every feature a vendor application might offer. The per-capability
[verification matrix](provider-capabilities.md) and linked native evidence
distinguish implementation, local tests and actual provider execution.

Current transport versions are Cursor 0.2.9, ZCode 0.2.6, Antigravity 0.2.3
and Claude/Codex 0.2.2. Historical smoke versions are identified separately
below. [Native policy observations](native-policy-controls.md) explain why
CLI flags, readiness and individual marker tests do not prove a complete
worker/reviewer confinement profile.

[Native subagent configuration and smoke evidence](native-subagents.md) covers
vendor delegation within a broker session and its current verification limits.

## Configuration and status

Native adapters are registered only when their `AB_*` pin is set. A pin does
not authenticate the CLI or establish a working model. `mock` is always
registered. The broker requires Node 24 and launches commands without shell
interpolation; quote paths when setting environment variables in PowerShell.

| Provider ID | Required pin | Transport and model selection | Native verification on Windows |
|---|---|---|---|
| `mock` | none | deterministic in-process runtime | mock-level tests; no inference |
| `codex` | `AB_CODEX_BIN` | `exec --json`, stdin; `--model`, native resume | CLI 0.157.0; adapter 0.2.0 Luna/low MCP model/resume passed |
| `claude-code` | `AB_CLAUDE_BIN` | `--print --output-format stream-json --verbose`, stdin; `--model` | CLI 2.1.285; adapter 0.2.0 Haiku model/resume passed |
| `cursor` | `AB_CURSOR_BIN` | `--print --output-format stream-json --trust`, stdin; `--model` | CLI 2026.09.28-64d2043; adapter 0.2.0 model/resume passed |
| `zcode` | `AB_ZCODE_BUNDLE` | Node + desktop `zcode.cjs`, argv; private model config and `--json` | CLI 0.16.9; standalone and adapter model/resume passed |
| `antigravity` | `AB_ANTIGRAVITY_BIN` | `agy`, argv/temp prompt file; `--model`, stream JSON | agy 1.2.1; short adapter model/resume passed |

Source of registration/pins: [bootstrap](../src/daemon/bootstrap.ts).
Authentication remains provider-owned. `account_profile_id` and quota scopes
are broker admission metadata; these adapters do not switch OS users or
create isolated vendor logins for each profile. Configure profiles to reflect
the actual account/quota boundary used by the CLI.

## Shared execution contract

- One adapter call starts one native process and acquires one dispatch gate.
  The broker does not retry, change models or start a fresh session after a
  failed explicit resume. Vendor-internal retries can still occur.
- Native IDs must come from native evidence. Empty IDs mean no observed
  native identity; a CLI's existence does not establish native resume.
- CLI success is execution evidence. Agent prose about checks or quality is
  still `agent_reported`; native JSON transport is not a structured quality
  report. ZCode also returns `format_status: text_only` for its response prose.
- Commands receive a provider-specific environment allowlist. Desktop login
  and standalone CLI readiness must be checked separately; ZCode required an
  additional native CLI login on the tested installation.
- Windows `.cmd`/`.bat` shims use strict token checks and an 8,000-character
  command cap. Unsafe shell tokens are rejected. Direct executables and
  Node bundle execution use argument arrays. `.ps1` shims use PowerShell.
- Cancellation/deadlines are polled during execution. The shared runner uses
  Windows `taskkill /T /F`; POSIX sends SIGKILL to the spawned process.
  Native descendant/quiescence and full role profiles need separate validation.
- Real adapters currently report no persistent idle runtime and return false
  from `interruptTurn`; active execution observes cancellation through its gate.

These adapters do not prove native reviewer read-only enforcement. Permission
flags and post-turn broker scope checks are different mechanisms. See the
[acceptance specification](multi-vendor-agent-broker-mvp-v0.2.md) §13/§18 and
[recovery runbook](recovery-runbook.md) for lifecycle/unknown-outcome handling.

The daemon now persists session instructions in the provisioning journal and
the full bounded task contract in the admission event. Both are delivered in
the native envelope, alongside required artifact inputs. Native summary text
is persisted separately and returned by `agent_turn_result.agent_reported`;
it remains an agent claim and does not establish reviewed quality. This fixes
two gaps found by the first real Codex MCP run. Registry tables and MCP field
shapes are unchanged. Task text and reports are retained in local broker state.
Older sessions lacking persisted instructions/tasks fail input delivery before
dispatch; create a new broker session rather than guessing the missing text.

## ZCode

Implementation: [adapter](../src/providers/zcode/zcodeAdapter.ts),
[launch config](../src/providers/zcode/nativeConfig.ts),
[JSON parser](../src/providers/zcode/resultParser.ts). Adapter version: `0.2.6`.

### Working installation and authentication

The tested installation is Desktop 3.14.4 with bundled CLI 0.16.9. The
bundle is a real standalone CLI runnable with Node; no separate distribution
was needed for the verified route. The tested Windows path is:

```powershell
$env:AB_ZCODE_BUNDLE = "$env:LOCALAPPDATA\Programs\ZCode\resources\glm\zcode.cjs"
```

`AB_ZCODE_NODE` optionally selects another Node executable; the default is
the broker's `process.execPath`. The adapter resolves the Desktop built-in
config at `resources/config/provider/zcode-builtin.json`, then checks
`provider/zcode-builtin.json` next to a standalone bundle. For other layouts:

```powershell
$env:AB_ZCODE_BUILTIN_CONFIG = 'C:\path\to\provider\zcode-builtin.json'
```

CLI credentials live in the native `~/.zcode/v2/credentials.json` store.
Desktop had valid OAuth/account metadata, but standalone needed its own
account identity registration. The operator completed the native login:

```powershell
node tests/native-smoke/zcode-native-login.mjs
```

The launcher uses the installed bundle's `login --no-browser`, prints an
authorization URL and leaves credential handling to ZCode. It redirects
model defaults to `.state/zcode-native-login/provider_config.json`. Do not
repeat login if readiness/execution already works. Never send tokens or
authorization codes to the broker. `ZCODE_DATA_BASE_DIR` and
`ZCODE_CREDENTIAL_SECRET`, when configured, are passed to the native CLI;
the adapter does not decrypt or copy the credential store.

### Models, launch config and resume

The adapter currently accepts `GLM-5.3` and `GLM-5.3-Flash` for
`account:zai-individual-coding-plan`. Either a bare model ID or
`account:zai-individual-coding-plan/GLM-5.3-Flash` can be `requested_model`.
An explicit model is required. Other model families, API-key providers and
team/off-peak accounts are outside this adapter route and fail before dispatch.

`account:zai-start-plan/GLM-5.3-Flash` is explicitly rejected with
`PROVIDER_INCOMPATIBLE` before dispatch. Its presence in the Desktop catalog
does not supply standalone account authentication. There is no Individual
fallback. The bounded investigation and host-bridge alternatives are in
[Start Plan research](zcode-start-plan.md). The current operator development
route is Individual Flash/max; selected reviews use GLM-5.3/high.

`requested_effort` accepts `low`, `high`, `max`; null explicitly selects
`low`. This is ZCode's `reasoningLevel`, not a provider-independent translation
of effort names. The smoke proves Flash selection; it does not prove every
provider-side reasoning level's behavior. Model/effort remain session settings;
explicit resume restores the native session's persisted model selection.

There is no `--model` flag in the verified CLI. Each turn gets a private
temporary `provider_config.json`, with the valid personal schema:

```json
{
  "schemaVersion": 1,
  "config": {
    "providerConfigRules": { "providerRules": [] },
    "modelConfigRules": {
      "providerModelRules": [],
      "manualProviderModelRules": []
    },
    "defaultModelSelection": {
      "providerId": "account:zai-individual-coding-plan",
      "modelId": "GLM-5.3-Flash",
      "options": { "reasoningLevel": "low" }
    }
  }
}
```

The actual adapter additionally hides other installed providers and disables
other model IDs for the selected account in that private config, preventing
selection of another account/model as fallback. It supplies explicit
`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`, `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`
and `ZCODE_LOG_DIR` to the child only. Private config/logs are cleaned up
after process termination; native sessions stay in ZCode's own storage.
The vendor provider config and credential files are not edited by the adapter.

Launch shape:

```text
node zcode.cjs --prompt <envelope> --json --mode yolo --cwd <workspace>
node zcode.cjs --prompt <follow-up> --json --mode yolo --cwd <workspace> --resume <sess_ID>
```

Default permission mode remains `yolo`. `ZcodeAdapterOptions.mode` can select
`plan` for a diagnostic run; this does not establish reviewer enforcement.
Native JSON includes `sessionId`, `response`, usage and projection metadata.
The adapter captures the real `sess_...` ID as soon as the complete JSON
object is available. A different ID on explicit resume, malformed output,
nonzero exit, cancellation or a non-idle projection fails the turn; no ID is
invented and no fresh-session retry occurs. `--continue` is intentionally not
used because it selects a latest session rather than the broker's exact ID.

Adapter 0.2.6 classifies explicit JSON error fields in stdout and stderr;
SDK `model_rate_limited` attribution is accepted on the stderr error channel.
Codes 1308/1310 and 1316–1321 map to `QUOTA_EXHAUSTED`; 1302/1305 and
explicit Start Plan busy codes 3008–3010 map to `RATE_LIMITED`. Code 1308
does not establish a five-hour window by itself. The
[official Z.AI error reference](https://docs.z.ai/api-reference/api-code)
defines the API codes; installed PROGRAM evidence defines the SDK error fields.
These sources do not prove that standalone `--json` emits every error.

Only fixed messages and observed numeric `vendor_code`/
`status_code` details are returned; HTTP status, reset time and duration are
never invented. Successful idle projections may retain historical lastError
and still complete. Response prose, nested tool data, HTTP 429 text and plain
error prefixes are not quota evidence. On an observable attributed error,
the adapter requests abort and awaits the existing managed process receipt;
unknown ownership/capture, cancellation, timeout and output caps take priority.
There is no automatic retry or model/account/plan/provider fallback.

The installed standalone CLI catch writes only `error.message` to stderr.
If it drops the attribution or suppresses errors during an internal retry,
the adapter cannot reconstruct the code; failure stays generic or ends at the
hard deadline. This checkpoint uses fake Node CLIs and does not claim a new
live ZCode quota smoke. See the
[quota checkpoint](native-smoke/2026-10-01-zcode-quota/report.md).

Prompts remain argv-based and capped at 6,000 JavaScript characters. There is
no large-prompt file workaround in this adapter. Output timers use the remaining
hard-deadline budget, rather than treating two minutes of silence as startup
failure. The daemon owns hard-deadline cancellation. JSON is delivered at the end,
so there is no streamed text progress or early session-ID event in this route.
Native usage counters are retained by smoke tooling, not exposed as broker
billing/quota accounting.

On Windows, environment lookup preserves case-insensitive `Path`/`PATH`
semantics even after copying `process.env` into an ordinary object. A lost
PATH made ZCode Bash unable to resolve Node/npm during the first development
task. Prefer explicit Node and package-tool paths when briefing native workers;
Git Bash path syntax differs from PowerShell. A slow quota-consuming task is
not proof that the toolchain or account route is unavailable.

**Do not use `--prompt /model` as a free catalog query.** On CLI 0.16.9 it
was forwarded to inference and consumed quota. The corrected local readiness
script checks registration metadata without sending prompts.

`app-server --stdio` is a separate protocol process, not a connection to the
already-open Desktop window. It needs a host account-config and request-header
service. Protocol bootstrap worked, but automatic Desktop account discovery
did not. This integration remains unimplemented; use the standalone route.

Evidence: [bootstrap/login/standalone/adapter report](native-smoke/2026-09-30-zcode-bootstrap/report.md).
Existing broker sessions pinned to adapter `0.1.0` fail the broker's adapter
drift check after this upgrade. Create a new broker session; do not rewrite
stored adapter versions or silently replay an old turn.

## Antigravity

Implementation: [adapter](../src/providers/antigravity/antigravityAdapter.ts).
Set `AB_ANTIGRAVITY_BIN` to `agy.exe`; the tested path is
`%LOCALAPPDATA%\agy\bin\agy.exe`. Authentication is owned by agy.

The adapter uses `--dangerously-skip-permissions --output-format stream-json
--print-timeout 0 -p <prompt>`, explicit `--model` and exact
`--conversation <native_ID>` for resume. Adapter 0.2.0 passes non-null
`requested_effort` through `--effort` (`low`, `medium`, `high`, `max`);
invalid selection fails before dispatch. The flag mapping has fake-process
tests and installed CLI help support; its effective native reasoning semantics
remain unverified. Earlier model/resume smoke used `gemini-3.8-flash-low`.

For prompts over 2,000 characters it writes a temporary prompt file and asks
agy to open it. A longer Gemini 3.8 Flash/high self-development task exercised
that path and produced source changes through MCP ([checkpoint](native-smoke/2026-10-01-dogfood/report.md)). Arbitrary large-input and full role profiles
remain unverified. Short prompts worked over ordinary pipes on Windows; a PTY was
not needed for the exercised scenario. Output waits follow the remaining turn
deadline, with a 65-second margin for daemon deadline supervision; the default
turn deadline is one hour and is configurable. Permission bypass does not
enforce reviewer read-only behavior.

An explicit `FAILED` result whose `error` starts with the observed diagnostic
`Individual quota reached.` maps to `QUOTA_EXHAUSTED`. The bounded, sanitized
diagnostic remains available, including any vendor-provided reset wording;
the broker does not turn that wording into a reset timer or subscription state.
Successful responses, response-only failures, stderr prose and other errors
are not quota evidence. No automatic retry or provider/account fallback occurs.
This classification is tested with fake native processes; a new live quota
failure has not been exercised. See the
[quota checkpoint](native-smoke/2026-10-03-antigravity-quota.md).

The parser handles step updates/results and captures observed conversation
IDs without inventing them. A missing ID stays empty; resume is only possible
with a real prior reference. Native result usage in the tested conversation
was cumulative: do not sum consecutive result counters as independent turns.
[Native model/resume evidence](native-smoke/2026-09-30-antigravity-zcode/report.md).

## Cursor

Adapter 0.2.4 prepares a unique private `CURSOR_CONFIG_DIR` for each reviewer
turn, retaining Ask mode and denying `Write(**)`, `Shell(*)`, `WebFetch(*)`
and `Mcp(*:*)`. Preparation precedes dispatch permission; cleanup covers
success, definite failure and gate refusal; uncertain execution retains config
and audit evidence. Native authentication stays
with the CLI; no user credential/settings files are copied or edited.
See the official [permissions](https://cursor.com/docs/cli/reference/permissions)
and [configuration](https://cursor.com/docs/cli/reference/configuration) contracts.
Reviewer HOME/USERPROFILE/XDG directories and `CURSOR_DATA_DIR` are isolated
under the daemon state directory with a hashed session identity. Those directories
persist, but the installed CLI stores chats under `CURSOR_CONFIG_DIR/chats`.
The per-turn config cleanup in 0.2.4 destroys that history: the
[clean continuity probe](native-smoke/2026-10-01-cursor-clean-continuity/report.md)
failed memory recall despite an unchanged native UUID. A stable per-session
config root and fresh native verification are required. Existing path components containing symlink/junctions fail before
dispatch. Direct callers should provide `stateRoot` to preserve restart reuse.
Windows APPDATA/LOCALAPPDATA authentication stays native-owned.

The candidate config uses explicit workspace and sealed input path allowances
and `sandbox.readBoundary=workspace`. It is partial hardening: the installed CLI
can feature-gate read control, and first-party plugins can remain discoverable.
The [native 0.2.3 probe](native-smoke/2026-10-01-cursor-read-boundary/report.md)
reproduced a harmless outside-file marker that was absent from the prompt:
scoped read enforcement failed. This profile is not supported.
Config self-repair, exact read/input-write denial and MCP/network restrictions
require native falsification before the profile can be advertised as enforced.
The earlier private-HOME continuity probe read broker evidence to find its
marker; that memory-recall evidence was rejected, not counted as acceptance.
See the [configuration checkpoint](native-smoke/2026-10-01-cursor-profile/report.md).

The [0.2.4 hook candidate](native-smoke/2026-10-01-cursor-hooks/report.md)
adds a trusted all-tool `preToolUse` gate, SHA-256-bound policy and immutable
physical grants. Flat native command records fail closed; recognized reads and
searches are checked against workspace/current input bindings. Mutation, shell,
MCP, web, delegation and unknown tools are denied by the script. Bounded audit
and typed stream receipts retain hashes and fixed labels only. Offline tests
and installed-program schema checks passed. A fresh
[native probe](native-smoke/2026-10-01-cursor-hooks-native/report.md) observed
the exact outside-path denial receipt and no marker disclosure. This is a
limited Read-boundary smoke; full input paging and every forbidden tool remain
unverified. Clean continuity on 0.2.4 failed separately. The 0.2.3 failure is not overwritten.

Implementation: [adapter](../src/providers/cursor/cursorAdapter.ts).
Set the pin to the agent launcher, which is separate from Desktop `cursor.cmd`:

```powershell
$env:AB_CURSOR_BIN = "$env:LOCALAPPDATA\cursor-agent\cursor-agent.ps1"
node tests/native-smoke/cursor-readiness.mjs
```

The installed CLI was `2026.09.28-64d2043`. `status` recognized the existing
login; no additional login was required. Readiness uses `--version`, `--help`,
`status`, `--list-models` without prompts, discards account email and retains
the model catalog. It does not authenticate on behalf of the user.
The default adapter command is `cursor-agent`; an explicit path is preferable
for reproducible setup.

Current launch shape is `--print --output-format stream-json --model <id>
--trust`, with `--workspace <path>` and exact `--resume <native_ID>` when
available. The prompt goes through stdin. Adapter 0.2.0 requires an explicit
model from the request or constructor and has no obsolete implicit fallback.
The verified ID is `gpt-5.4-mini-none`; init reports its catalog display name
`GPT-5.4 Mini None`. Use catalog IDs containing the required effort where
available; separate `requested_effort` is currently ignored. Parameterized
model overrides advertised by the CLI are not smoke-tested here.

Adapter 0.2.1 launches reviewers with `--mode ask`. Native `plan` mode put its
final review into a CreatePlan tool payload, leaving only interim narration in
the ordinary result. Ask mode delivered a real `auto` review report through MCP.
This establishes report delivery, not complete reviewer tool/sandbox enforcement.
See [development evidence](native-smoke/2026-10-01-dogfood/report.md). Existing
0.2.0 sessions require a new broker session after adapter-version drift.

The parser captures `system/init.session_id` or result identity, assistant/tool
progress and a final result with explicit boolean `is_error` and string text.
Native resume passed across two separate processes with the same ID and a
remembered marker omitted from the follow-up. Missing fresh identity stays
empty; missing or mismatched resume identity and conflicting IDs fail the turn.
No synthetic ID or fresh-session fallback is used. Nonzero exit, cancellation
and timeout override a success record. Timeouts do not imply rate limiting;
quota-error classification remains unverified because no quota error occurred.

Startup/inactivity timeouts are both 120 seconds. Windows profile variables
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`, optional
`CURSOR_API_KEY` and `NODE_COMPILE_CACHE` are passed alongside HOME/XDG state.
The shared Windows runner preserves `PATHEXT`: the installed PowerShell shim
silently produced no output without it, even on `--version`. Credentials
remain CLI-owned. Windows shim boundary restrictions still apply.

The exercised native stream reported `permissionMode: default`; `--force`
and `--mode ask/plan` are not used by this adapter. Trust does not enforce
reviewer read-only behavior. Worker edits, native tool cancellation, large
inputs and full broker lifecycle remain unverified. Usage fields include
`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`; they are
retained by smoke tooling, not exposed as broker billing.

[Native results, launch diagnosis and reproduction](native-smoke/2026-09-30-cursor/report.md).
Existing broker sessions pinned to adapter 0.1.0 hit the drift guard after
upgrading to 0.2.0; create a new broker session.

## Claude Code

Implementation: [adapter](../src/providers/claude/claudeAdapter.ts).
Set `AB_CLAUDE_BIN` to the CLI executable/shim (`claude` by default).
Tested installation: `%USERPROFILE%\.local\bin\claude.exe`, version 2.1.285.
Check readiness without a prompt:

```powershell
$env:AB_CLAUDE_BIN = "$env:USERPROFILE\.local\bin\claude.exe"
node tests/native-smoke/claude-readiness.mjs
```

Readiness uses `--version`, `--help`, `auth status --json`; it retains only
auth state/config paths, discarding account email and credential values.
The initial status was `loggedIn: false` for the same Windows profile.
Existing account metadata did not contain active CLI tokens; the operator
completed native login, then readiness reported `claude.ai`/Team and both
adapter processes reused that same profile. Complete `claude auth login` only when native
readiness indicates a missing login. No broker token extraction is required.
The allowlist passes HOME/XDG, Windows profile/temp paths, optional
`CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`; native CLI owns auth precedence.

Adapter 0.2.0 sends stdin with `--print --output-format stream-json --verbose`,
an explicit `--model` and exact `--resume <native_ID>`. The original adapter
failed because CLI 2.1.285 requires `--verbose` with print/stream-json.
`requested_effort` remains unmapped. The completed smoke used the pinned
`claude-haiku-4-5-20251001`; this model has no effort control according to the
[official table](https://platform.claude.com/docs/en/models/overview).
Startup hook frames, init or result provide observed session identity; assistant text provides
progress and a successful final result supplies prose. Native error arrays
are preserved. Hooks/permission handshakes are not wired.
Startup/inactivity timeouts are both 120 seconds.

Missing fresh identity stays empty; no synthetic ID is created. Missing or
mismatched resume identity and conflicting IDs fail. Nonzero process exit,
cancellation and timeout override success records. Native permissions remain
unchanged, with no bypass flags added. Model/resume passed in two separate
processes; init/assistant confirmed Haiku and the second prompt omitted the
recalled marker. Full roles/tool behavior remain unverified. Native user hooks
can still run although the broker does not configure hooks. `apiKeySource: none`
in init did not prevent OAuth subscription authentication. `usage` was per
turn; `modelUsage` and `total_cost_usd` were cumulative across resume. Do not
double-count them or equate the list-price estimate with subscription billing.
Old broker sessions pinned to
adapter 0.1.0 trigger the drift guard; create new broker sessions.
[Investigation, evidence and commands](native-smoke/2026-09-30-claude/report.md).

## Codex

Implementation: [adapter](../src/providers/codex/codexAdapter.ts),
[JSONL parser](../src/providers/codex/streamParser.ts). Adapter `0.2.0`.
Set `AB_CODEX_BIN` to a known CLI executable/shim. Bootstrap registers Codex
only when this pin is supplied. The tested npm installation was CLI `0.157.0`;
the separately bundled Desktop executable was `0.155.1`, so a bare PATH lookup
can select a different build. The native npm executable tested here lives at:

```text
%APPDATA%/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe
```

The existing CLI login was recognized as `Logged in using ChatGPT`; no new
login, token extraction or Desktop session attachment was needed. The adapter
preserves HOME/CODEX_HOME/XDG state and Windows profile/temp paths. Optional
CODEX_API_KEY, OPENAI_API_KEY and OPENAI_BASE_URL are passed to the native CLI;
the broker does not read credentials. Account-profile IDs remain admission
metadata, not independent native logins.

Launch shapes (prompt via stdin, never argv):

```text
codex exec --sandbox workspace-write --json --ignore-user-config --model <model> -c model_reasoning_effort="low" -
codex exec --sandbox workspace-write resume --json --ignore-user-config --model <model> -c model_reasoning_effort="low" <thread-id> -
```

An explicit model is required. Non-null effort is passed as a TOML string;
native model availability/effort combinations are validated by the CLI. The
verified model was `gpt-6-luna` with `low`, confirmed by two native turn-context
records. `--ignore-user-config` excludes ambient model/MCP configuration while
preserving native authentication; user/project instructions and managed
configuration may still apply. This avoids inheriting broker MCP connections
from the invoking Codex profile. It does not isolate account quotas.

`thread.started.thread_id` is recorded before completion. The final completed
agent message becomes bounded `text_only` summary. Missing/conflicting IDs,
missing message/completion, native error/failure, nonzero exit, cancellation or
timeout fail explicitly. Resume always names the stored ID; there is no
`--last`, fabricated ID, retry or fresh-session fallback. The former notify
bridge is unused. Startup and inactivity timeouts are both 120 seconds.

The adapter requests `read-only` for reviewer and `workspace-write` otherwise.
**Both actual smoke turn contexts recorded `read-only`**, despite the worker
flag; this test used no tools. Worker writes, effective sandbox mapping,
reviewer write denial and native tool cancellation therefore remain unverified.
Do not advertise full role/profile support from the text-only result.

A plain Node MCP client drove separate bridge and daemon processes over the
private named pipe, using production provider bootstrap. It sent two tasks,
received summaries/snapshots, resumed the same native conversation after the
first CLI exited, and closed the broker session. Calling Codex requires no
Codex-specific client APIs or open Desktop window. Another caller or machine
can use this route with its own configured CLI/login.

Native `turn.completed.usage` is cumulative across resume in this installation.
The native rollout's `last_token_usage` confirmed per-turn differences. Cached
input is included in input totals; do not add it again. Broker result usage
remains `unknown`; smoke metadata is not an account billing/quota meter.
[Native MCP evidence, initial failure and scope](native-smoke/2026-09-30-codex/report.md).
Existing sessions pinned to Codex adapter `0.1.0` fail adapter-drift checks;
create a new broker session.

## Mock and verification workflow

[MockAdapter](../src/providers/mock/mockAdapter.ts) is deterministic, exposes
mock IDs/continuity and supports lifecycle/fault testing. It has no vendor
authentication, model execution or quota use. It cannot prove any native CLI
capability.

Safe local checks:

```powershell
npm run typecheck
npm test
node tests/native-smoke/verify-evidence.mjs
node tests/native-smoke/verify-zcode-bootstrap.mjs
node tests/native-smoke/verify-zcode-adapter.mjs
node tests/native-smoke/verify-cursor-adapter.mjs
node tests/native-smoke/verify-claude-adapter.mjs
node tests/native-smoke/verify-codex-mcp.mjs
node tests/native-smoke/cursor-readiness.mjs
node tests/native-smoke/claude-readiness.mjs
node tests/native-smoke/zcode-standalone.mjs readiness
```

Opt-in quota-consuming smoke commands (excluded from `npm test`):

```powershell
node tests/native-smoke/provider-spike.mjs zcode GLM-5.3-Flash
node tests/native-smoke/provider-spike.mjs antigravity gemini-3.8-flash-low
node tests/native-smoke/provider-spike.mjs cursor gpt-5.4-mini-none 'GPT-5.4 Mini None'
node tests/native-smoke/provider-spike.mjs claude-code claude-haiku-4-5-20251001
node --experimental-transform-types tests/native-smoke/codex-mcp.mjs $env:AB_CODEX_BIN gpt-6-luna low
```

Each permits a fresh marker turn and one exact resume after the first process
exits. The follow-up omits the random marker. Stop on a failure, wrong model,
missing ID or mismatched marker; retain native logs and usage without secrets.
Full worker writes, reviewer restrictions, large inputs, broker restart and
quiescence are separate acceptance tests. §18.1 remains open.

Cursor short model/resume smoke is complete; no quota error occurred in four
requests. Claude Code Haiku model/resume also passed in two requests after
native login. Codex Luna/low passed through the external MCP route after fixing
caller task delivery and result persistence (one initial request plus two
corrected requests). Recheck
CLI metadata before each provider spike and use explicit models. Full role
and lifecycle acceptance remains separate from these short adapter tests.
