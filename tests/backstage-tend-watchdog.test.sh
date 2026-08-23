#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  missing: $needle"
    echo "  actual: $haystack"
    exit 1
  fi
}

source "$COMMON_SCRIPT"

FUNCS_FILE="$TMP_DIR/backstage-functions.sh"
: > "$FUNCS_FILE"
for fn in \
  backstage_restart_backoff_seconds \
  read_backstage_health_field \
  read_backstage_service_health_field \
  classify_ready_watchdog_hold_health \
  classify_backstage_health \
  backstage_tend_restart_diagnostic \
  check_backstage_health
do
  extract_function "$MILL_SCRIPT" "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

SESSION="test-session"
STATE_DIR="$TMP_DIR/state"
REPO_DIR="$TMP_DIR/repo"
TOOLS_DIR="$TMP_DIR/tools"
mkdir -p "$STATE_DIR" "$REPO_DIR/.wavemill/logs" "$TOOLS_DIR"
HEALTH_FILE="$STATE_DIR/backstage-health.json"
LOG_FILE="$TMP_DIR/log.txt"
RESTART_LOG="$TMP_DIR/restarts.txt"
: > "$LOG_FILE"
: > "$RESTART_LOG"

BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
BACKSTAGE_RESTART_BACKOFF_MAX_SECONDS=900
BACKSTAGE_RESTART_NEEDS_USER_AFTER_ATTEMPTS=3
BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS=0
BACKSTAGE_TEND_RESTART_GRACE_SECONDS=120
BACKSTAGE_TEND_HEARTBEAT_STALE_SECONDS=210
BACKSTAGE_CLASSIFICATION_HOLD_STALE_SECONDS=900
LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
PANE_PROBE=""
CONFIRM_RC=1

backstage_health_enabled() { return 0; }
probe_backstage_panes() { printf '%s\n' "$PANE_PROBE"; }
restart_backstage_tend_loop() {
  local count
  count="$(wc -l < "$RESTART_LOG" | tr -d ' ')"
  printf 'restart-%s\n' "$(( count + 1 ))" >> "$RESTART_LOG"
  printf '%%%s\n' "$(( count + 9 ))"
}
backstage_tend_restart_confirmed() {
  if (( CONFIRM_RC == 0 )); then
    printf '2026-08-18T12:00:10Z\n'
    return 0
  fi
  return 1
}
log() { printf 'LOG %s\n' "$*" >> "$LOG_FILE"; }
log_warn() { printf 'WARN %s\n' "$*" >> "$LOG_FILE"; }

write_health() {
  local status="$1" detail="$2" count="$3" at="$4" pane="${5:-}" heartbeat="${6:-}"
  wavemill_write_backstage_health "$HEALTH_FILE" "$status" "$detail" "$count" "$at" "$pane"
  if [[ -n "$heartbeat" ]]; then
    state_mutate "$HEALTH_FILE" '.services.tend.heartbeatAt = $heartbeat' --arg heartbeat "$heartbeat"
  fi
}

old_iso() {
  perl -MPOSIX=strftime -e 'my $offset = shift @ARGV; print strftime("%Y-%m-%dT%H:%M:%SZ", gmtime(time() - $offset)), "\n"' -- "$1"
}

assert_eq "backoff 0" "0" "$(backstage_restart_backoff_seconds 0)"
assert_eq "backoff 1" "60" "$(backstage_restart_backoff_seconds 1)"
assert_eq "backoff 2" "120" "$(backstage_restart_backoff_seconds 2)"
assert_eq "backoff 3" "240" "$(backstage_restart_backoff_seconds 3)"
assert_eq "backoff 4" "480" "$(backstage_restart_backoff_seconds 4)"
assert_eq "backoff 5" "900" "$(backstage_restart_backoff_seconds 5)"
assert_eq "backoff cap" "900" "$(backstage_restart_backoff_seconds 40)"

PANE_PROBE=$'%1\tWavemill Jobs\t0\tzsh\tzsh'
check_backstage_health
assert_eq "first restart count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_eq "first restart status" "missing-tend-loop" "$(jq -r '.status' "$HEALTH_FILE")"
assert_contains "first detail" "$(jq -r '.detail' "$HEALTH_FILE")" "fresh heartbeat"
assert_eq "first restart calls" "1" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"

write_health "missing-tend-loop" "old miss" 1 "$(old_iso 10)"
check_backstage_health
assert_eq "cooldown restart calls" "1" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_contains "cooldown detail" "$(jq -r '.detail' "$HEALTH_FILE")" "next automatic restart"

write_health "missing-tend-loop" "old miss" 1 "$(old_iso 70)"
check_backstage_health
assert_eq "second restart calls" "2" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "second count" "2" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"

write_health "missing-tend-loop" "old miss" 3 "$(old_iso 300)"
check_backstage_health
assert_eq "needs user still restarts" "3" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "needs user status" "needs-user" "$(jq -r '.status' "$HEALTH_FILE")"

write_health "needs-user" "waiting" 5 "$(old_iso 600)"
check_backstage_health
assert_eq "needs user cooldown no restart" "3" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_contains "needs user cooldown detail" "$(jq -r '.detail' "$HEALTH_FILE")" "next automatic restart"

CONFIRM_RC=0
write_health "missing-tend-loop" "old miss" 3 "$(old_iso 300)"
check_backstage_health
assert_eq "confirmed status" "healthy" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "confirmed count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "confirmed log" "$(cat "$LOG_FILE")" "confirmed by heartbeat"
CONFIRM_RC=1

attempt_at="$(old_iso 30)"
write_health "missing-tend-loop" "pending" 1 "$attempt_at" "%9" "$(old_iso 90)"
PANE_PROBE=$'%9\tWavemill Tend Loop\t0\tnode\tnpx tsx tools/tend.ts'
check_backstage_health
assert_eq "pending status" "missing-tend-loop" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "pending count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "pending detail" "$(jq -r '.detail' "$HEALTH_FILE")" "pending"

state_mutate "$HEALTH_FILE" '.services.tend.heartbeatAt = $heartbeat' --arg heartbeat "$(old_iso 1)"
check_backstage_health
assert_eq "new heartbeat status" "healthy" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "new heartbeat count" "0" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"

write_health "healthy" "ok" 0 "" "%9" "$(old_iso 300)"
PANE_PROBE=$'%9\tWavemill Tend Loop\t0\tnode\tnpx tsx tools/tend.ts'
check_backstage_health
assert_eq "stale heartbeat restarts" "5" "$(wc -l < "$RESTART_LOG" | tr -d ' ')"
assert_eq "stale heartbeat status" "stalled" "$(jq -r '.status' "$HEALTH_FILE")"
assert_eq "stale heartbeat count" "1" "$(jq -r '.restartAttemptCount' "$HEALTH_FILE")"
assert_contains "stale heartbeat detail" "$(jq -r '.detail' "$HEALTH_FILE")" "fresh heartbeat"

state_mutate "$HEALTH_FILE" '.services.tend.failureCount = 2 | .services.tend.lastError = "transient: github 503"'
wavemill_write_backstage_service_health "$HEALTH_FILE" "tend" "healthy" "ok" 0 "" "%9" "$(old_iso 1)"
assert_eq "merged failure count" "2" "$(jq -r '.services.tend.failureCount' "$HEALTH_FILE")"
assert_eq "merged last error" "transient: github 503" "$(jq -r '.services.tend.lastError' "$HEALTH_FILE")"
assert_eq "omitted instance count is null" "null" "$(jq -r '.services.tend.instanceCount' "$HEALTH_FILE")"

wavemill_write_backstage_service_health "$HEALTH_FILE" "tend" "healthy" "ok" 0 "" "%9" "$(old_iso 1)" 1
assert_eq "explicit instance count is written" "1" "$(jq -r '.services.tend.instanceCount' "$HEALTH_FILE")"

echo "backstage tend watchdog tests passed"
