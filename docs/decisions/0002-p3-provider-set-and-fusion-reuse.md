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

## Amendment 2026-09-30: Antigravity provider addition

- **Status:** accepted (operator scope extension)
- **Date:** 2026-09-30
- **Context:** The operator explicitly extended the P3 provider set to include
  the **Antigravity** agent CLI (`agy`, `antigravity`), alongside Cursor, ZCode,
  Codex, and Claude Code.
- **Interface facts:** Sourced from local CLI research and Fusion's
  `docs/antigravity-cli-contract.md` (MIT):
  - Binary: `agy.exe` (default `agy`).
  - Headless turn: `agy --dangerously-skip-permissions --output-format stream-json --print-timeout 900s -p "<prompt>" [--model <id>] [--conversation <id>]`.
  - Large prompt handling: when prompt exceeds ~2000 characters, write to a temp file and invoke `-p "Open and follow the instructions in <file>"`.
  - NDJSON streaming: `event: "step_update"` with `step_update.text_delta`, `event: "result"` with `result.status` ("SUCCESS" | "FAILED"), opportunistic `conversation_id` capture (first wins, never fabricated).
  - Cancellation via process tree kill (common headless infra).
- **Rule alignment:** Same as the initial ADR — capabilities stay `documented` /
  `unknown` until an operator-authorized native spike (§13.1/§18.1); no
  unsupported-before-spike claims.

