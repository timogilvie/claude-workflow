#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_conflict_attention_clean_clears_and_reruns

setup_ready_conflict_attention_clean_clears_and_reruns() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  READY_LAUNCH_RC=0
  GH_PR_VIEW_MERGEABLE="MERGEABLE"
  GH_PR_VIEW_MERGE_STATE="CLEAN"

  create_git_worktree
  write_stage_result "$FEATURE_DIR" "review" "completed" "$CURRENT_AGENT"

  local ready_dir current_head
  ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
  mkdir -p "$ready_dir"
  current_head="$(git -C "$WT_DIR" rev-parse HEAD)"
  touch "$ready_dir/.conflict-detected" "$ready_dir/.needs-attention" "$ready_dir/.conflict-attention-reported"
  printf '%s\n' "$current_head" > "$ready_dir/.conflict-attention-head"
  cat > "$ready_dir/.ready-result.json" <<JSON
{"stage":"ready","status":"completed","artifacts":{"verdict":"fail","launchHead":"stale-head"}}
JSON
}

assert_ready_conflict_attention_clean_clears_and_reruns() {
  local output="$1"
  local scenario_dir ready_dir
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_attention_clean_clears_and_reruns/features/ready_conflict_attention_clean_clears_and_reruns/ready"

  check_contains "clean recheck relaunches ready" "$output" "ready_launches=1"
  check_contains "clean recheck clears attention" "$output" "attention=clear"
  check_contains "clean recheck records gh lookup" "$output" "gh_pr_view_calls=1"
  check_file_absent "clean recheck clears conflict-detected" "$ready_dir/.conflict-detected"
  check_file_absent "clean recheck clears needs-attention" "$ready_dir/.needs-attention"
  check_file_absent "clean recheck clears attention head" "$ready_dir/.conflict-attention-head"
  check_file_absent "clean recheck clears attention reported" "$ready_dir/.conflict-attention-reported"
  check_file_absent "clean recheck clears recheck timestamp" "$ready_dir/.conflict-recheck-at"
}
