# Cursor integrated policy review

Provider: Cursor auto. Turn: turn-35b53ba842ad8cb6a4cc148a.
Native conversation: 9788f5f8-58eb-40a4-9ee7-3ddf990a630d.
Broker runtime: e8a2f70d5716c2d70997b539eba3ab32cb523813.

The sealed target predates the final caller-contract error-priority refactor.
The coordinator verified that refactor against the existing contract tests
and the full suite. The original worker FAILED state remains preserved.

I'll read the sealed review inputs and the changed policy/dogfood sources next, then report findings only.The diff input is large; I'll pull the policy-related hunks and the sealed source next.Shell was blocked in Ask mode; switching to direct reads of the diff and sealed sources.Next I'll inspect how broker/execution wire the binding and how dogfood handles failed-worker audits.None found.

Checked: `src/core/policy.ts` narrowing/integrity (`parseRequestedPolicyRestrictions`, `computeEffectiveWritePolicy`, `loadSessionWritePolicy`/`sessionWriteScope` legacy→invalid, corrupt JSON→malformed, no live-profile fallback); `src/core/broker.ts` spawn bind + send `checkWriteScopeCoverage`; `src/core/execution.ts` pre-input + dispatch-gate revalidate (all roles) and post-run scope from binding; `tests/unit/policy-restrictions.test.ts` reviewer mid-flight strip and adapter-handoff null binding; `scripts/dogfood.mjs` failed-worker path keeps `reviewSource.state`, requires `review_current`, demands sealed target. Native sandbox still out of scope.
