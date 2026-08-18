#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL="$REPO_DIR/shared/lib/wavemill-mill.sh"

extract_function() {
  local file="$1" name="$2"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1; depth=0 }
    capture {
      print
      opens=gsub(/\{/, "{")
      closes=gsub(/\}/, "}")
      depth += opens - closes
      if (capture && depth == 0) exit
    }
  ' "$file"
}

source "$COMMON"
eval "$(extract_function "$MILL" read_backstage_health_field)"
eval "$(extract_function "$MILL" read_backstage_service_health_field)"
eval "$(extract_function "$MILL" check_backstage_health)"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-watchdog-backoff.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

STATE_DIR="$tmp/state"
REPO_DIR="$tmp/repo"
SESSION="test"
TOOLS_DIR="$tmp/tools"
WAVEMILL_WINDOW_BACKSTAGE="backstage"
WAVEMILL_BACKSTAGE_TEND_PANE_TITLE="Wavemill Tend Loop"
WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE="Wavemill Jobs"
BACKSTAGE_HEALTH_INTERVAL=0
BACKSTAGE_RESTART_COOLDOWN=60
BACKSTAGE_RESTART_BACKOFF_MAX=900
BACKSTAGE_RESTART_NEEDS_USER_AFTER=3
BACKSTAGE_TEND_RESTART_CONFIRM_SECONDS=30
LAST_BACKSTAGE_HEALTH_CHECK=0
LAST_BACKSTAGE_HEALTH_STATUS=""
mkdir -p "$STATE_DIR" "$REPO_DIR/.wavemill/logs" "$TOOLS_DIR"

assert_eq() {
  local expected="$1" actual="$2" message="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $message: expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" message="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $message: expected '$haystack' to contain '$needle'" >&2
    exit 1
  fi
}

assert_eq 0 "$(wavemill_backstage_restart_backoff_seconds 0 60 900)" "attempt 0 backoff"
assert_eq 60 "$(wavemill_backstage_restart_backoff_seconds 1 60 900)" "attempt 1 backoff"
assert_eq 120 "$(wavemill_backstage_restart_backoff_seconds 2 60 900)" "attempt 2 backoff"
assert_eq 240 "$(wavemill_backstage_restart_backoff_seconds 3 60 900)" "attempt 3 backoff"
assert_eq 480 "$(wavemill_backstage_restart_backoff_seconds 4 60 900)" "attempt 4 backoff"
assert_eq 900 "$(wavemill_backstage_restart_backoff_seconds 5 60 900)" "attempt 5 backoff"
assert_eq 0 "$(wavemill_backstage_restart_backoff_seconds nope 60 900)" "non-numeric backoff"

backstage_health_enabled() { return 0; }
probe_backstage_panes() { printf '%%1\t%s\t0\tbash\tbash\n' "$WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE"; }
classify_backstage_health() {
  printf 'missing-tend-loop\tbackstage window is missing the %s executor pane while status panes remain\t1\t\n' "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE"
}
restart_backstage_tend_loop() {
  local count
  count="$(cat "$tmp/restarts" 2>/dev/null || echo 0)"
  count=$(( count + 1 ))
  printf '%s\n' "$count" > "$tmp/restarts"
  printf '%%9\n'
}
backstage_tend_restart_confirmed() { return 1; }
backstage_tend_pane_alive() { return 1; }
backstage_tend_restart_diagnostic() { printf 'HTTP 503 api.github.com/graphql\n'; }
log_warn() { printf '%s\n' "$*" >> "$tmp/warn.log"; }
log() { :; }

check_backstage_health
assert_eq 1 "$(cat "$tmp/restarts")" "first restart"
assert_eq missing-tend-loop "$(read_backstage_health_field '.status')" "first status"
assert_eq 1 "$(read_backstage_health_field '.restartAttemptCount')" "first attempt count"
assert_contains "$(read_backstage_health_field '.detail')" "Automatic retry" "first retry detail"

check_backstage_health
assert_eq 1 "$(cat "$tmp/restarts")" "within backoff does not restart"

BACKSTAGE_RESTART_COOLDOWN=0
check_backstage_health
assert_eq 2 "$(cat "$tmp/restarts")" "second restart after backoff"
assert_eq 2 "$(read_backstage_health_field '.restartAttemptCount')" "second attempt count"

check_backstage_health
assert_eq 3 "$(cat "$tmp/restarts")" "third restart after backoff"
assert_eq needs-user "$(read_backstage_health_field '.status')" "needs-user escalation"
assert_contains "$(read_backstage_health_field '.detail')" "keeps retrying automatically" "needs-user retry detail"

check_backstage_health
assert_eq 4 "$(cat "$tmp/restarts")" "persistent retry after needs-user"

echo "backstage watchdog backoff tests passed"
