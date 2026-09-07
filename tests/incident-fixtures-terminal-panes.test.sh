#!/usr/bin/env bash
# HOK-2950: cross-component regression fixtures for the 2026-09-05 terminal
# resource leak / repeated-cleanup incident.
#
# Drives the REAL monitor_issue_state controller (extracted from
# shared/lib/wavemill-monitor.sh), real git topology, a real isolated tmux
# server, and the real tools/observer.ts against three incident topologies:
#   1. HOK-2595-style closed non-challenge task with a retained pane.
#   2. HOK-2913_c-style challenger superseded by a merged primary.
#   3. Squash-merged PR with a deleted remote head.
#
# See tests/fixtures/incidents/README.md for local/CI invocation and how to
# add a new fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Note: this driver deliberately does NOT declare its own REPO_DIR - the
# harness's incident_scenario_new sets a global REPO_DIR per scenario (the
# scenario's own clone), and every fixture/assertion below reads that. The
# wavemill repo root itself is available as $INCIDENT_REPO_DIR once the
# harness below is sourced.
# shellcheck source=lib/incident-fixture-harness.sh
source "$SCRIPT_DIR/lib/incident-fixture-harness.sh"
incident_harness_require_tools

FIXTURES_DIR="$SCRIPT_DIR/fixtures/incidents"
# shellcheck source=fixtures/incidents/hok2595_closed_non_challenge.sh
source "$FIXTURES_DIR/hok2595_closed_non_challenge.sh"
# shellcheck source=fixtures/incidents/hok2913c_superseded_challenger.sh
source "$FIXTURES_DIR/hok2913c_superseded_challenger.sh"
# shellcheck source=fixtures/incidents/squash_delivery_deleted_remote_head.sh
source "$FIXTURES_DIR/squash_delivery_deleted_remote_head.sh"

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

preservation_marker_count() {
  local repo_dir="$1"
  # The directory legitimately does not exist when no branch was ever
  # preserved; a bare find would fail the pipefail-ed driver in that case.
  if [[ ! -d "$repo_dir/.wavemill/incidents/preserved-branches" ]]; then
    printf '0\n'
    return 0
  fi
  find "$repo_dir/.wavemill/incidents/preserved-branches" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' '
}

count_matching_lines() {
  local file="$1" pattern="$2"
  grep -c "$pattern" "$file" 2>/dev/null || true
}

# ============================================================================
# Scenario 1: HOK-2595-style closed non-challenge task, retained pane
# ============================================================================
echo ""
echo "=== Scenario 1: incident_hok2595_closed_non_challenge_pr_retained_pane ==="

incident_scenario_new "hok2595"
incident_scenario_start_tmux
incident_setup_hok2595_closed_non_challenge

tick1="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
tick1_cleanup="$(tick_field "$tick1" cleanup_completed_calls)"
tick1_remote_delta="$(tick_field "$tick1" remote_call_delta)"

# Pre-fix reproduction: should_cleanup_closed_pr() only recognizes a
# challenger role; a regular (non-challenge) task with a closed, unmerged PR
# takes the `else` branch (CLEANED[$issue]=1) and NEVER calls
# cleanup_completed_task. This is the actual bug this fixture exists to
# catch - once fixed, this assertion should read cleanup_completed_calls==1.
expect_eq "$tick1_cleanup" "0" "hok2595 tick1: cleanup_completed_task is NOT invoked for a closed non-challenge PR (the leak)"
expect_true "hok2595 tick1: tmux pane remains alive (resource leak reproduced)" \
  assert_pane_alive "$HOK2595_ISSUE" "$HOK2595_SLUG"
expect_eq "$(jq -r '.tasks["HOK-2595"] != null' "$STATE_FILE")" "true" \
  "hok2595 tick1: task entry still present in workflow-state (never cleaned up)"

tick2="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
tick2_cleanup="$(tick_field "$tick2" cleanup_completed_calls)"
tick2_remote_delta="$(tick_field "$tick2" remote_call_delta)"
expect_eq "$tick2_cleanup" "0" "hok2595 tick2: still no cleanup attempt (idempotent, not just delayed)"
expect_true "hok2595 tick2: tmux pane STILL alive" \
  assert_pane_alive "$HOK2595_ISSUE" "$HOK2595_SLUG"

restart_tick="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
restart_cleanup="$(tick_field "$restart_tick" cleanup_completed_calls)"
expect_eq "$restart_cleanup" "0" "hok2595 restart replay: workflow state alone still does not converge (the leak survives a restart)"

# The terminal reconciler stamps `updated=now` every time it applies a new
# marker field (tick1 here), so an Observer pass run immediately afterward
# would trivially fail every age-gated staleness check regardless of whether
# the underlying bug is fixed. Backdate again to simulate the real incident
# shape: the monitor loop reconciled state minutes ago and has been idle
# since, while the pane/worktree residue it should have reaped is still
# sitting there.
incident_set_task_updated "$HOK2595_ISSUE" "$(incident_backdated_iso 2)"

observer_json="$(run_observer_pass)"
# Pre-fix reproduction of the disagreement: wavemill_reconcile_terminal
# already stamped workflow-state phase/status "closed" (a terminal status)
# during tick1, even though cleanup never actually ran. Observer's
# terminal-residue detector (taskHasTerminalResidueStatus + worktree/pane
# still present) is the one that fires here - not the non-terminal
# "stale-active-task-*" detectors, which short-circuit on any terminal
# status and would wrongly report nothing wrong.
if observer_has_finding_prefix "$observer_json" "terminal-task-parked-${SESSION}-${HOK2595_ISSUE}"; then
  report_pass "hok2595: Observer independently flags the closed-but-still-resident task as parked residue (controller/Observer disagreement reproduced)"
else
  report_fail "hok2595: Observer did not flag the retained worktree/pane (expected terminal-task-parked finding); observer output: $observer_json"
fi

echo "  scenario 1 diagnostics: tick1=$tick1_cleanup tick2=$tick2_cleanup remote_deltas=${tick1_remote_delta}/${tick2_remote_delta}"

# ============================================================================
# Scenario 2: HOK-2913_c-style challenger superseded by a merged primary
# ============================================================================
echo ""
echo "=== Scenario 2: incident_hok2913c_challenger_superseded_pane_retained ==="

incident_scenario_new "hok2913c"
incident_scenario_start_tmux
incident_setup_hok2913c_superseded_challenger

# Primary tick: normal merge, should clean up fully on the same tick.
primary_tick1="$(run_monitor_tick "$HOK2913_ISSUE" "$HOK2913_SLUG" "$HOK2913_PR")"
primary_cleanup_merged="$(tick_field "$primary_tick1" cleanup_merged_primary_calls)"
expect_eq "$primary_cleanup_merged" "1" "hok2913 primary tick1: cleanup_merged_primary_challenge_task invoked exactly once"
expect_true "hok2913 primary tick1: primary tmux window closed" \
  assert_pane_closed "$HOK2913_ISSUE" "$HOK2913_SLUG"

# Challenger tick: closed PR, superseded, but challengeRole is missing.
challenger_tick1="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_cleanup1="$(tick_field "$challenger_tick1" cleanup_completed_calls)"
expect_eq "$challenger_cleanup1" "0" "hok2913c tick1: cleanup_completed_task is NOT invoked for the superseded challenger (the leak)"
expect_true "hok2913c tick1: tmux pane remains alive (resource leak reproduced)" \
  assert_pane_alive "$HOK2913C_ISSUE" "$HOK2913C_SLUG"
expect_eq "$(jq -r '.tasks["HOK-2913_c"].phase' "$STATE_FILE")" "review" \
  "hok2913c tick1: workflow-state phase is untouched (neither the reconciler nor cleanup ever ran)"

challenger_tick2="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_cleanup2="$(tick_field "$challenger_tick2" cleanup_completed_calls)"
challenger_remote_delta2="$(tick_field "$challenger_tick2" remote_call_delta)"
expect_eq "$challenger_cleanup2" "0" "hok2913c tick2: still no cleanup attempt"
expect_true "hok2913c tick2: tmux pane STILL alive" \
  assert_pane_alive "$HOK2913C_ISSUE" "$HOK2913C_SLUG"

challenger_restart="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_restart_cleanup="$(tick_field "$challenger_restart" cleanup_completed_calls)"
expect_eq "$challenger_restart_cleanup" "0" "hok2913c restart replay: challenger still leaked after restart"

observer_json_2913="$(run_observer_pass)"
if observer_has_finding_prefix "$observer_json_2913" "stale-active-task-live-process-${SESSION}-${HOK2913C_ISSUE}"; then
  report_pass "hok2913c: Observer independently flags the superseded challenger as unresolved active-task residue"
else
  report_fail "hok2913c: Observer did not flag the superseded challenger; observer output: $observer_json_2913"
fi

echo "  scenario 2 diagnostics: primary_cleanup=$primary_cleanup_merged challenger_cleanup=$challenger_cleanup1/$challenger_cleanup2 remote_delta_tick2=$challenger_remote_delta2"

# ============================================================================
# Scenario 3: Squash-merged PR with a deleted remote head
# ============================================================================
echo ""
echo "=== Scenario 3: incident_squash_delivery_deleted_remote_head ==="

incident_scenario_new "squash"
incident_setup_squash_delivery

squash_tick1="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
squash_rc1="$(tick_field "$squash_tick1" rc)"
squash_iteration1="$(tick_field "$squash_tick1" iteration_ms)"
marker_count_1="$(preservation_marker_count "$SCENARIO_DIR/repo")"

# HOK-2953: the merged PR's headRefOid exactly equals the local head, so the
# structured safe_terminal_pr_head authority must clean the branch up on the
# first tick even though ancestry is false and the remote head is deleted.
expect_eq "$marker_count_1" "0" \
  "squash tick1: no preservation marker is written (exact PR-head proof authorizes cleanup)"
expect_eq "$(jq -r '.tasks["HOK-3000"] != null' "$STATE_FILE")" "false" \
  "squash tick1: task entry is removed (cleanup completed)"
expect_true "squash tick1: worktree directory removed" \
  bash -c "[[ ! -d '$WORKTREE_ROOT/$SQUASH_SLUG' ]]"
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick1: local branch task/$SQUASH_SLUG still exists after PR-head-proven cleanup"
else
  report_pass "squash tick1: local branch task/$SQUASH_SLUG deleted"
fi

# The deletion authority must be durably recorded for operator audit, with
# the exact evidence (classification, PR head OID, final head check) used.
squash_decision="$SCENARIO_DIR/repo/.wavemill/incidents/cleanup-decisions/task__${SQUASH_SLUG}.json"
if [[ -f "$squash_decision" ]]; then
  report_pass "squash tick1: cleanup decision evidence recorded at $squash_decision"
  expect_eq "$(jq -r '.classification // ""' "$squash_decision")" "safe_terminal_pr_head" \
    "squash tick1: decision classification is safe_terminal_pr_head"
  expect_eq "$(jq -r '.prHeadOid // ""' "$squash_decision")" "$SQUASH_LOCAL_HEAD" \
    "squash tick1: decision records the exact PR headRefOid"
  expect_eq "$(jq -r '.localHeadSha // ""' "$squash_decision")" "$SQUASH_LOCAL_HEAD" \
    "squash tick1: decision records the matching local head"
  expect_eq "$(jq -r '.prState // ""' "$squash_decision")" "MERGED" \
    "squash tick1: decision records the terminal PR state"
  expect_eq "$(jq -r '.finalCheckPassed // ""' "$squash_decision")" "true" \
    "squash tick1: decision records the final pre-deletion head check"
else
  report_fail "squash tick1: no cleanup decision evidence at $squash_decision"
fi

# Automatic cleanup must never recreate the deleted remote branch.
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick1: cleanup recreated the deleted remote branch"
else
  report_pass "squash tick1: deleted remote branch was not recreated"
fi

squash_tick2="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
squash_remote_delta2="$(tick_field "$squash_tick2" remote_call_delta)"
squash_iteration2="$(tick_field "$squash_tick2" iteration_ms)"
marker_count_2="$(preservation_marker_count "$SCENARIO_DIR/repo")"

# Restart-replay resource invariants. Driving monitor_issue_state directly
# for an already-reaped issue makes the terminal reconciler upsert a fresh
# (branch/worktree-less) task entry and recreate the feature dir - a harness
# artifact of the forced re-invocation, retained conservatively as
# retain_dirty. What must hold is that no deleted git resource reappears and
# nothing new is deleted: the local branch stays gone, the remote branch is
# never recreated, and the recorded deletion authority survives.
if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick2: local branch was resurrected"
else
  report_pass "squash tick2: local branch stays deleted"
fi
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash tick2: deleted remote branch was recreated on replay"
else
  report_pass "squash tick2: deleted remote branch still not recreated"
fi
if git -C "$REPO_DIR" worktree list 2>/dev/null | grep -q "$SQUASH_SLUG"; then
  report_fail "squash tick2: git-registered worktree reappeared"
else
  report_pass "squash tick2: no git-registered worktree reappears"
fi
expect_true "squash tick2: deletion authority record survives replay" \
  bash -c "[[ -f '$squash_decision' ]]"
# Any replay-tick marker must be a conservative retention, never a record
# that authorized deleting something on unchanged evidence.
if [[ "$marker_count_2" -gt 0 ]]; then
  replay_marker="$SCENARIO_DIR/repo/.wavemill/incidents/preserved-branches/task__${SQUASH_SLUG}.json"
  expect_eq "$(jq -r '.safeToDelete // false' "$replay_marker" 2>/dev/null)" "false" \
    "squash tick2: replay marker is a retention record, not deletion authority"
fi

restart_squash="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
marker_count_restart="$(preservation_marker_count "$SCENARIO_DIR/repo")"
if git -C "$ORIGIN_DIR" show-ref --verify --quiet "refs/heads/task/$SQUASH_SLUG"; then
  report_fail "squash restart replay: deleted remote branch was recreated"
else
  report_pass "squash restart replay: deleted remote branch still not recreated"
fi

timing_multiplier="${WAVEMILL_INCIDENT_FIXTURE_TIMING_TOLERANCE_MULTIPLIER:-1}"
tick1_budget_ms=$((10000 * timing_multiplier))
if [[ "$squash_iteration1" -lt "$tick1_budget_ms" ]]; then
  report_pass "squash tick1 iteration time ${squash_iteration1}ms within ${tick1_budget_ms}ms CI budget"
else
  report_fail "squash tick1 iteration time ${squash_iteration1}ms exceeded ${tick1_budget_ms}ms CI budget"
fi

echo "  scenario 3 diagnostics: rc1=$squash_rc1 markers=${marker_count_1}/${marker_count_2}/${marker_count_restart} iteration_ms=${squash_iteration1}/${squash_iteration2}"

# ============================================================================
# Summary
# ============================================================================
echo ""
if [[ "$FAILURES" -eq 0 ]]; then
  echo "incident-fixtures-terminal-panes: all assertions passed (scenarios 1-2 pre-fix reproductions, scenario 3 squash cleanup fixed by HOK-2953)"
  exit 0
else
  echo "incident-fixtures-terminal-panes: $FAILURES assertion(s) failed" >&2
  exit 1
fi
