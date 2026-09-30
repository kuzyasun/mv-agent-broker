# Provider capability matrix

Per spec §13.1 and ADR-0001/ADR-0002: the native spike is **deferred** until
the operator authorizes provider usage. Until then every native capability
stays `unknown`/`documented` and no platform/adapter/role/profile combination
may be advertised as `supported` (§18.1).

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

## codex (adapter 0.1.0, `src/providers/codex/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`codex exec`, prompt via stdin) | native | documented | fusion facts |
| turn-complete + thread-id via `-c notify=[...]` bridge | native | documented | notify.js writes events.log; thread-id = native ref |
| resume (`codex resume <thread-id>`) | unknown | documented | not exercised headless this milestone |
| cancellation (taskkill/SIGKILL tree) | native | documented | common headless infra, unit-tested with node fake CLI |
| structured final output | unsupported | documented | text_only (`last-assistant-message`) |
| read-only enforcement / tool restrictions | unknown | configured | needs spike |

## claude-code (adapter 0.1.0, `src/providers/claude/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`claude --print --output-format stream-json`) | native | documented | fusion facts |
| session-id capture (`system/init` stream event) | native | documented | hook-events parser also transcribed (SessionStart/Stop) for future use |
| resume (`--resume <id>`) | unknown | documented | argv wired; not exercised |
| `--settings` hooks (Stop/PermissionRequest) | unsupported | documented | deliberately NOT wired this milestone (§12.5, no hidden prompts) |
| cancellation | native | documented | common infra |
| structured final output | unsupported | documented | text_only |

## cursor (adapter 0.1.0, `src/providers/cursor/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`cursor-agent --print --output-format stream-json --trust`) | native | documented | fusion plugin facts |
| session-id capture (`system/init` → session_id) | native | documented | parser unit-tested |
| resume (`--resume <id>`) | unknown | documented | argv wired; not exercised |
| Windows shim safety (cmd /d /s /c boundary checks) | native | documented | common infra, unit-tested via node fake |
| cancellation + inactivity timeouts | native | documented | common infra |
| structured final output | unsupported | documented | text_only |

## zcode (adapter 0.1.0, `src/providers/zcode/`) — print-first (ADR-0002)

| Capability | support | verification | notes |
|---|---|---|---|
| headless print run (`node zcode.cjs -p <prompt> --mode yolo --cwd`) | native | documented | feasibility-study facts; bundle path operator-configured |
| native conversation identity | unsupported | documented | print mode returns none — adapter reports "" (broker never fakes native_resume) |
| resume (`--resume`/`--continue`) | unknown | documented | unverified per the study; NOT wired |
| model selection | unknown | configured | CLI-owned via ~/.zcode/cli/config.json; no `--model` flag |
| prompt size | limited | documented | argv transport capped at 6000 chars (INPUT_LIMIT) — ENAMETOOLONG open question |
| app-server NDJSON bus | unsupported | configured | phase-2 per study; not implemented |

## antigravity (adapter 0.1.0, `src/providers/antigravity/`)

| Capability | support | verification | notes |
|---|---|---|---|
| headless turn (`agy --dangerously-skip-permissions --output-format stream-json --print-timeout 900s -p <prompt>`) | native | documented | local CLI research + fusion contract; prompt file fallback >2000 chars |
| resume (`--conversation <id>`) | unknown | documented | argv wired; not exercised headless this milestone |
| conversation-id capture | opportunistic | documented | scanned from top-level or nested result/step_update fields; empty string when absent |
| model selection (`--model <id>`) | native | documented | passed verbatim from request or default model |
| cancellation (taskkill/SIGKILL tree) | native | documented | common headless infra |
| structured final output | unsupported | documented | text_only |

## Platforms

| Platform | Status |
|---|---|
| Windows (dev, native Node) | dev-only; adapters carry Windows shim handling but unverified with real CLIs |
| macOS / Linux | unverified |
| Windows via WSL2 | unverified |
