#!/usr/bin/env bash
set -euo pipefail

# Tests for controller-owned stage state functions (HOK-1177)
# Tests write_stage_result, read_stage_result, read_stage_status,
# check_stage_complete, check_stage_awaiting_user, check_stage_aborted,
# write_phase_config, read_phase_config

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$SCRIPT_DIR/.."

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1 (expected '$2', got '$3')"; FAIL=$((FAIL + 1)); }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name" "$expected" "$actual"
  fi
}

# Create temp directory for test feature dirs
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

# Stub out dependencies used by the functions under test
WORKTREE_ROOT="$TEST_DIR"
SESSION="test-session"
_CFG_READY_ENABLED="true"

log() { :; }
log_warn() { :; }
agent_resolve_from_model() { echo "claude"; }

# Source only the functions we need — the mill script sources common first
# We need to source common, but it expects certain env vars
export HOME="$TEST_DIR/fakehome"
mkdir -p "$HOME/.wavemill"
echo '{}' > "$HOME/.wavemill/config.json"
mkdir -p "$TEST_DIR/fakerepo"
echo '{}' > "$TEST_DIR/fakerepo/.wavemill-config.json"

# Source common lib (provides base functions)
REPO_DIR="$TEST_DIR/fakerepo" source "$REPO_DIR/../shared/lib/wavemill-common.sh" 2>/dev/null || true

# Now define the functions directly from the mill script by extracting them
# We can't source the whole mill script, so we'll define them inline.

# Re-export REPO_DIR for the test context
REPO_DIR="$SCRIPT_DIR/.."

_stage_legacy_marker() {
  case "$1" in
    planning) echo ".plan-approved" ;;
    coding)   echo ".coding-complete" ;;
    *)        echo "" ;;
  esac
}

write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}"
  local result_file="$feature_dir/.${stage}-result.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$feature_dir"

  local started_at="$now"
  if [[ -f "$result_file" ]]; then
    local prev_start
    prev_start=$(jq -r '.startedAt // empty' "$result_file" 2>/dev/null || echo "")
    [[ -n "$prev_start" ]] && started_at="$prev_start"
  fi

  local finished_at="null"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$now\""
  fi

  local tmp
  tmp=$(mktemp) || return 0
  cat > "$tmp" <<EOF
{
  "stage": "$stage",
  "status": "$status",
  "startedAt": "$started_at",
  "finishedAt": $finished_at,
  "agent": "$agent",
  "model": "$model",
  "notes": "$notes"
}
EOF
  mv "$tmp" "$result_file"
}

read_stage_result() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]] && jq empty "$result_file" 2>/dev/null; then
    cat "$result_file"
  else
    echo ""
  fi
}

read_stage_status() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.status // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

check_stage_complete() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  if [[ -n "$status" ]]; then
    # Stage result exists and is authoritative
    [[ "$status" == "completed" ]] && return 0
    return 1
  fi
  # No stage result — fallback to legacy marker
  local marker
  marker=$(_stage_legacy_marker "$stage")
  if [[ -n "$marker" ]] && [[ -f "$feature_dir/$marker" ]]; then
    return 0
  fi
  return 1
}

check_stage_awaiting_user() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  [[ "$status" == "awaiting_user" ]] && return 0
  return 1
}

# Approve a plan: transition planning from awaiting_user to completed.
approve_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "completed" "$agent" "$model" "Plan approved by user"
  touch "$feature_dir/.plan-approved"
}

# Reject a plan: transition planning from awaiting_user to failed.
reject_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "failed" "$agent" "$model" "Plan rejected by user"
}

check_stage_aborted() {
  local feature_dir="$1"
  local stage result_file
  for stage in planning coding review ready; do
    result_file="$feature_dir/.${stage}-result.json"
    if [[ -f "$result_file" ]]; then
      local status
      status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
      [[ "$status" == "aborted" ]] && return 0
    fi
  done
  [[ -f "$feature_dir/.workflow-aborted" ]] && return 0
  return 1
}

write_phase_config() {
  local feature_dir="$1"
  local planner_model="$2" coder_model="$3" reviewer_model="$4"
  local plan_depth="$5" code_depth="$6" review_mode="$7"
  local force_model="${8:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$feature_dir"
  local tmp
  tmp=$(mktemp) || return 0
  local force_model_json="null"
  [[ -n "$force_model" ]] && force_model_json="\"$force_model\""
  local planner_agent coder_agent reviewer_agent
  planner_agent="$(agent_resolve_from_model "$planner_model")"
  coder_agent="$(agent_resolve_from_model "$coder_model")"
  reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"
  cat > "$tmp" <<EOF
{
  "planning": {
    "model": "$planner_model",
    "agent": "$planner_agent",
    "depth": "$plan_depth"
  },
  "coding": {
    "model": "$coder_model",
    "agent": "$coder_agent",
    "depth": "$code_depth"
  },
  "review": {
    "model": "$reviewer_model",
    "agent": "$reviewer_agent",
    "mode": "$review_mode"
  },
  "ready": {
    "enabled": ${_CFG_READY_ENABLED:-false}
  },
  "resolvedAt": "$now",
  "forceModel": $force_model_json
}
EOF
  mv "$tmp" "$feature_dir/.phase-config.json"
}

read_phase_config() {
  local feature_dir="$1" stage="$2" field="$3"
  local config_file="$feature_dir/.phase-config.json"
  if [[ -f "$config_file" ]]; then
    jq -r --arg s "$stage" --arg f "$field" '.[$s][$f] // empty' "$config_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# ─────────────────────────────────────────────────────────────────
echo "=== Stage Result Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 1: write_stage_result produces valid JSON
FD1="$TEST_DIR/test1"
mkdir -p "$FD1"
write_stage_result "$FD1" "planning" "running" "claude" "opus-4-6"
check "write produces valid JSON" "0" "$(jq empty "$FD1/.planning-result.json" 2>/dev/null; echo $?)"
check "stage field" "planning" "$(jq -r .stage "$FD1/.planning-result.json")"
check "status field" "running" "$(jq -r .status "$FD1/.planning-result.json")"
check "agent field" "claude" "$(jq -r .agent "$FD1/.planning-result.json")"
check "finishedAt is null for running" "null" "$(jq -r .finishedAt "$FD1/.planning-result.json")"

# Test 2: write completed preserves startedAt
ORIG_START=$(jq -r .startedAt "$FD1/.planning-result.json")
sleep 1
write_stage_result "$FD1" "planning" "completed" "claude" "opus-4-6"
check "startedAt preserved" "$ORIG_START" "$(jq -r .startedAt "$FD1/.planning-result.json")"
check "finishedAt set for completed" "false" "$(jq -r '.finishedAt == null' "$FD1/.planning-result.json")"

# Test 3: read_stage_status
check "read status" "completed" "$(read_stage_status "$FD1" "planning")"
check "read missing status" "" "$(read_stage_status "$FD1" "coding")"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== check_stage_complete Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 4: completed result file → true
FD2="$TEST_DIR/test2"
mkdir -p "$FD2"
write_stage_result "$FD2" "planning" "completed"
check_stage_complete "$FD2" "planning" && result=0 || result=1
check "completed result → true" "0" "$result"

# Test 5: running result file → false
FD3="$TEST_DIR/test3"
mkdir -p "$FD3"
write_stage_result "$FD3" "planning" "running"
check_stage_complete "$FD3" "planning" && result=0 || result=1
check "running result → false" "1" "$result"

# Test 6: awaiting_user result → false
FD4="$TEST_DIR/test4"
mkdir -p "$FD4"
write_stage_result "$FD4" "planning" "awaiting_user"
check_stage_complete "$FD4" "planning" && result=0 || result=1
check "awaiting_user result → false" "1" "$result"

# Test 7: legacy marker only → true (fallback)
FD5="$TEST_DIR/test5"
mkdir -p "$FD5"
touch "$FD5/.plan-approved"
check_stage_complete "$FD5" "planning" && result=0 || result=1
check "legacy marker only → true" "0" "$result"

# Test 8: neither present → false
FD6="$TEST_DIR/test6"
mkdir -p "$FD6"
check_stage_complete "$FD6" "planning" && result=0 || result=1
check "neither present → false" "1" "$result"

# Test 9: both present → true (new file takes precedence)
FD7="$TEST_DIR/test7"
mkdir -p "$FD7"
write_stage_result "$FD7" "planning" "completed"
touch "$FD7/.plan-approved"
check_stage_complete "$FD7" "planning" && result=0 || result=1
check "both present → true" "0" "$result"

# Test 10: coding legacy marker
FD8="$TEST_DIR/test8"
mkdir -p "$FD8"
touch "$FD8/.coding-complete"
check_stage_complete "$FD8" "coding" && result=0 || result=1
check "coding legacy marker → true" "0" "$result"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== check_stage_awaiting_user Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 11
check_stage_awaiting_user "$FD4" "planning" && result=0 || result=1
check "awaiting_user → true" "0" "$result"

# Test 12
check_stage_awaiting_user "$FD2" "planning" && result=0 || result=1
check "completed → false for awaiting" "1" "$result"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== check_stage_aborted Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 13: aborted result file
FD9="$TEST_DIR/test9"
mkdir -p "$FD9"
write_stage_result "$FD9" "planning" "aborted"
check_stage_aborted "$FD9" && result=0 || result=1
check "aborted result → true" "0" "$result"

# Test 14: legacy .workflow-aborted marker
FD10="$TEST_DIR/test10"
mkdir -p "$FD10"
touch "$FD10/.workflow-aborted"
check_stage_aborted "$FD10" && result=0 || result=1
check "legacy abort marker → true" "0" "$result"

# Test 15: no abort
FD11="$TEST_DIR/test11"
mkdir -p "$FD11"
write_stage_result "$FD11" "planning" "running"
check_stage_aborted "$FD11" && result=0 || result=1
check "no abort → false" "1" "$result"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Stage Result Precedence Tests (HOK-1193) ==="
# ─────────────────────────────────────────────────────────────────

# Test: awaiting_user result + legacy marker → false (stage result is authoritative)
FD_PREC1="$TEST_DIR/test_prec1"
mkdir -p "$FD_PREC1"
write_stage_result "$FD_PREC1" "planning" "awaiting_user"
touch "$FD_PREC1/.plan-approved"
check_stage_complete "$FD_PREC1" "planning" && result=0 || result=1
check "awaiting_user + .plan-approved → false (stage result authoritative)" "1" "$result"

# Test: running result + legacy marker → false (stage result is authoritative)
FD_PREC2="$TEST_DIR/test_prec2"
mkdir -p "$FD_PREC2"
write_stage_result "$FD_PREC2" "planning" "running"
touch "$FD_PREC2/.plan-approved"
check_stage_complete "$FD_PREC2" "planning" && result=0 || result=1
check "running + .plan-approved → false (stage result authoritative)" "1" "$result"

# Test: failed result + legacy marker → false
FD_PREC3="$TEST_DIR/test_prec3"
mkdir -p "$FD_PREC3"
write_stage_result "$FD_PREC3" "planning" "failed"
touch "$FD_PREC3/.plan-approved"
check_stage_complete "$FD_PREC3" "planning" && result=0 || result=1
check "failed + .plan-approved → false (stage result authoritative)" "1" "$result"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== approve_plan / reject_plan Tests (HOK-1193) ==="
# ─────────────────────────────────────────────────────────────────

# Test: approve_plan transitions to completed and creates legacy marker
FD_APR1="$TEST_DIR/test_apr1"
mkdir -p "$FD_APR1"
write_stage_result "$FD_APR1" "planning" "awaiting_user" "claude" "opus-4-6"
approve_plan "$FD_APR1" "claude" "opus-4-6"
check "approve: status is completed" "completed" "$(read_stage_status "$FD_APR1" "planning")"
check "approve: .plan-approved exists" "0" "$([[ -f "$FD_APR1/.plan-approved" ]]; echo $?)"
check "approve: notes mention user" "Plan approved by user" "$(jq -r .notes "$FD_APR1/.planning-result.json")"
check_stage_complete "$FD_APR1" "planning" && result=0 || result=1
check "approve: check_stage_complete → true" "0" "$result"

# Test: reject_plan transitions to failed
FD_APR2="$TEST_DIR/test_apr2"
mkdir -p "$FD_APR2"
write_stage_result "$FD_APR2" "planning" "awaiting_user" "claude" "opus-4-6"
reject_plan "$FD_APR2" "claude" "opus-4-6"
check "reject: status is failed" "failed" "$(read_stage_status "$FD_APR2" "planning")"
check "reject: notes mention user" "Plan rejected by user" "$(jq -r .notes "$FD_APR2/.planning-result.json")"
check_stage_complete "$FD_APR2" "planning" && result=0 || result=1
check "reject: check_stage_complete → false" "1" "$result"
check "reject: no .plan-approved" "1" "$([[ -f "$FD_APR2/.plan-approved" ]]; echo $?)"

# Test: approve_plan preserves startedAt from awaiting_user
FD_APR3="$TEST_DIR/test_apr3"
mkdir -p "$FD_APR3"
write_stage_result "$FD_APR3" "planning" "awaiting_user" "claude" "opus-4-6"
ORIG_START_APR=$(jq -r .startedAt "$FD_APR3/.planning-result.json")
sleep 1
approve_plan "$FD_APR3" "claude" "opus-4-6"
check "approve preserves startedAt" "$ORIG_START_APR" "$(jq -r .startedAt "$FD_APR3/.planning-result.json")"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Phase Config Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 16: write and read phase config
FD12="$TEST_DIR/test12"
mkdir -p "$FD12"
write_phase_config "$FD12" "claude-opus-4-6" "claude-sonnet-4-5" "claude-haiku-4-5" "deep" "medium" "static"
check "phase config valid JSON" "0" "$(jq empty "$FD12/.phase-config.json" 2>/dev/null; echo $?)"
check "read planning model" "claude-opus-4-6" "$(read_phase_config "$FD12" "planning" "model")"
check "read coding depth" "medium" "$(read_phase_config "$FD12" "coding" "depth")"
check "read review mode" "static" "$(read_phase_config "$FD12" "review" "mode")"
check "read ready enabled" "true" "$(jq -r '.ready.enabled' "$FD12/.phase-config.json")"
check "forceModel null" "null" "$(jq -r '.forceModel' "$FD12/.phase-config.json")"

# Test 17: with force model
FD13="$TEST_DIR/test13"
mkdir -p "$FD13"
write_phase_config "$FD13" "forced" "forced" "forced" "light" "light" "static" "forced"
check "forceModel set" "forced" "$(jq -r '.forceModel' "$FD13/.phase-config.json")"

# Test 18: missing config file
check "read missing config" "" "$(read_phase_config "$TEST_DIR/nonexistent" "planning" "model")"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo "  $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
