#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_stale_pass_reruns_on_conflict

setup_ready_stale_pass_reruns_on_conflict() {
  CURRENT_PHASE="ready"
  PR="999"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  PR_STATUS="OPEN"
  VALIDATE_MERGED="false"
  READY_LAUNCH_RC=0
  READY_PASS_STALE="true"

  local ready_dir
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass","baseSha":"abc123","mergeableState":"CLEAN"}}
JSON
}

assert_ready_stale_pass_reruns_on_conflict() {
  local output="$1"

  check_contains "stale ready-pass triggers re-run" "$output" "ready_launches=1"
  check_contains "stale ready logs invalidation" "$output" "prior pass invalidated"
  check_contains "stale ready stays in ready phase" "$output" "phase=ready"
  check_contains "stale ready holds slot active" "$output" "active_count=1"
}
