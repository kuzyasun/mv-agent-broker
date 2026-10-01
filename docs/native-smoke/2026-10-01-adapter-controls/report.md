# Adapter permission and effort checkpoint — 2026-10-01

Antigravity Gemini 3.8 Flash/high implemented this bounded package through
public MCP on frozen commit `97bc34f` (48 committed runtime files).
The worker turn succeeded with a sealed source snapshot. The coordinator
removed a test-stack-dependent version workaround, updated the obsolete
parser expectation, and isolated temporary-directory tests from other jobs.
Cursor auto independently reviewed the integrated mock capture through the
same frozen broker and reported no blocking findings. The coordinator
inspected the actual diff and accepted this bounded implementation.

Cursor adapter 0.2.2 keeps Ask mode and prepares a unique private reviewer
permission configuration before dispatch, denying write/shell/web/MCP tools
and preserving native auth. Antigravity adapter 0.2.0 requires explicit model,
rejects blank resume IDs and unsupported effort before dispatch, passes
`--effort low/medium/high/max`, and cleans prepared prompts on gate refusal.

Coordinator validation: typecheck passed; 63 targeted fake-process/parser
tests passed; full offline suite 371/371 across 30 files; diff whitespace
check passed. No real Claude CLI was launched. Native development/review
used the old stable adapters; candidate flags and cleanup have offline
coverage, not a complete native profile acceptance.

Separate no-inference Cursor status probes retained native authentication
with private config and with private HOME/USERPROFILE/config/data on Windows.
No credential files were read/copied. Installed CLI code still discovers
home-based MCP configuration; private config alone does not isolate it.
`Read(**)` is broad, native denial/config self-repair remains to be tested,
and Antigravity's permission bypass remains a weak writer profile.

The first architecture-review task was malformed (missing top-level goal)
and failed before inference. Its private evidence is retained. It is not a
provider failure or a completed review.

[Sanitized execution and review evidence](adapter-controls.evidence.json).
Full MVP role/profile acceptance remains open.
