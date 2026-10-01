# Complete input transport checkpoint — 2026-10-01

Implementation and independent reviews use public MCP and frozen accepted
runtime `39c3e8bb24d429872027ea2e3af16a2f0692eb82`. Claude and Codex are not launched.

## Native development evidence

Antigravity `gemini-3.8-flash-high` author completed as `SUCCEEDED` on turn
`turn-5fbc599b233e15ff4ba222ad`, native conversation
`206b3061-ed10-4ae6-b291-103cfb75ce6d`. Source baseline was
`snap-42ebd453e41cbb0685cb55bb`, final `snap-99a97ef399a7580f54cec005`.
Its declared prose contains progress messages as well as the final report;
it is not proof that reported checks ran. Coordinator independently ran checks.

The 4000-character summary correctly declared truncation. After restarting
this task's own frozen daemon, public `agent_turn_result` and
`agent_artifact_read` retrieved all 5603 UTF-8 bytes of report
`art-eda065ef1c033f58266ba0c6`, including the final check/limitation section.
SHA-256: `9b22074cc472fb00a6eedfe92ec11c24c253b77c07e56637e187b666b148fc83`.
This proves report retrieval across a daemon restart, not native conversation
continuity. No model call was made during retrieval.

Cursor `auto` independent review was attempted separately and failed on turn
`turn-74c88e0a4a336cbc6aa10dc1`, conversation
`6729384e-2179-4918-bfd3-5e19ff005f9f`. The recorded native diagnostic was
`RetriableError: [internal] unable to open database file`; core retained
`PROVIDER_PROTOCOL_ERROR` and completed native failure with owned quiescence.
This repeats the known long private SQLite-path issue, not observed quota
exhaustion. The failed review is not acceptance evidence and is retained.

An explicit alternative review used Individual `GLM-5.3/high`, with renewed
operator quota, and succeeded on `turn-ab80378927a8eb81273d9f28`, conversation
`sess_d89f9e6b-3c2f-41d1-8809-be5513720c8b`, findings artifact
`art-bdc3e4f1b1f568aa4910ab7b`. The reviewer observed the previous runtime's
omission of `src/core/execution.ts` from its required diff; the sealed target
source remained readable. It also confirmed an empty transport descriptor
bypass and incorrect EOF marker placement. Coordinator repaired both, as well
as the inline/path planning and pre-publication problems found independently.
Neither account nor model is silently substituted by an adapter.

## Integrated behavior

- Optional adapter transport bounds measure the actual full envelope, including
  instructions, complete task JSON, headers, snapshot identifiers, input hashes
  and exact path bindings. Planning and dispatch share one renderer.
- The preferred legal plan is measured first. Short inline inputs are retained
  when their paths would be longer; eligible inline inputs can become complete
  read-only materializations. Forced-inline channels and shared 16 KiB budget
  remain respected. Invalid bounds or missing required byte measurements fail.
- ZCode adapter 0.2.4 declares the existing 6000-code-unit bound and keeps its
  defensive last check. It does not truncate caller instructions or task goal.
- Required reviewer diffs use the complete renderer, with an 8 MiB finite
  delivery limit. The bounded preview API remains explicitly separate. Large
  LCS problems use a deterministic linear replacement rather than omitting a
  changed file. Missing source blobs, unsupported binary/invalid UTF-8 and
  oversized diffs fail explicitly before inference.
- BOM, CRLF changes and each side's missing final newline are represented.
  Transport rejection happens before provisional review-patch publication or
  review-slot refresh, and never seals an input manifest or grants dispatch.

## Verification boundary

Coordinator full offline suite: 593 passed, 1 platform skip, 39 files.
Final typecheck and 41 targeted tests in four files cover subsequent planner
and renderer repairs; the full suite was not repeated after those narrow edits.
The ZCode adapter version advances from 0.2.3 to 0.2.4; historical version-bound
sessions require explicit replacement/revalidation, rather than silent migration.
Fake native
CLI tests exercise protocol/input grants without consuming vendor quota.
Native mandatory access enforcement, all provider/role profiles, and complete
MVP acceptance remain open. Reviews use the frozen previous runtime whose
required diff may be preview-bounded; source in the sealed target remains
available, so this does not prove native complete-diff delivery on 0.2.4.
