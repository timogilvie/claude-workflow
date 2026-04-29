#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario post_merge_eval_queued_after_cleanup

setup_post_merge_eval_queued_after_cleanup() {
  CURRENT_PHASE="review"
  PR="888"
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

assert_post_merge_eval_queued_after_cleanup() {
  local output="$1"

  check_contains "post-merge eval queued with correct args" "$output" \
    "HOK-1294 888 task/post_merge_eval_queued_after_cleanup post_merge_eval_queued_after_cleanup HOK-1294 post-merge"
  check_contains "cleanup runs before eval" "$output" "cleanup_count=1"
  check_contains "eval-queued message appears in logs" "$output" "Eval queued in background"
  check_contains "linear marked done" "$output" "HOK-1294|Done"
}
