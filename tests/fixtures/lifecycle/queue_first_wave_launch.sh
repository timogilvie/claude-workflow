#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STARTUP_RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_FILE="$TMP_DIR/state.json"
PLAN_FILE="$REPO_DIR/tests/fixtures/startup/launch-plan-with-queue.json"
FUNCTION_FILE="$TMP_DIR/seed-functions.sh"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "test-first-wave",
  "tasks": {},
  "queued_tasks": []
}
JSON

export STATE_FILE SESSION="first-wave-test"

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$STARTUP_RUNNER" "seed_queued_tasks_from_plan" > "$FUNCTION_FILE"

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== First-Wave Launch Holds Queued Children ==="

seed_queued_tasks_from_plan "$PLAN_FILE"

available_now="$(jq -r '.queuePlan.availableNow[]' "$PLAN_FILE")"
if echo "$available_now" | grep -q 'HOK-1531'; then
  pass "HOK-1531 is in availableNow"
else
  fail "HOK-1531 is in availableNow"
fi

queued_count="$(jq '.queued_tasks | length' "$STATE_FILE")"
if [[ "$queued_count" -ge 1 ]]; then
  pass "queued_tasks populated after seeding"
else
  fail "queued_tasks populated after seeding (got $queued_count)"
fi

if jq -e '.queued_tasks[] | select(.issue_id == "HOK-1532")' "$STATE_FILE" >/dev/null 2>&1; then
  pass "HOK-1532 is in queued_tasks"
else
  fail "HOK-1532 is in queued_tasks"
fi

if jq -e '.queued_tasks[] | select(.issue_id == "HOK-1532") | .blocker_issue_id == "HOK-1531"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "HOK-1532 blocked by HOK-1531"
else
  fail "HOK-1532 blocked by HOK-1531"
fi

if jq -e '.queued_tasks[] | select(.issue_id == "HOK-1531")' "$STATE_FILE" >/dev/null 2>&1; then
  fail "HOK-1531 should NOT be in queued_tasks (it is a root)"
else
  pass "HOK-1531 is not in queued_tasks (root tasks are not queued)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
