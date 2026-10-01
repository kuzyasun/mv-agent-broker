# Opt-in Native Feedback Harness (MVP v0.2)

## Overview

The native feedback harness (`scripts/native-feedback.mjs`) provides an opt-in, caller-independent Node Model Context Protocol (MCP) client driving the normative multi-turn feedback workflow:

$$\text{Worker (Turn 1)} \longrightarrow \text{Reviewer (Turn 1: R1)} \longrightarrow \text{Worker Fix (Turn 2: Same Worker)} \longrightarrow \text{Reviewer (Turn 2: R2: Same Reviewer)}$$

The harness operates over existing public MCP tools and accepted Git runtime patterns from `scripts/dogfood.mjs`. It establishes designated operational boundaries between the supervisor daemon, the worker workspace, and the review slot workspace, structuring cross-turn transfers through sealed artifact IDs and keeping worker edits within a separate fixture repository.

---

## Key Invariants & Security Architecture

### 1. Operator Authorization & Provider Constraints
- **Production Providers**: Only `zcode`, `antigravity`, and `cursor` are permitted.
- **Forbidden Routes**: `claude` and `codex` are strictly disallowed. `AB_CLAUDE_BIN` and `AB_CODEX_BIN` environment variables are actively purged from the daemon environment before execution.
- **Explicit Configurations**: In production mode, an explicit model string and verified runtime commit SHA are required. No implicit native execution.
- **No Automatic Fallback**: Failures halt immediately with durable `failed` or `unknown` evidence. The harness never attempts fallback to another provider, model, or fresh session.

### 2. Immutable Broker Runtime & Temporary Fixture Repository
- **Broker Runtime**: Copied from regular Git-tracked source (`src/`) and `package.json` at an accepted, immutable commit SHA (`3cf17bd5a8f3b3ce09e067521ab26e0e0839596c`). Uncommitted or untracked changes cannot enter the supervising daemon.
- **Temporary Fixture Repo**: The worker operates within an owned, temporary Git repository with a generated package and source baseline (`src/math.js`, `src/obsolete.js`, `tests/math.test.js`). The worker workspace is registered with its canonical path bound to this fixture repository. The worker edits do not touch the main coordinator repository checkout.
- **Review Slot Workspace**: The reviewer operates in a `review_slot` workspace (`mode: "review_slot"`), where the broker populates exact snapshot trees separate from the worker's mutable working tree.

### 3. Normative 4-Turn Lifecycle

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

---

## Evidence & Verification

### Evidence Files
- **Private Evidence** (`evidence.private.json`): Comprehensive record including timestamps, runtime commit SHA, snapshot IDs ($S_0, S_1, S_2$), artifact IDs, content hashes, sizes, event IDs, route profiles, and check results. Omits vendor thinking, reasoning markers, prompt dumps, and credentials.
- **Public Assessment** (`assessment.json`): Privacy-safe public summary recording turn completion counts, continuity verification, artifact chain integrity, and offline check results.

### Independent Coordinator Checks
Coordinator-owned offline checks run directly against the fixture repository:
1. `node --test tests/math.test.js`: Validates function correctness after fix.
2. `git status --porcelain`: Validates that only the three assigned source paths changed. Worker changes remain uncommitted; baseline tests and package hashes must match.

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

Primary integration pins the accepted readiness commit 3cf17bd5a8f3b3ce09e067521ab26e0e0839596c; the strict accepted-SHA guard remains in place. The earlier clone validation used 72ecb93 and is recorded separately.

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
