#!/usr/bin/env bash
set -euo pipefail

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux unavailable"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_ROOT/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-disabled.XXXXXX)"
SESSION="wavemill-integration-disabled-$$"
export SESSION

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_spawn_function() {
  awk '
    /^spawn_integration_window\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}/ { exit }
  ' "$RUNNER"
}

FAKE_BIN="$TMP_DIR/bin"
REPO_DIR="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
STATUS_LOG_FILE="$TMP_DIR/status.log"
mkdir -p "$FAKE_BIN" "$REPO_DIR" "$TOOLS_DIR"
export REPO_DIR TOOLS_DIR STATUS_LOG_FILE PATH="$FAKE_BIN:$PATH"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exec -a "npx $* session=${WAVEMILL_SESSION:-unknown}" sleep 300
EOF
chmod +x "$FAKE_BIN/npx"
touch "$TOOLS_DIR/tend.ts"

cat > "$REPO_DIR/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": false,
    "useMillSession": true
  }
}
EOF

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$REPO_ROOT/shared/lib/wavemill-common.sh"
eval "$(extract_spawn_function)"

tmux new-session -d -s "$SESSION" -n control -c "$REPO_DIR" 'sleep 300'
spawn_integration_window
sleep 0.2

if tmux list-windows -t "$SESSION" -F '#{window_name}' | grep -qx 'integration'; then
  echo "FAIL: integration window should not be created"
  exit 1
fi

echo "PASS: integration window stays disabled"
exit 0
