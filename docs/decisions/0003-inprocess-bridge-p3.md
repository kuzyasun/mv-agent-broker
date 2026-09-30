# ADR-0003: In-process bridge for the P3 vertical slice

- **Status:** accepted (temporary simplification, revisited in P4)
- **Date:** 2026-09-30
- **Spec basis:** §4.1 (bridge and daemon as separate processes over private
  local RPC), §17 P3.

## Context

Spec §4.1 requires a thin stdio bridge process talking to ONE user-scoped
daemon over a private local RPC. The P3 vertical slice needs the full MCP
surface working end-to-end first; a socket RPC layer adds surface before the
API shapes are proven.

## Decision

For P3 the bridge runs **in-process** with the daemon assembly
(`src/daemon/main.ts` → `startDaemon` → `runStdioBridge` over the shared
BrokerCore). Consequences and mitigations:

- Multiple MCP hosts each start their own daemon; the second one on the same
  state directory fails fast with `DAEMON_ALREADY_RUNNING` (§4.1.1) — safe,
  but not yet "several bridges attach to one daemon".
- To keep the §4.1 split clean, the bridge layer holds NO business logic:
  discovery/status queries live behind `BrokerCore.statusOverview` /
`BrokerCore.discovery`; every tool maps to one core call.
- The daemon boundary is already isolated (BrokerCore + TurnExecutor +
  DaemonLifecycle); moving `runStdioBridge` behind a private socket in P4
  requires only a transport swap in `main.ts`.

## Consequences

- The §16.2 slice and §16.4 coordinator-independence checks run unchanged.
- The full separation (private socket RPC, version handshake, message size
  limits per §4.1) lands in P4 before the platform verification gate.
