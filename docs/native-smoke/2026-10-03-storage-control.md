# Operator storage control checkpoint

Date: 2026-10-03. Accepted supervisor runtime: `de7b3f1`.
Status: implemented and accepted in the isolated development worktree.

## Behavior

The operator can select a project and minimum retention days (default 7),
preview registered blob accounting and protected roots, then explicitly clear
only that preview's candidates. The private RPC/HTTP surface adds no MCP tools
or automatic background cleanup. Preview handles live in daemon memory for at
most five minutes; only the latest 20 are retained. Execution rechecks current
project authorization, pins, retained snapshot references and pending
publications. Replays of completed handles reuse the result and one audit.

Counts describe registered blob rows, not full physical disk use. SQLite,
turn/idempotency metadata, worktrees, materialized input areas, unregistered
files, native clones and provider conversation history are excluded. Retained
unreadable manifests and unfinished publications block destructive execution.

## Native author and independent review

ZCode Individual `GLM-5.3-Flash/max` authored backend service, cleanup extension,
RPC/HTTP wiring and tests in an isolated clone under the frozen accepted broker.
Turn `turn-56027af339291f6a5fb812e0` succeeded and its session closed. The
coordinator completely read and verified the sealed 4,140-byte author report
`art-79a2217fa41978e713191c63`; SHA-256
`91677b0af974ffc473d60a148139dec7e8dfebb8f57b787242b92dcb7ef6058d`.

The coordinator integrated only the completed author's source, added UI/docs,
and fixed authorization on completed-handle replay and serialization of HTTP
cleanup with Save/Restart. Two attempted Cursor reviews failed before inference
because the new UI source contained invalid UTF-8; the coordinator repaired
four incorrectly encoded characters and added strict UTF-8 asset validation.
Independent Cursor `grok-4.7-high/high` then started on the complete combined
sealed baseline/target. Final findings and acceptance are recorded below.

Reviewer turn `turn-a938090eed19ba464ee81bf9` SUCCEEDED. Its complete sealed
findings `art-d3a0b684fc86de5231a78190` (2,102 bytes) were read and verified;
SHA-256 `fc2fc14cb1d91e02a0e90bf5895c5e29c8b1dbb03f7c48cd32d6f5eb64a9a691`.
Baseline `snap-ad0aa1b37939283e086d63ac`, target
`snap-9e5e8041c0edcbcbb548dfcc`. Author, capture and reviewer sessions ended
CLOSED with no active turn; the owned harness exited without a close error.

## Findings and coordinator acceptance

- High: a failed capture leaves an unpublished staging artifact, permanently
  blocking project cleanup. Old unpinned staging manifests are now eligible
  only when every same-project capture owner is FAILED. Execution rechecks
  owner state and pins before expiry. Failed snapshot/error metadata remains;
  live CAPTURING, unknown owners and pinned failed captures remain protected.
  A regression uses the real capture failure path; another adds a recovery pin
  after preview and proves no destructive change. Live capture remains blocked.
- Low: Apply advanced could invalidate the UI preview during confirmed cleanup,
  hiding its successful result. It now shares the UI operation guard and is
  disabled during cleanup. Confirmed results identify their bound project and
  survive other form rerenders as well. A deferred HTTP-response test verifies
  the result remains visible after selection invalidation and the advanced
  control becomes available afterward.
- Coordinator browser fix: small nonzero blobs rounded to zero MiB. Amounts
  below MiB now use B/KiB, verified by a UI regression and a fresh isolated
  browser preview of a 28-byte blob. The final screenshot shows this UI source.

The native review inspected the sealed implementation before these coordinator
repairs. Actual diff inspection and targeted regressions accepted the repairs;
no second paid review or native author claim was added.

## Verification

- TypeScript check, JavaScript syntax check and `git diff --check`: PASS.
- Initial focused cleanup/service/HTTP/UI/report checks: 49 PASS (6 files).
- After review repairs: 76 targeted tests PASS across eight files in focused
  checks. The final service/capture check passed 13 tests; the final storage and
  profile UI check passed 20 tests in two files. The storage UI includes strict
  UTF-8, small amounts and advanced-action/result-rerender races.
- Full offline suite: 940 PASS, 1 SKIP, 1 FAIL (66 files). The failure was the
  existing worktree serialization test, expecting two recorded mutations and
  observing one under concurrent load. Its complete file passed 41/41 when
  rerun alone; this checkpoint does not claim a clean full-suite run.
- Owned browser UI used the actual authenticated HTTP/private RPC/storage
  handlers with mock project data. Project/retention changes invalidated the
  preview; local regional timestamps and protected-root counts rendered.
  Cleanup expired one old report, removed exactly two registered blobs and
  reclaimed 1,320,000 registered bytes. The pinned recovery artifact, recent
  report and second project's blob survived. The resulting registry and audit
  receipt were inspected: one cleanup event, no preview token in the payload.
  Browser automation did not reliably expose the native confirmation dialog;
  confirmation cancellation/acceptance are covered by the UI unit tests.
  The owned fixture process and browser tab were closed. Shared UI untouched.

## Limits and deployment

Artifact expiry is transactional; physical blob deletion, audit insertion and
in-memory response caching are later steps, not one crash-atomic transaction.
This portion does not add persistent cleanup journals or full-disk inventory.
A daemon restart requires a fresh preview. Blob deletion failures preserve
registry rows for a later explicitly previewed action.

No shared Beehive/DMP storage was cleared, no shared daemon restarted, no live
configuration overwritten and no benchmark inference run. This checkpoint
records the development portion; it does not prove deployment at port 4318.
Private provider outputs, token files and runtime evidence remain outside Git.
