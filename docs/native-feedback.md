# Opt-in Native Feedback Harness (MVP v0.2)

## Overview

The native feedback harness (`scripts/native-feedback.mjs`) provides an opt-in, caller-independent Node Model Context Protocol (MCP) client driving a four-turn feedback workflow. In its default `persistent` mode:

$$\text{Worker (Turn 1)} \longrightarrow \text{Reviewer (Turn 1: R1)} \longrightarrow \text{Worker Fix (Turn 2: Same Worker)} \longrightarrow \text{Reviewer (Turn 2: R2: Same Reviewer)}$$

The harness operates over existing public MCP tools and accepted Git runtime patterns from `scripts/dogfood.mjs`. It establishes designated operational boundaries between the supervisor daemon, the worker workspace, and the review slot workspace, structuring cross-turn transfers through sealed artifact IDs and keeping worker edits within a separate fixture repository.

---

## Key Invariants & Security Architecture

### 1. Operator Authorization & Provider Constraints
- **Production Providers**: Only `zcode`, `antigravity`, and `cursor` are permitted.
- **Forbidden Routes**: `claude` and `codex` are strictly disallowed. `AB_CLAUDE_BIN` and `AB_CODEX_BIN` environment variables are actively purged from the daemon environment before execution.
- **Explicit Configurations**: In production mode, an explicit model string and verified runtime commit SHA are required. No implicit native execution.
- **No Automatic Fallback**: Failures halt immediately with durable `failed` or `unknown` evidence. The harness never attempts fallback to another provider, model, or session. The opt-in `feedback_mode` replacements (`fresh`/`handoff`, below) are explicit configuration choices, never automatic recovery.

### 2. Immutable Broker Runtime & Temporary Fixture Repository
- **Broker Runtime**: Copied from regular Git-tracked source (`src/`) and `package.json` at an accepted, immutable commit SHA (`30d2a4ecd5052af9ae177550b26e8331af616319`). Uncommitted or untracked changes cannot enter the supervising daemon.
- **Temporary Fixture Repo**: The worker operates within an owned, temporary Git repository with a generated package and source baseline (`src/math.js`, `src/obsolete.js`, `tests/math.test.js`). The worker workspace is registered with its canonical path bound to this fixture repository. The worker edits do not touch the main coordinator repository checkout.
- **Short Owned Root**: Each run creates a fresh `<system temp>/ab-feedback/<random-id>` directory, independent of checkout depth. This keeps Cursor's private SQLite path within the Windows budget. Evidence records the exact root; cleanup still requires its ownership marker and confirmed shutdown. Production cannot adopt a caller-supplied root.
- **Review Slot Workspace**: The reviewer operates in a `review_slot` workspace (`mode: "review_slot"`), where the broker populates exact snapshot trees separate from the worker's mutable working tree.

### 3. Normative 4-Turn Lifecycle

This table describes `persistent` mode. In `fresh` and `handoff`, FIX and R2
instead use replacement sessions with verified distinct native references;
see the explicit mode table below. Snapshot and artifact bindings stay the same.

| Phase | Session | Workspace Mode | Invariant / Precondition | Output / Artifact |
|---|---|---|---|---|
| **Turn 1: Worker** | `sess-worker` | `current` (`ws-fixture`) | Expected snapshot: $S_0$ (baseline) | Adds `src/calc.js`, removes `src/obsolete.js`, introduces benign defect in `src/math.js`. Final snapshot: $S_1$. Acquires native worker conversation ID. |
| **Turn 2: Reviewer (R1)** | `sess-reviewer` | `review_slot` (`ws-review`) | `review_binding: { baseline: S0, target: S1 }` | Review slot materialized with $S_1$ tree. Inspects diff, produces findings. Broker seals findings as an artifact (`kind: "findings"`). Acquires reviewer native conversation ID. |
| **Turn 3: Fix Turn** | **SAME** `sess-worker` | `current` (`ws-fixture`) | Expected snapshot: $S_1$. `artifact_refs: [findingsArtifactId]` | Consumes findings artifact by ID only (**never copied reviewer prose**). Asserts identical native conversation ref. Fixes defect in `src/math.js`. Final snapshot: $S_2$. |
| **Turn 4: Reviewer (R2)** | **SAME** `sess-reviewer` | `review_slot` (`ws-review`) | `review_binding: { baseline: S1, target: S2 }` | Review slot cwd rebound to $S_2$ current files: deleted files absent, new files readable, fixed code present. Asserts identical native conversation ref. Confirms resolution. |

### 4. Artifact Transport & Large Findings (>16 KiB)
- Small text artifacts ($\le 16\text{ KiB}$) are delivered inline within the shared task envelope.
- When findings exceed the inline cap (`INLINE_TOTAL_BYTE_CAP = 16 * 1024`), the broker's input delivery planner selects `delivery: "read_only_path"`, materializing the artifact under a broker-managed read-only input view directory with `lifetime: "turn_until_quiescence"`.
- Manifest ACLs ensure that only authorized project coordinators can read sealed artifacts; foreign coordinators are rejected with `UNAUTHORIZED`.

### 5. Quiescence, Cleanup, and UNKNOWN Retention
- Side-effect cleanup is restricted to the harness's own validated root directories.
- Teardown requires confirmed quiescence: the bridge and daemon processes close gracefully via standard signals (`SIGTERM` / `stdin.end()`). No bare PIDs or shared applications are force-killed. Unresolved close acknowledgments or child shutdown retain the fixture and prevent a passed assessment.
- **UNKNOWN State Preservation**: If any turn or execution terminates in an `UNKNOWN` or unresolved state, the fixture directory is explicitly **retained on disk** for forensic inspection rather than deleted.

### 6. Graceful Disconnect / Reconnect & Cancellation
- The MCP client stdio bridge can disconnect and reconnect while turns or sessions remain active in the daemon. Reconnection restores access to session state, turn status, and monotonic event history.
- The harness provides an optional turn cancellation scenario (`agent_turn_cancel`). Native cancellation requires an owned zero-active-process and drained-pipes receipt. Offline mock cancellation proves terminal protocol handling only. Restart runs between R1 and FIX, followed by continuation turns on both original sessions.

### 7. Continuity experiment modes (opt-in `feedback_mode`)

The minimal F/P/H experiment from the [benchmark protocol](validation/post-v0.2-efficiency-check.md) is implemented inside the existing harness — no separate benchmark engine. The mode is opt-in configuration; an invalid value is rejected **before any I/O** (no root, no state, no child process):

| `feedback_mode` | FIX turn (worker) | R2 turn (reviewer) |
|---|---|---|
| `persistent` (default) | SAME worker session, same native conversation (existing same-ref assertions) | SAME reviewer session rebound to S2 |
| `fresh` | Old IDLE worker session is closed to a confirmed completed `CLOSED` receipt, then a replacement worker session is spawned for FIX on the same fixture pinned to S1 | Old IDLE reviewer session closed the same way, then a replacement reviewer session for R2 on the same review slot with binding S1→S2 |
| `handoff` | `fresh` plus a bounded English coordinator `task.context` summary | `fresh` (review binding is self-describing) |

Invariants across all three modes:

- **Identical inputs**: the same role session instructions, initial task goal (with acceptance criteria and checks), checks, and initial fixture are used in every mode. The initial-only fixture steps (delete `src/obsolete.js`, add `src/calc.js`, introduce the deliberate divide defect) live in the **initial task**, never in session instructions, so a fresh FIX session receives exactly the persistent FIX instruction semantics.
- **Honest identity proof**: evidence records the actual session IDs and observed native conversation refs for every turn. `fresh`/`handoff` runs fail unless the replacement session IDs **and** observed native refs differ from the closed ones; `persistent` keeps the existing same-ref assertions.
- Missing native identities fail acceptance; a null reference is not proof of a fresh conversation. Bounded handoff context is rejected if it would lose required content. Terminal counts exclude pending turns.
- **Handoff content**: the bounded summary (≤2000 chars) states the current sealed snapshot, unchanged coordinator controls, the coordinator-verified S1 divide failure, the remaining work, and the required findings artifact ID. It never embeds reviewer prose or paths from expired input views; the findings artifact is delivered through the new turn's own input manifest.
- **No conversation mutation, no fallback**: closed sessions are never written to, and a failed turn still halts the run with `failed`/`unknown` evidence. Modes are explicit choices, never automatic recovery.

Opt-in configuration example (`config.json` passed to the script, or CLI `--feedback-mode <m>`):

```json
{
  "mock": true,
  "feedback_mode": "handoff",
  "cleanup": true
}
```

```bash
node --experimental-transform-types scripts/native-feedback.mjs --mock --feedback-mode fresh --cleanup
```

**Measured evidence per run** (bounded, privacy-safe): per-turn `elapsed_ms` and chain elapsed wall-clock; every MCP `tools/call` counted including errors and failed attempts (per-method and total, with failure codes); the actual UTF-8 byte length of the JSON text payload in tool-result `content[0].text` (excluding the outer JSON-RPC envelope and requests) — never equated to wire traffic, native context, or billing units; `usage` copied exactly as the broker reports it (unknown stays unknown; no invented token or cost estimates); and admitted/terminal/succeeded turn counts. Failures and quiescence are recorded honestly.

**Interpretation limit**: a single measured series cannot establish that any mode saves work or cost. Modes differ only in history reuse and the bounded handoff context delivery; conclusions require rotated, authorized comparison series, and insufficient data must be reported as exactly that.

---

## Evidence & Verification

### Evidence Files
- **Private Evidence** (`evidence.private.json`): Comprehensive record including timestamps, runtime commit SHA, snapshot IDs ($S_0, S_1, S_2$), artifact IDs, content hashes, sizes, event IDs, route profiles, and check results. Omits vendor thinking, reasoning markers, prompt dumps, and credentials.
- **Public Assessment** (`assessment.json`): Privacy-safe public summary recording turn completion counts, continuity verification, artifact chain integrity, and offline check results.

### Independent Coordinator Checks
Coordinator-owned offline checks run directly against the fixture repository:
1. `node --test tests/math.test.js`: Validates function correctness after fix.
2. `git status --porcelain`: Checks the expected three-path fixture outcome. This is a controlled test acceptance check, not a worker file allowlist. Worker authorization defaults to the entire project with root source coverage; only an explicit `write_scope` restricts it. Worker changes remain uncommitted; baseline tests and package hashes must match.

---

## Running the Verification Suite

Run typechecking across the repository:
```bash
npm run typecheck
```

Run the offline integration regression test suite:
```bash
npm test -- --run tests/integration/native-feedback-harness.test.ts
```

Run the standalone harness in offline mock mode:
```bash
node --experimental-transform-types scripts/native-feedback.mjs --mock --large-findings --test-disconnect --test-restart --cleanup
```

---

## Boundaries & Declared Limitations

- **No Native Execution Guarantees**: A50/A53 native pass guarantees are not claimed from mock harness runs. Provider responses in mock mode represent deterministic protocol simulations, not LLM inference benchmarks or live vendor behavior.
- **Isolation Boundaries**: Workspaces rely on directory-level routing, root anti-adoption markers, and broker-enforced path validation. The harness does not provide OS kernel sandboxing, container virtualization, or network-level air-gapping.
- **Tool and Adapter Enforcement**: Worker and reviewer filesystem permissions within native vendor CLI environments remain bounded by underlying vendor CLI capabilities and adapter protocol semantics.
- **Operational Scope**: Quota tracking, rate limit backoff, vendor billing metrics, and credential provisioning remain external operator responsibilities.

Coordinator observations verify the actual R1 findings ID receives UNAUTHORIZED through a foreign MCP bridge, and the final review slot exactly matches assigned S2 files. These checks do not prove the native reviewer read those files; native source-read receipts remain unknown.

The current harness pins accepted runtime `30d2a4e`; the strict accepted-SHA guard remains in place. Historical primary integration used `3cf17bd`, and earlier clone validation used `72ecb93`; their evidence is retained separately.

The [2026-10-03 native checkpoint](native-smoke/2026-10-03-native-feedback.md)
accepted all four turns on Windows with ZCode `GLM-5.3-Flash/max` and Cursor
`grok-4.7-high/high`, preserving both native conversations and verifying S2 and
findings delivery. The failed startup and long-path attempts remain recorded.
That continuity package passed 51 focused tests (17 harness, 34 policy restrictions).
The subsequent [context-mode pilot](native-smoke/2026-10-03-context-modes.md)
accepted fresh, handoff and persistent chains: 12/12 native turns, with 28/28
focused offline tests. Usage remained unknown; the single series establishes
workflow acceptance without an efficiency ranking or native profile certification.

Mock mode rejects any native worker/reviewer route before creating state or children.
Primary acceptance: typecheck and the integrated full suite passed **649 tests**
with one platform skip across 41 files. This includes 15 harness integration tests.
The standalone mock CLI also passed with large findings, active disconnect,
restart before FIX, and owned cleanup. Retained evidence is under
`.state/native-feedback/2026-10-01T12-56-56-267Z-434b7e8b`.

The implementation and repairs were authored by Gemini through the stable broker;
GLM/high and Cursor/auto independently reviewed sealed snapshots. The coordinator
verified the complete Cursor report and repaired cancellation evidence, real ACL
testing, restart ordering, and exact S2 review-slot verification before acceptance.
The earlier isolated full suite passed 608 tests with one platform skip against
72ecb93; that result is separate from the integrated acceptance above.
