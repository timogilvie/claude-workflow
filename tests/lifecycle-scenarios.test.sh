#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/lifecycle"

PASS=0
FAIL=0
SCENARIOS=()

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

register_lifecycle_scenario() {
  SCENARIOS+=("$1")
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    echo "    output:"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    echo "    output:"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    fail "$name"
  fi
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

check_file_exists() {
  local name="$1" path="$2"
  if [[ -e "$path" ]]; then
    pass "$name"
  else
    echo "    missing file: $path"
    fail "$name"
  fi
}

check_file_absent() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    pass "$name"
  else
    echo "    unexpected file: $path"
    fail "$name"
  fi
}

check_file_content() {
  local name="$1" expected="$2" path="$3"
  local actual=""
  if [[ -f "$path" ]]; then
    actual="$(<"$path")"
  fi
  check_eq "$name" "$expected" "$actual"
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
trap 'rm -rf "$TEST_TMP"' EXIT

MONITOR_FUNC_FILE="$TEST_TMP/lifecycle-controller-functions.sh"
for fn in \
  approve_plan \
  validate_planning_phase_output \
  check_stage_aborted \
  check_stage_complete \
  check_stage_awaiting_user \
  resolve_phase \
  _persist_phase \
  ready_base_sha \
  get_main_head_sha \
  ready_stage_allows_merge \
  ready_stage_warn_bypass_once \
  ready_stage_pending_verdict \
  ready_conflict_launch_head \
  ready_conflict_attention_head \
  clear_ready_conflict_attention \
  clear_ready_conflict_markers \
  ready_conflict_recheck_interval_seconds \
  ready_conflict_recheck_due \
  write_ready_conflict_recheck_at \
  ready_conflict_pr_is_clean \
  ready_remediation_launch_head \
  inject_depends_on_pr_block \
  dispatch_queued_children_for_parent \
  monitor_issue_state
do
  extract_function "$MILL_SCRIPT" "$fn" >> "$MONITOR_FUNC_FILE"
  printf '\n' >> "$MONITOR_FUNC_FILE"
done

if [[ ! -s "$MONITOR_FUNC_FILE" ]]; then
  echo "Could not extract lifecycle controller functions"
  exit 1
fi

run_lifecycle_scenario() {
  local scenario_name="$1"
  local scenario_dir="$TEST_TMP/$scenario_name"
  mkdir -p "$scenario_dir"

  SCENARIO_NAME="$scenario_name" \
  SCENARIO_DIR="$scenario_dir" \
  MONITOR_FUNC_FILE="$MONITOR_FUNC_FILE" \
  FIXTURE_DIR="$FIXTURE_DIR" \
  bash -c '
    set -euo pipefail
    source "$MONITOR_FUNC_FILE"
    register_lifecycle_scenario() { :; }
    for scenario_file in "$FIXTURE_DIR"/*.sh; do
      # shellcheck source=/dev/null
      source "$scenario_file"
    done

    lifecycle_default_state() {
      declare -gAg BRANCH_BY_ISSUE=()
      declare -gAg SLUG_BY_ISSUE=()
      declare -gAg PR_BY_ISSUE=()
      declare -gAg CLEANED=()

      ISSUE="HOK-1294"
      SLUG="$SCENARIO_NAME"
      BRANCH="task/$SCENARIO_NAME"
      PR=""
      FOUND_PR=""
      SESSION="lifecycle-scenarios"
      WORKTREE_ROOT="$SCENARIO_DIR/worktrees"
      REPO_DIR="$SCENARIO_DIR/repo"
      BASE_BRANCH="main"
      AGENT_CMD="codex"
      STATE_FILE="$SCENARIO_DIR/workflow-state.json"
      API_TIMEOUT=5
      AUTO_EVAL="false"
      REQUIRE_CONFIRM="false"
      QUIT_REQUESTED="false"
      FORCE_MODEL=""
      TOOLS_DIR="$SCENARIO_DIR/tools"
      LIB_DIR="$SCENARIO_DIR/lib"
      STATUS_LOG_FILE="$SCENARIO_DIR/status.log"

      CURRENT_PHASE="planning"
      CURRENT_AGENT="codex"
      TASK_STATUS=""
      TASK_TITLE="Lifecycle Scenario"
      EVAL_COMPLETED="false"
      PR_STATUS="OPEN"
      VALIDATE_MERGED="false"
      LINEAR_UPDATES="false"
      LINEAR_COMPLETED="false"
      PANE_ALIVE="false"
      ABORTED="false"
      REVIEWER_MODEL="claude-sonnet-4-5-20250929"
      CODER_MODEL="claude-opus-4-6"
      REVIEW_MODE="static"
      CODE_DEPTH="medium"
      CHALLENGE_TASK="false"
      CHALLENGE_SIBLING_PR=""
      CHALLENGE_SIBLING_MERGED="false"
      CLEANUP_CLOSED_PR="false"
      MONITOR_ITERATIONS=1

      active_count=0
      ATTENTION_STATE=""
      WRITE_STAGE_CALLS=""
      SET_PHASE_CALLS=""
      READY_LAUNCH_COUNT=0
      READY_LAUNCH_ARGS=""
      GH_PR_VIEW_CALLS=0
      GH_PR_VIEW_MERGEABLE=""
      GH_PR_VIEW_MERGE_STATE=""
      MAIN_SHA_RETURN=""
      CODING_LAUNCH_COUNT=0
      REVIEW_LAUNCH_COUNT=0
      RESTORE_COUNT=0
      CLEANUP_COUNT=0
      CLEANUP_CALLS=""
      LINEAR_CALLS=""
      SAVE_TASK_CALLS=""
      POST_MERGE_EVAL_CALLS=""
      LOG_OUTPUT=""
      READY_ATTENTION_CALLS=""
      SAVE_MIGRATION_CALLS=""

      mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG" "$REPO_DIR" "$TOOLS_DIR" "$LIB_DIR"
      FEATURE_DIR="$WORKTREE_ROOT/$SLUG/features/$SLUG"
      WT_DIR="$WORKTREE_ROOT/$SLUG"
      printf "{\"title\":\"%s\"}\n" "$TASK_TITLE" > "/tmp/${SESSION}-${ISSUE}-issue.json"
      printf "{\"tasks\":{}}\n" > "$STATE_FILE"

      BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
      SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    }

    create_git_worktree() {
      mkdir -p "$WT_DIR"
      git -C "$WT_DIR" init -q
      git -C "$WT_DIR" config user.email "tests@example.com"
      git -C "$WT_DIR" config user.name "Wavemill Tests"
      mkdir -p "$FEATURE_DIR"
      printf "initial\n" > "$WT_DIR/README.md"
      git -C "$WT_DIR" add README.md
      git -C "$WT_DIR" commit -q -m "Initial commit"
    }

    log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$*"; }
    log_warn() { printf -v LOG_OUTPUT "%sWARN:%s\n" "$LOG_OUTPUT" "$*"; }
    log_error() { printf -v LOG_OUTPUT "%sERROR:%s\n" "$LOG_OUTPUT" "$*"; }

    read_state_value() {
      local default="${1:-}"
      shift || true
      local expr="${*: -1}"
      local value
      case "$expr" in
        *".tasks["*"].agent"*) printf "%s\n" "$CURRENT_AGENT" ;;
        *".tasks["*"].title"*) printf "%s\n" "$TASK_TITLE" ;;
        *".tasks["*"].status"*) printf "%s\n" "$TASK_STATUS" ;;
        *".tasks["*"].evalCompleted"*) printf "%s\n" "$EVAL_COMPLETED" ;;
        *)
          if [[ -r "$STATE_FILE" ]] && value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
            printf "%s\n" "$value"
          else
            printf "%s\n" "$default"
          fi
          ;;
      esac
    }

    set_window_attention_state() { ATTENTION_STATE="$2"; }
    handle_agent_error_recovery() { :; }
    execute() { "$@" >/dev/null 2>&1 || true; }
    tmux() {
      if [[ "${1:-}" == "list-panes" && "$PANE_ALIVE" == "true" ]]; then
        printf "0\n"
        return 0
      fi
      return 1
    }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    should_update_linear_state() { [[ "$LINEAR_UPDATES" == "true" ]]; }
    linear_set_state() { printf -v LINEAR_CALLS "%s%s|%s\n" "$LINEAR_CALLS" "$1" "$2"; }
    linear_is_completed() { [[ "$LINEAR_COMPLETED" == "true" ]]; }
    get_task_meta() {
      case "${2:-}" in
        coderModel) printf "%s\n" "$CODER_MODEL" ;;
        reviewerModel) printf "%s\n" "$REVIEWER_MODEL" ;;
        reviewMode) printf "%s\n" "$REVIEW_MODE" ;;
        codeDepth) printf "%s\n" "$CODE_DEPTH" ;;
        challenge) [[ "$CHALLENGE_TASK" == "true" ]] && printf "true\n" ;;
        challengePairId) printf "%s\n" "${CHALLENGE_PAIR_ID:-}" ;;
        challengeRole) printf "%s\n" "${CHALLENGE_ROLE:-}" ;;
        challengeModel) printf "%s\n" "${CHALLENGE_MODEL:-}" ;;
        *) printf "\n" ;;
      esac
    }
    save_task_state() { printf -v SAVE_TASK_CALLS "%s%s\n" "$SAVE_TASK_CALLS" "$*"; }
    save_migration_reservation() { printf -v SAVE_MIGRATION_CALLS "%s%s|%s\n" "$SAVE_MIGRATION_CALLS" "$1" "$2"; }
    _with_timeout() { shift; "$@"; }
    gh() {
      if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
        GH_PR_VIEW_CALLS=$((GH_PR_VIEW_CALLS + 1))
        if [[ -n "${GH_PR_VIEW_MERGEABLE:-}" || -n "${GH_PR_VIEW_MERGE_STATE:-}" ]]; then
          printf '{"mergeable":"%s","mergeStateStatus":"%s"}\n' \
            "${GH_PR_VIEW_MERGEABLE:-}" \
            "${GH_PR_VIEW_MERGE_STATE:-}"
          return 0
        fi
      fi
      return 1
    }
    find_pr_for_branch() { printf "%s\n" "${FOUND_PR:-$PR}"; }
    get_task_phase() { printf "%s\n" "$CURRENT_PHASE"; }
    pr_state() {
      if [[ -n "$CHALLENGE_SIBLING_PR" && "${1:-}" == "$CHALLENGE_SIBLING_PR" ]]; then
        printf "%s\n" "${CHALLENGE_SIBLING_STATE:-OPEN}"
      else
        printf "%s\n" "$PR_STATUS"
      fi
    }
    read_stage_status() {
      local feature_dir="$1" stage="$2" result_file="$1/.${2}-result.json"
      if [[ -f "$result_file" ]]; then
        jq -r ".status // empty" "$result_file" 2>/dev/null || echo ""
      else
        echo ""
      fi
    }
    write_stage_result() {
      local feature_dir="$1" stage="$2" status="$3"
      local agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts_json="${7:-}"
      mkdir -p "$feature_dir"
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" "$WRITE_STAGE_CALLS" "$feature_dir" "$stage" "$status" "$agent" "$model" "$notes" "$artifacts_json"
      cat > "$feature_dir/.${stage}-result.json" <<JSON
{"stage":"$stage","status":"$status","agent":"$agent","model":"$model","notes":"$notes"}
JSON
    }
    set_task_phase() {
      CURRENT_PHASE="$2"
      printf -v SET_PHASE_CALLS "%s%s|%s\n" "$SET_PHASE_CALLS" "$1" "$2"
    }
    launch_planning_phase() { return 0; }
    launch_coding_phase() {
      CODING_LAUNCH_COUNT=$((CODING_LAUNCH_COUNT + 1))
      return 0
    }
    launch_review_phase() {
      REVIEW_LAUNCH_COUNT=$((REVIEW_LAUNCH_COUNT + 1))
      return 0
    }
    launch_ready_phase() {
      READY_LAUNCH_COUNT=$((READY_LAUNCH_COUNT + 1))
      READY_LAUNCH_ARGS="$*"
      return "${READY_LAUNCH_RC:-0}"
    }
    handle_phase_launch_result() { [[ "${4:-}" != "fail" ]]; }
    agent_resolve_from_model() { printf "%s\n" "${1%%-*}"; }
    resolve_phase_model() { printf "%s\n" "${2:-$3}"; }
    read_phase_config() {
      case "$2:$3" in
        coding:model) printf "%s\n" "$CODER_MODEL" ;;
        coding:depth) printf "%s\n" "$CODE_DEPTH" ;;
        review:model) printf "%s\n" "$REVIEWER_MODEL" ;;
        review:mode) printf "%s\n" "$REVIEW_MODE" ;;
        *) printf "\n" ;;
      esac
    }
    validate_coding_phase_output() { return 0; }
    restore_review_task_window() {
      RESTORE_COUNT=$((RESTORE_COUNT + 1))
      return 0
    }
    _restore_inflight_task_window_if_missing() {
      _RESTORE_STATE="none"
      return 0
    }
    validate_pr_merge() { [[ "$VALIDATE_MERGED" == "true" ]]; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    ready_remediation_launch_head() { printf "\n"; }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
      mkdir -p "$1"
      printf "%s\n" "$2" > "$1/.needs-attention"
    }
    is_challenge_task() { [[ "$CHALLENGE_TASK" == "true" ]]; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    should_cleanup_closed_pr() { [[ "$CLEANUP_CLOSED_PR" == "true" ]]; }
    get_challenge_sibling_pr() { printf "%s\n" "$CHALLENGE_SIBLING_PR"; }
    check_challenge_sibling_merged() { [[ "$CHALLENGE_SIBLING_MERGED" == "true" ]]; }
    get_main_head_sha() { printf "%s\n" "$MAIN_SHA_RETURN"; }
    transient_error_recovery_pending() { return 1; }
    phase_should_remain_active_without_pr() { return 1; }
    codex_has_pending_approval() { return 1; }
    check_pr_exists() { return 1; }
    check_routing_complete() { return 1; }
    _pane_is_dead_or_idle() { return 0; }
    cleanup_completed_task() {
      CLEANUP_COUNT=$((CLEANUP_COUNT + 1))
      printf -v CLEANUP_CALLS "%s%s\n" "$CLEANUP_CALLS" "$*"
    }
    launch_background_post_merge_eval() {
      printf -v POST_MERGE_EVAL_CALLS "%s%s\n" "$POST_MERGE_EVAL_CALLS" "$*"
      log "debug" "post-merge eval stubbed: $*"
    }

    lifecycle_default_state
    "setup_${SCENARIO_NAME}"

    for ((i = 0; i < MONITOR_ITERATIONS; i++)); do
      monitor_issue_state "$ISSUE"
    done

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    phase_summary=$(printf "%s" "$SET_PHASE_CALLS" | tr "\n" ";")
    log_summary=$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")
    cleanup_summary=$(printf "%s" "$CLEANUP_CALLS" | tr "\n" ";")
    linear_summary=$(printf "%s" "$LINEAR_CALLS" | tr "\n" ";")
    eval_summary=$(printf "%s" "$POST_MERGE_EVAL_CALLS" | tr "\n" ";")
    migration_summary=$(printf "%s" "$SAVE_MIGRATION_CALLS" | tr "\n" ";")
    printf "scenario=%s\nscenario_dir=%s\nwt_dir=%s\nfeature_dir=%s\nphase=%s\nattention=%s\nactive_count=%s\nstage_calls=%s\nphase_calls=%s\ncoding_launches=%s\nreview_launches=%s\nready_launches=%s\ngh_pr_view_calls=%s\ncleanup_count=%s\ncleanup_calls=%s\nlinear_calls=%s\npost_merge_eval_calls=%s\nsave_migration_calls=%s\nlogs=%s\n" \
      "$SCENARIO_NAME" \
      "$SCENARIO_DIR" \
      "$WT_DIR" \
      "$FEATURE_DIR" \
      "$CURRENT_PHASE" \
      "$ATTENTION_STATE" \
      "$active_count" \
      "$stage_summary" \
      "$phase_summary" \
      "$CODING_LAUNCH_COUNT" \
      "$REVIEW_LAUNCH_COUNT" \
      "$READY_LAUNCH_COUNT" \
      "$GH_PR_VIEW_CALLS" \
      "$CLEANUP_COUNT" \
      "$cleanup_summary" \
      "$linear_summary" \
      "$eval_summary" \
      "$migration_summary" \
      "$log_summary"
  '
}

for scenario_file in "$FIXTURE_DIR"/*.sh; do
  # shellcheck source=/dev/null
  source "$scenario_file"
done

echo "=== Lifecycle Golden Scenarios ==="

for scenario in "${SCENARIOS[@]}"; do
  echo ""
  echo "--- $scenario ---"
  output="$(run_lifecycle_scenario "$scenario")"
  "assert_${scenario}" "$output"
done

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
