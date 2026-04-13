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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

MONITOR_FUNC_FILE="$TEST_TMP/monitor_issue_state.sh"
extract_function "$MILL_SCRIPT" "monitor_issue_state" > "$MONITOR_FUNC_FILE"

if [[ ! -s "$MONITOR_FUNC_FILE" ]]; then
  echo "Could not extract monitor_issue_state()"
  exit 1
fi

run_monitor_case() {
  local case_name="$1"
  local case_dir="$TEST_TMP/$case_name"
  mkdir -p "$case_dir"

  CASE_NAME="$case_name" CASE_DIR="$case_dir" MONITOR_FUNC_FILE="$MONITOR_FUNC_FILE" bash -lc '
    set -euo pipefail
    shopt -s expand_aliases
    source "$MONITOR_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()

    ISSUE="HOK-1249"
    SLUG="monitor-ready"
    BRANCH="task/monitor-ready"
    PR="321"
    SESSION="ready-transition-test"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    REPO_DIR="$CASE_DIR/repo"
    BASE_BRANCH="main"
    STATE_FILE="$CASE_DIR/state.json"
    API_TIMEOUT=5
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    _CFG_READY_ENABLED="true"
    active_count=0
    CURRENT_PHASE="review"
    CURRENT_AGENT="codex"
    RESOLVED_PHASE="review"
    REVIEW_STATUS="running"
    READY_STATUS="completed"
    PR_STATUS="OPEN"
    RESTORE_SHOULD_FAIL="false"
    READY_LAUNCH_RC=0
    ABORTED="false"
    ATTENTION_STATE=""
    SET_PHASE_TO=""
    READY_LAUNCH_COUNT=0
    RESTORE_COUNT=0
    WRITE_STAGE_CALLS=""
    WRITE_READY_ATTENTION_CALLS=""
    LOG_OUTPUT=""

    mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG" "$REPO_DIR"
    FEATURE_DIR="$WORKTREE_ROOT/$SLUG/features/$SLUG"
    READY_DIR="$FEATURE_DIR/ready"
    mkdir -p "$READY_DIR"
    printf "{\"title\":\"Monitor ready transition\"}\n" > "/tmp/${SESSION}-${ISSUE}-issue.json"

    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    PR_BY_ISSUE["$ISSUE"]="$PR"

    case "$CASE_NAME" in
      review_to_ready)
        ;;
      review_ready_disabled)
        _CFG_READY_ENABLED="false"
        ;;
      ready_conflict_rerun)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected"
        ;;
      *)
        echo "unknown case: $CASE_NAME" >&2
        exit 1
        ;;
    esac

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { LOG_OUTPUT+="WARN:$*\n"; }
    read_state_value() { printf "%s\n" "${1-}"; }
    set_window_attention_state() { ATTENTION_STATE="$2"; }
    handle_agent_error_recovery() { :; }
    cleanup_completed_task() { :; }
    execute() { :; }
    tmux() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    is_challenge_task() { return 1; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    find_pr_for_branch() { printf "%s\n" "$PR"; }
    get_task_phase() { printf "%s\n" "$CURRENT_PHASE"; }
    pr_state() { printf "%s\n" "$PR_STATUS"; }
    resolve_phase() { printf "%s\n" "$RESOLVED_PHASE"; }
    read_stage_status() {
      local feature_dir="$1" stage="$2"
      if [[ "$stage" == "review" ]]; then
        printf "%s\n" "$REVIEW_STATUS"
      elif [[ "$stage" == "ready" && "$feature_dir" == "$READY_DIR" ]]; then
        printf "%s\n" "$READY_STATUS"
      else
        printf "\n"
      fi
    }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS '%s%s\n' \
        "$WRITE_STAGE_CALLS" \
        "${1-}|${2-}|${3-}|${4-}|${5-}|${6-}|${7-}"
    }
    set_task_phase() {
      CURRENT_PHASE="$2"
      SET_PHASE_TO="$2"
    }
    launch_ready_phase() {
      READY_LAUNCH_COUNT=$((READY_LAUNCH_COUNT + 1))
      READY_LAUNCH_ARGS="$*"
      return "$READY_LAUNCH_RC"
    }
    check_stage_aborted() { [[ "$ABORTED" == "true" ]]; }
    restore_review_task_window() {
      RESTORE_COUNT=$((RESTORE_COUNT + 1))
      [[ "$RESTORE_SHOULD_FAIL" != "true" ]]
    }
    validate_pr_merge() { return 1; }
    write_ready_attention_file() {
      printf -v WRITE_READY_ATTENTION_CALLS '%s%s\n' "$WRITE_READY_ATTENTION_CALLS" "$*"
    }
    ready_state_dir() { printf "%s\n" "$READY_DIR"; }
    ready_conflict_launch_head() {
      if [[ "$CASE_NAME" == "ready_conflict_rerun" ]]; then
        printf "%s\n" "old-head"
      fi
    }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "current-head"
        return 0
      fi
      return 1
    }
    should_cleanup_closed_pr() { return 1; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }
    transient_error_recovery_pending() { return 1; }
    phase_should_remain_active_without_pr() { return 1; }
    codex_has_pending_approval() { return 1; }

    monitor_issue_state "$ISSUE"

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    printf "phase=%s\nattention=%s\nready_launches=%s\nrestore_calls=%s\nactive_count=%s\nwrite_stage=%s\nready_args=%s\n" \
      "$CURRENT_PHASE" \
      "$ATTENTION_STATE" \
      "$READY_LAUNCH_COUNT" \
      "$RESTORE_COUNT" \
      "$active_count" \
      "$stage_summary" \
      "${READY_LAUNCH_ARGS:-}"
  '
}

echo "=== Monitor Ready Transition ==="

review_to_ready_output="$(run_monitor_case review_to_ready)"
check_contains "review with open PR transitions to ready" "$review_to_ready_output" "phase=ready"
check_contains "review with open PR launches ready checks" "$review_to_ready_output" "ready_launches=1"
check_contains "review with open PR does not only restore review window" "$review_to_ready_output" "restore_calls=0"
check_contains "review with open PR records completed review stage" "$review_to_ready_output" "|review|completed|"

review_disabled_output="$(run_monitor_case review_ready_disabled)"
check_contains "review keeps phase when ready disabled" "$review_disabled_output" "phase=review"
check_contains "review restores window when ready disabled" "$review_disabled_output" "restore_calls=1"
check_contains "review does not launch ready when disabled" "$review_disabled_output" "ready_launches=0"

ready_conflict_output="$(run_monitor_case ready_conflict_rerun)"
check_contains "ready conflict rerun keeps task in ready" "$ready_conflict_output" "phase=ready"
check_contains "ready conflict rerun launches ready checks again" "$ready_conflict_output" "ready_launches=1"
check_contains "ready conflict rerun leaves attention on task" "$ready_conflict_output" "attention=needs-user"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
