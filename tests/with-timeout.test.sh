#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

check_lt() {
  local name="$1" actual="$2" limit="$3"
  if (( actual < limit )); then
    pass "$name"
  else
    echo "    expected less than: $limit"
    echo "    actual:             $actual"
    fail "$name"
  fi
}

check_ge() {
  local name="$1" actual="$2" limit="$3"
  if (( actual >= limit )); then
    pass "$name"
  else
    echo "    expected at least: $limit"
    echo "    actual:            $actual"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    echo "    in:      $haystack"
    fail "$name"
  fi
}

TEST_TMP="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-with-timeout.XXXXXX")"
cleanup_test_tmp() {
  rm -rf "$TEST_TMP"
}
trap cleanup_test_tmp EXIT

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$SCRIPT_DIR/fixtures/with-timeout-pre-change.sh"

now_seconds() { date +%s; }

matching_sleep_lines() {
  local duration="$1"
  ps -axo pid=,command= 2>/dev/null | awk -v duration="$duration" '
    $0 ~ ("(^|[[:space:]/])sleep[[:space:]]+" duration "($|[[:space:]])") {
      sub(/^[[:space:]]+/, "")
      print
    }
  '
}

kill_matching_sleep_duration() {
  local duration="$1" pid
  matching_sleep_lines "$duration" | awk '{print $1}' | while IFS= read -r pid; do
    [[ "$pid" =~ ^[0-9]+$ ]] || continue
    kill "$pid" 2>/dev/null || true
  done
}

choose_unused_sleep_duration() {
  local base offset duration
  base=$((30000 + ($$ % 20000)))
  for offset in 0 1 2 3 4 5 6 7 8 9 10; do
    duration=$((base + offset))
    if [[ -z "$(matching_sleep_lines "$duration")" ]]; then
      printf '%s\n' "$duration"
      return 0
    fi
  done
  return 1
}

assert_no_sleep_duration() {
  local name="$1" duration="$2" lines
  sleep 0.2
  lines="$(matching_sleep_lines "$duration")"
  if [[ -z "$lines" ]]; then
    pass "$name"
  else
    echo "    lingering sleep processes:"
    echo "$lines"
    kill_matching_sleep_duration "$duration"
    fail "$name"
  fi
}

install_timeout_backend_stub() {
  local bin_dir="$1"
  mkdir -p "$bin_dir"
  cat > "$bin_dir/timeout" <<'SH'
#!/usr/bin/env bash
set -u
backend_name="$(basename "$0")"
if [[ -n "${TIMEOUT_BACKEND_LOG:-}" ]]; then
  printf '%s\n' "$backend_name" >> "$TIMEOUT_BACKEND_LOG"
fi
secs="${1:-}"
[[ -n "$secs" ]] || exit 1
shift || exit 1
(( $# > 0 )) || exit 1
marker="$(mktemp "${TMPDIR:-/tmp}/wavemill-timeout-backend.XXXXXX")" || exit 1
rm -f "$marker"
"$@" &
cmd_pid=$!
(
  sleep "$secs" || exit 0
  : > "$marker"
  kill "$cmd_pid" 2>/dev/null || true
) >/dev/null 2>&1 &
watchdog_pid=$!
rc=0
wait "$cmd_pid" 2>/dev/null || rc=$?
if command -v pkill >/dev/null 2>&1; then
  pkill -P "$watchdog_pid" 2>/dev/null || true
fi
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
if [[ -f "$marker" ]]; then
  rc=124
fi
rm -f "$marker"
exit "$rc"
SH
  chmod +x "$bin_dir/timeout"
  cp "$bin_dir/timeout" "$bin_dir/gtimeout"
}

with_forced_fallback() {
  (
    command() {
      if [[ "${1:-}" == "-v" && ( "${2:-}" == "timeout" || "${2:-}" == "gtimeout" ) ]]; then
        return 1
      fi
      builtin command "$@"
    }
    _with_timeout "$@"
  )
}

with_pre_change_forced_fallback() {
  (
    command() {
      if [[ "${1:-}" == "-v" && ( "${2:-}" == "timeout" || "${2:-}" == "gtimeout" ) ]]; then
        return 1
      fi
      builtin command "$@"
    }
    _with_timeout_pre_change "$@"
  )
}

echo "=== _with_timeout canonicalization (HOK-2906) ==="

BACKEND_BIN="$TEST_TMP/backend-bin"
BACKEND_LOG="$TEST_TMP/backend.log"
install_timeout_backend_stub "$BACKEND_BIN"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
PATH="$BACKEND_BIN:$PATH" TIMEOUT_BACKEND_LOG="$BACKEND_LOG" _with_timeout "$duration" true
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "timeout backend fast success returns 0" "0" "$rc"
check_lt "timeout backend fast success returns immediately" "$elapsed" "2"
assert_no_sleep_duration "timeout backend fast success leaves no watchdog sleep" "$duration"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
PATH="$BACKEND_BIN:$PATH" TIMEOUT_BACKEND_LOG="$BACKEND_LOG" _with_timeout "$duration" false
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "timeout backend fast failure preserves rc" "1" "$rc"
check_lt "timeout backend fast failure returns immediately" "$elapsed" "2"
assert_no_sleep_duration "timeout backend fast failure leaves no watchdog sleep" "$duration"

set +e
PATH="$BACKEND_BIN:$PATH" TIMEOUT_BACKEND_LOG="$BACKEND_LOG" _with_timeout 5 bash -c 'exit 42'
rc=$?
set -e
check_eq "timeout backend preserves useful exit status" "42" "$rc"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
PATH="$BACKEND_BIN:$PATH" TIMEOUT_BACKEND_LOG="$BACKEND_LOG" _with_timeout 1 sleep "$duration"
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "timeout backend timeout returns 124" "124" "$rc"
check_ge "timeout backend timeout waits for deadline" "$elapsed" "1"
check_lt "timeout backend timeout does not wait for child duration" "$elapsed" "4"
assert_no_sleep_duration "timeout backend timeout kills wrapped sleep" "$duration"

G_TIMEOUT_LOG="$TEST_TMP/gtimeout.log"
set +e
(
  PATH="$BACKEND_BIN:$PATH"
  TIMEOUT_BACKEND_LOG="$G_TIMEOUT_LOG"
  export TIMEOUT_BACKEND_LOG
  command() {
    if [[ "${1:-}" == "-v" && "${2:-}" == "timeout" ]]; then
      return 1
    fi
    builtin command "$@"
  }
  _with_timeout 5 bash -c 'exit 42'
)
rc=$?
set -e
check_eq "gtimeout backend preserves useful exit status" "42" "$rc"
check_contains "gtimeout backend is selected when timeout is absent" "$(cat "$G_TIMEOUT_LOG")" "gtimeout"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
with_forced_fallback "$duration" true
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "fallback fast success returns 0" "0" "$rc"
check_lt "fallback fast success returns immediately" "$elapsed" "2"
assert_no_sleep_duration "fallback fast success leaves no watchdog sleep" "$duration"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
with_forced_fallback "$duration" false
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "fallback fast failure preserves rc" "1" "$rc"
check_lt "fallback fast failure returns immediately" "$elapsed" "2"
assert_no_sleep_duration "fallback fast failure leaves no watchdog sleep" "$duration"

set +e
with_forced_fallback 5 bash -c 'exit 42'
rc=$?
set -e
check_eq "fallback preserves useful exit status" "42" "$rc"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
with_forced_fallback 1 sleep "$duration"
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "fallback timeout normalizes to 124" "124" "$rc"
check_ge "fallback timeout waits for deadline" "$elapsed" "1"
check_lt "fallback timeout does not wait for child duration" "$elapsed" "4"
assert_no_sleep_duration "fallback timeout kills wrapped sleep" "$duration"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
out="$(with_forced_fallback "$duration" echo hi)"
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "fallback command substitution returns 0" "0" "$rc"
check_eq "fallback command substitution captures stdout" "hi" "$out"
check_lt "fallback command substitution does not wait for watchdog" "$elapsed" "2"
assert_no_sleep_duration "fallback command substitution leaves no watchdog sleep" "$duration"

duration="$(choose_unused_sleep_duration)"
start="$(now_seconds)"
set +e
with_forced_fallback 1 bash -c 'sleep "$1"' _ "$duration"
rc=$?
set -e
elapsed=$(( $(now_seconds) - start ))
check_eq "fallback timeout normalizes descendant command to 124" "124" "$rc"
check_ge "fallback descendant timeout waits for deadline" "$elapsed" "1"
check_lt "fallback descendant timeout does not wait for child duration" "$elapsed" "5"
assert_no_sleep_duration "fallback timeout kills descendant sleep" "$duration"

set +e
_with_timeout 5
rc=$?
set -e
check_eq "invalid invocation returns non-zero" "1" "$rc"

duration="$(choose_unused_sleep_duration)"
set +e
with_pre_change_forced_fallback 1 sleep "$duration"
rc=$?
set -e
check_eq "pre-change fallback timeout returned SIGTERM status" "143" "$rc"
assert_no_sleep_duration "pre-change timeout fixture leaves no wrapped sleep after cleanup" "$duration"

duration="$(choose_unused_sleep_duration)"
set +e
with_pre_change_forced_fallback "$duration" true
rc=$?
set -e
check_eq "pre-change fallback fast success returned 0" "0" "$rc"
kill_matching_sleep_duration "$duration"

pre_change_body="$(declare -f _with_timeout_pre_change)"
if [[ "$pre_change_body" != *'pkill -P "$wd_pid"'* && "$pre_change_body" != *'pkill -P "$watchdog_pid"'* ]]; then
  pass "pre-change fallback had no explicit watchdog child cleanup"
else
  fail "pre-change fallback unexpectedly contains watchdog child cleanup"
fi

echo ""
echo "--- _with_timeout tests: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
