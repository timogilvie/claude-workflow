#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario persisted_merged_without_ready_cleans_up

setup_persisted_merged_without_ready_cleans_up() {
  CURRENT_PHASE="ready"
  TASK_STATUS="merged"
  PR="902"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="true"
  PANE_ALIVE="true"
}

assert_persisted_merged_without_ready_cleans_up() {
  local output="$1"
  local feature_dir ready_dir

  feature_dir="$(printf '%s\n' "$output" | awk -F= "/^feature_dir=/{print \$2}")"
  ready_dir="$feature_dir/ready"

  check_contains "persisted merged without ready clears attention" "$output" "attention=clear"
  check_contains "persisted merged without ready cleans up" "$output" "cleanup_count=1"
  check_contains "persisted merged without ready uses post-review cleanup" "$output" "cleanup_calls=HOK-1294 persisted_merged_without_ready_cleans_up post-review cleanup;"
  check_not_contains "persisted merged without ready does not stay active" "$output" "active_count=1"
  check_contains "persisted merged without ready logs bypass warning" "$output" "was merged before ready checks passed"
  check_file_exists "persisted merged without ready writes dedup sentinel" "$ready_dir/.ready-bypass-warned"
  check_file_content \
    "persisted merged without ready writes attention file" \
    "PR #902 was merged before the Release Readiness Check passed." \
    "$ready_dir/.needs-attention"
}
