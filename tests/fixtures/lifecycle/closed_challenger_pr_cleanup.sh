#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario closed_challenger_pr_cleanup

setup_closed_challenger_pr_cleanup() {
  CURRENT_PHASE="review"
  PR="654"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_SIBLING_PR="655"
  CHALLENGE_SIBLING_STATE="OPEN"
  CLEANUP_CLOSED_PR="true"
  LINEAR_UPDATES="true"
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_challenger_pr_cleanup() {
  local output="$1"

  check_contains "closed challenger is cleaned up" "$output" "cleanup_count=1"
  check_contains "closed challenger cleanup reason captured" "$output" "closed without merge"
  check_not_contains "active sibling prevents Linear Done" "$output" "|Done"
  check_not_contains "active sibling prevents Backlog reset" "$output" "|Backlog"
  check_not_contains "sibling task is not cleaned up" "$output" "655"
}

register_lifecycle_scenario closed_challenge_pair_backlog_dedup

setup_closed_challenge_pair_backlog_dedup() {
  CURRENT_PHASE="review"
  PR="664"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="CLOSED"
  CHALLENGE_TASK="true"
  CHALLENGE_SIBLING_PR="665"
  CHALLENGE_SIBLING_STATE="CLOSED"
  CLEANUP_CLOSED_PR="false"
  LINEAR_UPDATES="true"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
}

assert_closed_challenge_pair_backlog_dedup() {
  local output="$1"
  local linear_calls

  check_not_contains "closed pair is not cleaned without cleanup policy" "$output" "cleanup_count=1"
  check_contains "closed pair logs backlog outcome" "$output" "returning Linear to Backlog"
  linear_calls="$(printf '%s\n' "$output" | awk -F= '/^linear_calls=/{print $2}')"
  check_eq "closed pair applies Backlog once" "HOK-1294|Backlog;" "$linear_calls"
}
