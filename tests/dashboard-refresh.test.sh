#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

now_seconds() {
  perl -MTime::HiRes=time -e 'printf "%.6f\n", time'
}

measure_delta() {
  local start="$1" finish="$2"
  perl -e 'printf "%.6f\n", $ARGV[1] - $ARGV[0]' "$start" "$finish"
}

float_le() {
  perl -e 'exit(($ARGV[0] <= $ARGV[1]) ? 0 : 1)' "$1" "$2"
}

float_ge() {
  perl -e 'exit(($ARGV[0] >= $ARGV[1]) ? 0 : 1)' "$1" "$2"
}

resolve_refresh_case() {
  local value="${1-}"
  local output_var="$2"
  local err_var="$3"
  local refresh_output err_file

  err_file="$(mktemp)"
  if [[ -n "$value" ]]; then
    refresh_output="$(
      WAVEMILL_DASHBOARD_REFRESH_SECONDS="$value" bash -lc '
        set -euo pipefail
        set -- test-session /tmp
        tput() { :; }
        source "'"$REPO_DIR"'/shared/lib/wavemill-status.sh"
        printf "%s\n" "$REFRESH"
      ' 2>"$err_file"
    )"
  else
    refresh_output="$(
      bash -lc '
        set -euo pipefail
        set -- test-session /tmp
        unset WAVEMILL_DASHBOARD_REFRESH_SECONDS
        tput() { :; }
        source "'"$REPO_DIR"'/shared/lib/wavemill-status.sh"
        printf "%s\n" "$REFRESH"
      ' 2>"$err_file"
    )"
  fi

  printf -v "$output_var" '%s' "$refresh_output"
  printf -v "$err_var" '%s' "$(cat "$err_file")"
  rm -f "$err_file"
}

run_dashboard_probe() {
  local output_file="$1"
  local stop_file="$2"

  WAVEMILL_DASHBOARD_REFRESH_SECONDS=2 \
  OUTPUT_FILE="$output_file" \
  STOP_FILE="$stop_file" \
  bash -lc '
    set -euo pipefail
    set -- test-session /tmp
    tput() { :; }
    source "'"$REPO_DIR"'/shared/lib/wavemill-status.sh"

    refresh_pr_cache() { :; }
    clear_dashboard_scrollback() { :; }
    redraw_dashboard_frame() { :; }
    gather_tasks() { :; }

    render_dashboard() {
      local now
      now=$(perl -MTime::HiRes=time -e '"'"'printf "%.6f\n", time'"'"')
      printf "%s\n" "$now" >> "$OUTPUT_FILE"
      if [[ -f "$STOP_FILE" ]]; then
        exit 0
      fi
    }

    run_dashboard
  ' >/dev/null 2>&1 &
  echo $!
}

wait_for_lines() {
  local file="$1"
  local expected="$2"
  local attempts="${3:-200}"
  local count=0
  local current=0

  while (( count < attempts )); do
    if [[ -f "$file" ]]; then
      current=$(wc -l < "$file")
      (( current >= expected )) && return 0
    fi
    sleep 0.02
    count=$((count + 1))
  done

  return 1
}

read_line() {
  sed -n "${2}p" "$1"
}

cleanup_dashboard_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
}

echo "=== Dashboard Refresh Timing ==="

refresh=""
stderr_output=""

resolve_refresh_case "" refresh stderr_output
if [[ "$refresh" == "2" && -z "$stderr_output" ]]; then
  pass "default refresh interval resolves to 2 seconds"
else
  fail "default refresh interval expected 2 without warning"
fi

resolve_refresh_case "3" refresh stderr_output
if [[ "$refresh" == "3" && -z "$stderr_output" ]]; then
  pass "valid refresh override of 3 seconds is accepted"
else
  fail "valid refresh override of 3 seconds was not accepted"
fi

resolve_refresh_case "1" refresh stderr_output
if [[ "$refresh" == "1" && -z "$stderr_output" ]]; then
  pass "lower bound refresh override of 1 second is accepted"
else
  fail "lower bound refresh override of 1 second was not accepted"
fi

resolve_refresh_case "10" refresh stderr_output
if [[ "$refresh" == "10" && -z "$stderr_output" ]]; then
  pass "upper bound refresh override of 10 seconds is accepted"
else
  fail "upper bound refresh override of 10 seconds was not accepted"
fi

for invalid_value in "0" "abc" "99"; do
  resolve_refresh_case "$invalid_value" refresh stderr_output
  if [[ "$refresh" == "2" ]] \
    && grep -q "wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=${invalid_value}, using default 2" <<< "$stderr_output"; then
    pass "invalid refresh value ${invalid_value} falls back to 2 with warning"
  else
    fail "invalid refresh value ${invalid_value} did not fall back with warning"
  fi
done

TMP_DIR="$(mktemp -d)"
TIMESTAMPS_FILE="$TMP_DIR/dashboard-times.txt"
STOP_FILE="$TMP_DIR/stop"
DASHBOARD_PID="$(run_dashboard_probe "$TIMESTAMPS_FILE" "$STOP_FILE")"
trap 'cleanup_dashboard_pid "$DASHBOARD_PID"; rm -rf "$TMP_DIR"' EXIT

if wait_for_lines "$TIMESTAMPS_FILE" 2 250; then
  first_render="$(read_line "$TIMESTAMPS_FILE" 1)"
  second_render="$(read_line "$TIMESTAMPS_FILE" 2)"
  idle_delta="$(measure_delta "$first_render" "$second_render")"
  if float_ge "$idle_delta" "1.5" && float_le "$idle_delta" "3.5"; then
    pass "idle refresh cadence stays within 2 second tolerance"
  else
    fail "idle refresh cadence outside tolerance: ${idle_delta}s"
  fi
else
  fail "dashboard probe did not produce two idle renders"
fi

signal_sent_at="$(now_seconds)"
kill -USR1 "$DASHBOARD_PID"
if wait_for_lines "$TIMESTAMPS_FILE" 3 50; then
  third_render="$(read_line "$TIMESTAMPS_FILE" 3)"
  signal_delta="$(measure_delta "$signal_sent_at" "$third_render")"
  if float_ge "$signal_delta" "0" && float_le "$signal_delta" "0.5"; then
    pass "USR1 wakes the dashboard loop within 500ms"
  else
    fail "USR1 wake latency exceeded 500ms: ${signal_delta}s"
  fi
else
  fail "dashboard probe did not render after USR1"
fi

rapid_signal_sent_at="$(now_seconds)"
kill -USR1 "$DASHBOARD_PID"
kill -USR1 "$DASHBOARD_PID"
if wait_for_lines "$TIMESTAMPS_FILE" 4 50; then
  fourth_render="$(read_line "$TIMESTAMPS_FILE" 4)"
  rapid_delta="$(measure_delta "$rapid_signal_sent_at" "$fourth_render")"
  if float_ge "$rapid_delta" "0" && float_le "$rapid_delta" "0.5"; then
    pass "rapid consecutive USR1 signals still trigger a prompt redraw"
  else
    fail "rapid consecutive USR1 signals were not handled promptly: ${rapid_delta}s"
  fi
else
  fail "dashboard probe did not redraw after rapid signals"
fi

touch "$STOP_FILE"
kill -USR1 "$DASHBOARD_PID"
wait "$DASHBOARD_PID" 2>/dev/null || true

echo ""
echo "=== Hook Notify Contract ==="

HOOK_PROTOCOL_LIB="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"
if bash -lc '
  set -euo pipefail
  source "'"$HOOK_PROTOCOL_LIB"'"

  kill_log=$(mktemp)
  cleanup() {
    rm -f "$kill_log" "$hook_file"
  }

  kill() {
    printf "%s %s\n" "$1" "$2" >> "$kill_log"
    return 0
  }

  export WAVEMILL_SESSION="hook-count-$$"
  export WAVEMILL_ISSUE="TEST-COUNT"
  export WAVEMILL_DASHBOARD_PID="4242"
  hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"

  for _ in 1 2 3 4 5; do
    wavemill_hook_write "working" "PreToolUse" "Read" "claude"
  done

  [[ -s "$hook_file" ]] || { cleanup; exit 1; }
  [[ "$(grep -c "^-0 4242$" "$kill_log")" -eq 5 ]] || { cleanup; exit 1; }
  [[ "$(grep -c "^-USR1 4242$" "$kill_log")" -eq 5 ]] || { cleanup; exit 1; }
  [[ "$(wc -l < "$kill_log")" -eq 10 ]] || { cleanup; exit 1; }
  cleanup
' >/dev/null 2>&1; then
  pass "successful hook writes notify exactly once per write"
else
  fail "successful hook writes did not notify exactly once per write"
fi

if bash -lc '
  set -euo pipefail
  source "'"$HOOK_PROTOCOL_LIB"'"

  kill_log=$(mktemp)
  cleanup() {
    rm -f "$kill_log"
    rm -f /tmp/wavemill-${WAVEMILL_SESSION}-TEST-*.hook 2>/dev/null || true
  }

  kill() {
    printf "%s %s\n" "$1" "${2-}" >> "$kill_log"
    if [[ "$1" == "-0" && "$2" == "99999999" ]]; then
      return 1
    fi
    return 0
  }

  export WAVEMILL_SESSION="hook-invalid-$$"

  export WAVEMILL_ISSUE="TEST-empty"
  unset WAVEMILL_DASHBOARD_PID
  wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"

  export WAVEMILL_ISSUE="TEST-alpha"
  export WAVEMILL_DASHBOARD_PID="abc"
  wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"

  export WAVEMILL_ISSUE="TEST-negative"
  export WAVEMILL_DASHBOARD_PID="-1"
  wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"

  export WAVEMILL_ISSUE="TEST-zero"
  export WAVEMILL_DASHBOARD_PID="0"
  wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"

  export WAVEMILL_ISSUE="TEST-dead"
  export WAVEMILL_DASHBOARD_PID="99999999"
  wavemill_hook_write "working" "UserPromptSubmit" "noop" "claude"

  for suffix in empty alpha negative zero dead; do
    [[ -s "/tmp/wavemill-${WAVEMILL_SESSION}-TEST-${suffix}.hook" ]] || { cleanup; exit 1; }
  done

  [[ "$(grep -c "^-0 99999999$" "$kill_log")" -eq 1 ]] || { cleanup; exit 1; }
  ! grep -q "^-USR1" "$kill_log" || { cleanup; exit 1; }
  cleanup
' >/dev/null 2>&1; then
  pass "invalid or stale dashboard PIDs degrade gracefully without USR1 failures"
else
  fail "invalid or stale dashboard PIDs did not degrade gracefully"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
