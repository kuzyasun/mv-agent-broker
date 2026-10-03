# Compact complete review diffs

Accepted baseline: `e1ef4e6`. This runtime package is separate from the AD-01
documentation package. It adds no configuration, API fields or dependencies.

## Behavior

Every added/deleted line remains in deterministic numbered unified hunks.
Unchanged context is three lines before and after a change; touching or
overlapping windows merge. File ordering, content hashes, newline markers,
CRLF/BOM bytes and the original review baseline/target remain unchanged.
Complete additions/deletions and the existing bounded-LCS replacement fallback
remain complete. Missing blobs, unsupported content and over-budget complete
output still refuse execution; snapshots and required inputs are not narrowed.

Full source remains retained in sealed snapshots. Compact text does not prove
that a native reviewer read or accepted all input.

## Native development and independent review

Cursor `grok-4.7-high` / `high` authored the package through frozen `e1ef4e6` in
an exclusive checkout. Turn `turn-cd9a69296f6189b4ad1628dc` succeeded and its
private session/daemon closed. Evidence: dogfood
`2026-10-03T02-08-11-686Z-064472e0`.

ZCode Individual `GLM-5.3` / `high` reviewed the original author baseline and
exact sealed target through frozen accepted `c5ccfb2`. Turn
`turn-43f2e993c2c7800eb07b6c97` succeeded; private cleanup passed. Evidence:
dogfood `2026-10-03T02-22-42-367Z-9e2e1c71`.

Review found no correctness defects and three minor/nit observations. The
coordinator restored an unchanged documentation prefix from the exact baseline
blob to eliminate EOL noise, and moved a misplaced JSDoc. Empty-file sections
remain header-only: they contain no missing content lines and file-kind/hash
metadata remains available. That presentation nit is deferred.

## Coordinator verification

- Typecheck and 40 tests across diff, review delivery, transport and required
  input integrity passed. The original-binding/full-head-tail test beyond the
  former 8 MiB budget remains green, as does pre-inference budget refusal.
- Another 41 tests passed: snapshot lifecycle and the mock-backed real
  implement/review/fix/same-reviewer harness, including findings delivery.
- Independent `git apply` reconstructed target bytes exactly for 14 fixtures:
  ordinary/separated changes, edge insertion/deletion, empty-to-text and reverse,
  missing/final newline changes, CRLF, BOM and one edit in a 10,000-line file.
- The identical 10,000-line fixture's complete document was 300,123 UTF-8 bytes
  before and 339 after; source files and the one added/deleted line were the same.
  This is a byte measurement, not exact tokens, money or subscription savings.
- Coordinator final diff review and `git diff --check` passed.

Trailing-newline changes retain the existing complete-side replacement. Full
classified bodies are still constructed before output compaction; memory/CPU
behavior is not claimed improved. Comparative native context strategies remain
`not_run`; the AD-01 protocol records their variables and unknown usage.

The shared daemon/UI stays on `e1ef4e6`. Applying this package is a separate
guarded idle update. Private transcripts and runtime evidence remain outside Git.
