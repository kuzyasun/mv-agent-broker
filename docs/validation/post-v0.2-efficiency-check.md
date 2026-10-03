# Post-v0.2 coordinator-efficiency check (AD-01)

Status of the documentation package from
`docs/multi-vendor-agent-broker-mvp-v0.2-addendum-01.md` (operator input,
Ukrainian, left unmodified). Companion to the CE-01–CE-06 rules in
[coordinator instructions](../coordinator-instructions.md). This report adds
no runtime behavior; the full v0.2/native acceptance matrix remains open.

## Baseline and dirty state

- Accepted baseline: commit `e1ef4e6` ("Document active project-wide workspace
  selection"), branch `codex/coordinator-efficiency`. Full v0.2/native
  certification remains incomplete (see
  [self-development](../self-development.md) "Remaining packages").
- Package start: the operator addendum
  `docs/multi-vendor-agent-broker-mvp-v0.2-addendum-01.md` was **untracked**
  (`git status`: `??`). It was treated as read-only operator input.
- Package diff: documentation and examples only — no `src/`, schema,
  dependency, migration or runtime changes. One authorized ZCode Individual
  `GLM-5.3-Flash` / `max` author ran through frozen broker `e1ef4e6` in an
  isolated checkout and finished `SUCCEEDED`; private session/daemon cleanup
  passed. This author call is not a benchmark. No additional native efficiency
  trials or subagent delegation were performed.

## CE-01–CE-06 gap mapping

| Rule | Existing base (file/test/evidence) | Added here | Remaining gap |
|---|---|---|---|
| CE-01 bounded tasks | Task contract delivery and required-input admission: `src/core/broker.ts` (`sendSnapshotPreflight`, `resolveTaskArtifacts`); input planning `src/inputs/manifest.ts` (no silent truncation, `INPUT_LIMIT`/`ARTIFACT_NOT_READY`); whole-project default grant `src/core/policy.ts`; `tests/unit/task-contract.test.ts`, `tests/unit/p2-input-delivery.test.ts`, `tests/unit/required-input-integrity.test.ts` | Bounded-task template + CE-01 rule in coordinator-instructions; example 02 | Worker-side reading/coverage behavior on native models: unknown (mock evidence only) |
| CE-02 result-first, cursors | `src/bridge/tools.ts` (`agent_turn_result` bounded DTO, `agent_turn_events` cursor/wait); README cursor snippet; `tests/integration/turn-events-wait.test.ts` | CE-02 rule (already implied by instructions rule 4, now explicit) | None documented; host polling costs are outside broker measurement |
| CE-03 exact route, immutable session | Route discovery and pagination: instructions rules 1, 6; spawn oneOf (route_id XOR explicit bindings) `src/bridge/tools.ts`; `tests/unit/operator-routes.test.ts` | CE-03 rule (new session for any immutable change) | None beyond existing open native readiness/binding gates |
| CE-04 continuation vs fresh | Persistent sessions, review re-binding: `agent_session_send` review_binding; `tests/integration/native-feedback-harness.test.ts`, [native feedback record](../native-feedback.md); UNKNOWN/quarantine guards `tests/unit/quota-cooldown.test.ts`, `tests/unit/zcode-quota.test.ts`, [recovery runbook](../recovery-runbook.md) | CE-04 rule + fresh-session recipe + handoff template; example 04 | [Combined persistent native chain accepted](../native-smoke/2026-10-03-native-feedback.md) for Windows ZCode Flash/max + Cursor grok/high; fresh handoff and worktree-vs-checkout discipline remain separate |
| CE-05 claims vs observed | `turnResultDto` separates `agent_reported` from `broker_observed`; report bounding `tests/unit/task-contract.test.ts` | CE-05 rule | No automatic claim verification exists or is proposed |
| CE-06 context/storage/native memory | Artifact/snapshot storage and cleanup `tests/unit/cleanup.test.ts`; input manifests are per-turn (`src/inputs/manifest.ts` lifetime `turn_until_quiescence`) | CE-06 rule (no reuse of materialized paths; retention unchanged) | Native context-size telemetry: unknown |

## AD-C01–AD-C08 status

Checks from addendum §8; they do not replace A01–A53. "Offline" = mock-level
verification in this repository; native behavior is reported separately.

| ID | Status | Evidence |
|---|---|---|
| AD-C01 examples use only v0.2 tools/fields | **pass (offline)** | Validator run against the real `bridgeToolDefs()` schemas (recursion over properties/required/`additionalProperties:false`/enum plus the spawn oneOf): 4/4 files PASS (see "Checks run"). Handoff labels live only inside `task.context` strings, not as API properties |
| AD-C02 bounded task keeps coverage and required artifacts | **pass (offline, unchanged code)** | No src changes; coverage/required-input behavior still enforced by existing tests above (39 passed) |
| AD-C03 fresh input bindings per turn; old paths/expired IDs stay invalid | **pass (offline)**; native | `src/inputs/manifest.ts` per-turn manifest; `required-input-integrity.test.ts` (12 passed); native input-access enforcement remains a separate open gate |
| AD-C04 handoff = new conversation, immutable config untouched, worktree caveat | **documented; native not_run** | Recipe in coordinator-instructions; spec §5.2/§8.3 semantics unchanged; no new continuity evidence was collected |
| AD-C05 no hidden fallback/retry on quota error, UNKNOWN, missing history | **pass (offline, unchanged guards)** | `tests/unit/zcode-quota.test.ts`, `tests/unit/quota-cooldown.test.ts` untouched and green in the last full runs; no src diff in this package |
| AD-C06 researcher has no broker tools; summary stays a claim | **deferred (documented)** | `role: "researcher"` exists in the spawn schema; this does not certify a native profile or establish a registered pilot route; no profile added |
| AD-C07 usage honest; unknown ≠ zero; no invented costs | **pass (docs review)** | This report claims no savings or costs; `agent_turn_result.usage.availability` remains `unknown` in `src/bridge/tools.ts` |
| AD-C08 no runtime router/memory DB/auto reset/new upload API | **pass (diff review)** | Package diff contains docs/examples only |

## Benchmark protocol — `not_run`

Subsequent continuity acceptance completed one persistent four-turn native
chain on the exact Windows/model pair in the
[native feedback checkpoint](../native-smoke/2026-10-03-native-feedback.md).
It retained setup failures and verified the actual final fixture independently.
No F/P/H comparison was performed; broker-reported usage remained unknown for
every turn. The following comparison protocol and its `not_run` status stand.

No measurements exist; **no savings or cost claim is made**. Protocol for a
future small comparison, run only within explicitly authorized provider/profile
and usage bounds. The standing authorization covers native development calls;
this package deliberately leaves the comparative series `not_run`:

- **Modes.** (F) fresh native session per task; (P) persistent worker +
  persistent reviewer across the chain; (H) fresh session with explicit
  compact handoff (recipe above). Exactly these three; no fourth engine.
- **Fixtures.** Identical small bug-fix fixtures, independently reset from
  the same base commit for each mode; modes never share workspaces or
  ready-made fixes; run order rotated between series.
- **Fixed variables.** Same worker/reviewer routes, model/effort, task goals,
  acceptance criteria and deadline default, coordinator fixed. Use the same
  `implement → review → fix → review` chain, baseline/target semantics and
  review scope; only history reuse and the explicitly defined handoff/context
  delivery vary. Specify fresh reviewer sessions for F/H and one persistent
  reviewer for P before running. Count every additional fix/review attempt.
- **Counted.** Accepted chains (coordinator acceptance, not bare
  `SUCCEEDED`), failed attempts and fix cycles, turn counts, elapsed
  wall-clock per chain, broker-reported usage fields where available
  (missing values recorded as unknown/null, never zero), MCP output sizes in
  bytes (never equated to tokens or money). Failed attempts are included in
  per-chain totals; a series with zero accepted chains reports zero successes
  and total known costs, with no average.
- **Claimed.** Nothing until measured; if data is insufficient, the
  conclusion is "insufficient data to choose a more efficient mode". Model or
  researcher comparisons are separate later experiments.

## Checks run for this package (offline only)

- Example schema validation (validator in a private temp directory, loading
  `src/bridge/tools.ts`): `01-spawn-route-worker.json`,
  `02-send-worker-fix.json`, `03-send-reviewer-binding.json`,
  `04-send-fresh-handoff.json` — all PASS against advertised API 0.2 schemas.
- The coordinator independently checked all four schemas and passed their
  arguments through actual `callBridgeTool` parsing with a stub core: no I/O,
  registered-ID admission or inference is claimed by this check.
- Targeted vitest (docs package; full suite not rerun): `bridge-protocol` (19),
  `task-contract` (5), `p2-input-delivery` (3), `required-input-integrity`
  (12) — **39/39 passed**.
- Authored documentation/examples pass `git diff --check`. The preserved source
  addendum has five intentional Markdown hard-break lines flagged as trailing
  whitespace when checking the entire baseline-to-final diff; its bytes were
  not rewritten to remove those operator-authored line breaks.
- The coordinator independently reran the four-file gate: 39/39 passed. Final
  review corrected the example README link, required terminal result AND managed
  quiescence for handoff, and distinguished the paid author call from benchmarks.

## Limitations

- Native reading depth, real context sizes and quota costs remain unverified.
  The separately accepted persistent chain demonstrates continuity for its
  exact Windows/model pair; mock/offline checks do not promote native profiles.
- The benchmark protocol has no runs behind it; its variables and counting
  rules are commitments for a future authorized series, not results.
- The operator addendum was preserved byte-for-byte (SHA-256
  `6a2993a6a5ea8fe1cf9d5f3dc984c3e4d5cd922b0eb89786271f2090e12cbad7`)
  and is included as the source document in this authorized completed portion.
