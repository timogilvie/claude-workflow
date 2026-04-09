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

resolve_phase() {
  local feature_dir="$1"

  if [[ ! -d "$feature_dir" ]]; then
    echo "unknown"
    return 0
  fi

  # 1. Check for abort first (any stage or legacy marker)
  if check_stage_aborted "$feature_dir"; then
    _persist_phase "$feature_dir" "aborted"
    echo "aborted"
    return 0
  fi

  # 2. Check stages in reverse order (highest stage wins)
  # Ready
  local ready_status
  ready_status=$(read_stage_status "$feature_dir" "ready")
  if [[ "$ready_status" == "completed" ]]; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  # Review
  if check_stage_complete "$feature_dir" "review"; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  local review_status
  review_status=$(read_stage_status "$feature_dir" "review")
  if [[ -n "$review_status" ]]; then
    # Review stage exists (running/failed/etc) — we're in review
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  # Coding
  if check_stage_complete "$feature_dir" "coding"; then
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  local coding_status
  coding_status=$(read_stage_status "$feature_dir" "coding")
  if [[ -n "$coding_status" ]]; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  # Planning
  if check_stage_awaiting_user "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "awaiting_user"
    echo "awaiting_user"
    return 0
  fi

  if check_stage_complete "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  local planning_status
  planning_status=$(read_stage_status "$feature_dir" "planning")
  if [[ -n "$planning_status" ]]; then
    _persist_phase "$feature_dir" "planning"
    echo "planning"
    return 0
  fi

  # 3. Legacy-only fallback (no stage result files exist)
  if [[ -f "$feature_dir/.coding-complete" ]]; then
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  if [[ -f "$feature_dir/.plan-approved" ]]; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  # 4. Default
  _persist_phase "$feature_dir" "planning"
  echo "planning"
  return 0
}

_persist_phase() {
  local feature_dir="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || return 0
  printf '%s\n' "$phase" > "$tmp"
  mv "$tmp" "$feature_dir/.resolved-phase"
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
echo "=== resolve_phase Tests ==="
# ─────────────────────────────────────────────────────────────────

# Test 19: Empty dir → planning
FD19="$TEST_DIR/test19"
mkdir -p "$FD19"
check "empty dir → planning" "planning" "$(resolve_phase "$FD19")"
check "persisted phase matches" "planning" "$(cat "$FD19/.resolved-phase")"

# Test 20: Non-existent dir → unknown
check "non-existent dir → unknown" "unknown" "$(resolve_phase "$TEST_DIR/nonexistent-dir")"

# Test 21: Planning running
FD21="$TEST_DIR/test21"
mkdir -p "$FD21"
write_stage_result "$FD21" "planning" "running" "claude" "opus"
check "planning running → planning" "planning" "$(resolve_phase "$FD21")"

# Test 22: Planning awaiting_user
FD22="$TEST_DIR/test22"
mkdir -p "$FD22"
write_stage_result "$FD22" "planning" "awaiting_user" "claude" "opus"
check "planning awaiting_user → awaiting_user" "awaiting_user" "$(resolve_phase "$FD22")"

# Test 23: Planning completed
FD23="$TEST_DIR/test23"
mkdir -p "$FD23"
write_stage_result "$FD23" "planning" "completed" "claude" "opus"
check "planning completed → coding" "coding" "$(resolve_phase "$FD23")"

# Test 24: Coding running
FD24="$TEST_DIR/test24"
mkdir -p "$FD24"
write_stage_result "$FD24" "planning" "completed" "claude" "opus"
write_stage_result "$FD24" "coding" "running" "claude" "opus"
check "coding running → coding" "coding" "$(resolve_phase "$FD24")"

# Test 25: Coding completed
FD25="$TEST_DIR/test25"
mkdir -p "$FD25"
write_stage_result "$FD25" "planning" "completed" "claude" "opus"
write_stage_result "$FD25" "coding" "completed" "claude" "opus"
check "coding completed → review" "review" "$(resolve_phase "$FD25")"

# Test 26: Review running
FD26="$TEST_DIR/test26"
mkdir -p "$FD26"
write_stage_result "$FD26" "planning" "completed" "claude" "opus"
write_stage_result "$FD26" "coding" "completed" "claude" "opus"
write_stage_result "$FD26" "review" "running" "claude" "opus"
check "review running → review" "review" "$(resolve_phase "$FD26")"

# Test 27: Review completed
FD27="$TEST_DIR/test27"
mkdir -p "$FD27"
write_stage_result "$FD27" "planning" "completed" "claude" "opus"
write_stage_result "$FD27" "coding" "completed" "claude" "opus"
write_stage_result "$FD27" "review" "completed" "claude" "opus"
check "review completed → ready" "ready" "$(resolve_phase "$FD27")"

# Test 28: Ready completed
FD28="$TEST_DIR/test28"
mkdir -p "$FD28"
write_stage_result "$FD28" "planning" "completed" "claude" "opus"
write_stage_result "$FD28" "coding" "completed" "claude" "opus"
write_stage_result "$FD28" "review" "completed" "claude" "opus"
write_stage_result "$FD28" "ready" "completed" "claude" "opus"
check "ready completed → ready" "ready" "$(resolve_phase "$FD28")"

# Test 29: Aborted (stage result)
FD29="$TEST_DIR/test29"
mkdir -p "$FD29"
write_stage_result "$FD29" "planning" "aborted" "claude" "opus"
check "aborted via stage result → aborted" "aborted" "$(resolve_phase "$FD29")"

# Test 30: Aborted (legacy marker)
FD30="$TEST_DIR/test30"
mkdir -p "$FD30"
touch "$FD30/.workflow-aborted"
check "aborted via legacy marker → aborted" "aborted" "$(resolve_phase "$FD30")"

# Test 31: Legacy .plan-approved only
FD31="$TEST_DIR/test31"
mkdir -p "$FD31"
touch "$FD31/.plan-approved"
check "legacy .plan-approved only → coding" "coding" "$(resolve_phase "$FD31")"

# Test 32: Legacy .coding-complete only
FD32="$TEST_DIR/test32"
mkdir -p "$FD32"
touch "$FD32/.coding-complete"
check "legacy .coding-complete only → review" "review" "$(resolve_phase "$FD32")"

# Test 33: Legacy both markers
FD33="$TEST_DIR/test33"
mkdir -p "$FD33"
touch "$FD33/.plan-approved"
touch "$FD33/.coding-complete"
check "legacy both markers → review" "review" "$(resolve_phase "$FD33")"

# Test 34: Mixed - stage result + legacy marker (stage wins)
FD34="$TEST_DIR/test34"
mkdir -p "$FD34"
write_stage_result "$FD34" "planning" "awaiting_user" "claude" "opus"
touch "$FD34/.plan-approved"
check "mixed: stage awaiting_user + legacy marker → awaiting_user" "awaiting_user" "$(resolve_phase "$FD34")"

# Test 35: Mixed - planning result completed + coding legacy
FD35="$TEST_DIR/test35"
mkdir -p "$FD35"
write_stage_result "$FD35" "planning" "completed" "claude" "opus"
touch "$FD35/.coding-complete"
check "mixed: planning completed + legacy coding marker → review" "review" "$(resolve_phase "$FD35")"

# Test 36: Malformed JSON (falls through to legacy/default)
FD36="$TEST_DIR/test36"
mkdir -p "$FD36"
echo "not json" > "$FD36/.planning-result.json"
touch "$FD36/.plan-approved"
check "malformed JSON falls back to legacy → coding" "coding" "$(resolve_phase "$FD36")"

# Test 37: Malformed JSON without legacy fallback
FD37="$TEST_DIR/test37"
mkdir -p "$FD37"
echo "not json" > "$FD37/.planning-result.json"
check "malformed JSON without legacy → planning" "planning" "$(resolve_phase "$FD37")"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Coding Stage Transition Tests (HOK-1194) ==="

# Test 38: Coding running + .coding-complete (before monitor transition)
# Phase should still be "coding" because monitor hasn't written "completed" yet
FD38="$TEST_DIR/test38"
mkdir -p "$FD38"
cat > "$FD38/.coding-result.json" <<'EOF'
{
  "stage": "coding",
  "status": "running",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-04-09T10:00:00Z"
}
EOF
touch "$FD38/.coding-complete"
check "coding running + .coding-complete → coding" "coding" "$(resolve_phase "$FD38")"
check "read_stage_status detects running" "running" "$(read_stage_status "$FD38" "coding")"

# Test 39: Coding completed (after monitor transition)
FD39="$TEST_DIR/test39"
mkdir -p "$FD39"
cat > "$FD39/.coding-result.json" <<'EOF'
{
  "stage": "coding",
  "status": "completed",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-04-09T10:05:00Z"
}
EOF
check "coding completed → review" "review" "$(resolve_phase "$FD39")"
check "check_stage_complete detects completion" "0" "$([[ $(check_stage_complete "$FD39" "coding"; echo $?) -eq 0 ]] && echo 0 || echo 1)"

# Test 40: Legacy .coding-complete still works (no stage result)
FD40="$TEST_DIR/test40"
mkdir -p "$FD40"
touch "$FD40/.coding-complete"
check "legacy .coding-complete only → review" "review" "$(resolve_phase "$FD40")"

# Test 41: Coding running without .coding-complete
FD41="$TEST_DIR/test41"
mkdir -p "$FD41"
cat > "$FD41/.coding-result.json" <<'EOF'
{
  "stage": "coding",
  "status": "running",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-04-09T10:00:00Z"
}
EOF
check "coding running without marker → coding" "coding" "$(resolve_phase "$FD41")"

# Test 42: Legacy marker works even when stage result is running (migration compat)
# Monitor will detect .coding-complete and transition running→completed
FD42="$TEST_DIR/test42"
mkdir -p "$FD42"
cat > "$FD42/.coding-result.json" <<'EOF'
{
  "stage": "coding",
  "status": "running",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-04-09T10:00:00Z"
}
EOF
touch "$FD42/.coding-complete"
# Before monitor transition: still shows as coding (status is "running")
check "running + legacy marker (pre-transition) → coding" "coding" "$(resolve_phase "$FD42")"
# Simulate monitor transition
write_stage_result "$FD42" "coding" "completed" "claude" "claude-opus-4-6"
check "running + legacy marker (post-transition) → review" "review" "$(resolve_phase "$FD42")"

# Test 43: Coding failed status
FD43="$TEST_DIR/test43"
mkdir -p "$FD43"
cat > "$FD43/.coding-result.json" <<'EOF'
{
  "stage": "coding",
  "status": "failed",
  "agent": "claude",
  "model": "claude-opus-4-6",
  "timestamp": "2026-04-09T10:00:00Z",
  "notes": "Agent crashed"
}
EOF
check "coding failed → coding" "coding" "$(resolve_phase "$FD43")"
check "failed status is not complete" "1" "$([[ $(check_stage_complete "$FD43" "coding"; echo $?) -eq 0 ]] && echo 0 || echo 1)"

# ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
echo "  $PASS passed, $FAIL failed"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
