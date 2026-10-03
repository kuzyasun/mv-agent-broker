# Project agent pools checkpoint

## Scope

Workers, Reviewers and Researchers group existing project routes by role.
Profiles expose readable names, enablement and effective tags in UI/discovery.
Several profiles can be tagged `default`; several sessions can share a profile,
subject to the existing quota, project session cap and physical checkout leases.
No scheduler, automatic fallback, compatibility layer or storage-schema change
was added. `multi-agent` is derived from native-subagent mode prefer/auto;
it does not certify native child count, models or confinement.

Disabled named profiles refuse NEW spawns after committed idempotent replay,
before provider preflight/provisioning, and again in the admission transaction.
Metadata never changes resolved spawn hashes or worker prompts. Existing bound
sessions continue; raw explicit bindings retain their existing authorization.
Named reviewer/researcher profiles require an explicit read-only policy.

See the [reviewed plan](../plans/project-agent-pools.md) and
[operator guide](../operator-guide.md).

## Native author and independent reviews

The coordinator used isolated copies of accepted runtimes, preserving the
shared Beehive/DMP daemon and its saved configuration. No Claude, native Codex,
comparative benchmark, automatic retry or provider substitution was invoked.

The plan was independently reviewed by Cursor `grok-4.7-high/high` through
frozen `7ea314c`. Its sealed findings artifact was fully read and verified:
`art-37307354883c3b5e4d636b4f`, 3721 bytes, SHA-256
`4127e6b80d1d98d1689e418ef70ecd44f062bd38dcc270e783ab9a5629ecf9d6`.
Accepted corrections are recorded in the plan; reviewed plan commit `7ebd691`
became the author baseline and the next frozen runtime.

ZCode Individual `GLM-5.3-Flash/max` authored the package in an isolated clone
through frozen `7ebd691`. Turn `turn-c83b7b318730c9901b6b0fa7` reached its
one-hour deadline and ended **TIMED_OUT** with execution started. Its changes
were retained; no successful author report, check claims or native identity
was returned. Events recorded deadline, owned process quiescence, terminal
state and session closure. The coordinator copied the stopped clone's intended
source/docs/tests changes into its own clean worktree, inspected them and ran
acceptance independently. Silence was not classified as a quota failure.
This author attempt remains failed in retained private evidence.

An explicit review-only operation then captured the clone's current changes
with a mock turn and submitted the sealed baseline/target to Cursor
`grok-4.7-high/high`. The mock capture is not a successful native author run.
Reviewer turn `turn-5b971c6509f77815d6725b48` **SUCCEEDED** through frozen
`7ebd691`; baseline `snap-8b6ad4cd9a9173dc75f3eeb3`, target
`snap-4dd4c1f81f4b1544fa9f8da5`. Complete sealed findings were read and verified:
`art-8806aff5d8555297b2096560`, 2667 bytes, SHA-256
`5444e5e2e287a2363470cbaf643dcff66b82497a993ad969938f9b93820dac13`.
All owned author/capture/reviewer sessions ended CLOSED with no active turn;
both private harness runs exited. Raw output, account details and local
runtime evidence remain outside Git.

## Findings and coordinator fixes

| Finding | Accepted fix and verification |
|---|---|
| High: profile-name input rebuilt its DOM and lost focus after one character | Update the existing heading without replacing the input; DOM-identity regression and sequential browser typing |
| Medium: tags/filter/chip state stayed stale during editing | Refresh the tag selector after route changes and update chip/summary state in place while typing; browser and DOM regressions |
| Medium: Add worker picked the first policy, possibly read-only | Prefer the selected project's existing write policy; otherwise the sole write policy or an unresolved explicit choice; test read-only-first ordering and browser project-specific default |
| Low: chip addition could exceed 12 stored tags | Validate before applying the chip addition; 12-tag regression |
| Coordinator browser finding: invalid custom tags appeared saved while previous tags persisted | Retain the actual invalid draft, show field validation and refuse Save; regression asserts no PUT and browser confirms Unsaved changes |
| Coordinator usability finding: Add under a tag filter hid the new untagged profile | Clear the tag filter when adding and explain it; DOM/browser verification |

The independent reviewer inspected the pre-fix sealed implementation. These
coordinator repairs were accepted through actual diff inspection and targeted
regressions/browser checks; no second paid review was claimed.

## Acceptance

- `npm run typecheck`: PASS after review fixes.
- `node --check src/operator/ui/app.js`: PASS.
- Initial focused six-file config/routes/UI/settings acceptance: 54/54 PASS.
- Full `npm test -- --maxWorkers=2`: **63 files, 919 PASS, 1 SKIPPED**,
  414.33 seconds. This is the offline/mock suite, not a live benchmark.
- Final UI behavior check after the last Add/filter refinement:
  `npx vitest run tests/unit/operator-ui-app.test.ts --maxWorkers=2`:
  **11/11 PASS**. The full run also included the other review fixes.
- `git diff --check`: PASS.

Actual in-app browser tests used a separate owned ephemeral UI/config, no
shared-daemon operations or provider launches. Verified three role pools,
project/tag filtering (including derived multi-agent), uninterrupted name
entry, invalid-save refusal, chips, disabled editing and save/reload,
duplicate IDs, model/effort preservation, Agent decides, worker defaults,
explicit ambiguous read-only policy choice and researcher role moves.
Project-wizard copies preserved names/tags/enablement/native settings, assigned
new IDs and read-only reviewer/researcher policies. The resulting private JSON
was also checked directly (three fixture projects, 27 profiles).
A screenshot is retained with the private fixture; the temporary UI is stopped.

The private candidate for the real operator configuration validates all 24
existing profiles and changes only display_name/enabled/tags. Exact route IDs,
provider/model/effort/account/policy/subagent bindings, concurrency and grants
match the saved source. No candidate was applied. The source SHA-256 remained
`a2817cb911f00e85380ac37090869288afeb09bf8658bd00877ec0048369e99c`.
The shared daemon remained READY on accepted `0409fb1`; this portion neither
upgrades it nor restarts it. Recheck the current saved revision and idle state
before a later guarded deployment; do not overwrite subsequent operator edits.

Disk accumulation preview/cleanup is the next separate portion. Benchmarks
remain deferred. No native researcher/confinement certification is claimed.
