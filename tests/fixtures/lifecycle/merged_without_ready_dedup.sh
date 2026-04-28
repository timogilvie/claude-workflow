#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario merged_without_ready_dedup

setup_merged_without_ready_dedup() {
  CURRENT_PHASE="ready"
  PR="901"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="MERGED"
  VALIDATE_MERGED="true"
  REQUIRE_CONFIRM="true"
  AUTO_EVAL="true"
  EVAL_COMPLETED="false"
  LINEAR_UPDATES="true"
  MONITOR_ITERATIONS=1
}

assert_merged_without_ready_dedup() {
  local output="$1"
  local scenario_dir feature_dir ready_dir

  scenario_dir="$(printf '%s\n' "$output" | awk -F= "/^scenario_dir=/{print \$2}")"
  feature_dir="$(printf '%s\n' "$output" | awk -F= "/^feature_dir=/{print \$2}")"
  ready_dir="$feature_dir/ready"

  check_contains "merged without ready keeps ready phase until cleanup" "$output" "phase=ready"
  check_contains "merged without ready clears attention before cleanup" "$output" "attention=clear"
  check_contains "merged without ready cleans up immediately" "$output" "cleanup_count=1"
  check_contains "merged without ready runs post-merge eval" "$output" "HOK-1294 901 task/merged_without_ready_dedup merged_without_ready_dedup HOK-1294 post-merge"
  check_contains "merged without ready marks Linear done" "$output" "HOK-1294|Done"
  check_contains "merged without ready logs bypass warning" "$output" "was merged before ready checks passed"
  check_contains "merged without ready logs merged success" "$output" "✓ HOK-1294 → PR #901 MERGED"
  check_not_contains "merged without ready does not hold window for review" "$output" "Window stays open for review"
  check_file_exists "merged without ready writes dedup sentinel" "$ready_dir/.ready-bypass-warned"
  check_file_content \
    "merged without ready writes attention file" \
    "PR #901 was merged before the Release Readiness Check passed." \
    "$ready_dir/.needs-attention"

  local warn_count
  warn_count="$(printf '%s\n' "$output" | grep -o "was merged before ready checks passed" | wc -l | tr -d " ")"
  check_eq "merged without ready logs warning once" "1" "$warn_count"
}
