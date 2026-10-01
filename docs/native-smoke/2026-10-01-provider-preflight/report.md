# Provider preflight checkpoint — 2026-10-01

ZCode Individual GLM-5.3-Flash/max implemented the core package through public
MCP on frozen commit `4044b48` (48 committed runtime files). Its worker turn
succeeded. The coordinator repaired recursive policy immutability, rejected
same-version adapter instance replacement, preserved genuine BrokerError
classification and phase, and seeded registered mock accounts in integration
fixtures. The original worker snapshot remains distinct from integrated source.

Spawn now requires a registered matching account, invokes provider preflight
once outside the authoritative transaction, and revalidates account, adapter
and policy observations with pure reads before admission. Accepted idempotent
replay bypasses readiness; rejected preflight consumes no accepted key or
session resources. Sessions bind observed adapter version and registered auth
mode. CLI version and effective model/effort remain unknown.

Execution receives a recursively frozen copy of the validated durable policy
and exact materialized input paths from the sealed manifest. No public MCP
schema or database migration changed. Native CLI/auth/catalog readiness and
native policy enforcement remain separate work.

Coordinator validation: typecheck passed; 87 focused offline tests passed;
full offline suite 387/387 across 31 files. Cursor auto independently reviewed
the integrated capture. The coordinator verified and fixed its two low-severity
findings (name-only error helper and inaccurate adapter-replacement message),
then passed typecheck and 47 targeted tests. Real Claude was not launched.
Review and sanitized execution identifiers are recorded in
[checkpoint evidence](provider-preflight.evidence.json).
