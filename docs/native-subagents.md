# Native subagents in operator routes

The broker coordinates vendor sessions; a vendor can delegate within its own
session. Use a single agent for small tasks and an explicitly selected route for
larger tasks that benefit from independent work. Native delegation can improve
elapsed time; it does not establish lower token or quota consumption.

## Provider mechanisms

| Provider | Documented mechanism | Local evidence |
| --- | --- | --- |
| Antigravity CLI | `invoke_subagent`; built-in `self` and `research`; repository definitions under `.agents/agents/` | Two real child sessions completed through accepted broker `8db50fb` on 2026-10-01 |
| Cursor CLI | Agent definitions under `.cursor/agents/`; explicit model configuration; native delegation | CLI/help/catalog checked; native child execution with an operator-selected model remains pending |
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

## Antigravity smoke evidence, 2026-10-01

The coordinator submitted one bounded worker turn through the public MCP
interface using a source runtime frozen from accepted Git commit
`8db50fb277a5ff09fda750f62a15050ecfe52c4a`. The parent requested
`gemini-3.8-flash-medium` and exactly two built-in `self` children, inherited
workspace/model, no nested delegation, and a five-minute deadline. The fixture
was a separate checkout; the main repository was not the probe workspace.

| Evidence | Observed value |
| --- | --- |
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
