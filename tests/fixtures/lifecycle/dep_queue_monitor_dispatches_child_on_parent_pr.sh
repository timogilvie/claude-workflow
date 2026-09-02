#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario dep_queue_monitor_dispatches_child_on_parent_pr

setup_dep_queue_monitor_dispatches_child_on_parent_pr() {
  CURRENT_PHASE="review"
  PR="9001"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  cat > "$FEATURE_DIR/.review-result.json" <<'JSON'
{"stage":"review","status":"completed","artifacts":{"type":"review","prNumber":9001,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}}
JSON

  cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-1294": {
      "title": "Parent task"
    }
  },
  "queued_tasks": [
    {
      "issue_id": "HOK-9001",
      "blocker_issue_id": "HOK-1294",
      "blocker_pr_number": null,
      "desired_base_branch": "HOK-1294",
      "linear_issue_url": "https://linear.app/issue/HOK-9001",
      "slug": "hok-9001-child",
      "title": "Child task"
    }
  ]
}
JSON

  dispatch_queued_children_for_parent() {
    printf '%s:%s\n' "$1" "$2" > "$SCENARIO_DIR/dispatched"
  }
}

assert_dep_queue_monitor_dispatches_child_on_parent_pr() {
  local output="$1"
  local dispatched_file="$TEST_TMP/dep_queue_monitor_dispatches_child_on_parent_pr/dispatched"

  check_contains "parent PR advances to ready" "$output" "phase=ready"
  check_contains "parent PR completes review" "$output" "|review|completed|"
  check_contains "parent PR launches ready" "$output" "ready_launches=1"
  check_file_exists "parent PR dispatch marker written" "$dispatched_file"
  check_file_content "parent PR dispatch payload" "HOK-1294:9001" "$dispatched_file"
}
