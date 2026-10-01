# Cursor reviewer configuration checkpoint — 2026-10-01

Antigravity Gemini 3.8 Flash/high implemented this package through public MCP
on frozen commit `27a9eb2`. The worker completed with a sealed source snapshot.
Its capped report contained native progress/task-wrapper text and was not
treated as a complete handoff or test proof. The coordinator inspected the
actual diff, corrected excessive rejection of ordinary path names, preserved
exact input path bytes, and strengthened checks for links in every private
history directory component, including root, sessions and data junctions.

Cursor adapter 0.2.3 separates temporary per-turn permission config from
persistent session-specific HOME/XDG/data directories under managed state.
History survives turns and adapter reconstruction using the same stateRoot;
session IDs become SHA-256 directory names. Windows native authentication
environment remains owned by the CLI. Worker launch behavior is unchanged.

Reviewer config replaces broad Read(**) with explicit workspace/input paths,
requests workspace read boundary and retains Ask mode plus deny rules for
write/shell/web/MCP. Missing workspace or unsafe permission/glob path fails
before dispatch. Cursor thinking text no longer becomes progress events.

Coordinator gates: typecheck passed; 96 targeted tests passed before adding
three junction regressions; full offline suite 426/426 across 32 files passed.
Cursor auto independently reviewed the integrated capture. The coordinator
added guarded EEXIST revalidation and a physical temporary fallback root;
the latter resolves trusted system temp aliases while managed history links
remain rejected. Post-review typecheck and 85 targeted tests passed, including
two new directory-creation/temp-alias regressions. Same-event-loop creation
is synchronous; the EEXIST guard protects an external creation race rather
than proving the reviewer's proposed interleaving on one adapter.
Review and execution identifiers appear in
[sanitized evidence](cursor-profile.evidence.json).

This is configured behavior, not full native enforcement acceptance. Installed
Cursor code feature-gates read boundary; home isolation does not prove removal
of first-party plugins. Real input readability, denial receipts, MCP/network
blocking, config self-repair and clean native continuity remain to be checked.
An earlier broad-read probe accessed broker evidence for its marker, so its
memory proof is explicitly rejected. No real Claude was launched.
