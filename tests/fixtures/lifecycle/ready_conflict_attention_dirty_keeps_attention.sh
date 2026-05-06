#!/usr/bin/env bash
# shellcheck shell=bash disable=SC2034,SC2153,SC2154

register_lifecycle_scenario ready_conflict_attention_dirty_keeps_attention

setup_ready_conflict_attention_dirty_keeps_attention() {
  CURRENT_PHASE="ready"
  PR="528"
  PR_BY_ISSUE["$ISSUE"]="$PR"
  REQUIRE_CONFIRM="false"
  GH_PR_VIEW_MERGEABLE="CONFLICTING"
  GH_PR_VIEW_MERGE_STATE="DIRTY"

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

assert_ready_conflict_attention_dirty_keeps_attention() {
  local output="$1"
  local scenario_dir ready_dir recheck_value
  scenario_dir="$(printf '%s\n' "$output" | awk -F= '$1=="scenario_dir"{print $2}')"
  ready_dir="$scenario_dir/worktrees/ready_conflict_attention_dirty_keeps_attention/features/ready_conflict_attention_dirty_keeps_attention/ready"

  check_contains "dirty recheck does not relaunch ready" "$output" "ready_launches=0"
  check_contains "dirty recheck keeps attention" "$output" "attention=needs-user"
  check_contains "dirty recheck records gh lookup" "$output" "gh_pr_view_calls=1"
  check_file_exists "dirty recheck keeps conflict-detected" "$ready_dir/.conflict-detected"
  check_file_exists "dirty recheck keeps needs-attention" "$ready_dir/.needs-attention"
  check_file_exists "dirty recheck keeps attention head" "$ready_dir/.conflict-attention-head"
  check_file_exists "dirty recheck keeps attention reported" "$ready_dir/.conflict-attention-reported"
  check_file_exists "dirty recheck writes recheck timestamp" "$ready_dir/.conflict-recheck-at"
  recheck_value="$(<"$ready_dir/.conflict-recheck-at")"
  if [[ "$recheck_value" =~ ^[0-9]+$ ]]; then
    pass "dirty recheck timestamp is numeric"
  else
    echo "    invalid timestamp: $recheck_value"
    fail "dirty recheck timestamp is numeric"
  fi
}
