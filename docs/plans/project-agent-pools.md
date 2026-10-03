# Project agent pools and tagged profiles

Status: implemented and accepted in the isolated development worktree. Baseline: `7ea314c`.
Checkpoint: [agent pools acceptance](../native-smoke/2026-10-03-agent-pools.md).
Operator direction: three role pools with tagged profiles; multiple simultaneous
workers, including several sessions from one profile. Benchmarks are deferred.
Disk accumulation control is implemented separately; see [storage control](storage-control.md).

## Outcome and selection

The operator chooses a project, then sees Workers, Reviewers and Researchers.
Each pool contains provider/model/effort profiles with editable human names,
an enabled toggle and tags. Multiple profiles can carry `default`.
The coordinator selects one or more enabled profiles by task, role, tags and
known availability; the broker validates the exact selection and runs it.
No automatic model router, fallback, unique-default constraint or one-agent
limit is introduced. Configured enabled profiles are operator-approved choices
for coordinator selection; enabled is not a security/authorization boundary.
Uncertain execution must be resolved before launching a replacement for the
same mutation. Existing concurrency, quota-scope and physical checkout lease
guards remain in effect: independent writers normally use separate worktrees.
Multiple sessions can use the same profile; a profile is not an execution slot.
Project open-session caps remain. A read-only researcher on a physical current
checkout still uses its existing exclusive lease; independent concurrent work
uses separate checkouts. This package does not change those lease semantics.

## Minimal contract

Keep `routes`, `kind: route`, `route_id` as the internal launch binding already
used by MCP; UI and documentation call these project agent profiles. Pools
are grouping by the existing `role`, not a second registry or scheduling system.

Add three optional configuration fields on OperatorRoute:
- `display_name`: nonempty readable name when supplied; otherwise show the ID.
- `enabled`: boolean, omitted means enabled; false refuses NEW named-profile
  spawns before preflight/provisioning/inference, AFTER committed same-key
  idempotency replay. Existing bound sessions can continue. Check project access
  and route project match first; a foreign-project route remains UNAUTHORIZED.
  Do not include display_name/enabled/tags in the resolved request hash or prompt.
  Replaying an accepted IDLE or PROVISIONING spawn survives metadata edits and
  disablement. Conflicting arguments still conflict. Repeat the enabled admission
  check in the authoritative transaction after its committed replay lookup.
- `tags`: string array, omitted means []; at most 12 unique lower-case tokens,
  each 1–32 chars matching letters/numbers plus hyphen/underscore, beginning
  with a letter or number. `default` and `large` are ordinary coordinator hints.
  Tags never change permissions, model, effort or deadlines.

These are ordinary optional metadata defaults, not migration/legacy formats.
Do not infer tags or enablement from old profile names at runtime.
The `multi-agent` tag is reserved and derived from `native_subagents.mode`
(`prefer` or `auto`). It cannot be independently stored or toggled in tags:
reject ALL stored `multi-agent` tags, even when mode is already prefer/auto. UI shows the derived
tag and edits its existing native-subagent control. Native delegation remains
advisory/unverified, separate from broker-level parallel workers. The limit of
12 applies to stored tags; effective tags can contain 13 with the derived tag.
The tag does not distinguish prefer/auto: the native_subagents field does.

Publish name, enabled and effective tags in every route discovery entry,
including disabled entries for visibility. Disabled named-profile spawn returns
`INVALID_REQUEST` with `execution_started:false`; project authorization still
precedes that check. No persistent session/storage schema change. Raw explicit
spawns retain their existing policy/account validation and can request the same
bindings without route_id. Disabling is a named-profile selection control only;
it must not be presented as account/provider revocation. Pools constrain
coordinator selection through named profiles, not a new native sandbox.
Metadata is not appended to worker prompts; the coordinator consumes it.

## UI

Keep the existing project picker, model catalogue/manual ID entry, effort,
account, policy, subagent controls, save/applied/restart status and button feedback.
Render three pool sections with counts, concise role explanations and per-pool
Add profile. No mandatory researcher entry or new paid readiness/certification.
Profile cards show readable name, provider/model/effort, tags and enabled state.
Expose the technical route ID in advanced details. Allow edit, duplicate, delete,
move role and change project. New reviewer/researcher profiles and project-wizard
copies use an explicitly read-only policy; worker defaults stay project-write.
When switching role, choose a suitable policy or show a clear unresolved choice;
never silently widen reviewer/researcher access. Retain an already suitable
read-only policy; otherwise auto-select only one unambiguous suitable policy,
or require explicit selection. The policy dropdown for these two roles contains
only read-only policies. Config validation also rejects a named reviewer or
researcher profile with a non-read-only policy, so saving through JSON cannot
silently reintroduce the wizard bug. Workers may intentionally be read-only. Do not tighten unrelated worker
policies or advertise these choices as native enforcement.

Offer toggle chips for default/large, custom tag input with validation/help,
and a tag filter that also includes the derived multi-agent tag.
A default tag is a preference, not exclusive selection or a concurrency cap.
A disabled card remains editable and visible; duplication copies metadata but
creates a distinct technical ID. Project wizard preserves names/tags/enablement
when copying and remaps project/policy bindings by role.

## Portions and evidence

1. **Plan acceptance**: independent Cursor `grok-4.7-high/high` read-only review
   through frozen `7ea314c`; coordinator resolves confirmed findings.
2. **Profiles/config/discovery**: native ZCode Individual
   `GLM-5.3-Flash/max` author in a separate clone through the accepted frozen
   broker. Update config, discovery, disabled-spawn admission, documentation and
   examples; tests cover metadata validation/round trip, project isolation,
   disabled zero-preflight/provisioning admission, accepted IDLE/PROVISIONING
   same-key replay after metadata edits/disablement, unchanged argument conflicts,
   read-only named researcher/reviewer validation, and multiple sessions per
   profile on distinct physical workspaces (without bypassing lease guards).
3. **Pools UI**: same coherent author package owns UI and its focused tests.
   Verify actual browser interactions on a separate owned port/config:
   three pools, enabled/default tags, filter, duplicate/move, role policy,
   save/reload, model/effort/subagents preservation, project-wizard copies.
4. **Acceptance and commit**: independent final Cursor review of sealed diff;
   coordinator examines real diff, fixes findings and runs targeted acceptance.
   Full suite at the final integration checkpoint because core admission/UI/
   config consumers change together. Commit accepted portions, no push.

Examples and coordinator/project guides must consistently distinguish profile
selection, simultaneous broker workers and vendor-internal subagents.
Prepare a private enriched candidate of current operator configuration without
changing existing route IDs, provider/model/effort/account/policy IDs, concurrency or grants.
Preserve the shared current config/daemon and active Beehive/DMP jobs; applying
new UI/runtime/settings is a later guarded idle deployment.

## Acceptance boundaries and exclusions

Pass means the selected project's pools and effective metadata are exposed,
editing survives validated save/reload, disabled named profiles cannot create
new sessions, and ordinary parallel routing has no artificial profile occupancy
limit. Existing policies, quota/leases, immutable sessions, unknown/quarantine
and required-input behavior must remain intact. Offline/mock tests demonstrate
broker contracts; browser checks demonstrate UI behavior. Native author/reviewer
success is not native researcher/confinement certification.

No benchmark calls, native capability research, new provider login, automatic
cleanup, forced daemon restart, automatic commit/merge by workers, compatibility
aliases, new MCP tools, cost estimates, memory DB or nested orchestrator.

## Plan review and disposition

Independent Cursor grok-4.7-high/high review succeeded through frozen 7ea314c.
The coordinator inspected the sealed findings artifact
`art-37307354883c3b5e4d636b4f` (3721 bytes, SHA-256
`4127e6b80d1d98d1689e418ef70ecd44f062bd38dcc270e783ab9a5629ecf9d6`).
Both owned sessions closed and the private daemon/bridge completed.
Raw native output remains private.

| Finding | Accepted correction |
|---|---|
| High: disabled guard can block accepted idempotent spawn recovery | Guard after committed replay, before new preflight, and in transaction after replay; exclude metadata from request hashes; IDLE and PROVISIONING regression checks |
| Medium: explicit bindings bypass named-profile enablement | Describe enablement as selection control, not security revocation; keep existing explicit binding authorization |
| Medium: physical researcher lease can block same-checkout writers | Preserve lease/session caps; concurrency acceptance uses distinct checkouts |
| Medium: stored/derived multi-agent tag ambiguity | Reject reserved tag in all stored configurations; 12 stored plus optional derived tag; mode remains authoritative |
| Medium: role change and wizard can assign write policy | Read-only policy choices and validated named reviewer/researcher config; preserve exact existing route IDs in the private candidate |
