# Native self-development workflow

The operator authorized ZCode, Antigravity and Cursor for broker development
and review, with a coordinator review and commit after each completed package.
Claude is excluded from this workflow. Offline fixtures do not launch vendors.

## Operator pilot priorities — 2026-10-01

The operator redirected development toward a usable MCP for everyday work and
lower coordination cost. The v0.2 specification remains the reference; its
complete acceptance matrix is deferred rather than represented as complete.
Existing ownership, idempotency, preservation and explicit failure behavior stay
in place. No new edge-case gate is required merely to start the local pilot.

Success means a coordinator can connect the broker to another repository,
discover configured routes, delegate a bounded implementation, obtain its
result, request an independent review when useful, and continue the task.
Setup must not require private coordinator scripts or manual SQLite edits.

| Next delivery | User value | Minimum acceptance |
|---|---|---|
| P1: Operator setup and connection | One documented setup/start path for any chosen repository; generate a client MCP configuration snippet | Fresh state initializes owned bases; validate config without inference; connect a client and run an offline mock task |
| P2: Named worker/reviewer routes | Choose allowed providers, model/effort and defaults once; reuse them in tasks | Validate configured routes and expose them to the coordinator; one routing smoke; no guessed IDs or hidden substitution |
| P3: Pilot and issue capture | Use the broker for actual work outside its own repository and record encountered problems | One bounded implementation, review and follow-up through the ordinary MCP path; inspect the actual diff and result; preserve failed evidence |

P1 and P2 are implemented by the [operator guide](operator-guide.md) and its
mock/Windows examples. One JSON config contains CLI pins, project registration,
named worker/reviewer routes, model/effort and advisory subagent preferences.
The examples use six global unfinished broker turns and two per configured
account quota scope for practical parallel self-development. These limits count
unfinished broker turns across projects, not vendor token quotas or native
child count; one unfinished turn per logical session remains and native child
preference is independent. Stable daemon copies can use the validated
`AB_GLOBAL_UNFINISHED_TURNS` and `AB_QUOTA_SCOPE_UNFINISHED_TURNS` environment
overrides for the same 6/2 setting.
In shared-daemon mode, save edits, stop only while idle, and start the daemon
again before new sessions use them; reconnecting a bridge does not reload
settings. Existing bindings are preserved. Native CLI login remains
provider-owned; account profile
metadata does not switch a subscription plan or create a new vendor login.

The accepted runtime and quarantine-operation checkpoints are complete. The
live operator UI includes saved-versus-applied settings, project registration,
editable routes, idle restart, expandable retained errors and observed activity
with a configurable one-hour turn deadline. Beehive and DMP are registered
pilot projects. The next practical priority is resolving observed pilot
failures and making their causes clear to the coordinator; the Antigravity
quota classification checkpoint is recorded below.
Total storage budgeting, full native certification, and rare recovery cases
remain deferred.

The coordinator owns task decomposition and final acceptance. Role preferences
belong to the broker configuration/coordinator instructions; the MCP connection
in Codex only exposes the broker's tools. A small instruction file or skill
should explain how to select a named route and return concise results.
Configured defaults are distinct from the allowed route list. An alternative
provider may be selected explicitly or under an operator-approved, visible
policy; UNKNOWN execution never authorizes a replacement launch.

Retain the operator's existing route choices: ZCode Individual Flash/max workers,
selected GLM/high reviews, Antigravity Gemini 3.8 medium/high, and explicit
operator-selected Cursor model/effort. Read current choices from the applied
routes rather than historical example defaults. Large-task preferences remain
editable by the operator. Antigravity long author runs returned server 500;
one separate bounded Gemini medium review completed successfully.
ZCode's five-hour quota was reported exhausted; the allowed list does not imply
current availability. Claude stays excluded from this workflow. Do not silently
raise effort or change the main coordinator model.

### Delivery and token discipline

- Give each worker one coherent outcome and only the necessary source/context.
  Return changed paths, meaningful checks, result and remaining problems.
- Use independent review for substantive code/risk; do not commission repeated
  vendor reviews for mechanical documentation or already verified minor repairs.
  The coordinator verifies findings and owns the final diff.
- Run targeted existing checks for the changed behavior. Run the full suite at
  integration checkpoints or when a failure/cross-module change justifies it.
  Add regression tests for observed failures and material expected behavior.
- Retrieve final results and bounded event deltas. Use `agent_turn_events` with
  the last numeric cursor and `wait_ms` 10000 or 20000; after terminal status,
  retrieve the final result once. Avoid repeated full transcripts.
- Record broker issues with provider/version, session/turn reference, observable
  error, short reproduction, impact and workaround. Keep credentials/raw native
  thinking out of the log. Missing quota telemetry remains unknown.
- Fix immediately when a problem risks losing changes, permits uncontrolled paid
  execution, misreports completion, or blocks the ordinary workflow. Defer rare
  recoverable cases with a recorded limitation and workaround.

Coordinator-side context-efficiency rules (CE-01–CE-06), task/handoff
templates and the fresh-session recipe are in the
[coordinator instructions](coordinator-instructions.md); their gap mapping,
AD-C01–08 verification status and the context-mode pilot protocol/results are in the
[post-v0.2 efficiency check](validation/post-v0.2-efficiency-check.md).

The separate accepted runtime portion keeps every actual review change while
compacting unchanged context; see the
[compact review-diff checkpoint](native-smoke/2026-10-03-compact-review-diff.md).
The [independent Windows UI checkpoint](native-smoke/2026-10-03-independent-ui.md)
records the tracked launcher, independent GLM review and owned-process/HTTP
verification. These portions were integrated and deployed as accepted
`0409fb1` during the operator-authorized idle update; Beehive/DMP registrations
and applied route settings were preserved. Further development remains isolated.
The [integration checkpoint](native-smoke/2026-10-03-coordinator-efficiency.md)
records the final full offline gate and the accepted/deferred boundary.

### Deferred work and native subagents

Complete A01–A53 closure, exhaustive provider/role/platform certification, total
storage admission and rare recovery cases are later hardening work unless an
actual pilot problem makes one necessary. Existing incomplete package clones
remain unaccepted; do not integrate them wholesale to close the old plan.
Fresh inputs/slots initialization is part of P1 because it blocks ordinary setup.

Cursor and Antigravity officially document native CLI subagents, and bounded
smoke evidence exists for both; see [native subagent evidence](native-subagents.md).
This does not certify full provider/role/platform profiles or enforce child
models, permissions, counts, cancellation, or quota attribution. Do not build a
nested orchestration platform first. Broker-visible workers and vendor-internal
subagents are separate. Parallel execution can improve elapsed time without
reducing total usage.

References: [Codex MCP connection](https://learn.chatgpt.com/docs/extend/mcp?surface=cli),
[Cursor subagents](https://cursor.com/docs/subagents),
[Antigravity CLI subagents](https://antigravity.google/docs/subagents?tab=cli).

## Routes

| Role | Route |
|---|---|
| ZCode worker | `account:zai-individual-coding-plan/GLM-5.3-Flash`, effort `max` |
| Selected ZCode reviews | `account:zai-individual-coding-plan/GLM-5.3`, effort `high` |
| Antigravity worker/reviewer | Gemini 3.8 Flash medium/high by task complexity |
| Cursor worker/reviewer | Explicit operator-selected model/effort from live routes (current pilot: `grok-4.7-high/high`) |
| Final acceptance | Coordinator inspects actual diff, validates findings and runs appropriate offline gates |

Start Plan is currently unavailable through the verified standalone account
runtime. See [bounded research and alternatives](zcode-start-plan.md).
Plan changes are explicit; failures do not trigger automatic account/model
fallback. Usage and subscription quota accounting remain unknown.

## Frozen broker execution

The opt-in [dogfood client](../scripts/dogfood.mjs) extracts Git-tracked `src/`
and `package.json` from the last accepted commit into a private frozen runtime
under a fresh system-temp `ab-df-*` root (printed as `EVIDENCE` at completion).
This short path avoids Cursor's Windows SQLite budget failure independently
of checkout depth. `runtime_ref` defaults to `HEAD`; pass an explicit last
verified commit when HEAD is not an accepted checkpoint. The resolved immutable
commit and copied file count are recorded as `runtimeCommit`/`runtimeFiles` in
private evidence. Dirty/untracked source is never copied into the broker runtime.
It starts a separate daemon and stdio MCP bridge and drives the public API from Node.
Native workers edit the actual repository. Reviewers receive an isolated
target snapshot with required baseline/target diff inputs. Changing source
does not replace the active broker executable midway through a turn.

```powershell
node --experimental-transform-types scripts/dogfood.mjs .state/tasks/package.json
```

Task JSON contains `name`, `provider`, `model`, optional `effort`,
optional `write_scope` (an explicit opt-in restriction; without it the worker
grant covers the whole project, per the operator rule in AGENTS.md), `goal`,
optional `checks`, and `deadline_ms` (default 3600000).
Optional `runtime_ref` pins the accepted broker commit independently of the
working tree being implemented and reviewed.
The isolation rehearsal on 2026-10-01 used commit `d7d01b3`: a mock MCP turn
completed successfully using 47 committed runtime files. A temporary dirty
source marker and an untracked source file were both excluded; the frozen file
matched its Git blob byte for byte. The rehearsal consumed no native quota.
An optional `review` route starts an independent review of the completed
worker snapshots. `review_from` points to a private successful worker evidence
file for a standalone review. `review_current: true` captures current integrated
source via a mock turn, then reviews it against that worker's original baseline.
This explicit capture also permits auditing retained changes from a failed
worker; it preserves the original failed status and records `reviewSource`.
It does not run another paid implementation task. Final worker/reviewer reports
must fit 3000 characters, with findings first and relative paths, to stay inside
the broker's 4000-character summary boundary. A capped report is partial evidence.

Private evidence includes MCP results/events and bounded native reports; no
credentials are copied into broker storage. Native authentication stays with
the installed CLI. A task failure stops the workflow without automatic retry.
If the client/daemon is interrupted, preserve unresolved state and follow the
[recovery runbook](recovery-runbook.md). Do not classify an interrupted turn
as completed merely because files appeared on disk.

Use a hidden detached job when execution must survive a client turn ending.
Do not change covered source while a writer holds its turn lease: even a
coordinator edit can produce a scope violation or unstable final capture.
Inspect the final actual diff independently of the worker's reported checks.
Keep coordinator diagnostics in existing nested private directories such as
`.state/coordinator/`; creating top-level `.state` files during a writer turn
is observable protected metadata and can fail that turn's final capture.

This development harness is not an operator configuration product or a native
sandbox guarantee. Ambient vendor MCP/plugins, reviewer read/search-only
restrictions and materialized-input enforcement remain unverified. The
operator-approved weaker writer profile must not be advertised as enforced.
Production adapters do not rely on reading Desktop chat caches for reports.

## Remaining packages

| Package | Remaining acceptance |
|---|---|
| Effective policy and inputs | Core narrowing and immutable binding completed; native mandatory enforcement, read/search-only reviewer and required-input enforcement remain open |
| Runtime supervision | Local Windows ownership, descendant quiescence and guarded operator recovery are implemented; hosted execution domains and wider crash/platform certification remain open |
| Preflight and binding | Observed native readiness and lifetime account/config binding completed; actual vendor account identity and mandatory native confinement remain unverified |
| Workspaces/resources | Bounded output/report artifacts and broker-created Git worktrees implemented; total storage admission including staging remains |
| Complete native feedback loop | [Persistent chain](native-smoke/2026-10-03-native-feedback.md) and [fresh/handoff/persistent pilot](native-smoke/2026-10-03-context-modes.md) accepted for Windows ZCode Flash/max + Cursor grok/high; usage is unknown, and other native profiles and cancellation during native tools remain open |
| Pilot operations | Setup, applied-settings visibility, project registration, idle restart and error details are implemented; fix newly observed multi-project/provider failures as they arise |
| Acceptance closure | A01–A53 evidence by actual platform/provider/role/profile; retain unknown/failed statuses where no native proof exists |

The daemon deadline timer and graceful-drain package is the first completed
implementation portion of this workflow. Evidence and validation are in the
[checkpoint report](native-smoke/2026-10-01-dogfood/report.md). The complete
MVP acceptance gate remains open.
The [effective write-policy checkpoint](native-smoke/2026-10-01-effective-policy/report.md)
records the next portion, including the preserved failed native worker turn,
separate integrated capture, Cursor review and coordinator acceptance.
The [adapter permission/effort checkpoint](native-smoke/2026-10-01-adapter-controls/report.md)
records Antigravity implementation, independent Cursor review, coordinator
repairs and 371 passing offline tests. Full native isolation remains open.
The [provider preflight checkpoint](native-smoke/2026-10-01-provider-preflight/report.md)
records ZCode implementation and coordinator integration with 387 passing
offline tests. Native readiness and mandatory enforcement remain open.
The [Cursor reviewer configuration checkpoint](native-smoke/2026-10-01-cursor-profile/report.md)
records Antigravity implementation, managed session history, scoped read config
and 426 passing offline tests. Configuration is not native enforcement proof.
The subsequent [scoped-read falsification](native-smoke/2026-10-01-cursor-read-boundary/report.md)
failed on Cursor 0.2.3: an outside marker absent from the prompt was read.
Workflow success and agent-reported Write/Shell denials did not promote that
restricted reviewer profile. A fail-closed hook candidate needs fresh proof.
The [physical checkout lease checkpoint](native-smoke/2026-10-01-workspace-aliases/report.md)
records ZCode authoring, independent Cursor review, confirmed bypass repairs
and 448 passing offline tests. Legacy unbound leases/quarantines remain
conservative until authoritative reconciliation.
The [0.2.4 hook checkpoint](native-smoke/2026-10-01-cursor-hooks/report.md)
records partial Antigravity authoring, ZCode completion, independent GLM/high
review and coordinator repairs. The prior native outside-read failure remains
recorded; configured hooks require a fresh accepted-runtime falsification.

The [0.2.4 native hook probe](native-smoke/2026-10-01-cursor-hooks-native/report.md)
observed exact outside-path Read denial. Full restricted profile acceptance
remains open. The separate
[clean continuity probe](native-smoke/2026-10-01-cursor-clean-continuity/report.md)
failed memory recall; per-turn config cleanup removes native Cursor history.

The [physical session cwd checkpoint](native-smoke/2026-10-01-workspace-binding/report.md)
records ZCode implementation, independent Cursor review and coordinator repairs
with 489 passing offline tests. New physical sessions bind a resolved cwd;
historically unbound physical sessions need explicit replacement while retaining
their recorded native context. Hosted execution-domain proof remains open.

The [Windows owned-process checkpoint](native-smoke/2026-10-01-windows-job/report.md)
records retained failed/partial authors, independent reviews and main repairs.
Local Job ownership, pre-resume journaling and conservative helper-loss handling
are tested with owned Node processes. Hosted tool-domain quiescence and complete
native profiles remain open. The observed ZCode Individual provider-1310 limit
led to an explicit Cursor/Gemini development route; Start Plan remains unverified
and unavailable through the verified standalone account runtime.

The [Cursor native history checkpoint](native-smoke/2026-10-01-cursor-history/report.md)
records failed native author final capture, explicit integrated Gemini review,
coordinator repairs, and offline continuity tests for adapter 0.2.6. The private
config/chat root survives turns; immutable policies remain separate. Real clean
memory recall and workspace cleanliness are validated separately from these
offline gates.

The [clean Cursor 0.2.6 pair](native-smoke/2026-10-01-cursor-clean-continuity-repaired/report.md)
confirmed same-conversation memory and changed S1/S2 source projection with a
short state path; the failed long-path SQLite attempt remains retained.
The [bounded output/report checkpoint](native-smoke/2026-10-01-bounded-reports/report.md)
records Cursor authorship, renewed GLM Flash/max repair, independent reviews
and coordinator crash/retention/Unicode repairs. Native and offline evidence
remain distinct. The operator renewed GLM quota on 2026-10-01 and authorized
Individual Flash/max development and selected GLM/high reviews again; the
earlier provider-1310 failure is historical evidence, not a current quota check.

The [complete input transport checkpoint](native-smoke/2026-10-01-transport-inputs/report.md)
records Antigravity authorship, retained Cursor SQLite failure, explicit renewed
GLM review and coordinator repairs. It separates preview diffs from required
complete diffs and measures the full transport envelope before input publication.
Native input enforcement and readiness/binding are still separate gates.

The [readiness and provider-binding checkpoint](native-smoke/2026-10-01-native-readiness/report.md)
records the retained GLM five-hour quota failure, Gemini repair, independent Cursor reviews,
and primary complete-program/launch/account-binding repairs. Observed metadata remains
separate from requests and actual native account identity; mandatory profiles stay unverified.

The [caller-independent feedback harness](native-feedback.md) records sealed R1
findings delivery to FIX, same worker/reviewer continuation, an active bridge
disconnect, restart before FIX, actual foreign-coordinator ACL denial, and exact
S2 review-slot files. Typecheck and the integrated full suite passed 649 tests
with one platform skip. These offline results do not promote a mandatory native profile.

The [native policy controls document](native-policy-controls.md) records bounded
installed PROGRAM evidence and an independent Cursor sealed-tree review. ZCode
hook failure is a static fail-open observation, not native denial validation;
complete worker/reviewer policy profiles remain open. An incomplete Gemini
background-search report and a failed GLM/high review are preserved separately.

The [required-input integrity checkpoint](native-smoke/2026-10-01-input-integrity/report.md)
records Cursor implementation/repair, independent Gemini review, coordinator
ancestor-link corrections and actual zero-dispatch corruption tests. Verified
byte delivery is separate from native input access/write enforcement.

The [ZCode quota checkpoint](native-smoke/2026-10-01-zcode-quota/report.md)
records explicit error attribution, owned fail-fast termination, successful
Cursor review with coordinator fixes, and 723 passing offline tests/one skip.
Standalone plain-message/silent-retry attribution remains unknown. The operator
requested stopping after that package, then authorized completion of the retained
worktree portion. Event/storage/operator packages remain preserved and unaccepted. Fresh owned inputs/slots initialization
is a separate confirmed remaining issue.

The [detached worktree provisioning checkpoint](native-smoke/2026-10-01-worktree-provisioning/report.md)
records managed launch/completion receipts, in-lock durable repository fencing,
malformed-journal retention, exact ownership checks, source-alias drift refusal,
and preserved dirty worktrees. Antigravity implementation and Cursor independent
review ran through accepted stable broker a176221; the coordinator fixed confirmed
findings and verified the final source. Integrated typecheck and full suite passed
766 tests with one skip across 45 files; 39 worktree tests passed.
Storage admission and complete native profiles remain open; the event-wait and
quarantine-operation checkpoints are accepted. The subsequent operator portions
implemented live UI status/errors, saved-versus-applied new-session settings
and project registration.

The operator UI now supports an idle-only restart of the existing accepted
runtime and lazy retained turn-error details. The restart must work from an
exported runtime without a Git checkout. Its HTTP control shares the save queue
and requires the saved revision. Verification uses frozen mock runtimes, not
paid jobs for refusal cases. Error details show observed execution/quarantine
separately from recovery suggestions. Record incomplete native reviews honestly;
an error panel never replaces coordinator acceptance.

The [hour-deadline checkpoint](native-smoke/2026-10-02-hour-deadline.md)
records configurable deadlines, observed activity and preserved error details
during background refresh failures. The
[Antigravity quota checkpoint](native-smoke/2026-10-03-antigravity-quota.md)
records the narrow explicit-error classification and its offline regressions;
other vendor failure formats and live quota telemetry remain unverified.

The [pilot operations checkpoint](native-smoke/2026-10-03-pilot-operations.md)
tracks regional UI dates, configurable complete review delivery and persisted
quota pauses. The original native author remains a retained scope failure;
acceptance uses an explicit current-source capture and separate review.
Keep the shared daemon on its accepted runtime until an idle update is agreed.
Review diffs keep every changed line and three lines of unchanged context.
Full unchanged source remains in the sealed baseline and target snapshots.
The reduction is measured in UTF-8 bytes, not tokens or native cost. Do not
infer a need for broad edge-case certification from this pilot.
