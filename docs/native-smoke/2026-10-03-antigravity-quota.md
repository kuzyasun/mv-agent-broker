# Antigravity explicit quota classification — 2026-10-03

## Outcome

An Antigravity `FAILED` result with an explicit string `result.error` beginning
`Individual quota reached.` now returns `QUOTA_EXHAUSTED` instead of
`PROVIDER_PROTOCOL_ERROR`. The prefix permits leading whitespace and case
variation, but requires the observed period. The diagnostic remains bounded
and sanitized, and execution remains marked as started.

Only this error channel is classified. Successful responses, response-only
failures, stderr prose and unrelated errors keep their existing behavior.
Uncertain ownership and output limits still take priority. No retry, fallback,
subscription selection, reset timer or configuration/schema change was added.

## Development and acceptance

- ZCode `GLM-5.3-Flash` / `max` authored the adapter and six fake-native
  regressions through the public MCP workflow; the author turn succeeded.
- Cursor `grok-4.7-high` / `high` independently reviewed the sealed target
  snapshot and reported no findings. Its review turn succeeded.
- Both runs used the frozen accepted broker commit
  `09b92a608409965292aecb387b3c827f23b74692`, a separate private daemon,
  explicit one-hour deadlines and an isolated author checkout. Claude was not
  used. The harness closed its sessions and stopped its private daemon.
- The coordinator inspected the actual source/test diff and preserved the
  existing unknown-execution/output-limit ordering. Documentation now reflects
  current deadline behavior and completed operator setup features.
- Coordinator `npm run typecheck`: passed.
- Coordinator `npm test -- tests/unit/antigravity-adapter.test.ts
  tests/unit/antigravity-parser.test.ts`: 48 passed across two files
  (28 adapter, 20 parser); six added cases cover the observed quota error,
  bounded detail, successful quota prose, response-only quota text, ordinary
  failure and generic stderr.
- `git diff --check`: passed. The full suite was not rerun for this focused
  adapter change.

Private author/review evidence remains in the isolated checkout's dogfood
directory `2026-10-02T22-53-53-249Z-f7325128`; credentials and raw native
reports are not committed.

## Verification and deployment boundary

The original quota incident is retained in [pilot issues](../pilot-issues.md).
The new mapping is verified with fake native processes, not a new live
Antigravity quota failure. Other vendor wording/error channels remain generic;
this checkpoint does not certify all quota errors or expose quota telemetry.
Historical turns retain their original codes.

This portion is committed in the development worktree. The shared Beehive/DMP
daemon remains on `09b92a6`; applying the new code requires a separate accepted
runtime update while idle. No active job or saved project configuration was
changed by this portion.
