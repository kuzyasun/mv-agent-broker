# Local operator settings UI checkpoint

The operator authorized a primitive local UI for project configuration and
worker/reviewer model, effort and native-subagent preferences. The delivered
page edits the existing version-1 JSON config; it adds no database migration,
core orchestration layer, frontend dependency or inference-backed routing.

## Behavior

- `npm run --silent broker -- ui --config PATH [--port NUMBER]` serves a plain
  HTML/CSS/JavaScript settings page on `127.0.0.1`, default port 4318.
- Project-filtered profiles support add, duplicate, rename and delete, configured
  provider/account selection, role and explicit permissions, model/effort and
  advisory native-subagent settings. Shared permissions are displayed rather
  than silently changed when a role is selected.
- New project setup creates fresh project, current/review workspace, coverage
  and separate worker/read-only review policy IDs, plus coordinator permission.
- Advanced accounts, binary pins, state and coverage edits coexist with the
  structured form. MCP JSON and Codex TOML can be copied for the chosen config.
- Reads/writes require a per-process token, expected loopback Host and matching
  Origin when supplied; embedding is denied. Only fixed assets and the selected
  config file are served. The page does not start a daemon or modify its registry.
- Saves validate a clone, retain raw extension fields and relative paths, reject
  stale revisions, preserve exact old bytes in a unique backup, and replace the
  file using a same-directory temporary file. Restart MCP and create new sessions
  to use new route settings; existing session bindings are retained.
- Explicit metadata refresh uses only saved binary pins and the existing vendor
  parsers/program catalog. Cursor fast IDs remain exact; an unspecified effort
  differs from Cursor's literal `none` variant. No login, prompt, inference, task
  launch or quota claim is associated with metadata refresh.

## Native development and review

Author: Cursor requested `gpt-5.6-luna-high` / high through the own broker frozen
from accepted commit `a3ab5d90fcb3b5f125e9565d11b768509cc52175`. Turn
`turn-3e8c8a27e6adb7c03ee139f1`, parent
`adb7430c-a225-43ad-8339-e3819a674d6b`, `SUCCEEDED`. Main integration checked
owned quiescence, allowed paths and the unchanged baseline before copying files.
Two earlier private client setup attempts failed with an unknown workspace
reference before any turn was admitted; both failures were retained, then the
client binding was corrected. No native inference occurred in those attempts.

Independent review: Antigravity requested `gemini-3.8-flash` / medium through
the same accepted frozen runtime, turn `turn-260c13c2906bb599bf78951e`, parent
`6713f0b1-87f9-43c1-93a8-d454566dc8d1`, `SUCCEEDED`, normal owned quiescence.
The source review bound author baseline `snap-cc863847998deeea7d6f8948` to
integrated target `snap-424aed53c3009cf3d1b518cc` and reported no pilot blockers.
Its static claims are not browser or provider-enforcement evidence.

Primary review corrected catalog mapping, unpinned metadata fallback, the
validation regression's unawaited JSON read, provider/account selectors,
advanced edits, separate review policy/slot setup, and missing copy controls.
Later browser acceptance exposed the bootstrap placeholder substitution and
text/input preservation defects; the coordinator repaired both, verified the
actual persisted JSON and rechecked the changed paths. Layout/copy and embedding
headers were finalized with primary checks after the sealed source review.

## Primary acceptance

- Typecheck and JavaScript syntax check passed.
- Six targeted operator files: 20 tests passed. Final changed UI files: seven
  tests passed across two files, including actual HTTP/CLI startup, auth guards,
  schema rejection, exact backup/raw-field preservation, stale external edits,
  explicit catalog reads and actual adapter-compatible model mapping.
- Integrated full offline suite: **790 passed / one platform skip**, 51 files,
  two workers. No real Claude or Codex provider was invoked by these tests.
- Browser acceptance on a private copy of the native operator config: model,
  effort and child preference saved; duplicate renamed and reviewer policy
  persisted; reload succeeded; project setup and coordinator/coverage references
  persisted; advanced draft survived project setup; zero-child count was rejected;
  MCP clipboard text matched the displayed snippet and exact selected config.
- Direct fixture inspection confirmed the original exact backup, extension field,
  model/effort, role/policy, distinct project workspaces and preserved advanced
  state setting. Personal operator settings were not edited by these tests.
- Explicit browser metadata refresh observed 247 Cursor entries, 14 Antigravity
  entries and two supported ZCode models. These are catalogs, not quota or login
  evidence. No paid ZCode task was launched.
- Narrow viewport had no horizontal page overflow; browser console was clear
  after final corrections. Browser verification used the Browser skill.

Private native reports remain under `.state/coordinator/` and `.state/dogfood/`.
Browser fixture/config backups and projected proof remain in `.state/ui-acceptance/`.
The settings page is independent of running MCP: no hot reload, automatic paid
job termination, quota dashboard, hard child cap or registry-conflict inspector
was added. Full provider/platform acceptance and the external-project pilot
remain separate work.
