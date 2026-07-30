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

check_json_eq() {
  local name="$1" file="$2" filter="$3" expected="$4" actual
  actual="$(jq -r "$filter" "$file")"
  check_eq "$name" "$expected" "$actual"
}

extract_monitor_heredoc() {
  awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
    /^MONITOR_EOF$/ { found=0; next }
    found { print }
  ' "$MILL_SCRIPT"
}

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1; depth = 0 }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

FUNCTIONS_FILE="$TEST_TMP/queue-plan-lifecycle-funcs.sh"
{
  printf 'source %q\n' "$REPO_DIR/shared/lib/wavemill-common.sh"
  printf 'source %q\n' "$REPO_DIR/shared/lib/queue-health.sh"
  echo
  extract_function "$MONITOR_BODY" "record_fetch_queue_plan_failure"
  echo
  extract_function "$MONITOR_BODY" "classify_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "get_queue_failure_reason"
  echo
  extract_function "$MONITOR_BODY" "queue_plan_dependency_graph_hash"
  echo
  extract_function "$MONITOR_BODY" "queue_plan_process_pgid"
  echo
  extract_function "$MONITOR_BODY" "queue_plan_kill_group"
  echo
  extract_function "$MONITOR_BODY" "run_queue_plan_lifecycle"
  echo
  extract_function "$MONITOR_BODY" "build_queue_plan_once"
} > "$FUNCTIONS_FILE"

BACKLOG_JSON='[
  {"identifier":"HOK-10","title":"Ready task","relations":{"nodes":[]},"inverseRelations":{"nodes":[]}},
  {"identifier":"HOK-11","title":"Dependent task","relations":{"nodes":[]},"inverseRelations":{"nodes":[{"type":"blocks","issue":{"identifier":"HOK-10"}}]}},
  {"identifier":"HOK-12","title":"Shared task","sharedSurface":["HOK-11"],"relations":{"nodes":[]},"inverseRelations":{"nodes":[]}}
]'

run_planner_case() {
  local mode="$1" timeout="${2:-120}" case_tmp bin_dir stdout stderr diag state_dir
  case_tmp="$(mktemp -d "$TEST_TMP/case.XXXXXX")"
  bin_dir="$case_tmp/bin"
  state_dir="$case_tmp/state"
  mkdir -p "$bin_dir" "$state_dir"
  cat > "$bin_dir/npx" <<'EOF'
#!/usr/bin/env bash
case "${TEST_PLANNER_MODE:-success}" in
  success)
    printf '{"availableNow":[{"taskId":"HOK-10"}],"queue":[]}\n'
    ;;
  terminated)
    printf 'token=super-secret api_key=abc123\n' >&2
    exit 143
    ;;
  malformed)
    printf 'not-json\n'
    ;;
  timeout)
    (sleep 1000) &
    printf '%s\n' "$!" > "$TEST_CHILD_PID_FILE"
    wait
    ;;
  *)
    echo "unknown mode" >&2
    exit 2
    ;;
esac
EOF
  chmod +x "$bin_dir/npx"
  stdout="$case_tmp/stdout.txt"
  stderr="$case_tmp/stderr.txt"
  diag="$case_tmp/diag.txt"
  set +e
  TEST_PLANNER_MODE="$mode" \
  TEST_CHILD_PID_FILE="$case_tmp/child.pid" \
  FUNCTIONS_FILE="$FUNCTIONS_FILE" \
  REPO_DIR="$case_tmp/repo" \
  TOOLS_DIR="/unused" \
  BACKLOG_JSON="$BACKLOG_JSON" \
  FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$diag" \
  WAVEMILL_QUEUE_HEALTH_STATE_DIR="$state_dir" \
  WAVEMILL_QUEUE_PLAN_TIMEOUT_SECONDS="$timeout" \
  PATH="$bin_dir:$PATH" \
  bash -c '
    set -euo pipefail
    source "$FUNCTIONS_FILE"
    mkdir -p "$REPO_DIR"
    PROJECT_NAME=""
    BACKLOG_CACHE_TTL=1
    if build_queue_plan_once "$BACKLOG_JSON"; then
      exit 0
    fi
    exit 1
  ' >"$stdout" 2>"$stderr"
  local rc=$?
  set -e
  printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$rc" "$stdout" "$stderr" "$diag" "$state_dir/queue-health.json" "$case_tmp/child.pid"
}

test_success_records_healthy() {
  local result rc stdout state_file output
  result="$(run_planner_case success)"
  rc="$(sed -n '1p' <<<"$result")"
  stdout="$(sed -n '2p' <<<"$result")"
  state_file="$(sed -n '5p' <<<"$result")"
  output="$(cat "$stdout")"
  check_eq "success returns zero" "0" "$rc"
  check_contains "success prints queue plan" "$output" '"availableNow"'
  check_json_eq "success health status" "$state_file" '.status' "healthy"
  check_json_eq "success stores input hash" "$state_file" '(.planner.input_snapshot_hash | length > 0)' "true"
}

test_external_cancellation_has_cause_and_redacts() {
  local result rc diag state_file diag_text
  result="$(run_planner_case terminated)"
  rc="$(sed -n '1p' <<<"$result")"
  diag="$(sed -n '4p' <<<"$result")"
  state_file="$(sed -n '5p' <<<"$result")"
  diag_text="$(cat "$diag")"
  check_eq "external cancellation returns nonzero" "1" "$rc"
  check_contains "143 diagnostics include cause" "$diag_text" "cause=external_cancellation"
  check_json_eq "external cancellation health reason" "$state_file" '.reason' "queue_plan_external_cancellation"
  check_json_eq "external cancellation redacts key" "$state_file" '(.planner.stderr_excerpt | contains("abc123") | not)' "true"
}

test_malformed_output_degrades() {
  local result state_file
  result="$(run_planner_case malformed)"
  state_file="$(sed -n '5p' <<<"$result")"
  check_json_eq "malformed output reason" "$state_file" '.reason' "invalid_input"
  check_json_eq "malformed output stores stdout excerpt" "$state_file" '(.planner.stdout_excerpt | length > 0)' "true"
}

test_backoff_and_observer_dedup() {
  local state_dir="$TEST_TMP/backoff-state" state_file events_file output
  mkdir -p "$state_dir"
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" WAVEMILL_QUEUE_HEALTH_STATE_DIR="$state_dir" SESSION="hok-test" bash -c '
    set -euo pipefail
    source "$FUNCTIONS_FILE"
    BACKLOG_CACHE_TTL=3
    WAVEMILL_QUEUE_HEALTH_NOW=1000 queue_health_record_failure timeout "{\"exit_code\":143,\"timeout_seconds\":10}"
    WAVEMILL_QUEUE_HEALTH_NOW=1001 queue_health_record_failure timeout "{\"exit_code\":143,\"timeout_seconds\":10}"
    WAVEMILL_QUEUE_HEALTH_NOW=1002 queue_health_record_failure external_cancellation "{\"exit_code\":143}"
    WAVEMILL_QUEUE_HEALTH_NOW=1003 queue_health_record_success "{}"
  ')
  state_file="$state_dir/queue-health.json"
  events_file="$state_dir/queue-health-events.jsonl"
  check_json_eq "backoff resets after success" "$state_file" '.status' "healthy"
  check_eq "observer emits degraded/degraded/resolved" "3" "$(wc -l < "$events_file" | tr -d ' ')"
  check_contains "observer has stable condition type" "$(cat "$events_file")" '"type":"queue_health_condition"'
  check_eq "backoff command produced no stdout" "" "$output"
}

test_dependency_safe_flat_filter() {
  local safe held available
  available=$'HOK-10|ready-task|Ready task|core|100|0\nHOK-11|dependent-task|Dependent task|core|90|0\nHOK-12|shared-task|Shared task|core|80|0'
  safe="$(source "$REPO_DIR/shared/lib/queue-health.sh"; queue_health_filter_dependency_safe_flat_candidates "$available" "$BACKLOG_JSON")"
  held="$(source "$REPO_DIR/shared/lib/queue-health.sh"; queue_health_dependency_held_count "$available" "$BACKLOG_JSON")"
  check_contains "safe flat keeps dependency-free task" "$safe" "HOK-10|ready-task"
  check_eq "safe flat holds dependency metadata tasks" "2" "$held"
}

test_timeout_cleans_planner_group() {
  local result rc state_file child_pid_file child_pid
  result="$(run_planner_case timeout 10)"
  rc="$(sed -n '1p' <<<"$result")"
  state_file="$(sed -n '5p' <<<"$result")"
  child_pid_file="$(sed -n '6p' <<<"$result")"
  child_pid="$(cat "$child_pid_file" 2>/dev/null || true)"
  check_eq "timeout returns nonzero" "1" "$rc"
  check_json_eq "timeout health reason" "$state_file" '.reason' "queue_plan_timeout"
  if [[ "$child_pid" =~ ^[0-9]+$ ]] && kill -0 "$child_pid" 2>/dev/null; then
    fail "timeout cleans child process group"
    kill "$child_pid" 2>/dev/null || true
  else
    pass "timeout cleans child process group"
  fi
}

echo "=== Queue Plan Lifecycle ==="
test_success_records_healthy
test_external_cancellation_has_cause_and_redacts
test_malformed_output_degrades
test_backoff_and_observer_dedup
test_dependency_safe_flat_filter
test_timeout_cleans_planner_group

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
