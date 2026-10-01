# Native subagents in operator routes

The broker coordinates vendor sessions; a vendor can delegate within its own
session. Use a single agent for small tasks and an explicitly selected route for
larger tasks that benefit from independent work. Native delegation can improve
elapsed time; it does not establish lower token or quota consumption. Route IDs
are editable profile names; a
`*_large` suffix is only a convention.

## Provider mechanisms

| Provider | Documented mechanism | Local evidence |
| --- | --- | --- |
| Antigravity CLI | `invoke_subagent`; built-in `self` and `research`; repository definitions under `.agents/agents/` | Two real child sessions completed through accepted broker `8db50fb` on 2026-10-01 |
| Cursor CLI | Agent definitions under `.cursor/agents/`; explicit model configuration; native delegation | Two child sessions completed through frozen broker `f3e5d44` on requested Luna/high; large-task model remains operator-configurable |
| ZCode | No verified configuration or native child execution in this package | Unknown; continue using explicit broker worker/reviewer sessions |

Sources: [Antigravity custom subagents](https://antigravity.google/docs/subagents?tab=cli),
[Cursor subagents](https://cursor.com/docs/subagents),
[Cursor CLI parameters](https://cursor.com/docs/cli/reference/parameters).

Model and effort select the parent session. Vendor child configuration can have
separate defaults. Do not infer the children's actual models or effort from the
parent's requested settings. The installed CLIs expose no verified flag for a
hard child count limit; a requested mode/count is advisory unless separately
enforced and tested. Native children share vendor context and permissions;
they do not replace an independent broker reviewer of a sealed target snapshot.

Operator routes expose three native-subagent modes. `off` requests one agent,
`prefer` suggests independent native children and carries a positive
`max_agents` advisory, while `auto` lets the agent decide whether delegation
is useful and lets the vendor choose the number of children. `auto` carries no
numeric count and none of these settings enforce child count, models, or
permissions. There is intentionally no `zcode_large` preset: ZCode native
children are not verified, although a ZCode worker can still implement a large
task.

## Antigravity smoke evidence, 2026-10-01

The coordinator submitted one bounded worker turn through the public MCP
interface using a source runtime frozen from accepted Git commit
`8db50fb277a5ff09fda750f62a15050ecfe52c4a`. The parent requested
`gemini-3.8-flash-medium` and exactly two built-in `self` children, inherited
workspace/model, no nested delegation, and a five-minute deadline. The fixture
was a separate checkout; the main repository was not the probe workspace.

| Evidence | Observed value |
| --- | --- |
| Installed Antigravity CLI | `1.2.14` (`agy.exe --version`, checked in this run) |
| Broker turn | `turn-a3850f842af7ebb3994dd1c4`, `SUCCEEDED` |
| Parent native conversation | `8bb8bca6-a7a9-4c0e-9d5a-96822bd2e76e` |
| Child A | `0b5de7c6-c8b6-499f-8654-d5d8028f73c2` |
| Child B | `0570afb0-3a21-4bc7-8604-173772d46286` |
| Numeric fixture | `17 23 41` produced independently checked `81` |
| Word fixture | `amber birch cedar` produced independently checked `cedar birch amber` |

The declared final report was retrieved through `agent_artifact_read` after a
daemon restart without inference. Both child conversation databases existed,
had distinct trajectory IDs, and their conversation IDs occurred in the owned
parent's native tool payloads. Only identity/link metadata and numeric step
counts were projected; private thinking was not published. Both result files
were checked directly, rather than accepting the parent's report alone.

Private evidence remains under `.state/coordinator/subagent-probe-repo/`:
`antigravity-probe-report.private.json` and `subagent-proof.private.json` in its
`.state/coordinator/` directory, plus the dogfood turn evidence. This is local
smoke evidence, not a general permission/confinement acceptance result.

Still unknown: actual child model/effort, exact parallel overlap, child quota
attribution, cancellation of a running parent and all descendants, failure
propagation, and enforcement of an advisory child cap. Those are deferred
until an observed workflow problem requires them.

## Cursor smoke evidence, 2026-10-01

The coordinator used a separate fixture checkout, CLI
`2026.09.28-64d2043`, and frozen accepted broker
`f3e5d448c56efabdb341fd17ab21c84785f92014`. The parent and both repository
agent definitions explicitly requested `gpt-5.6-luna-high`. High effort was
encoded in the catalog model ID; this probe does not establish separate
effort-field mapping on the historical adapter. No `auto` model was requested.

| Evidence | Observed value |
| --- | --- |
| Broker turn | `turn-89226ac533caeed8d428c9e4`, `SUCCEEDED` |
| Parent native conversation | `5a892d2e-e6cb-4b21-acd5-98a2ecb7ddc0` |
| `alpha-worker` child | `0f736941-ed45-490d-9e44-b1edd1d108ff` |
| `beta-worker` child | `c1e7058f-0e4e-45e6-9b36-e3974a7da6a5` |
| Successful native task receipt call IDs | `929e666d625d1afadfc0d50fb5305dfc`, `1e6ba5e9149abde427dc77822bf902fe` |
| Numeric / word outputs | Independently checked `81` and `cedar birch amber` |

Each child had a distinct native chat store and transcript for the exact fixture
workspace. The two successful task receipts were projected from broker events.
Only safe identity/model metadata was extracted from the owned native records;
private thinking was not published. The completed declared report was retrieved
through public MCP artifact paging after daemon restart without inference.

Private evidence: `.state/coordinator/cursor-subagent-probe-repo/`, including
`cursor-probe-report.private.json` and `cursor-subagent-proof.private.json`
in its `.state/coordinator/` directory. The parent named the native tool
`cursor.Subagent`; the broker's sanitized receipt class is `task`.

Actual child model metadata was absent from the projected transcript fields;
the configured model and parent's report remain requests/claims. Child usage,
parallel overlap, a hard child cap, group cancellation, and reviewer subagent
permission inheritance remain unverified.
