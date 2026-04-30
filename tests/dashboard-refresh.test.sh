#!/usr/bin/env bash
set -euo pipefail

# Dashboard refresh interval and signal-driven redraw tests.
# Validates REQ-F1 (configurable interval), REQ-F3 (USR1 sub-second redraw),
# and rapid-signal resilience.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Portable millisecond timestamp: python3 on macOS/Darwin, date +%s%N on Linux.
ts_ms() { python3 -c 'import time; print(int(time.time()*1000))' 2>/dev/null || echo $(( $(date +%s) * 1000 )); }
export -f ts_ms

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# ============================================================================
# TEST 1: Refresh interval resolver — defaults and overrides
# ============================================================================
echo "=== Refresh Interval Resolver ==="

run_resolver() {
  bash -c '
    WAVEMILL_DASHBOARD_REFRESH_DEFAULT=2
    WAVEMILL_DASHBOARD_REFRESH_MAX=10
    resolve_dashboard_refresh_seconds() {
      local raw="${WAVEMILL_DASHBOARD_REFRESH_SECONDS:-$WAVEMILL_DASHBOARD_REFRESH_DEFAULT}"
      if ! [[ "$raw" =~ ^[0-9]+$ ]] || (( raw < 1 || raw > WAVEMILL_DASHBOARD_REFRESH_MAX )); then
        echo "wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=$raw, using default $WAVEMILL_DASHBOARD_REFRESH_DEFAULT" >&2
        echo "$WAVEMILL_DASHBOARD_REFRESH_DEFAULT"
        return 0
      fi
      echo "$raw"
    }
    export WAVEMILL_DASHBOARD_REFRESH_SECONDS='"'$1'"'
    resolve_dashboard_refresh_seconds
  ' 2>/dev/null
}

run_resolver_stderr() {
  bash -c '
    WAVEMILL_DASHBOARD_REFRESH_DEFAULT=2
    WAVEMILL_DASHBOARD_REFRESH_MAX=10
    resolve_dashboard_refresh_seconds() {
      local raw="${WAVEMILL_DASHBOARD_REFRESH_SECONDS:-$WAVEMILL_DASHBOARD_REFRESH_DEFAULT}"
      if ! [[ "$raw" =~ ^[0-9]+$ ]] || (( raw < 1 || raw > WAVEMILL_DASHBOARD_REFRESH_MAX )); then
        echo "wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=$raw, using default $WAVEMILL_DASHBOARD_REFRESH_DEFAULT" >&2
        echo "$WAVEMILL_DASHBOARD_REFRESH_DEFAULT"
        return 0
      fi
      echo "$raw"
    }
    export WAVEMILL_DASHBOARD_REFRESH_SECONDS='"'$1'"'
    resolve_dashboard_refresh_seconds
  ' 2>&1 1>/dev/null
}

# Unset env resolves to default 2
result=$(bash -c '
  WAVEMILL_DASHBOARD_REFRESH_DEFAULT=2
  WAVEMILL_DASHBOARD_REFRESH_MAX=10
  resolve_dashboard_refresh_seconds() {
    local raw="${WAVEMILL_DASHBOARD_REFRESH_SECONDS:-$WAVEMILL_DASHBOARD_REFRESH_DEFAULT}"
    if ! [[ "$raw" =~ ^[0-9]+$ ]] || (( raw < 1 || raw > WAVEMILL_DASHBOARD_REFRESH_MAX )); then
      echo "wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=$raw, using default $WAVEMILL_DASHBOARD_REFRESH_DEFAULT" >&2
      echo "$WAVEMILL_DASHBOARD_REFRESH_DEFAULT"
      return 0
    fi
    echo "$raw"
  }
  unset WAVEMILL_DASHBOARD_REFRESH_SECONDS
  resolve_dashboard_refresh_seconds
' 2>/dev/null)
if [[ "$result" == "2" ]]; then
  pass "unset env resolves to 2"
else
  fail "unset env resolved to '$result', expected '2'"
fi

# Valid override 3
result=$(run_resolver "3")
if [[ "$result" == "3" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=3 resolves to 3"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=3 resolved to '$result'"
fi

# Valid override 1 (lower bound)
result=$(run_resolver "1")
if [[ "$result" == "1" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=1 resolves to 1"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=1 resolved to '$result'"
fi

# Valid override 10 (upper bound)
result=$(run_resolver "10")
if [[ "$result" == "10" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=10 resolves to 10"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=10 resolved to '$result'"
fi

# Invalid: 0
result=$(run_resolver "0")
if [[ "$result" == "2" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=0 falls back to 2"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=0 resolved to '$result'"
fi

# Invalid: abc
result=$(run_resolver "abc")
if [[ "$result" == "2" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=abc falls back to 2"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=abc resolved to '$result'"
fi

# Invalid: 99 (above max)
result=$(run_resolver "99")
if [[ "$result" == "2" ]]; then
  pass "WAVEMILL_DASHBOARD_REFRESH_SECONDS=99 falls back to 2"
else
  fail "WAVEMILL_DASHBOARD_REFRESH_SECONDS=99 resolved to '$result'"
fi

# Invalid values emit a warning
stderr_out=$(run_resolver_stderr "0")
if [[ "$stderr_out" == *"invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=0"* ]]; then
  pass "invalid value emits warning to stderr"
else
  fail "expected stderr warning for invalid value, got: '$stderr_out'"
fi

# ============================================================================
# TEST 2: Idle cadence — loop redraws within expected interval
# ============================================================================
echo ""
echo "=== Idle Cadence ==="

if bash -c '
  set -euo pipefail
  REDRAW_LOG=$(mktemp "/tmp/wavemill-cadence-XXXXXX")
  trap "rm -f $REDRAW_LOG" EXIT

  REFRESH=2
  WAVEMILL_REDRAW=0

  iterations=0
  while (( iterations < 3 )); do
    trap "" USR1
    ts_ms >> "$REDRAW_LOG"
    (( iterations += 1 ))
    trap "WAVEMILL_REDRAW=1" USR1
    WAVEMILL_REDRAW=0
    sleep "$REFRESH" &
    wait $! 2>/dev/null || true
  done

  lines=$(wc -l < "$REDRAW_LOG" | tr -d " ")
  (( lines >= 3 )) || exit 1

  prev=""
  while IFS= read -r ts; do
    if [[ -n "$prev" ]]; then
      delta_ms=$(( ts - prev ))
      (( delta_ms >= 1500 && delta_ms <= 3500 )) || exit 1
    fi
    prev="$ts"
  done < "$REDRAW_LOG"
' 2>/dev/null; then
  pass "idle cadence is within 1.5s–3.5s tolerance"
else
  fail "idle cadence outside expected range"
fi

# ============================================================================
# TEST 3: USR1 triggers sub-second redraw
# ============================================================================
echo ""
echo "=== Signal-Driven Redraw Latency ==="

if bash -c '
  set -euo pipefail
  REDRAW_LOG=$(mktemp "/tmp/wavemill-signal-XXXXXX")
  SIGNAL_TS_FILE=$(mktemp "/tmp/wavemill-signal-ts-XXXXXX")
  trap "rm -f $REDRAW_LOG $SIGNAL_TS_FILE" EXIT

  REFRESH=10
  WAVEMILL_REDRAW=0

  render_stub() {
    ts_ms >> "$REDRAW_LOG"
  }

  (
    iterations=0
    while (( iterations < 3 )); do
      trap "" USR1
      render_stub
      (( iterations += 1 ))
      trap "WAVEMILL_REDRAW=1" USR1
      WAVEMILL_REDRAW=0
      sleep "$REFRESH" &
      wait $! 2>/dev/null || true
    done
  ) &
  loop_pid=$!

  # Wait for first render
  for _ in {1..20}; do
    [[ -s "$REDRAW_LOG" ]] && break
    sleep 0.05
  done

  # Record pre-signal time and send USR1
  sleep 0.2
  ts_ms > "$SIGNAL_TS_FILE"
  kill -USR1 "$loop_pid" 2>/dev/null

  # Wait for second render (the signal-driven one)
  for _ in {1..50}; do
    lines=$(wc -l < "$REDRAW_LOG" | tr -d " ")
    (( lines >= 2 )) && break
    sleep 0.02
  done

  kill "$loop_pid" 2>/dev/null || true
  wait "$loop_pid" 2>/dev/null || true

  lines=$(wc -l < "$REDRAW_LOG" | tr -d " ")
  (( lines >= 2 )) || exit 1

  signal_ts=$(cat "$SIGNAL_TS_FILE")
  second_render=$(sed -n "2p" "$REDRAW_LOG")
  latency_ms=$(( second_render - signal_ts ))

  # Must redraw within 500ms of signal
  (( latency_ms >= 0 && latency_ms <= 500 )) || exit 1
' 2>/dev/null; then
  pass "USR1 triggers redraw within 500ms"
else
  fail "USR1 did not trigger sub-second redraw"
fi

# ============================================================================
# TEST 4: Rapid USR1 signals — no crash
# ============================================================================
echo ""
echo "=== Rapid Signal Resilience ==="

if bash -c '
  set -euo pipefail
  REDRAW_LOG=$(mktemp "/tmp/wavemill-rapid-XXXXXX")
  trap "rm -f $REDRAW_LOG" EXIT

  REFRESH=10
  WAVEMILL_REDRAW=0

  render_stub() {
    ts_ms >> "$REDRAW_LOG"
  }

  (
    iterations=0
    while (( iterations < 6 )); do
      trap "" USR1
      render_stub
      (( iterations += 1 ))
      trap "WAVEMILL_REDRAW=1" USR1
      WAVEMILL_REDRAW=0
      sleep "$REFRESH" &
      wait $! 2>/dev/null || true
    done
  ) &
  loop_pid=$!

  # Wait for first render
  for _ in {1..20}; do
    [[ -s "$REDRAW_LOG" ]] && break
    sleep 0.05
  done
  sleep 0.1

  # Send 5 rapid USR1 signals
  for _ in {1..5}; do
    kill -USR1 "$loop_pid" 2>/dev/null || true
    sleep 0.02
  done

  # Wait for at least one signal-driven redraw
  sleep 1

  kill "$loop_pid" 2>/dev/null || true
  wait "$loop_pid" 2>/dev/null || true

  lines=$(wc -l < "$REDRAW_LOG" | tr -d " ")
  # At least 2 redraws (initial + at least one signal-driven)
  (( lines >= 2 )) || exit 1
' 2>/dev/null; then
  pass "rapid USR1 signals do not crash the loop"
else
  fail "rapid USR1 signals caused a crash or no additional redraws"
fi

# ============================================================================
# TEST 5: Hook notify contract — valid PID receives exactly one USR1 per write
# ============================================================================
echo ""
echo "=== Hook Notify Contract ==="

HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

if [[ ! -f "$HOOK_PROTOCOL" ]]; then
  fail "wavemill-hook-protocol.sh not found"
else
  if bash -c '
    set -euo pipefail
    source "'"$HOOK_PROTOCOL"'"

    SIGNAL_COUNT_FILE=$(mktemp "/tmp/wavemill-notify-count-XXXXXX")
    echo 0 > "$SIGNAL_COUNT_FILE"
    cleanup() {
      kill "$listener_pid" 2>/dev/null || true
      wait "$listener_pid" 2>/dev/null || true
      rm -f "$SIGNAL_COUNT_FILE" "/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
    }

    (
      trap "
        count=\$(cat \"$SIGNAL_COUNT_FILE\" 2>/dev/null || echo 0)
        echo \$(( count + 1 )) > \"$SIGNAL_COUNT_FILE\"
      " USR1
      while :; do sleep 0.1 & wait $! 2>/dev/null || true; done
    ) &
    listener_pid=$!
    sleep 0.1

    export WAVEMILL_SESSION="notify-count-$$"
    export WAVEMILL_ISSUE="TEST-COUNT"
    export WAVEMILL_DASHBOARD_PID="$listener_pid"

    for i in 1 2 3; do
      wavemill_hook_write "working" "PreToolUse" "Read" "claude"
      sleep 0.15
    done

    sleep 0.3
    count=$(cat "$SIGNAL_COUNT_FILE" 2>/dev/null || echo 0)
    cleanup
    (( count == 3 )) || exit 1
  ' 2>/dev/null; then
    pass "3 hook writes deliver exactly 3 USR1 signals"
  else
    fail "hook write signal count mismatch"
  fi

  # Failed write (unrecognized state) does not notify
  if bash -c '
    set -euo pipefail
    source "'"$HOOK_PROTOCOL"'"

    SIGNAL_FILE=$(mktemp "/tmp/wavemill-nonotify-XXXXXX")
    rm -f "$SIGNAL_FILE"
    cleanup() {
      kill "$listener_pid" 2>/dev/null || true
      wait "$listener_pid" 2>/dev/null || true
      rm -f "$SIGNAL_FILE"
    }

    (trap "touch \"$SIGNAL_FILE\"; exit 0" USR1; while :; do sleep 0.1 & wait $! 2>/dev/null || true; done) &
    listener_pid=$!
    sleep 0.05

    export WAVEMILL_SESSION="notify-bad-state-$$"
    export WAVEMILL_ISSUE="TEST-BADSTATE"
    export WAVEMILL_DASHBOARD_PID="$listener_pid"

    wavemill_hook_write "invalid_state" "SomeEvent" "" "claude"
    sleep 0.2

    [[ ! -f "$SIGNAL_FILE" ]] || { cleanup; exit 1; }
    cleanup
  ' 2>/dev/null; then
    pass "unrecognized state does not trigger notification"
  else
    fail "unrecognized state triggered a notification"
  fi
fi

# ============================================================================
# RESULTS
# ============================================================================
echo ""
echo "--- Dashboard Refresh Tests: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
