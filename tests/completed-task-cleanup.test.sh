#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

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
  extract_function "$MILL_SCRIPT" "_tmux_window_target_exists"
  printf '\n'
  extract_function "$MILL_SCRIPT" "_tmux_target_join"
  printf '\n'
  extract_function "$MILL_SCRIPT" "_tmux_task_window_target"
} > "$HELPERS_FILE"

CLEANUP_FILE="$TEST_TMP/cleanup_completed_task.sh"
extract_nth_function "$MILL_SCRIPT" "cleanup_completed_task" 2 > "$CLEANUP_FILE"

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

  CASE_DIR="$case_dir" HELPERS_FILE="$HELPERS_FILE" CLEANUP_FILE="$CLEANUP_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$HELPERS_FILE"
    source "$CLEANUP_FILE"

    SESSION="wavemill"
    ISSUE="HOK-2348"
    SLUG="task-slug"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    MILL_LOG_FILE="$CASE_DIR/mill.log"

    cat > "$STATE_FILE" <<EOF
{"tasks":{"$ISSUE":{"windowId":"@31"}}}
EOF
    : > "$MILL_LOG_FILE"

    declare -Ag CLEANED=()
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    ATTENTION=""
    REMOVE_STATE_CALLS=0
    KILLED=0

    archive_stage_artifacts() { :; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION="$2"; }
    remove_task_state() { REMOVE_STATE_CALLS=$((REMOVE_STATE_CALLS + 1)); }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
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
              if [[ "$TEST_CASE" == "dead-pane-success" && "$KILLED" -eq 1 ]]; then
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
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
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
