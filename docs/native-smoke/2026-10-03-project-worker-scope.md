# Whole-project worker defaults

## Accepted behavior

An ordinary `workspace_write` policy without `write_scope` grants the project
root (`"."`), including future root files and directories. Explicit arrays are
operator-selected restrictions; `[]` denies writes. Task paths are guidance,
not inferred permission allowlists. Reviewer policies stay read-only.

Coverage prefixes accept the project-root selector, while actual file paths
still reject root, absolute and traversal paths. Root source coverage allows
explicit cache exclusions; other contradictory classes remain rejected.
The UI recommended preset emits root coverage, omits worker `write_scope`, and
excludes known output folders even before they exist. Rules, examples and the
self-development harness use the same default. Stored bindings already contain
explicit normalized scopes, so no new binding format or migration is needed.
Existing captured grants do not silently widen.

## Evidence and coordinator acceptance

ZCode Individual `GLM-5.3-Flash` / `max` authored the package through frozen
accepted broker `700449a` in an exclusive checkout. Its turn finished
`SUCCEEDED`, execution started, and its private session/daemon were closed.
Private author evidence: dogfood `2026-10-03T00-38-31-810Z-c923f86a`.

The coordinator removed an unnecessary binding-version bump, covered future
cache folders, restricted the root-exclusion exception to source coverage,
and clarified coordinator instructions. A fresh mock target was reviewed
against the original author baseline by ZCode Individual `GLM-5.3` / `high`
through frozen `7f82390`. Review finished `SUCCEEDED` with no blockers;
private cleanup succeeded. Private review evidence:
dogfood `2026-10-03T01-23-19-749Z-0963ab38`.

Coordinator verification:

- Typecheck passed. Updated mock and Windows examples validated.
- Focused policy/coverage/config/UI checks passed: 82 tests, with the corrected
  binding expectation verified by a separate 34-test policy run.
- Final full suite: 61 files passed, 873 tests passed and one platform skip,
  258.41 seconds. JavaScript syntax and `git diff --check` passed.
- Mock worker created a previously undeclared root directory and root file,
  with a sealed successful snapshot; read-only and excluded writes failed.
- Isolated browser UI on 4319 saved a project containing only `README.md`:
  worker policy omitted `write_scope`, source coverage was `["."]`, and 16
  output exclusions included nonexistent caches. Preview tab/server were closed.
- A private configuration candidate for Agent Broker, Beehive and DMP applied
  to an online registry copy, preserving all 20 historical sessions and their
  policy rows. Provider/model/effort/subagent selections were unchanged.
  The live configuration was not changed by this test.

Review noted inherited handling of manually entered whitespace prefixes and
an unused `absent` union variant; both are deferred. The UI trims entries.
Mandatory native confinement remains unverified. Excluded subtrees are
observed only at their top level; this package does not add recursive policing.

## Shared runtime and restart checkpoint

At the operator's request, the separately accepted operations/Cursor portion
was applied to the shared daemon and UI as `7f82390`. Authenticated status
confirmed READY and matching saved/applied settings. The guarded upgrade
preserved configuration bytes, backed up the registry, and launched no inference.
Both project route lists were complete, and the real UI catalogue refresh
returned 246 Cursor entries without changing the selected model.

This whole-project portion is committed only in the isolated development
worktree; it is not yet applied to the shared runtime or its project policies.
Resume by integrating primary `master` (`7f82390`) into this development branch,
checking the combined Cursor changes, and applying the prepared project policy
candidate only during a guarded idle update. Recheck its source config hash
first so intervening operator model edits are preserved. New policy/coverage/
workspace IDs preserve existing session evidence; coordinators must select the
new root-covered workspaces when starting sessions with these new grants.

The operator requested a pause for restarting Codex after the current agents
finished. There are no remaining native runs owned by this portion. Private
runtime evidence and the configuration candidate remain outside Git.
