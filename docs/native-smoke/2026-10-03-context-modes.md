# Native context-mode pilot — 2026-10-03

## Scope and controls

One authorized Windows pilot compared fresh (F), compact handoff (H), and
persistent (P) conversations, in that order. Each case used the same
implement → review → fix → review chain through public MCP tools, with its own
fixture, daemon, bridge and review slot. Shared Beehive/DMP runtime was untouched.

- Frozen broker: `30d2a4ecd5052af9ae177550b26e8331af616319`.
- Worker: ZCode Individual `GLM-5.3-Flash/max`; independent reviewer:
  Cursor `grok-4.7-high/high`. Deadline: 3600000 ms. No model fallback.
- Identical role instructions, task goals, acceptance criteria, initial files,
  and fixture Git HEAD: `310be7ebbf33eebe541edaa784671279d0b5a2d5`.
  Fixture commit dates are fixed metadata; measurement clocks use actual time.
- F replaces both sessions before FIX/R2, after confirmed completed closure.
  H does the same, adding a 942-character coordinator summary to FIX only.
  R2 uses the explicit S1→S2 binding without an additional summary.
  P retains both sessions and their observed native conversation references.

## Results

| Mode | Accepted turns | Chain elapsed | MCP tools/call count | Result payload bytes | Native usage / billing |
|---|---:|---:|---:|---:|---|
| Fresh | 4/4 | 356934 ms (5:56.934) | 168 | 124298 | unknown |
| Handoff | 4/4 | 291435 ms (4:51.435) | 156 | 116185 | unknown |
| Persistent | 4/4 | 306154 ms (5:06.154) | 156 | 119090 | unknown |

Elapsed time includes setup, probes, event waits, checks and teardown.
Bytes measure UTF-8 JSON text in MCP tool-result `content[0].text`; they exclude
the outer JSON-RPC envelope and requests. They are not native context, tokens,
wire traffic or money. Every tool call, including refusals, is counted.

All three chains were accepted after coordinator inspection: 12 successful
native turns, zero failed native benchmark attempts, and one scheduled FIX per
case with no additional repair cycle. Each case has one expected
`UNAUTHORIZED` tool-call failure from its foreign-coordinator artifact ACL test;
these are not provider failures. All 12 usage records reported
`availability: "unknown"`, `billing_basis: "unknown"`, and no measurements.

## Acceptance evidence

For each case, the coordinator verified the deliberate S1 defect, sealed R1
findings delivery by exact artifact ID/hash/size through FIX's own manifest,
actual foreign-coordinator denial, and exact S2 review-slot files.
Tests/package/index/HEAD controls remained unchanged. The expected added helper
and removed obsolete file were inspected independently. Final fixture tests
passed 2/2 in each case; additional direct helper checks passed for all three.
Complete retained R1/R2 findings were inspected, rather than relying only on
bounded result summaries.

F/H each had four distinct sessions, with nonempty replacement native references
different from their predecessors. Original sessions were confirmed closed
before replacement. P had two sessions with identical references across their
respective two turns. All owned sessions, bridges and daemons closed; no
unresolved children remained. Private evidence and fixtures are retained.

| Case | Initial / R1 turn | FIX / R2 turn | Final snapshot |
|---|---|---|---|
| F | `turn-f27484e50b12c9d33e2d1ea3` / `turn-f75601d8c34a0015d9c390db` | `turn-754ed1e5e2bd0e1a468ef6d2` / `turn-9c8dd370de337fda07b8a10d` | `snap-3de5cbb4ee8b8c8ad463f70b` |
| H | `turn-3a9c338625b139d67f0849ae` / `turn-a880659eae01b30a227700f8` | `turn-d3464ff56db69d0aed0d0474` / `turn-97ba40e5525be97f7567c3c1` | `snap-93e7b4f4e8e4b1b111fa2014` |
| P | `turn-e434410dd73e2d376be4d5bf` / `turn-3d1ad3025631c54f74b5333c` | `turn-0c39eab14c4df23ce8ca9ca4` / `turn-75858f98f80c042b0fb6b384` | `snap-bdec6c568c5a8d8570eb5c4e` |

## Implementation and independent review

ZCode authored the harness extension in an isolated checkout through the frozen
accepted broker. Its turn succeeded. The first Cursor review was refused before
inference: projected private store/sidecar path length 275 exceeded the Windows
260 budget. That failed evidence remains retained. Moving the dogfood runtime to
a fresh short system-temp `ab-df-*` root allowed a separate successful Cursor
review of the integrated source; no second native author was launched.

Cursor identified missing fresh-identity refusal and outdated mode/path
documentation. The coordinator fixed those findings, and additionally corrected
terminal counting, required handoff content bounds, bounded event waits with
monotonic cursors, and deterministic initial fixture metadata.

Final focused acceptance: `npm run typecheck` passed; the harness and event-wait
integration files passed **28/28 tests** (22 + 6). Both scripts passed Node syntax
checks. Full-suite results belong to the earlier integration checkpoint and were
not rerun for this scripts/tests/docs portion. No public MCP API, runtime source,
storage schema or dependency changed.

## Interpretation and remaining work

**Insufficient data to choose a more efficient mode.** This is one F→H→P series,
not repeated or rotated trials. Backend load and setup vary; models also chose
different helper implementations (guarded clamp, double, and simple clamp).
Matching task instructions therefore do not establish identical realized work.
The shorter observed H time is not evidence of token or cost savings.

The practical continuation/fresh rules in
[coordinator instructions](../coordinator-instructions.md) remain appropriate:
retain related work context, and choose explicit fresh/handoff sessions when
resetting context or handing work over. This pilot proves that all three
workflows function on this Windows/model pair, not that one is cheaper.

Native source-read receipts, enforced profiles, cancellation during vendor tools,
other platforms/model pairs, researcher certification and total storage admission
remain separate open gates. No further paid comparison is justified by this
pilot alone while usage is unavailable. Raw provider output, credentials and
private runtime evidence are excluded from Git.
