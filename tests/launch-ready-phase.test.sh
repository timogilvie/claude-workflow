#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }

    $0 ~ "^" name "\\(\\) \\{" {
      capture=1
      depth=0
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

LAUNCH_FUNC_FILE="$TEST_TMP/launch_ready_phase.sh"
extract_function "$MILL_SCRIPT" "ready_conflict_attention_head" > "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "record_ready_conflict_attention" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "clear_ready_conflict_attention" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "transient_mergeability_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "increment_transient_mergeability_count" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "clear_transient_mergeability_state" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "write_ready_attention_file" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "cross_pr_revert_gate_allows_merge" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "write_transient_ready_attention_file" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "log_ready_failure_result" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "log_ready_unparseable_result" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_failure_is_actionable_for_remediation" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "ready_failed_check_summary" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "set_ready_pass_labels" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "_launch_ready_remediation_attempt" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "launch_ready_watchdog_remediation" >> "$LAUNCH_FUNC_FILE"
extract_function "$MILL_SCRIPT" "launch_ready_phase" >> "$LAUNCH_FUNC_FILE"

if [[ ! -s "$LAUNCH_FUNC_FILE" ]]; then
  echo "Could not extract launch_ready_phase()"
  exit 1
fi

run_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    SESSION="ready-phase-test-$TEST_CASE"
    TOOLS_DIR="$CASE_DIR/tools"
    AGENT_CMD="codex"
    READY_TRANSIENT_MAX_ATTEMPTS=6
    mkdir -p "$TOOLS_DIR"

    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"
    DEBUG_FILE="$(ready_debug_log_file)"
    rm -f "$DEBUG_FILE"
    trap '\''rm -f "$DEBUG_FILE"'\'' EXIT

    case "$TEST_CASE" in
      conflict_persists_after_remediation)
        touch "$STATE_DIR/.conflict-detected"
        ;;
      pass_after_remediation)
        touch "$STATE_DIR/.conflict-detected" "$STATE_DIR/.conflict-attention-reported"
        printf "%s\n" "abc123" > "$STATE_DIR/.conflict-attention-head"
        printf "%s\n" "stale attention" > "$STATE_DIR/.needs-attention"
        ;;
      unknown_capped)
        printf "%s\n" "6" > "$STATE_DIR/.transient-mergeability-count"
        ;;
      clean_after_unknown)
        printf "%s\n" "stale transient attention" > "$STATE_DIR/.needs-attention"
        : > "$STATE_DIR/.needs-attention-transient"
        printf "%s\n" "3" > "$STATE_DIR/.transient-mergeability-count"
        ;;
    esac

    WRITE_STAGE_CALLS=""
    READY_ATTENTION_CALLS=""
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    LOG_WARN_OUTPUT=""
    LAUNCH_AGENT_CALLS=0
    READY_PROMPT_CALLS=0
    READY_PROMPT_SUMMARY=""
    READY_LABEL_COUNT_FILE="$CASE_DIR/ready-label-calls"
    printf "%s\n" "0" > "$READY_LABEL_COUNT_FILE"

    _ensure_window_exists() { :; }
    ready_state_dir() { printf "%s\n" "$STATE_DIR"; }
    read_state_value() {
      if [[ "${4:-}" == *".tasks["*".model"* ]]; then
        printf "%s\n" "gpt-5.4"
        return 0
      fi
      printf "\n"
    }
    read_stage_status() {
      case "$TEST_CASE" in
        pending_re_check) printf "%s\n" "running" ;;
        already_inflight_same_head) printf "%s\n" "running" ;;
        *) printf "\n" ;;
      esac
    }
    ready_stage_pending_verdict() {
      case "$TEST_CASE" in
        pending_re_check) printf "%s\n" "pending" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_attempts() {
      case "$TEST_CASE" in
        second_remediation_launch) printf "%s\n" "1" ;;
        remediation_exhausted) printf "%s\n" "3" ;;
        pass_after_remediation) printf "%s\n" "2" ;;
        *) printf "%s\n" "0" ;;
      esac
    }
    ready_remediation_launch_head() {
      case "$TEST_CASE" in
        already_inflight_same_head) printf "%s\n" "abc123" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_enabled() {
      case "$TEST_CASE" in
        remediation_disabled) printf "%s\n" "false" ;;
        *) printf "%s\n" "true" ;;
      esac
    }
    ready_remediation_max_attempts() { printf "%s\n" "3"; }
    ready_remediation_agent_cmd() { printf "\n"; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    log_warn() { LOG_WARN_OUTPUT+="$*\n"; }
    build_conflict_resolution_prompt() { :; }
    build_ready_remediation_prompt() {
      READY_PROMPT_CALLS=$((READY_PROMPT_CALLS + 1))
      READY_PROMPT_SUMMARY="${8-}"
      printf "prompt\n"
    }
    _launch_agent_in_pane() {
      LAUNCH_AGENT_CALLS=$((LAUNCH_AGENT_CALLS + 1))
      case "$TEST_CASE" in
        remediation_launch_failure) return 1 ;;
        *) return 0 ;;
      esac
    }
    check_stage_aborted() { return 1; }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "abc123"
        return 0
      fi
      return 1
    }
    get_main_head_sha() { printf "%s\n" "main456"; }
    merge_queue_enabled() { return 1; }
    merge_queue_enrich_ready_artifacts() { printf "%s\n" "$2"; }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "${1-}" "${2-}" "${3-}" "${4-}" "${5-}" "${6-}" "${7-}"
    }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
      mkdir -p "$1"
      printf "%s\n" "$2" > "$1/.needs-attention"
    }
    cross_pr_revert_gate_allows_merge() {
      case "$TEST_CASE" in
        cross_pr_revert_blocked)
          write_ready_attention_file "$2" "PR #$4 removes files from #437 without explicit acknowledgement. Affected files: strategy.txt."
          log "status" "⛔ $1 → Cross-PR revert guard blocked ready phase for PR #$4"
          return 1
          ;;
        cross_pr_revert_error)
          write_ready_attention_file "$2" "Cross-PR revert guard failed (tool error) for PR #$4."
          log_error "  Cross-PR revert guard failed for $1 (PR #$4)"
          return 1
          ;;
        *)
          return 0
          ;;
      esac
    }
    npx() {
      if [[ "${1:-}" != "tsx" ]]; then
        return 1
      fi

      if [[ "${2:-}" == "$TOOLS_DIR/check-cross-pr-reverts.ts" ]]; then
        case "$TEST_CASE" in
          cross_pr_revert_blocked)
            printf "%s\n" "{\"blocked\":true,\"reverts\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}],\"acknowledged\":[],\"unacknowledged\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}]}"
            return 1
            ;;
          cross_pr_revert_error)
            return 2
            ;;
          *)
            printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[]}"
            return 0
            ;;
        esac
      fi

      if [[ "${2:-}" == "$TOOLS_DIR/set-pr-ready-label.ts" ]]; then
        printf "%s\n" "$(( $(cat "$READY_LABEL_COUNT_FILE") + 1 ))" > "$READY_LABEL_COUNT_FILE"
        case "$TEST_CASE" in
          ready_label_failure) return 1 ;;
          *) printf "Restored ready labels for PR #%s\n" "${3:-304}"; return 0 ;;
        esac
      fi

      case "$TEST_CASE" in
        pending|pending_re_check)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pending\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pending\",\"message\":\"2 CI check(s) still running\",\"details\":{\"pendingChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"QUEUED\"},{\"name\":\"Check Lifecycle Paths\",\"state\":\"QUEUED\"}],\"totalChecks\":2}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"CI checks still in progress - will retry\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 2
          ;;
        pass_after_remediation)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        ready_label_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        unknown_first|unknown_capped)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"UNKNOWN\",\"message\":\"GitHub is still computing mergeability\",\"mergeable\":\"UNKNOWN\",\"mergeStateStatus\":\"UNKNOWN\",\"attempts\":3}}"
          return 0
          ;;
        error_first)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"ERROR\",\"message\":\"Unable to fetch mergeability from GitHub\",\"attempts\":3,\"error\":\"HTTP 504\"}}"
          return 0
          ;;
        clean_after_unknown)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        clean_with_stderr)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          return 0
          ;;
        fail_with_stderr)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          printf "%s\n" "TypeError: ready crashed" >&2
          return 1
          ;;
        remediation_disabled|remediation_launch|second_remediation_launch|remediation_exhausted|remediation_launch_failure|already_inflight_same_head)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_named_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"lint\",\"status\":\"fail\",\"message\":\"eslint failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Lint failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_compound_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"fail\",\"message\":\"1 CI check(s) failing\",\"details\":{\"failedChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"FAILURE\"}],\"pendingChecks\":[],\"totalChecks\":3}},{\"name\":\"tests\",\"status\":\"fail\",\"message\":\"unit tests failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Multiple checks failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        actionable_message_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"ci-suite\",\"status\":\"fail\",\"message\":\"Shell and Unit Tests failed\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"CI suite failed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        conflict_persists_after_remediation)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"merge-conflict\",\"status\":\"fail\",\"message\":\"PR has conflicts\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"Merge conflicts detected\",\"mergeConflict\":{\"status\":\"CONFLICTED\",\"message\":\"PR #304 has conflicts with main\",\"mergeable\":\"CONFLICTING\",\"mergeStateStatus\":\"DIRTY\",\"attempts\":1}}"
          printf "%s\n" "⚠️  MERGE CONFLICT: PR #304 has conflicts with main" >&2
          return 1
          ;;
        non_ci_failure)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"fail\",\"checks\":[{\"name\":\"release-requirements\",\"status\":\"fail\",\"message\":\"Manual release steps missing\",\"details\":{}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"One or more checks failed - not safe to merge\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
          return 1
          ;;
        *)
          return 1
          ;;
      esac
    }

    set +e
    launch_ready_phase "HOK-1300" "fix-failing-ci-tests" "Fix failing CI tests" "$WT_DIR" "task/fix-failing-ci-tests" "main" "304"
    rc=$?
    set -e

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    attention_summary=$(printf "%s" "$READY_ATTENTION_CALLS" | tr "\n" ";")
    attention_count=0
    [[ -n "$READY_ATTENTION_CALLS" ]] && attention_count=$(printf "%s" "$READY_ATTENTION_CALLS" | grep -c .)
    error_count=0
    [[ -n "$LOG_ERROR_OUTPUT" ]] && error_count=$(printf "%s" "$LOG_ERROR_OUTPUT" | grep -c .)
    conflict_attention_head=""
    [[ -f "$STATE_DIR/.conflict-attention-head" ]] && conflict_attention_head=$(cat "$STATE_DIR/.conflict-attention-head")
    conflict_attention_reported="absent"
    [[ -f "$STATE_DIR/.conflict-attention-reported" ]] && conflict_attention_reported="present"
    conflict_detected="absent"
    [[ -f "$STATE_DIR/.conflict-detected" ]] && conflict_detected="present"
    needs_attention="absent"
    [[ -f "$STATE_DIR/.needs-attention" ]] && needs_attention="present"
    transient_attention="absent"
    [[ -f "$STATE_DIR/.needs-attention-transient" ]] && transient_attention="present"
    transient_count="$(cat "$STATE_DIR/.transient-mergeability-count" 2>/dev/null || echo "")"
    ready_label_calls="$(cat "$READY_LABEL_COUNT_FILE" 2>/dev/null || echo "0")"

    debug_line_count=0
    [[ -f "$DEBUG_FILE" ]] && debug_line_count=$(wc -l < "$DEBUG_FILE" | tr -d " ")
    debug_payload=""
    [[ -f "$DEBUG_FILE" ]] && debug_payload=$(cat "$DEBUG_FILE")

    printf "rc=%s\nstage_calls=%s\nattention_calls=%s\nattention_count=%s\nlaunch_calls=%s\nprompt_calls=%s\nerror_count=%s\nlogs=%s\nwarn_logs=%s\nerror_payload=%s\ndebug_file=%s\ndebug_lines=%s\ndebug_payload=%s\nconflict_attention_head=%s\nconflict_attention_reported=%s\nconflict_detected=%s\nneeds_attention=%s\ntransient_attention=%s\ntransient_count=%s\n" \
      "$rc" "$stage_summary" "$attention_summary" "$attention_count" "$LAUNCH_AGENT_CALLS" "$READY_PROMPT_CALLS" "$error_count" "$LOG_OUTPUT" "$LOG_WARN_OUTPUT" "$LOG_ERROR_OUTPUT" "$DEBUG_FILE" "$debug_line_count" "$debug_payload" "$conflict_attention_head" "$conflict_attention_reported" "$conflict_detected" "$needs_attention" "$transient_attention" "$transient_count"
    printf "ready_label_calls=%s\n" "$ready_label_calls"
    printf "prompt_summary=%s\n" "$READY_PROMPT_SUMMARY"
  ' 2>&1
}

run_watchdog_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/watchdog-$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    SESSION="ready-watchdog-test-$TEST_CASE"
    AGENT_CMD="codex"
    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"
    printf "%s\n" "{\"stage\":\"ready\",\"status\":\"running\",\"startedAt\":\"2026-05-05T11:55:00.000Z\",\"finishedAt\":null,\"agent\":\"codex\",\"model\":\"gpt-5.5\",\"notes\":null,\"artifacts\":{\"type\":\"ready\",\"verdict\":\"fail\",\"prNumber\":304,\"checksRun\":3,\"checksPassed\":2,\"mergeConflict\":\"CLEAN\"}}" > "$STATE_DIR/.ready-result.json"

    WRITE_STAGE_CALLS=""
    READY_PROMPT_CALLS=0
    READY_PROMPT_SUMMARY=""
    LAUNCH_AGENT_CALLS=0

    _ensure_task_window_exists() { printf "%s\n" "win-1"; }
    persist_task_window_id() { :; }
    ready_state_dir() { printf "%s\n" "$STATE_DIR"; }
    read_state_value() {
      if [[ "${4:-}" == *".agent"* ]]; then
        printf "%s\n" "codex"
      elif [[ "${4:-}" == *".model"* ]]; then
        printf "%s\n" "gpt-5.5"
      else
        printf "\n"
      fi
    }
    read_stage_status() {
      case "$TEST_CASE" in
        inflight_same_head) printf "%s\n" "running" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_attempts() {
      case "$TEST_CASE" in
        max_attempts) printf "%s\n" "3" ;;
        *) printf "%s\n" "0" ;;
      esac
    }
    ready_remediation_launch_head() {
      case "$TEST_CASE" in
        inflight_same_head) printf "%s\n" "abc123" ;;
        *) printf "\n" ;;
      esac
    }
    ready_remediation_agent_cmd() { printf "\n"; }
    build_ready_remediation_prompt() {
      READY_PROMPT_CALLS=$((READY_PROMPT_CALLS + 1))
      READY_PROMPT_SUMMARY="${8-}"
      printf "prompt\n"
    }
    _launch_agent_in_pane() {
      LAUNCH_AGENT_CALLS=$((LAUNCH_AGENT_CALLS + 1))
      return 0
    }
    check_stage_aborted() { return 1; }
    git() {
      if [[ "${1:-}" == "-C" && "${3:-}" == "rev-parse" && "${4:-}" == "HEAD" ]]; then
        printf "%s\n" "abc123"
        return 0
      fi
      return 1
    }
    merge_queue_enrich_ready_artifacts() { printf "%s\n" "$2"; }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "${1-}" "${2-}" "${3-}" "${4-}" "${5-}" "${6-}" "${7-}"
    }
    write_ready_attention_file() { :; }
    log() { :; }
    log_error() { :; }

    output_file="$CASE_DIR/watchdog-output.json"
    launch_ready_watchdog_remediation \
      "HOK-1300" \
      "fix-failing-ci-tests" \
      "$WT_DIR" \
      "task/fix-failing-ci-tests" \
      "main" \
      "304" \
      "Alembic Check (FAILURE)" \
      "1" \
      "3" \
      "[\"Alembic Check\"]" > "$output_file"
    output=$(cat "$output_file")

    stage_summary=$(printf "%s" "$WRITE_STAGE_CALLS" | tr "\n" ";")
    printf "output=%s\nstage_calls=%s\nlaunch_calls=%s\nprompt_calls=%s\nprompt_summary=%s\n" \
      "$output" "$stage_summary" "$LAUNCH_AGENT_CALLS" "$READY_PROMPT_CALLS" "$READY_PROMPT_SUMMARY"
  ' 2>&1
}

run_cross_pr_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/cross-pr-$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" COMMON_SCRIPT="$COMMON_SCRIPT" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$COMMON_SCRIPT"
    source "$LAUNCH_FUNC_FILE"

    SESSION="cross-pr-test-$TEST_CASE"
    TOOLS_DIR="$CASE_DIR/tools"
    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$TOOLS_DIR" "$STATE_DIR" "$WT_DIR"

    CAPTURED_NPX_ARGS_FILE="$CASE_DIR/npx-args.txt"
    READY_ATTENTION_CALLS=""
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""

    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
      mkdir -p "$1"
      printf "%s\n" "$2" > "$1/.needs-attention"
    }
    npx() {
      printf "%s\n" "$*" > "$CAPTURED_NPX_ARGS_FILE"
      if [[ "${1:-}" != "tsx" || "${2:-}" != "$TOOLS_DIR/check-cross-pr-reverts.ts" ]]; then
        return 1
      fi

      case "$TEST_CASE" in
        rc1_policy)
          printf "%s\n" "{\"blocked\":true,\"reverts\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}],\"acknowledged\":[],\"unacknowledged\":[{\"prNumber\":437,\"files\":[{\"path\":\"strategy.txt\"}]}]}"
          return 1
          ;;
        rc2_with_diag)
          printf "%s\n" "fatal: Not a valid object name '\''auto/integration'\''" >&2
          return 2
          ;;
        rc2_no_diag)
          return 2
          ;;
        *)
          printf "%s\n" "{\"blocked\":false,\"reverts\":[],\"acknowledged\":[],\"unacknowledged\":[]}"
          return 0
          ;;
      esac
    }

    case "$TEST_CASE" in
      passes_base_branch)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304" "main"
        rc=$?
        set -e
        ;;
      empty_base_branch)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304" ""
        rc=$?
        set -e
        ;;
      omitted_base_branch|*)
        set +e
        cross_pr_revert_gate_allows_merge "HOK-1300" "$STATE_DIR" "$WT_DIR" "304"
        rc=$?
        set -e
        ;;
    esac

    attention_contents=""
    [[ -f "$STATE_DIR/.needs-attention" ]] && attention_contents=$(cat "$STATE_DIR/.needs-attention")

    printf "rc=%s\nargs=%s\nattention_calls=%s\nattention_file=%s\nlogs=%s\nerror_logs=%s\n" \
      "$rc" "$(cat "$CAPTURED_NPX_ARGS_FILE" 2>/dev/null || true)" "$READY_ATTENTION_CALLS" "$attention_contents" "$LOG_OUTPUT" "$LOG_ERROR_OUTPUT"
  ' 2>&1
}

echo "=== Cross-PR Revert Gate ==="

output="$(run_cross_pr_case passes_base_branch)"
check_contains "gate includes integration ref flag" "$output" "--integration-ref main"
check_contains "gate invokes revert checker" "$output" "check-cross-pr-reverts.ts --repo-dir"
check_contains "gate passes explicit integration ref rc" "$output" "rc=0"

output="$(run_cross_pr_case empty_base_branch)"
check_contains "gate omits empty integration ref rc" "$output" "rc=0"
check_not_contains "gate omits empty integration ref flag" "$output" "--integration-ref"

output="$(run_cross_pr_case omitted_base_branch)"
check_contains "gate supports omitted base branch rc" "$output" "rc=0"
check_not_contains "gate omits missing integration ref flag" "$output" "--integration-ref"

echo "=== Launch Ready Phase ==="

output="$(run_launch_case pending)"
check_contains "pending ready returns retry code" "$output" "rc=4"
check_contains "pending ready writes running stage result" "$output" "|ready|running|"
check_contains "pending ready records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "pending ready logs launch at info level" "$output" "logs=info   HOK-1300: Launching ready phase (PR #304)"
check_contains "pending ready logs retry message" "$output" "will retry"
check_contains "pending ready logs retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending ready does not demote first poll to debug" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_contains "pending ready skips attention file" "$output" "attention_count=0"
check_contains "pending ready emits no errors" "$output" "error_count=0"

output="$(run_launch_case pending_re_check)"
check_contains "pending re-check returns retry code" "$output" "rc=4"
check_contains "pending re-check logs launch at debug level" "$output" "logs=debug   HOK-1300: Launching ready phase (PR #304)"
check_contains "pending re-check logs retry at debug level" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending re-check does not log launch at info level" "$output" "info   HOK-1300: Launching ready phase (PR #304)"
check_not_contains "pending re-check does not log retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"

output="$(run_launch_case cross_pr_revert_blocked)"
check_contains "cross-pr revert block returns failure" "$output" "rc=1"
check_contains "cross-pr revert block writes attention" "$output" "PR #304 removes files from #437 without explicit acknowledgement."
check_contains "cross-pr revert block includes file list" "$output" "Affected files: strategy.txt."
check_contains "cross-pr revert block skips ready result writes" "$output" "stage_calls="
check_contains "cross-pr revert block logs status" "$output" "Cross-PR revert guard blocked ready phase for PR #304"
check_not_contains "cross-pr revert block does not run ready tool" "$output" "\"verdict\":"

output="$(run_launch_case cross_pr_revert_error)"
check_contains "cross-pr revert tool error returns failure" "$output" "rc=1"
check_contains "cross-pr revert tool error writes attention" "$output" "Cross-PR revert guard failed (tool error) for PR #304."
check_contains "cross-pr revert tool error skips ready result writes" "$output" "stage_calls="
check_contains "cross-pr revert tool error logs failure" "$output" "Cross-PR revert guard failed for HOK-1300 (PR #304)"
check_not_contains "cross-pr revert error does not run ready tool" "$output" "\"verdict\":"

output="$(run_cross_pr_case rc1_policy)"
check_contains "direct cross-pr policy returns failure" "$output" "rc=1"
check_contains "direct cross-pr policy keeps acknowledgement message" "$output" "PR #304 removes files from #437 without explicit acknowledgement."
check_contains "direct cross-pr policy includes affected files" "$output" "Affected files: strategy.txt."
check_not_contains "direct cross-pr policy is not tagged as tool error" "$output" "tool error"

output="$(run_cross_pr_case rc2_with_diag)"
check_contains "direct cross-pr tool failure returns failure" "$output" "rc=1"
check_contains "direct cross-pr tool failure tags tool error" "$output" "Cross-PR revert guard failed (tool error) for PR #304:"
check_contains "direct cross-pr tool failure preserves diagnostic ref" "$output" "auto/integration"
check_contains "direct cross-pr tool failure logs diagnostic" "$output" "Cross-PR revert guard failed for HOK-1300 (PR #304): fatal: Not a valid object name 'auto/integration'"

output="$(run_cross_pr_case rc2_no_diag)"
check_contains "direct cross-pr tool failure without stderr returns failure" "$output" "rc=1"
check_contains "direct cross-pr tool failure without stderr stays concise" "$output" "Cross-PR revert guard failed (tool error) for PR #304."
check_contains "direct cross-pr tool failure without stderr logs fallback" "$output" "Cross-PR revert guard failed for HOK-1300 (PR #304): no diagnostics captured"

output="$(run_launch_case unknown_first)"
check_contains "unknown first poll returns retry code" "$output" "rc=4"
check_contains "unknown first poll writes running stage result" "$output" "|ready|running|"
check_contains "unknown first poll records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "unknown first poll tracks transient attempt" "$output" "\"transientMergeabilityAttempts\":1"
check_contains "unknown first poll leaves no attention file" "$output" "needs_attention=absent"
check_contains "unknown first poll leaves no transient attention marker" "$output" "transient_attention=absent"
check_contains "unknown first poll stores retry count" "$output" "transient_count=1"
check_contains "unknown first poll logs retry" "$output" "Merge status for HOK-1300 is UNKNOWN - will retry (attempt 1/6)"

output="$(run_launch_case error_first)"
check_contains "error first poll returns retry code" "$output" "rc=4"
check_contains "error first poll writes running stage result" "$output" "|ready|running|"
check_contains "error first poll records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "error first poll tracks transient attempt" "$output" "\"transientMergeabilityAttempts\":1"
check_contains "error first poll stores retry count" "$output" "transient_count=1"
check_contains "error first poll leaves no attention file" "$output" "needs_attention=absent"
check_contains "error first poll logs retry" "$output" "Merge status for HOK-1300 is ERROR - will retry (attempt 1/6)"

output="$(run_launch_case unknown_capped)"
check_contains "unknown capped returns failure" "$output" "rc=1"
check_contains "unknown capped writes attention" "$output" "Merge status UNKNOWN persisted after 7 checks for PR #304."
check_contains "unknown capped writes transient marker" "$output" "transient_attention=present"
check_contains "unknown capped keeps attention file" "$output" "needs_attention=present"
check_contains "unknown capped increments counter past cap" "$output" "transient_count=7"
check_contains "unknown capped logs persistent failure" "$output" "Merge status UNKNOWN persisted for HOK-1300 after 7 attempts"

output="$(run_launch_case remediation_launch)"
check_contains "first remediation launch returns rc 5" "$output" "rc=5"
check_contains "first remediation launch writes running stage result" "$output" "|ready|running|"
check_contains "first remediation launch records attempt 1" "$output" "\"remediationAttempts\":1"
check_contains "first remediation launch records current head" "$output" "\"remediationLaunchHead\":\"abc123\""
check_contains "first remediation launch records ci-status failure name" "$output" "\"remediationFailures\":[\"ci-status\"]"
check_contains "first remediation launch clears attention" "$output" "attention_count=0"
check_contains "first remediation launch invokes agent once" "$output" "launch_calls=1"
check_contains "first remediation launch builds prompt once" "$output" "prompt_calls=1"
check_contains "first remediation launch emits no errors" "$output" "error_count=0"

output="$(run_launch_case actionable_named_failure)"
check_contains "actionable named failure returns rc 5" "$output" "rc=5"
check_contains "actionable named failure launches remediation" "$output" "launch_calls=1"
check_contains "actionable named failure records failure name" "$output" "\"remediationFailures\":[\"lint\"]"
check_contains "actionable named failure summarizes direct check" "$output" "prompt_summary=lint: eslint failed"

output="$(run_launch_case actionable_compound_failure)"
check_contains "compound actionable failure returns rc 5" "$output" "rc=5"
check_contains "compound actionable failure launches once" "$output" "launch_calls=1"
check_contains "compound actionable failure records both failures" "$output" "\"remediationFailures\":[\"ci-status\",\"tests\"]"
check_contains "compound actionable failure summarizes both checks" "$output" "prompt_summary=ci-status: 1 CI check(s) failing (Shell and Unit Tests); tests: unit tests failed"

output="$(run_launch_case actionable_message_failure)"
check_contains "message-based actionable failure returns rc 5" "$output" "rc=5"
check_contains "message-based actionable failure launches remediation" "$output" "launch_calls=1"
check_contains "message-based actionable failure records direct name" "$output" "\"remediationFailures\":[\"ci-suite\"]"

output="$(run_launch_case second_remediation_launch)"
check_contains "second remediation launch returns rc 5" "$output" "rc=5"
check_contains "second remediation launch records attempt 2" "$output" "\"remediationAttempts\":2"

output="$(run_launch_case remediation_exhausted)"
check_contains "remediation exhaustion returns failure" "$output" "rc=1"
check_contains "remediation exhaustion writes failed stage result" "$output" "|ready|failed|"
check_contains "remediation exhaustion writes terse attention file" "$output" "Remediation exhausted after 3 attempt(s)"
check_contains "remediation exhaustion logs terse error" "$output" "Ready remediation exhausted"
check_not_contains "remediation exhaustion skips json dump" "$output" "error_payload=  {\"prNumber\":304"

output="$(run_launch_case remediation_disabled)"
check_contains "disabled remediation falls back to ready failure" "$output" "rc=1"
check_contains "disabled remediation writes attention" "$output" "Ready checks failed for PR #304."
check_contains "disabled remediation logs failing check summary" "$output" "Ready checks failed for HOK-1300 - 1 failed (ci-status: 1 check), 0 passed/skipped"
check_contains "disabled remediation logs debug file pointer" "$output" "Full ready result: /tmp/wavemill-ready-phase-test-remediati"
check_not_contains "disabled remediation omits raw json from error log" "$output" "error_payload=  {\"prNumber\":304"
check_contains "disabled remediation writes debug record" "$output" "debug_lines=1"
check_contains "disabled remediation debug record preserves payload" "$output" "\"prNumber\":304"

output="$(run_launch_case non_ci_failure)"
check_contains "non ci failure returns failure" "$output" "rc=1"
check_contains "non ci failure does not launch agent" "$output" "launch_calls=0"
check_contains "non ci failure logs failing check summary" "$output" "release-requirements"
check_not_contains "non ci failure omits raw json from error log" "$output" "error_payload=  {\"prNumber\":304"
check_contains "non ci failure writes debug record" "$output" "debug_lines=1"

output="$(run_launch_case remediation_launch_failure)"
check_contains "launch failure returns failure" "$output" "rc=1"
check_contains "launch failure records failed stage" "$output" "|ready|failed|"
check_contains "launch failure writes operator message" "$output" "Could not launch remediation agent for PR #304."
check_contains "launch failure does not pollute attempts" "$output" "\"remediationAttempts\":0"

output="$(run_launch_case already_inflight_same_head)"
check_contains "inflight same head returns rc 5" "$output" "rc=5"
check_contains "inflight same head does not relaunch agent" "$output" "launch_calls=0"
check_contains "inflight same head does not rewrite stage" "$output" "stage_calls="

output="$(run_launch_case conflict_persists_after_remediation)"
check_contains "persistent conflict returns failure" "$output" "rc=1"
check_contains "persistent conflict writes attention" "$output" "PR #304 still has merge conflicts after automatic remediation."
check_contains "persistent conflict records attention head" "$output" "conflict_attention_head=abc123"
check_contains "persistent conflict records reported marker" "$output" "conflict_attention_reported=present"
check_contains "persistent conflict keeps detected marker" "$output" "conflict_detected=present"
check_contains "persistent conflict logs one terse error" "$output" "Merge conflicts persist for HOK-1300 after remediation attempt"

output="$(run_launch_case pass_after_remediation)"
check_contains "pass after remediation returns success" "$output" "rc=0"
check_contains "pass after remediation writes completed stage" "$output" "|ready|completed|"
check_contains "pass after remediation restores ready labels once" "$output" "ready_label_calls=1"
check_contains "pass after remediation records ready label update" "$output" "\"readyLabelsUpdated\":true"
check_not_contains "pass after remediation clears remediation artifacts" "$output" "\"remediationAttempts\":"
check_contains "pass after remediation clears conflict marker" "$output" "conflict_detected=absent"
check_contains "pass after remediation clears attention head" "$output" "conflict_attention_head="
check_contains "pass after remediation clears reported marker" "$output" "conflict_attention_reported=absent"
check_contains "pass after remediation clears needs attention" "$output" "needs_attention=absent"
check_contains "pass after remediation demotes restored labels to debug" "$output" "debug   HOK-1300: Restored ready labels for PR #304"
check_contains "pass after remediation demotes ready completion to debug" "$output" "debug   HOK-1300: Ready checks completed (verdict: pass)"
check_not_contains "pass after remediation no longer emits restored labels at status" "$output" "status   HOK-1300: Restored ready labels for PR #304"

output="$(run_launch_case ready_label_failure)"
check_contains "ready label failure returns failure" "$output" "rc=1"
check_contains "ready label failure writes failed stage" "$output" "|ready|failed|"
check_contains "ready label failure attempts label restore once" "$output" "ready_label_calls=1"
check_contains "ready label failure keeps attention" "$output" "needs_attention=present"
check_contains "ready label failure writes operator message" "$output" "Ready passed for PR #304, but updating wm:ready labels failed."
check_contains "ready label failure records label update failure" "$output" "\"readyLabelsUpdated\":false"
check_contains "ready label failure logs terse error" "$output" "Ready passed for HOK-1300 but failed to restore PR labels"

output="$(run_launch_case clean_after_unknown)"
check_contains "clean after unknown returns success" "$output" "rc=0"
check_contains "clean after unknown clears attention" "$output" "needs_attention=absent"
check_contains "clean after unknown clears transient marker" "$output" "transient_attention=absent"
check_contains "clean after unknown clears transient count" "$output" "transient_count="

output="$(run_launch_case clean_with_stderr)"
check_contains "success stderr is not treated as error" "$output" "error_count=0"
check_not_contains "success path does not log ready stderr" "$output" "[ready stderr] ⚠️  MERGE CONFLICT: PR #304 has conflicts with main"

output="$(run_launch_case fail_with_stderr)"
check_contains "failure stderr is logged as error" "$output" "error_payload=  [ready stderr] TypeError: ready crashed"
check_not_contains "failure stderr does not leak to terminal" "$output" $'\nTypeError: ready crashed\n'

echo "=== Watchdog Launch Helper ==="

output="$(run_watchdog_launch_case success)"
check_contains "watchdog launch succeeds" "$output" '"status":"launched"'
check_contains "watchdog launch writes running stage" "$output" "|ready|running|"
check_contains "watchdog launch invokes agent" "$output" "launch_calls=1"
check_contains "watchdog launch reuses prompt summary" "$output" "prompt_summary=Alembic Check (FAILURE)"

output="$(run_watchdog_launch_case max_attempts)"
check_contains "watchdog max attempts skips launch" "$output" '"status":"skipped-max-attempts"'
check_contains "watchdog max attempts does not relaunch agent" "$output" "launch_calls=0"
check_contains "watchdog max attempts does not rewrite stage" "$output" "stage_calls="

output="$(run_watchdog_launch_case inflight_same_head)"
check_contains "watchdog inflight skips launch" "$output" '"status":"skipped-in-flight"'
check_contains "watchdog inflight does not relaunch agent" "$output" "launch_calls=0"
check_contains "watchdog inflight does not rewrite stage" "$output" "stage_calls="

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
