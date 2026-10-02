# Operator pilot issue log

Keep this log short. After a real task, record an issue only when it affects
completion, correctness, cost, or the operator workflow. Fix blockers first;
defer uncommon cases until they recur or have a clear practical impact.

For a new issue record the provider/model, broker turn ID, observed error or
reproduction, impact, workaround, and status. Link retained evidence without
publishing credentials, native thinking, or full vendor transcripts. A vendor
error alone does not establish a broker defect.

## 2026-10-02: Stale failed worktree quarantine required explicit offline release

The observed Beehive worktree provisioning failure was durably recorded as
`worktree-provisioning: git-add-failed`. The generated allocation was absent
and unregistered in Git, but the failed session's workspace quarantine
correctly continued to block admission after the session was closed. Closing
the session is intentionally not a quarantine-release operation.

Impact: the corrected coverage configuration could not start a replacement
worktree until an operator had a bounded, auditable release path. Workaround:
close the failed session, stop the daemon, inspect the exact journal and
quiescence evidence, then run the offline `reconcile-workspace` command. The
command supports only this fully closed case with no native inference;
the original Git launch receipt is retained and its processes must be absent.
It creates a
private SQLite backup and JSON receipt, clears one quarantine flag, and writes
an audit event. Unknown/active turns, pending intents, execution/workspace reservations, existing
or registered paths, live recorded PIDs, mismatched journals, and other
quarantine reasons remain refused.

Status: resolved by the explicit operator workflow. No provider retry,
inference, path deletion, Git pruning, or generic force-release behavior was
added.

## 2026-10-02: Beehive snapshot and Windows worktree blockers

Beehive Stage review could not start: snapshot `INPUT_LIMIT` at an ignored Dart
cache under `artifacts`, followed by `git-worktree-add-failed: git-exit-nonzero`
in session `session-0ab0909cd092b68c1da12aa5`. No inference was submitted.

The project wizard admitted `artifacts` as source, and the saved coverage also
included nested Angular dependencies/build outputs under `web`. Corrected
active coverage excludes those caches, declares `web/src` and its root files
separately, and captures approximately 153 MiB without raising the 256 MiB cap.
New coverage/worker-policy IDs preserve the failed session's historical
bindings; route models, efforts, accounts, and delegation settings stay intact.
The wizard now excludes common top-level `artifacts`, `.dart_tool`, and
`.angular` folders; nested cache scope still requires explicit configuration.

An isolated reproduction of the selected commit exposed Git's `Filename too
long` error for tracked research images under the longer managed worktree
root. Windows mutations now pass `-c core.longpaths=true` per invocation,
without writing Git configuration. Bounded stderr inspection returns
`git-path-too-long` for that failure, without exposing raw paths or stderr.

Validation: 50 targeted worktree/UI tests, typecheck, independent Antigravity
review, and coordinator final diff review. The updated live MCP sealed a
current-checkout snapshot and provisioned an IDLE detached worktree containing
a tracked file at a 262-character absolute path. The test session had zero
turns and was closed. Beehive HEAD, Git index, and the three Stage files matched
their captured baseline. Stage review/acceptance remains with its coordinator.

Private evidence: `.state/coordinator/beehive-workspace-acceptance.private.json`
and `.state/coordinator/beehive-config-plan.private.json`; author/reviewer
receipts under `.state/coordinator/workspace-fix-repo/.state/dogfood/`.

Status: both observed blockers resolved. Bridges running older code need one
client reload. Updated bridges recover from later daemon restarts as described
below.

## 2026-10-02: Running bridge loses connection after daemon restart

After the Beehive fixes restarted the shared daemon, an already running client
continued exposing MCP tools but every call failed with
`Daemon RPC client is not connected`. Fresh clients returned READY. The bridge
authenticated only at startup, kept the old token, and never reconnected.

The bridge now reconnects before its next discovery/tool call with the same
coordinator and rereads the rotated token. Concurrent callers share one
connection/handshake, and old-socket events affect only that socket's pending
requests. Connection/authentication has a five-second bound. Failed connection
attempts do not prevent a later call from recovering. A dispatched tool call
whose connection is lost fails without automatic replay.

Validation: 11 integration tests, typecheck, independent Antigravity review,
and coordinator final review. A separate coordinator-owned process check kept
one real stdio bridge alive while restarting its test daemon and rotating the
token. A call while unavailable failed; later status and tool discovery
recovered. No paid inference was submitted in that process check.

Private evidence: `.state/coordinator/bridge-recovery-acceptance.private.json`
and author/reviewer receipts under
`.state/coordinator/bridge-reconnect-repo/.state/dogfood/`.

Status: fixed for updated bridges. An old bridge must be reloaded once to load
the code. The live daemon and project configuration do not need another restart
for this bridge-only change.

## 2026-10-02: Cursor review deadline and private path budget

A Cursor Grok-4.7/high review on a deeply nested private state directory was
refused before inference because its projected SQLite path exceeded 260
characters. The coordinator shortened only the private review state directory.
That explicit retry started execution and read source, but reached its
seven-minute deadline without a report. Neither attempt establishes review
acceptance. Private evidence: dogfood directories
`2026-10-02T19-42-09-111Z-2e7851dd` and
`2026-10-02T19-45-54-343Z-e8a24737`.
The live Cursor worker smoke separately succeeded on the saved Grok high route.

## 2026-10-02: ZCode review reached its deadline without a report

A GLM-5.3/high review through the accepted broker ended `TIMED_OUT` with
execution started, termination reason `deadline`, and no report or native
conversation reference. No quota error was recorded, so quota exhaustion is
not established. The coordinator did not accept it as a completed review.
Private evidence: self-development dogfood directory
`2026-10-02T19-33-15-498Z-c497f148`. Diagnose the missing native output in a
separate bounded provider investigation; do not assume that `STARTING` means
no paid execution began.

## 2026-10-02: Antigravity quota reported as protocol failure

An authorized Gemini 3.8 Flash/high review ended with an explicit native
individual-quota exhaustion message. The broker retained that message, marked
execution started, and returned `FAILED / PROVIDER_PROTOCOL_ERROR` with no
review report. It was not accepted as a successful review or automatically
replayed. The operator error-details panel exposes the retained cause even
when the adapter's code is generic. The 2026-10-03 adapter follow-up maps an
explicit `FAILED.result.error` starting `Individual quota reached.` to
`QUOTA_EXHAUSTED`, with fake-native regression coverage. It does not relabel
the historical turn or claim a new live quota failure; response-only/stderr
messages remain generic. See the
[checkpoint](native-smoke/2026-10-03-antigravity-quota.md).
Private evidence: self-development dogfood directory
`2026-10-02T19-28-53-288Z-5ffff203`.

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
