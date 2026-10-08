> Historical implementation plan. Superseded on 2026-10-08 by the
> [trusted local workflow](trusted-local-workflow-plan.md): ordinary reviewers
> read checkout files and Git directly with a plain task send. Commit/digest
> bindings and automatic source-state vetoes described below were removed.

# Git review

## Default workflow

1. Finish the author's turn and inspect its actual changes.
2. Spawn a separate reviewer profile with a read-only policy in the author's
   registered `current` or `worktree` workspace. Reuse that workspace's mode
   and ID; a branch name alone is not a registered folder.
3. Send `git_review_binding` with full base and target commit IDs. The
   checkout's HEAD must equal the target. Set `include_working_tree: true`
   for staged, unstaged and nonignored new files. Both IDs can be HEAD when
   reviewing only uncommitted work.
4. Pause edits until the reviewer finishes. Read its report and inspect any
   findings yourself; execution success does not prove review quality.

The reviewer reads files and uses Git in that folder. The broker supplies
compact commit IDs and command guidance, not source copies, snapshots or a
mandatory full textual diff. Binary files therefore do not block dispatch.
For uncommitted review, the broker records a local fingerprint of HEAD,
index and file contents and checks it before dispatch and after completion.
A changed target is rejected rather than reported as a successful review.
Ignored files are outside that working-tree identity; generated caches should
be ignored. Clean initialized submodules are supported; uncommitted content
inside a submodule is not supported by this mode.
Register the Git checkout root, not a folder inside it. Clean-commit review
also refuses index flags that hide edits (`assume-unchanged`, `skip-worktree`);
working-tree review hashes actual contents independently of those flags.

## Same folder or a separate worktree?

Use the same folder for a sequential author → review → fix cycle. Broker
turns hold an exclusive lease on the physical checkout, including aliases.
The lease cannot stop external editors or processes: the coordinator must
pause those writes. Read-only policy is not proof of a native OS sandbox.

Use a separate reviewer worktree at the exact committed target when the
author needs to keep editing in parallel. The broker never stages, commits
or switches the author's checkout for review.

Explicit snapshot review (`review_slot` plus `review_binding`) remains useful
for non-Git sources. Snapshot capture stores source locally and performs no
inference. A provider run may read source through its own CLI; choose that
provider according to the project's authorization.

See [coordinator examples](examples/coordinator/README.md) and
[coordinator instructions](coordinator-instructions.md).
