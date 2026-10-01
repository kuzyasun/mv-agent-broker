# Operator setup and named-route checkpoint

The operator asked for a practical MCP pilot, editable worker/reviewer model and
effort settings, and native subagents for larger tasks. P1/P2 now reuse the
existing registry/core/bridge with a versioned JSON operator entrypoint; no
database schema migration or additional admin MCP tool was added.

## Implementation and acceptance

- `src/operator/config.ts`: offline validation, CLI pins, project/account/workspace
  and policy/coverage registration, named routes, transactional application under
  daemon ownership. Bound session resources remain immutable; coordinator ACLs
  remain operator-managed. Credentials are rejected; quota/account labels do not
  switch vendor plans.
- `src/operator/main.ts`: validate, stdio, standalone daemon and MCP client snippet
  commands. `mcp-config --connect` attaches the existing separate bridge instead
  of starting a second owner. Fresh safe input/slot bases initialize on startup.
- Named `route_id` spawn and paged discovery preserve existing explicit bindings;
  route/raw mixtures fail. Models/effort/roles/policies bind at session creation.
  Native subagent preferences are explicit advisory instructions, default off.
- Cursor 0.2.9 compiles catalog model/effort variants consistently in preflight and
  execution, rejects contradictory/unavailable choices, and preserves matching
  exact/fast IDs. It never emits an unsupported separate `--effort` flag or
  silently falls back to auto. Older durable native bindings require replacement
  when revalidation detects the new adapter version.

Primary corrections addressed observed usability/contract gaps: runnable mock
coverage/path settings, correct native sample IDs and paths, actual reviewer slot,
separate-daemon snippets, authorization before route lookup, instruction byte-limit
failure without truncation, ancestor-link refusal, credential rejection, and
canonical JSON comparison for unchanged bound profiles. The coordinator reviewed
the actual diff and supplied regression checks for these corrections.

## Evidence

Author: Cursor `gpt-5.6-luna-high`/high through frozen accepted broker
`f3e5d448c56efabdb341fd17ab21c84785f92014`, turn
`turn-a2baf0e062f38df8fdc68f5a`, native parent
`bd152be9-886f-403d-9ae6-9d5c52a206b8`, `SUCCEEDED`. The author reported typecheck
and 139 focused tests; those claims were followed by primary checks.

Independent source review: Antigravity requested `gemini-3.8-flash-medium`, frozen
accepted broker `78a89733fdecfa643f39ab8a078bbc49811654f2`, turn
`turn-41c8f8dfc7e68a2c9c288deb`, native parent
`9ffbde6f-aeb5-4675-bed7-494124169b62`, `SUCCEEDED`, no pilot blockers reported.
The review bound original baseline `snap-9b57a2ce6b3aad8571722af5` to integrated
target `snap-86f140d5ef8b34d71b16d256`. Its static claims do not establish native
model/confinement enforcement. The later adapter-version bump and documentation
were checked by the primary coordinator.

Primary validation:

- Typecheck passed.
- Targeted integrated checks: 124 tests passed across six files.
- Final full offline suite: 783 passed / one platform skip, 49 files, two workers.
- The supplied mock JSON sample completed an actual Node stdio MCP discover,
  named spawn, send, status and stop on fresh isolated state, with only absolute
  workspace/state path overrides. Turn `turn-b375b35e98ab4878cd25c425`, `SUCCEEDED`.
- Native two-child probes for Cursor and Antigravity succeeded separately;
  [identity/receipt/file evidence](../../native-subagents.md) records their exact scope.
- A fresh Cursor base-model/effort smoke through accepted runtime
  `7928be5ff077e6e9d840419c587621085aae2442` requested `gpt-5.6-luna` plus
  `high`, resolved the catalog variant, and returned `NATIVE_EFFORT_OK` through
  public MCP. Turn `turn-23a28ef0526bde6ac27c0e34`, native parent
  `d4463558-2948-4473-9004-f1b0c14d41a1`, `SUCCEEDED`, normal owned quiescence,
  no provider error. This validates dispatch and response for the requested
  variant, not the provider's internal reasoning effort or child settings.
- The prepared personal operator configuration started successfully and exposed
  all eight named routes through MCP discovery, without native inference. Its
  daemon then closed cleanly. Editable JSON and client snippets are retained
  privately under `.state/operator/`.
- Three longer Antigravity author attempts returned explicit native server 500,
  made no source changes, and retained owned quiescence evidence;
  [incident log](../../pilot-issues.md). There was no silent model fallback.

Private reports and harness evidence remain under `.state/coordinator/` and
`.state/dogfood/`. Personal operator paths/snippets are private configuration,
not repository-distributed credentials or a global Codex configuration change.

## Next

P3 is a real task in another repository using ordinary MCP and the issue log.
Child model/usage attribution, hard child caps, group cancellation, complete
native profiles/platform acceptance, total storage admission and richer event
wait remain deferred. This package does not promote any full mandatory native
profile to supported.
