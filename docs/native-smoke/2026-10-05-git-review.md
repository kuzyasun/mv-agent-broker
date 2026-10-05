# ZCode Git-review smoke, 2026-10-05

Two authorized runs used the configured ZCode Individual reviewer route,
GLM-5.3 at high effort, through an isolated broker daemon. The shared daemon
was not restarted or reconfigured. The fixture was a disposable Git repository
with a source file and a changed binary PNG, not another project's source.

| Mode | Observed result |
| --- | --- |
| Exact committed target | `SUCCEEDED`; report identified source value 2 and the changed PNG |
| Uncommitted target | `SUCCEEDED`; persisted working-tree digest; report identified source value 3 and both new source/binary files |

The registry contained **zero snapshot records** after both turns. The reviewer
used the registered physical checkout; no required full diff was generated.
The private smoke daemon and session were stopped after completion.

This verifies a short native workflow, not review quality or a native sandbox.
The second report incorrectly called the unstaged source edit staged; broker
binding/fingerprint evidence is authoritative, while that classification is
an agent claim. Cursor's generated policy/hook tests passed separately, but
Cursor inference was not run under the operator's ZCode-only restriction.

Local validation covered Git review, dirty drift, alias leases, worktree
provisioning, required inputs and the explicit snapshot-review path. One
existing worktree test failed while spawning its fixture Git process in the
broader run; its exact isolated retry passed. This is not a claim that the
whole repository suite passed in one run.

The longer ZCode clean-path author turn reached its one-hour deadline without
a final report. Its retained code was integrated and verified locally; the
timed-out turn was not reported as successful execution.
