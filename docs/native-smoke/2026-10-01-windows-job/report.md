# Windows owned process supervision checkpoint — 2026-10-01

Status: implemented and tested with owned offline Node processes on Windows.
This is not acceptance of a complete native vendor role/profile.

## Implementation and boundaries

The shared runner creates a suspended root, assigns it to a new named Windows
Job with kill-on-close, and binds the daemon owner by process handle and exact
creation time. Only three native pipe handles are inherited. Private nonce
control frames are separated from bounded base64 native output. Existing named
jobs and unavailable creation identities are refused before resume.

The core records launch UUID, job, root/helper/owner identities in the existing
launch intent and runtime references in one incarnation-fenced transaction
before acknowledging resume. Corrupt, missing or duplicate intents refuse the
acknowledgement. The permission grant alone is not proof of execution; a
journaled zero-resume receipt corrects the phase when execution was refused.

Normal completion requires zero active job processes and drained native pipes.
The native root exit code is preserved. Cancel and native IO deadlines terminate
the owned job. Helper loss after an acknowledgement is conservative `UNKNOWN`,
even when the resume receipt was lost: leases, pins and private bindings stay
held. An unresolved owned shutdown also stays conservative. An asynchronous
ownership callback cannot acknowledge a helper that has already closed.

All five adapters forward ownership events and preserve private bindings on
typed `EXECUTION_UNKNOWN`. Adapter versions changed: Cursor 0.2.5, ZCode 0.2.2,
and Antigravity/Claude/Codex 0.2.1. Existing version-bound sessions require
explicit revalidation/replacement; historical native context is not migrated.

An Antigravity local CLI job does not establish quiescence of hosted tools.
Full mandatory role controls, hosted execution-domain proof and current-version
native model/resume conformance remain open. POSIX execution is not promoted by
these Windows tests. No real Claude or Codex was invoked.

## Retained author and review provenance

All native tasks used the public MCP interface and immutable runtime
`82fba0a877e711f1affbcf0b185aae16bb06f714`.

| Task | Retained result |
|---|---|
| ZCode Flash/max author, `turn-6a1ff499ac5431ccc380392c` | FAILED: explicit provider 1310 weekly/monthly quota limit; partial helper retained, no final report |
| Cursor auto completion, `turn-1deef60c6c3259f9b805c2ea` | SUCCEEDED workflow but reported partial implementation/checks blocked by native Shell permission; not acceptance proof |
| Gemini high review, `turn-2d61440c66dd987c6a4b4c0c` | Identified the accounting ABI defect and weak descendant tests; main reproduced the normal-run hang |
| Gemini high repair, `turn-d997d9cacf4f3daf4c573aa0` | FAILED after an outbound model HTTP connection closed; source retained, no final report or accepted final snapshot |
| Cursor independent review, `turn-e05a04687c5a13558773c2b5` | Sealed current capture compared with the original pre-author baseline; phase/creation-time findings checked and repaired by main |

The original helper was unverified partial source. Review of the complete
helper and actual Git diff was required; its presence in a later baseline was
not treated as earlier acceptance. A review suggestion to classify lost ACK as
known zero-resume was rejected because resume may already have happened.
The follow-up integrated review and any confirmed repairs are recorded below.

The final integrated Cursor review `turn-36f5b91d38c6db326395450b`
(native `2bad5d02-31d5-4b49-bbfe-3caf61b9b22d`, sealed target
`snap-f49112346e57ce817fe82fb3`) found two confirmed shutdown defects: a
default terminal root code and an owner-lost termination without `killed`.
Main sampled the actual root exit before the terminated receipt, marked every
owned termination as killed and added an owner-channel EOF regression after
declared success. Direct launches now pass the explicit application path;
PowerShell/where supervision lookup is independent of the vendor PATH.
The owner-death fixture asserts a successful handle kill and its observed signal.
This fixture does not promote a complete provider execution-domain profile.

Main also checked installed Cursor help: `--force` permits command execution
unless explicitly denied, while `--trust` only trusts the workspace. It is now
requested only for a worker with an explicit nonempty `workspace_write` binding;
reviewers, read-only/empty workers and unbound direct callers do not receive it.
No `--approve-mcps`, global settings change or native scope-enforcement claim is
introduced. This permits subsequent broker authors to run their local checks.
Four focused fake-argv cases independently verify this selection.

Private MCP evidence remains under `.state/dogfood/`; credentials, native
history, prompts and reasoning are not copied into this public report.
ZCode's explicit service reset was 2026-10-07 04:40:09, with no verified timezone.
It does not establish Start Plan usage or exhaustion. The operator-authorized
Cursor/Gemini alternatives were selected explicitly, without automatic fallback.

## Main validation

`npm run typecheck` passed. The complete offline suite passed **512 tests across
37 files**, with one non-Windows capability branch skipped on Windows. The
final shutdown regression adds one test; the final gate is recorded below.

Final full gate: **513 passed / 1 platform skip / 37 files**. After the bounded
Cursor writer-approval addition, typecheck and the four focused fake argv cases
passed; this does not claim a native Shell conformance test.

Sixteen real owned-process tests cover nonzero root exit, ownership before
stdout, zero-output callback refusal, forged native NDJSON, heartbeat growth
after the observed root exit, cancellation after native readiness, exact owner
death, helper loss after resume, stale owner creation time, large stdin, helper
close during a pending callback, Unicode chunk boundaries and EOF tail.
Seven separate core fixture tests cover atomic ownership, corrupt/missing/
duplicate journals, invalid creation identity, typed UNKNOWN resource retention
and zero-resume phase correction. Core fixtures are not native confinement proof.

The initial 60-second normal-run timeout and the first full-suite failures were
preserved as failures. Main repaired the Win32 accounting layout, nested DB
transaction, protocol ordering/bounds, phase evidence, helper PATH dependence,
adapter version expectations and private failure-evidence retention before the
passing gate. No Git push or support-matrix promotion happened.
