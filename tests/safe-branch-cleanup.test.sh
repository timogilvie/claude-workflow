#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_ROOT/shared/lib/wavemill-common.sh"

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helper_file="$tmp/safe-cleanup-helper.sh"
{
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_DEFAULT=15'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MIN=1'
  printf '%s\n' 'WAVEMILL_GIT_REMOTE_TIMEOUT_MAX=600'
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_warn"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_timeout_seconds"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_kill_process_tree"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_git_remote_with_timeout"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "wavemill_cleanup_run"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "_wavemill_write_preserved_branch_incident"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch"
} > "$helper_file"

fail() {
  echo "$1" >&2
  exit 1
}

setup_repo() {
  local case_name="$1"
  local case_dir="$tmp/$case_name"
  local origin="$case_dir/origin.git"
  local repo="$case_dir/repo"

  mkdir -p "$case_dir"
  git init --bare "$origin" >/dev/null
  git clone "$origin" "$repo" >/dev/null 2>&1
  git -C "$repo" config user.email "test@example.com"
  git -C "$repo" config user.name "Wavemill Test"
  git -C "$repo" checkout -b auto/integration >/dev/null 2>&1
  printf 'base\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m "base" >/dev/null
  git -C "$repo" push -u origin auto/integration >/dev/null 2>&1
  printf '%s\n' "$repo"
}

add_task_worktree() {
  local repo="$1" branch="$2" wt_dir="$3"
  git -C "$repo" branch "$branch" auto/integration
  git -C "$repo" worktree add "$wt_dir" "$branch" >/dev/null 2>&1
}

commit_in_worktree() {
  local wt_dir="$1" file_name="$2" message="$3"
  printf '%s\n' "$message" > "$wt_dir/$file_name"
  git -C "$wt_dir" add "$file_name"
  git -C "$wt_dir" commit -m "$message" >/dev/null
}

run_helper() {
  local repo="$1" wt_dir="$2" branch="$3" base_branch="${4:-auto/integration}" caller="${5:-test}"
  REPO_DIR="$repo" WT_DIR="$wt_dir" BRANCH="$branch" BASE="$base_branch" CALLER="$caller" HELPER_FILE="$helper_file" bash -lc '
    set -euo pipefail
    source "$HELPER_FILE"
    MILL_LOG_FILE="$REPO_DIR/mill.log"
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    set +e
    safe_remove_task_worktree_and_branch "$WT_DIR" "$BRANCH" "$BASE" "$CALLER"
    rc=$?
    set -e
    printf "rc=%s\n" "$rc"
    printf "logs=%s\n" "$(printf "%s" "$LOG_OUTPUT" | tr "\n" ";")"
    printf "warns=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" ";")"
  '
}

branch_exists() {
  git -C "$1" show-ref --verify --quiet "refs/heads/$2"
}

marker_path() {
  local repo="$1" branch="$2"
  printf '%s/.wavemill/incidents/preserved-branches/%s.json\n' "$repo" "${branch//\//__}"
}

assert_exists() {
  [[ -e "$1" ]] || fail "expected to exist: $1"
}

assert_absent() {
  [[ ! -e "$1" ]] || fail "expected to be absent: $1"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "$label missing '$needle': $haystack"
}

case_unpushed_commits_retained() {
  local repo branch wt out marker
  repo="$(setup_repo unpushed)"
  branch="task/unpushed"
  wt="$tmp/unpushed/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "unpushed return"
  branch_exists "$repo" "$branch" || fail "unpushed branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "unpushed marker reason mismatch"
  [[ "$(jq -r '.commitsAhead' "$marker")" == "1" ]] || fail "unpushed marker commitsAhead mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "unpushed warning"
}

case_pushed_unmerged_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo pushed)"
  branch="task/pushed"
  wt="$tmp/pushed/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  git -C "$repo" fetch origin "$branch" >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "pushed return"
  branch_exists "$repo" "$branch" && fail "pushed branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_merged_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo merged)"
  branch="task/merged"
  wt="$tmp/merged/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$repo" merge --ff-only "$branch" >/dev/null
  git -C "$repo" push origin auto/integration >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "merged return"
  branch_exists "$repo" "$branch" && fail "merged branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_pushed_then_local_commit_retained() {
  local repo branch wt out marker
  repo="$(setup_repo pushed-then-local)"
  branch="task/pushed-then-local"
  wt="$tmp/pushed-then-local/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push -u origin "$branch" >/dev/null 2>&1
  git -C "$repo" fetch origin "$branch" >/dev/null 2>&1
  commit_in_worktree "$wt" "local.txt" "local"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "pushed-then-local return"
  branch_exists "$repo" "$branch" || fail "pushed-then-local branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "pushed-then-local marker reason mismatch"
  [[ "$(jq -r '.verificationReason' "$marker")" == "remote_missing_local_head" ]] || fail "pushed-then-local verification reason mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "pushed-then-local warning"
}

case_stale_local_base_uses_origin_base() {
  local repo branch wt out marker
  repo="$(setup_repo stale-local-base)"
  branch="task/stale-local-base"
  wt="$tmp/stale-local-base/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$wt" push origin HEAD:auto/integration >/dev/null 2>&1

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "stale-local-base return"
  branch_exists "$repo" "$branch" && fail "stale-local-base branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_remote_verification_failure_preserved() {
  local repo branch wt out marker
  repo="$(setup_repo remote-verification-failure)"
  branch="task/remote-verification-failure"
  wt="$tmp/remote-verification-failure/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"
  git -C "$repo" remote set-url origin "$tmp/remote-verification-failure/missing-origin.git"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "remote-verification-failure return"
  branch_exists "$repo" "$branch" || fail "remote-verification-failure branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.verificationReason' "$marker")" == base_fetch_failed:* ]] || fail "remote-verification-failure reason mismatch"
  assert_contains "$out" "PRESERVED_UNPUSHED_WORK" "remote-verification-failure warning"
}

case_no_new_commits_deleted() {
  local repo branch wt out marker
  repo="$(setup_repo no-new-commits)"
  branch="task/no-new-commits"
  wt="$tmp/no-new-commits/wt"
  add_task_worktree "$repo" "$branch" "$wt"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=0" "no-new return"
  branch_exists "$repo" "$branch" && fail "no-new branch was retained"
  assert_absent "$wt"
  assert_absent "$marker"
}

case_dirty_worktree_retained() {
  local repo branch wt out marker
  repo="$(setup_repo dirty)"
  branch="task/dirty"
  wt="$tmp/dirty/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  printf 'dirty\n' > "$wt/dirty.txt"

  out="$(run_helper "$repo" "$wt" "$branch")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "dirty return"
  branch_exists "$repo" "$branch" || fail "dirty branch was deleted"
  assert_exists "$wt/dirty.txt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "dirty_worktree" ]] || fail "dirty marker reason mismatch"
  assert_contains "$out" "PRESERVED_DIRTY_WORKTREE" "dirty warning"
}

case_protected_branch_refused() {
  local repo out
  repo="$(setup_repo protected)"
  out="$(run_helper "$repo" "$repo" "main")"
  assert_contains "$out" "rc=0" "protected return"
  assert_contains "$out" "Refusing to delete protected branch: main" "protected warning"
  assert_absent "$repo/.wavemill/incidents/preserved-branches/main.json"
}

case_branch_already_absent() {
  local repo out
  repo="$(setup_repo absent)"
  out="$(run_helper "$repo" "" "task/absent")"
  assert_contains "$out" "rc=0" "absent return"
}

case_unresolvable_base_preserved() {
  local repo branch wt out marker
  repo="$(setup_repo missing-base)"
  branch="task/missing-base"
  wt="$tmp/missing-base/wt"
  add_task_worktree "$repo" "$branch" "$wt"
  commit_in_worktree "$wt" "feature.txt" "feature"

  out="$(run_helper "$repo" "$wt" "$branch" "missing/base")"
  marker="$(marker_path "$repo" "$branch")"
  assert_contains "$out" "rc=10" "missing-base return"
  branch_exists "$repo" "$branch" || fail "missing-base branch was deleted"
  assert_exists "$wt"
  assert_exists "$marker"
  [[ "$(jq -r '.reason' "$marker")" == "unpushed_commits" ]] || fail "missing-base marker reason mismatch"
}

case_all_sites_refactored() {
  local non_helper_matches helper_matches
  non_helper_matches="$(grep -nE 'branch -[dD]|worktree remove --force|worktree remove' \
    "$REPO_ROOT/shared/lib/wavemill-mill.sh" \
    "$REPO_ROOT/shared/lib/wavemill-monitor.sh" \
    "$REPO_ROOT/shared/lib/wavemill-startup-runner.sh" || true)"
  [[ -z "$non_helper_matches" ]] || fail "unsafe cleanup remains outside helper: $non_helper_matches"

  helper_matches="$(extract_function "$COMMON_SCRIPT" "safe_remove_task_worktree_and_branch")"
  assert_contains "$helper_matches" "worktree remove" "helper worktree cleanup"
  assert_contains "$helper_matches" "branch \"\$branch_delete_flag\"" "helper branch cleanup"
  assert_contains "$helper_matches" "branch_delete_flag=\"-D\"" "helper force cleanup only after guard"
  [[ "$helper_matches" != *"--force"* ]] || fail "helper still force-removes worktrees"
}

case_unpushed_commits_retained
case_pushed_unmerged_deleted
case_merged_deleted
case_pushed_then_local_commit_retained
case_stale_local_base_uses_origin_base
case_remote_verification_failure_preserved
case_no_new_commits_deleted
case_dirty_worktree_retained
case_protected_branch_refused
case_branch_already_absent
case_unresolvable_base_preserved
case_all_sites_refactored

echo "safe-branch-cleanup test passed"
