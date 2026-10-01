# Provider capability matrix

Per spec §13.1 and ADR-0001/ADR-0002: the operator authorized a limited
Antigravity/ZCode native smoke and then Cursor testing on 2026-09-30.
[Antigravity/ZCode evidence](native-smoke/2026-09-30-antigravity-zcode/report.md),
[Cursor evidence and scope](native-smoke/2026-09-30-cursor/report.md).
Only individually exercised capabilities below are `smoke_tested`; full
platform/adapter/role/profile combinations remain unverified and may not
be advertised as `supported` (§18.1). Claude Haiku model/resume also passed
after native login ([evidence](native-smoke/2026-09-30-claude/report.md)).
Codex Luna/low also passed through an external Node MCP client and separate
bridge/daemon processes ([evidence](native-smoke/2026-09-30-codex/report.md)).

Setup, auth ownership, model/effort rules and limitations for every provider:
[provider operations guide](providers.md).

Current managed Windows transport versions are Cursor 0.2.6, ZCode 0.2.2 and
Antigravity/Claude/Codex 0.2.1. Native smoke rows below retain their original
tested adapter versions; they do not validate a new version-bound profile.
The [Windows supervision checkpoint](native-smoke/2026-10-01-windows-job/report.md)
uses offline owned processes and makes no full native support claim.

Legend — `support`: native | emulated | unsupported | unknown;
`verification`: configured | documented | smoke_tested | failed.

Interface facts for codex/claude-code/cursor/zcode/antigravity are transcribed from the
Fusion repository (C:\projects\fusion, MIT) and local CLI research per ADR-0002 — facts only, no
auto-retry/fresh-session fallback/PTY machinery ported.

## Mock provider (deterministic, no inference)

| Capability | support | verification | notes |
|---|---|---|---|
| explicit native conversation selection | native | smoke_tested | mock ref registry |
| sequential follow-up / resume | native | smoke_tested | mock-level only |
| cancellation/quiescence visibility | native | smoke_tested | interrupt + definite failed outcome |
| structured final output | native | smoke_tested | incl. `complete_malformed` fault case |
| read-only enforcement | n/a | n/a | metadata-only in P1 |
| artifact input delivery | native | smoke_tested | views + manifest since P2-2 |

## codex (adapter 0.2.0, `src/providers/codex/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`codex exec --json`, prompt via stdin) | native | smoke_tested | Windows CLI 0.157.0, existing ChatGPT login, two marker turns; full task envelope after core fix |
| native thread-id + turn completion | native | smoke_tested | thread.started ID captured before completion; native JSONL, no notify/fabricated ID; failures/conflicts tested locally |
| resume (`codex exec resume <thread-id>`) | native | smoke_tested | exact same native ID after first process exits; marker recalled without marker in second stdin |
| model and effort selection | native | smoke_tested | gpt-6-luna/low in both native turn contexts; other models/efforts unverified |
| caller-independent MCP execution | native | smoke_tested | plain Node client -> stdio bridge -> named pipe -> daemon -> Codex; result summary/snapshots and session close passed |
| cancellation (taskkill/SIGKILL tree) | native | documented | common headless infra, unit-tested with node fake CLI |
| structured final output | unsupported | documented | native JSONL transport; report remains text_only |
| effective role sandbox / tool restrictions | unknown | configured | adapter requests worker workspace-write/reviewer read-only; native smoke recorded read-only for worker, no tools exercised; mapping/write-denial unverified |
| native usage interpretation | native | smoke_tested | cumulative turn.completed counters confirmed by rollout last_token_usage; broker usage still unknown |

## claude-code (adapter 0.2.0, `src/providers/claude/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`claude --print --output-format stream-json --verbose`) | native | smoke_tested | Windows CLI 2.1.285, adapter 0.2.0, Haiku 4.5; stdin, default permissions, two successful processes ([evidence](native-smoke/2026-09-30-claude/report.md)) |
| CLI authentication | native | smoke_tested | initial loggedIn=false; operator completed native login; claude.ai/Team profile reused by both adapter processes; no broker token extraction |
| session-id capture (startup hook, init or result) | native | smoke_tested | init/result ID agrees; first startup hook contains same ID before init; final parser early emission verified by offline replay; result-only/conflict paths locally tested |
| resume (`--resume <id>`) | native | smoke_tested | exact ID after first process exits; marker recalled without marker in second stdin; no fresh fallback |
| model selection (`--model <id>`) | native | smoke_tested | claude-haiku-4-5-20251001 in init, assistant and modelUsage both turns; other models and effort not exercised |
| `--settings` hooks (Stop/PermissionRequest) | unsupported | documented | deliberately NOT wired this milestone (§12.5, no hidden prompts) |
| cancellation | native | documented | common infra |
| structured final output | unsupported | documented | text_only |

Native `usage` was per turn; `modelUsage`/cost were cumulative on resume.
User startup hooks can run, although broker hook/permission integration is
unwired. Worker writes, reviewer enforcement and live tool cancellation remain
unverified. Native rate-limit status was allowed; quota rejection was not tested.

## cursor (adapter 0.2.4; model/resume smoke on 0.2.0, `src/providers/cursor/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`cursor-agent --print --output-format stream-json --trust`) | native | smoke_tested | Windows CLI 2026.09.28-64d2043, adapter 0.2.0; stdin over pipes; existing CLI login, default permission mode, no tools ([evidence](native-smoke/2026-09-30-cursor/report.md)) |
| session-id capture (`system/init` → session_id) | native | smoke_tested | init/result UUID agrees; no invented ID; result-only capture and conflict rejection have fake-process tests |
| resume (`--resume <id>`) | native | smoke_tested | exact ID in second process after first exits; marker recalled without marker in follow-up; mismatch rejection is locally tested |
| model selection (`--model <id>`) | native | smoke_tested | gpt-5.4-mini-none; init display name GPT-5.4 Mini None matches catalog; other models and separate effort unverified |
| Windows PowerShell shim launch | native | smoke_tested | shared runner now preserves PATHEXT; Cursor passes Windows profile variables; metadata-only probe reproduces silent exit without PATHEXT |
| Windows cmd shim boundary checks | native | documented | common infra; Cursor native run used .ps1, not .cmd |
| cancellation + inactivity timeouts | native | documented | common infra/fake process cancellation; native tool-tree cancellation and quiescence unverified |
| reviewer outside-read boundary | unknown | failed | 0.2.3 reproduced an outside marker absent from the prompt; [native falsification](native-smoke/2026-10-01-cursor-read-boundary/report.md); restricted profile not supported |
| trusted all-tool preToolUse hook | unknown | configured | 0.2.4 flat native config, pinned policy hash/physical grants and bounded receipts passed offline checks; [checkpoint](native-smoke/2026-10-01-cursor-hooks/report.md); full forbidden-tool/input-paging enforcement remains unverified |
| hook outside-Read denial on 0.2.4 | native | smoke_tested | exact outside-path denial receipt, 7 hook receipts, no marker disclosure; [native probe](native-smoke/2026-10-01-cursor-hooks-native/report.md); limited scenario only |
| private reviewer native continuity on 0.2.4 | unknown | failed | same UUID, S1/S2 readable, fresh memory tag not recalled; per-turn CURSOR_CONFIG_DIR cleanup destroys native chats; [clean probe](native-smoke/2026-10-01-cursor-clean-continuity/report.md) |
| reviewer Write/Shell denial / worker writes | unknown | configured | 0.2.3 config and agent-reported denials; disposable sentinel absent, native denial receipts unavailable; --trust is workspace trust, not enforcement |
| quota-error classification | unknown | configured | four successful requests; quota exhaustion not observed; startup timeout no longer mislabeled RATE_LIMITED |
| structured final output | unsupported | documented | text_only |

Cursor auto ask-mode review delivered its final report through MCP on adapter
0.2.1 ([checkpoint](native-smoke/2026-10-01-dogfood/report.md)). Read/search-only
enforcement remains unknown; report delivery does not promote the role profile.
Scoped outside-read enforcement on 0.2.3 subsequently failed the native marker
probe; this failure remains recorded independently of later candidate repairs.
The [0.2.3 checkpoint](native-smoke/2026-10-01-cursor-profile/report.md) records
offline config/path/history checks. The earlier broad-read private-HOME probe
had contaminated marker recall and remains rejected evidence.

## zcode (adapter 0.2.1; model/resume smoke on 0.2.0, `src/providers/zcode/`) — standalone JSON (ADR-0002 amendment)

| Capability | support | verification | notes |
|---|---|---|---|
| adapter headless (`--prompt --json`, explicit config paths) | native | smoke_tested | Windows, CLI 0.16.9, native login; two Flash adapter turns in plan mode, MCP/memory off; yolo/worker writes/reviewer enforcement unverified ([evidence](native-smoke/2026-09-30-zcode-bootstrap/report.md)) |
| native conversation identity | native | smoke_tested | JSON contains real sess_ ID; adapter emits native_ref_obtained and returns it |
| resume (`--resume <sess_...>`) | native | smoke_tested | adapter wired; first process exits before second; same ID and marker recalled without marker in follow-up; mismatched ID rejected; --continue not exercised |
| model selection | native | smoke_tested | private defaultModelSelection; logs confirm Flash twice; GLM-5.3/Flash on Z.AI Individual; other families rejected; low/high/max accepted, null selects low; reasoning semantics unverified |
| prompt size | limited | documented | argv transport capped at 6000 chars (INPUT_LIMIT) — ENAMETOOLONG open question |
| structured agent report | unsupported | documented | native JSON parsed; response prose stays text_only; usage not returned in broker result |
| app-server NDJSON bus | unsupported | configured | broker integration not implemented; native 0.16.9 protocol/empty-session bootstrap smoke passed, account model selection failed; requires host account/auth contract ([evidence](native-smoke/2026-09-30-zcode-bootstrap/report.md)) |

Individual GLM-5.3/high delivered a static review through MCP on adapter 0.2.1.
Flash/max development produced a partial regression test but its turn timed
out; it is not a successful native worker acceptance. Start Plan model creation
failed on standalone 0.16.9; current adapter rejects that route before dispatch
without account fallback. [Evidence and limits](native-smoke/2026-10-01-dogfood/report.md),
[Start Plan research](zcode-start-plan.md).
Subsequently Flash/max completed the bounded core preflight package through
public MCP; [integrated acceptance](native-smoke/2026-10-01-provider-preflight/report.md)
includes independent Cursor review and coordinator repairs. This establishes
that development scenario, not a full native worker security profile.

## antigravity (adapter 0.2.0; native smoke on 0.1.0, `src/providers/antigravity/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`agy --dangerously-skip-permissions --output-format stream-json --print-timeout 900s -p <prompt>`) | native | smoke_tested | Windows, agy 1.2.1, gemini-3.8-flash-low short resume smoke; larger requested Gemini 3.8 Flash/high MCP task exercised temporary prompt-file fallback and produced source changes ([checkpoint](native-smoke/2026-10-01-dogfood/report.md)); general large-input/full-role limits unverified |
| resume (`--conversation <id>`) | native | smoke_tested | same observed init/result ID in both processes; second prompt omits random marker, response reproduces it |
| conversation-id capture | native | smoke_tested | init.conversation_id observed; alternate nested-field capture remains parser-level only |
| model selection (`--model <id>`) | native | smoke_tested | CLI init.model confirms gemini-3.8-flash-low on both turns; other models/effort unverified |
| separate effort (`--effort low/medium/high/max`) | native | documented | adapter 0.2.0 fake-process mapping/zero-dispatch rejection; effective native reasoning unverified |
| cancellation (taskkill/SIGKILL tree) | native | documented | common headless infra |
| structured final output | unsupported | documented | text_only |

## Platforms

| Platform | Status |
|---|---|
| Windows (dev, native Node) | partial model/resume smoke for all five providers: agy 1.2.1, ZCode CLI 0.16.9, Cursor 2026.09.28-64d2043, Claude 2.1.285, Codex 0.157.0; Codex additionally exercised external MCP caller/bridge/daemon; full worker/reviewer profiles unverified |
| macOS / Linux | unverified |
| Windows via WSL2 | unverified |
