# Effective write-policy restrictions

This package implements coordinator narrowing and immutable write-scope
checks from spec section 12.1. Native sandbox, tool-network isolation and
reviewer read/search-only enforcement remain separate, unverified work.

The operator's policy profile defines the maximum grant. Spawn currently binds
profile version `1`; this package does not add profile-version selection.
By operator rule, a `workspace_write` profile WITHOUT `write_scope` grants the
whole project root (`"."`), including files and folders that do not exist yet;
the operator UI's recommended preset pairs it with a root coverage profile
that excludes generated folders. An explicit `write_scope` array remains a
deliberate restriction, and `[]` denies every write. Narrow scope is never
inferred from task descriptions or work-assignment paths.
`policy_restrictions` supports:

- `access`: `workspace_write` or `read_only`; a read-only profile cannot be widened.
- `write_scope`: relative path prefixes contained within the operator grant.

For example, a profile allowing `src` and `tests` can be narrowed to
`{"write_scope":["src/core"]}`, and a scope-less profile can be narrowed to
any project prefixes. Prefix comparison uses path components: `src/core` does
not allow `src/core-old`. The project-root prefix `.` is a valid prefix that
matches everything inside the workspace. Backslashes and leading `./` are
normalized; absolute paths, traversal, empty segments and duplicate normalized
prefixes are rejected. `[]` and `read_only` permit no source writes.

Malformed values and widening requests return `INVALID_REQUEST`. Unknown
restriction keys return `POLICY_UNSUPPORTED`; they are never silently ignored.
Missing or unreadable operator profiles also fail before session admission.
The broker calls provider preflight once outside the admission transaction,
then repeats pure account, adapter and policy checks inside it before
reserving resources or recording an accepted idempotency key. Reusing that key
with different restrictions returns `IDEMPOTENCY_CONFLICT`.

The existing provision intent stores the captured profile configuration, its
SHA-256 fingerprint, requested restrictions and normalized effective grant.
Admission and execution read and validate that same binding, including after
reconstructing the broker. Editing a live profile does not alter existing
session grants. Stop and replace sessions when an operator changes their
permissions; new sessions receive the new configuration.

A missing legacy binding cannot prove which historical restrictions were
requested. Further turns return `POLICY_UNSUPPORTED` and require a replacement
session. Existing history and native conversation references remain stored;
there is no automatic migration or native-context import. Malformed bindings
also fail closed. The executor checks policy before input preparation and again
inside dispatch permission. Caller-contract corruption retains the established
`INPUT_DELIVERY_FAILED` classification.

Adapters receive a recursively frozen defensive copy of the durable grant
and a frozen list of exact materialized input bindings from the sealed manifest.
These internal fields convey authority; they do not establish native enforcement.

For writer workspaces, admission checks source coverage against the effective
scope; the default whole-project scope therefore requires a root coverage
profile (`source_prefixes: ["."]`). Coverage classification still honors
exclusions first: explicit exclusions may carve Git metadata, broker state and
generated folders out of the root source, and writes into them fail the turn.
After native completion, changes outside that scope produce
`SCOPE_VIOLATION`, without rollback or a successful final snapshot. This detects
source changes; it does not prevent arbitrary native side effects. Reviewer
slots still require the separate native permission package before enforcement
can be advertised.

Bindings already record explicit normalized scopes, so the binding shape stays
unchanged. New sessions pick up the updated project policies after the operator
applies them; an existing session does not acquire a wider grant from a profile
change.

Validation uses mock adapters and real temporary workspaces. It covers scoped
writes, scope violations, the whole-project default grant (including writes to
previously undeclared root entries), empty/read-only grants, provenance
integrity, idempotency, configuration drift, reconstructed execution, missing
legacy bindings, reviewer corruption after admission and corrupt policy at
dispatch.
