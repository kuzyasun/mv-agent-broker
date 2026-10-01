# Physical checkout lease checkpoint — 2026-10-01

ZCode Individual GLM-5.3-Flash/max authored this portion through the public MCP
broker on frozen commit `cffcb81`. Cursor auto independently reviewed the
integrated sealed target. The coordinator verified the actual diff and two
review findings, repaired them, and ran typecheck plus the complete offline
suite: **448/448 tests in 33 files passed**. No real Claude was launched.

Writer reservations now use filesystem directory identity (`stat` device/inode
after realpath), so registered IDs, Windows junctions, case spellings and
dot-segment aliases of the same checkout share one exclusive writer lease.
Distinct physical checkouts remain independent. An unavailable inode fails
closed; lexical path fallback is insufficient proof of alias exclusion.
Preflight identity is compared again at admission and dispatch. A changed
checkout after native completion becomes evidence failure, preserving the
known completed outcome without sealing another checkout as its final source.

Legacy workspace-ID leases contain no historical physical identity. Current
registry paths cannot recover that identity after retarget or clear. Such a
lease therefore conservatively blocks physical writers until quiescence-based
reconciliation. Path-less targets retain their ID-scoped compatibility.
`UNKNOWN` keeps its durable physical lease and quarantine on the original
checkout even if its registered path changes; a provably unrelated checkout
remains usable. A legacy/operator quarantine flag without a physical binding
also conservatively blocks physical writers. Foreign project hold identity and
reason are not disclosed to the requesting coordinator.

New regression scenarios cover preflight/admission retarget, post-completion
retarget, unresolved/cleared/different legacy paths, scope-shaped legacy IDs,
retargeted quarantine, independent access beside physically bound UNKNOWN,
and foreign-project diagnostics. A temporary stricter snapshot precondition
broke durable failed-capture replay; the coordinator reverted it and reran the
existing regression. The failed test run is not reported as a passing gate.

The Cursor review target preceded the final namespace and legacy/quarantine
repairs; the coordinator accepted those against the concrete findings and
regression tests. The final Git checkpoint, rather than the author's or
reviewer's earlier snapshot, is the accepted implementation.

This closes the offline/platform checkout-alias portion. It does not establish
native descendant quiescence or complete provider permission profiles. The
[Cursor outside-read failure](../2026-10-01-cursor-read-boundary/report.md)
remains failed and requires a separate repair and native falsification.
See [sanitized evidence](workspace-aliases.evidence.json).
