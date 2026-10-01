# Cursor 0.2.6 native clean continuity — 2026-10-01

Accepted runtime: 79496f5097bb523cb0fedb0f20c89c7795d8849e.
Public MCP Cursor auto, independent readonly session, same logical session and
native reference e1103cec-7486-48f9-a3ff-44516c52168a for both turns.

First turn turn-61a098583db3709fc840a74d read retained S1
snap-2945dcbc02b64fc1240b7925. Follow-up turn
turn-659355c69a5d38cd542f77a2 read retained S2
snap-c972be86f8e2964bc1300a5c. Both SUCCEEDED. Follow-up recalled the fresh
UUID memory tag; the tag value was absent from follow-up instructions/task/
artifacts and no native conversation/cache content was read to recover it.
Reports correctly distinguished S1 without physical_bindings from S2 with
physical_bindings and the changed hook command schema. Projection of source
is agent-reported, with typed hook receipts; it is not proof of a complete
restricted reviewer profile. No daemon restart was exercised by this pair.

The first repaired probe remains FAILED, turn-bbd1d239e86d62ddfd868014:
Cursor emitted unable to open database file before reporting. Its private
config was 190 characters, making the native store path 275 characters.
Metadata-only inspection observed the native conversation directory/meta.json
but no store.db; no native file contents were opened. Installed PROGRAM
node_sqlite3.node, exercised against independent owned synthetic databases,
opened a 150-character path (exit0) and refused 275 (SQLITE_CANTOPEN, exit2).
This establishes a Windows path limitation in this installed binding.

A separate new probe used a shorter owned state root under existing .state/jobs/n,
with a fresh session/tag. It consumed native quota explicitly after the root
cause was reproduced offline. Original failed probe and failed author final
capture evidence remain preserved; no status was overwritten. Operational
setup should use a state path that leaves room for chat hashes, native IDs and
SQLite journal suffixes. Path-aware readiness remains part of the planned
readiness/operator portions. Full native model/role/cancel/restart/large-input
acceptance remains separate.

Private retained records:
- FAILED long-state pair: .state/dogfood/2026-10-01T08-09-24-772Z-399c8366/evidence.private.json
- PASSED short-state pair: .state/dogfood/2026-10-01T08-16-14-968Z-59364e1c/evidence.private.json
