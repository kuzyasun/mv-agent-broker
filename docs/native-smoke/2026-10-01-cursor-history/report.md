# Cursor private chat storage checkpoint — 2026-10-01

Cursor adapter 0.2.6 keeps reviewer `CURSOR_CONFIG_DIR` under its physical
session directory. Installed PROGRAM 2026.09.28-64d2043 stores conversations
under this root, keyed by the resolved workspace path and native reference;
`CURSOR_DATA_DIR` alone does not preserve them. Previous per-turn configuration
cleanup destroyed native memory even though resume returned the same reference.

Each turn has a separate immutable policy/audit directory. Success removes only
that directory; known failures retain evidence without blocking the next turn.
Typed `EXECUTION_UNKNOWN` retains bindings and blocks configuration refresh.
The in-memory owner stays blocked even if the extra disk marker cannot be
written; the core's durable unknown execution record remains authoritative.
The adapter does not clear unknown markers or provide reconciliation itself.

Resume checks only owned path metadata, never conversation contents. Unsafe
native path components, linked ancestors and absent/nonregular stores are
refused before dispatch. Overlapping invocations, including the same turn ID,
cannot overwrite configuration. Existing adapter-version drift checks refuse
old contexts; no native history migration or fresh-resume fallback is provided.
Worker behavior and explicitly bound worker command approval are unchanged.

## Retained native provenance

Authoring and independent review used public MCP through immutable accepted
runtime `cd2eed0a60ec2b3ce2b6465daa049002827aeff7`.

Cursor auto author `turn-f1620e385cad88a87b79562f`, native reference
`b0d9ffdf-c8d5-48db-ac01-9a2168212a95`, completed inference and edited the
declared source. Its broker outcome remains **FAILED**: final capture rejected
three undeclared Windows cache files under literal `%SystemDrive%`.
No accepted final snapshot was fabricated from this failed turn.

The scrubbed subprocess/helper environments omitted structural `SystemDrive`.
The coordinator added case-insensitive preservation with a SystemRoot-derived
fallback and removed only the verified literal temporary directory inside this
repository after the managed turn ended. Owned fake subprocess tests check
actual inherited values and continued omission of an unallowlisted secret.
The exact Windows component creating those cache files was not identified.

Gemini high independently reviews integrated sealed capture
`snap-735c70d875f247d2bd73b776` against the original author baseline;
review turn `turn-1af11981ca6663e678b8c3ca`, native reference
`3917027d-07ec-4ff9-8405-c6deb16668eb`, succeeded. The coordinator confirmed and
repaired traversal/ancestor checks and marker-write failure handling. A dangling
unknown marker now blocks both roles, including reconstructed adapters.

The suggestion to add a second filesystem ownership lock was not adopted:
the public broker serializes the immutable role/session under its single daemon
owner; independent direct adapter instances are not a supported concurrent
ownership interface. Adapter-local locking adds a guard within that contract;
it is not advertised as cross-process exclusion. Native workspace cleanliness
still needs a fresh real invocation after the environment repair.

## Validation boundary

Coordinator typecheck and the initial focused suite passed: 120 tests, one
platform skip. Additional concrete repairs passed ten focused cases covering
same-ID overlap, unknown marker write failure, immutable policy replay, unsafe
native references and linked chat-store ancestors.

The integrated full offline suite then passed 531 tests with one platform skip
across 37 files. After the final dangling-marker/all-role guard, typecheck and
11 targeted regression cases passed. The full suite was not repeated after
that final narrow repair.

The synthetic native-history fixture preserves an earlier marker across turns
and adapter reconstruction without injecting it into the follow-up prompt.
These offline tests do not establish current-version native memory recall,
daemon restart conformance or a complete restricted reviewer profile. A fresh
controlled native continuity pair is required; the earlier failed 0.2.4 pair
remains historical evidence.
