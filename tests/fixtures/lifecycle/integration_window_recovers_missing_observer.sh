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
SOURCE_REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$SOURCE_REPO_DIR/shared/lib/wavemill-startup-runner.sh"
MILL="$SOURCE_REPO_DIR/shared/lib/wavemill-mill.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-observer-recover.XXXXXX)"
SESSION="wavemill-observer-recover-$$"
export SESSION

cleanup() {
  tmux kill-session -t "$SESSION" >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
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
  ' "$source_file"
}

wait_for_pane_title() {
  local title="$1"
  for _ in {1..30}; do
    pane_id="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' 2>/dev/null | awk -F '\t' -v title="$title" '$2 == title { print $1; exit }')"
    if [[ -n "${pane_id:-}" ]]; then
      printf '%s\n' "$pane_id"
      return 0
    fi
    sleep 0.1
  done
  return 1
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
export LIB_DIR="$SOURCE_REPO_DIR/shared/lib"

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
    "maxRestarts": 1
  }
}
EOF

startup_log() { printf '%s\n' "$*" >> "$STATUS_LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$STATUS_LOG_FILE"; }
log() {
  shift || true
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
eval "$(extract_function "$RUNNER" spawn_integration_window)"
eval "$(extract_function "$MILL" observer_health_enabled)"
eval "$(extract_function "$MILL" read_observer_health_field)"
eval "$(extract_function "$MILL" ensure_observer_health_file)"
eval "$(extract_function "$MILL" write_observer_health_state)"
eval "$(extract_function "$MILL" probe_observer_panes)"
eval "$(extract_function "$MILL" classify_observer_health)"
eval "$(extract_function "$MILL" restart_backstage_observer)"
eval "$(extract_function "$MILL" check_observer_health)"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$TEST_REPO" 'sleep 300'
spawn_integration_window

observer_pane="$(wait_for_pane_title "Wavemill Observer")" || {
  echo "FAIL: observer pane did not start"
  exit 1
}

tmux kill-pane -t "$observer_pane"
sleep 0.3

LAST_OBSERVER_HEALTH_CHECK=0
LAST_OBSERVER_HEALTH_STATUS=""
OBSERVER_HEALTH_INTERVAL=0
OBSERVER_RESTART_COOLDOWN=0
check_observer_health

recovered_pane="$(wait_for_pane_title "Wavemill Observer")" || {
  echo "FAIL: observer pane did not recover"
  exit 1
}

status="$(jq -r '.status // empty' "$STATE_DIR/observer-health.json" 2>/dev/null || echo missing)"
attempts="$(jq -r '.restartAttemptCount // 0' "$STATE_DIR/observer-health.json" 2>/dev/null || echo 0)"
if [[ "$status" != "restarted" || "$attempts" != "1" ]]; then
  echo "FAIL: observer restart state unexpected (status=$status attempts=$attempts)"
  exit 1
fi

tmux kill-pane -t "$recovered_pane"
sleep 0.3
LAST_OBSERVER_HEALTH_CHECK=0
check_observer_health

status="$(jq -r '.status // empty' "$STATE_DIR/observer-health.json" 2>/dev/null || echo missing)"
if [[ "$status" != "needs-user" ]]; then
  echo "FAIL: observer did not escalate after restart budget (status=$status)"
  exit 1
fi

if ! wait_for_pane_title "Wavemill Tend Loop" >/dev/null; then
  echo "FAIL: tend pane should remain alive"
  exit 1
fi

echo "PASS: observer restart escalates independently"
