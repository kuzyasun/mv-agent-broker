# Claude Code native adapter smoke — 2026-09-30

The operator authorized Claude testing after the Cursor smoke. Installation,
CLI auth metadata and the original adapter launch were checked. After the
operator completed native login, adapter 0.2.0 **passed two short Haiku 4.5
turns with exact resume**. Full role/profile/lifecycle acceptance remains
unverified (§18.1).

## Installation and auth

Installed standalone executable: `%USERPROFILE%\.local\bin\claude.exe`,
version `2.1.285 (Claude Code)`. `auth status --json` returned exit 1,
`loggedIn: false`, `authMethod: none`, `apiProvider: firstParty` and config
directory `%USERPROFILE%\.claude`. This was the initial state before login;
metadata commands send no prompts.
[Initial sanitized readiness](initial-readiness.evidence.json).

The operator initially expected an existing console login to be reused, then
confirmed a login was needed. Local diagnosis found the same Windows user
and config directory, existing account metadata, but no active access or
refresh token in the CLI credential record (expiry 0). No credential values
were exported or copied. CLI-owned login is the intended route, not a new
broker account or token bridge:

```powershell
& "$env:USERPROFILE\.local\bin\claude.exe" auth login
```

Post-login `auth status` returned exit 0, `loggedIn: true`,
`authMethod: claude.ai`, `subscriptionType: team` for the same config directory.
Both adapter processes reused that native profile. No further login or broker
credential bridge was needed. [Post-login readiness](readiness.evidence.json).
Native init reported `apiKeySource: none`: that field names API-key sourcing,
not subscription-login readiness, which is confirmed by auth status/execution.

The broker does not perform login or extract secrets. `CLAUDE_CONFIG_DIR`,
when explicitly configured, is passed to the child so the broker can reuse
the operator's native profile. Native auth environment variables are supported,
but no token extraction is required for the normal login route.

## Confirmed launch defect

The original adapter 0.1.0 exited with code 1 and the native message:

```text
Error: When using --print, --output-format=stream-json requires --verbose
```

This argument rejection produced no completed native result or observed model
usage. It is independent of the missing login.
[Failure evidence](initial-flags-failure.evidence.json).

Adapter 0.2.0 adds `--verbose`, an explicit `--model`, Windows profile/temp
variables, optional `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_OAUTH_TOKEN` to the
existing auth allowlist. It uses stdin and exact `--resume <ID>`, with the
shared runner's Windows `PATHEXT` handling from the Cursor fix.

The parser now captures identity from startup hook frames, init or result, rejects ambiguous
success shapes, and preserves native error arrays. Fresh completion without
an observed identity returns an empty reference; no `claude-<turn_id>` value
is invented. Resume requires observed matching identity. Conflicting IDs,
missing results, malformed output, nonzero exit, interruption and timeout
fail rather than returning successful completion. Early gate denial or a
pending cancellation launches no child.

## Model and scope

The completed short smoke used the pinned ID `claude-haiku-4-5-20251001` from
the [official model table](https://platform.claude.com/docs/en/models/overview).
Haiku 4.5 has no effort control; `requested_effort` remains unmapped in this
adapter. Installed help exposes no standalone model-list command; no `/model`
prompt is used for discovery. Init, assistant messages and model usage all
confirmed that exact model ID in both turns.

## Native results and usage

The first process remembered a random marker; after its exit, a second process
used `--resume a44cbc4e-54eb-48e3-8a00-f1858dcccee3` and returned the exact
marker absent from its stdin. Init/result native IDs agreed, each turn acquired
one gate and emitted one native reference, both final records were successful,
and both processes exited 0. No model tool calls appeared and stderr was empty.
Native permission mode stayed `default`, with no bypass flags added.
[Sanitized adapter evidence](adapter-resume.evidence.json).

The existing user configuration loaded a successful native startup hook and
custom commands. Their output/descriptions are omitted from public evidence;
identity, init, assistant, result, usage and actual stdin are retained. The
first hook frame exposed the session ID before init. This prompted a narrow
parser correction to emit that observed identity immediately. Both retained
native streams were replayed through the final adapter offline, proving early
single emission and unchanged results without additional inference.
Broker hook/permission integration remains unwired; native user hooks can run.

| Turn | input_tokens | cache_creation_input_tokens | cache_read_input_tokens | output_tokens (thinking included) |
|---|---:|---:|---:|---:|
| Fresh | 9 | 10161 | 18091 | 102 (75 thinking) |
| Resume | 9 | 1393 | 28252 | 93 (66 thinking) |
| Sum of per-turn usage | 18 | 11554 | 46343 | 195 (141 thinking) |

`usage` was per turn, but `modelUsage` and `total_cost_usd` were cumulative
across native resume. The final CLI estimate was `0.0287353` USD with
`costBasis: list`; do not add the first estimate again. This is native usage
and a list-price estimate, not a claim about money deducted or remaining quota.
The native `rate_limit_event` status was `allowed` on both requests; no quota
error occurred. Overage was disabled and was not used. No rejection/retry
scenario or quota-exhaustion classification was exercised.

## Remaining limits

Worker writes, reviewer read-only enforcement, hooks/permission handshakes,
live tool cancellation, large prompts, quota errors and full broker lifecycle
remain unverified. Native CLI configuration and permissions are retained;
this change does not add bypass-permission flags. Upgrading the adapter from
0.1.0 triggers the existing broker adapter-drift guard for old sessions;
create a new broker session.

CLI interface reference: [official CLI docs](https://code.claude.com/docs/en/cli-reference).

## Local validation

Final `npm run typecheck` passed; `npm test` passed **257/257 tests in 25 files**,
including 23 Claude process/protocol regressions. All five offline evidence
validators passed, including native Claude model/ID/resume and cumulative usage
checks; `git diff --check` passed. Local checks and evidence replay send no
model requests. Only two successful model requests were made after login.

## Reproduction

```powershell
$env:AB_CLAUDE_BIN = "$env:USERPROFILE\.local\bin\claude.exe"
# Metadata only, no inference:
node tests/native-smoke/claude-readiness.mjs
# After CLI login, up to two quota-consuming turns:
node tests/native-smoke/provider-spike.mjs claude-code claude-haiku-4-5-20251001
# Offline, no inference:
node tests/native-smoke/verify-claude-adapter.mjs
```

The smoke performs a fresh random-marker turn followed, only after success,
by one exact resume in a new process. The second prompt omits the marker.
Stop on failure; do not switch models or create a fresh replacement session.
