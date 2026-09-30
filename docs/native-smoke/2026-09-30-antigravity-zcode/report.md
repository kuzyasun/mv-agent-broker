# Limited native smoke: Antigravity and ZCode

Date: 2026-09-30, Europe/Kyiv. Operator authorized quota-consuming tests of
these two providers first. Codex, Claude Code and Cursor were not launched.
Source revision: `d1a9594` on `master`. Production adapters were unchanged.
The pre-existing untracked v0.2 specification was preserved.

## Scope and pinned environment

This is a minimal adapter smoke, not the complete P0 worker/reviewer profile
gate or spec §18.1 acceptance. Tests called each real adapter directly with
a dispatch gate, empty isolated workspace and a 90-second cancellation
deadline. Credentials remained CLI-owned; no credentials/config files were
copied or edited. No automatic model/provider fallback or fresh retry occurred.

| Component | Observed value |
|---|---|
| OS / runtime | Windows native, Node 24.11.1 |
| Antigravity | `C:\Users\902st\AppData\Local\agy\bin\agy.exe`, version 1.2.1 |
| Antigravity executable SHA-256 | `07f7ed55654b7066886c7390d3f5e245dbe4ede425c005909342cfc90333f2f8` |
| Antigravity requested/effective model | `gemini-3.8-flash-low`, confirmed by both native `init.model` events |
| ZCode | `C:\Users\902st\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs`, version 0.16.9 |
| ZCode bundle SHA-256 | `fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f` |
| ZCode requested/effective model | none selected; startup failed before a model response |
| Adapter versions | Antigravity 0.1.0, ZCode 0.1.0 |

## Observed results

**Antigravity: passed headless/model/ID/explicit-resume smoke.** Two CLI
processes exited 0 using pipes, without a PTY. Turn 1 received a random
marker and returned exactly that marker. Turn 2 was invoked with
`--conversation 51e6bafc-a883-4561-9b49-7bd600d02c20`, without the marker in
its prompt, and returned it exactly. Both native init/result records contain
that ID and `SUCCESS`; the adapter emitted `native_ref_obtained` and returned
the same ID. Dispatch permission was acquired once per turn. Both workspace
inventories remained empty. The CLI-owned native history is retained.

See [raw adapter/process evidence](antigravity.evidence.json) and
[model discovery evidence](antigravity-models.evidence.json). The model
catalog probe initially failed inside the network/filesystem sandbox; the
successful probe and smoke ran outside it. This was not an account login
failure. The historical Fusion requirement for PTY did not apply to this
specific two-turn test on agy 1.2.1; tool-heavy runs remain unverified.

**ZCode: failed startup.** One real adapter invocation exited 1, with empty
stdout and `PROVIDER_PROTOCOL_ERROR`. The installed CLI reported that it
could not locate its bundled provider configuration at either
`resources/glm/provider/zcode-builtin.json` or
`C:\Users\902st\AppData\config\provider\zcode-builtin.json`.
The installed file actually exists at
`resources/config/provider/zcode-builtin.json`.
See [raw adapter/process evidence](zcode.evidence.json).

Read-only inspection of the installed bundle confirms the fallback path
calculation in `resolveBundledZCodeBuiltinProviderConfig` and the native
overrides `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` /
`ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`. The broker's ZCode environment
allowlist does not pass these overrides. No workaround was applied during
this smoke. A follow-up launch fix should use the installed non-secret
provider file and CLI-owned personal provider config, with explicit model
confirmation, rather than copying credentials or modifying the vendor bundle.
The old `~/.zcode/cli/config.json` has only MCP/plugins; that observation
alone does not establish that 0.16.9 lacks a configured provider, because the
current CLI also uses the v2 provider configuration.

The ZCode adapter also does not wire `requested_model`, `--resume`, or native
ID capture. Even after resolving startup, a successful print run cannot
prove native continuity or close its mandatory resume contract.

## Usage and validation

Quota-consuming successful inference: **two Antigravity turns**. The one
ZCode attempt failed during provider-path bootstrap, with no model response
or usage record; no successful ZCode inference was observed. Remaining
subscription quota and monetary cost are unknown.

Antigravity exposes native usage in the captured stream, although the
adapter currently does not return it. The result records are cumulative
over this conversation: the final values equal the sum of the two completed
agent-response step records. Do not sum turn 1 and turn 2 result counters.

| Native counter | Turn 1 result | Turn 2 cumulative result |
|---|---:|---:|
| input_tokens | 19,916 | 23,903 |
| output_tokens | 131 | 160 |
| thinking_tokens | 102 | 102 |
| cache_read_tokens | 0 | 16,291 |
| total_tokens | 20,047 | 24,063 |

These are CLI-reported counters, not independently measured billing or a
context-reuse benchmark. Cache/thinking accounting is preserved as reported.

- `npm run typecheck`: passed.
- `npm test`: **187/187 passed, 22 files**, after retrying outside the sandbox
  because the initial esbuild launch failed with `spawn EPERM`; no inference
  occurs in this suite.
- Offline evidence assertions: both native models/IDs/statuses/marker
  continuity/process exits, resume argv, one gate acquisition per turn,
  cumulative usage consistency, ZCode failure and empty test workspaces.
  Command: `node tests/native-smoke/verify-evidence.mjs` (no inference).

Not exercised: broker daemon/MCP lifecycle, restart recovery, invalid-history
handling, worker writes, read-only enforcement, artifact delivery, snapshot
refresh, large prompts, cancellation/process-tree quiescence, effort choice,
other models/platforms. **§18.1 remains open.** The matrix marks only the
specific exercised Antigravity capabilities `smoke_tested`, and ZCode
headless launch `failed` for this pinned installation.

## Opt-in reproduction

From the repository root, using Node 24 and authenticated local CLIs:

```powershell
node tests/native-smoke/provider-spike.mjs models
node tests/native-smoke/provider-spike.mjs antigravity gemini-3.8-flash-low
node tests/native-smoke/provider-spike.mjs zcode
```

The last two commands may consume quota. They are excluded from `npm test`.
Antigravity gets at most a fresh turn plus one explicit resume; a failed
turn or missing native reference stops the chain. Detailed new evidence is
written under `.state/native-smoke/`. The retained JSON above captures the
original smoke; stricter raw init/result assertions were subsequently added
to the runner and checked offline against that original evidence, without
repeating inference.
