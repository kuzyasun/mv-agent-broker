# Native four-turn feedback checkpoint

## Scope and accepted runtime

The caller-independent harness drove the existing MCP API through a frozen
copy of accepted commit `0409fb173a704c8fc849bb41ba05bbb1efda967d`
(67 tracked runtime files). Native authors edited an owned harmless fixture,
separate from the coordinator checkout and the shared Beehive/DMP daemon.
The shared daemon was READY and the full Agent Broker route catalogue had
`next_cursor: null`, revision 19, before the paid retry.

- Worker: ZCode, `GLM-5.3-Flash`, effort `max`, CLI-owned login; configured
  Individual account. Actual vendor account identity remains unverified.
- Reviewer: Cursor, `grok-4.7-high`, effort `high`, read-only role.
- Deadline: one hour per turn. No Claude, native Codex, fallback, additional
  cancellation probe or comparative benchmark was invoked.
- Worker policy defaults to the entire project with root source coverage.
  The deliberately small fixture and immutable baseline controls are test
  acceptance criteria, not a policy file allowlist.

## Observed setup failures and repairs

The initial attempt exited before any turn: native `--serve` imported the
daemon's asynchronous entrypoint and immediately called `process.exit(0)`.
The harness now leaves the native daemon alive until stdin-owned shutdown.
A no-inference regression starts the actual exported native daemon, observes
READY, closes stdin, verifies exit zero and an empty turns table.

The next attempt completed one paid ZCode turn, but its first Cursor review
was refused with `PROVIDER_INCOMPATIBLE`, `execution_started: false`.
The projected private SQLite store plus sidecar was 324 characters, exceeding
the Windows 260-character guard. This was a path failure, not quota evidence.
The coordinator independently verified the retained deliberate divide failure
(`0.5 !== 2`). Both sessions closed and private children exited.

The harness now creates a fresh owned `<system temp>/ab-feedback/<random-id>`
root independently of checkout depth. The regression checks the actual
Cursor store projection, rejects adoption of a preexisting root and validates
its ownership marker before cleanup. The adapter guard was not disabled.
Failed attempt evidence remains private and retained. After these repairs the
coordinator explicitly started a fresh four-turn run on the same model pair;
this was a manual test retry, not an automatic provider retry or fallback.

## Accepted native run

The accepted run used owned root suffix `6842709c`, began at
`2026-10-03T04:19:37.346Z` and finished at `2026-10-03T04:25:16.356Z`
(339.010 seconds wall-clock, including setup and teardown).

| Phase | Turn | Result |
|---|---|---|
| Implement | `turn-73bf95feef8e57df24d27291` | SUCCEEDED; intended divide regression, helper added, obsolete file deleted |
| Review R1 | `turn-32cce951320ee25dc9bb2705` | SUCCEEDED; identified the divide defect with source/test references |
| Fix | `turn-4bf544dd9af1bb9f07a2c894` | SUCCEEDED; original ZCode session fixed the divide defect |
| Review R2 | `turn-ca37a106301d376b96916cea` | SUCCEEDED; original Cursor session reported no remaining findings |

Worker session `session-8487610252492b9c5bc6f45a` and reviewer session
`session-c121e8c8b0acb81249ce4aac` retained their respective observed native
conversation references across their two turns. Both sessions finished CLOSED,
with no active turns; the private bridge and daemon exited with no unresolved
children. Runtime, fixture and private evidence were retained for inspection.

- S0: `snap-c7827ff7d827ec8563342f17`.
- S1: `snap-98575811b900fcd68806d0a6`.
- S2: `snap-a1e44589835d086f1783d6a8`.
- R1 findings: `art-5c3771710b416205675f5b07`, 1,027 UTF-8 bytes,
  SHA-256 `4af5db2b43bb3db199490808a8115d7a95fa1817020aa195c137661386f57f57`.

The FIX request referenced only the findings artifact ID; reviewer prose was
not copied into the coordinator task. The observed input manifest matched its
ID, hash and size and granted inline delivery. A foreign coordinator was denied
access to that exact artifact. The R2 review slot matched the assigned S2 files
byte-for-byte, with the deleted file absent and the new helper present.

## Coordinator acceptance and offline gate

The coordinator read both complete findings reports and inspected the final
fixture diff after native shutdown. `src/math.js` exactly matched its baseline
again; `src/obsolete.js` was deleted and `src/calc.js` added `sumAll`. No baseline
test/package/index/HEAD changes occurred. Independent `node --test` passed 2/2;
additional nonpersistent helper assertions passed for empty, positive and
mixed-sign input. These observations support acceptance, separately from the
agents' reports.

- Typecheck passed.
- Harness plus existing policy restrictions: **51/51 passed** (17 + 34).
- After clarifying the fixture-check diagnostic names, the final harness suite
  independently passed **17/17**; `node --check` passed.
- The previous full accepted integration gate remains 888 passes and one
  platform skip; the full suite was not rerun for this small harness portion.

## Measurement and remaining boundaries

Across the three attempts, one startup failed before admission, one chain
recorded a successful paid worker and a zero-inference refused reviewer, and
one four-turn chain was accepted. There were six recorded turns and five
observed native dispatches. Failed attempts are retained, not omitted as free
or successful work. Provider usage and billing fields are unknown; no monetary
amount, token saving or subscription quota cost is inferred from those counts.

This confirms the persistent feedback workflow for the exact Windows/model
pair above. It does not certify mandatory native confinement, source-read
receipts, model comprehension, other provider/role/platform combinations or
cancellation during native tools. Fresh/persistent/compact-handoff comparison
remains `not_run`; this small continuity acceptance is not that comparison.
