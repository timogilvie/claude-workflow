#!/usr/bin/env bash
# HOK-2950: safety-control regression fixtures.
#
# Counter-fixtures to tests/incident-fixtures-terminal-panes.test.sh: they
# prove the existing cleanup guards in safe_remove_task_worktree_and_branch
# (shared/lib/wavemill-common.sh) still preserve dirty, racy, divergent,
# unreachable-remote, and never-pushed work when driven through the SAME
# real monitor_issue_state -> cleanup_merged_primary_challenge_task ->
# cleanup_completed_task -> safe_remove_task_worktree_and_branch call path
# the incident fixtures exercise. If these regress, a "fix" for the terminal-
# pane leak has gone too far and started deleting real work.
#
# See tests/fixtures/incidents/README.md for local/CI invocation and how to
# add a new fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=lib/incident-fixture-harness.sh
source "$SCRIPT_DIR/lib/incident-fixture-harness.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/control_dirty_worktree.sh
source "$FIXTURES_DIR/control_dirty_worktree.sh"
# shellcheck source=fixtures/incidents/control_local_head_changed.sh
source "$FIXTURES_DIR/control_local_head_changed.sh"
# shellcheck source=fixtures/incidents/control_divergent_local_ahead.sh
source "$FIXTURES_DIR/control_divergent_local_ahead.sh"
# shellcheck source=fixtures/incidents/control_missing_network.sh
source "$FIXTURES_DIR/control_missing_network.sh"
# shellcheck source=fixtures/incidents/control_never_pushed.sh
source "$FIXTURES_DIR/control_never_pushed.sh"

FAILURES=0

report_pass() { printf '  PASS: %s\n' "$1"; }
report_fail() { printf '  FAIL: %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }

expect_eq() {
  local actual="$1" expected="$2" label="$3"
  if [[ "$actual" == "$expected" ]]; then
    report_pass "$label (got '$actual')"
  else
    report_fail "$label: expected '$expected', got '$actual'"
  fi
}

expect_true() {
  local label="$1"
  shift
  if "$@"; then
    report_pass "$label"
  else
    report_fail "$label"
  fi
}

marker_path_for_branch() {
  local repo_dir="$1" branch="$2"
  printf '%s/.wavemill/incidents/preserved-branches/%s.json\n' "$repo_dir" "${branch//\//__}"
}

branch_exists() {
  git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$1"
}

# assert_control_preserved <issue> <slug> <branch> <expected-reason> <expected-verification-reason-or-empty>
#
# Drives two ticks (proving the guard is not a one-shot fluke) and asserts,
# after each: the preservation marker exists with the right reason/
# verificationReason, the workflow-state task entry is retained (cleanup
# never completed), the worktree directory still exists on disk, and the
# local branch still exists. This is the shared assertion body for all five
# controls - only the topology-building setup differs between them.
assert_control_preserved() {
  local issue="$1" slug="$2" branch="$3" expected_reason="$4" expected_verification_reason="$5"
  local wt_dir="$WORKTREE_ROOT/$slug"
  local marker_path
  marker_path="$(marker_path_for_branch "$REPO_DIR" "$branch")"

  local tick1 tick1_cleanup
  tick1="$(run_monitor_tick "$issue" "$slug" "")"
  tick1_cleanup="$(tick_field "$tick1" cleanup_merged_primary_calls)"
  expect_eq "$tick1_cleanup" "1" "$issue tick1: cleanup_merged_primary_challenge_task attempted (guard must run, not skip)"

  if [[ -f "$marker_path" ]]; then
    report_pass "$issue tick1: preservation marker written at $marker_path"
    local actual_reason actual_verification
    actual_reason="$(jq -r '.reason // ""' "$marker_path")"
    expect_eq "$actual_reason" "$expected_reason" "$issue tick1: marker reason"
    if [[ -n "$expected_verification_reason" ]]; then
      actual_verification="$(jq -r '.verificationReason // ""' "$marker_path")"
      case "$actual_verification" in
        "$expected_verification_reason"*)
          report_pass "$issue tick1: marker verificationReason matches '$expected_verification_reason' (got '$actual_verification')"
          ;;
        *)
          report_fail "$issue tick1: marker verificationReason expected prefix '$expected_verification_reason', got '$actual_verification'"
          ;;
      esac
    fi
  else
    report_fail "$issue tick1: no preservation marker found at $marker_path"
  fi

  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i] != null' "$STATE_FILE")" "true" \
    "$issue tick1: workflow-state task entry retained (cleanup did not complete)"
  expect_true "$issue tick1: worktree directory still present on disk" \
    bash -c "[[ -d '$wt_dir' ]]"
  expect_true "$issue tick1: local branch still exists" branch_exists "$branch"

  # Second tick: the guard must keep preserving on unchanged evidence, not
  # flip to deleting the branch just because it has already been asked once.
  local tick2 tick2_cleanup
  tick2="$(run_monitor_tick "$issue" "$slug" "")"
  tick2_cleanup="$(tick_field "$tick2" cleanup_merged_primary_calls)"
  expect_eq "$tick2_cleanup" "1" "$issue tick2: guard re-verifies (still attempted, not silently skipped)"
  expect_true "$issue tick2: worktree directory still present after a second tick" \
    bash -c "[[ -d '$wt_dir' ]]"
  expect_true "$issue tick2: local branch still exists after a second tick" branch_exists "$branch"
  expect_eq "$(jq -r --arg i "$issue" '.tasks[$i] != null' "$STATE_FILE")" "true" \
    "$issue tick2: workflow-state task entry still retained"
}

# ============================================================================
# Control 4: dirty worktree
# ============================================================================
echo ""
echo "=== Control 4: control_dirty_worktree_retained ==="
incident_scenario_new "dirty"
incident_setup_control_dirty_worktree
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "dirty_worktree" ""

# ============================================================================
# Control 5: local head changed mid-verification (race)
# ============================================================================
echo ""
echo "=== Control 5: control_local_head_changed_during_check ==="
incident_scenario_new "racehead"
incident_setup_control_local_head_changed
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "local_head_changed"

# ============================================================================
# Control 6: divergent - local ahead of what was pushed
# ============================================================================
echo ""
echo "=== Control 6: control_divergent_local_ahead_of_pushed ==="
incident_scenario_new "divergent"
incident_setup_control_divergent_local_ahead
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "remote_missing_local_head"

# ============================================================================
# Control 7: missing network (origin unreachable)
# ============================================================================
echo ""
echo "=== Control 7: control_missing_network ==="
incident_scenario_new "missingnet"
incident_setup_control_missing_network
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "base_fetch_failed:"

# ============================================================================
# Control 8: never pushed
# ============================================================================
echo ""
echo "=== Control 8: control_never_pushed ==="
incident_scenario_new "neverpushed"
incident_setup_control_never_pushed
assert_control_preserved "$CONTROL_ISSUE" "$CONTROL_SLUG" "task/$CONTROL_SLUG" "unpushed_commits" "remote_missing_local_head"

# ============================================================================
# Summary
# ============================================================================
echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "incident-fixtures-safety-controls: all assertions passed (safety guards intact)"
  exit 0
else
  echo "incident-fixtures-safety-controls: $FAILURES assertion(s) failed" >&2
  exit 1
fi
