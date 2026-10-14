#!/usr/bin/env bash
# start-ui.sh - Launch the Agent Broker Operator UI on macOS / POSIX
set -euo pipefail

PORT=4318
CONFIG_PATH=""
NODE_PATH=""

print_usage() {
  cat <<EOF
Usage: start-ui.sh --config <path> [--port <number>] [--node-path <path>]

Options:
  --config PATH        Path to operator.json configuration file (required)
  --port PORT          Port to bind the UI to (default: 4318)
  --node-path PATH     Path to Node.js binary (default: search PATH)
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --config|-c)
      CONFIG_PATH="$2"
      shift 2
      ;;
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    --node-path)
      NODE_PATH="$2"
      shift 2
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CONFIG_PATH" ]]; then
  echo "Error: --config is required." >&2
  print_usage >&2
  exit 1
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "CONFIG_NOT_FOUND: Config file not found at '$CONFIG_PATH'." >&2
  exit 1
fi

# Resolve absolute path of config file
RESOLVED_CONFIG="$(cd "$(dirname "$CONFIG_PATH")" && pwd)/$(basename "$CONFIG_PATH")"
CONFIG_DIR="$(dirname "$RESOLVED_CONFIG")"

# Resolve Node.js binary
if [[ -z "$NODE_PATH" ]]; then
  NODE_PATH="$(command -v node || true)"
  if [[ -z "$NODE_PATH" ]]; then
    echo "NODE_NOT_FOUND: Node.js executable could not be resolved from PATH." >&2
    exit 1
  fi
elif [[ ! -x "$NODE_PATH" ]]; then
  echo "NODE_NOT_FOUND: Node.js executable does not exist or is not executable at '$NODE_PATH'." >&2
  exit 1
fi

# Parse state_dir from config using node
STATE_DIR="$( "$NODE_PATH" -e '
  const fs = require("fs");
  const path = require("path");
  try {
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    if (!cfg.state_dir) process.exit(2);
    const resolved = path.isAbsolute(cfg.state_dir) ? cfg.state_dir : path.resolve(process.argv[2], cfg.state_dir);
    process.stdout.write(resolved);
  } catch (e) { process.exit(3); }
' "$RESOLVED_CONFIG" "$CONFIG_DIR" || exit $? )"

RUNTIME_RECORD="$STATE_DIR/operator-runtime.json"
if [[ ! -f "$RUNTIME_RECORD" ]]; then
  echo "NO_ACCEPTED_RUNTIME: operator-runtime.json not found in state_dir '$STATE_DIR'." >&2
  exit 1
fi

# Validate accepted runtime record and resolve entrypoint
PARSED_RUNTIME="$( "$NODE_PATH" -e '
  const fs = require("fs");
  const path = require("path");
  const recordPath = process.argv[1];
  const configPath = process.argv[2];
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    if (!record.runtime_path || !record.manifest_path || !record.config_path) process.exit(4);
    if (path.resolve(record.config_path) !== path.resolve(configPath)) process.exit(5);
    const manifest = JSON.parse(fs.readFileSync(record.manifest_path, "utf8"));
    const entry = manifest?.runtime?.entry;
    if (!entry) process.exit(6);
    const entrypoint = path.join(record.runtime_path, entry);
    if (!fs.existsSync(entrypoint)) process.exit(7);
    process.stdout.write(JSON.stringify({
      runtime_path: record.runtime_path,
      entrypoint,
      runtime_identity: record.runtime_identity,
      origin: manifest.origin
    }));
  } catch (e) { process.exit(8); }
' "$RUNTIME_RECORD" "$RESOLVED_CONFIG" || exit $? )"

ENTRYPOINT="$( "$NODE_PATH" -e 'console.log(JSON.parse(process.argv[1]).entrypoint)' "$PARSED_RUNTIME" )"
RUNTIME_PATH="$( "$NODE_PATH" -e 'console.log(JSON.parse(process.argv[1]).runtime_path)' "$PARSED_RUNTIME" )"
RUNTIME_IDENTITY="$( "$NODE_PATH" -e 'console.log(JSON.parse(process.argv[1]).runtime_identity)' "$PARSED_RUNTIME" )"
RUNTIME_ORIGIN="$( "$NODE_PATH" -e 'console.log(JSON.stringify(JSON.parse(process.argv[1]).origin))' "$PARSED_RUNTIME" )"

# Check if port is already in use
if lsof -i "TCP:${PORT}" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "PORT_ALREADY_OWNED: UI port $PORT is already in use." >&2
  exit 1
fi

# Prepare node execution arguments
NODE_ARGS=()
if [[ "$ENTRYPOINT" == *.ts ]]; then
  NODE_ARGS+=("--experimental-transform-types")
fi

# Launch UI process in background
"$NODE_PATH" "${NODE_ARGS[@]}" "$ENTRYPOINT" ui --config "$RESOLVED_CONFIG" --port "$PORT" >/dev/null 2>&1 &
UI_PID=$!

# Wait for UI to become ready
READY=false
DEADLINE=$((SECONDS + 10))

while [[ $SECONDS -lt $DEADLINE ]]; do
  if ! kill -0 "$UI_PID" 2>/dev/null; then
    echo "UI_START_FAILED: launched UI process exited unexpectedly." >&2
    exit 1
  fi
  if curl -s -f "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.1
done

if [[ "$READY" != "true" ]]; then
  kill "$UI_PID" 2>/dev/null || true
  echo "UI_START_FAILED: launched UI did not respond on http://127.0.0.1:${PORT}/ within 10 seconds." >&2
  exit 1
fi

# Get process start time on POSIX
CREATION_DATE="$(ps -p "$UI_PID" -o lstart= 2>/dev/null | xargs || date -u +"%Y-%m-%dT%H:%M:%SZ")"
SIDECAR_PATH="$STATE_DIR/operator-ui-${PORT}.json"

# Write sidecar JSON
"$NODE_PATH" -e '
  const fs = require("fs");
  const sidecar = {
    port: parseInt(process.argv[1], 10),
    url: "http://127.0.0.1:" + process.argv[1],
    pid: parseInt(process.argv[2], 10),
    creation_date: process.argv[3],
    runtime_identity: process.argv[4],
    runtime_origin: JSON.parse(process.argv[5]),
    runtime_path: process.argv[6],
    config_path: process.argv[7],
    started_at: Date.now(),
  };
  fs.writeFileSync(process.argv[8], JSON.stringify(sidecar, null, 2) + "\n", { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    url: sidecar.url,
    pid: sidecar.pid,
    creation_date: sidecar.creation_date,
    runtime_identity: sidecar.runtime_identity,
    runtime_origin: sidecar.runtime_origin
  }) + "\n");
' "$PORT" "$UI_PID" "$CREATION_DATE" "$RUNTIME_IDENTITY" "$RUNTIME_ORIGIN" "$RUNTIME_PATH" "$RESOLVED_CONFIG" "$SIDECAR_PATH"
