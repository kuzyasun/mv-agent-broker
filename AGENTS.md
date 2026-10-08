# Agent Broker development rules

## Pre-release scope

This project is under active development and has no released version. Backward
compatibility is **not a requirement** unless the operator explicitly requests it
for a specific change.

- Prefer the simplest implementation that makes the current workflow work.
- Change APIs, configuration schemas, profiles, defaults, names, and file formats
  directly when that improves the design. Update the active configuration,
  examples, documentation, and relevant tests together.
- Do not add migration layers, legacy parsers, compatibility aliases, fallback
  branches, deprecation periods, or tests solely to preserve an old interface.
- Existing development configurations can be replaced or regenerated. Do not ask
  for approval merely because a change breaks an earlier development format.
- Prioritize a usable MCP broker, clear configuration, and token economy. Defer
  rare recoverable edge cases until an observed problem justifies the work.

## Trusted local execution

The operator trusts the agents running locally. Permissions have only two
levels: `read_only` and `workspace_write` for the entire project. Task paths,
package assignments and `relevant_paths` are guidance, never file allowlists.

Ordinary current/worktree tasks and reviews require no snapshots, source
coverage, Git bindings or source-digest checks. Native completion is execution
success; the coordinator owns acceptance and final review. Do not recreate
file-scope, workspace-drift or catalogue-fingerprint guards as workflow gates.
Manual snapshots and explicit snapshot review slots are optional advanced tools.

Keep actual project/session authorization, selected provider/model/effort,
owned-process cancellation, quotas/deadlines and serialization of writers in
the same physical checkout. Read-only turns do not freeze shared files and do
not take an exclusive writer lease. Native confinement is unverified and must
not be advertised as an enforced OS sandbox. Sessions can be closed and created
again on the same authorized profile without preserving old development APIs.

## Self-development

Use a copy of the last accepted broker commit to run authorized native workers
and reviewers. Give native authors an isolated checkout; the coordinator must
not edit their workspace while a turn is running. The coordinator inspects the
final diff and verifies the relevant checks. Commit completed portions when the
operator has authorized commits.

Keep credentials, private provider output, and local runtime evidence out of Git.
Do not discard unrelated user work or terminate active paid jobs as part of a
configuration cleanup.

Reply to the operator in Ukrainian. Keep code, documentation, and commits in
English.
