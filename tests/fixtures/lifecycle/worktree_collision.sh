#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-worktree-collision.XXXXXX)"
TEST_REPO="$TMP_DIR/repo"
BRANCH="task/worktree-collision"
PATH_A="$TMP_DIR/worktree-a"
PATH_B="$TMP_DIR/worktree-b"
CANONICAL_PATH_A="$(cd "$TMP_DIR" && pwd -P)/worktree-a"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# shellcheck source=/dev/null
source "$COMMON_LIB"

git -C "$TMP_DIR" init -q repo
git -C "$TEST_REPO" config user.email "tests@example.com"
git -C "$TEST_REPO" config user.name "Wavemill Tests"
printf 'root\n' > "$TEST_REPO/README.md"
git -C "$TEST_REPO" add README.md
git -C "$TEST_REPO" commit -q -m "Initial commit"
git -C "$TEST_REPO" branch "$BRANCH"

git -C "$TEST_REPO" worktree add "$PATH_A" "$BRANCH" >/dev/null
rm -rf "$PATH_A"

resolved_path="$(ensure_worktree "$BRANCH" "$PATH_A" "$TEST_REPO" 2>"$TMP_DIR/stale.stderr")"
if [[ "$resolved_path" != "$PATH_A" ]]; then
  echo "FAIL: stale registration resolved to '$resolved_path', expected '$PATH_A'"
  exit 1
fi
if [[ ! -d "$PATH_A/.git" && ! -f "$PATH_A/.git" ]]; then
  echo "FAIL: stale registration was not recreated at '$PATH_A'"
  exit 1
fi

worktree_count_before="$(git -C "$TEST_REPO" worktree list --porcelain | grep -c '^worktree ')"
resolved_path="$(ensure_worktree "$BRANCH" "$PATH_A" "$TEST_REPO" 2>"$TMP_DIR/reuse.stderr")"
worktree_count_after="$(git -C "$TEST_REPO" worktree list --porcelain | grep -c '^worktree ')"
if [[ "$resolved_path" != "$PATH_A" ]]; then
  echo "FAIL: same-path reuse resolved to '$resolved_path', expected '$PATH_A'"
  exit 1
fi
if [[ "$worktree_count_before" != "$worktree_count_after" ]]; then
  echo "FAIL: same-path reuse changed worktree count from $worktree_count_before to $worktree_count_after"
  exit 1
fi

resolved_path="$(ensure_worktree "$BRANCH" "$PATH_B" "$TEST_REPO" 2>"$TMP_DIR/other.stderr")"
if [[ "$resolved_path" != "$CANONICAL_PATH_A" ]]; then
  echo "FAIL: different-path reuse resolved to '$resolved_path', expected existing '$CANONICAL_PATH_A'"
  exit 1
fi
if [[ -e "$PATH_B" ]]; then
  echo "FAIL: different-path reuse unexpectedly created '$PATH_B'"
  exit 1
fi

echo "PASS: ensure_worktree handles stale and reused registrations"
