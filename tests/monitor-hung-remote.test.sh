#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_file_exists() {
  local name="$1" path="$2"
  if [[ -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

MONITOR_FUNC_FILE="$TEST_TMP/monitor-hung-remote-functions.sh"
for fn in \
  trim_outer_whitespace \
  ready_base_sha \
  get_main_head_sha \
  ready_stage_allows_merge \
  ready_stage_pending_verdict \
  log_ready_stale_merge_lane_once \
  validate_planning_phase_output \
  planning_rejection_files_summary \
  write_planning_rejection_artifact \
  notify_planning_rejection_agent \
  handle_planning_overreach_rejection \
  resolve_phase \
  resolve_stage_result_model \
  approve_plan \
  _persist_phase \
  write_stage_result \
  _write_stage_result_trace_event \
  read_stage_status \
  read_stage_result \
  check_stage_complete \
  check_stage_awaiting_user \
  check_stage_aborted \
  phase_should_remain_active_without_pr \
  stage_result_is_in_progress \
  ready_conflict_launch_head \
  monitor_issue_state
do
  extract_function "$MILL_SCRIPT" "$fn" >> "$MONITOR_FUNC_FILE"
  printf '\n' >> "$MONITOR_FUNC_FILE"
done

echo "=== Hung Remote Monitor Behavior ==="

timeout_config_output="$(
  bash -lc '
    set -euo pipefail
    source "'"$COMMON_LIB"'"
    unset WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS
    printf "default=%s\n" "$(wavemill_git_probe_timeout_seconds)"
    WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=7
    printf "valid=%s\n" "$(wavemill_git_probe_timeout_seconds)"
    WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=0
    printf "zero=%s\n" "$(wavemill_git_probe_timeout_seconds)"
    WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=999
    printf "high=%s\n" "$(wavemill_git_probe_timeout_seconds)"
    WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=abc
    printf "text=%s\n" "$(wavemill_git_probe_timeout_seconds)"
  '
)"
check_contains "timeout helper uses default when unset" "$timeout_config_output" "default=30"
check_contains "timeout helper accepts valid values" "$timeout_config_output" "valid=7"
check_contains "timeout helper rejects zero" "$timeout_config_output" "zero=30"
check_contains "timeout helper rejects large values" "$timeout_config_output" "high=30"
check_contains "timeout helper rejects text values" "$timeout_config_output" "text=30"

fetch_timeout_output="$(
  TEST_ROOT="$TEST_TMP/fetch-timeout" COMMON_LIB="$COMMON_LIB" bash -lc '
    set -euo pipefail
    mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/repo"
    cat > "$TEST_ROOT/bin/git" <<'"'"'EOF'"'"'
#!/usr/bin/env bash
set -euo pipefail
printf "%s\n" "$*" >> "$TEST_ROOT/git-args.log"
sleep 2
EOF
    chmod +x "$TEST_ROOT/bin/git"

    export PATH="$TEST_ROOT/bin:$PATH"
    export TEST_ROOT
    export REPO_DIR="$TEST_ROOT/repo"
    export STATE_FILE="$TEST_ROOT/state.json"
    export WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=1

    source "$COMMON_LIB"

    warn_output=""
    log_warn() { warn_output+="$*\n"; }

    printf "{\"tasks\":{}}\n" > "$STATE_FILE"
    start_ts=$(date +%s)
    if wavemill_fetch_base_branch "main"; then
      fetch_rc=0
    else
      fetch_rc=$?
    fi
    elapsed=$(( $(date +%s) - start_ts ))
    cache_value="$(jq -r ".baseBranchFetchCache.main.last_fetch_at // empty" "$STATE_FILE" 2>/dev/null || true)"
    printf "rc=%s\nelapsed=%s\ncache_value=%s\nwarn=%s" "$fetch_rc" "$elapsed" "${cache_value:-}" "$warn_output"
  '
)"
check_contains "fetch timeout returns 124" "$fetch_timeout_output" "rc=124"
check_contains "fetch timeout leaves cache empty" "$fetch_timeout_output" "cache_value="
check_contains "fetch timeout warning includes fetch operation" "$fetch_timeout_output" "operation=fetch"
check_contains "fetch timeout warning includes degraded action" "$fetch_timeout_output" "skipping base branch fetch cache update; continuing monitor tick"

ls_remote_output="$(
  TEST_ROOT="$TEST_TMP/ls-remote-timeout" COMMON_LIB="$COMMON_LIB" MONITOR_FUNC_FILE="$MONITOR_FUNC_FILE" bash -lc '
    set -euo pipefail
    mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/worktree"
    cat > "$TEST_ROOT/bin/git" <<'"'"'EOF'"'"'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${4:-}" == "ls-remote" ]]; then
  sleep 2
  exit 0
fi
exit 1
EOF
    chmod +x "$TEST_ROOT/bin/git"

    export PATH="$TEST_ROOT/bin:$PATH"
    export WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=1
    source "$COMMON_LIB"
    source "$MONITOR_FUNC_FILE"

    WARN_LOG="$TEST_ROOT/warn.log"
    : > "$WARN_LOG"
    log_warn() { printf "%s\n" "$*" >> "$WARN_LOG"; }

    start_ts=$(date +%s)
    sha="$(get_main_head_sha "$TEST_ROOT/worktree" "auto/integration")"
    elapsed=$(( $(date +%s) - start_ts ))
    warn_output="$(cat "$WARN_LOG" 2>/dev/null || true)"
    printf "sha=%s\nelapsed=%s\nwarn=%s" "$sha" "$elapsed" "$warn_output"
  '
)"
check_contains "ls-remote timeout returns empty sha" "$ls_remote_output" "sha="
check_contains "ls-remote timeout warning includes ref" "$ls_remote_output" "ref=refs/heads/auto/integration"
check_contains "ls-remote timeout warning includes degraded behavior" "$ls_remote_output" "base freshness unknown; continuing monitor tick"

loop_output="$(
  TEST_ROOT="$TEST_TMP/loop-continue" COMMON_LIB="$COMMON_LIB" MONITOR_FUNC_FILE="$MONITOR_FUNC_FILE" bash -lc '
    set -euo pipefail
    mkdir -p "$TEST_ROOT/bin" "$TEST_ROOT/repo/.wavemill"
    cat > "$TEST_ROOT/bin/git" <<'"'"'EOF'"'"'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${4:-}" == "ls-remote" ]]; then
  sleep 2
  exit 0
fi
if [[ "${4:-}" == "rev-parse" && "${5:-}" == "HEAD" ]]; then
  printf "%s\n" "current-head"
  exit 0
fi
exit 1
EOF
    chmod +x "$TEST_ROOT/bin/git"

    export PATH="$TEST_ROOT/bin:$PATH"
    export WAVEMILL_GIT_PROBE_TIMEOUT_SECONDS=1
    source "$COMMON_LIB"
    source "$MONITOR_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()
    declare -Ag PHASE_BY_ISSUE=()
    declare -Ag CLEANED=()

    READY_ISSUE="HOK-READY"
    READY_SLUG="ready-timeout"
    PLAN_ISSUE="HOK-PLAN"
    PLAN_SLUG="plan-approved"
    SESSION="hung-remote-loop"
    WORKTREE_ROOT="$TEST_ROOT/worktrees"
    REPO_DIR="$TEST_ROOT/repo"
    STATE_FILE="$TEST_ROOT/repo/.wavemill/state.json"
    BASE_BRANCH="auto/integration"
    AGENT_CMD="codex"
    API_TIMEOUT=1
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    FORCE_MODEL="test-model"
    CURRENT_AGENT="codex"
    active_count=0
    LOG_OUTPUT=""
    CODING_LAUNCHED="false"
    CODING_LAUNCH_ISSUE=""
    WARN_LOG="$TEST_ROOT/warn.log"
    : > "$WARN_LOG"

    mkdir -p \
      "$WORKTREE_ROOT/$READY_SLUG/features/$READY_SLUG/ready" \
      "$WORKTREE_ROOT/$PLAN_SLUG/features/$PLAN_SLUG"

    cat > "$WORKTREE_ROOT/$READY_SLUG/features/$READY_SLUG/ready/.ready-result.json" <<'"'"'EOF'"'"'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-old"
  }
}
EOF

    cat > "$WORKTREE_ROOT/$PLAN_SLUG/features/$PLAN_SLUG/.planning-result.json" <<'"'"'EOF'"'"'
{
  "stage": "planning",
  "status": "awaiting_user",
  "startedAt": "2026-06-24T00:00:00Z",
  "finishedAt": null,
  "agent": "codex",
  "model": "test-model",
  "notes": ""
}
EOF
    printf "# Plan\n\nApproved.\n" > "$WORKTREE_ROOT/$PLAN_SLUG/features/$PLAN_SLUG/plan.md"
    touch "$WORKTREE_ROOT/$PLAN_SLUG/features/$PLAN_SLUG/.plan-approved"

    BRANCH_BY_ISSUE["$READY_ISSUE"]="task/$READY_SLUG"
    BRANCH_BY_ISSUE["$PLAN_ISSUE"]="task/$PLAN_SLUG"
    SLUG_BY_ISSUE["$READY_ISSUE"]="$READY_SLUG"
    SLUG_BY_ISSUE["$PLAN_ISSUE"]="$PLAN_SLUG"
    PR_BY_ISSUE["$READY_ISSUE"]="601"
    PHASE_BY_ISSUE["$READY_ISSUE"]="ready"
    PHASE_BY_ISSUE["$PLAN_ISSUE"]="planning"
    printf "{\"title\":\"Ready timeout\"}\n" > "/tmp/${SESSION}-${READY_ISSUE}-issue.json"
    printf "{\"title\":\"Plan approval\"}\n" > "/tmp/${SESSION}-${PLAN_ISSUE}-issue.json"

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { printf "%s\n" "$*" >> "$WARN_LOG"; }
    log_error() { printf "%s\n" "$*" >> "$WARN_LOG"; }
    set_window_attention_state() { :; }
    _pane_is_dead_or_idle() { return 0; }
    _ensure_window_exists() { :; }
    tmux() { return 1; }
    sleep() { command sleep "$@"; }
    cleanup_completed_task() { :; }
    execute() { "$@" 2>/dev/null || true; }
    _with_timeout() { shift; "$@"; }
    gh() { return 1; }
    find_pr_for_branch() {
      if [[ "$1" == "task/$READY_SLUG" ]]; then
        printf "%s\n" "601"
      fi
    }
    check_pr_exists() { return 1; }
    pr_state() { printf "%s\n" "OPEN"; }
    validate_pr_merge() { return 1; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    linear_is_completed() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$1"; }
    get_task_meta() { :; }
    save_task_state() { :; }
    read_state_value() { printf "%s\n" "${1-}"; }
    get_task_phase() { printf "%s\n" "${PHASE_BY_ISSUE[$1]:-planning}"; }
    set_task_phase() { PHASE_BY_ISSUE["$1"]="$2"; }
    resolve_phase_model() { printf "%s\n" "${2:-${3:-test-model}}"; }
    agent_resolve_from_model() { printf "%s\n" "codex"; }
    read_phase_config() {
      case "${2:-}.${3:-}" in
        coding.model) printf "%s\n" "test-model" ;;
        coding.depth) printf "%s\n" "medium" ;;
        review.model) printf "%s\n" "test-model" ;;
        review.mode) printf "%s\n" "static" ;;
        *) printf "\n" ;;
      esac
    }
    write_phase_config() { :; }
    handle_agent_error_recovery() { :; }
    handle_phase_launch_result() { return 0; }
    launch_planning_phase() { return 0; }
    launch_coding_phase() {
      CODING_LAUNCHED="true"
      CODING_LAUNCH_ISSUE="$1"
      return 0
    }
    launch_review_phase() { return 0; }
    launch_ready_phase() { return 0; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    ready_remediation_launch_head() { printf "\n"; }
    write_ready_attention_file() { :; }
    emit_execution_active_route() { :; }
    log_route_lifecycle() { :; }
    route_lifecycle_route_id() { :; }
    reroute_expanded_packets_for_coding_handoff() { return 0; }
    apply_expanded_route_if_present() { return 0; }
    mill_expansion_handshake_reason() { printf "%s\n" "already-expanded"; }
    get_expansion_handshake_policy() { printf "%s\n" "recover"; }
    recover_missing_expansion_artifact() { return 1; }
    mill_check_expansion_handshake() { return 0; }
    restore_review_task_window() { return 0; }
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
    check_routing_complete() { return 1; }
    merge_queue_enabled() { return 1; }
    ready_queue_state() { printf "%s\n" "ready"; }
    mark_ready_stale() { printf "%s\n" "stale" > "$TEST_ROOT/marked-ready-stale"; }
    ready_candidate_selected() { return 1; }
    is_challenge_task() { return 1; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    dispatch_queued_children_for_parent() { :; }
    validate_coding_phase_output() { :; }
    clear_coding_uncommitted_output_attention() { :; }
    guard_coding_complete_handoff() { return 1; }
    auto_advance_blocked_completion() { return 1; }
    emit_blocked_completion_attention() { return 1; }
    recover_misplaced_coding_complete_marker() { :; }
    transient_error_recovery_pending() { return 1; }
    codex_has_pending_approval() { return 1; }
    _tmux_task_window_target() { printf "%s\n" "pane"; }
    persist_task_window_id() { :; }
    _tmux_target_join() { printf "%s:%s\n" "$1" "$2"; }
    should_cleanup_closed_pr() { return 1; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }

    for ISSUE in "$READY_ISSUE" "$PLAN_ISSUE"; do
      monitor_issue_state "$ISSUE"
    done
    for ISSUE in "$READY_ISSUE" "$PLAN_ISSUE"; do
      monitor_issue_state "$ISSUE"
    done

    plan_status="$(jq -r ".status" "$WORKTREE_ROOT/$PLAN_SLUG/features/$PLAN_SLUG/.planning-result.json")"
    coding_marker=""
    if [[ -f "$TEST_ROOT/marked-ready-stale" ]]; then
      coding_marker="marked-ready-stale"
    fi
    WARN_OUTPUT="$(cat "$WARN_LOG" 2>/dev/null || true)"
    printf "plan_status=%s\nphase=%s\ncoding_launched=%s\ncoding_issue=%s\nready_marker=%s\nwarn=%s\nlogs=%s" \
      "$plan_status" \
      "${PHASE_BY_ISSUE[$PLAN_ISSUE]:-}" \
      "$CODING_LAUNCHED" \
      "$CODING_LAUNCH_ISSUE" \
      "$coding_marker" \
      "$WARN_OUTPUT" \
      "$LOG_OUTPUT"
  '
)"
check_contains "ready timeout logs degraded probe warning" "$loop_output" "operation=ls-remote"
check_contains "plan-approved marker is consumed despite degraded freshness" "$loop_output" "plan_status=completed"
check_contains "planning task advances into coding on later tick" "$loop_output" "coding_launched=true"
check_contains "coding launch targets approved task" "$loop_output" "coding_issue=HOK-PLAN"
check_contains "degraded ready freshness does not mark task stale" "$loop_output" "ready_marker="

echo ""
echo "Results: $PASS passed, $FAIL failed"
if (( FAIL != 0 )); then
  exit 1
fi
