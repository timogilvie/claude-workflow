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
  MONITOR_ITERATIONS=2
}

assert_merged_without_ready_dedup() {
  local output="$1"
  local scenario_dir feature_dir ready_dir

  scenario_dir="$(printf '%s\n' "$output" | awk -F= "/^scenario_dir=/{print \$2}")"
  feature_dir="$(printf '%s\n' "$output" | awk -F= "/^feature_dir=/{print \$2}")"
  ready_dir="$feature_dir/ready"

  check_contains "merged without ready keeps phase active" "$output" "phase=ready"
  check_contains "merged without ready keeps attention on task" "$output" "attention=needs-user"
  check_contains "merged without ready does not clean up" "$output" "cleanup_count=0"
  check_contains "merged without ready saves merged status" "$output" "merged"
  check_contains "merged without ready logs bypass warning" "$output" "was merged before ready checks passed"
  check_not_contains "merged without ready does not log merged success" "$output" "✓ HOK-1294 → PR #901 MERGED"
  check_file_exists "merged without ready writes dedup sentinel" "$ready_dir/.ready-bypass-warned"
  check_file_content \
    "merged without ready writes attention file" \
    "PR #901 was merged before the Release Readiness Check passed." \
    "$ready_dir/.needs-attention"

  local warn_count
  warn_count="$(printf '%s\n' "$output" | grep -o "was merged before ready checks passed" | wc -l | tr -d " ")"
  check_eq "merged without ready logs warning once across polls" "1" "$warn_count"
}
