#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
QUEUE_HEALTH_LIB="$REPO_DIR/shared/lib/queue-health.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Queue Health UTC Backoff ==="
echo "Note: the past-UTC regression detects the original macOS bug only outside UTC."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
STATE_DIR="$TMP_DIR/.wavemill"
export STATE_DIR
mkdir -p "$STATE_DIR"

# shellcheck source=/dev/null
source "$COMMON_LIB"
# shellcheck source=/dev/null
source "$QUEUE_HEALTH_LIB"

format_utc_epoch() {
  local epoch="$1"
  date -u -r "$epoch" +'%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || \
    date -u -d "@$epoch" +'%Y-%m-%dT%H:%M:%SZ'
}

write_health() {
  local next_retry_at="${1-}"
  if [[ -n "$next_retry_at" ]]; then
    jq -n --arg nextRetryAt "$next_retry_at" \
      '{status: "degraded", retryBackoffSeconds: 0, nextRetryAt: $nextRetryAt}' \
      > "$STATE_DIR/queue-health.json"
  else
    printf '{}\n' > "$STATE_DIR/queue-health.json"
  fi
}

assert_skip() {
  local name="$1"
  if queue_health_should_skip_attempt; then
    pass "$name"
  else
    fail "$name"
  fi
}

assert_no_skip() {
  local name="$1"
  if queue_health_should_skip_attempt; then
    fail "$name"
  else
    pass "$name"
  fi
}

now_epoch="$(date +%s)"
past_retry_at="$(format_utc_epoch "$((now_epoch - 5))")"
future_retry_at="$(format_utc_epoch "$((now_epoch + 3600))")"
fractional_past_retry_at="${past_retry_at%Z}.123Z"

write_health "$past_retry_at"
assert_no_skip "past UTC nextRetryAt does not skip"

write_health "$future_retry_at"
assert_skip "future UTC nextRetryAt skips"

write_health "$fractional_past_retry_at"
assert_no_skip "past UTC nextRetryAt with fractional seconds does not skip"

write_health ""
assert_no_skip "missing nextRetryAt does not skip"

write_health "garbage"
assert_no_skip "unparseable nextRetryAt does not skip"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
