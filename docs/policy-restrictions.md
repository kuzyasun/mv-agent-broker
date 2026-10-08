# Access for trusted local agents

Ordinary policies have one field: `access`, set to `read_only` or
`workspace_write`. Write access covers the whole project, including source,
tests and documentation. `relevant_paths` and assignments are guidance, not
file allowlists. The previous `policy_restrictions` and `write_scope` public
fields were removed during pre-release simplification on 2026-10-08.

A profile sets the maximum access. At spawn, `access: "read_only"` narrows a
write profile for an audit. A read-only profile cannot grant write access.
The selected access is captured for that session; settings changes apply to
new sessions. Close and recreate a session when its settings need changing.

Physical tasks use `{session_id, idempotency_key, task}`. There are no required
snapshots, source-coverage or digest guards. Completed native execution is
`SUCCEEDED`; acceptance remains the coordinator's responsibility.

The broker serializes writers in the same physical checkout. Read-only sessions
may share it with editors or writers and do not certify unchanged source.
Native confinement is unverified; configured access is not an OS sandbox claim.
Adapters use available native read-only controls and explicit task instructions.
See [coordinator workflow](coordinator-instructions.md).
