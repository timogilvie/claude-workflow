#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario coding_complete_launches_review

setup_coding_complete_launches_review() {
  CURRENT_PHASE="coding"
  MONITOR_ITERATIONS=2
  write_stage_result "$FEATURE_DIR" "coding" "running" "$CURRENT_AGENT"
  touch "$FEATURE_DIR/.coding-complete"
}

assert_coding_complete_launches_review() {
  local output="$1"

  check_contains "coding complete reaches review phase" "$output" "phase=review"
  check_contains "coding complete records coding completed" "$output" "|coding|completed|"
  check_contains "coding complete starts review" "$output" "|review|running|"
  check_contains "coding complete launches review" "$output" "review_launches=1"
}
