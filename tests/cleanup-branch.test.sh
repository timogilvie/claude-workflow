#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Cleanup Branch Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

cleanup_defs=$(grep -c '^cleanup_completed_task()' "$MILL_SCRIPT" || true)
if [[ "$cleanup_defs" == "2" ]]; then
  pass "cleanup_completed_task remains patched in both script contexts"
else
  fail "expected two cleanup_completed_task definitions, found $cleanup_defs"
fi

remote_cleanup_defs=$(grep -c '^cleanup_remote_task_branch()' "$MILL_SCRIPT" || true)
if [[ "$remote_cleanup_defs" == "2" ]]; then
  pass "cleanup_remote_task_branch exists in both script contexts"
else
  fail "expected two cleanup_remote_task_branch definitions, found $remote_cleanup_defs"
fi

outer_cleanup=$(awk '
  /^cleanup_completed_task\(\) \{/ { count++; if (count == 1) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$MILL_SCRIPT")

monitor_cleanup=$(awk '
  /^cleanup_completed_task\(\) \{/ { count++; if (count == 2) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$MILL_SCRIPT")

outer_remote_cleanup=$(awk '
  /^cleanup_remote_task_branch\(\) \{/ { count++; if (count == 1) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$MILL_SCRIPT")

monitor_remote_cleanup=$(awk '
  /^cleanup_remote_task_branch\(\) \{/ { count++; if (count == 2) in_fn=1 }
  in_fn { print }
  in_fn && /^}$/ { exit }
' "$MILL_SCRIPT")

if grep -Fq 'cleanup_remote_task_branch "$issue" "$task_branch" "$pr"' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'cleanup_remote_task_branch "$issue" "$task_branch" "$pr"' <<< "$outer_cleanup"; then
  pass "both cleanup copies invoke remote branch cleanup"
else
  fail "cleanup_completed_task is missing remote branch cleanup calls"
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
  if grep -Fq "$needle" <<< "$outer_remote_cleanup" \
    && grep -Fq "$needle" <<< "$monitor_remote_cleanup"; then
    pass "remote cleanup helper contains: $needle"
  else
    fail "remote cleanup helper missing: $needle"
  fi
done

if grep -Fq 'execute _with_timeout "$API_TIMEOUT" git -C "$REPO_DIR" push origin --delete "$task_branch"' <<< "$outer_remote_cleanup" \
  && grep -Fq '_with_timeout "$API_TIMEOUT" git -C "$REPO_DIR" push origin --delete "$task_branch"' <<< "$monitor_remote_cleanup"; then
  pass "outer cleanup dry-runs remote deletion and monitor performs it directly"
else
  fail "remote deletion is not wired with the expected outer/monitor execution style"
fi

if grep -Fq 'Deleted local branch: $task_branch' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Deleted local branch: $task_branch' <<< "$outer_cleanup"; then
  pass "cleanup logging distinguishes local branch deletion"
else
  fail "cleanup logging still reports generic branch deletion"
fi

if grep -Fq 'Local branch cleanup failed after worktree removal: $task_branch' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Local branch cleanup failed after worktree removal: $task_branch' <<< "$outer_cleanup"; then
  pass "cleanup warns but continues when local branch deletion fails"
else
  fail "cleanup is missing local deletion fallback logging"
fi

if grep -Fq 'Refusing to delete protected branch: $task_branch' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Refusing to delete protected branch: $task_branch' <<< "$outer_cleanup" \
  && grep -Fq 'Refusing to delete protected branch: $branch' "$MILL_SCRIPT"; then
  pass "cleanup guards protected branches in all deletion paths"
else
  fail "cleanup is missing protected branch guards"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
