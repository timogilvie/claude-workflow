#!/usr/bin/env bash
# Incident fixture: HOK-3000, squash-merged PR with a deleted remote head.
#
# Topology: PR #3000 is MERGED with headRefOid == the local task branch's
# real head. auto/integration is rewritten on origin with a single squash
# commit whose tree matches the task branch tip, and the remote task branch
# is deleted (mirroring GitHub's post-merge branch deletion). The local task
# head is provably delivered (headRefOid matches the merged PR) but is NOT
# an ancestor of the rewritten base - the exact shape safe_remove_task_
# worktree_and_branch's `git merge-base --is-ancestor` check cannot see.
#
# Workflow-state starts with status=merged (a prior tick already recorded
# the merge) and a passing .ready-result.json, so monitor_issue_state takes
# the tmux-liveness-gated cleanup path rather than the ready-gate-bypass
# path. No tmux window is used for this scenario (Phase 2 of the plan
# deliberately isolates the squash-ancestry logic from pane management,
# which scenarios 1 and 2 cover).
set -euo pipefail

# incident_setup_squash_delivery - builds the topology and seeds state.
# Returns via globals: SQUASH_ISSUE, SQUASH_SLUG, SQUASH_PR, SQUASH_LOCAL_HEAD
incident_setup_squash_delivery() {
  SQUASH_ISSUE="HOK-3000"
  SQUASH_SLUG="squash-delivery-fixture"
  SQUASH_PR="3000"
  local branch="task/$SQUASH_SLUG"
  local wt_dir="$WORKTREE_ROOT/$SQUASH_SLUG"

  git -C "$REPO_DIR" branch "$branch" auto/integration
  git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1

  printf 'feature line 1\n' > "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "feature: part 1" >/dev/null
  printf 'feature line 2\n' >> "$wt_dir/feature.txt"
  git -C "$wt_dir" add feature.txt
  git -C "$wt_dir" commit -m "feature: part 2" >/dev/null
  git -C "$wt_dir" push -u origin "$branch" >/dev/null 2>&1

  SQUASH_LOCAL_HEAD="$(git -C "$wt_dir" rev-parse HEAD)"

  # Rewrite origin's auto/integration with a squash commit whose tree
  # matches the task branch tip, without the task branch as an ancestor -
  # exactly what `gh`/GitHub produces for a "Squash and merge".
  local origin_base_tip squash_tree squash_commit
  origin_base_tip="$(git -C "$REPO_DIR" rev-parse auto/integration)"
  squash_tree="$(git -C "$wt_dir" rev-parse HEAD^{tree})"
  squash_commit="$(git -C "$REPO_DIR" commit-tree "$squash_tree" -p "$origin_base_tip" \
    -m "feature: part 1 (#$SQUASH_PR) (squash)")"
  # REPO_DIR is the primary checkout (auto/integration is checked out there),
  # so move its own branch with reset --hard rather than `branch -f`, which
  # git refuses on a branch checked out in a worktree.
  git -C "$REPO_DIR" reset --hard "$squash_commit" >/dev/null
  git -C "$REPO_DIR" push origin auto/integration --force >/dev/null 2>&1

  # GitHub's post-merge automation deletes the remote head branch.
  git -C "$ORIGIN_DIR" update-ref -d "refs/heads/$branch"

  # The controller must not be able to fast-forward-verify this merge via
  # ancestry alone: prove it really is not an ancestor of the new base.
  if git -C "$REPO_DIR" merge-base --is-ancestor "$branch" auto/integration 2>/dev/null; then
    echo "FIXTURE BUG: squash topology accidentally left the task branch as an ancestor of base" >&2
    return 1
  fi

  record_pr "$SQUASH_PR" "MERGED" "2026-09-04T12:00:00Z" "$SQUASH_LOCAL_HEAD" "$branch" "auto/integration"

  local ready_dir="$wt_dir/features/$SQUASH_SLUG"
  mkdir -p "$ready_dir"
  jq -cn '{status:"completed",artifacts:{verdict:"pass"}}' > "$ready_dir/.ready-result.json"

  # Backdated well past run_observer_pass's --stale-minutes 1 so the
  # age-gated residue detectors in tools/observer.ts fire deterministically
  # without a real-time wait.
  local backdated
  backdated="$(date -u -v-2H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '2 hours ago' +"%Y-%m-%dT%H:%M:%SZ")"

  incident_seed_task "$SQUASH_ISSUE" "$(jq -cn \
    --arg slug "$SQUASH_SLUG" --arg branch "$branch" --arg wt "$wt_dir" --arg pr "$SQUASH_PR" --arg updated "$backdated" \
    '{slug:$slug,branch:$branch,worktree:$wt,pr:$pr,status:"merged",phase:"review",agent:"codex",linearIssueId:"HOK-3000",updated:$updated}')"

  incident_write_hook "$SQUASH_ISSUE" "idle" "Stop" "" "claude"
}
