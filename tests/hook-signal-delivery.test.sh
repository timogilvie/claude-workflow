#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Hook Signal Delivery ==="

if [[ ! -f "$HOOK_PROTOCOL" ]]; then
  fail "wavemill-hook-protocol.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

if (
  source "$HOOK_PROTOCOL"
  marker="$(mktemp /tmp/wavemill-hook-signal.XXXXXX)"
  hook_file="/tmp/wavemill-hook-test-session-TEST-1222.hook"
  rm -f "$marker" "$hook_file" "$hook_file.tmp."*

  cleanup() {
    [[ -n "${test_pid:-}" ]] && kill "$test_pid" 2>/dev/null || true
    [[ -n "${test_pid:-}" ]] && wait "$test_pid" 2>/dev/null || true
    rm -f "$marker" "$hook_file" "$hook_file.tmp."*
  }
  trap cleanup EXIT

  export WAVEMILL_SESSION="hook-test-session"
  export WAVEMILL_ISSUE="TEST-1222"
  MARKER_FILE="$marker" perl -e '$SIG{USR1}=sub{system(q(touch), $ENV{MARKER_FILE}); exit 0}; sleep 30' &
  test_pid=$!
  sleep 0.1
  export WAVEMILL_DASHBOARD_PID="$test_pid"

  wavemill_hook_write "working" "TestEvent" "TestDetail" "claude"
  for _ in 1 2 3 4 5; do
    [[ -f "$marker" ]] && break
    sleep 0.1
  done

  [[ -f "$marker" ]]
); then
  pass "hook write sends USR1 to the dashboard pid"
else
  fail "hook write did not deliver USR1 to the dashboard pid"
fi

if (
  source "$HOOK_PROTOCOL"
  marker="$(mktemp /tmp/wavemill-hook-nosignal.XXXXXX)"
  hook_file="/tmp/wavemill-hook-test-session-TEST-1222.hook"
  rm -f "$marker" "$hook_file" "$hook_file.tmp."*

  cleanup() {
    [[ -n "${test_pid:-}" ]] && kill "$test_pid" 2>/dev/null || true
    [[ -n "${test_pid:-}" ]] && wait "$test_pid" 2>/dev/null || true
    rm -f "$marker" "$hook_file" "$hook_file.tmp."*
  }
  trap cleanup EXIT

  export WAVEMILL_SESSION="hook-test-session"
  export WAVEMILL_ISSUE="TEST-1222"
  unset WAVEMILL_DASHBOARD_PID
  MARKER_FILE="$marker" perl -e '$SIG{USR1}=sub{system(q(touch), $ENV{MARKER_FILE}); exit 0}; sleep 30' &
  test_pid=$!
  sleep 0.1

  wavemill_hook_write "working" "TestEvent" "" "claude"
  sleep 0.3

  [[ ! -f "$marker" ]]
); then
  pass "hook write skips USR1 when the dashboard pid is unset"
else
  fail "hook write signaled even though the dashboard pid was unset"
fi

if (
  source "$HOOK_PROTOCOL"
  hook_file="/tmp/wavemill-hook-test-session-TEST-1222.hook"
  trap 'rm -f "$hook_file" "$hook_file.tmp."*' EXIT
  export WAVEMILL_SESSION="hook-test-session"
  export WAVEMILL_ISSUE="TEST-1222"
  export WAVEMILL_DASHBOARD_PID="999999"
  wavemill_hook_write "working" "TestEvent" "" "claude"
); then
  pass "hook write ignores invalid dashboard pids"
else
  fail "hook write failed when the dashboard pid was invalid"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
