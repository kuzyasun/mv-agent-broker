# Agent Broker

Local deterministic execution/session layer with an MCP interface for
multi-vendor coding agents. Implements the **MVP v0.2 specification**
(`../multi-vendor-agent-broker-mvp-v0.2.md`).

## Status

| Phase | Scope | Status |
|---|---|---|
| P0 non-native | Stack pins, repo layout, ADR, capability skeleton | done (see `docs/decisions/0001-codebase-choice.md`) |
| P0 native spike | Codex + Claude Code CLI verification | **deferred** — requires operator authorization for provider usage |
| P1/P2-1..P2-4 | Deterministic core, coverage contracts, snapshots, input delivery, review slots, diff artifacts, operator cleanup | done+reviewed (2 rounds); 154/154 green |
| P3-1 providers | Adapters codex/claude-code/cursor/zcode + mock behind shared headless infra | done — adapters codex/claude-code/cursor/zcode + mock behind shared headless infra (ADR-0002; interface facts from the Fusion repo) |
| P3-2 bridge | 13 MCP tools over BrokerCore, JSON-RPC stdio transport, daemon bootstrap with ownership-first startup | done — 13 MCP tools over BrokerCore, JSON-RPC stdio transport, daemon bootstrap with ownership-first startup, in-process simplification per ADR-0003 |
| P4 | Fault injection + platform verification + full acceptance matrix | not started; private-socket daemon/bridge split deferred to P4 per ADR-0003 |

Implements (spec §6–§11, §14–§16): versioned coverage profiles with a stable
contract hash; component-prefix classification with overlap rejection;
independent FS inventory (untracked/`.gitignore`-invisible files are
first-class, byte-capped, symlinks rejected); journal-first capture with a
stability re-inventory (SNAPSHOT_UNSTABLE), content-addressed blobs shared
per project; `source_digest` workspace preconditions (WORKSPACE_CHANGED);
post-turn scope enforcement incl. protected/`.git` metadata writes
(SCOPE_VIOLATION, no rollback); accepted-turn snapshot pins with
latest-anchor transfer; explicit `agent_workspace_snapshot` refresh; a real
recovery barrier (crashed provisioning → BLOCKED, orphan CAPTURING → FAILED,
running turns → UNKNOWN); delivery of required inputs and review-slot diffs;
and the 13 MCP tools exposed via the in-process stdio bridge.

Known limitations (intentional, fail-closed):
- In-process bridge (ADR-0003); private-socket daemon/bridge split deferred to P4.
- Adapters documented-not-verified until the native spike passes (`capability_status: "documented"`, spec §13.1/§18.1).
- `wait_ms` long-poll on `agent_turn_events` is accepted and resolves immediately.
- Worktree mode does not yet create git worktrees (registered path only).
- Artifact storage budget beyond the per-capture 256 MiB source cap unenforced.
- Deadline scanning (`TurnExecutor.scanDeadlines`) is still an explicit API,
  not a daemon timer.
- Operator recovery and triage runbook: see docs/recovery-runbook.md.

No capability is `supported` until the native P0 spike passes
(spec §13.1/§18.1). The mock provider exists for deterministic testing only.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run (mock-level, no inference)
```

Stack (ADR-0001): TypeScript strict, Node 24 LTS, `node:sqlite` (`DatabaseSync`),
vitest. Zero runtime dependencies.

## Layout

See spec §17.1. `src/storage` (SQLite registry), `src/core` (sessions/turns/
admission), `src/runtime` (adapter contract + supervisor), `src/providers/mock`
(deterministic mock), `src/daemon` (singleton ownership + recovery barrier),
`tests/` (unit / integration / adapter-contract / fault-injection).
