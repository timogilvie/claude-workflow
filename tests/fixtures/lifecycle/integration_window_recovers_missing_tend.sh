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
TMP_DIR="$(mktemp -d /tmp/wavemill-integration-recover.XXXXXX)"
SESSION="wavemill-integration-recover-$$"
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
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

wait_for_tend_pane() {
  for _ in {1..30}; do
    pane_id="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_id}	#{pane_title}' 2>/dev/null | awk -F '\t' '$2 == "Wavemill Tend Loop" { print $1; exit }')"
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
touch "$TOOLS_DIR/tend.ts"

cat > "$TEST_REPO/.wavemill-config.json" <<'EOF'
{
  "integration": {
    "enabled": true,
    "useMillSession": true
  }
}
EOF

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

log_warn() {
  printf 'WARN %s\n' "$*" >> "$STATUS_LOG_FILE"
}

log() {
  local _level="${1:-info}"
  shift || true
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

source "$SOURCE_REPO_DIR/shared/lib/wavemill-common.sh"
eval "$(extract_function "$RUNNER" spawn_integration_window)"
eval "$(extract_function "$MILL" backstage_health_enabled)"
eval "$(extract_function "$MILL" probe_backstage_panes)"
eval "$(extract_function "$MILL" read_backstage_health_field)"
eval "$(extract_function "$MILL" classify_backstage_health)"
eval "$(extract_function "$MILL" restart_backstage_tend_loop)"
eval "$(extract_function "$MILL" check_backstage_health)"

tmux new-session -d -s "$SESSION" -n mill -x 220 -y 50 -c "$TEST_REPO" 'sleep 300'
spawn_integration_window

tend_pane="$(wait_for_tend_pane)" || {
  echo "FAIL: tend pane did not start"
  exit 1
}

tmux kill-pane -t "$tend_pane"
sleep 0.3

remaining_titles="$(tmux list-panes -t "$SESSION:backstage" -F '#{pane_title}' 2>/dev/null | sort)"
if [[ "$remaining_titles" != *"Wavemill Jobs"* || "$remaining_titles" != *"Wavemill Pending + Queue"* ]]; then
  echo "FAIL: status panes did not remain after tend exit"
  exit 1
fi

LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
check_backstage_health

recovered_pane="$(wait_for_tend_pane)" || {
  echo "FAIL: tend pane did not recover"
  exit 1
}

health_status="$(jq -r '.status' "$STATE_DIR/backstage-health.json" 2>/dev/null || echo missing)"
if [[ "$health_status" != "healthy" ]]; then
  echo "FAIL: backstage health did not return to healthy (status=$health_status)"
  exit 1
fi

if [[ -z "$recovered_pane" ]]; then
  echo "FAIL: recovered tend pane id missing"
  exit 1
fi

echo "PASS: backstage health restored missing tend loop"
