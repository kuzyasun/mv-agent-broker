# Effective write-policy restrictions

This package implements coordinator narrowing and immutable write-scope
checks from spec section 12.1. Native sandbox, tool-network isolation and
reviewer read/search-only enforcement remain separate, unverified work.

The operator's policy profile defines the maximum grant. Spawn currently binds
profile version `1`; this package does not add profile-version selection.
`policy_restrictions` supports:

- `access`: `workspace_write` or `read_only`; a read-only profile cannot be widened.
- `write_scope`: relative path prefixes contained within the operator grant.

For example, a profile allowing `src` and `tests` can be narrowed to
`{"write_scope":["src/core"]}`. Prefix comparison uses path components:
`src/core` does not allow `src/core-old`. Backslashes and leading `./` are
normalized; absolute paths, traversal, empty segments and duplicate normalized
prefixes are rejected. `[]` and `read_only` permit no source writes.

Malformed values and widening requests return `INVALID_REQUEST`. Unknown
restriction keys return `POLICY_UNSUPPORTED`; they are never silently ignored.
Missing or unreadable operator profiles also fail before session admission.
The broker repeats policy derivation inside the admission transaction before
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

For writer workspaces, admission checks source coverage against the effective
scope. After native completion, changes outside that scope produce
`SCOPE_VIOLATION`, without rollback or a successful final snapshot. This detects
source changes; it does not prevent arbitrary native side effects. Reviewer
slots still require the separate native permission package before enforcement
can be advertised.

Validation uses mock adapters and real temporary workspaces. It covers scoped
writes, scope violations, empty/read-only grants, provenance integrity,
idempotency, configuration drift, reconstructed execution, missing legacy
bindings, reviewer corruption after admission and corrupt policy at dispatch.
