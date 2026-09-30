# Agent Broker

Local deterministic execution/session layer with an MCP interface for
multi-vendor coding agents. Implements the **MVP v0.2 specification**
([docs/multi-vendor-agent-broker-mvp-v0.2.md](docs/multi-vendor-agent-broker-mvp-v0.2.md)).

## Status

| Phase | Scope | Status |
|---|---|---|
| P0 non-native | Stack pins, repo layout, ADR, capability skeleton | done (see `docs/decisions/0001-codebase-choice.md`) |
| P0 native spike | Per-provider native verification | partial: all five providers passed short model/resume smoke; Codex also passed external MCP client/bridge/daemon; full role/profile acceptance remains open ([matrix](docs/provider-capabilities.md)) |
| P1/P2-1..P2-4 | Deterministic core, coverage contracts, snapshots, input delivery, review slots, diff artifacts, operator cleanup | done+reviewed (2 rounds); 154/154 green |
| P3-1 providers | Five native adapters + mock behind shared headless infra | implemented; ZCode/Cursor/Claude/Codex 0.2.0 include verified native model/identity/resume; per-capability verification in the matrix |
| P3-2 bridge | 13 MCP tools over BrokerCore, JSON-RPC stdio transport, daemon bootstrap with ownership-first startup | implemented; native MCP spike fixed durable task/instructions delivery and agent_reported summary retrieval |
| P4 | Fault injection + platform verification + full acceptance matrix | fault injection and private-socket daemon/bridge split implemented; full native platform/role/profile acceptance remains open |

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
and the 13 MCP tools exposed through the stdio bridge and private daemon RPC.

Known limitations (intentional, fail-closed):
- The legacy in-process bridge remains available; normal multi-client operation
  uses the separate bridge attached to one daemon (ADR-0003 amendment).
- Native verification is partial; full provider/role/platform profiles remain unverified (spec §13.1/§18.1).
- `wait_ms` long-poll on `agent_turn_events` is accepted and resolves immediately.
- Worktree mode does not yet create git worktrees (registered path only).
- Artifact storage budget beyond the per-capture 256 MiB source cap unenforced.
- Daemon-owned deadline supervision runs during execution and graceful drain.
  Polling defaults to 50ms; `AB_DEADLINE_POLL_MS` accepts integers 5..60000.
  Native descendant quiescence remains a separate acceptance gate.
- Operator recovery and triage runbook: see docs/recovery-runbook.md.

No capability is `supported` until the native P0 spike passes
(spec §13.1/§18.1). The mock provider exists for deterministic testing only.

## Development

Provider setup, authentication, models, resume, Windows caveats and test
procedures: [provider operations guide](docs/providers.md). Exact verification
status: [capability matrix](docs/provider-capabilities.md).
Native self-development, frozen broker runtimes and current remaining work:
[self-development checkpoint](docs/self-development.md).

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
