# Operator pilot issue log

Keep this log short. After a real task, record an issue only when it affects
completion, correctness, cost, or the operator workflow. Fix blockers first;
defer uncommon cases until they recur or have a clear practical impact.

For a new issue record the provider/model, broker turn ID, observed error or
reproduction, impact, workaround, and status. Link retained evidence without
publishing credentials, native thinking, or full vendor transcripts. A vendor
error alone does not establish a broker defect.

## 2026-10-01: Antigravity coding turn server failures

Two author turns using requested `gemini-3.8-flash-high` through accepted
broker `8db50fb` failed with the native diagnostic
`INTERNAL (code 500): Internal error encountered.`:

- `turn-cc83e3fabe3e24da38a96340`, parent
  `194c5bb1-9d20-416d-b5a5-275574db913e`.
- One explicit shorter-task retry, `turn-d36c25790b63f5865803ae7d`, parent
  `2e32b35e-883e-4eda-b41a-66e6330c9854`.

Both were classified `FAILED / PROVIDER_PROTOCOL_ERROR`, with execution
started and owned quiescence receipts. Neither left source changes in the
isolated author checkout. They were not promoted to successful work or silently
retried by the broker. This is a provider-reported server failure; the cause of
the native `500` remains unknown.

The coordinator stopped repeating high and explicitly selected the operator's
already authorized medium route for a bounded implementation attempt. The
[short medium subagent smoke](native-subagents.md) succeeded separately;
that result does not establish reliability for longer author tasks.

Private evidence: `.state/coordinator/pilot-routes-repo/.state/dogfood/`
directories `2026-10-01T18-10-03-799Z-d0ca5ec9` and
`2026-10-01T18-23-37-151Z-9e54c1f3`.

Status: retained provider incident; no adapter retry/fallback feature added.

The explicit medium implementation attempt also failed with the same native
`500`, turn `turn-fffc09e7d05bd14f885bf85e`. Its exact native parent ID is
retained in private evidence.
Source changes remained zero and the broker recorded owned quiescence.
Private evidence directory: `2026-10-01T18-28-08-816Z-fa051405`.
The coordinator stopped long Antigravity author attempts and moved the fixed
implementation design to a bounded Cursor Luna/high worker. Small native
subagent probes succeeded for both vendors separately.

## Concurrent coordinator edit attributed to a native turn, 2026-10-02

Cursor completed the profile-help/agent-decides implementation and terminated
normally, but turn `turn-a07c7e921548c02738e2268c` finalized as
`FAILED / SCOPE_VIOLATION`. The coordinator added `AGENTS.md` to the same checkout
after the worker baseline, outside the worker's declared source coverage. The
broker detected that new protected path; it cannot attribute a filesystem change
to a particular writer. The coordinator verified the completed diff and tests,
then captured a separate current snapshot for review without another paid author
launch. Future author work uses an isolated checkout with no concurrent
coordinator edits. No broker enforcement change was added.

Private evidence: `.state/dogfood/2026-10-01T22-33-43-225Z-d6857849/`.
