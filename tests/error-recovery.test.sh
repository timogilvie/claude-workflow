#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
ADAPTERS_SCRIPT="$REPO_DIR/shared/lib/agent-adapters.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_true() {
  local name="$1"
  shift
  if "$@"; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_false() {
  local name="$1"
  shift
  if "$@"; then
    fail "$name"
  else
    pass "$name"
  fi
}

check_eq() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d)"
TEST_SESSION="TESTREC$$"
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wavemill-'"$TEST_SESSION"'-*.hook /tmp/wavemill-'"$TEST_SESSION"'-*.retry /tmp/wavemill-'"$TEST_SESSION"'-*.exit 2>/dev/null || true' EXIT

extract_monitor_heredoc() {
  awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
    /^MONITOR_EOF$/ { found=0; next }
    found { print }
  ' "$MILL_SCRIPT"
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

RECOVERY_FUNCS="$TEST_TMP/recovery-funcs.sh"
{
  echo 'log() { :; }'
  echo 'log_warn() { :; }'
  echo 'log_error() { :; }'
  echo "SESSION='$TEST_SESSION'"
  for fn in \
    is_transient_error \
    retry_state_file \
    get_retry_count \
    get_retry_timestamp \
    increment_retry_count \
    reset_retry_count \
    get_backoff_delay \
    transient_error_recovery_pending \
  ; do
    extract_function "$MONITOR_BODY" "$fn"
    echo
  done
} > "$RECOVERY_FUNCS"

# shellcheck source=/dev/null
source "$RECOVERY_FUNCS"

echo "=== Error Recovery Helpers ==="

check_true "classifies 500 as transient" is_transient_error 'API Error: 500 Internal server error'
check_true "classifies 429 as transient" is_transient_error 'Rate limit: 429 Too Many Requests'
check_false "classifies 401 as permanent" is_transient_error 'API Error: 401 Unauthorized'
check_false "classifies empty detail as permanent" is_transient_error ''

check_eq "retry count defaults to zero" "0" "$(get_retry_count "$TEST_SESSION" "HOK-1")"
increment_retry_count "$TEST_SESSION" "HOK-1"
check_eq "retry count increments" "1" "$(get_retry_count "$TEST_SESSION" "HOK-1")"
check_true "retry timestamp recorded" test "$(get_retry_timestamp "$TEST_SESSION" "HOK-1")" -gt 0
reset_retry_count "$TEST_SESSION" "HOK-1"
check_eq "retry count resets" "0" "$(get_retry_count "$TEST_SESSION" "HOK-1")"

check_eq "backoff 1" "30" "$(get_backoff_delay 1)"
check_eq "backoff 2" "60" "$(get_backoff_delay 2)"
check_eq "backoff 3" "120" "$(get_backoff_delay 3)"
check_eq "backoff max" "240" "$(get_backoff_delay 4)"

cat > "/tmp/wavemill-${TEST_SESSION}-HOK-2.hook" <<EOF
{"state":"error","detail":"API Error: 500","timestamp":$(date +%s)}
EOF
check_true "pending recovery while retries remain" transient_error_recovery_pending "HOK-2"
for _ in 1 2 3 4; do
  increment_retry_count "$TEST_SESSION" "HOK-2"
done
check_false "no pending recovery after max retries" transient_error_recovery_pending "HOK-2"
reset_retry_count "$TEST_SESSION" "HOK-2"

echo ""
echo "=== Resume Adapter ==="

FAKE_BIN="$TEST_TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
shift || true
case "$cmd" in
  list-windows)
    printf '%s\n' "${TMUX_WINDOW_NAME:-}"
    ;;
  list-panes)
    if [[ "$*" == *"#{pane_dead}"* ]]; then
      printf '%s\n' "${TMUX_PANE_DEAD:-0}"
    fi
    ;;
  display-message)
    if [[ "$*" == *"#{pane_pid}"* ]]; then
      printf '%s\n' "${TMUX_PANE_PID:-4242}"
    elif [[ "$*" == *"#{pane_current_command}"* ]]; then
      printf '%s\n' "${TMUX_CURRENT_COMMAND:-bash}"
    elif [[ "$*" == *"#{pane_current_path}"* ]]; then
      printf '%s\n' "${TMUX_CURRENT_PATH:-$PWD}"
    fi
    ;;
  send-keys|respawn-pane)
    printf '%s %s\n' "$cmd" "$*" >> "${TMUX_LOG:?}"
    ;;
esac
EOF
cat > "$FAKE_BIN/pgrep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
count="${TMUX_CHILD_COUNT:-0}"
if (( count > 0 )); then
  seq 1 "$count"
else
  exit 1
fi
EOF
cat > "$FAKE_BIN/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "--help" ]]; then
  printf '%s\n' "${CLAUDE_HELP_TEXT:-usage: claude --resume}"
fi
EOF
chmod +x "$FAKE_BIN/tmux" "$FAKE_BIN/pgrep" "$FAKE_BIN/claude"

PATH="$FAKE_BIN:$PATH"

# shellcheck source=/dev/null
source "$ADAPTERS_SCRIPT"

TMUX_WINDOW_NAME="HOK-3-test-slug"
TMUX_PANE_DEAD=0
TMUX_PANE_PID=4242
TMUX_LOG="$TEST_TMP/tmux-ready.log"
TMUX_CURRENT_COMMAND="bash"
TMUX_CHILD_COUNT=0
CLAUDE_HELP_TEXT="usage: claude --resume"
export TMUX_WINDOW_NAME TMUX_PANE_DEAD TMUX_PANE_PID TMUX_LOG TMUX_CURRENT_COMMAND TMUX_CHILD_COUNT CLAUDE_HELP_TEXT
: > "$TMUX_LOG"
check_true "claude shell resume succeeds" agent_resume_after_error "sess" "HOK-3" "claude"
check_true "claude uses --resume from shell" grep -q 'claude --resume' "$TMUX_LOG"

TMUX_LOG="$TEST_TMP/tmux-busy.log"
TMUX_CURRENT_COMMAND="claude"
TMUX_CHILD_COUNT=1
export TMUX_LOG TMUX_CURRENT_COMMAND TMUX_CHILD_COUNT
: > "$TMUX_LOG"
check_true "busy agent resume succeeds" agent_resume_after_error "sess" "HOK-3" "claude"
check_true "busy agent gets continuation prompt" grep -q 'Please continue working on the task from where you left off' "$TMUX_LOG"
check_false "busy agent does not inject shell resume command" grep -q 'claude --resume' "$TMUX_LOG"

echo ""
echo "=== Hook Scripts ==="

CLAUDE_ISSUE="HOK-4"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CLAUDE_ISSUE" \
  bash "$REPO_DIR/shared/hooks/claude-status-hook.sh" <<'EOF'
{"hook_event_name":"StopFailure","error":{"type":"api_error","message":"Internal server error"}}
EOF
check_eq "claude hook records nested error message" "Internal server error" "$(jq -r '.detail' "/tmp/wavemill-${TEST_SESSION}-${CLAUDE_ISSUE}.hook")"

CODEX_ISSUE="HOK-5"
WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$CODEX_ISSUE" \
  bash "$REPO_DIR/shared/hooks/codex-status-monitor.sh" <<'EOF'
{"type":"api_error","error":{"message":"Rate limit exceeded"}}
EOF
check_eq "codex hook records api errors" "error|Rate limit exceeded" "$(jq -r '.state + "|" + .detail' "/tmp/wavemill-${TEST_SESSION}-${CODEX_ISSUE}.hook")"

echo ""
echo "=== Generic Process Monitor ==="

PROCESS_ISSUE="HOK-6"
EXIT_FILE="/tmp/wavemill-${TEST_SESSION}-${PROCESS_ISSUE}.exit"
(
  sleep 0.2
  printf '7\n' > "$EXIT_FILE"
) &
WATCHER_PID=$!
WAVEMILL_PROCESS_STATUS_POLL_INTERVAL=1 WAVEMILL_SESSION="$TEST_SESSION" WAVEMILL_ISSUE="$PROCESS_ISSUE" \
  bash "$REPO_DIR/shared/hooks/process-status-monitor.sh" "$WATCHER_PID" "$EXIT_FILE"
check_eq "generic monitor surfaces wrapped exit codes" "error|exit_code:7" "$(jq -r '.state + "|" + .detail' "/tmp/wavemill-${TEST_SESSION}-${PROCESS_ISSUE}.hook")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
