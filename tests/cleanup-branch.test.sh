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

if grep -Fq 'push origin --delete "$task_branch"' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Deleted remote branch: $task_branch' <<< "$HEREDOC_CONTENT"; then
  pass "monitor cleanup deletes remote task branches"
else
  fail "monitor cleanup is missing remote branch deletion"
fi

outer_cleanup=$(sed -n '2705,2750p' "$MILL_SCRIPT")
if grep -Fq 'push origin --delete "$task_branch"' <<< "$outer_cleanup" \
  && grep -Fq 'Deleted remote branch: $task_branch' <<< "$outer_cleanup"; then
  pass "outer cleanup deletes remote task branches"
else
  fail "outer cleanup is missing remote branch deletion"
fi

if grep -Fq 'Deleted local branch: $task_branch' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Deleted local branch: $task_branch' <<< "$outer_cleanup"; then
  pass "cleanup logging distinguishes local branch deletion"
else
  fail "cleanup logging still reports generic branch deletion"
fi

if grep -Fq 'Remote branch already deleted or push failed: $task_branch' <<< "$HEREDOC_CONTENT" \
  && grep -Fq 'Remote branch already deleted or push failed: $task_branch' <<< "$outer_cleanup"; then
  pass "cleanup tolerates already-deleted remote branches"
else
  fail "cleanup is missing remote deletion fallback logging"
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
