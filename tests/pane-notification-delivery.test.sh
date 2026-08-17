#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTERS_SCRIPT="$REPO_DIR/shared/lib/agent-adapters.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_true() {
  local name="$1"
  shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

check_false() {
  local name="$1"
  shift
  if "$@"; then fail "$name"; else pass "$name"; fi
}

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
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

TEST_TMP="$(mktemp -d)"
TEST_SESSION="TESTPANE$$"
trap 'rm -rf "$TEST_TMP"; rm -f /tmp/wavemill-'"$TEST_SESSION"'-*.hook 2>/dev/null || true' EXIT

FAKE_BIN="$TEST_TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
cmd="${1:-}"
shift || true
case "$cmd" in
  send-keys)
    printf '%s %s\n' "$cmd" "$*" >> "${TMUX_LOG:?}"
    if [[ "${FAKE_SEND_FAIL:-0}" == "1" ]]; then
      exit 1
    fi
    if [[ "$*" == *" C-m"* || "$*" == *" Enter"* ]]; then
      count="$(cat "${TMUX_ENTER_COUNT:?}" 2>/dev/null || echo 0)"
      count=$((count + 1))
      printf '%s\n' "$count" > "$TMUX_ENTER_COUNT"
      case "${FAKE_CONFIRM:-}" in
        hook)
          printf '{"state":"working","event":"UserPromptSubmit","timestamp":%s}\n' "$(date +%s)" > "${FAKE_HOOK_FILE:?}"
          ;;
        pane)
          printf 'submitted\n' > "${TMUX_PANE_STATE:?}"
          ;;
        stranded_then_submit)
          if (( count >= 2 )); then
            printf 'submitted\n' > "${TMUX_PANE_STATE:?}"
          else
            printf 'stranded\n' > "${TMUX_PANE_STATE:?}"
          fi
          ;;
        never)
          printf 'stranded\n' > "${TMUX_PANE_STATE:?}"
          ;;
      esac
    fi
    ;;
  capture-pane)
    if [[ "${FAKE_CAPTURE_UNSUPPORTED:-0}" == "1" ]]; then
      exit 1
    fi
    state="$(cat "${TMUX_PANE_STATE:?}" 2>/dev/null || echo ready)"
    case "$state" in
      submitted)
        printf 'assistant transcript\n> %s\n> \n' "${FAKE_MESSAGE:?}"
        ;;
      stranded)
        printf 'assistant transcript\n> %s\n' "${FAKE_MESSAGE:?}"
        ;;
      *)
        printf 'assistant transcript\n> \n'
        ;;
    esac
    ;;
  list-panes)
    if [[ "$*" == *"#{pane_dead}"* ]]; then
      printf '%s\n' "${TMUX_PANE_DEAD:-0}"
    fi
    ;;
  display-message)
    if [[ "$*" == *"#{pane_pid}"* ]]; then
      printf '4242\n'
    elif [[ "$*" == *"#{pane_current_command}"* ]]; then
      printf 'claude\n'
    fi
    ;;
  *)
    ;;
esac
EOF
chmod +x "$FAKE_BIN/tmux"
PATH="$FAKE_BIN:$PATH"

# shellcheck source=/dev/null
source "$ADAPTERS_SCRIPT"

export WAVEMILL_PANE_SEND_CONFIRM_WAIT=0.05
export WAVEMILL_PANE_SEND_POLL=0.01
export WAVEMILL_PANE_SEND_ENTER_DELAY=0.01
export WAVEMILL_PANE_SEND_MAX_ATTEMPTS=3

reset_tmux_fake() {
  local name="$1"
  TMUX_LOG="$TEST_TMP/${name}.tmux.log"
  TMUX_ENTER_COUNT="$TEST_TMP/${name}.enter-count"
  TMUX_PANE_STATE="$TEST_TMP/${name}.pane-state"
  FAKE_HOOK_FILE="/tmp/wavemill-${TEST_SESSION}-HOK-1.hook"
  FAKE_MESSAGE="Planning approval was rejected because planning modified out-of-scope files: src/new-feature.ts."
  : > "$TMUX_LOG"
  printf '0\n' > "$TMUX_ENTER_COUNT"
  printf 'ready\n' > "$TMUX_PANE_STATE"
  rm -f "$FAKE_HOOK_FILE"
  export TMUX_LOG TMUX_ENTER_COUNT TMUX_PANE_STATE FAKE_HOOK_FILE FAKE_MESSAGE
  unset FAKE_CONFIRM FAKE_CAPTURE_UNSUPPORTED FAKE_SEND_FAIL
}

echo "=== Confirmed Pane Message Helper ==="

reset_tmux_fake hook
printf '{"state":"idle","event":"Stop","timestamp":1}\n' > "$FAKE_HOOK_FILE"
FAKE_CONFIRM=hook
export FAKE_CONFIRM
check_true "hook confirms first attempt" agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "HOK-1" "$TEST_SESSION"
check_eq "hook method recorded" "hook" "${AGENT_PANE_SEND_LAST_METHOD:-}"
check_eq "hook attempt count" "1" "${AGENT_PANE_SEND_LAST_ATTEMPTS:-}"
check_eq "hook sends text once" "1" "$(grep -c -- ' -l -- ' "$TMUX_LOG")"
check_eq "hook sends enter once" "1" "$(grep -c -- ' C-m' "$TMUX_LOG")"

reset_tmux_fake pane
FAKE_CONFIRM=pane
export FAKE_CONFIRM
check_true "pane transcript confirms submission" agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
check_eq "pane method recorded" "pane" "${AGENT_PANE_SEND_LAST_METHOD:-}"

reset_tmux_fake stranded
FAKE_CONFIRM=stranded_then_submit
export FAKE_CONFIRM
check_true "stranded input retries enter only" agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
check_eq "stranded retry attempts twice" "2" "${AGENT_PANE_SEND_LAST_ATTEMPTS:-}"
check_eq "stranded retry types text once" "1" "$(grep -c -- ' -l -- ' "$TMUX_LOG")"
check_eq "stranded retry sends enter twice" "2" "$(grep -c -- ' C-m' "$TMUX_LOG")"

reset_tmux_fake never
FAKE_CONFIRM=never
export FAKE_CONFIRM
set +e
agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
rc=$?
set -e
check_eq "never accepted returns failure" "1" "$rc"
check_eq "never accepted exhausts attempts" "3" "${AGENT_PANE_SEND_LAST_ATTEMPTS:-}"
check_eq "never accepted records stranded input" "stranded_input" "${AGENT_PANE_SEND_LAST_REASON:-}"

reset_tmux_fake unverifiable
FAKE_CAPTURE_UNSUPPORTED=1
export FAKE_CAPTURE_UNSUPPORTED
set +e
agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
rc=$?
set -e
check_eq "unsupported capture is unverifiable" "2" "$rc"
check_eq "unverifiable does not retry blind" "1" "${AGENT_PANE_SEND_LAST_ATTEMPTS:-}"

reset_tmux_fake sendfail
FAKE_SEND_FAIL=1
export FAKE_SEND_FAIL
set +e
agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
rc=$?
set -e
check_eq "send-keys failure returns failure" "1" "$rc"
check_eq "send failure reason" "send_failed" "${AGENT_PANE_SEND_LAST_REASON:-}"

reset_tmux_fake literal
FAKE_CONFIRM=pane
FAKE_MESSAGE='Planning approval was rejected; quotes "$HOME" # no expansion.'
export FAKE_CONFIRM FAKE_MESSAGE
check_true "literal message with shell metacharacters sends" agent_pane_send_message_confirmed "sess:win" "$FAKE_MESSAGE" "" ""
check_true "literal send uses -l --" grep -q -- 'send-keys .* -l -- Planning approval was rejected; quotes "\$HOME" # no expansion\.' "$TMUX_LOG"

echo ""
echo "=== Planning Rejection Notification ==="

MILL_FUNCS="$TEST_TMP/mill-funcs.sh"
{
  for fn in \
    planning_rejection_files_summary \
    planning_rejection_notify_retry_due \
    planning_rejection_hook_confirms_after \
    escalate_planning_rejection_undelivered \
    notify_planning_rejection_agent
  do
    extract_function "$MILL_SCRIPT" "$fn"
    echo
  done
} > "$MILL_FUNCS"

# shellcheck source=/dev/null
source "$COMMON_SCRIPT"

SESSION="$TEST_SESSION"
LIB_DIR="$REPO_DIR/shared/lib"
WORKTREE_ROOT="$TEST_TMP/worktrees"
STATE_FILE="$TEST_TMP/state.json"
LOG_FILE="$TEST_TMP/mill.log"
ATTENTION_LOG="$TEST_TMP/attention.log"
HOOK_LOG="$TEST_TMP/hook.log"
mkdir -p "$WORKTREE_ROOT/slug/features/slug"
printf '{}\n' > "$STATE_FILE"
export SESSION LIB_DIR WORKTREE_ROOT STATE_FILE

log() { printf 'log %s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'warn %s\n' "$*" >> "$LOG_FILE"; }
set_window_attention_state() { printf '%s %s\n' "$1" "$2" >> "$ATTENTION_LOG"; }
wavemill_hook_write() { printf '%s|%s|%s|%s|%s\n' "$1" "$2" "$3" "$4" "$5" >> "$HOOK_LOG"; }
_tmux_task_window_target() { printf '%s\n' "$2-window"; }
_tmux_target_join() { printf '%s:%s\n' "$1" "$2"; }
_pane_is_dead_or_idle() { return "${PANE_IDLE_RC:-1}"; }

# shellcheck source=/dev/null
source "$MILL_FUNCS"

write_artifact() {
  local artifact="$1"
  mkdir -p "$(dirname "$artifact")"
  cat > "$artifact" <<'EOF'
{
  "issue": "HOK-1",
  "stage": "planning",
  "status": "awaiting_user",
  "reason": "planning_modified_out_of_scope_files",
  "outOfScopeFiles": ["src/new-feature.ts"]
}
EOF
}

FEATURE_DIR="$WORKTREE_ROOT/slug/features/slug"
ARTIFACT="$FEATURE_DIR/.planning-rejected.json"

reset_notify_logs() {
  : > "$LOG_FILE"
  : > "$ATTENTION_LOG"
  : > "$HOOK_LOG"
  PANE_IDLE_RC=1
  export PANE_IDLE_RC
}

agent_pane_send_message_confirmed() {
  AGENT_PANE_SEND_LAST_METHOD="${STUB_SEND_METHOD:-hook}"
  AGENT_PANE_SEND_LAST_REASON="${STUB_SEND_REASON:-confirmed}"
  AGENT_PANE_SEND_LAST_ATTEMPTS="${STUB_SEND_ATTEMPTS:-1}"
  return "${STUB_SEND_RC:-0}"
}

reset_notify_logs
write_artifact "$ARTIFACT"
STUB_SEND_RC=0 STUB_SEND_METHOD=hook STUB_SEND_REASON=confirmed STUB_SEND_ATTEMPTS=1
export STUB_SEND_RC STUB_SEND_METHOD STUB_SEND_REASON STUB_SEND_ATTEMPTS
notify_planning_rejection_agent "$FEATURE_DIR" "HOK-1-slug" "src/new-feature.ts"
check_eq "confirmed stamps notifiedAt" "confirmed" "$(jq -r '.notifyDelivery.status' "$ARTIFACT")"
check_true "confirmed writes notifiedAt" test -n "$(jq -r '.notifiedAt // empty' "$ARTIFACT")"
check_eq "confirmed avoids blocked hook" "0" "$(wc -l < "$HOOK_LOG" | tr -d ' ')"

reset_notify_logs
write_artifact "$ARTIFACT"
STUB_SEND_RC=1 STUB_SEND_METHOD=none STUB_SEND_REASON=stranded_input STUB_SEND_ATTEMPTS=3
export STUB_SEND_RC STUB_SEND_METHOD STUB_SEND_REASON STUB_SEND_ATTEMPTS
notify_planning_rejection_agent "$FEATURE_DIR" "HOK-1-slug" "src/new-feature.ts"
check_eq "failed records status" "failed" "$(jq -r '.notifyDelivery.status' "$ARTIFACT")"
check_eq "failed records attempts" "3" "$(jq -r '.notifyDelivery.attempts' "$ARTIFACT")"
check_eq "failed does not stamp notifiedAt" "" "$(jq -r '.notifiedAt // empty' "$ARTIFACT")"
check_true "failed emits blocked hook" grep -q 'blocked|planning_notify_undelivered' "$HOOK_LOG"
check_true "failed marks needs user" grep -q 'HOK-1-slug needs-user' "$ATTENTION_LOG"

reset_notify_logs
write_artifact "$ARTIFACT"
STUB_SEND_RC=2 STUB_SEND_METHOD=none STUB_SEND_REASON=unverifiable STUB_SEND_ATTEMPTS=1
export STUB_SEND_RC STUB_SEND_METHOD STUB_SEND_REASON STUB_SEND_ATTEMPTS
notify_planning_rejection_agent "$FEATURE_DIR" "HOK-1-slug" "src/new-feature.ts"
check_eq "unverifiable records status" "unverifiable" "$(jq -r '.notifyDelivery.status' "$ARTIFACT")"
check_eq "unverifiable does not stamp notifiedAt" "" "$(jq -r '.notifiedAt // empty' "$ARTIFACT")"
check_eq "unverifiable avoids blocked hook" "0" "$(wc -l < "$HOOK_LOG" | tr -d ' ')"

reset_notify_logs
write_artifact "$ARTIFACT"
PANE_IDLE_RC=0
export PANE_IDLE_RC
notify_planning_rejection_agent "$FEATURE_DIR" "HOK-1-slug" "src/new-feature.ts"
check_eq "idle pane records skipped" "skipped" "$(jq -r '.notifyDelivery.status' "$ARTIFACT")"
check_eq "idle pane reason" "agent_not_running" "$(jq -r '.notifyDelivery.reason' "$ARTIFACT")"

reset_notify_logs
write_artifact "$ARTIFACT"
old_ts="$(date -u -v-60S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '60 seconds ago' +"%Y-%m-%dT%H:%M:%SZ")"
state_mutate "$ARTIFACT" '.notifyDelivery = {status:"failed", reason:"stranded_input", attempts:3, rounds:1, lastAttemptAt:$ts}' --arg ts "$old_ts"
WAVEMILL_PANE_NOTIFY_RETRY_INTERVAL=1
export WAVEMILL_PANE_NOTIFY_RETRY_INTERVAL
STUB_SEND_RC=0 STUB_SEND_METHOD=hook STUB_SEND_REASON=confirmed STUB_SEND_ATTEMPTS=1
export STUB_SEND_RC STUB_SEND_METHOD STUB_SEND_REASON STUB_SEND_ATTEMPTS
notify_planning_rejection_agent "$FEATURE_DIR" "HOK-1-slug"
check_eq "retry round can confirm" "confirmed" "$(jq -r '.notifyDelivery.status' "$ARTIFACT")"
check_eq "retry increments rounds" "2" "$(jq -r '.notifyDelivery.rounds' "$ARTIFACT")"

if (( FAIL > 0 )); then
  echo ""
  echo "FAIL: $FAIL assertions failed ($PASS passed)"
  exit 1
fi

echo ""
echo "PASS: $PASS assertions"
