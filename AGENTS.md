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

## Worker authorization scope

Ordinary worker authorization covers the ENTIRE project by default. A policy
profile with `access: "workspace_write"` and no explicit `write_scope` grants
the project root (`"."`): source, tests, scripts, documentation, and root
files and directories that do not exist yet. Exclusions for Git metadata,
broker state, and dependency/build caches stay in place.

- Narrow write scope is an explicit operator choice only: set `write_scope`
  in the policy profile or `policy_restrictions` to specific prefixes;
  `[]` denies writes; `read_only` (reviewers) stays read-only.
- Task descriptions, package names, and work-assignment paths NEVER imply a
  file allowlist. Never infer narrow scope from where a worker was told to
  work; only an explicitly configured scope list restricts it.
- This is coordinator-side policy, not a verified native sandbox: mandatory
  native confinement remains unverified and must not be advertised as
  enforced.

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
