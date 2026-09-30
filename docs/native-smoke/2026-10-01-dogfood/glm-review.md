# Native static review report

Requested route: zcode / account:zai-individual-coding-plan/GLM-5.3 / high.
Turn: turn-9daeb0ad61bb928913ff7618.
Native report delivered through MCP; claims and static findings only.

All five files read (manifest, diff input, and the three targets). Analysis complete — the fix and the monitor cap check out against the actual code; final report below.

**Review result: changes confirmed against target code; no blocker/major findings.**

**src/daemon/lifecycle.ts:359-367 (shutdown)** — `??=` caches the in-flight promise, so concurrent callers share it (asserted in tests/integration/daemon-deadlines.test.ts:394-396). The rejection handler (:363-364) clears the cache only after performShutdown has settled (rejection originates at the drain await :380), and monitor stop / ownership release (:381-386) never run on failure — ownership and supervision stay held, matching the comment. No overlapping attempts: the cache is non-null for attempt 1's entire life, including the microtask gap between the underlying rejection and the catch. Success stays idempotent (resolved promise cached; a re-run would no-op anyway since monitor/ownership are nulled). ownership.release() swallows close/unlink errors (:74-75), so rejection can only come from the drain. No early release, deadlock, or re-entrancy found (single-threaded JS; performShutdown's sync prefix rejects inside the chain, never throws synchronously). Retry-after-drain-failure is covered by the test at :484-501.

**src/daemon/deadlineMonitor.ts:94-115 (tick)** — alternating failure/recovery pairs stay silent while `Date.now() < nextDiagnosticAt` (:109), and a suppressed failure leaves recoveryDiagnosticPending=false (set only at :112), so its paired recovery is silent too: the one-pair-per-minute cap holds for alternating failures (test :474-478). stop() is idempotent (:78-86), tick() gated on stopped (:95), restart-after-stop blocked (:65).

Nits: (a) lifecycle.ts:371-377 — a failed-drain retry re-stamps started_at/ready_at in durable daemon_state, losing original boot time; (b) monitor uses Date.now() rather than the injected Clock. Note: daemon_state remains STOPPING after a failed drain, so admission stays closed (DAEMON_NOT_READY) until retry/restart — intended per comments/tests, but operator-visible.

Limits: static single-threaded reasoning only; tests not executed; bootstrap.ts `daemon.stop()` wiring out of scope (covered behaviorally by tests). Native permission enforcement remains unverified.
