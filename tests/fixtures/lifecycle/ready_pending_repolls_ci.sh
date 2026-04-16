#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_pending_repolls_ci

setup_ready_pending_repolls_ci() {
  CURRENT_PHASE="ready"
  PR="857"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  VALIDATE_MERGED="false"
  REQUIRE_CONFIRM="false"
  READY_LAUNCH_RC=4
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"
  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"running","artifacts":{"verdict":"pending"}}
JSON
}

assert_ready_pending_repolls_ci() {
  local output="$1"

  check_contains "pending ready re-polls CI" "$output" "ready_launches=1"
  check_contains "pending ready stays in ready phase" "$output" "phase=ready"
  check_contains "pending ready does not flag user" "$output" "attention=clear"
  check_contains "pending ready holds slot active" "$output" "active_count=1"
}
