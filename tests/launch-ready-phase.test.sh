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
  local case_dir="$TEST_TMP/case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" bash -lc '
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

    _ensure_window_exists() { :; }
    ready_state_dir() { printf "%s\n" "$STATE_DIR"; }
    read_state_value() { printf "\n"; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    build_conflict_resolution_prompt() { :; }
    _launch_agent_in_pane() { return 1; }
    check_stage_aborted() { return 1; }
    git() { return 1; }
    write_stage_result() {
      printf -v WRITE_STAGE_CALLS "%s%s|%s|%s|%s|%s|%s|%s\n" \
        "$WRITE_STAGE_CALLS" "$1" "$2" "$3" "$4" "$5" "$6" "$7"
    }
    write_ready_attention_file() {
      printf -v READY_ATTENTION_CALLS "%s%s|%s\n" "$READY_ATTENTION_CALLS" "$1" "$2"
    }
    npx() {
      if [[ "${1:-}" == "tsx" ]]; then
        printf "%s\n" "{\"prNumber\":304,\"branch\":\"task/fix-failing-ci-tests\",\"verdict\":\"pending\",\"checks\":[{\"name\":\"ci-status\",\"status\":\"pending\",\"message\":\"2 CI check(s) still running\",\"details\":{\"pendingChecks\":[{\"name\":\"Shell and Unit Tests\",\"state\":\"QUEUED\"},{\"name\":\"Check Lifecycle Paths\",\"state\":\"QUEUED\"}],\"totalChecks\":2}}],\"timestamp\":\"2026-04-16T14:12:00.431Z\",\"summary\":\"CI checks still in progress - will retry\",\"mergeConflict\":{\"status\":\"CLEAN\",\"message\":\"No merge conflicts detected\",\"mergeable\":\"MERGEABLE\",\"mergeStateStatus\":\"UNSTABLE\",\"attempts\":1}}"
        return 2
      fi
      return 1
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

    printf "rc=%s\nstage_calls=%s\nattention_calls=%s\nattention_count=%s\nerror_count=%s\nlogs=%s\nerrors=%s\n" \
      "$rc" "$stage_summary" "$attention_summary" "$attention_count" "$error_count" "$LOG_OUTPUT" "$LOG_ERROR_OUTPUT"
  '
}

echo "=== Launch Ready Phase ==="

output="$(run_launch_case)"
check_contains "pending ready returns retry code" "$output" "rc=4"
check_contains "pending ready writes running stage result" "$output" "|ready|running|"
check_contains "pending ready records pending verdict" "$output" "\"verdict\":\"pending\""
check_contains "pending ready logs retry message" "$output" "will retry"
check_contains "pending ready skips attention file" "$output" "attention_count=0"
check_contains "pending ready emits no errors" "$output" "error_count=0"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
