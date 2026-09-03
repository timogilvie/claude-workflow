#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario review_pr_detected_marks_ready

setup_review_pr_detected_marks_ready() {
  CURRENT_PHASE="review"
  PR="321"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  write_stage_result "$FEATURE_DIR" "review" "running" "$CURRENT_AGENT" "" "" \
    '{"type":"review","prNumber":321,"exitCode":0,"verdict":"ready","iterations":1,"blockerCount":0}'
}

assert_review_pr_detected_marks_ready() {
  local output="$1"

  check_contains "open PR moves review to ready" "$output" "phase=ready"
  check_contains "open PR completes review" "$output" "|review|completed|"
  check_contains "open PR launches ready" "$output" "ready_launches=1"
  check_contains "open PR records PR number" "$output" "PR #321"
}
