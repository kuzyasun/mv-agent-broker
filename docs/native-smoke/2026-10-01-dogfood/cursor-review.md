# Native static review report

Requested route: cursor / auto / .
Turn: turn-1556db709a3137f6ca0576a5.
Native report delivered through MCP; claims and static findings only.

I'll do a read-only review of the required inputs and the focused deadline/shutdown changes—no edits, shell, or MCP.Reading the required diff and the focused source files next.Focusing on admission during STOPPING, shutdown drain, poll validation, and PATH allowlist changes.## Review findings

**1. Medium — `src/daemon/lifecycle.ts:359-375`**
`shutdown()` coalesces via `shutdownPromise ??= performShutdown()`. Concurrent stops during an in-flight drain are correct, but a **rejected** drain permanently caches that rejection. After `STOPPING` is written and drain throws, later `stop()`/`shutdown()` never re-enter `performShutdown()`, so ownership/monitor cannot be released by API even if drain would succeed on retry. Tests only assert retain-on-failure; they never retry after restoring drain. Entrypoint exits and leaves the lock (crash-like), but any host that catches `stop()` is wedged.

---

**Checked OK (no confirmed regression):**
- Supervision stays up through drain; monitor stopped only after drain (`lifecycle.ts:373-376`); integration covers hanging-turn drain + dual `stop`/`lifecycle` coalescing.
- New send/spawn rejected with `DAEMON_NOT_READY` while STOPPING; same-key replay still works (`broker.ts:216-220,658-660` + test ~399-409).
- Poll interval validated before ownership/state open (`bootstrap.ts:79-86`, `deadlineMonitor.ts:17-21`).
- Scan errors: one bounded diagnostic per streak, recovery log, no raw error leak (`deadlineMonitor.ts:92-107`).
- Windows PATH/`Path` case fold in allowlist env (`headless.ts:108-128`).
- `nativeConfig.ts`: no delta in required diff; reviewed in place, nothing deadline/shutdown-related.

**Verification limits:** Static read of required diff + focused sources only; no tests/runtime executed; native permission enforcement unverified per session rules.
