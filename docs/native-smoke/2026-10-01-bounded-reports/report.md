# Bounded native output and durable complete reports — 2026-10-01

Development used public MCP with runtime pinned to accepted commit
79496f5097bb523cb0fedb0f20c89c7795d8849e. The Cursor auto author and renewed
ZCode Individual GLM-5.3-Flash/max repair both completed successfully. Their
reports are agent claims; coordinator checks and repairs determine acceptance.
Earlier quota failures remain preserved. No actual Claude or Codex was launched.

## Implemented behavior

- Native stdout/stderr processing has shared UTF-8 byte limits: 1 MiB per
  line, 8 MiB total and 50,000 line events by default. A no-newline stream
  also consumes the line budget. The owned Windows helper separately limits
  native bytes. Overflow requests cancellation and waits for owned quiescence;
  missing quiescence remains UNKNOWN with resources retained. POSIX child exit
  is not advertised as proof of whole-domain quiescence.
- Only known operational labels and projected event/receipt keys persist.
  Native thinking events and arbitrary progress tokens/tool arguments are
  discarded. The limits apply before parsing discarded payloads too.
- A bounded declared native final is stored as a sealed project report, or a
  findings JSON container with broker-assigned session/turn/S1/S2 bindings.
  The summary remains bounded to 4,000 characters. Full content has an 8 MiB
  UTF-8 limit; oversize is an explicit evidence failure, never silent tail loss.
- Known native outcome and the required-report declaration commit atomically.
  The existing launch intent then journals one artifact identity/hash/size and
  staging pin before filesystem writes. Verified sealing, pin transfer and
  phase settlement are fenced by daemon incarnation. Recovery verifies actual
  blob bytes and bindings, including already sealed publications, before using
  them. Missing/corrupt evidence fails explicitly while retaining the known
  completed native outcome; it never starts another inference.
- The latest worker/researcher report stays anchored while its session is open.
  A later validated report makes the previous owned report eligible for explicit
  cleanup. Reviewer findings remain anchored until close. UNKNOWN and pending
  publication roots retain their protections. Failed staging records expire by
  their owned pins, including recovery from malformed report metadata.
- Additive result metadata exposes `summary_truncated`,
  `full_message_artifact_id` and artifact references. Text artifact pages retain
  `content_type: text` and add `bytes_read`/`next_offset`. Byte offsets must be
  UTF-8 boundaries; pages end at complete characters and never silently insert
  replacement characters. A page too small for its next character fails with
  INVALID_REQUEST. JSON pages are text fragments; assemble them before parsing.

## Coordinator validation

Typecheck passed. The first integrated full gate passed **566 tests**, with
one platform skip across 38 files. Subsequent recovery/schema/metadata/hardlink
repairs passed typecheck and **48 targeted tests** across four files, followed
by a complete **569 passed / one platform skip / 38 files** gate.
Independent GLM-5.3/high review completed on the sealed target listed below;
the coordinator confirmed and fixed its active-no-newline timer regression,
settled-report duplicate event and callback diagnostic findings. After that
repair, typecheck and **38 targeted tests / one skip / two files** passed.
The final reviewed full gate passed **571 tests**, with one platform skip,
across 38 files. A final schema-key correction preserves the installed
Windows helper's `root_exit_code`, `active` and `drained` quiescence fields;
its targeted regression and typecheck are separate from that full gate.

The coordinator repaired defects remaining after native authorship: the gap
between outcome and declaration, latest report retention, late UNKNOWN report
publication, sealed/malformed journal verification, unrestricted progress and
receipt tokens, and UTF-8 paging. Regression tests use actual SQLite failure
triggers, stored blob corruption and owned filesystem fixtures.

## Boundaries and provenance

Offline fake-provider/process tests do not promote any complete native
platform/adapter/role/profile to supported. Latest native report publication,
large input, hosted tool-domain cancellation and full feedback-loop probes
remain separate. The prior Cursor 0.2.6 clean S1/S2 continuity pair is documented
[separately](../2026-10-01-cursor-clean-continuity-repaired/report.md).

The GLM reviewer explicitly reported that the generated required diff ended
with `[diff truncated]`; it read the omitted broker/execution source from the
sealed target instead and did not execute tests. This limits the independent
comparison evidence. The coordinator inspected the full Git diff. Removing
required diff truncation and the large-file LCS omission is part of the next
complete-input transport portion; this checkpoint does not claim that gap closed.

Private records retained:

- Cursor author: `.state/dogfood/2026-10-01T08-10-10-951Z-d14747d2/evidence.private.json`;
  turn `turn-99f1e9e37755e27528487acf`.
- Independent Gemini review of original package:
  `.state/dogfood/2026-10-01T08-28-29-331Z-b98d1e1b/evidence.private.json`.
- GLM repair: `.state/dogfood/2026-10-01T08-36-05-744Z-6358b805/evidence.private.json`;
  turn `turn-b1b03504a1f601e2901afbd0`.
- Integrated independent GLM-5.3/high review:
  `.state/dogfood/2026-10-01T09-34-10-725Z-7d6d12ec/evidence.private.json`;
  sealed target `snap-2459cd640a715c00f6c1bff8`.
