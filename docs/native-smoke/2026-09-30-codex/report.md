# Codex native MCP smoke — 2026-09-30

Status: **short model/effort/native resume and caller-independent MCP route passed**.
Full worker/reviewer/profile acceptance (§18.1) remains open.

## Tested route

- Windows, Node 24.11.1; native npm Codex CLI **0.157.0**; adapter **0.2.0**.
- Existing native login: `Logged in using ChatGPT`; no second login or token extraction.
- Model **gpt-6-luna**, reasoning effort **low**, confirmed in both native
  rollout turn contexts. CLI metadata/catalog checks sent no inference.
- Plain Node MCP client -> separate `src/bridge/main-stdio.ts` process ->
  private named pipe -> separate daemon using production bootstrap -> Codex.
- Disposable Git workspace under ignored `.state/native-smoke/`; caller
  requested short text responses and no tools or file changes.

Two processes (PIDs 68536 and 71076) exited 0 with no stderr. The first ended
at 19:44:31.666Z; the second started at 19:44:31.785Z. Both returned native
thread ID `01a0f3d8-cc81-78c1-a040-7f0aa5239208`. The first prompt introduced
a random marker. The second stdin omitted it and returned the exact marker,
using explicit `exec resume <ID>` after the original process exited.

The MCP route exercised initialize, all 13 tools discovery, broker status,
session spawn, two sends, status/events/result reads and session close. Both
turns were SUCCEEDED; continuation changed from `new_native_conversation` to
`native_resume`. Result summaries contained the marker, quality stayed
`unreviewed`, and broker observations contained input/final snapshot IDs.
The broker session reached CLOSED. No Codex Desktop chat API was involved.

Evidence: [passed MCP/process/native metadata](mcp-resume.evidence.json).
Full native rollouts and private broker logs are omitted from public evidence.

## Initial failure and changes

The first quota-consuming request (19:36:42Z) completed successfully at the
CLI/process layer but received an envelope with only IDs, snapshot and input
bindings, without caller instructions or task goal. It answered that there
was no task. MCP returned `agent_reported: null`, and the smoke assertion
failed. This was **not quota or authentication failure**. Only one request
ran before the test stopped; no automatic retries/fallback occurred.
[Retained initial failure](initial-delivery-failure.evidence.json).

Changes made before the successful pair:

- Codex uses JSONL `thread.started`, completed agent message and turn
  completion/failure events. It records real identity immediately, requires
  explicit model, passes effort, checks resumed identity and process outcome,
  and uses no fabricated references or notify-file bridge.
- Windows profile/temp environment and native auth variables are preserved.
  `--ignore-user-config` excludes ambient model/MCP defaults, with native auth
  still owned by Codex. It does not suppress all managed/project instructions.
- Broker persists session instructions in its existing provisioning intent
  and task contracts in admission events. Envelope construction validates the
  stored instruction/goal hashes before dispatch and delivers the full task.
  Missing legacy text fails input delivery before inference.
- Broker retains bounded native reports separately and returns them in the
  existing `agent_reported` result field. Tables and MCP field shapes are
  unchanged; agent claims remain separate from broker observations.

## Native usage

`turn.completed.usage` is **cumulative on resume** in this CLI. Native rollout
`token_count.info.last_token_usage` confirms independent request increments.
Cached input is a subset of input, not an additional token amount.

| Request | Input | Cached input within input | Output | Total input + output |
|---|---:|---:|---:|---:|
| Initial delivery failure | 17,366 | 11,008 | 30 | 17,396 |
| Corrected fresh marker | 17,448 | 11,008 | 23 | 17,471 |
| Corrected resume increment | 18,664 | 17,152 | 23 | 18,687 |
| All three requests | 53,478 | 39,168 | 76 | **53,554** |

The successful pair's final cumulative total is **36,158**, not the sum of
its two cumulative JSON counters. Reasoning/cache-write counters were zero.
No account quota percentage, dollar charge or remaining allowance is inferred.
Broker result usage remains unknown; these are native smoke measurements.

## Scope and limitations

The adapter requested worker `--sandbox workspace-write`, but **both native
turn contexts recorded sandbox_policy.type=read-only** and approval_policy=never.
No tools were used. Effective write permission mapping, worker file changes,
reviewer write denial, tool-tree cancellation, broker crash/restart across
turns, large inputs, other platforms/models/efforts and exhausted quota remain
unverified. Do not label any complete role/profile combination supported.

Older Codex broker sessions pinned to adapter 0.1.0 fail adapter drift checks.
Older sessions for any provider without retained instruction/task text cannot
be safely reconstructed; create a new session. The native CLI conversation
is separate from this Codex Desktop chat; the caller supplies its own task.

## Reproduction and offline checks

Quota-free transport rehearsal:

```powershell
node --experimental-transform-types tests/native-smoke/codex-mcp.mjs --mock
```

Explicitly opt-in native run, two requests maximum, stopping at first failure:

```powershell
node --experimental-transform-types tests/native-smoke/codex-mcp.mjs $env:AB_CODEX_BIN gpt-6-luna low
```

Set AB_CODEX_BIN to the intended absolute native executable; see the
[operations guide](../../providers.md#codex). The test registers disposable
project/account/policy/coverage/coordinator records in its own state directory.
Local Node needs `--experimental-transform-types` for existing TypeScript
parameter properties. The smoke script is excluded from `npm test`.

```powershell
npm run typecheck
npm test
node tests/native-smoke/verify-codex-mcp.mjs
```

Offline tests cover native stream replay, missing/conflicting identity, exact
resume args, failure/cancellation/timeout priority, gate denial, corrupt/missing
task/instructions before dispatch, bounded reports, coordinator ownership,
full MCP contract delivery and retained result after session close. No further
native model requests are needed to replay the evidence.

Final local verification: **288/288 tests across 27 files passed**, typecheck
passed, and all retained native evidence validators passed without inference.
The diff check for changed implementation/docs/tests is clean. The unrelated
staged specification retains its existing Markdown hard-break whitespace.

References: [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode),
[Codex app-server alternative](https://learn.chatgpt.com/docs/app-server).
