# ADR-0002: P3 provider set extended with Cursor and ZCode; selective reuse from Fusion

- **Status:** accepted (operator scope change)
- **Date:** 2026-09-29
- **Spec basis:** multi-vendor-agent-broker-mvp-v0.2.md §2.2 (Cursor/ZCode adapters
  were deferred), §13.4 (reuse rules), §17 P3.

## Context

The MVP spec defers Cursor/Antigravity/ZCode adapters out of scope. On
2026-09-29 the operator explicitly requested adding **Cursor** and **ZCode**
adapters to the P3 provider set (alongside Codex and Claude Code). The
operator also pointed at `C:\projects\fusion` (Runfusion/Fusion, MIT), where
CLI agent integrations already exist for Codex, Claude Code, Droid, Pi and
Cursor, plus a ZCode feasibility study.

## Decision

1. **Provider set for P3:** `codex`, `claude-code`, `cursor`, `zcode`
   (+ the existing deterministic `mock`). This is an operator-authorized
   widening of §2.2; every adapter still passes the same ProviderAdapter
   contract tests, and none is advertised `supported` until its native P0
   spike passes (§13.1/§18.1) — status stays `configured`/`unknown`.
2. **Reuse from Fusion (MIT, source of interface facts only):**
   - TAKE: exact CLI launch/resume command shapes, stream/JSONL event type
     names and field names, session-id capture points, readiness/cancellation
     mechanics, Windows shim handling (Cursor).
   - DO NOT PORT: Fusion's PTY-interactive session model, hook-over-HTTP
     telemetry hub, auto-retry / fresh-session fallback / model substitution /
     waiting-heuristics that mask provider semantics (§13.2, INV-05/06),
     generic-CLI heuristics, its own state machine (we have §6.5 tables).
   - No code is copied wholesale; facts are transcribed into our
     `ProviderAdapter` implementations with tests on the pure parsers.
3. **ZCode:** implement per the feasibility study's direction — print-first
     headless invocation of the desktop bundle (`resources/glm/zcode.cjs`),
     behind the same adapter contract; its `unknown` capability fields stay
     explicitly unknown until a native spike is authorized.
4. **Native spikes remain deferred:** adapters land with parser-level unit
   tests and a `native` integration layer that is NOT exercised in the
   default test suite (no provider CLI runs without operator authorization).

## Consequences

- Support matrix entries for cursor/zcode remain `unverified` until spikes.
- The MCP bridge (P3) exposes providers generically; adding adapters does
  not change the API surface (§10).
