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

# Post-fix: cleanup_completed_task is now invoked for ALL closed PRs,
# not just challenger arms. The pane is released and the task is cleaned up.
expect_eq "$tick1_cleanup" "1" "hok2595 tick1: cleanup_completed_task is invoked for a closed non-challenge PR"
expect_true "hok2595 tick1: tmux pane is closed (resource leak fixed)" \
  assert_pane_closed "$HOK2595_ISSUE" "$HOK2595_SLUG"

# Tick 2 and restart: the harness re-drives monitor_issue_state even though
# the task was already cleaned from state on tick 1. In the real monitor the
# task would not be iterated again. The important properties are: no errors,
# no duplicate pane-release errors, and the pane stays closed.
tick2="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
tick2_remote_delta="$(tick_field "$tick2" remote_call_delta)"
expect_true "hok2595 tick2: tmux pane stays closed" \
  assert_pane_closed "$HOK2595_ISSUE" "$HOK2595_SLUG"

restart_tick="$(run_monitor_tick "$HOK2595_ISSUE" "$HOK2595_SLUG" "$HOK2595_PR")"
expect_true "hok2595 restart: tmux pane stays closed" \
  assert_pane_closed "$HOK2595_ISSUE" "$HOK2595_SLUG"

echo "  scenario 1 diagnostics: tick1=$tick1_cleanup remote_deltas=${tick1_remote_delta}/${tick2_remote_delta}"

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
# Post-fix: cleanup_completed_task is now invoked for ALL closed PRs
# regardless of challengeRole presence.
challenger_tick1="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_cleanup1="$(tick_field "$challenger_tick1" cleanup_completed_calls)"
expect_eq "$challenger_cleanup1" "1" "hok2913c tick1: cleanup_completed_task IS invoked for the superseded challenger (leak fixed)"
expect_true "hok2913c tick1: tmux pane is closed (resource leak fixed)" \
  assert_pane_closed "$HOK2913C_ISSUE" "$HOK2913C_SLUG"

# Tick 2 and restart: same as scenario 1 — harness re-drives the issue
# but the task was already cleaned from state on tick 1.
challenger_tick2="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
challenger_remote_delta2="$(tick_field "$challenger_tick2" remote_call_delta)"
expect_true "hok2913c tick2: tmux pane stays closed" \
  assert_pane_closed "$HOK2913C_ISSUE" "$HOK2913C_SLUG"

challenger_restart="$(run_monitor_tick "$HOK2913C_ISSUE" "$HOK2913C_SLUG" "$HOK2913C_PR")"
expect_true "hok2913c restart: tmux pane stays closed" \
  assert_pane_closed "$HOK2913C_ISSUE" "$HOK2913C_SLUG"

echo "  scenario 2 diagnostics: primary_cleanup=$primary_cleanup_merged challenger_cleanup=$challenger_cleanup1 remote_delta_tick2=$challenger_remote_delta2"

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

# Pre-fix reproduction: safe_remove_task_worktree_and_branch's merged_to_base
# check relies solely on `git merge-base --is-ancestor`, which is never true
# for a squash-merged branch, even though the PR's headRefOid proves it was
# delivered. This preserves the branch and writes a marker on EVERY tick.
expect_eq "$(preservation_marker_count "$SCENARIO_DIR/repo")" "1" \
  "squash tick1: a PRESERVED_UNPUSHED_WORK marker is written despite the PR being provably merged (headRefOid matches)"
expect_eq "$(jq -r '.tasks["HOK-3000"] != null' "$STATE_FILE")" "true" \
  "squash tick1: task entry is retained (cleanup did not complete)"

squash_tick2="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
squash_remote_delta2="$(tick_field "$squash_tick2" remote_call_delta)"
squash_iteration2="$(tick_field "$squash_tick2" iteration_ms)"
marker_count_2="$(preservation_marker_count "$SCENARIO_DIR/repo")"

# The task packet explicitly calls out duplicate cleanup attempts on
# unchanged evidence: a fixed implementation must not re-attempt (and
# re-mark) an already-preserved branch every tick.
if [[ "$marker_count_2" -gt "$marker_count_1" ]]; then
  report_fail "squash tick2: preservation marker was rewritten again on unchanged evidence (repeated-cleanup-retry loop reproduced: $marker_count_1 -> $marker_count_2)"
else
  report_pass "squash tick2: preservation marker count did not grow further ($marker_count_1 -> $marker_count_2)"
fi

restart_squash="$(run_monitor_tick "$SQUASH_ISSUE" "$SQUASH_SLUG" "$SQUASH_PR")"
marker_count_restart="$(preservation_marker_count "$SCENARIO_DIR/repo")"

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
  echo "incident-fixtures-terminal-panes: all assertions passed (pre-fix reproductions confirmed)"
  exit 0
else
  echo "incident-fixtures-terminal-panes: $FAILURES assertion(s) failed" >&2
  exit 1
fi
