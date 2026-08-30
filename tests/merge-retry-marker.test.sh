#!/usr/bin/env bash
# Regression coverage for HOK-2411: the merge-queue tick must read the
# cross-process transient merge-retry marker written by the tend process so an
# actively-retrying merge candidate is not demoted as "stuck" and re-promoted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_SCRIPT_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"

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

extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Source the function under test in isolation.
FUNC_FILE="$TEST_TMP/merge_retry_marker_until.sh"
extract_function "$MONITOR_SCRIPT_FILE" "merge_retry_marker_until" > "$FUNC_FILE"
# shellcheck disable=SC1090
REPO_DIR="$TEST_TMP/repo"
mkdir -p "$REPO_DIR/.wavemill/merge-retry"
source "$FUNC_FILE"

echo "=== HOK-2411: merge_retry_marker_until ==="

# Active marker: returns the ISO expiry so isCandidateStuck can protect the retry.
printf '{"prNumber":924,"until":"2026-07-01T12:35:00.000Z"}\n' \
  > "$REPO_DIR/.wavemill/merge-retry/924.json"
check_equals "active marker returns until timestamp" \
  "2026-07-01T12:35:00.000Z" "$(merge_retry_marker_until 924)"

# No marker file: returns empty (candidate follows normal stuck detection).
check_equals "absent marker returns empty" "" "$(merge_retry_marker_until 999)"

# Empty PR number: returns empty without touching the filesystem.
check_equals "empty pr number returns empty" "" "$(merge_retry_marker_until "")"

# Malformed marker JSON: degrades to empty instead of erroring.
printf 'not-json' > "$REPO_DIR/.wavemill/merge-retry/500.json"
check_equals "malformed marker returns empty" "" "$(merge_retry_marker_until 500)"

# Marker without an 'until' field: returns empty.
printf '{"prNumber":501}\n' > "$REPO_DIR/.wavemill/merge-retry/501.json"
check_equals "marker missing until returns empty" "" "$(merge_retry_marker_until 501)"

# The tick must source the marker (not the always-null ready artifact field).
echo "=== HOK-2411: tick wires marker into mergeRetryInProgressUntil ==="
if grep -q 'merge_retry_in_progress_until "\$(merge_retry_marker_until "\$pr")"' "$MONITOR_SCRIPT_FILE"; then
  pass "refresh_ready_merge_queue_tick reads merge_retry_marker_until"
else
  fail "refresh_ready_merge_queue_tick reads merge_retry_marker_until"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
