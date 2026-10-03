# Pilot operations: regional time, review budget and quota pauses

## Scope and observed incidents

The operator requested host-local regional UI timestamps, relief for Beehive's
complete review diff rejection, and temporary quota-aware routing after Gemini
exhaustion. The reported review diff was 9,649,425 bytes against the old
8,388,608-byte budget. Its inference never started. The supplied Gemini timeout
used an old 900000 ms deadline and retained a root waiting for two background
tasks; no explicit quota diagnostic was present. It remains a deadline failure.

## Resulting behavior

- The server supplies read-only host `locale`, `timeZone` and `hourCycle`;
  one formatter covers live rows, error detail timestamps and catalogue dates.
  Unknown/invalid timestamps remain unknown. Display metadata is not saved.
- `limits.maxReviewDiffBytes` defaults to 32 MiB and is configurable up to
  256 MiB, including a UI field in MiB. Actual complete-diff preparation uses
  this cap. It delivers all bytes or refuses before inference, preserving
  the original baseline/target. Provider input-envelope limits remain separate.
- An executed, definitive `QUOTA_EXHAUSTED` persists a shared quota-scope pause
  in the terminal transaction. Admission and dispatch both enforce it across
  projects; unrelated scopes remain available. Successfully recorded calls
  still replay. Expiry admits explicit work, without automatic retries.
- A strict positive reset suffix of at most 24 hours supplies the duration;
  absence uses a labeled 15-minute conservative policy. Timeouts, silence,
  cancellations, pre-dispatch refusals and unknown outcomes do not learn or
  backfill a pause. Existing paid jobs are not cancelled.
- Account discovery exposes active pause scope/end/source; operator status and
  UI show active pauses. Authenticated operator-only clear is transactional and
  audited, with no inference or configuration writes.
- Coordinator guidance now records checkpoint IDs/keys and exact review
  bindings, distinguishes revision drift from changed routes, and requires
  deliberate follow-up review scope rather than silently replacing a baseline.

## Native authorship and integration

ZCode Individual `GLM-5.3-Flash` / `max` authored the implementation through a
frozen copy of accepted broker `943e966`, in an exclusive isolated checkout
with an explicit one-hour deadline. Its native process completed, but the
broker final capture retained `FAILED / SCOPE_VIOLATION`: the one-line limits
expectation in `tests/integration/operator-operations.test.ts` was outside the
initial path allowlist. It is not a successful author turn. Source was retained,
the related expectation was inspected and no replacement paid author ran.

The coordinator corrected invalid/missing timestamp handling, requested an
hour field when observing the host hour cycle, made reset suffix parsing strict
and kept operator clear plus audit in one transaction. A mock public-MCP turn
captured the integrated source for independent Cursor `grok-4.7-high` / `high`
review against the original author baseline, again through stable `943e966`
with a one-hour deadline. Claude was not used.

Private author evidence: dogfood `2026-10-02T23-12-13-689Z-03793c9a`.
Private integrated review evidence: dogfood `2026-10-03T00-08-51-638Z-be486eba`.
Raw provider reports, private state and credentials stay outside Git.

## Coordinator verification

- Typecheck and both mock/Windows example validators passed.
- Final coordinator `npm test -- --maxWorkers=2`: 61 files passed,
  861 tests passed and one platform skip, in 300.26 seconds.
- Eight targeted files: 69 passed. The atomic clear/reset follow-up checks:
  12 passed in two files.
- Isolated mock UI on port 4319 showed `02.10.2026, 18:40:18` in the error list
  and expanded details with the observed Ukrainian regional settings.
- Clearing the preview pause left turn count and config bytes unchanged.
  Saving a 48 MiB review budget stored 50,331,648 bytes, omitted display
  metadata, and correctly showed saved settings needing restart.
- The preview server/RPC/tab were closed. The shared port 4318 was preserved.

Independent Cursor review finished `SUCCEEDED` with no findings. Its exact
binding used the original author baseline and the fresh mock integrated target.
The coordinator inspected the actual diff and checks, including the additional
foreign-coordinator clear refusal regression. `git diff --check` passed.
The native harness closed its sessions and stopped its private daemon.

## Deployment and verification boundary

The shared Beehive/DMP daemon remains on `09b92a6`. Applying this portion needs
an explicit accepted-runtime update while idle; the UI restart button alone
reuses the existing runtime and does not upgrade code. Active jobs and saved
project settings were not changed during development.

Quota classification and pause enforcement use fake native and offline tests,
not deliberate live quota exhaustion or a subscription telemetry query.
Native child quota error channels remain unverified. Large-diff byte delivery
does not prove that a native reviewer read or accepted every byte. Compact
unchanged context is a separate practical token-economy follow-up.
