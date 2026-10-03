# Independent Windows settings UI launcher

Accepted author baseline: `e114efe`. This portion adds a launcher and operator
documentation; it adds no MCP tools, dependencies or daemon/provider behavior.

## Behavior

`scripts/start-ui.ps1` uses Windows PowerShell 5.1 and hidden
`Win32_Process.Create` to start only the UI from the recorded accepted runtime.
Relative `state_dir` is resolved against the config directory. Config-path and
runtime-manifest identity are checked; occupied ports are refused.

Success requires the launched process to own the loopback listener and serve
HTTP 200 within ten seconds. Failure produces no success receipt and stops only
the still-identified process started by this invocation. One credential-free
`operator-ui-<port>.json` sidecar and a JSON receipt use snake_case fields and
UTC creation identity. Stale sidecar PIDs do not reserve ports.

No daemon start/stop, inference, service supervisor or autostart is introduced.
Windows restart still ends the process; a new launcher invocation is required.

## Native development and independent review

Antigravity `gemini-3.8-flash` / `medium` authored the script through frozen
`e114efe` in an isolated checkout. Turn `turn-45313acfeef7ffc3cea39abe`
succeeded; private session/daemon cleanup passed. Evidence: dogfood
`2026-10-03T02-29-21-871Z-d36c6098`.

ZCode Individual `GLM-5.3` / `high` independently reviewed the original
baseline and exact sealed author target through frozen accepted `661d1b4`.
Turn `turn-553ad2b44f0ae0b25901afc8` succeeded; private cleanup passed.
Evidence: dogfood `2026-10-03T02-38-48-477Z-1d15fe92`.

The coordinator removed duplicate sidecars/compatibility aliases, removed the
false port-ownership check based only on a saved PID, and added listener/HTTP
verification to address the review's startup-observation limitation. Final
repairs were inspected and exercised locally by the coordinator.

## Coordinator verification

An owned fixture on port **4319** used a separate config/state and accepted
runtime `661d1b4`. Shared port **4318** and its daemon were not changed.

- Windows PowerShell 5.1 AST parsing passed.
- Launch returned JSON; the UI remained alive after its launching command
  exited. Its observed parent was `WmiPrvSE.exe`, independent of Codex.
- Paths with spaces, config-relative `state_dir`, explicit Node path and Node
  selection from `PATH` passed. HTTP root/config/status returned 200; the
  intended empty fixture configuration matched and daemon status was stopped,
  PID zero. No inference started.
- A sidecar naming an unrelated live PID did not block a free port.
- Repeating launch on the occupied port refused with `PORT_ALREADY_OWNED`.
- A different config path refused with `CONFIG_IDENTITY_MISMATCH` before launch.
- A config rejected by the actual UI validator exited nonzero with
  `UI_START_FAILED`, without a success receipt or surviving fixture process.
- Final diff and whitespace checks passed. Fixture process cleanup required
  exact PID, creation time and command identity; no shared process was stopped.

This is real local Windows process/HTTP evidence, not a native-provider
confinement test. Actual Codex shutdown and Windows reboot were not repeated;
survival across Codex shutdown is supported by observed WMI process ownership.
The fixture used UTF-8 configuration without BOM. This launcher requires an
already accepted runtime and does not repair invalid configurations.

Private transcripts, config, sidecars and HTTP tokens remain outside Git.
The shared runtime stays on `e1ef4e6`; applying new code is a separate idle update.
