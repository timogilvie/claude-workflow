#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_stale_main_advances_reruns_check

setup_ready_stale_main_advances_reruns_check() {
  CURRENT_PHASE="ready"
  PR="902"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  VALIDATE_MERGED="false"
  REQUIRE_CONFIRM="false"
  READY_LAUNCH_RC=0
  MAIN_SHA_RETURN="new-main-sha"

  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"pass","readyBaseSha":"old-main-sha"}}
JSON
}

assert_ready_stale_main_advances_reruns_check() {
  local output="$1"

  check_contains "stale ready re-runs ready checks when main advances" "$output" "ready_launches=1"
  check_contains "stale ready stays in ready phase" "$output" "phase=ready"
  check_contains "stale ready clears attention on pass" "$output" "attention=clear"
  check_contains "stale ready holds slot active" "$output" "active_count=1"
}
