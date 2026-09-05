#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Cleanup Branch Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" || ! -f "$MONITOR_SCRIPT_FILE" || ! -f "$COMMON_SCRIPT" ]]; then
  fail "wavemill cleanup source files not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

HEREDOC_CONTENT=$(cat "$MONITOR_SCRIPT_FILE")

common_cleanup_defs=$(grep -c '^cleanup_completed_task()' "$COMMON_SCRIPT" || true)
private_cleanup_defs=$(( $(grep -c '^cleanup_completed_task()' "$MILL_SCRIPT" || true) + $(grep -c '^cleanup_completed_task()' "$MONITOR_SCRIPT_FILE" || true) ))
if [[ "$common_cleanup_defs" == "1" && "$private_cleanup_defs" == "0" ]]; then
  pass "cleanup_completed_task has one common definition"
else
  fail "expected one common and zero private cleanup_completed_task definitions"
fi

common_remote_cleanup_defs=$(grep -c '^cleanup_remote_task_branch()' "$COMMON_SCRIPT" || true)
private_remote_cleanup_defs=$(( $(grep -c '^cleanup_remote_task_branch()' "$MILL_SCRIPT" || true) + $(grep -c '^cleanup_remote_task_branch()' "$MONITOR_SCRIPT_FILE" || true) ))
if [[ "$common_remote_cleanup_defs" == "1" && "$private_remote_cleanup_defs" == "0" ]]; then
  pass "cleanup_remote_task_branch has one common definition"
else
  fail "expected one common and zero private cleanup_remote_task_branch definitions"
fi

common_cleanup=$(awk '
  /^cleanup_completed_task\(\) \{/ { count++; if (count == 1) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$COMMON_SCRIPT")

common_remote_cleanup=$(awk '
  /^cleanup_remote_task_branch\(\) \{/ { count++; if (count == 1) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$COMMON_SCRIPT")

safe_cleanup=$(awk '
  /^safe_remove_task_worktree_and_branch\(\) \{/ { count++; if (count == 1) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$COMMON_SCRIPT")

if grep -Fq 'cleanup_remote_task_branch "$issue" "$task_branch" "$pr"' <<< "$common_cleanup"; then
  pass "common cleanup invokes remote branch cleanup"
else
  fail "cleanup_completed_task is missing remote branch cleanup calls"
fi

if grep -Fq 'cleanup_completed_task "$issue" "$slug"' "$MONITOR_SCRIPT_FILE" \
  && grep -Fq 'cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"' "$MONITOR_SCRIPT_FILE" \
  && ! grep -Fq 'cleanup_forfeit_loser_from_resolution' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" "$COMMON_SCRIPT"; then
  pass "monitor cleanup callers remain and hard-failure cleanup is gone"
else
  fail "cleanup callers or hard-failure cleanup guard changed unexpectedly"
fi

# HOK-2774 reverses the HOK-1547/#524 split: tend deletes refs only for
# tend-driven merges, while manual merges leaked stale remote refs that blocked
# sibling challenge PRs indefinitely.
for needle in \
  'push origin --delete "$task_branch"' \
  'pr_state "$pr"' \
  'Deleted remote branch: $task_branch' \
  'retaining remote branch' \
  'Refusing to delete protected branch: $task_branch'; do
  if grep -Fq "$needle" <<< "$common_remote_cleanup"; then
    pass "remote cleanup helper contains: $needle"
  else
    fail "remote cleanup helper missing: $needle"
  fi
done

if grep -Fq 'wavemill_cleanup_run _with_timeout "$API_TIMEOUT" git -C "$REPO_DIR" push origin --delete "$task_branch"' <<< "$common_remote_cleanup" \
  && grep -Fq 'command -v execute' "$COMMON_SCRIPT"; then
  pass "common command adapter preserves parent dry-run behavior"
else
  fail "remote deletion is not wired through the common cleanup adapter"
fi

if grep -Fq 'Deleted local branch: $task_branch' <<< "$safe_cleanup"; then
  pass "cleanup logging distinguishes local branch deletion"
else
  fail "cleanup logging still reports generic branch deletion"
fi

if grep -Fq 'refs/remotes/origin/${base_branch}' <<< "$safe_cleanup" \
  && grep -Fq 'ls-remote --heads origin "$remote_ref"' <<< "$safe_cleanup" \
  && grep -Fq 'merge-base --is-ancestor "$local_head_sha" "$remote_head_sha"' <<< "$safe_cleanup"; then
  pass "cleanup verifies authoritative base and remote head evidence"
else
  fail "cleanup is missing authoritative base/head verification"
fi

if grep -Fq 'branch "$branch_delete_flag" "$task_branch"' <<< "$safe_cleanup" \
  && grep -Fq 'branch_delete_flag="-D"' <<< "$safe_cleanup" \
  && grep -Fq 'merged_to_current_head' <<< "$safe_cleanup"; then
  pass "cleanup selects branch delete mode after guard checks"
else
  fail "cleanup branch deletion is not routed through guarded delete mode"
fi

if grep -Fq 'Local branch cleanup failed after worktree removal: $task_branch' <<< "$safe_cleanup" \
  && grep -Fq 'return 20' <<< "$safe_cleanup"; then
  pass "cleanup retains state when local branch deletion fails"
else
  fail "cleanup is missing local deletion fallback logging"
fi

if grep -Fq 'Refusing to delete protected branch: $task_branch' <<< "$safe_cleanup" \
  && grep -Fq 'safe_remove_task_worktree_and_branch "$worktree" "$branch" "$BASE_BRANCH" "stale_task_pruner"' "$MILL_SCRIPT" \
  && grep -Fq 'safe_remove_task_worktree_and_branch "$wt_dir" "$task_branch" "${BASE_BRANCH:-main}" "cleanup_aborted_challenge_arm"' "$MONITOR_SCRIPT_FILE" \
  && grep -Fq 'safe_remove_task_worktree_and_branch "$wt_dir" "$branch" "${BASE_BRANCH:-main}" "startup_dependency_failure"' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "cleanup guards protected branches through shared helper"
else
  fail "cleanup is missing protected branch guards"
fi

if ! grep -R -nE 'worktree remove --force|branch -D' \
  "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" >/dev/null; then
  pass "cleanup has no direct forced deletion outside shared helper"
else
  fail "direct forced cleanup remains outside shared helper"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
