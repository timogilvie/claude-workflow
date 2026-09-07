#!/usr/bin/env bash
# Safety control: a merged task whose worktree has uncommitted (or merely
# untracked) changes must never be deleted. Drives the same
# monitor_issue_state -> cleanup_merged_primary_challenge_task ->
# cleanup_completed_task -> safe_remove_task_worktree_and_branch call path as
# the squash-delivery incident fixture, so this proves the guard still holds
# on the exact code path the incident exercises.
set -euo pipefail

incident_setup_control_dirty_worktree() {
  CONTROL_ISSUE="HOK-4001"
  CONTROL_SLUG="control-dirty-worktree"
  local branch="task/$CONTROL_SLUG"
  local wt_dir="$WORKTREE_ROOT/$CONTROL_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'uncommitted\n' > "$wt_dir/dirty.txt"

  local ready_dir="$wt_dir/features/$CONTROL_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  incident_seed_task "$CONTROL_ISSUE" "$(jq -cn \
    --arg slug "$CONTROL_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-4001"}')"

  incident_write_hook "$CONTROL_ISSUE" "idle" "Stop" "" "claude"
}
