# Required input integrity checkpoint

Every required-byte consumption in execution verifies the authoritative sealed
SHA-256, size and regular single-link file identity before native dispatch.
This covers snapshot manifests, source review slots, diff inputs, inline
candidates and final envelopes, and materialized input copies. Corruption does
not trigger a channel fallback, rehash or reseal under the old metadata.

Views verify callback bytes before publication. Review slots reject invalid
file hashes/sizes before clearing an existing tree. Directory ancestry is
checked before verified blob reads, view creation/cleanup and slot refresh;
linked ancestors are refused. Unknown published inodes are retained.
These sampled checks do not establish an OS immutable lock or native sandbox.
Low-level unchecked blob reads remain separate from these verified consumers;
deduplication/storage accounting is a later portion.

Cursor/auto authored and repaired the package through public MCP on accepted
runtime `0303daee96b01d250f3de49f4ff9ee6f066f9d04`. The primary review identified
unchecked manifest reads, a synthetic-hash bypass, and ineffective link tests.
An independent Gemini 3.8 Flash/high review examined the repaired whole package
against the original clean baseline (turn `turn-1efafde7807d13107a5234fc`, native
`061e616f-966c-4512-b822-3cc556374402`) and reported no findings. The coordinator
independently corrected the remaining grandparent-link gap and added four
regressions; review claims about ancestry were not treated as proof.

Full review artifact: `art-734bbf3daf90d89ba5f6ec4f`, 2591 UTF-8 bytes, SHA-256
`b18012ce2cf56ddc9bbaa9a1fcc8c289ad06ca5a7d46ec7cee85705f77f77218`.
It was read completely through public MCP after restarting the owned daemon,
without new inference.

Primary isolated acceptance: typecheck and **667 passing tests, one platform
skip, 43 files**. Targeted execution cases prove zero adapter calls and no
dispatch permission for same-size inline/path corruption, corrupt target
manifests, missing source bytes, file links, a used blob-prefix junction and
hardlinks. Valid inline envelopes and path copies retain the sealed bytes.
Four real ancestor-junction cases additionally preserve existing physical
files and refuse foreign directory creation/cleanup. Link creation failures
are explicit skips; they are not reported as successful denial tests.
Integration typecheck and 62 focused tests across six files passed, including
snapshot and concurrent worktree compatibility checks. The 667-test gate above
was run on the isolated accepted-source candidate, separate from the unfinished
worktree portion in the main checkout.

No Claude/Codex CLI was launched. Offline gates do not promote a complete
native worker/reviewer profile or close the native P0 acceptance requirement.
