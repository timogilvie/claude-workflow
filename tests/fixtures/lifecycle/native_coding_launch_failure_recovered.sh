#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario native_coding_launch_failure_recovered

setup_native_coding_launch_failure_recovered() {
  CURRENT_PHASE="coding"
  CURRENT_AGENT="native-openrouter"
  PANE_ALIVE="false"
  PANE_TAIL=$'Native OpenRouter coding launcher\nError: native agent native-openrouter does not support interactive phase coding\nAgent exited (127)'
  write_stage_result "$FEATURE_DIR" "coding" "running" "native-openrouter" "qwen-3-coder"
}

assert_native_coding_launch_failure_recovered() {
  local output="$1"
  local feature_dir
  feature_dir="$(printf '%s\n' "$output" | awk -F= '$1 == "feature_dir" { print $2; exit }')"

  check_contains "native coding launch failure stays in coding" "$output" "phase=coding"
  check_contains "native coding launch failure marks needs-user" "$output" "attention=needs-user"
  check_contains "native coding launch failure records failed stage" "$output" "|coding|failed|native-openrouter|qwen-3-coder|Native coding launch failed: agent-exited-127 (exit 127)"
  check_contains "native coding launch failure does not launch review" "$output" "review_launches=0"
  check_contains "native coding launch failure keeps task visible" "$output" "active_count=1"
  check_file_exists "native coding launch failure writes recovery artifact" "$feature_dir/.native-launch-failure.json"
  check_eq "native coding launch failure artifact stage" "coding" "$(jq -r '.stage' "$feature_dir/.native-launch-failure.json")"
  check_eq "native coding launch failure artifact kind" "agent-exited-127" "$(jq -r '.failureKind' "$feature_dir/.native-launch-failure.json")"
  check_eq "native coding launch failure artifact pane" "lifecycle-scenarios:HOK-1294-native_coding_launch_failure_recovered" "$(jq -r '.paneTarget' "$feature_dir/.native-launch-failure.json")"
}
