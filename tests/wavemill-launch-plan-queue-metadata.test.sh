#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LEGACY="$REPO_DIR/tests/fixtures/startup/launch-plan-legacy.json"
QUEUE="$REPO_DIR/tests/fixtures/startup/launch-plan-with-queue.json"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

expect_true() {
  local name="$1" expr="$2" file="$3"
  if jq -e "$expr" "$file" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Launch Plan Queue Metadata Compatibility ==="

# 1. Legacy fixture shape
expect_true "legacy has no queuePlan key" 'has("queuePlan") | not' "$LEGACY"
expect_true "legacy tasks have no dependsOn key" '[.tasks[] | has("dependsOn")] | any | not' "$LEGACY"
expect_true "legacy tasks have no baseFromTask key" '[.tasks[] | has("baseFromTask")] | any | not' "$LEGACY"

# 2. Queue fixture shape
expect_true "queuePlan contains two waves" '.queuePlan | length == 2' "$QUEUE"
expect_true "wave 1 contains HOK-1" '.queuePlan[0] == {"wave":1,"taskIds":["HOK-1"]}' "$QUEUE"
expect_true "wave 2 contains HOK-2" '.queuePlan[1] == {"wave":2,"taskIds":["HOK-2"]}' "$QUEUE"
expect_true "HOK-2 dependsOn is HOK-1" '(.tasks[] | select(.issue=="HOK-2") | .dependsOn) == ["HOK-1"]' "$QUEUE"
expect_true "HOK-2 baseFromTask is HOK-1" '(.tasks[] | select(.issue=="HOK-2") | .baseFromTask) == "HOK-1"' "$QUEUE"
expect_true "HOK-1 has no dependency metadata" '(.tasks[] | select(.issue=="HOK-1") | has("dependsOn") or has("baseFromTask")) | not' "$QUEUE"

# 3. Runner tolerance - legacy fixture
expect_true "legacy queuePlan read defaults to []" '(.queuePlan // []) == []' "$LEGACY"
expect_true "legacy task dependsOn read defaults to []" '[.tasks[] | (.dependsOn // []) == []] | all' "$LEGACY"
expect_true "legacy task baseFromTask read defaults to empty" '[.tasks[] | (.baseFromTask // empty) | (type == "string")] | all' "$LEGACY"

# 4. Runner tolerance - queue fixture
expect_true "queue fixture queuePlan read succeeds" '(.queuePlan // []) | length == 2' "$QUEUE"
expect_true "queue fixture dependsOn read succeeds" '[(.tasks[] | select(.issue=="HOK-2") | (.dependsOn // [])) == ["HOK-1"]] | all' "$QUEUE"
expect_true "queue fixture baseFromTask read succeeds" '[(.tasks[] | select(.issue=="HOK-2") | (.baseFromTask // empty)) == "HOK-1"] | all' "$QUEUE"

# 5. Launch sequence unchanged
legacy_order="$(jq -c '[.tasks[].issue]' "$LEGACY")"
queue_order="$(jq -c '[.tasks[].issue]' "$QUEUE")"
if [[ "$legacy_order" == "$queue_order" ]]; then
  pass "task order unchanged across legacy and queue fixtures"
else
  fail "task order unchanged across legacy and queue fixtures"
fi

# 6. Mill jq logic - no queue plan
no_queue_task_json="$(jq -cn \
  --arg issue "HOK-2" \
  --arg slug "task-b" \
  --arg title "Task B" \
  --arg branch "task/task-b" \
  --arg worktreeDir "/tmp/task-b" \
  --arg linearIssueId "HOK-2" \
  --arg taskPacketFile "/tmp/taskpacket.md" \
  --arg taskPacketDetailsFile "/tmp/taskpacket-details.md" \
  --arg issueJsonFile "/tmp/issue.json" \
  --arg routeFile "/tmp/route.json" \
  --argjson route '{}' \
  --arg challenge "false" \
  --arg challengePairId "" \
  --arg challengeRole "" \
  --arg challengeModel "" \
  --arg migrationNumber "" \
  --arg agent "codex" \
  --argjson dependsOn '[]' \
  --arg baseFromTask "" \
  '{
    issue: $issue,
    slug: $slug,
    title: $title,
    branch: $branch,
    worktreeDir: $worktreeDir,
    linearIssueId: $linearIssueId,
    taskPacketFile: $taskPacketFile,
    taskPacketDetailsFile: $taskPacketDetailsFile,
    issueJsonFile: $issueJsonFile,
    routeFile: $routeFile,
    route: $route,
    challenge: ($challenge == "true"),
    challengePairId: (if $challengePairId == "" then null else $challengePairId end),
    challengeRole: (if $challengeRole == "" then null else $challengeRole end),
    challengeModel: (if $challengeModel == "" then null else $challengeModel end),
    migrationNumber: (if $migrationNumber == "" then null else ($migrationNumber | tonumber) end),
    agent: $agent
  } + (if ($dependsOn | length) > 0 then {dependsOn: $dependsOn} else {} end)
    + (if $baseFromTask != "" then {baseFromTask: $baseFromTask} else {} end)')"

if jq -e '(has("dependsOn") | not) and (has("baseFromTask") | not)' <<<"$no_queue_task_json" >/dev/null; then
  pass "mill jq emits no per-task queue metadata when queue plan unavailable"
else
  fail "mill jq emits no per-task queue metadata when queue plan unavailable"
fi

# 7. Mill jq logic - with queue plan
queue_plan_json='{"availableNow":["HOK-1"],"queuedAfterDependencies":[{"taskId":"HOK-2","ancestors":["HOK-1"]}]}'
computed_depends_on="$(printf '%s' "$queue_plan_json" | jq -c --arg id "HOK-2" '[ .queuedAfterDependencies[]? | select(.taskId == $id) | .ancestors[] ] // []')"
computed_base_from="$(printf '%s' "$queue_plan_json" | jq -r --arg id "HOK-2" '[ .queuedAfterDependencies[]? | select(.taskId == $id) | .ancestors[0] ] | first // empty')"

with_queue_task_json="$(jq -cn \
  --arg issue "HOK-2" \
  --argjson dependsOn "$computed_depends_on" \
  --arg baseFromTask "$computed_base_from" \
  '{issue:$issue}
  + (if ($dependsOn | length) > 0 then {dependsOn: $dependsOn} else {} end)
  + (if $baseFromTask != "" then {baseFromTask: $baseFromTask} else {} end)')"

if jq -e '.dependsOn == ["HOK-1"] and .baseFromTask == "HOK-1"' <<<"$with_queue_task_json" >/dev/null; then
  pass "mill jq emits dependsOn and baseFromTask when queue plan exists"
else
  fail "mill jq emits dependsOn and baseFromTask when queue plan exists"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
