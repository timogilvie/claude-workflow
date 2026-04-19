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

LAUNCH_FUNC_FILE="$TEST_TMP/launch_ready_phase.sh"
extract_function "$MILL_SCRIPT" "launch_ready_phase" > "$LAUNCH_FUNC_FILE"

if [[ ! -s "$LAUNCH_FUNC_FILE" ]]; then
  echo "Could not extract launch_ready_phase()"
  exit 1
fi

run_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$LAUNCH_FUNC_FILE"

    SESSION="ready-phase-test"
    TOOLS_DIR="$CASE_DIR/tools"
    AGENT_CMD="codex"
    mkdir -p "$TOOLS_DIR"

    STATE_DIR="$CASE_DIR/feature/ready"
    WT_DIR="$CASE_DIR/worktree"
    mkdir -p "$STATE_DIR" "$WT_DIR"

    WRITE_STAGE_CALLS=""
    READY_ATTENTION_CALLS=""
    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    LOG_WARN_OUTPUT=""
    LAUNCH_AGENT_CALLS=0
    READY_PROMPT_CALLS=0

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
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "${1-}" "${2-}" "${3-}" "${4-}" "${5-}" "${6-}" "${7-}"
    }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
    }
    npx() {
      if [[ "${1:-}" != "tsx" ]]; then
        return 1
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
        clean_with_stderr)
          printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pass\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pass\",\"message\":\"All CI checks passing\",\"details\":{\"totalChecks\":3}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"All checks passed\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"CLEAN\",\"attempts\":1}}"
          printf "%s\n" "⚠️  MERGE CONFLICT: PR #304 has conflicts with main" >&2
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

    printf "rc=%s\nstage_calls=%s\nattention_calls=%s\nattention_count=%s\nlaunch_calls=%s\nprompt_calls=%s\nerror_count=%s\nlogs=%s\nwarn_logs=%s\nerror_payload=%s\n" \
      "$rc" "$stage_summary" "$attention_summary" "$attention_count" "$LAUNCH_AGENT_CALLS" "$READY_PROMPT_CALLS" "$error_count" "$LOG_OUTPUT" "$LOG_WARN_OUTPUT" "$LOG_ERROR_OUTPUT"
  ' 2>&1
}

echo "=== Launch Ready Phase ==="

output="$(run_launch_case pending)"
check_contains "pending ready returns retry code" "$output" "rc=4"
check_contains "pending ready writes running stage result" "$output" "|ready|running|"
check_contains "pending ready records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "pending ready logs launch at info level" "$output" "logs=info   Launching ready phase for HOK-1300 (PR #304)"
check_contains "pending ready logs retry message" "$output" "will retry"
check_contains "pending ready logs retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending ready does not demote first poll to debug" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_contains "pending ready skips attention file" "$output" "attention_count=0"
check_contains "pending ready emits no errors" "$output" "error_count=0"

output="$(run_launch_case pending_re_check)"
check_contains "pending re-check returns retry code" "$output" "rc=4"
check_contains "pending re-check logs launch at debug level" "$output" "logs=debug   Launching ready phase for HOK-1300 (PR #304)"
check_contains "pending re-check logs retry at debug level" "$output" "debug   CI checks pending for HOK-1300 (PR #304) - will retry"
check_not_contains "pending re-check does not log launch at info level" "$output" "info   Launching ready phase for HOK-1300 (PR #304)"
check_not_contains "pending re-check does not log retry at info level" "$output" "info   CI checks pending for HOK-1300 (PR #304) - will retry"

output="$(run_launch_case remediation_launch)"
check_contains "first remediation launch returns rc 5" "$output" "rc=5"
check_contains "first remediation launch writes running stage result" "$output" "|ready|running|"
check_contains "first remediation launch records attempt 1" "$output" "\"remediationAttempts\":1"
check_contains "first remediation launch records current head" "$output" "\"remediationLaunchHead\":\"abc123\""
check_contains "first remediation launch clears attention" "$output" "attention_count=0"
check_contains "first remediation launch invokes agent once" "$output" "launch_calls=1"
check_contains "first remediation launch builds prompt once" "$output" "prompt_calls=1"
check_contains "first remediation launch emits no errors" "$output" "error_count=0"

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
check_contains "disabled remediation logs json for backwards compatibility" "$output" "\"prNumber\":304"

output="$(run_launch_case non_ci_failure)"
check_contains "non ci failure returns failure" "$output" "rc=1"
check_contains "non ci failure does not launch agent" "$output" "launch_calls=0"
check_contains "non ci failure keeps legacy json logging" "$output" "\"release-requirements\""

output="$(run_launch_case remediation_launch_failure)"
check_contains "launch failure returns failure" "$output" "rc=1"
check_contains "launch failure records failed stage" "$output" "|ready|failed|"
check_contains "launch failure writes operator message" "$output" "Could not launch remediation agent for PR #304."
check_contains "launch failure does not pollute attempts" "$output" "\"remediationAttempts\":0"

output="$(run_launch_case already_inflight_same_head)"
check_contains "inflight same head returns rc 5" "$output" "rc=5"
check_contains "inflight same head does not relaunch agent" "$output" "launch_calls=0"
check_contains "inflight same head does not rewrite stage" "$output" "stage_calls="

output="$(run_launch_case pass_after_remediation)"
check_contains "pass after remediation returns success" "$output" "rc=0"
check_contains "pass after remediation writes completed stage" "$output" "|ready|completed|"
check_not_contains "pass after remediation clears remediation artifacts" "$output" "\"remediationAttempts\":"

output="$(run_launch_case clean_with_stderr)"
check_contains "success stderr stays in debug logs" "$output" "debug   [ready stderr] ⚠️  MERGE CONFLICT: PR #304 has conflicts with main"
check_not_contains "success stderr does not leak to terminal" "$output" $'\n⚠️  MERGE CONFLICT: PR #304 has conflicts with main\n'
check_contains "success stderr is not treated as error" "$output" "error_count=0"

output="$(run_launch_case fail_with_stderr)"
check_contains "failure stderr is logged as error" "$output" "error_payload=  [ready stderr] TypeError: ready crashed"
check_not_contains "failure stderr does not leak to terminal" "$output" $'\nTypeError: ready crashed\n'

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
