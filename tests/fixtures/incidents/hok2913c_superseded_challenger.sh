#!/usr/bin/env bash
# Incident fixture: HOK-2913_c-style challenger superseded by a merged
# primary, with a retained terminal pane.
#
# Topology: a challenge pair where the primary (HOK-2913) merges normally and
# the challenger (HOK-2913_c) is closed without merge (superseded). The
# challenger's workflow-state entry has `challenge: true` and
# `challengePairId: "HOK-2913"` (so is_challenge_task() and sibling-lookup
# machinery both recognize it as part of a pair) but is MISSING
# `challengeRole: "challenger"` - the exact field the real HOK-2926 fix
# ("save_task_state derive an omitted challengeRole instead of rejecting the
# write") targeted. A task entry written by any path that predates/bypasses
# that derivation (or that this fixture seeds directly, as a stand-in for
# such a path) reproduces the drift in production.
#
# Root cause this reproduces: shared/lib/wavemill-monitor.sh's closed-PR
# dispatch (elif "$pr_status" == "CLOSED") uses TWO independent challenge
# detectors that read different fields and disagree once challengeRole is
# missing:
#   - is_challenge_task() reads `.tasks[$issue].challenge` -> true, so the
#     Linear-deferral branch treats this as a challenge task and tries to
#     resolve the sibling PR via get_challenge_sibling_pr(), which requires
#     BOTH challengePairId AND challengeRole. With challengeRole missing,
#     get_challenge_sibling_pr() returns 1, sibling_pr stays empty, and the
#     `Backlog::*` case arm explicitly resets linear_status="" (deferred) -
#     so wavemill_reconcile_terminal is never even called for this task.
#   - should_cleanup_closed_pr() reads `.tasks[$issue].challengeRole` only
#     (not `.challenge`) and requires it to equal "challenger" to trigger
#     cleanup_completed_task. With challengeRole missing, it returns false,
#     so the `else` branch fires: `CLEANED[$issue]=1` and nothing else -
#     exactly should_cleanup_closed_pr's sibling bug in hok2595_closed_non_
#     challenge.sh, but reached through the challenge path instead of the
#     "not a challenge task at all" path.
# Net effect: NEITHER the terminal reconciler NOR cleanup_completed_task ever
# runs for this task. Unlike the hok2595 fixture (where the terminal
# reconciler at least marks phase/status/hook "closed" even though the pane
# leaks), this challenger's workflow-state stays completely unchanged -
# phase, status, and hook file are exactly what they were before the PR
# closed - while its tmux pane and worktree/branch survive indefinitely. This
# is a strictly worse form of the same bug class and matches the incident's
# "interrupted/exited agent, pane still present" description.
#
# The primary (HOK-2913) is unaffected by any of this: it merges normally
# through the generic `validate_pr_merge` branch and
# cleanup_merged_primary_challenge_task, and its pane/worktree/branch are
# expected to close on the SAME tick - proving the bug is specific to the
# challenger's field-omission, not to challenge pairs in general.
set -euo pipefail

incident_setup_hok2913c_superseded_challenger() {
  HOK2913_ISSUE="HOK-2913"
  HOK2913_SLUG="review-scope-guards"
  HOK2913_PR="2000"
  HOK2913C_ISSUE="HOK-2913_c"
  HOK2913C_SLUG="review-scope-guards-challenger"
  HOK2913C_PR="2001"

  local primary_branch="task/$HOK2913_SLUG"
  local primary_wt="$WORKTREE_ROOT/$HOK2913_SLUG"
  local challenger_branch="task/$HOK2913C_SLUG"
  local challenger_wt="$WORKTREE_ROOT/$HOK2913C_SLUG"

  # Challenger branches off the pre-merge base first (matches the real
  # challenge-pair flow: both arms fork from the same point, then race).
  git -C "$REPO_DIR" branch "$challenger_branch" auto/integration
  git -C "$REPO_DIR" worktree add "$challenger_wt" "$challenger_branch" >/dev/null 2>&1
  printf 'challenger approach\n' > "$challenger_wt/approach.txt"
  git -C "$challenger_wt" add approach.txt
  git -C "$challenger_wt" commit -m "challenger: alternate approach" >/dev/null
  git -C "$challenger_wt" push -u origin "$challenger_branch" >/dev/null 2>&1

  # Primary branches off the same base, adds its own (different) change, and
  # is fast-forward-merged into auto/integration - a clean, ordinary primary
  # merge with nothing for safe_remove_task_worktree_and_branch to preserve.
  git -C "$REPO_DIR" branch "$primary_branch" auto/integration
  git -C "$REPO_DIR" worktree add "$primary_wt" "$primary_branch" >/dev/null 2>&1
  printf 'primary approach\n' > "$primary_wt/approach.txt"
  git -C "$primary_wt" add approach.txt
  git -C "$primary_wt" commit -m "primary: winning approach" >/dev/null
  git -C "$primary_wt" push -u origin "$primary_branch" >/dev/null 2>&1
  git -C "$REPO_DIR" merge --ff-only "$primary_branch" >/dev/null
  git -C "$REPO_DIR" push origin auto/integration >/dev/null 2>&1

  # The challenger is now provably NOT an ancestor of the rewritten base (the
  # primary's file collides with the challenger's), and it was never merged.
  if git -C "$REPO_DIR" merge-base --is-ancestor "$challenger_branch" auto/integration 2>/dev/null; then
    echo "FIXTURE BUG: challenger branch accidentally left as an ancestor of the post-merge base" >&2
    return 1
  fi

  record_pr "$HOK2913_PR" "MERGED" "2026-09-04T11:00:00Z" "$(git -C "$primary_wt" rev-parse HEAD)" "$primary_branch" "auto/integration"
  record_pr "$HOK2913C_PR" "CLOSED" "null" "" "$challenger_branch" "auto/integration"

  # Timestamps are backdated well past `run_observer_pass`'s
  # --stale-minutes 1 so the age-gated residue detectors fire deterministically
  # without a real-time wait.
  local backdated
  backdated="$(date -u -v-2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '2 hours ago' +"%Y-%m-%dT%H:%M:%SZ")"

  incident_seed_task "$HOK2913_ISSUE" "$(jq -cn \
    --arg slug "$HOK2913_SLUG" --arg branch "$primary_branch" --arg wt "$primary_wt" --arg pr "$HOK2913_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"",phase:"review",agent:"codex",linearIssueId:"HOK-2913",challenge:true,challengeRole:"primary",challengePairId:"HOK-2913",updated:$updated}')"

  # The bug under test: challengeRole is deliberately omitted here.
  incident_seed_task "$HOK2913C_ISSUE" "$(jq -cn \
    --arg slug "$HOK2913C_SLUG" --arg branch "$challenger_branch" --arg wt "$challenger_wt" --arg pr "$HOK2913C_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"",phase:"review",agent:"codex",linearIssueId:"HOK-2913",challenge:true,challengePairId:"HOK-2913",challengeAborted:true,updated:$updated}')"

  incident_write_hook "$HOK2913_ISSUE" "idle" "Stop" "" "codex"
  incident_write_hook "$HOK2913C_ISSUE" "error" "native-error" "interrupt" "codex"

  incident_scenario_add_task_window "$HOK2913_ISSUE" "$HOK2913_SLUG"
  incident_scenario_add_task_window "$HOK2913C_ISSUE" "$HOK2913C_SLUG"
}
