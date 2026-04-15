#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario merged_pr_runs_post_merge_eval_async

setup_merged_pr_runs_post_merge_eval_async() {
  CURRENT_PHASE="review"
  PR="777"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="MERGED"
  VALIDATE_MERGED="true"
  AUTO_EVAL="true"
  EVAL_COMPLETED="false"
  REQUIRE_CONFIRM="false"
  _CFG_READY_ENABLED="false"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_merged_pr_runs_post_merge_eval_async() {
  local output="$1"

  check_contains "merged PR launches post-merge eval" "$output" "HOK-1294 777 task/merged_pr_runs_post_merge_eval_async merged_pr_runs_post_merge_eval_async HOK-1294 post-merge"
  check_contains "merged PR cleanup still runs" "$output" "cleanup_count=1"
  check_contains "merged PR marks Linear done" "$output" "HOK-1294|Done"
  check_contains "merged PR clears attention" "$output" "attention=clear"
}
