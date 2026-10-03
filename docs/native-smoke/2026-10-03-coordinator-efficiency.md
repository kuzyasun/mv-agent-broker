# Coordinator-efficiency integration checkpoint

Baseline: shared accepted `e1ef4e6`. Integrated branch:
`codex/coordinator-efficiency`, separate from the shared checkout/runtime.

## Accepted portions

- `c5ccfb2` plus `e114efe`: AD-01 guide, bounded-task and explicit handoff
  templates, four API 0.2 examples, gap mapping and a comparable task-chain
  benchmark protocol. Operator addendum retained byte-for-byte. No runtime
  router, semantic memory, schema changes or automatic retries were added.
  [Verification and remaining native boundaries](../validation/post-v0.2-efficiency-check.md).
- `aa1ce79`: compact complete review diffs. Every actual change survives;
  snapshot coverage, required inputs, review bindings and full source are
  unchanged. [Native author/review and local proof](2026-10-03-compact-review-diff.md).
- `9a46a7e`: independent Windows UI launcher, with accepted-runtime checks,
  occupied-port refusal and observed listener/HTTP startup. It starts no
  daemon or inference. [Owned Windows fixture proof](2026-10-03-independent-ui.md).

All portions used the last accepted broker copy for authorized isolated native
authors; substantive code received independent native review and coordinator
acceptance. ZCode, Cursor and Antigravity were used; Claude was not invoked.
Private native transcripts/configuration and runtime evidence stay outside Git.

## Final integration gate

- Typecheck passed.
- `npm test -- --maxWorkers=2`: **62/62 files passed; 888 tests passed,
  one existing platform skip**, duration 270.16 seconds. Offline adapters use
  fixtures; these tests are not a full native-provider certification.
- The initial wide-parallel run had 887 passes, one existing skip and one
  recovery-test timeout at its 20-second limit. The recovery file passed alone
  (4/4, affected case 5.751 seconds) and in the capped full run (4/4). Production
  behavior, test limits and Vitest configuration were not changed.
- Earlier focused gates passed: AD-01 examples through actual bridge parsing
  (4/4), delivery/diff integrity (40/40), snapshot/mock feedback flow (41/41).
  Fourteen independent `git apply` fixtures reconstructed target bytes exactly.
- The same one-edit, 10,000-line complete diff document shrank from 300,123 to
  339 UTF-8 bytes. This measures bytes, not exact tokens, native quota or money.
- Authored changes pass whitespace checks. Five intentional Markdown hard-break
  lines in the untouched operator addendum are excluded from that assertion.
  Its SHA-256 in both checkouts remains
  `6a2993a6a5ea8fe1cf9d5f3dc984c3e4d5cd922b0eb89786271f2090e12cbad7`.

## Shared operation and deferred work

The shared daemon and UI were verified READY/applied on `e1ef4e6` with Agent
Broker, Beehive and DMP registrations intact. No shared restart or deployment
occurred. The separate test UI was stopped using exact owned process identity.
New portions require a guarded idle update before other projects consume them.

Comparative native fresh/persistent/handoff benchmarks remain **not_run** with
the explicit protocol recorded. Researcher routing is deferred; no default
researcher stage was introduced. Existing native confinement, account identity,
combined feedback continuity and wider resource/platform gates remain open.
Do not equate offline success or successful native author/review calls with
complete MVP acceptance or proven savings.
