#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_pr_runs_post_merge_eval_async

setup_ready_pr_runs_post_merge_eval_async() {
  CURRENT_PHASE="ready"
  PR="853"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="MERGED"
  VALIDATE_MERGED="true"
  AUTO_EVAL="true"
  EVAL_COMPLETED="false"
  REQUIRE_CONFIRM="false"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass"}}
JSON
}

assert_ready_pr_runs_post_merge_eval_async() {
  local output="$1"

  check_contains "ready merged PR launches post-merge eval" "$output" "HOK-1294 853 task/ready_pr_runs_post_merge_eval_async ready_pr_runs_post_merge_eval_async HOK-1294 post-merge"
  check_contains "ready merged PR cleanup still runs" "$output" "cleanup_count=1"
  check_contains "ready merged PR marks Linear done" "$output" "HOK-1294|Done"
  check_contains "ready merged PR clears attention" "$output" "attention=clear"
}
