# Configurable deadline and activity UI acceptance

The default turn deadline is one hour. The operator UI edits minutes and saves
`limits.hardTurnDeadlineMs`; an explicit per-turn `deadline_ms` still overrides
the default. Active jobs expose deadline, elapsed time, execution status, and
the latest retained provider activity timestamp. Ten minutes of quiet output
produces an advisory message, never an automatic hang decision.

## Native independent review

An isolated reviewer ran through the last accepted broker runtime
`573a457eb3f2cb54aea6f0ef625d61b95ee3e10e`, using the authorized Cursor
`grok-4.7-high` / `high` route and an explicit `deadline_ms: 3600000`.
Live readiness and all discovery pages were checked before paid work. The
review completed as `SUCCEEDED` after approximately twenty minutes; the
configured one-hour duration was not shortened to the previous fifteen-minute
default. This is execution evidence, not automatic quality acceptance.

The coordinator checked and resolved both findings:

- Adapter output timers could race the daemon's deadline scan and report a
  protocol failure. Cursor, Antigravity and ZCode now reserve 65 seconds beyond
  the deadline, letting the daemon's maximum 60-second scan interval cancel first.
- A failed background status read destroyed open error details. The panel now
  retains them, labels them as last observed data, and preserves form drafts.

The coordinator also preserved unknown execution status as unknown and added
timed-out/failed/unknown turns to diagnostics even without an adapter error code.
No further paid review was required for these focused verified corrections.

## Local validation

Typecheck, JavaScript syntax and diff checks passed. Targeted existing gates
cover configuration validation and fingerprints, default/configured/per-turn
deadlines, daemon cancellation and cleanup, immutable session bindings, frozen
runtime restart, authenticated details, and Cursor/Antigravity/ZCode adapters.
The Cursor timer regression checks a wait strictly beyond the maximum scan
interval without waiting an hour.

Browser validation used an isolated mock UI: a thirty-minute elapsed turn,
deadline remaining time, twelve-minute quiet warning, saving ninety minutes,
and preserving drafts/open error details across polling, RPC loss and recovery.
The live shared daemon was updated only while idle and reported `READY` with
`hardTurnDeadlineMs: 3600000`. All saved provider routes and concurrency settings
were retained. Real sixty-minute execution and automatic hang detection are not
claimed. Private transcripts, credentials and runtime evidence remain outside Git.
