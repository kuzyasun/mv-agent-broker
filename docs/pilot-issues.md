# Operator pilot issue log

Keep this log short. After a real task, record an issue only when it affects
completion, correctness, cost, or the operator workflow. Fix blockers first;
defer uncommon cases until they recur or have a clear practical impact.

For a new issue record the provider/model, broker turn ID, observed error or
reproduction, impact, workaround, and status. Link retained evidence without
publishing credentials, native thinking, or full vendor transcripts. A vendor
error alone does not establish a broker defect.

## 2026-10-08: UI catalogue refresh consumed the wrong response shape

The models endpoint returned `{observation, options}` correctly, but the UI
treated the entire response as the observation and read `models` at its root.
The refresh action failed and could put a malformed observation into its cache.
Separately, an unrefreshed Antigravity profile hid the effort selector, even
when the profile had a configured effort. Manual model entry hid it as well.

The live metadata-only endpoint returned 18 Antigravity model routes; the
Gemini 3.8 Flash options included low, medium and high. No provider inference
was needed to obtain that catalogue. The attached `inpage.js` wallet-adapter
broadcast errors did not establish a failure of this endpoint.

The UI fix consumes the endpoint's observation envelope, keeps the effort
control visible, preserves configured values and distinguishes unverified
choices from observed catalogue options. Provider metadata failures must be
reported as failures rather than a successful refresh of zero models.

## 2026-10-08: A snapshot ID in artifact_refs looked like an authorization failure

Beehive correctly created a read-only Antigravity worker session, then submitted
the same snapshot ID in both `workspace_precondition.expected_snapshot_id` and
`task.artifact_refs`. The latter accepts retained artifact IDs, not snapshots.
The generic `UNAUTHORIZED` response and operator-action guidance obscured that
request error. No turn was accepted for the affected session.

Use `artifact_refs: []` for an audit with no required retained artifacts; keep
the snapshot in its workspace precondition and reuse the same read-only session.
Use a new send key for corrected arguments. Preflight now explains a known
same-project snapshot in artifact_refs as `INVALID_REQUEST`, with the affected
field/index and `execution_started: false`. Unknown and foreign resources still
produce identical authorization refusals, now with artifact-field diagnostics
and `verify_required_artifact_refs` guidance. Tool/docs clarify the ID types.
Local mock tests verify successful corrected read-only execution and identical
foreign/unknown refusals. No native inference or shared deployment is claimed.

## 2026-10-08: Session-spawn fields were opaque in the client tool catalogue

The coordinator tried resource listings and searches inside Beehive to discover
spawn arguments. The observed client catalogue exposed `agent_session_spawn`
as an opaque union of argument maps, without named parameters. The advertised
schema had a root `oneOf` whose branches contained only required-field rules;
common field definitions lived outside those branches.

The spawn schema now exposes one object with named fields and typed, closed
`policy_restrictions`. Route/raw binding exclusivity and required bindings remain
validated by BrokerCore before acceptance. Coordinator instructions include a
complete scoped read-only spawn example. Local MCP tests confirm the audit grant
and reject missing or mixed bindings without creating extra sessions. Actual
client catalogue regeneration remains to be checked after deployment/reconnection;
the client schema conversion and its cache are outside these local tests.

## 2026-10-08: Audit instructions did not narrow a worker's write policy

Beehive's replacement Antigravity worker session stayed IDLE after its send
returned `SNAPSHOT_COVERAGE_MISMATCH`. Its durable policy granted
`workspace_write` over `["."]`, with no requested restrictions. The registered
workspace had a narrower coverage selector. Describing the task as a read-only
audit did not change that grant, and changing a per-send selector could not
replace the bound coverage profile.

For this audit, spawn the same authorized route and workspace with
`policy_restrictions: {"access":"read_only"}` and a new spawn idempotency key.
The existing session's binding stays unchanged. Session status now exposes a
compact durable `effective_policy`, and coverage refusals report the affected
scope, recovery guidance and `execution_started: false`. These diagnostics do
not expand coverage or change permissions. Validation uses local mock sessions;
no provider inference or shared-runtime update is claimed here.

## 2026-10-08: Unrelated catalogue changes invalidated sessions

Beehive reported an Antigravity send refused before inference because provider
readiness differed from the session binding. The reported diagnostic does not
identify which input changed, so the cause of that particular refusal remains
unconfirmed.

Code inspection found an unnecessary guard: the durable readiness fingerprint
included the entire model catalogue. The broker now excludes catalogue entries
from this comparison and relies on adapter preflight to validate the requested
model and effort. CLI/launch-input, authentication and account binding guards
remain. ZCode still fingerprints its installed provider configuration as a
launch input. Old session bindings need replacement after this upgrade.

Local fake-provider regressions cover catalogue changes before acceptance and
before dispatch, selected-route refusal and retained identity guards. This is
local validation; no paid provider inference or shared-runtime deployment is
claimed here.

## 2026-10-03: Cursor catalogue probe exited with Windows fail-fast status

Beehive reported `PROVIDER_INCOMPATIBLE`, `Cursor CLI --list-models probe failed:
exit 3221226505`, `execution_started: false`. No turn/artifact was returned and
the existing reviewer session remained IDLE. The integer corresponds to
`0xC0000409`, a Windows fail-fast status; it does not identify the root cause
([Microsoft](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail)). The
reported response supplied no stderr or additional diagnosis.

Two direct pinned catalogue probes subsequently passed, returning 246 models
including the selected `grok-4.7-high`. A paid one-response Cursor control through
frozen broker `700449a` also succeeded, with execution started and no source
changes. These observations establish current success, not the crash's cause.
Private control evidence: dogfood `2026-10-03T00-44-16-860Z-863ee7fc`.

The bounded repair retries that specific exit once for metadata only; repeated
failure remains a pre-inference refusal with safe context. No paid retry, model
substitution, raw stderr disclosure or stale catalogue fallback is added.

The preceding Beehive request sent both `review_binding` and
`workspace_precondition` and was correctly rejected as `INVALID_REQUEST` before
inference. MCP tool descriptions and the coordinator guide now state explicitly
that reviewer sends use `review_binding` only. The earlier successful review
still applies to its prior target, not the later active-member test snapshot.

## 2026-10-03: Beehive full review diff exceeded the delivery budget

The coordinator reported a complete 9,649,425-byte review diff rejected against
the former 8,388,608-byte budget before inference. It then deliberately used
the previous reviewed target as the follow-up baseline to check findings
closure. That is a different review scope, not a full checkpoint review.

The operations follow-up sets a configurable 32 MiB default (maximum 256 MiB),
passes it to actual complete-diff rendering, and tests delivery of the full
head/tail through read-only transport without replacing the original binding.
The coordinator guide now explains checkpoint IDs/keys, route-revision drift
and deliberate follow-up review scope. Review diffs now use compact hunks:
every changed line stays, unchanged context is three lines, and full source
remains in the baseline and target snapshots. That is a UTF-8 byte reduction,
not a token or cost measurement. See the
[checkpoint](native-smoke/2026-10-03-pilot-operations.md).

## 2026-10-03: Gemini timeout is not confirmed quota exhaustion

The supplied Gemini turn `turn-5dda87e9d5291ff38aaa0042` used a 900000 ms
deadline and ended `TIMED_OUT`, execution started, termination reason `deadline`.
Its retained terminal detail reported the root waiting for two background
tasks. No explicit quota error was present. The historical timeout stays a
deadline failure; the one-hour default applies to future turns.

Confirmed executed quota failures now create a persisted shared scope pause,
shown in operator status and clearable through the authenticated operator UI.
A validated vendor duration is used when supplied; otherwise a labeled
15-minute conservative policy applies. This does not retroactively block the
recovered Gemini account on the basis of that timeout. Verification is offline
and mock UI evidence; no deliberate live quota exhaustion was run.

## 2026-10-03: Related test outside native author's declared paths

The isolated GLM-5.3-Flash/max author completed but its final capture failed
`SCOPE_VIOLATION`: `tests/integration/operator-operations.test.ts` was omitted
from the initial write scope. Its only change updates the expected default
limits for the new review budget. The coordinator retained the failed turn,
inspected that related expectation and captured the integrated source with
mock for a separate Cursor review; no replacement paid author was launched.
This was a task-scope omission, not a broker enforcement defect.

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
## 2026-10-05: npm cache bookkeeping rejected after a completed ZCode author turn

ZCode completed the Cursor Git-review package, but the accepted shared broker
finalized turn `turn-3fd4aca8765751b30f2f65c0` as `FAILED / SCOPE_VIOLATION`:
`Writes into excluded/protected subtrees: node_modules/.package-lock.json`.
Execution started and native termination was normal; this is not a successful
broker turn. Source changes were retained in its isolated checkout. The
coordinator copied only the source/test diff and independently verified the
Cursor tests (119/119), without copying dependencies or accepting the native
summary as proof.

This is a generated dependency-cache write, not an inferred source-file
allowlist. Keep protected-path policy intact. Prepare dependencies before
worker admission; investigate benign package-manager bookkeeping separately
if it recurs. No shared daemon/configuration was changed for this incident.
