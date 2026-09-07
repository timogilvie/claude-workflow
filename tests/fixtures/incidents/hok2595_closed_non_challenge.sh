#!/usr/bin/env bash
# Incident fixture: HOK-2595-style closed non-challenge task with a retained
# terminal pane.
#
# Topology: a regular (non-challenge) task whose PR was closed without being
# merged. The local branch is a clean fast-forward of auto/integration (no
# unpushed commits, no divergence) - there is nothing for the safety guards
# in safe_remove_task_worktree_and_branch to legitimately preserve. The
# workflow-state task entry is still `phase=review, status=""` (the
# controller never recorded a terminal status for it), and its tmux window
# is still alive with a `sleep` pane standing in for an agent process that
# already exited.
#
# Root cause this reproduces: monitor_issue_state's PR-status dispatch calls
# should_cleanup_closed_pr(), which only returns true for a challenger arm
# (see shared/lib/wavemill-monitor.sh). For a *regular* task, a closed,
# unmerged PR takes the `else` branch: `CLEANED[$issue]=1` is set (so the
# task stops counting toward active-slot accounting) but nothing else
# happens - no cleanup is attempted, the tmux window is never closed, the
# worktree is never removed, and no attention flag is raised. The task
# silently disappears from "active" bookkeeping while its resources leak
# forever, which is the "retained terminal pane" the incident observed.
set -euo pipefail

incident_setup_hok2595_closed_non_challenge() {
  HOK2595_ISSUE="HOK-2595"
  HOK2595_SLUG="detect-and-correlate-incidents"
  HOK2595_PR="1000"
  local branch="task/$HOK2595_SLUG"
  local wt_dir="$WORKTREE_ROOT/$HOK2595_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1
  # No commits beyond auto/integration: the branch is an exact, already
  # fast-forwarded match of base, so no cleanup guard has anything to
  # preserve - the only thing keeping this task's resources alive should be
  # the bug under test.

  record_pr "$HOK2595_PR" "CLOSED" "null" "" "$branch" "auto/integration"

  # Backdated well past run_observer_pass's --stale-minutes 1 so the
  # age-gated residue detectors in tools/observer.ts fire deterministically
  # without a real-time wait.
  local backdated
  backdated="$(date -u -v-2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '2 hours ago' +"%Y-%m-%dT%H:%M:%SZ")"

  incident_seed_task "$HOK2595_ISSUE" "$(jq -cn \
    --arg slug "$HOK2595_SLUG" --arg branch "$branch" --arg wt "$wt_dir" --arg pr "$HOK2595_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"",phase:"review",agent:"claude",linearIssueId:"HOK-2595",updated:$updated}')"

  incident_write_hook "$HOK2595_ISSUE" "waiting" "UserPromptSubmit" "Claude is waiting for your input" "claude"

  incident_scenario_add_task_window "$HOK2595_ISSUE" "$HOK2595_SLUG"
}
