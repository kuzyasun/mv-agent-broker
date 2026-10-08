# Trusted local agent workflow

Operator direction, 2026-10-08: trusted agents run on the operator's machine.
The broker provides execution, not automatic acceptance of code. Sessions may
be discarded and created again; preserving historical development interfaces
is not a requirement.

## Ordinary workflow

1. Discover allowed projects and configured profiles.
2. Spawn on an existing physical checkout or broker-created worktree. Access is
   `read_only` or `workspace_write` for the project. There is no file allowlist.
3. Send `{session_id, idempotency_key, task}`. No snapshot, coverage selector,
   review binding, full commit ID, or source digest is required.
4. Wait for the turn and read the retained report. Native completion is
   execution success; quality/acceptance remains the coordinator's decision.
5. Reuse an idle session or close it and spawn again on the same profile.

## Implementation

- Remove automatic initial/final source snapshots and scope/coverage gates from
  physical session execution. Explicit local snapshot capture remains a manual
  diagnostic tool, outside task admission and completion.
- Remove physical snapshot/Git binding variants from the task-send API. Keep
  `review_binding` only for an explicitly chosen manual `review_slot`. Physical reviewers
  use Git directly. Instructions can name a commit or intended files without
  imposing a separate broker evidence protocol.
- Simplify permissions to access only; derive whole-project write or read-only
  directives. Remove file-scope controls from MCP/UI and current examples.
- Remove immutable readiness fingerprint comparisons at send/dispatch. Perform
  one current adapter preflight at dispatch; retain real auth/model/CLI errors
  and do not substitute providers, models or effort.
- Keep project/session authorization, selected profile identity, valid cwd,
  idempotency, quota/deadline limits, ownership of spawned processes and
  writer-vs-writer checkout serialization. Readers take no exclusive writer lease. Read-only instructions are not a
  guaranteed native sandbox. They do not freeze files against external editors.
- Preserve reports independently of optional workspace observations. Never
  require source evidence capture to turn native completion into success.
- Update coordinator docs, Beehive instructions and MCP descriptions together.

## Acceptance

Mock/integration cases: plain write/read-only/reviewer sends with no bindings,
no coverage and no generated snapshots; manual external edits during a read-only
turn retain successful native output; concurrent writers on aliases conflict;
metadata drift does not require replacement session; actual provider errors,
quota pauses, deadlines, owned cancellation and duplicate request replay remain.
Recovery must follow the same completion semantics without new inference.
Run relevant tests/typecheck and independent review before committing. Native
smoke, when used, is bounded and uses only operator-authorized providers.

Shared runtime deployment uses a frozen accepted commit, config/database backup,
a guarded stop and live MCP/UI verification. Do not terminate active paid jobs.

## Observed validation (2026-10-08)

- TypeScript and UI type checks passed; UI regenerated with project tooling.
- Independent Luna high review completed. Its read-only worker adapter finding
  was fixed for Codex and Cursor and covered by adapter regressions.
- New stdio and trusted-turn regressions: 5/5; frozen-runtime advanced snapshot
  harness: 22/22. The harness now pins the accepted implementation commit `060a556`.
- Real isolated ZCode worker (`GLM-5.3-Flash/max`) and physical read-only reviewer
  (`GLM-5.3/high`) both returned the requested smoke marker with `SUCCEEDED`,
  `unreviewed`, and no baseline/target/final source snapshots. This proves the
  plain transport path, not full provider confinement or review quality.
- Provider output, SQLite and detailed runtime evidence remain outside Git.
- Final complete suite: 930 passed, 1 skipped, zero failures.
