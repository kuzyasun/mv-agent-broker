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

The opt-in [dogfood client](../scripts/dogfood.mjs) copies `src/` and
`package.json` into a private frozen runtime under `.state/dogfood/`. It starts
a separate daemon and stdio MCP bridge and drives the public API from Node.
Native workers edit the actual repository. Reviewers receive an isolated
target snapshot with required baseline/target diff inputs. Changing source
does not replace the active broker executable midway through a turn.

```powershell
node --experimental-transform-types scripts/dogfood.mjs .state/tasks/package.json
```

Task JSON contains `name`, `provider`, `model`, optional `effort`,
`write_scope`, `goal`, optional `checks`, and `deadline_ms` (default 900000).
An optional `review` route starts an independent review of the completed
worker snapshots. `review_from` points to a private successful worker evidence
file for a standalone review. `review_current: true` captures current integrated
source via a mock turn, then reviews it against that worker's original baseline.
The latter does not run another paid implementation task.

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

This development harness is not an operator configuration product or a native
sandbox guarantee. Ambient vendor MCP/plugins, reviewer read/search-only
restrictions and materialized-input enforcement remain unverified. The
operator-approved weaker writer profile must not be advertised as enforced.
Production adapters do not rely on reading Desktop chat caches for reports.

## Remaining packages

| Package | Remaining acceptance |
|---|---|
| Effective policy and inputs | Apply narrowing restrictions; fail before inference for mandatory unsupported enforcement; verify native read/search-only reviewer and required-input delivery |
| Runtime supervision | Durable launch/process ownership, managed descendant quiescence, crash/disconnect/restart cases and explicit UNKNOWN reconciliation |
| Preflight and binding | Native CLI/auth/catalog readiness without inference; honest CLI/model/effort/account bindings and error classification |
| Workspaces/resources | Broker-created Git worktrees, total storage admission including staging, bounded output and event wait behavior |
| Complete native feedback loop | Worker → review findings artifact → fix → review, R1/S1/R2/S2 continuity, cancellation during native tools |
| Operator setup | Validated registry configuration, runnable startup packaging, practical recovery/triage workflow |
| Acceptance closure | A01–A53 evidence by actual platform/provider/role/profile; retain unknown/failed statuses where no native proof exists |

The daemon deadline timer and graceful-drain package is the first completed
implementation portion of this workflow. Evidence and validation are in the
[checkpoint report](native-smoke/2026-10-01-dogfood/report.md). The complete
MVP acceptance gate remains open.
