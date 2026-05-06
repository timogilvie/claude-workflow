#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
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

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

extract_monitor_heredoc() {
  awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
    /^MONITOR_EOF$/ { found=0; next }
    found { print }
  ' "$MILL_SCRIPT"
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

MONITOR_BODY="$TEST_TMP/monitor-body.sh"
extract_monitor_heredoc > "$MONITOR_BODY"

FUNCTIONS_FILE="$TEST_TMP/task-selection-renderer-funcs.sh"
{
  extract_function "$MONITOR_BODY" "queue_plan_debug_failure"
  echo
  extract_function "$MONITOR_BODY" "build_queue_plan_once"
  echo
  extract_function "$MONITOR_BODY" "invoke_first_wave_helper"
  echo
  extract_function "$MONITOR_BODY" "fetch_queue_plan"
  echo
  extract_function "$MONITOR_BODY" "render_grouped_task_list"
} > "$FUNCTIONS_FILE"

if [[ ! -s "$FUNCTIONS_FILE" ]]; then
  echo "Could not extract task selection renderer helpers"
  exit 1
fi

CANDIDATES=$'HOK-10|foundation-task|Foundation task|core|98|0\nHOK-11|depends-on-foundation|Depends on foundation|core|95|1\nHOK-12|also-depends-on-foundation|Also depends on foundation|core|92|1\nHOK-13|shares-surface-with-hok-11|Shares surface with HOK-11|ux|90|0\nHOK-14|broken-dependency|Broken dependency|core|80|1'

LINEAR_BACKLOG_JSON=$(cat <<'EOF'
[
  { "identifier": "HOK-10", "title": "Foundation task", "inverseRelations": { "nodes": [] } },
  { "identifier": "HOK-11", "title": "Depends on foundation", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-10" } }] } },
  { "identifier": "HOK-12", "title": "Also depends on foundation", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-10" } }] } },
  { "identifier": "HOK-13", "title": "Shares surface with HOK-11", "sharedSurface": ["HOK-11"], "inverseRelations": { "nodes": [] } },
  { "identifier": "HOK-14", "title": "Broken dependency", "inverseRelations": { "nodes": [{ "type": "blocks", "issue": { "identifier": "HOK-99" } }] } }
]
EOF
)

render_prompt_under_test() {
  local available="$1" avail_unblocked avail_blocked avail_blocked_count queue_plan_json
  avail_unblocked=$(echo "$available" | awk -F'|' '$6 == 0 || $6 == ""')
  avail_blocked=$(echo "$available" | awk -F'|' '$6 > 0')
  avail_blocked_count=0
  [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

  echo "Next tasks:"
  queue_plan_json=""
  GROUPED_DISPLAY=""
  GROUPED_SELECT_FROM=""
  if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
    render_grouped_task_list "$queue_plan_json" "$available"
    if [[ -n "$GROUPED_DISPLAY" ]]; then
      echo "$GROUPED_DISPLAY"
      select_from="$GROUPED_SELECT_FROM"
      USING_GROUPED_VIEW=true
    fi
  fi
  if [[ -z "$GROUPED_DISPLAY" ]]; then
    USING_GROUPED_VIEW=false
    [[ -n "$queue_plan_json" ]] || log_warn "queue analysis unavailable, falling back to flat list"
    if [[ -n "$avail_unblocked" ]]; then
      echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
    else
      echo "  (no unblocked tasks)"
    fi
    if (( avail_blocked_count > 0 )); then
      echo ""
      echo "  ($avail_blocked_count blocked task(s) hidden - enter 'm' to show all)"
    fi
  fi
}

test_fetch_queue_plan_transforms_linear_backlog() {
  local output
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" REPO_DIR="$REPO_DIR" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() { :; }
    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR="$REPO_DIR/tools"
    _with_timeout() {
      shift
      "$@"
    }

    fetch_queue_plan
  ')

  check_contains "fetch_queue_plan emits availableNow" "$output" '"availableNow"'
  check_contains "fetch_queue_plan maps ready tasks" "$output" '"HOK-10"'
  check_contains "fetch_queue_plan maps dependency queue" "$output" '"taskId": "HOK-11"'
  check_contains "fetch_queue_plan preserves shared-surface clusters" "$output" '"avoidRunningTogether"'
  check_contains "fetch_queue_plan preserves shared-surface ids" "$output" '"HOK-13"'
  check_contains "fetch_queue_plan triages unknown dependency" "$output" '"to": "HOK-14"'
}

test_invoke_first_wave_helper_packs_priority_without_violating_dependencies() {
  local wave_result
  wave_result=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" REPO_DIR="$REPO_DIR" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() { :; }
    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR="$REPO_DIR/tools"
    MAX_PARALLEL=3
    _with_timeout() {
      shift
      "$@"
    }

    queue_plan=$(build_queue_plan_once "$LINEAR_BACKLOG_JSON")
    invoke_first_wave_helper "$queue_plan" "$CANDIDATES" 3
  ')

  check_contains "wave helper selects highest-priority ready task" "$wave_result" '"HOK-10"'
  check_contains "wave helper keeps ready shared-surface task in wave" "$wave_result" '"HOK-13"'
  check_not_contains "wave helper does not pull blocked dependency into wave" "$wave_result" '"HOK-11"'
  check_contains "wave helper defers blocked work even if highly scored" "$wave_result" '"deferred"'
}

test_grouped_render_with_fixture_output() {
  local queue_plan output line3 line5 line7
  queue_plan=$(cd "$REPO_DIR" && npx tsx tools/plan-queue.ts --backlog-file fixtures/plan-queue/backlog-basic.json --json)
  output=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" QUEUE_PLAN="$queue_plan" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() { :; }
    GROUPED_DISPLAY=""
    GROUPED_SELECT_FROM=""
    render_grouped_task_list "$QUEUE_PLAN" "$CANDIDATES"
    echo "$GROUPED_DISPLAY"
    echo
    echo "---SELECT---"
    printf "%s\n" "$GROUPED_SELECT_FROM"
  ')

  check_contains "render prints available section" "$output" "Available Now - Parallel Wave 1"
  check_contains "render prints queued section" "$output" "Queued After Dependencies"
  check_contains "render prints avoid section" "$output" "Avoid Running Together"
  check_contains "render prints triage section" "$output" "Needs Triage"
  check_contains "render annotates blockers" "$output" "3. HOK-11 - Depends on foundation (blocked by: HOK-10)"
  check_contains "render includes conflict cluster" "$output" "[conflict cluster 1]"
  check_contains "render marks triage" "$output" "7. HOK-14 - Broken dependency [triage]"

  line3=$(awk '/---SELECT---/{flag=1; next} flag {print; exit}' <<<"$output")
  line5=$(awk '/---SELECT---/{flag=1; next} flag {count++; if (count == 3) { print; exit }}' <<<"$output")
  line7=$(awk '/---SELECT---/{flag=1; next} flag {count++; if (count == 7) { print; exit }}' <<<"$output")
  check_eq "selection line 1 matches first rendered task" "HOK-10|foundation-task|Foundation task|core|98|0" "$line3"
  check_eq "selection line 3 matches queued task order" "HOK-11|depends-on-foundation|Depends on foundation|core|95|1" "$line5"
  check_eq "selection line 7 matches triage task order" "HOK-14|broken-dependency|Broken dependency|core|80|1" "$line7"
}

test_render_rejects_malformed_json() {
  if FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() { :; }
    render_grouped_task_list "{not-json}" "$CANDIDATES" >/dev/null
  '; then
    fail "malformed queue plan returns failure"
  else
    pass "malformed queue plan returns failure"
  fi
}

test_fetch_queue_plan_logs_cache_empty() {
  local debug_log
  debug_log=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() {
      local level="$1"
      shift
      [[ "$level" == "debug" ]] && printf "%s\n" "$*" >&2
    }

    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE=""
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0

    if fetch_queue_plan >/dev/null; then
      exit 2
    fi
  ' 2>&1) || true

  check_contains "cache empty logs category" "$debug_log" "fetch_queue_plan: cache_empty"
  check_contains "cache empty logs reason" "$debug_log" "BACKLOG_JSON_CACHE is empty"
}

test_fetch_queue_plan_logs_jq_massage_failure() {
  local debug_log
  debug_log=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() {
      local level="$1"
      shift
      [[ "$level" == "debug" ]] && printf "%s\n" "$*" >&2
    }

    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="{not-json}"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0

    if fetch_queue_plan >/dev/null; then
      exit 2
    fi
  ' 2>&1) || true

  check_contains "jq massage logs category" "$debug_log" "fetch_queue_plan: jq_massage"
  check_contains "jq massage logs stderr" "$debug_log" "parse error"
}

test_fetch_queue_plan_logs_plan_queue_exec_failure_and_cleans_tempdir() {
  local tmp_root debug_log remaining
  tmp_root=$(mktemp -d)
  debug_log=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" TMPDIR="$tmp_root" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() {
      local level="$1"
      shift
      [[ "$level" == "debug" ]] && printf "%s\n" "$*" >&2
    }
    _with_timeout() {
      shift
      printf "planner exploded\nsecond line\n" >&2
      return 1
    }

    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR=/nonexistent

    if fetch_queue_plan >/dev/null; then
      exit 2
    fi
  ' 2>&1) || true
  remaining=$(find "$tmp_root" -maxdepth 1 -name 'wavemill-fetch-queue-plan.*' -print)
  rm -rf "$tmp_root"

  check_contains "plan queue exec logs category" "$debug_log" "fetch_queue_plan: plan_queue_exec"
  check_contains "plan queue exec logs stderr" "$debug_log" "planner exploded | second line"
  check_eq "plan queue exec cleans tempdir" "" "$remaining"
}

test_fetch_queue_plan_logs_validation_failure_and_cleans_tempdir() {
  local tmp_root debug_log remaining
  tmp_root=$(mktemp -d)
  debug_log=$(FUNCTIONS_FILE="$FUNCTIONS_FILE" TMPDIR="$tmp_root" LINEAR_BACKLOG_JSON="$LINEAR_BACKLOG_JSON" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    log() {
      local level="$1"
      shift
      [[ "$level" == "debug" ]] && printf "%s\n" "$*" >&2
    }
    _with_timeout() {
      shift
      printf "%s\n" "{\"queued\":[]}"
    }

    BACKLOG_CACHE_TTL=60
    BACKLOG_JSON_CACHE="$LINEAR_BACKLOG_JSON"
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    TOOLS_DIR=/nonexistent

    if fetch_queue_plan >/dev/null; then
      exit 2
    fi
  ' 2>&1) || true
  remaining=$(find "$tmp_root" -maxdepth 1 -name 'wavemill-fetch-queue-plan.*' -print)
  rm -rf "$tmp_root"

  check_contains "validation logs category" "$debug_log" "fetch_queue_plan: validation"
  check_contains "validation logs stderr" "$debug_log" "stderr=<empty>"
  check_eq "validation cleans tempdir" "" "$remaining"
}

test_fallback_when_queue_analysis_fails() {
  local stdout stderr
  stdout="$TEST_TMP/fallback.out"
  stderr="$TEST_TMP/fallback.err"
  FUNCTIONS_FILE="$FUNCTIONS_FILE" CANDIDATES="$CANDIDATES" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    render_prompt_under_test() {
      local available="$1" avail_unblocked avail_blocked avail_blocked_count queue_plan_json
      avail_unblocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 == 0 || $6 == ""'"'"')
      avail_blocked=$(echo "$available" | awk -F'"'"'|'"'"' '"'"'$6 > 0'"'"')
      avail_blocked_count=0
      [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

      echo "Next tasks:"
      queue_plan_json=""
      GROUPED_DISPLAY=""
      GROUPED_SELECT_FROM=""
      if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
        render_grouped_task_list "$queue_plan_json" "$available"
        if [[ -n "$GROUPED_DISPLAY" ]]; then
          echo "$GROUPED_DISPLAY"
          select_from="$GROUPED_SELECT_FROM"
          USING_GROUPED_VIEW=true
        fi
      fi
      if [[ -z "$GROUPED_DISPLAY" ]]; then
        USING_GROUPED_VIEW=false
        [[ -n "$queue_plan_json" ]] || log_warn "queue analysis unavailable, falling back to flat list"
        if [[ -n "$avail_unblocked" ]]; then
          echo "$avail_unblocked" | head -9 | awk -F'"'"'|'"'"' '"'"'{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'"'"'
        else
          echo "  (no unblocked tasks)"
        fi
        if (( avail_blocked_count > 0 )); then
          echo ""
          echo "  ($avail_blocked_count blocked task(s) hidden - enter '\''m'\'' to show all)"
        fi
      fi
    }
    log_warn() { printf "%s\n" "$*" >&2; }
    fetch_queue_plan() { return 1; }
    USING_GROUPED_VIEW=false
    SELECT_SHOW_ALL=false
    GROUPED_SELECT_FROM=""
    GROUPED_DISPLAY=""
    render_prompt_under_test "$CANDIDATES"
  ' >"$stdout" 2>"$stderr"

  stdout=$(cat "$stdout")
  stderr=$(cat "$stderr")
  check_contains "fallback prints flat list" "$stdout" "1. HOK-10 - Foundation task (score: 98)"
  check_contains "fallback preserves more hint" "$stdout" "(3 blocked task(s) hidden - enter 'm' to show all)"
  check_not_contains "fallback omits grouped header" "$stdout" "Available Now - Parallel Wave 1"
  check_contains "fallback warns once" "$stderr" "queue analysis unavailable, falling back to flat list"
}

echo "=== Task Selection Renderer ==="
test_fetch_queue_plan_transforms_linear_backlog
test_invoke_first_wave_helper_packs_priority_without_violating_dependencies
test_grouped_render_with_fixture_output
test_render_rejects_malformed_json
test_fetch_queue_plan_logs_cache_empty
test_fetch_queue_plan_logs_jq_massage_failure
test_fetch_queue_plan_logs_plan_queue_exec_failure_and_cleans_tempdir
test_fetch_queue_plan_logs_validation_failure_and_cleans_tempdir
test_fallback_when_queue_analysis_fails

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
