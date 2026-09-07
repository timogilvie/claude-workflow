#!/usr/bin/env bash
# Safety control: the repo's origin remote is unreachable (points at a path
# that does not exist). safe_remove_task_worktree_and_branch's mandatory
# base-branch fetch must fail closed (verificationReason=base_fetch_failed:*)
# and preserve the branch/worktree rather than assume it is safe to delete.
set -euo pipefail

incident_setup_control_missing_network() {
  CONTROL_ISSUE="HOK-4003"
  CONTROL_SLUG="control-missing-network"
  local branch="task/$CONTROL_SLUG"
  local wt_dir="$WORKTREE_ROOT/$CONTROL_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'feature\n' > "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "feature" >/dev/null

  # Point origin at a path that never existed so every remote-facing git
  # call in safe_remove_task_worktree_and_branch fails closed.
  git -C "$REPO_DIR" remote set-url origin "$SCENARIO_DIR/no-such-origin.git"

  local ready_dir="$wt_dir/features/$CONTROL_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  incident_seed_task "$CONTROL_ISSUE" "$(jq -cn \
    --arg slug "$CONTROL_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-4003"}')"

  incident_write_hook "$CONTROL_ISSUE" "idle" "Stop" "" "claude"
}
