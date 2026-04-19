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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

LAUNCH_FUNC_FILE="$TEST_TMP/launch_task.sh"
extract_function "$MILL_SCRIPT" "launch_task" > "$LAUNCH_FUNC_FILE"

if [[ ! -s "$LAUNCH_FUNC_FILE" ]]; then
  echo "Could not extract launch_task()"
  exit 1
fi

run_launch_case() {
  local test_case="$1"
  local case_dir="$TEST_TMP/$test_case"
  mkdir -p "$case_dir"

  CASE_DIR="$case_dir" LAUNCH_FUNC_FILE="$LAUNCH_FUNC_FILE" TEST_CASE="$test_case" bash -lc '
    set -euo pipefail
    source "$LAUNCH_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()

    SESSION="task-selection-test"
    ISSUE="HOK-1375"
    SLUG="suppress-output-in-task-selection-pane-when-starting-new-tasks"
    TITLE="Suppress output in task selection pane when starting new tasks"
    REPO_DIR="$CASE_DIR/repo"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    STATE_FILE="$CASE_DIR/state.json"
    TOOLS_DIR="$CASE_DIR/tools"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    AGENT_CMD_EXPLICIT="true"
    API_TIMEOUT=1
    PLANNING_MODE="interactive"
    MILL_LOG_FILE="$CASE_DIR/mill.log"

    mkdir -p "$REPO_DIR/.wavemill/logs" "$WORKTREE_ROOT" "$TOOLS_DIR"
    printf "{}\n" > "$STATE_FILE"
    : > "$MILL_LOG_FILE"
    cat > "/tmp/${SESSION}-${ISSUE}-issue.json" <<EOF
{"description":"Investigate pane noise","labels":{"nodes":[]}}
EOF

    LOG_OUTPUT=""
    LOG_ERROR_OUTPUT=""
    WRITE_STAGE_CALLS=""
    LAUNCH_PLANNING_CALLS=0

    get_linear_issue_id() { printf "%s\n" "$1"; }
    get_task_meta() { printf "\n"; }
    log() { LOG_OUTPUT+="$*\n"; }
    log_error() { LOG_ERROR_OUTPUT+="$*\n"; }
    log_warn() { LOG_OUTPUT+="warn $*\n"; }
    is_task_packet() { return 1; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    agent_validate() { return 0; }
    agent_resolve_from_model() { printf "%s\n" "${1:-codex}"; }
    save_task_state() { :; }
    set_task_phase() { :; }
    set_window_attention_state() { :; }
    get_model_operating_mode() { printf "%s\n" "normal"; }
    read_route_json() { printf "\n"; }
    write_stage_result() { WRITE_STAGE_CALLS+="$*\n"; }
    tmux() { :; }
    launch_planning_phase() {
      LAUNCH_PLANNING_CALLS=$((LAUNCH_PLANNING_CALLS + 1))
      return 0
    }
    handle_phase_launch_result() { return 0; }

    git() {
      if [[ "${1:-}" == "-C" ]]; then
        shift 2
      fi
      case "${1:-}" in
        fetch)
          return 0
          ;;
        show-ref)
          case "$TEST_CASE" in
            resume_success) return 0 ;;
            *) return 1 ;;
          esac
          ;;
        worktree)
          printf "%s\n" "Preparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')" 
          printf "%s\n" "branch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''." >&2
          printf "%s\n" "HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)" >&2
          case "$TEST_CASE" in
            create_failure) return 1 ;;
            *) return 0 ;;
          esac
          ;;
        *)
          return 0
          ;;
      esac
    }

    set +e
    launch_task "$ISSUE" "$SLUG" "$TITLE" 1
    rc=$?
    set -e

    mill_log="$(tr "\n" ";" < "$MILL_LOG_FILE")"
    printf "rc=%s\nlaunch_planning_calls=%s\nmill_log=%s\nerror_logs=%s\nlogs=%s\n" \
      "$rc" "$LAUNCH_PLANNING_CALLS" "$mill_log" "$LOG_ERROR_OUTPUT" "$LOG_OUTPUT"
  ' 2>&1
}

echo "=== Task Selection Worktree Silence ==="

output="$(run_launch_case create_success)"
check_contains "create success returns 0" "$output" "rc=0"
check_contains "create success launches planning once" "$output" "launch_planning_calls=1"
check_contains "create success logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
# Needles use a leading \n to match standalone pane output. mill_log= uses ; separators,
# so noise stored there is never preceded by \n and won't trigger these checks.
check_not_contains "create success does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "create success does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "create success does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

output="$(run_launch_case resume_success)"
check_contains "resume success returns 0" "$output" "rc=0"
check_contains "resume success launches planning once" "$output" "launch_planning_calls=1"
check_contains "resume success logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
check_not_contains "resume success does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "resume success does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "resume success does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

output="$(run_launch_case create_failure)"
check_contains "create failure returns 1" "$output" "rc=1"
check_contains "create failure does not launch planning" "$output" "launch_planning_calls=0"
check_contains "create failure logs worktree noise to mill log" "$output" "mill_log=Preparing worktree (new branch 'task/per-vendor-frontier-quota-telemetry');branch 'task/per-vendor-frontier-quota-telemetry' set up to track 'origin/main'.;HEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349);"
check_contains "create failure surfaces concise error" "$output" "error_logs=HOK-1375: worktree add failed (log: "
check_not_contains "create failure does not leak preparing line to pane" "$output" $'\nPreparing worktree (new branch '\''task/per-vendor-frontier-quota-telemetry'\'')'
check_not_contains "create failure does not leak tracking line to pane" "$output" $'\nbranch '\''task/per-vendor-frontier-quota-telemetry'\'' set up to track '\''origin/main'\''.'
check_not_contains "create failure does not leak head line to pane" "$output" $'\nHEAD is now at cb3e98d HOK-1367: Aggregate operating mode across all frontier models (#349)'

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS assertions passed."
  exit 0
else
  echo "$FAIL assertion(s) failed; $PASS passed."
  exit 1
fi
