# Cursor 0.2.4 fail-closed hook candidate

Antigravity Gemini 3.8 Flash/high began the package through the public MCP
broker frozen at `8f9d3f3`. Its turn completed, but its handoff only described
waiting for background tests. That report was not accepted as package or test
proof. ZCode Individual GLM-5.3-Flash/max completed the candidate through the
same accepted runtime. An independent ZCode GLM-5.3/high reviewed a sealed
capture against the original Antigravity baseline. The coordinator verified
the actual diff, repaired confirmed issues, and ran offline acceptance checks.
Native workflow completion does not establish descendant quiescence or quality.

## Accepted implementation

Reviewer turns install a trusted standalone Node `preToolUse` script in the
private session HOME. Native configuration has `version: 1` and **flat** command
records, `matcher: "*"`, and `failClosed: true`. The script itself allows only
recognized Read/Grep/List input shapes and denies mutators, shell, MCP, web,
delegation and unknown tools. The completed worker candidate incorrectly used
nested matcher groups; the coordinator corrected that native schema and the
read-only matcher that left other tools outside the gate.

Policy bytes are SHA-256-bound in the command. Workspace and input paths carry
immutable device/inode identities: replaced files and retargeted ancestor
junctions cannot expand a grant. Exact file grants differ from directory grants;
payload cwd supplies no authority. Private exclusions retain precedence without
blanket-denying the broker state root containing legitimate slots/inputs.

Stdin is byte-bounded and decoded as strict UTF-8. Audit records carry fixed
labels, path hashes and opaque call-ID hashes, with bounded file/event/line reads.
Exclusive append locking and verified file handles cap the audit file at 512 KiB
and avoid writing through a swapped pathname. Missing/contended audit receipts
remain absent evidence. Config and audit files remain available after uncertain
execution. Physical temp paths and shell-metacharacter refusals guard commands.

Native tool-call receipts parse flattened protobuf JSON oneofs; arbitrary
result labels and raw call IDs are not persisted. Parser fixtures are synthetic
offline contracts grounded in the installed program, not native tool transcripts.

## Review and validation

The independent review found missing sealed native schema evidence, no pinned
policy hash, inconsistent physical temp handling, and audit/call-ID hardening
issues. The coordinator repaired the implementation issues and independently
found the configuration/matcher and physical grant problems above. The initial
review targeted the pre-repair sealed snapshot; subsequent repairs were accepted
by coordinator inspection and regression checks.

- `npm run typecheck`: passed after final code changes.
- `npm test`: 476/476, 34 files, before the final audit-handle/locking repair.
- `npx vitest run tests/unit/cursor-hooks.test.ts`: 19/19 after that repair,
  including concurrent append cap and the real generated command.
- `git diff --check`: passed.

CLI program inspected: `2026.09.28-64d2043`, native hooks module and executor.
The [official hooks contract](https://cursor.com/docs/hooks) independently
specifies flat command entries and all-tool `preToolUse` dispatch. This is
program/schema evidence, not a retained live hook invocation transcript.

## Remaining boundary

The candidate is **configured**, not a supported restricted reviewer profile.
The earlier [0.2.3 outside-read failure](../2026-10-01-cursor-read-boundary/report.md)
remains recorded. A new accepted-runtime native falsification must establish
actual hook invocation, allowed current input reads, exact denial receipts,
Write/Shell/MCP/web restrictions and clean continuity. Managed tool descendants,
arbitrary external filesystem races and hosted execution domains need their
separate acceptance gates. These hooks do not create an OS security boundary.

The native author/reviewer final reports exceeded the requested 3000-character
handoff limit (3641 and 3224); neither was silently presented as complete test
proof. Both fit the current 4000-character broker summary boundary. Complete
report artifacts and stricter bounded output remain a later package.
