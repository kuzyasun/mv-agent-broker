# Effective policy and stable-runtime checkpoint

The self-development client now extracts committed broker source and records
its immutable runtime commit. A no-quota MCP rehearsal used `d7d01b3`, completed
successfully with 47 files, and excluded both dirty and untracked source.

ZCode Individual GLM-5.3-Flash/max implemented the write-policy package through
the broker's public MCP using frozen runtime `e8a2f70`. Native execution
completed and the source changes were retained. Its broker turn is **FAILED**,
with `SCOPE_VIOLATION` and no final snapshot: the coordinator created top-level
diagnostic files in protected `.state` metadata during the writer turn.
That failure is preserved; it is not a quota error or successful worker turn.

The coordinator inspected the actual diff, verified the initial 340-test suite,
and corrected legacy live-profile fallback, pre-input/dispatch policy checks,
and caller-contract error priority. An explicit new MCP mock turn sealed the
integrated source for independent Cursor auto review against the original
worker baseline. Cursor completed through the same frozen runtime and reported
no findings. Its report was delivered within the summary cap. The final small
caller-contract refactor followed that sealed review target; the coordinator
verified it with existing caller-contract tests and the full suite.

Final offline validation: typecheck passed; **343/343 tests in 29 files**, including
27 policy tests and all five caller-contract tests. These use mock adapters and
temporary workspaces, not native Claude. The existing dogfood evidence validator
also passed. Native authentication remains owned by each installed CLI.

A follow-up tightened rejection metadata to explicit `execution_started=false`.
Its typecheck and all 39 policy/bridge tests passed. The accepted `cf99dc5` copy
then passed a public MCP smoke without native inference: unknown restrictions,
scope widening, null restrictions and traversal were rejected with zero sessions,
turns, reservations or accepted keys. The same rejected key subsequently admitted
a valid narrowed mock session, which completed with a sealed final snapshot.
Its durable policy grant was verified as `src/core` in the private registry.

An independent Antigravity design review completed in a separate review slot,
but its delivered summary reached 4000 characters and ended mid-sentence.
Retain it as partial evidence, not complete acceptance. Future dogfood briefs
require findings first, relative paths and at most 3000 characters.

A separate no-inference Cursor status probe remained authenticated with private
permission configuration. Cursor's review report also observed shell blocked in
Ask mode. Neither establishes complete write/network/MCP isolation. Native
enforcement and usage accounting remain unknown; the full MVP gate is open.

See [policy behavior and legacy session handling](../../policy-restrictions.md),
[sanitized evidence](effective-policy.evidence.json), and the delivered
[Cursor report](cursor-review.md). Keep coordinator diagnostics in an existing
nested private directory during future turns.
