# Operator storage control

Status: implemented and accepted in the isolated development worktree. Accepted base: de7b3f1.
Checkpoint: [storage acceptance](../native-smoke/2026-10-03-storage-control.md).

Expose the existing pin-aware cleanup through operator-only daemon RPC and
HTTP/UI: project selection, minimum retention in days (default 7), preview,
then an explicit confirmed action. Count registered blob bytes, not total
physical state size. Preserve active/open/unknown/recovery/operator pins,
newer artifacts and snapshot file references. No automatic deletion, worktree
or provider-history cleanup, recursive filesystem traversal, storage admission
gate, benchmark or shared-daemon deployment in this portion.

A bounded daemon-memory preview handle (5-minute expiry) binds the exact
project/artifact/blob candidates. Execution checks live authorization, pins,
retained manifests and in-flight publication again. Delete only that preview's
candidates; late orphan blobs remain. Completed handles replay their result
without further mutation. Invalid/expired handles refuse; restart requires a
fresh preview. Audit records counts/project, no token or native content.

Use frozen accepted de7b3f1 for a ZCode GLM-5.3-Flash/max backend author in an
isolated clone. Assignment ownership: operator storage service/RPC/HTTP/tests;
coordinator owns UI assets/docs in its separate worktree. Whole-project worker
authorization remains. Integrate after owned author closure, verify actual diff
and focused cleanup/operator tests, then an independent Cursor grok-4.7-high/high
sealed review and coordinator acceptance. Browser verifies an owned mock state,
never shared-project cleanup. Commit accepted portion; no push/deployment.

Accounting excludes SQLite, slots, inputs, staging, vendor history and native
clones. Unreadable retained manifests/in-flight publication block deletion
and report zero reclaimable bytes while preserving visible registered totals.
The age cutoff uses latest artifact creation/seal time and blob creation time.
Storage pressure rejection/full disk inventory remains a separate scope.

Independent final Cursor review identified abandoned failed-capture staging
blocking all project cleanup and Apply advanced discarding an in-flight cleanup
result. Accepted fixes: include old unpinned staging manifests only when every
same-project capture owner is terminal FAILED; recheck this eligibility and
pins at execution. Preserve failed snapshot/error tombstones. Live CAPTURING,
unknown and protected owners remain blocked. Serialize Apply advanced with
other UI control operations; confirmed results stay attached to their project
even when the form rerenders. Coordinator regression checks cover a real
capture failure, recovery pin acquired after preview, live capture blocking,
and the UI result race. No second paid review was claimed.
