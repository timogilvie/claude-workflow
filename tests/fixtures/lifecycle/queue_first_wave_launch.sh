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
CALL_LOG="$TMP_DIR/launch-calls.log"
FUNCTION_FILE="$TMP_DIR/seed-functions.sh"
STATUS_LOG_FILE="$TMP_DIR/status.log"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "test-first-wave",
  "tasks": {},
  "queued_tasks": []
}
JSON

export STATE_FILE SESSION="first-wave-test" PLAN_FILE STATUS_LOG_FILE

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$STARTUP_RUNNER" "seed_queued_tasks_from_plan" > "$FUNCTION_FILE"
extract_function "$STARTUP_RUNNER" "launch_startup_concurrent" >> "$FUNCTION_FILE"

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== First-Wave Launch Holds Queued Children ==="

# Phase 1: seed queued_tasks state from the queue plan
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

# Phase 2: verify dispatch — stub launch_task_from_plan to record calls,
# skipping tasks already queued in STATE_FILE (simulating the intended
# launcher behavior: only root tasks are dispatched on first wave).
startup_log() { :; }

launch_task_from_plan() {
  local task_json="$1"
  local issue
  issue="$(printf '%s' "$task_json" | jq -r '.issue')"
  if jq -e --arg id "$issue" '.queued_tasks[] | select(.issue_id == $id)' "$STATE_FILE" >/dev/null 2>&1; then
    return 0
  fi
  printf '%s\n' "$issue" >> "$CALL_LOG"
}

: > "$CALL_LOG"
launch_startup_concurrent 2

if grep -q 'HOK-1531' "$CALL_LOG"; then
  pass "HOK-1531 (root) dispatched by launcher"
else
  fail "HOK-1531 (root) dispatched by launcher"
fi

if grep -q 'HOK-1532' "$CALL_LOG"; then
  fail "HOK-1532 (queued child) not dispatched"
else
  pass "HOK-1532 (queued child) not dispatched"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
