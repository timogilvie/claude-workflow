#!/usr/bin/env bash
# Safety control: workflow-state says the task is merged, but the local
# branch is one commit AHEAD of what was actually pushed (push happened,
# then another local commit landed). safe_remove_task_worktree_and_branch
# must find the remote head is not an ancestor of the local head and
# preserve the branch (verificationReason=remote_missing_local_head) rather
# than trusting workflow-state's "merged" status.
set -euo pipefail

incident_setup_control_divergent_local_ahead() {
  CONTROL_ISSUE="HOK-4002"
  CONTROL_SLUG="control-divergent-local-ahead"
  local branch="task/$CONTROL_SLUG"
  local wt_dir="$WORKTREE_ROOT/$CONTROL_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'pushed change\n' > "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "pushed change" >/dev/null
  git -C "$wt_dir" push -u origin "$branch" >/dev/null 2>&1

  printf 'local-only change\n' >> "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "local-only change" >/dev/null

  local ready_dir="$wt_dir/features/$CONTROL_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  incident_seed_task "$CONTROL_ISSUE" "$(jq -cn \
    --arg slug "$CONTROL_SLUG" --arg branch "$branch" --arg wt "$wt_dir" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:"",status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-4002"}')"

  incident_write_hook "$CONTROL_ISSUE" "idle" "Stop" "" "claude"
}
