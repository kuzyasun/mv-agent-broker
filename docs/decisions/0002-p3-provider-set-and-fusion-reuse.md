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

## Amendment 2026-09-30: verified ZCode standalone JSON route

Operator authorized fixing the adapter after the bundled CLI 0.16.9 smoke.
The installed Desktop bundle works via Node with explicit built-in provider
paths and native CLI-owned login. Adapter `0.2.0` uses a private per-turn
model config, `--json` session identity and exact `--resume`; no broker auth
bridge, distribution installation or app-server integration is required.
The initial route is Z.AI Individual Coding Plan with GLM-5.3/GLM-5.3-Flash,
validated low/high/max effort (null selects low). Other accounts/model families
fail before dispatch. Default permission mode stays yolo; full role/profile
verification is still open. See the [operations guide](../providers.md) and
[native evidence](../native-smoke/2026-09-30-zcode-bootstrap/report.md).

## Amendment 2026-09-30: verified Cursor Windows CLI route

The operator authorized quota-consuming Cursor tests. Native CLI
`2026.09.28-64d2043` recognized the existing login and executed two short
marker/resume pairs, including the final adapter `0.2.0`. Windows shim
execution requires `PATHEXT` in the shared runner plus Cursor profile paths.
The adapter requires an explicit model, captures observed identity without
fabrication, checks resume identity and waits for a successful process exit.
No extra login, SDK/app-server route or installation was needed. Full role,
tool cancellation and quota-exhaustion behavior remain unverified; see the
[Cursor report](../native-smoke/2026-09-30-cursor/report.md).

## Amendment 2026-09-30: verified Claude Code native route

The operator authorized Claude testing and completed native CLI login.
CLI 2.1.285 requires `--verbose` with print/stream-json; adapter 0.2.0 adds
that flag, preserves native profile paths and validates identity/process
completion. Two Haiku 4.5 requests passed model/marker/exact resume using
the operator's claude.ai/Team profile, with no broker credential extraction.
Startup hooks expose identity before init, so the parser captures it early;
retained native streams cover this in offline replay. Full roles and tool
cancellation remain unverified. See the
[Claude report](../native-smoke/2026-09-30-claude/report.md).

## Amendment 2026-09-30: verified caller-independent Codex CLI route

The operator authorized Codex testing through the broker. Adapter 0.2.0 uses
`exec --json`, explicit model/effort and exact `exec resume`, replacing the
notify-file bridge. CLI 0.157.0 reused existing ChatGPT login. A plain Node MCP
client drove separate bridge/daemon processes and completed two Luna/low
marker turns, received reported summaries and snapshots, and closed the session.

The first native MCP request exposed missing caller text in the envelope and
discarded agent summaries. The existing provisioning/admission journals now
retain instructions/tasks, and a bounded report event populates the existing
MCP result field. No registry migration or new MCP fields were introduced.
Old sessions without persisted instruction text fail before dispatch. Both
successful native contexts recorded read-only despite the worker sandbox flag;
worker writes and full role enforcement remain open. See the
[Codex report](../native-smoke/2026-09-30-codex/report.md).
