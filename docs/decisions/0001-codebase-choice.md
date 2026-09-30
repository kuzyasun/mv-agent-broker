# ADR-0001: Codebase choice, runtime stack and P0 scope split

- **Status:** accepted (development-phase)
- **Date:** 2026-09-29
- **Spec basis:** multi-vendor-agent-broker-mvp-v0.2.md §2.3, §13.4, §17 (P0/P1)

## Context

Spec §17 requires a P0 technical spike (native CLI verification for Codex and
Claude Code) before finalizing the implementation contract. Per operator
instruction (2026-09-29): **native Codex smoke tests must NOT be launched yet**.
Native provider verification is therefore deferred; it stays a mandatory gate
before any `supported` capability status is claimed (§13.1, §18.1).

## Decision

1. **Thin own core, selective reuse (D01).** We build a new small codebase per
   the §17.1 repository layout. No fork of `agent-pool-mcp` or similar: donor
   automation (auto-retry, fresh-session fallback, routing) directly conflicts
   with INV-05/INV-06/§7.4 and would have to be removed.
2. **Stack:** TypeScript (strict), Node.js LTS (pinned dev runtime: Node 24.x),
   `node:sqlite` (`DatabaseSync`) for the metadata registry — synchronous API
   naturally serializes the authoritative admission boundary inside one
   process (§7.2), zero native addons. If `node:sqlite` proves insufficient
   later, the DAL is isolated behind `src/storage/` for a swap to
   `better-sqlite3`.
3. **Test framework:** vitest.
4. **P0 split:** non-native P0 deliverables are fixed now (this ADR, repo
   layout, stack pins, capability-matrix skeleton with `unknown` statuses);
   native spike (provider-capabilities verification for Codex + Claude Code)
   is deferred until the operator explicitly authorizes provider usage.
5. **Development order:** P1 (deterministic core + mock adapter, §17 P1) first.
   All P1 acceptance evidence is mock-level — no inference, no provider CLI.
6. **Platform note:** dev machine is Windows (native). Spec §2.3 targets
   macOS/Linux runtime with Windows via WSL2. Core P1 code is
   platform-neutral (pure TS + SQLite). The platform-backed singleton lock
   (§4.1.1) gets a Windows-capable implementation now (`LockFileWithHandle`)
   with a Unix advisory-lock variant for the tested-platform phase; verified
   platform/OS pairs will be recorded in the capability matrix, and untested
   combinations stay `unverified` per §18.1.

## Consequences

- No capability may be advertised `supported` on the basis of code existing;
  spec §13.1/§18.1 evidence rules apply only after the deferred native spike.
- Mock adapter (§17 P1) must cover: delayed completion, concurrent same-key
  requests, startup/cancel races, crash windows, malformed output, missing
  native context, failed close, cleanup/admission races.
- The API surface implemented now targets spec API `0.2` shapes
  (§10) with mocks; bridge/MCP transport arrives in P3.
