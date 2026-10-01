# ZCode quota attribution checkpoint — 2026-10-01

## Outcome

ZCode adapter 0.2.6 recognizes explicit JSON error attribution and requests
owned process termination before returning QUOTA_EXHAUSTED or RATE_LIMITED.
Messages are fixed; only observed numeric vendor_code/status_code survive.
No account/model/plan/provider fallback or automatic retry is added.

Codes 1308/1310 and 1316–1321 indicate usage exhaustion; 1302/1305 indicate
transient limits. Code 1308 alone does not prove a five-hour window.
[Official API reference](https://docs.z.ai/api-reference/api-code).
Installed SDK error fields also allow model_rate_limited and attributed
Start Plan busy codes 3008–3010. These are parsing contracts, not evidence
that every standalone CLI error is observable.

Idle completed projections ignore historical lastError. Response prose,
nested tool data, unsupported message prefixes and generic HTTP 429 text
cannot produce quota classification. Error message/header content is withheld.
Ownership/capture uncertainty, operator cancellation, timeout and output caps
retain precedence. Temporary launch resources survive EXECUTION_UNKNOWN.

## Author and acceptance evidence

Antigravity gemini-3.8-flash-high authored through the public MCP interface
using the accepted cc9eb695565179671cb909f88222d10f7259a19b runtime extracted
from Git. The author turn ended FAILED/SCOPE_VIOLATION with an owned quiescence
receipt; its partial source was retained rather than accepted as success.
The violation was coordinator-created protected .state/quota-review-client.mjs
during the active writer, not attributed to the vendor. This coordination
error remains recorded; later acceptance used an explicit current-source capture.
The coordinator corrected unsupported message parsing, invented status/duration,
historical idle errors, multiline attribution and raw stderr retention, and
added independent regression cases. A separate sealed current-source review
and coordinator checks are recorded below.

## Current incident and limitation

The operator confirmed exhausted five-hour quota. Three prior ZCode jobs
ended FAILED/PROVIDER_PROTOCOL_ERROR; one ended TIMED_OUT. All had owned
quiescence receipts. Their exact current vendor codes were not retained and
cannot be retrospectively asserted. Historical 1308/1310 evidence remains
historical and does not establish those four current codes.

Static evidence: installed zcode.cjs, 14,820,968 bytes, SHA256
fad4c35c4c36ec210d8a06d3fa0e77de23c8545e2eb6ff90aea1eb38d1e6275f.
Its outer catch prints only error.message. If the CLI drops attribution or
silently retries under --json, the broker cannot infer quota from silence or
arbitrary text; the generic error/deadline boundary remains. No live ZCode
inference or quota smoke was run for this checkpoint.

## Validation

- Independent Cursor auto sealed review completed with owned quiescence using
  the unchanged accepted cc9eb69 runtime. Its three findings were confirmed
  and corrected: restore the Cursor quota row, label the ZCode row limited
  without a five-hour overclaim, and preserve explicit top-level errors next
  to idle projections while ignoring only historical projection.lastError.
- Complete review report retrieved through public MCP after daemon restart:
  2264 bytes, SHA256
  214f6caebe49cf4a5ca2463de36b0fa9e25a086117472dc20843f5ce2c0f366a.
  The reviewer did not execute tests. Coordinator acceptance inspects actual
  source and verifies findings independently.
- npm run typecheck: passed in the isolated accepted-source clone plus this
  package, and in the main checkout after integration and final source fixes.
- npx vitest run --maxWorkers=2: 723 passed, one platform skip, 44 files,
  isolated cc9eb69 source plus the final quota package only.
- Integrated targeted gate: 143 passed across zcode-quota, zcode-adapter,
  native-readiness, provider-preflight and transport-inputs. Quota file: 56 tests.
- Regressions cover attributed quota/rate errors, observed numeric details,
  successful stale-error resume, explicit top-level failure beside idle,
  multiline/unterminated data, unrelated tool/prose/auth errors, output bounds,
  cancellation/deadline/capture/UNKNOWN precedence and secret withholding.
  A real owned Node descendant writes a heartbeat; quota abort produces
  active=0/drained=true and the heartbeat stops before definite failure returns.
- Initial default-parallel full run had one existing headless-infra inactivity
  test timeout (200 ms). Its unchanged isolated run passed 20 tests/one skip;
  the bounded final full run passed. This is retained as load-sensitive evidence.
- git diff --check: passed. No native ZCode, Claude or Codex inference/probe
  was used. Other provider adapter tests use fake Node processes.

## Stop boundary and preserved work

The operator requested completion of this package, a commit and then a stop.
Only this quota package is accepted here. Seven unfinished worktree source/test
files in the main checkout retain their exact pre-integration SHA256 bytes.
Worktree, event wait, physical storage admission and operator setup partial
packages remain unaccepted and retained; no next implementation is started.
Core A01–A53 closure and full native feedback/profile evidence also remain open.

The first independent review failed before dispatch with EVIDENCE_CAPTURE_FAILED:
review-slot refresh SLOT_PATH_INVALID. Fresh stable bootstrap did not create
its owned inputs/slots base directories. The second run pre-created empty owned
directories in a fresh short state root; it did not modify the supervising
runtime. Bootstrap initialization is a confirmed separate remaining defect.
Cursor quota exhaustion was not observed: the first failure consumed no native
dispatch and the second review succeeded.
