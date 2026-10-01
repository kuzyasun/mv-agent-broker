# Native self-development workflow

The operator authorized ZCode, Antigravity and Cursor for broker development
and review, with a coordinator review and commit after each completed package.
Claude is excluded from this workflow. Offline fixtures do not launch vendors.

## Routes

| Role | Route |
|---|---|
| ZCode worker | `account:zai-individual-coding-plan/GLM-5.3-Flash`, effort `max` |
| Selected ZCode reviews | `account:zai-individual-coding-plan/GLM-5.3`, effort `high` |
| Antigravity worker/reviewer | Gemini 3.8 Flash medium/high by task complexity |
| Cursor worker/reviewer | `auto` |
| Final acceptance | Coordinator inspects actual diff, validates findings and runs appropriate offline gates |

Start Plan is currently unavailable through the verified standalone account
runtime. See [bounded research and alternatives](zcode-start-plan.md).
Plan changes are explicit; failures do not trigger automatic account/model
fallback. Usage and subscription quota accounting remain unknown.

## Frozen broker execution

The opt-in [dogfood client](../scripts/dogfood.mjs) extracts Git-tracked `src/`
and `package.json` from the last accepted commit into a private frozen runtime
under `.state/dogfood/`. `runtime_ref` defaults to `HEAD`; pass an explicit last
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
`write_scope`, `goal`, optional `checks`, and `deadline_ms` (default 900000).
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
| Runtime supervision | Durable launch/process ownership, managed descendant quiescence, crash/disconnect/restart cases and explicit UNKNOWN reconciliation |
| Preflight and binding | Core admission preflight and immutable handoff completed; native CLI/auth/catalog readiness and lifetime account/config binding remain open |
| Workspaces/resources | Broker-created Git worktrees, total storage admission including staging, bounded output and event wait behavior |
| Complete native feedback loop | Worker → review findings artifact → fix → review, R1/S1/R2/S2 continuity, cancellation during native tools |
| Operator setup | Validated registry configuration, runnable startup packaging, practical recovery/triage workflow |
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
their recorded native context. Runtime process-tree ownership remains open.
