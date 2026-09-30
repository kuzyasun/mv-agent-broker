# Cursor native adapter smoke — 2026-09-30

The operator authorized Cursor inference despite a nearly exhausted quota,
with a reset expected on October 1. Four native requests completed successfully;
no quota/rate-limit error occurred. Claude and Codex native testing remain deferred.
This verifies short adapter turns and exact resume on Windows, not full §18.1
worker/reviewer/profile acceptance.

## Installation and metadata (no inference)

- Agent version: `2026.09.28-64d2043`, bundled Node `v24.5.0`;
  broker/test Node `v24.11.1`, Windows native pipes.
- Launcher: `%LOCALAPPDATA%\cursor-agent\cursor-agent.ps1`.
  Desktop `cursor.cmd` is a separate command and is not the agent entrypoint.
- `status` confirmed an existing login. No additional login was needed; account
  email and credentials are omitted from retained metadata.
- `--list-models` listed 246 IDs. Selected `gpt-5.4-mini-none` with catalog
  display name `GPT-5.4 Mini None`. `system/init.model` uses that display name.
- `--help` confirmed print/stream-json, workspace, model and resume flags.
  These explicit metadata commands send no prompts. No slash-command probes.

[Metadata](readiness.evidence.json).

## Confirmed Windows launch defect and fix

The original adapter exited in under a second with no stdout/stderr and no
result, although its PowerShell child returned exit code 0. Adding Windows
profile variables alone produced the same failure. Repeating **only
`--version`** isolated the missing environment variable: the installed
PowerShell launcher silently skipped native execution without `PATHEXT`, and
printed its version with that variable restored.

The shared Windows runner now preserves `PATHEXT` (with standard extensions
as a fallback). Cursor additionally passes `USERPROFILE`, `APPDATA`,
`LOCALAPPDATA`, `TEMP`, `TMP`, optional `CURSOR_API_KEY` and `NODE_COMPILE_CACHE`.
Authentication remains native-owned. No vendor credential/config files were
edited. The first two failed attempts produced no native stream or observable
model usage; this is not a claim based on vendor billing telemetry.

[Initial failure](initial-launch-failure.evidence.json),
[profile-only failure](profile-only-launch-failure.evidence.json),
[metadata-only PATHEXT comparison](launcher.evidence.json).

## Native turn/resume results

Both smoke runs used the production adapter with `--print --output-format
stream-json --model gpt-5.4-mini-none --trust --workspace <isolated-directory>`.
The prompt travelled through stdin with the broker end marker. The second
process started after the first had exited, used the exact observed
`--resume <ID>`, and reproduced a random marker omitted from the follow-up
prompt. Each turn acquired exactly one dispatch gate and emitted one observed
native reference; init/result IDs agreed. All exits were 0, final records had
`subtype: success` and `is_error: false`, and no tool calls appeared.
`apiKeySource` was `login`; permission mode was `default`.

| Run | Adapter | Native conversation ID | Result |
|---|---|---|---|
| Environment fix | 0.1.0 with environment corrections | `dfb67b06-6532-44d6-9b67-12e67bc1b569` | fresh + resume passed |
| Final implementation | 0.2.0 | `30b0fd9a-ce76-47df-8661-8a7ce7148b91` | fresh + resume passed |

[Environment fix evidence](environment-fixed.evidence.json),
[final adapter evidence](adapter-resume.evidence.json).

Across four result records: `inputTokens=25548`, `outputTokens=96`,
`cacheReadTokens=24576`, `cacheWriteTokens=0`. These are native usage fields,
not money, remaining quota or broker billing. Cache reads are reported
separately; do not interpret `inputTokens` alone as total context consumption.

## Adapter 0.2.0 and remaining limits

- Removed the obsolete implicit model default; request or constructor must
  provide an explicit model. Catalog IDs can encode effort; `requested_effort`
  still has no independent mapping.
- No synthetic `cursor-<turn_id>` references. Missing identity on a fresh
  successful turn stays empty; explicit resume requires observed matching ID.
- Captures identity from init or result. Conflicting IDs fail; a different
  ID on resume is not emitted as a replacement, and no fresh-session retry runs.
- A success record cannot override nonzero exit, interruption or timeout.
  Malformed results cannot be interpreted as success. Startup timeout does
  not imply rate limiting. Native error text is preserved where available;
  a dedicated quota-error mapping remains unverified.
- Fake process tests cover literal stdin, filtered environment, gates, missing
  identity, resume mismatch, invalid output and cancellation after a result.
  Retained native output is also a parser fixture.

Worker file writes, reviewer read-only enforcement, live tool cancellation,
large prompts, broker restart/quiescence, other models/platforms and actual
quota exhaustion were not exercised. `--trust` accepts workspace trust and
does not establish a broker role policy. Existing broker sessions pinned to
adapter 0.1.0 hit the adapter drift guard; create new broker sessions.

## Reproduction

Validation completed: `npm run typecheck` passed; `npm test` passed
234/234 tests in 24 files. All four offline native evidence validators
passed, including `verify-cursor-adapter.mjs`; `git diff --check` passed.
This adds 24 local regressions (17 adapter, five parser, two Windows env)
to the preceding 210-test suite. These local checks consume no provider quota.

```powershell
$env:AB_CURSOR_BIN = "$env:LOCALAPPDATA\cursor-agent\cursor-agent.ps1"
node tests/native-smoke/cursor-readiness.mjs
# The following sends up to two prompts and consumes Cursor quota:
node tests/native-smoke/provider-spike.mjs cursor gpt-5.4-mini-none 'GPT-5.4 Mini None'
# Offline, no inference:
node tests/native-smoke/verify-cursor-adapter.mjs
```

Recheck the catalog before selecting a different model. Stop on a native error;
retain the error and evidence rather than silently retrying another model or
session. If the vendor rejects execution due to quota, retry only when quota
has reset. The completed short smoke does not need another run just to exhaust
the account balance.
