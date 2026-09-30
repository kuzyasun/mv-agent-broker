# ZCode bootstrap and account readiness probes

Date: 2026-09-30, Europe/Kyiv. Operator authorized the staged ZCode test
plan: bootstrap/model checks before inference, then two turns with a process
restart. After the operator completed native CLI login, the standalone
GLM-5.3-Flash model/resume smoke passed. Production adapters and the existing
staged changes were preserved. The app-server host integration remains open.

## Environment and isolation

- Installed Desktop: 3.14.4; bundled CLI: 0.16.9; Node: 24.11.1, native Windows.
- Bundle: `C:\Users\902st\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`.
- Built-in provider file: `resources/config/provider/zcode-builtin.json`.
- Initial probes used their own empty workspace and credential-free personal
  provider file under `.state/native-smoke/`, with explicit child-process
  `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` and
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. Global environment/PATH and vendor
  files were not edited.
- A separate app-server probe used the real Desktop provider config without
  modifying it; its catalog was also empty. Post-login standalone smoke used
  a valid private provider config and a copy of the installed built-in file.
- SHA-256 of the real Desktop `~/.zcode/v2/provider_config.json` was unchanged
  across the probes. This hash verifies that specific provider config,
  not every file in the native data directory. CLI-owned logs/session storage
  are normal bootstrap side effects; no native history was deleted.
- App-server sessions disabled title generation, memory, native search,
  dynamic workflows, off-peak work and passed empty MCP/tool allowlists.
  These probes do not establish enforced reviewer or worker permissions.

## Executed checks

| Probe | Observed result | Generation |
|---|---|---|
| App-server with explicit `account:zai-individual-coding-plan / GLM-5.3-Flash / low` | Process starts, storage ready, capabilities response and runtime-preferences handshake work; model selection fails with `Provider Registry 中不存在 Model` | No `session/send` |
| App-server without model selection | Creates `sess_8a3e360b-1cb1-4bbf-9634-886f2b87489a`; snapshot reports ZCode Protocol v1 and `settings.model.available: []` | No `session/send` |
| Standalone `--prompt`, same provider/model explicitly configured in private provider file | Exits 1; native error cause is `Select a model before continuing` / `CONFIGURATION_ERROR` during model creation | One prompt attempt; failed before model execution |

Evidence: [model rejection](app-server-model.evidence.json),
[empty-session/catalog snapshot](app-server-catalog.evidence.json),
[standalone attempt](standalone-print.evidence.json),
[native error cause](standalone-failure.evidence.json), and
[credential readiness metadata, without values](native-readiness.evidence.json).

The three initial processes exited normally. The explicit-model probe's empty
stderr and app-server error reply are retained, rather than treating process
exit 0 as task success. At that pre-login stage there were zero successful model generations,
no app-server sends and no restart/marker continuity test. No billing or
remaining-quota counter was exposed; the standalone failure is a local
configuration failure, not an observed remote model response. Those private
configs were later found to have an invalid personal schema (`templateRules`
is not accepted and model-rule arrays were missing). They are retained as
original failed attempts, not proof of the exact cause in a valid config.
The [real Desktop config probe](desktop-catalog.evidence.json) independently
confirms that app-server does not automatically initialize the account catalog.

## Why the two launch modes differ

Read-only inspection of the installed bundle establishes two distinct
initialization paths:

1. `app-server` calls `startProcessProviderRegistryRuntime(env)` without
   standalone options. Its account source starts empty and is supplied by
   the host through `provider/updateAccountConfig`; account request headers
   also use host-provided machinery. Passing the provider file paths fixes
   layout lookup but does not reconstruct the Desktop host's account state.
2. Standalone prompt/TUI initialization supplies the `standalone` option.
   It reads the CLI-owned credential store and resolves account entitlement
   through `readStandaloneAccountProviderConfigSnapshot`.

For the selected Z.AI individual provider, that reader first requires
`account-provider:<providerId>:identity`, then an account-scoped key. The
pre-login native store had Z.AI OAuth metadata and an account-scoped Coding
Plan key, but lacked the standalone identity entry. No credential values
were exported, decrypted, copied, changed, or manually registered.
This is a concrete mismatch between Desktop login state and standalone CLI
readiness, not evidence of a missing subscription or invalid account.

The operator subsequently ran the bundle's native login using
`tests/native-smoke/zcode-native-login.mjs`. The CLI registered its own
identity/key entries and saved a model default to the launcher's private
personal config. No broker-side credential bridge was implemented.

## Post-login native standalone result

The first post-login attempt mistakenly used `--prompt /model --json` as a
metadata query. CLI 0.16.9 forwarded `/model` to the model, which made two
requests and returned an explanation. The invalid temporary config fell back
to GLM-5.3. The attempt's original `readiness-passed` status and
`generationAttempts: 0` are **incorrect classifications**; its response text
is not model-selection proof. Native usage records 52,413 tokens. This mistake
was disclosed to the operator and the runner was corrected before continuing.
[Original evidence](misrouted-model-command.evidence.json).

Corrected local readiness performs no subprocess or prompt. Personal config
uses `providerConfigRules: { providerRules: [] }` and
`modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] }`.
The smoke pins `account:zai-individual-coding-plan / GLM-5.3-Flash`, with
`reasoningLevel: low` in its default selection. The native request logs prove
the model/provider, but do not establish provider-side reasoning semantics.
The test workspace disables MCP and memory and disables user-enabled plugins;
native runtime logs confirm MCP/memory off. Plan mode and Bash/Write/Edit
denial are exercised as launch settings, not proven security enforcement.

Two separate processes returned the same marker and real session ID:
`sess_09d66b17-fb38-4808-9c1f-68656df6c243`. The first process exited 0 before
the second started. The second uses `--resume <id>` and its prompt does not
contain the random marker. Each turn made exactly one model request, with
GLM-5.3-Flash, attempt 1 and finish reason `stop` in the native network log.
No further inference was performed for verification.

| Native usage counter | First turn | Resumed turn |
|---|---:|---:|
| modelRequestCount | 1 | 1 |
| inputTokens | 18,690 | 18,736 |
| outputTokens | 16 | 16 |
| totalTokens | 18,706 | 18,752 |
| cacheReadTokens | 0 | 192 |

The two intended turns report 37,458 total tokens. Including the mistaken
`/model` attempt, this post-login test session reports **89,871 tokens over
four model requests and three user turns**. These are native counters, not a
billing estimate or measured remaining quota; cache accounting is preserved.
Evidence: [standalone model/resume](standalone-resume.evidence.json),
[selected native runtime events](standalone-runtime.evidence.json), and
[local registration readiness](post-login-readiness.evidence.json).

## Working route and remaining scope

Use the installed Desktop bundle via Node with explicit config paths and
native CLI-owned login. A separate CLI distribution has no demonstrated
benefit for this smoke. The standalone test established the launch config,
JSON identity and resume contract. Subsequent adapter changes and native
acceptance are recorded below; the original standalone test itself did not
exercise them.

The optional manual login command remains:

```powershell
node tests/native-smoke/zcode-native-login.mjs
```

Login is already complete for this test and does not need to be repeated.
It does not by itself supply app-server's host registry/header service.

Continuing with `app-server` requires a separate integration decision about
the host account/auth contract. No account entitlement snapshot was forged,
no Desktop private IPC was attached and no API/provider fallback occurred.
Installing the same CLI runtime in a separate distribution has no proven
benefit for this account bootstrap mismatch, so no distribution was installed.

## Reproduction and validation

```powershell
node tests/native-smoke/zcode-app-server.mjs probe
node tests/native-smoke/zcode-app-server.mjs catalog
node tests/native-smoke/zcode-app-server.mjs desktop-catalog
node tests/native-smoke/zcode-standalone.mjs readiness
node tests/native-smoke/zcode-standalone.mjs smoke
node tests/native-smoke/verify-zcode-bootstrap.mjs
```

App-server probes and corrected standalone `readiness` perform no generation.
Standalone `smoke` may consume quota; `print-probe` is also an inference mode.
The login command is a separate manual
step and is never called automatically by these probes or `npm test`.
Evidence capture redacts credential fields; raw native credential values
are not retained. Empty sessions are not evidence of working model resume.

Validation: JavaScript syntax checks, offline assertions over retained
native evidence, and `git diff --check`. The production code was unchanged,
so the previously passing 187-test suite was not rerun. Native worker/reviewer
profiles, broker integration and §18.1 remain unverified. Standalone native
resume/model selection are now verified for this one model and installation.

## Adapter 0.2.0 implementation and native acceptance

The operator subsequently authorized code changes to make ZCode work and
documentation for every provider. The adapter now resolves the Desktop
provider config layout (or AB_ZCODE_BUILTIN_CONFIG override), creates a valid
private per-turn model config, parses --json, emits the observed native ID and
uses exact --resume. Other providers/model IDs are disabled/hidden in its
private launch config; unknown models/effort fail before dispatch. Native
credentials stay CLI-owned; vendor files are not rewritten. Native transport
JSON does not change agent prose into a structured quality report.

The scope is Z.AI Individual Coding Plan, GLM-5.3/GLM-5.3-Flash, low/high/max
effort (null selects low); full model/effort coverage remains unverified.
The default permission mode remains yolo, but the native smoke explicitly
uses plan with MCP/memory disabled in the prepared workspace. Existing broker
sessions pinned to adapter 0.1.0 require a new broker session under the normal
adapter drift rule; no registry/session migration or automatic replay occurred.

Real execution through the production ZcodeAdapter passed two small turns:
- Native ID: sess_8609a207-c37d-41df-bf54-6441a1eb7d09 on both turns.
- The first process exited before the second process started; the second
  prompt omitted the marker and used --resume with exactly the first ID.
- CLI network logs confirm GLM-5.3-Flash / account:zai-individual-coding-plan
  on both turns; each made one model request, attempt 1, finish reason stop.
- Each call acquired one dispatch gate and emitted one native_ref_obtained.
- The private config was removed after execution; CLI JSON and adapter
  summary both contain the expected marker.

Native totals were 18,322 and 18,378 tokens: **36,700** for this additional
adapter acceptance test. These are reported counters, not billed cost.
[Retained adapter evidence](adapter-resume.evidence.json).

Validation after code changes: npm run typecheck passed; npm test passed
**210/210 tests in 23 files**, including 23 new parser/config/process-level
ZCode tests using a fake Node CLI. Offline native-evidence checks and
git diff --check passed. No Cursor/Claude/Codex inference was performed.
Standalone and adapter model/resume are proven for this installation;
broker daemon/MCP acceptance with ZCode, role enforcement, large inputs,
native cancellation and the complete §18.1 matrix remain open.

Reproduce native acceptance (consumes quota):

```powershell
node tests/native-smoke/provider-spike.mjs zcode GLM-5.3-Flash
```

Verify retained evidence without inference:

```powershell
node tests/native-smoke/verify-zcode-adapter.mjs
```
