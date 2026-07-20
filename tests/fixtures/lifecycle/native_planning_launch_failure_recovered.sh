#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario native_planning_launch_failure_recovered

setup_native_planning_launch_failure_recovered() {
  CURRENT_PHASE="planning"
  CURRENT_AGENT="native-openrouter"
  PANE_ALIVE="false"
  PANE_TAIL=$'Native OpenRouter planning launcher\n --model qwen-3-coder\nzsh: command not found: --model\nAgent exited (127)'
  write_stage_result "$FEATURE_DIR" "planning" "running" "native-openrouter" "qwen-3-coder"
}

assert_native_planning_launch_failure_recovered() {
  local output="$1"
  local feature_dir
  feature_dir="$(printf '%s\n' "$output" | awk -F= '$1 == "feature_dir" { print $2; exit }')"

  check_contains "native planning launch failure stays in planning" "$output" "phase=planning"
  check_contains "native planning launch failure marks needs-user" "$output" "attention=needs-user"
  check_contains "native planning launch failure records failed stage" "$output" "|planning|failed|native-openrouter|qwen-3-coder|Native planning launch failed: bare-model-command (exit 127)"
  check_contains "native planning launch failure keeps task visible" "$output" "active_count=1"
  check_file_exists "native planning launch failure writes recovery artifact" "$feature_dir/.native-launch-failure.json"
  check_eq "native planning launch failure artifact stage" "planning" "$(jq -r '.stage' "$feature_dir/.native-launch-failure.json")"
  check_eq "native planning launch failure artifact model" "qwen-3-coder" "$(jq -r '.model' "$feature_dir/.native-launch-failure.json")"
  check_eq "native planning launch failure artifact exit code" "127" "$(jq -r '.exitCode' "$feature_dir/.native-launch-failure.json")"
}
