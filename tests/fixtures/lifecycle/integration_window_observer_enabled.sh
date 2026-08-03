#!/usr/bin/env bash
set -euo pipefail

[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

if ! command -v tmux >/dev/null 2>&1; then
  echo "SKIP: tmux unavailable"
  exit 0
fi

if [[ -n "${CI:-}" ]]; then
  echo "SKIP: tmux layout test not available in CI"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_SOURCE="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_SOURCE/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-observer-enabled.XXXXXX)"
SESSION="wavemill-observer-enabled-$$"
export SESSION

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$RUNNER"
}

FAKE_BIN="$TMP_DIR/bin"
TEST_REPO="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
STATE_DIR="$TEST_REPO/.wavemill"
STATUS_LOG_FILE="$TMP_DIR/status.log"
STATE_FILE="$STATE_DIR/workflow-state.json"
mkdir -p "$FAKE_BIN" "$TEST_REPO" "$TOOLS_DIR" "$STATE_DIR"
printf '{"tasks":{}}' > "$STATE_FILE"
export REPO_DIR="$TEST_REPO" TOOLS_DIR STATUS_LOG_FILE STATE_FILE STATE_DIR PATH="$FAKE_BIN:$PATH"
export LIB_DIR="$REPO_SOURCE/shared/lib"

cat > "$FAKE_BIN/npx" <<'EOF'
#!/usr/bin/env bash
exec -a "npx $* session=${WAVEMILL_SESSION:-unknown}" sleep 300
EOF
chmod +x "$FAKE_BIN/npx"
touch "$TOOLS_DIR/tend.ts" "$TOOLS_DIR/observer.ts"

cat > "$TEST_REPO/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "useMillSession": true
  },
  "observer": {
    "enabled": true,
    "intervalSeconds": 1,
    "maxRestarts": 1,
    "retention": {
      "maxEntries": 5
    }
  }
}
EOF

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$REPO_SOURCE/shared/lib/wavemill-common.sh"
eval "$(extract_function spawn_integration_window)"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$TEST_REPO" 'sleep 300'
spawn_integration_window

for _ in {1..30}; do
  titles="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' 2>/dev/null | sort || true)"
  if [[ "$titles" == *"Wavemill Tend Loop"* \
    && "$titles" == *"Wavemill Observer"* \
    && "$titles" == *"Wavemill Jobs"* \
    && "$titles" == *"Wavemill Pending + Queue"* ]]; then
    pane_count="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}' | wc -l | tr -d ' ')"
    if [[ "$pane_count" == "4" && -f "$STATE_DIR/observer-health.json" ]]; then
      echo "PASS: backstage observer pane created"
      exit 0
    fi
  fi
  sleep 0.1
done

echo "FAIL: observer-enabled backstage layout missing expected panes"
exit 1
