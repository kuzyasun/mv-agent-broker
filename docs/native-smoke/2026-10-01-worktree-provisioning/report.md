# Detached worktree provisioning checkpoint — 2026-10-01

## Accepted behavior

Spec §8.3 adds broker-created detached worktrees through agent_session_spawn.
Set workspace.mode=worktree, repository_workspace_id to a registered current
repository workspace in the same project, and base_commit to its explicit full
40- or 64-character lowercase commit id. Omit workspace_id. Existing registered
workspace calls remain supported. Contradictory fields are rejected before
admission; the accepted key replays the same session and generated workspace.
No inference is needed to provision the checkout.

Git creates a detached checkout of the committed tree under the managed root.
Dirty and untracked source content is not copied. Closing a session preserves
its worktree and edits; provisioning never deletes or adopts a foreign target.
The response includes an additive worktree summary; discovery advertises source
eligibility. No database schema migration is introduced.

## Ownership and recovery

Git mutations use the existing Windows Job object helper. The journal records
exact launch ownership before resume. Success requires quiesced exit zero with
drained pipes and matching launch/completion records. A parent exit, target
files, or a stage label alone cannot establish completion. The journal is
trusted broker metadata, not cryptographic authentication against arbitrary
SQLite modification. Unsupported platforms refuse managed mutations honestly.
Both pipes have fixed output limits; ambient GIT_* routing variables are removed.

Mutations serialize by resolved shared Git common directory, including checkout
aliases. The lock covers verification, physical cwd binding, initial capture,
and failure/quarantine/fence transitions. Exact hold/incarnation checks prevent
a late pre-dispatch holder from resuming or failing a replacement. Before resume,
the source common directory is checked again to refuse retargeted source aliases.

An UNKNOWN mutation or post-add inspection retains its journal and durable fence.
The fence is installed before unlock and rebuilt after restart. A malformed
journal fences recoverable common-directory identities and quarantines the
session-owned worktree row. If its repository scope is unreadable, new Git
mutations are conservatively held globally; no unrelated repository is assumed
safe. When the scope is known, healthy unrelated repositories remain usable.
There is no PID-based release, timeout release, automatic retry, or force cleanup.

## Native author and independent review

Implementation used Antigravity gemini-3.8-flash-high through the public MCP
interface of a frozen broker runtime from accepted commit a176221, in an isolated
clone. Author turn turn-80424a3cd73fa4a94c68a83a ended SUCCEEDED with owned
quiescence. Its declared report SHA-256 is

a7dbc7198ae71ea98d8c486117314df7b2f515047b6d18ac78a16c87692de0c7.

Independent Cursor auto review turn turn-5a8b21de26daa2d11fcb7e6d ended SUCCEEDED
with owned quiescence. Its declared report SHA-256 is

7e1b0d9b331408e701c0cace4bafed345a40861d8a4ba4283ed1625ef3d676ce.

The coordinator confirmed and fixed all four findings: late fence installation,
malformed-journal common-directory key mismatch, missing owned-row quarantine,
and missing durable fence after UNKNOWN post-add inspection. Additional fixes
keep failure transitions under the lock, reject stale ownership callbacks,
refuse retargeted source aliases before resume, and withhold unexpected raw
execution errors. Eleven added regression cases cover these outcomes. The
completed-add recovery fixture now waits for the actual managed completion
receipt rather than merely observing that a directory appeared.

A second sealed Cursor review (turn-8f0508eb50fc75e55fe75aa7) ended SUCCEEDED
with owned quiescence; report SHA-256:

7ef7c6861c8f7a701fc9b095a6dfd1fcab4d0b37f33ef762aa1c14c0a89a393d.

Its additional crash-window finding was confirmed and fixed: every pending
completed add fences siblings on restart until its owner verifies and completes
under the lock. UNKNOWN evidence cannot take this verification-only path or
release the fence. Tests cover both added and ready, including sibling-first
arrival and idempotent replay after owner completion. The coordinator additionally
made helper uncertainty outrank a missing resume acknowledgement, with a focused
protocol-result regression, and revalidates the ready-stage hold before completion.
Reports are review evidence; the coordinator owns source review and acceptance.
No Claude or Codex vendor CLI was used for this portion.

## Coordinator validation

- npm run typecheck: passed on the repaired isolated source.
- Five focused suites: 79 passed before the additional source-alias regression.
- Source-alias regression: 1 passed, 34 deselected; no Git mutation resumed.
- Isolated full suite before the final narrow repairs: 762 passed, 1 skipped, 45 files.
- Final helper-loss/ready recovery checks: 2 passed, 35 deselected.
- Restart verification-fence checks: 4 passed, 35 deselected.
- Main checkout npm run typecheck: passed after exact nine-file integration.
- Main checkout npx vitest run --maxWorkers=2: **766 passed, 1 skipped, 45 files**,
  exit 0, 190.44 seconds. Dedicated worktree suite: **39 passed**.
- git diff --check: passed. The original partial source and index patch are
  retained privately; no unrelated clone was integrated.

## Boundaries and remaining work

Worktree separation does not prove native host confinement or vendor tool
permission enforcement. Complete mandatory native profiles remain open.
The fresh owned inputs/slots base-directory initialization issue remains separate;
private dogfood clients pre-created their own bases without relaxing link checks.
Event-wait, physical storage admission, and operator setup packages remain
unaccepted in separate private clones. Their partial files and earlier failed
ZCode evidence are preserved; this checkpoint does not complete the whole MVP.
The operator requested a clean main checkout and a stop after this portion.
