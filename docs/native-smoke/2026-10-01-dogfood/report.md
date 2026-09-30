# Broker self-development checkpoint (2026-10-01)

## Scope

The operator authorized native development/review on ZCode, Antigravity and
Cursor, excluding Claude. Each job uses an immutable copy of broker source,
a separate daemon and stdio MCP bridge, and a plain Node MCP client. Writers
work in the actual repository; reviewers receive a sealed snapshot review
slot with the baseline/target diff. This is development evidence, not full
provider/role/platform acceptance.

Initial cleanup removed 182 private temporary files (2,287,411 bytes) and
created commit `ddb7044` after 288 offline tests and typecheck passed.

## Deadline supervision package

Antigravity Gemini 3.8 Flash/high wrote the initial daemon deadline monitor and
integration tests through the real MCP route. Native conversation:
`d9304c84-f75d-413a-87c0-6d1b12e6eabb`; turn
`turn-3cfa1ce84aea99861c7b2804` completed successfully.

Cursor auto independently found four issues: high-level stop released
ownership before drain; direct lifecycle shutdown had the same issue;
poll configuration accepted invalid/partial values; scan failures were
silently swallowed. The coordinator verified and repaired the findings.
New admission is rejected during shutdown, while idempotent accepted requests
remain replayable. Supervision runs during drain and ownership remains held
on drain failure. Invalid polling configuration is rejected before state
creation. Error diagnostics omit arbitrary private error details.

The integrated Cursor ask-mode review then identified a permanently cached
drain rejection. The coordinator repaired it: ownership and supervision stay
held on failure, and an explicit later stop can retry after the cause is fixed.
Diagnostics are also capped across alternating failure/recovery streaks.
Independent GLM-5.3/high review of these exact corrections completed through
MCP without blocking findings. It was static review, not test execution.

The native ZCode correction attempt reached its deadline without edits. A
read-only inspection of only that owned native session showed Bash could not
resolve Node/npm because Windows `Path` had been lost after an environment
object spread. The shared runner now matches Windows environment names
case-insensitively while preserving the allowlist.

A subsequent short job exposed a separate false two-minute timeout: ZCode
`--json` can remain silent until completion. Its output timers now use the
remaining hard-deadline budget, with daemon cancellation still authoritative.
Neither failed job is reported as successful development or exhausted quota.

A final Flash/max job reached its 15-minute deadline after writing a regression
test, before producing a completed handoff. The coordinator reviewed its actual
partial diff, fixed fake-result truncation introduced by the extra PATH fields,
and independently ran the checks. The native turn remains TIMED_OUT; source
appearance is not relabeled as a successful native outcome.

Cursor plan mode stored its final review in a native CreatePlan tool payload;
ordinary broker result text contained only interim narration. The coordinator
recovered only the intended report from that exact owned native conversation,
without reading reasoning or copying credentials. Reviewer launch now uses
ask mode. Production adapter does not depend on native chat-cache reads.

## Validation

- `npm run typecheck`: passed.
- `npm test`: 316/316 tests across 28 files passed. Native Claude was not
  launched; its adapter tests use a fake process.
- All six retained native evidence validators passed offline. Optional removed
  private workspaces were skipped explicitly; this is not a fresh native run.
- Cursor auto reviewed the integrated package; its confirmed rejected-drain
  finding was fixed. GLM-5.3/high then independently reviewed the exact retry
  and diagnostic corrections. The coordinator inspected the actual diff,
  corrected the partial ZCode test and preserved SESSION_BLOCKED precedence
  found by the full suite before the successful acceptance run.
- [Selected run evidence](dogfood.evidence.json) preserves native successes and
  failures separately. Reports are agent claims from static review, not runtime
  permission or billing proof.
- Retained final static reports: [Cursor auto](cursor-review.md),
  [GLM-5.3/high](glm-review.md). Minor observations about pre-existing boot-time
  stamping and the real-time diagnostic rate limiter do not change the tested
  shutdown ownership or turn-deadline behavior.

## Remaining boundary

Native writer/reviewer permissions and ambient MCP/plugin isolation are not
fully enforced/verified. The weak operator-approved writer setup and reviewer
instructions are not a sandbox guarantee. Quota/billing remains unknown.
Managed descendant cancellation, crash recovery, required-input enforcement,
CLI/model bindings and total storage admission remain separate open work.
No provider is promoted to fully supported by this checkpoint.
