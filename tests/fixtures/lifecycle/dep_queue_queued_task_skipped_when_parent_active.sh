#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario dep_queue_queued_task_skipped_when_parent_active

setup_dep_queue_queued_task_skipped_when_parent_active() {
  CURRENT_PHASE="coding"

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

  launch_task() {
    printf '%s:%s\n' "$1" "${2:-}" > "$SCENARIO_DIR/unexpected-launch"
  }

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "coding" "running" "$CURRENT_AGENT"
}

assert_dep_queue_queued_task_skipped_when_parent_active() {
  local output="$1"
  local scenario_dir="$TEST_TMP/dep_queue_queued_task_skipped_when_parent_active"
  local launch_file="$scenario_dir/unexpected-launch"
  local state_file="$scenario_dir/workflow-state.json"
  local queued_len blocker_issue blocker_pr

  queued_len="$(jq -r '(.queued_tasks // []) | length' "$state_file")"
  blocker_issue="$(jq -r '.queued_tasks[0].blocker_issue_id // ""' "$state_file")"
  blocker_pr="$(jq -r 'if .queued_tasks[0].blocker_pr_number == null then "null" else (.queued_tasks[0].blocker_pr_number | tostring) end' "$state_file")"

  check_contains "queued child keeps coding phase active" "$output" "phase=coding"
  check_contains "queued child keeps task active" "$output" "active_count=1"
  check_file_absent "queued child is not launched early" "$launch_file"
  check_eq "queued child remains queued" "1" "$queued_len"
  check_eq "queued child keeps blocker issue" "HOK-1294" "$blocker_issue"
  check_eq "queued child keeps null blocker PR" "null" "$blocker_pr"
}
