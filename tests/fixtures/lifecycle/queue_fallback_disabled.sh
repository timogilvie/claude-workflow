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
PLAN_NO_QUEUE="$TMP_DIR/plan-no-queue.json"
PLAN_EMPTY_QUEUE="$TMP_DIR/plan-empty-queue.json"
FUNCTION_FILE="$TMP_DIR/seed-functions.sh"

export STATE_FILE SESSION="queue-disabled-test"

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$STARTUP_RUNNER" "seed_queued_tasks_from_plan" > "$FUNCTION_FILE"

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== Queue Disabled Falls Back Cleanly ==="

# --- Scenario A: plan has no queuePlan at all ---
cat > "$STATE_FILE" <<'JSON'
{
  "session": "test-no-queue",
  "tasks": {},
  "queued_tasks": []
}
JSON

cat > "$PLAN_NO_QUEUE" <<'JSON'
{
  "session": "test-no-queue",
  "tasks": [
    {
      "issue": "HOK-3001",
      "slug": "task-alpha",
      "title": "Task Alpha",
      "branch": "task/task-alpha",
      "dependsOn": ["HOK-3002"],
      "baseFromTask": "HOK-3002"
    },
    {
      "issue": "HOK-3002",
      "slug": "task-beta",
      "title": "Task Beta",
      "branch": "task/task-beta"
    }
  ]
}
JSON

seed_queued_tasks_from_plan "$PLAN_NO_QUEUE"

queued_count="$(jq '.queued_tasks | length' "$STATE_FILE")"
if [[ "$queued_count" -eq 0 ]]; then
  pass "no queuePlan → no queued_tasks created"
else
  fail "no queuePlan → no queued_tasks created (got $queued_count)"
fi

# --- Scenario B: plan has empty queuePlan ---
cat > "$STATE_FILE" <<'JSON'
{
  "session": "test-empty-queue",
  "tasks": {},
  "queued_tasks": []
}
JSON

cat > "$PLAN_EMPTY_QUEUE" <<'JSON'
{
  "session": "test-empty-queue",
  "tasks": [
    {
      "issue": "HOK-3001",
      "slug": "task-alpha",
      "title": "Task Alpha",
      "branch": "task/task-alpha"
    }
  ],
  "queuePlan": {}
}
JSON

seed_queued_tasks_from_plan "$PLAN_EMPTY_QUEUE"

queued_count="$(jq '.queued_tasks | length' "$STATE_FILE")"
if [[ "$queued_count" -eq 0 ]]; then
  pass "empty queuePlan → no queued_tasks created"
else
  fail "empty queuePlan → no queued_tasks created (got $queued_count)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
