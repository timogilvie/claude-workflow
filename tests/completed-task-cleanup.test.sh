#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "    unexpected: $needle"
    fail "$name"
  else
    pass "$name"
  fi
}

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

extract_nth_function() {
  local source_file="$1"
  local function_name="$2"
  local target_count="$3"
  awk -v name="$function_name" -v target="$target_count" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      count++
      if (count == target) {
        capture = 1
        depth = 0
      }
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

HELPERS_FILE="$TEST_TMP/tmux_helpers.sh"
{
  extract_function "$MONITOR_SCRIPT_FILE" "_tmux_window_target_exists"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "_tmux_target_join"
  printf '\n'
  extract_function "$MONITOR_SCRIPT_FILE" "_tmux_task_window_target"
} > "$HELPERS_FILE"

CLEANUP_FILE="$TEST_TMP/cleanup_completed_task.sh"
extract_nth_function "$MONITOR_SCRIPT_FILE" "cleanup_completed_task" 1 > "$CLEANUP_FILE"
REMOTE_CLEANUP_FILE="$TEST_TMP/cleanup_remote_task_branch.sh"
extract_nth_function "$MONITOR_SCRIPT_FILE" "cleanup_remote_task_branch" 1 > "$REMOTE_CLEANUP_FILE"
OUTER_CLEANUP_FILE="$TEST_TMP/outer_cleanup_completed_task.sh"
extract_nth_function "$MILL_SCRIPT" "cleanup_completed_task" 1 > "$OUTER_CLEANUP_FILE"
OUTER_REMOTE_CLEANUP_FILE="$TEST_TMP/outer_cleanup_remote_task_branch.sh"
extract_nth_function "$MILL_SCRIPT" "cleanup_remote_task_branch" 1 > "$OUTER_REMOTE_CLEANUP_FILE"
EXECUTE_FILE="$TEST_TMP/execute.sh"
extract_function "$MILL_SCRIPT" "execute" > "$EXECUTE_FILE"

run_target_resolution_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/target-$test_case"
  mkdir -p "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    STATE_FILE="$CASE_DIR/state.json"
    WT_DIR="$CASE_DIR/worktrees/$SLUG"

    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31"}}}
EOF

    tmux() {
      case "${1:-}" in
        display-message)
          case "$TEST_CASE:${4:-}:${5:-}" in
            stored-dead:@31:"#{session_name}") printf "%s\n" "wavemill" ;;
            stored-dead:@31:"#{pane_current_path}") printf "\n" ;;
            renamed-title:@31:"#{session_name}") printf "%s\n" "wavemill" ;;
            renamed-title:@31:"#{pane_current_path}") printf "%s\n" "$WT_DIR" ;;
            *) return 1 ;;
          esac
          ;;
        list-panes)
          case "$TEST_CASE:${3:-}:${5:-}" in
            stored-dead:@31:"#{pane_dead}") printf "%s\n" "1" ;;
            *) return 1 ;;
          esac
          ;;
        list-windows)
          if [[ "$TEST_CASE" == "renamed-title" ]]; then
            printf "%s\n" "@31|2348 · task-slug · PR#868 ✓ · review"
          fi
          ;;
        *)
          return 1
          ;;
      esac
    }

    target="$(_tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "$STATE_FILE" "$WT_DIR")"
    printf "target=%s\n" "$target"
  ' 2>&1
}

run_cleanup_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/cleanup-$test_case"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" CLEANUP_FILE="$CLEANUP_FILE" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    source "$REMOTE_CLEANUP_FILE"
    source "$CLEANUP_FILE"

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    API_TIMEOUT=5

    state_pr_json=",\"pr\":4242"
    if [[ "$TEST_CASE" == "no-pr" ]]; then
      state_pr_json=""
    fi
    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31"$state_pr_json}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    declare -Ag PR_BY_ISSUE=()
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    ATTENTION=""
    REMOVE_STATE_CALLS=0
    KILLED=0
    GIT_CALLS=""

    archive_stage_artifacts() { :; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION="$2"; }
    remove_task_state() { REMOVE_STATE_CALLS=$((REMOVE_STATE_CALLS + 1)); }
    _with_timeout() { shift; "$@"; }
    pr_state() {
      case "$TEST_CASE" in
        closed-unmerged) printf "%s\n" "CLOSED" ;;
        *) printf "%s\n" "MERGED" ;;
      esac
    }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      GIT_CALLS+="$*;"
      case "${1:-} ${2:-}" in
        "ls-remote --exit-code")
          [[ "$TEST_CASE" == "merged-remote-absent" ]] && return 2
          return 0
          ;;
        "push origin")
          [[ "$TEST_CASE" == "push-fails" ]] && return 1
          return 0
          ;;
      esac
      return 0
    }

    tmux() {
      case "${1:-}" in
        display-message)
          case "${5:-}" in
            "#{session_name}")
              if [[ "${4:-}" != "@31" ]]; then
                return 1
              fi
              if [[ "$TEST_CASE" == "kill-persistent" && "$KILLED" -eq 1 ]]; then
                printf "%s\n" "wavemill"
                return 0
              fi
              if [[ "$TEST_CASE" != "kill-persistent" && "$KILLED" -eq 1 ]]; then
                return 1
              fi
              printf "%s\n" "wavemill"
              ;;
            "#{pane_current_path}")
              printf "\n"
              ;;
            *)
              return 1
              ;;
          esac
          ;;
        list-panes)
          if [[ "${2:-}" == "-t" && "${3:-}" == "@31" ]]; then
            printf "%s\n" "1"
            return 0
          fi
          return 1
          ;;
        kill-window)
          KILLED=1
          return 0
          ;;
        *)
          return 1
          ;;
      esac
    }

    cleanup_completed_task "$ISSUE" "$SLUG" "test cleanup" || true

    printf "remove_state_calls=%s\n" "$REMOVE_STATE_CALLS"
    printf "cleaned=%s\n" "${CLEANED[$ISSUE]:-}"
    printf "attention=%s\n" "$ATTENTION"
    printf "git_calls=%s\n" "$GIT_CALLS"
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  ' 2>&1
}

run_protected_helper_case() {
  local case_dir="$TEST_TMP/protected-helper"
  mkdir -p "$case_dir/repo"

  CASE_DIR="$case_dir" REMOTE_CLEANUP_FILE="$REMOTE_CLEANUP_FILE" bash -lc '
    set -euo pipefail
    source "$REMOTE_CLEANUP_FILE"
    REPO_DIR="$CASE_DIR/repo"
    API_TIMEOUT=5
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    pr_state() { printf "%s\n" "MERGED"; }
    _with_timeout() { shift; "$@"; }
    git() { return 0; }

    cleanup_remote_task_branch "HOK-2348" "main" "4242"
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  ' 2>&1
}

run_outer_dry_run_case() {
  local case_dir="$TEST_TMP/outer-dry-run"
  mkdir -p "$case_dir/repo" "$case_dir/worktrees/task-slug"

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" CLEANUP_FILE="$OUTER_CLEANUP_FILE" REMOTE_CLEANUP_FILE="$OUTER_REMOTE_CLEANUP_FILE" EXECUTE_FILE="$EXECUTE_FILE" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    source "$EXECUTE_FILE"
    source "$REMOTE_CLEANUP_FILE"
    source "$CLEANUP_FILE"

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"
    API_TIMEOUT=5
    DRY_RUN=true

    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31","pr":4242}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    declare -Ag PR_BY_ISSUE=()
    REMOVE_STATE_CALLS=0
    KILLED=0
    LOG_OUTPUT=""
    WARN_OUTPUT=""

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { :; }
    reset_retry_count() { :; }
    remove_task_state() { REMOVE_STATE_CALLS=$((REMOVE_STATE_CALLS + 1)); }
    pr_state() { printf "%s\n" "MERGED"; }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      return 0
    }
    _with_timeout() { shift; "$@"; }
    tmux() { return 1; }

    cleanup_completed_task "$ISSUE" "$SLUG" "test cleanup" || true
    printf "mill_log=%s\n" "$(tr "\n" ";" < "$MILL_LOG_FILE")"
  ' 2>&1
}

echo "=== Completed Task Cleanup ==="

output="$(run_target_resolution_case stored-dead)"
check_contains "stored dead pane keeps persisted target" "$output" "target=@31"

output="$(run_target_resolution_case renamed-title)"
check_contains "renamed title resolves current window id" "$output" "target=@31"

output="$(run_cleanup_case dead-pane-success)"
check_contains "cleanup success removes task state" "$output" "remove_state_calls=1"
check_contains "cleanup success marks issue cleaned" "$output" "cleaned=1"
check_contains "cleanup success keeps attention clear" "$output" "attention="
check_not_contains "cleanup success avoids warnings" "$output" "keeping task state"

output="$(run_cleanup_case merged-remote-present)"
check_contains "merged PR deletes remote branch" "$output" "push origin --delete task/task-slug"
check_contains "merged PR logs remote deletion" "$output" "Deleted remote branch: task/task-slug"
check_contains "merged PR cleanup still removes state" "$output" "remove_state_calls=1"

output="$(run_cleanup_case merged-remote-absent)"
check_not_contains "absent remote avoids delete push" "$output" "push origin --delete task/task-slug"
check_contains "absent remote logs no-op" "$output" "remote branch already absent: task/task-slug"
check_contains "absent remote produces no warning" "$output" "warns="

output="$(run_cleanup_case closed-unmerged)"
check_not_contains "closed unmerged retains remote branch" "$output" "push origin --delete task/task-slug"
check_contains "closed unmerged logs retention" "$output" "retaining remote branch task/task-slug (PR #4242 state=CLOSED"

output="$(run_cleanup_case no-pr)"
check_not_contains "missing PR avoids remote delete" "$output" "push origin --delete task/task-slug"
check_contains "missing PR logs retention" "$output" "retaining remote branch task/task-slug (no PR recorded)"

output="$(run_cleanup_case push-fails)"
check_contains "push failure warns" "$output" "Remote branch cleanup failed (retained): task/task-slug"
check_contains "push failure still marks cleaned" "$output" "cleaned=1"
check_contains "push failure still removes state" "$output" "remove_state_calls=1"

output="$(run_protected_helper_case)"
check_contains "helper refuses protected branch" "$output" "Refusing to delete protected branch: main"

output="$(run_outer_dry_run_case)"
check_contains "outer dry run reports remote delete" "$output" "[DRY-RUN] _with_timeout 5 git -C"
check_contains "outer dry run includes push delete" "$output" "push origin --delete task/task-slug"

output="$(run_cleanup_case kill-persistent)"
check_contains "cleanup failure preserves task state" "$output" "remove_state_calls=0"
check_contains "cleanup failure does not mark issue cleaned" "$output" "cleaned="
check_contains "cleanup failure requests attention" "$output" "attention=needs-user"
check_contains "cleanup failure warns about persistent window" "$output" "keeping task state"

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
else
  echo "$FAIL assertion(s) failed; $PASS passed."
  exit 1
fi
