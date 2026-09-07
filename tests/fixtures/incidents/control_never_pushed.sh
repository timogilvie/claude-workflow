#!/usr/bin/env bash
# Safety control: workflow-state says merged, but the task branch was never
# pushed to origin at all. safe_remove_task_worktree_and_branch must treat
# the unpublished commit as work at risk and preserve the branch/worktree.
set -euo pipefail

incident_setup_control_never_pushed() {
  CONTROL_ISSUE="HOK-4004"
  CONTROL_SLUG="control-never-pushed"
  local branch="task/$CONTROL_SLUG"
  local wt_dir="$WORKTREE_ROOT/$CONTROL_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'never pushed\n' > "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "never pushed" >/dev/null

  local ready_dir="$wt_dir/features/$CONTROL_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  incident_seed_task "$CONTROL_ISSUE" "$(jq -cn \
    --arg slug "$CONTROL_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-4004"}')"

  incident_write_hook "$CONTROL_ISSUE" "idle" "Stop" "" "claude"
}
