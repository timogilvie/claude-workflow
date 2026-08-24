#!/usr/bin/env bash
# Regression coverage for HOK-2785: queue planner retry timestamps are UTC.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Keep the regression visible on machines whose default timezone is UTC.
export TZ='America/New_York'

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_ROOT/shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/queue-health.sh
source "$REPO_ROOT/shared/lib/queue-health.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_equals() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    echo "    expected: [$expected]"
    echo "    actual:   [$actual]"
    fail "$name"
  fi
}

check_skip_result() {
  local name="$1" expected="$2" actual
  if queue_health_should_skip_attempt; then
    actual="skip"
  else
    actual="proceed"
  fi
  check_equals "$name" "$expected" "$actual"
}

iso_from_epoch() {
  local epoch="$1"
  date -u -r "$epoch" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
    date -u -d "@$epoch" '+%Y-%m-%dT%H:%M:%SZ'
}

write_health() {
  local next_retry_at="$1"
  printf '{"nextRetryAt":%s}\n' "$next_retry_at" > "$STATE_DIR/queue-health.json"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT
STATE_DIR="$TEST_TMP"
export STATE_DIR

echo "=== HOK-2785: queue health retry UTC parsing ==="

now_epoch="$(date +%s)"
past_retry_at="$(iso_from_epoch "$((now_epoch - 5))")"
future_retry_at="$(iso_from_epoch "$((now_epoch + 3600))")"
future_retry_at_fractional="${future_retry_at%Z}.123Z"

write_health "\"$past_retry_at\""
check_skip_result "past UTC nextRetryAt does not skip" "proceed"

write_health "\"$future_retry_at\""
check_skip_result "future UTC nextRetryAt skips" "skip"

printf '{}\n' > "$STATE_DIR/queue-health.json"
check_skip_result "missing nextRetryAt does not skip" "proceed"

write_health '"not-a-date"'
check_skip_result "malformed nextRetryAt does not skip" "proceed"

write_health "\"$future_retry_at_fractional\""
check_skip_result "fractional future nextRetryAt skips" "skip"

check_equals "UTC Z timestamp parses independent of local TZ" \
  "1787231067" "$(wavemill_iso8601_to_epoch '2026-08-20T13:04:27Z')"

printf '{}\n' > "$STATE_DIR/queue-health.json"
queue_health_record_failure "timeout" "plan_queue_failed" \
  "123" "123" "60" "143" "" "queue_plan_timeout" \
  "" "planner timeout" '{"taskCount":2,"explicitDependencyCount":1}' || fail "record failure before success"
queue_health_record_success "124" "124" "250" "planner command" || fail "record success after failure"

check_equals "success clears active status" "healthy" "$(jq -r '.status' "$STATE_DIR/queue-health.json")"
check_equals "success clears active failure count" "0" "$(jq -r '.failureCount' "$STATE_DIR/queue-health.json")"
check_equals "success preserves cumulative failures" "1" "$(jq -r '.totalFailureCount' "$STATE_DIR/queue-health.json")"
check_equals "success preserves last failure reason" "timeout" "$(jq -r '.lastFailureEvidence.degradationReason' "$STATE_DIR/queue-health.json")"
check_equals "success preserves last failure owner" "queue_plan_timeout" "$(jq -r '.lastFailureEvidence.planner.cancellationOwner' "$STATE_DIR/queue-health.json")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
