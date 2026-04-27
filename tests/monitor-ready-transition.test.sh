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
extract_function "$MILL_SCRIPT" "ready_base_sha" > "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "get_main_head_sha" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_stage_allows_merge" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_stage_warn_bypass_once" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_stage_pending_verdict" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_remediation_launch_head" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_conflict_attention_head" >> "$MONITOR_FUNC_FILE"
extract_function "$MILL_SCRIPT" "monitor_issue_state" >> "$MONITOR_FUNC_FILE"

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
    declare -Ag CLEANED=()

    ISSUE="HOK-1249"
    SLUG="monitor-ready"
    BRANCH="task/monitor-ready"
    PR="321"
    FOUND_PR=""
    SESSION="ready-transition-test"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    REPO_DIR="$CASE_DIR/repo"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    STATE_FILE="$CASE_DIR/state.json"
    API_TIMEOUT=5
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    active_count=0
    CURRENT_PHASE="review"
    CURRENT_AGENT="codex"
    RESOLVED_PHASE="review"
    REVIEW_STATUS="running"
    READY_STATUS="completed"
    PR_STATUS="OPEN"
    VALIDATE_MERGED="false"
    RESTORE_SHOULD_FAIL="false"
    READY_LAUNCH_RC=0
    ABORTED="false"
    CLEANUP_CLOSED_PR="false"
    ATTENTION_STATE=""
    SET_PHASE_TO=""
    READY_LAUNCH_COUNT=0
    RESTORE_COUNT=0
    CLEANUP_COUNT=0
    INVOKE_COUNT=1
    WRITE_STAGE_CALLS=""
    WRITE_READY_ATTENTION_CALLS=""
    SAVE_TASK_STATE_CALLS=""
    LOG_OUTPUT=""
    MAIN_SHA_RETURN="current-main-sha"

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
      ready_conflict_rerun)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected"
        ;;
      ready_conflict_attention_already_reported)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected" "$READY_DIR/.conflict-attention-reported"
        printf "%s\n" "current-head" > "$READY_DIR/.conflict-attention-head"
        ;;
      ready_conflict_attention_different_head)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        touch "$READY_DIR/.conflict-detected" "$READY_DIR/.conflict-attention-reported"
        printf "%s\n" "old-head" > "$READY_DIR/.conflict-attention-head"
        ;;
      ready_pending_repolls_ci)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=4
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_pending_transitions_to_pass)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=0
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_pending_failure_needs_user)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=1
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
        ;;
      ready_remediation_repolls_active)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        READY_LAUNCH_RC=5
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending","remediationAttempts":1,"remediationLaunchHead":"old-head"}}
JSON
        ;;
      ready_remediation_inflight_same_head)
        CURRENT_PHASE="ready"
        READY_STATUS="running"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"fail","remediationAttempts":1,"remediationLaunchHead":"current-head"}}
JSON
        ;;
      ready_conflict_merged)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        touch "$READY_DIR/.conflict-detected"
        printf "%s\n" "{\"status\":\"completed\",\"artifacts\":{\"verdict\":\"pass\"}}" > "$READY_DIR/.ready-result.json"
        ;;
      ready_closed_cleanup)
        CURRENT_PHASE="ready"
        PR_STATUS="CLOSED"
        CLEANUP_CLOSED_PR="true"
        ;;
      review_to_ready_pending)
        READY_LAUNCH_RC=4
        ;;
      merged_without_ready)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        ;;
      merged_without_ready_twice)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        INVOKE_COUNT=2
        ;;
      merged_after_ready)
        PR_STATUS="MERGED"
        VALIDATE_MERGED="true"
        printf "%s\n" "{\"status\":\"completed\",\"artifacts\":{\"verdict\":\"pass\"}}" > "$READY_DIR/.ready-result.json"
        ;;
      discovered_pr_from_coding)
        unset "PR_BY_ISSUE[$ISSUE]"
        PR=""
        FOUND_PR="321"
        CURRENT_PHASE="coding"
        ;;
      ready_stale_main_advanced)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="new-main-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-main-sha"}}
JSON
        ;;
      ready_fresh_base_sha)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="same-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"same-sha"}}
JSON
        ;;
      ready_empty_base_sha_treated_as_stale)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN="current-main-sha"
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass"}}
JSON
        ;;
      ready_main_sha_fetch_fails)
        CURRENT_PHASE="ready"
        READY_STATUS="completed"
        MAIN_SHA_RETURN=""
        cat > "$READY_DIR/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-sha"}}
JSON
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
    cleanup_completed_task() { CLEANUP_COUNT=$((CLEANUP_COUNT + 1)); }
    execute() { :; }
    tmux() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    get_task_meta() { :; }
    save_task_state() {
      printf -v SAVE_TASK_STATE_CALLS '%s%s\n' "$SAVE_TASK_STATE_CALLS" "$*"
    }
    _with_timeout() { shift; "$@"; }
    gh() { return 1; }
    is_challenge_task() { return 1; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    find_pr_for_branch() { printf "%s\n" "${FOUND_PR:-$PR}"; }
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
    validate_pr_merge() { [[ "$VALIDATE_MERGED" == "true" ]]; }
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
    get_main_head_sha() { printf "%s\n" "$MAIN_SHA_RETURN"; }
    should_cleanup_closed_pr() { [[ "$CLEANUP_CLOSED_PR" == "true" ]]; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }
    transient_error_recovery_pending() { return 1; }
    phase_should_remain_active_without_pr() { return 1; }
    codex_has_pending_approval() { return 1; }

    for ((i = 0; i < INVOKE_COUNT; i++)); do
      monitor_issue_state "$ISSUE"
    done

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    bypass_warn_count=$(printf "%s" "$LOG_OUTPUT" | grep -c "was merged before ready checks passed" || true)
    save_task_state_status=""
    if printf "%s" "$SAVE_TASK_STATE_CALLS" | grep -q " merged "; then
      save_task_state_status="merged"
    fi
    printf "phase=%s\nattention=%s\nready_launches=%s\nrestore_calls=%s\ncleanup_count=%s\nactive_count=%s\nwrite_stage=%s\nready_args=%s\nattention_calls=%s\nbypass_warn_count=%s\nsave_task_state_status=%s\n" \
      "$CURRENT_PHASE" \
      "$ATTENTION_STATE" \
      "$READY_LAUNCH_COUNT" \
      "$RESTORE_COUNT" \
      "$CLEANUP_COUNT" \
      "$active_count" \
      "$stage_summary" \
      "${READY_LAUNCH_ARGS:-}" \
      "$WRITE_READY_ATTENTION_CALLS" \
      "$bypass_warn_count" \
      "$save_task_state_status"
  '
}

echo "=== Monitor Ready Transition ==="

review_to_ready_output="$(run_monitor_case review_to_ready)"
check_contains "review with open PR transitions to ready" "$review_to_ready_output" "phase=ready"
check_contains "review with open PR launches ready checks" "$review_to_ready_output" "ready_launches=1"
check_contains "review with open PR does not only restore review window" "$review_to_ready_output" "restore_calls=0"
check_contains "review with open PR records completed review stage" "$review_to_ready_output" "|review|completed|"

ready_conflict_output="$(run_monitor_case ready_conflict_rerun)"
check_contains "ready conflict rerun keeps task in ready" "$ready_conflict_output" "phase=ready"
check_contains "ready conflict rerun launches ready checks again" "$ready_conflict_output" "ready_launches=1"
check_contains "ready conflict rerun leaves attention on task" "$ready_conflict_output" "attention=needs-user"

ready_conflict_reported_output="$(run_monitor_case ready_conflict_attention_already_reported)"
check_contains "reported conflict keeps task in ready" "$ready_conflict_reported_output" "phase=ready"
check_contains "reported conflict does not relaunch ready" "$ready_conflict_reported_output" "ready_launches=0"
check_contains "reported conflict leaves attention on task" "$ready_conflict_reported_output" "attention=needs-user"

ready_conflict_different_head_output="$(run_monitor_case ready_conflict_attention_different_head)"
check_contains "different-head conflict relaunches ready" "$ready_conflict_different_head_output" "ready_launches=1"
check_contains "different-head conflict leaves attention on task" "$ready_conflict_different_head_output" "attention=needs-user"

ready_pending_repolls_ci_output="$(run_monitor_case ready_pending_repolls_ci)"
check_contains "pending ready re-polls CI" "$ready_pending_repolls_ci_output" "ready_launches=1"
check_contains "pending ready stays in ready phase" "$ready_pending_repolls_ci_output" "phase=ready"
check_contains "pending ready does not flag user" "$ready_pending_repolls_ci_output" "attention=clear"
check_contains "pending ready holds slot active" "$ready_pending_repolls_ci_output" "active_count=1"

ready_pending_transitions_to_pass_output="$(run_monitor_case ready_pending_transitions_to_pass)"
check_contains "pending ready passes on re-poll" "$ready_pending_transitions_to_pass_output" "ready_launches=1"
check_contains "pending ready pass keeps attention clear" "$ready_pending_transitions_to_pass_output" "attention=clear"
check_contains "pending ready pass holds slot active" "$ready_pending_transitions_to_pass_output" "active_count=1"

ready_pending_failure_needs_user_output="$(run_monitor_case ready_pending_failure_needs_user)"
check_contains "pending ready failure relaunches once" "$ready_pending_failure_needs_user_output" "ready_launches=1"
check_contains "pending ready failure needs user" "$ready_pending_failure_needs_user_output" "attention=needs-user"

ready_remediation_repolls_active_output="$(run_monitor_case ready_remediation_repolls_active)"
check_contains "ready remediation rc 5 relaunches once" "$ready_remediation_repolls_active_output" "ready_launches=1"
check_contains "ready remediation rc 5 clears attention" "$ready_remediation_repolls_active_output" "attention=clear"
check_contains "ready remediation rc 5 holds slot active" "$ready_remediation_repolls_active_output" "active_count=1"

ready_remediation_inflight_same_head_output="$(run_monitor_case ready_remediation_inflight_same_head)"
check_contains "ready remediation in-flight keeps task active" "$ready_remediation_inflight_same_head_output" "active_count=1"
check_contains "ready remediation in-flight does not relaunch ready" "$ready_remediation_inflight_same_head_output" "ready_launches=0"
check_contains "ready remediation in-flight clears attention" "$ready_remediation_inflight_same_head_output" "attention=clear"

ready_conflict_merged_output="$(run_monitor_case ready_conflict_merged)"
check_contains "ready merge wins over conflict rerun" "$ready_conflict_merged_output" "cleanup_count=1"
check_contains "ready merge does not relaunch ready" "$ready_conflict_merged_output" "ready_launches=0"
check_contains "ready merge clears attention" "$ready_conflict_merged_output" "attention=clear"

ready_closed_cleanup_output="$(run_monitor_case ready_closed_cleanup)"
check_contains "ready closed PR cleans up" "$ready_closed_cleanup_output" "cleanup_count=1"
check_contains "ready closed PR clears attention" "$ready_closed_cleanup_output" "attention=clear"
check_contains "ready closed PR avoids ready relaunch" "$ready_closed_cleanup_output" "ready_launches=0"

review_to_ready_pending_output="$(run_monitor_case review_to_ready_pending)"
check_contains "pending ready checks keep task in ready" "$review_to_ready_pending_output" "phase=ready"
check_contains "pending ready checks clear attention" "$review_to_ready_pending_output" "attention=clear"
check_contains "pending ready checks count as active work" "$review_to_ready_pending_output" "active_count=1"

merged_without_ready_output="$(run_monitor_case merged_without_ready)"
check_contains "merged PR without ready pass is blocked" "$merged_without_ready_output" "attention=needs-user"
check_contains "merged PR without ready pass is not cleaned up" "$merged_without_ready_output" "cleanup_count=0"
check_contains "merged PR without ready pass writes attention" "$merged_without_ready_output" "Release Readiness Check passed"
check_contains "merged PR without ready pass persists merged state" "$merged_without_ready_output" "save_task_state_status=merged"

merged_without_ready_twice_output="$(run_monitor_case merged_without_ready_twice)"
check_contains "merged-before-ready warning logs only once across ticks" "$merged_without_ready_twice_output" "bypass_warn_count=1"
check_contains "merged-before-ready stays blocked after repeat tick" "$merged_without_ready_twice_output" "attention=needs-user"
check_contains "merged-before-ready persists merged task status on repeat tick" "$merged_without_ready_twice_output" "save_task_state_status=merged"

merged_after_ready_output="$(run_monitor_case merged_after_ready)"
check_contains "merged PR after ready pass can clean up" "$merged_after_ready_output" "cleanup_count=1"

discovered_pr_from_coding_output="$(run_monitor_case discovered_pr_from_coding)"
check_contains "newly discovered PR moves stale coding phase to ready" "$discovered_pr_from_coding_output" "phase=ready"
check_contains "newly discovered PR launches ready immediately" "$discovered_pr_from_coding_output" "ready_launches=1"
check_contains "newly discovered PR does not restore review window first" "$discovered_pr_from_coding_output" "restore_calls=0"

ready_stale_main_advanced_output="$(run_monitor_case ready_stale_main_advanced)"
check_contains "stale ready (main advanced) re-runs ready checks" "$ready_stale_main_advanced_output" "ready_launches=1"
check_contains "stale ready (main advanced) clears attention on pass" "$ready_stale_main_advanced_output" "attention=clear"
check_contains "stale ready (main advanced) holds slot active" "$ready_stale_main_advanced_output" "active_count=1"

ready_fresh_base_sha_output="$(run_monitor_case ready_fresh_base_sha)"
check_contains "fresh base SHA does not re-run ready" "$ready_fresh_base_sha_output" "ready_launches=0"
check_contains "fresh base SHA keeps task active" "$ready_fresh_base_sha_output" "active_count=1"
check_contains "fresh base SHA clears attention" "$ready_fresh_base_sha_output" "attention=clear"

ready_empty_base_sha_output="$(run_monitor_case ready_empty_base_sha_treated_as_stale)"
check_contains "empty baseSha (legacy record) treated as stale" "$ready_empty_base_sha_output" "ready_launches=1"

ready_main_sha_fetch_fails_output="$(run_monitor_case ready_main_sha_fetch_fails)"
check_contains "main SHA fetch failure skips re-check" "$ready_main_sha_fetch_fails_output" "ready_launches=0"
check_contains "main SHA fetch failure keeps task active" "$ready_main_sha_fetch_fails_output" "active_count=1"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
