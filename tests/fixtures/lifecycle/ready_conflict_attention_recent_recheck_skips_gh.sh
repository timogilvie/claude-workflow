#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_conflict_attention_recent_recheck_skips_gh

setup_ready_conflict_attention_recent_recheck_skips_gh() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  WAVEMILL_READY_CONFLICT_RECHECK_SECONDS=60

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"

  local ready_dir current_head
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  current_head="$(git -C "$WT_DIR" rev-parse HEAD)"
  touch "$ready_dir/.conflict-detected" "$ready_dir/.needs-attention" "$ready_dir/.conflict-attention-reported"
  printf '%s\n' "$current_head" > "$ready_dir/.conflict-attention-head"
  printf '%s\n' "$(date +%s)" > "$ready_dir/.conflict-recheck-at"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"fail","launchHead":"stale-head"}}
JSON
}

assert_ready_conflict_attention_recent_recheck_skips_gh() {
  local output="$1"
  local scenario_dir ready_dir
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_attention_recent_recheck_skips_gh/features/ready_conflict_attention_recent_recheck_skips_gh/ready"

  check_contains "recent recheck skips ready relaunch" "$output" "ready_launches=0"
  check_contains "recent recheck keeps attention" "$output" "attention=needs-user"
  check_contains "recent recheck skips gh call" "$output" "gh_pr_view_calls=0"
  check_file_exists "recent recheck keeps conflict-detected" "$ready_dir/.conflict-detected"
  check_file_exists "recent recheck keeps needs-attention" "$ready_dir/.needs-attention"
  check_file_exists "recent recheck keeps attention head" "$ready_dir/.conflict-attention-head"
  check_file_exists "recent recheck keeps attention reported" "$ready_dir/.conflict-attention-reported"
  check_file_exists "recent recheck keeps recheck timestamp" "$ready_dir/.conflict-recheck-at"
}
