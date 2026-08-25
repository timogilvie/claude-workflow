#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=../shared/lib/wavemill-common.sh disable=SC1091
source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
PIDS=()
SPAWNED_PID=""

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

cleanup() {
  local pid
  for pid in "${PIDS[@]:-}"; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT

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

check_contains_pid() {
  local name="$1" expected_pid="$2" pid
  for pid in "${MILL_BLOCKING_PROCESS_PIDS[@]:-}"; do
    if [[ "$pid" == "$expected_pid" ]]; then
      pass "$name"
      return
    fi
  done
  echo "    expected pid: $expected_pid"
  echo "    actual pids:   ${MILL_BLOCKING_PROCESS_PIDS[*]:-}"
  fail "$name"
}

check_not_contains_pid() {
  local name="$1" unexpected_pid="$2" pid
  for pid in "${MILL_BLOCKING_PROCESS_PIDS[@]:-}"; do
    if [[ "$pid" == "$unexpected_pid" ]]; then
      echo "    unexpected pid: $unexpected_pid"
      echo "    actual pids:    ${MILL_BLOCKING_PROCESS_PIDS[*]:-}"
      fail "$name"
      return
    fi
  done
  pass "$name"
}

wait_for_command_line() {
  local pid="$1" needle="$2" line attempt
  for ((attempt = 0; attempt < 50; attempt++)); do
    line="$(wavemill_process_command_line "$pid" 2>/dev/null || true)"
    if [[ "$line" == *"$needle"* ]]; then
      return 0
    fi
    sleep 0.1
  done
  echo "process $pid command line did not contain '$needle'" >&2
  return 1
}

spawn_prompt_process() {
  local blocking_command="$1" pid
  bash -c 'while :; do sleep 1; done' \
    codex --model gpt-5 --no-alt-screen \
    "You are working on: HOK-2882. Blocking check: ${blocking_command}" &
  pid=$!
  PIDS+=("$pid")
  wait_for_command_line "$pid" "$blocking_command"
  SPAWNED_PID="$pid"
}

spawn_argv_process() {
  local argv0="$1" sleep_arg="${2:-60}" pid
  bash -c 'exec -a "$0" sleep "$1"' "$argv0" "$sleep_arg" &
  pid=$!
  PIDS+=("$pid")
  wait_for_command_line "$pid" "$argv0 $sleep_arg"
  SPAWNED_PID="$pid"
}

echo "=== Blocked Completion Liveness Matching ==="

unique="hok2882-blocker-$$"
blocking_command="$unique 60"
spawn_prompt_process "$blocking_command"
agent_pid="$SPAWNED_PID"

if mill_pane_has_live_blocking_process "$$" "$blocking_command"; then
  clear_rc=0
else
  clear_rc=$?
fi
check_eq "prompt-only command text is not live" "1" "$clear_rc"
check_eq "prompt-only match count remains zero" "0" "${MILL_BLOCKING_PROCESS_MATCH_COUNT:-}"
check_eq "prompt-only pids remain empty" "0" "${#MILL_BLOCKING_PROCESS_PIDS[@]}"

spawn_argv_process "$unique" 60
blocker_pid="$SPAWNED_PID"
if mill_pane_has_live_blocking_process "$$" "$blocking_command"; then
  live_rc=0
else
  live_rc=$?
fi
check_eq "leading command is live" "0" "$live_rc"
check_contains_pid "leading command pid is reported" "$blocker_pid"
check_not_contains_pid "agent prompt pid is not reported" "$agent_pid"

kill "$blocker_pid" 2>/dev/null || true
wait "$blocker_pid" 2>/dev/null || true

spawn_argv_process "${unique}x" 60
lookalike_pid="$SPAWNED_PID"
if mill_pane_has_live_blocking_process "$$" "$unique"; then
  lookalike_rc=0
else
  lookalike_rc=$?
fi
check_eq "prefix lookalike command is not live" "1" "$lookalike_rc"
check_eq "prefix lookalike match count remains zero" "0" "${MILL_BLOCKING_PROCESS_MATCH_COUNT:-}"

spawn_argv_process "$unique" 60
extra_pid="$SPAWNED_PID"
if mill_pane_has_live_blocking_process "$$" "$unique"; then
  extra_rc=0
else
  extra_rc=$?
fi
check_eq "valid extra arguments preserve token boundary" "0" "$extra_rc"
check_contains_pid "valid extra argument pid is reported" "$extra_pid"
check_not_contains_pid "lookalike pid is not reported" "$lookalike_pid"

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS blocked-completion liveness tests passed"
else
  echo "$FAIL blocked-completion liveness tests failed ($PASS passed)"
  exit 1
fi
