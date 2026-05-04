#!/usr/bin/env bash
# Test: Queue plan metadata emission in launch plans (HOK-1532)
# Auto-discovered by check-shell.sh TEST 2C

set -Eeuo pipefail

test_launch_plan_no_queue() {
  local fixture="tests/fixtures/startup/launch-plan-no-queue.json"
  [[ -f "$fixture" ]] || { echo "FAIL: fixture not found: $fixture" >&2; return 1; }

  # Verify no new fields present when queue plan is disabled
  jq -e '.queuePlan' "$fixture" >/dev/null 2>&1 && {
    echo "FAIL: queuePlan field should not be present in no-queue fixture"
    return 1
  }

  # Verify first task has no queue metadata
  jq -e '.tasks[0].dependsOn' "$fixture" >/dev/null 2>&1 && {
    echo "FAIL: dependsOn field should not be present in no-queue fixture"
    return 1
  }

  jq -e '.tasks[0].baseFromTask' "$fixture" >/dev/null 2>&1 && {
    echo "FAIL: baseFromTask field should not be present in no-queue fixture"
    return 1
  }

  echo "PASS: launch plan without queue has no queue fields"
}

test_launch_plan_with_queue() {
  local fixture="tests/fixtures/startup/launch-plan-with-queue.json"
  [[ -f "$fixture" ]] || { echo "FAIL: fixture not found: $fixture" >&2; return 1; }

  # Verify queuePlan is present
  jq -e '.queuePlan' "$fixture" >/dev/null 2>&1 || {
    echo "FAIL: queuePlan field should be present in with-queue fixture"
    return 1
  }

  # Verify queuePlan structure
  jq -e '.queuePlan | has("availableNow") and has("queuedAfterDependencies")' "$fixture" >/dev/null 2>&1 || {
    echo "FAIL: queuePlan should have availableNow and queuedAfterDependencies"
    return 1
  }

  # Verify task A (no dependencies) has no queue fields (backward compatible when no deps)
  jq -e '.tasks[0].dependsOn' "$fixture" >/dev/null 2>&1 && {
    echo "FAIL: task A should not have dependsOn field when no dependencies"
    return 1
  }

  jq -e '.tasks[0].baseFromTask' "$fixture" >/dev/null 2>&1 && {
    echo "FAIL: task A should not have baseFromTask field when no dependencies"
    return 1
  }

  # Verify task B (depends on A) has correct dependsOn and baseFromTask
  local task_b_depends
  task_b_depends=$(jq -c '.tasks[1].dependsOn // "MISSING"' "$fixture")
  [[ "$task_b_depends" == '["HOK-1531"]' ]] || {
    echo "FAIL: task B dependsOn should be [\"HOK-1531\"], got: $task_b_depends"
    return 1
  }

  local task_b_base
  task_b_base=$(jq -r '.tasks[1].baseFromTask // "MISSING"' "$fixture")
  [[ "$task_b_base" == "HOK-1531" ]] || {
    echo "FAIL: task B baseFromTask should be HOK-1531, got: $task_b_base"
    return 1
  }

  echo "PASS: launch plan with queue has correct queue metadata"
}

main() {
  test_launch_plan_no_queue || return 1
  test_launch_plan_with_queue || return 1
  echo ""
  echo "✓ All queue plan metadata tests passed"
}

main "$@"
