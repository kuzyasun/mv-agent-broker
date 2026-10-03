# Cursor metadata probe recovery

## Incident and bounded repair

Beehive reported a pre-inference `--list-models` refusal with exit 3221226505.
It is Windows fail-fast status `0xC0000409`, not a root-cause diagnosis
([Microsoft](https://learn.microsoft.com/en-us/cpp/intrinsics/fastfail)).
The reported response had no turn ID, artifact or stderr, and its existing
session remained IDLE.

Cursor readiness and operator catalogue refresh now retry that exact signed
or unsigned exit once, using the same pinned metadata command. They require
a fresh successful response; a second failure still refuses before inference.
Ordinary failures and timeouts are not retried. No paid turn is replayed and
no stale catalogue or model substitution is used. Refusals include safe probe
arguments, exit status and attempt count without publishing raw vendor logs.

The MCP send description, binding field descriptions and rejection message
also explain that a reviewer sends `review_binding` only. The coordinator guide
has the same instruction. Contradictory worker/reviewer bindings remain invalid.

## Live control and verification

Two pinned installed Cursor catalogue probes succeeded with 246 model IDs,
including the requested `grok-4.7-high`. An authorized one-response paid control
through frozen accepted broker `700449a`, with that model and `high` effort,
completed `SUCCEEDED` and returned `CURSOR_BROKER_CONTROL_OK`. Execution started,
and the private harness closed its session and stopped its daemon without a
close error. Source was not changed. This establishes current success; it does
not reproduce or explain the earlier fail-fast crash.

Private control evidence: dogfood `2026-10-03T00-44-16-860Z-863ee7fc`.

A second paid control used the accepted repaired runtime `ffe10e5`, the same
requested model/effort and an explicit five-minute smoke deadline. Turn
`turn-dba8fb3e305c5642630a93ec` succeeded with execution started and the same
exact response, without source edits. Private evidence: dogfood
`2026-10-03T01-07-22-145Z-6e819b06`; private session/daemon cleanup succeeded.
The specific fail-fast retry branch is covered by offline fault injection;
the real control did not reproduce that crash.

Coordinator typecheck and 36 focused tests passed across metadata retry,
operator UI and bridge protocol. The existing fake-native readiness suite
passed 40 tests before the final UI/description changes. Tests cover both
exit representations, a successful fresh second response, repeated refusal,
ordinary errors/timeouts, inference-argument rejection and contradictory
review bindings rejected before core admission.

Independent ZCode Individual `GLM-5.3` / `high` review through frozen `700449a`
finished `SUCCEEDED`. It inspected the six listed target files: this was a
current-source review after integrator capture, not a historical delta review.
Private evidence: dogfood `2026-10-03T00-59-46-401Z-0eca8de0`; sessions and its
private daemon were closed without a close error. The coordinator corrected its
finding that JSON null bindings surfaced a TypeError, and added both reviewer
and worker regression cases. A latent mixed-case effort-suffix mismatch outside
this repair is deferred: the verified installed catalogue uses lowercase IDs.
Raw reports, native output, credentials and runtime state remain outside Git.

## Deployment boundary

The shared Beehive/DMP daemon and operator UI have not been upgraded by this
development run. Updating the accepted runtime and UI is a separate idle
operation; the UI restart button alone reuses its current runtime.
