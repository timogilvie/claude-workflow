#!/usr/bin/env bash
set -euo pipefail

# Characterization tests for the canonical save_task_state in wavemill-common.sh.
#
# Covers:
#   - Status default ("active" when empty or omitted, explicit status preserved)
#   - Partial updates preserve all unspecified existing fields
#   - Challenge intent/execution, varied model/agent, comparison/eval state survive thin writes
#   - Trace ID resolved from features/<slug> and bugs/<slug> context files
#   - Malformed/missing trace context falls back silently to previous traceId
#   - Phase and windowId preserved or updated via positions 20/21
#   - challengeStage passed at position 19

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

extract_function_occurrence() {
  local source_file="$1"
  local function_name="$2"
  local occurrence="$3"
  awk -v name="$function_name" -v target="$occurrence" '
    $0 ~ "^" name "\\(\\) \\{" {
      count++
      if (count == target) { capture=1 }
    }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

echo "=== save_task_state canonical characterization ==="

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Extract the canonical save_task_state from wavemill-common.sh.
FUNCTION_FILE="$TEST_TMP/save-task-state.sh"
extract_function_occurrence "$COMMON_SCRIPT_FILE" "save_task_state" 1 > "$FUNCTION_FILE"
if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract save_task_state() from wavemill-common.sh"
  exit 1
fi

source "$REPO_DIR/shared/lib/wavemill-common.sh"
log_warn() { :; }

# ── helpers ──────────────────────────────────────────────────────────────────

new_state() {
  local dir="$1"
  mkdir -p "$dir"
  printf '{"tasks":{}}\n' > "$dir/state.json"
  echo "$dir/state.json"
}

jq_get() {
  local state_file="$1" query="$2"
  jq -r "$query" "$state_file" 2>/dev/null
}

# ── 1. Status default ─────────────────────────────────────────────────────────

echo ""
echo "-- Status default --"

T="$TEST_TMP/status-default"
SF="$(new_state "$T")"
STATE_FILE="$SF"
save_task_state "HOK-1" "hok-1" "task/hok-1" "/tmp/hok-1" "" "" "claude"
check_eq "empty status defaults to active" \
  "active" "$(jq_get "$SF" '.tasks["HOK-1"].status')"

T2="$TEST_TMP/status-explicit"
SF2="$(new_state "$T2")"
STATE_FILE="$SF2"
save_task_state "HOK-2" "hok-2" "task/hok-2" "/tmp/hok-2" "" "merged" "claude"
check_eq "explicit status preserved unchanged" \
  "merged" "$(jq_get "$SF2" '.tasks["HOK-2"].status')"

T3="$TEST_TMP/status-error"
SF3="$(new_state "$T3")"
STATE_FILE="$SF3"
save_task_state "HOK-3" "hok-3" "task/hok-3" "/tmp/hok-3" "" "error" "claude"
check_eq "explicit error status preserved" \
  "error" "$(jq_get "$SF3" '.tasks["HOK-3"].status')"

# ── 2. challengeRole required for challenge tasks ─────────────────────────────

echo ""
echo "-- challengeRole validation --"

T4="$TEST_TMP/role-validation"
SF4="$(new_state "$T4")"
STATE_FILE="$SF4"
if save_task_state "HOK-4" "hok-4" "task/hok-4" "/tmp/hok-4" "" "active" "claude" "HOK-4" "true" "HOK-4" "" "gpt-5" 2>/dev/null; then
  fail "blank challengeRole for challenge=true should fail"
else
  pass "blank challengeRole for challenge=true is rejected"
fi

# ── 3. Partial updates preserve rich existing fields ──────────────────────────

echo ""
echo "-- Partial updates preserve existing fields --"

T5="$TEST_TMP/preserve-fields"
SF5="$(new_state "$T5")"
# Seed a rich task object
printf '%s\n' '{
  "tasks": {
    "HOK-5": {
      "slug": "hok-5",
      "branch": "task/hok-5",
      "worktree": "/tmp/hok-5",
      "pr": "100",
      "status": "review",
      "agent": "codex",
      "challenge": true,
      "challengePairId": "HOK-5",
      "challengeRole": "primary",
      "challengeModel": "gpt-5",
      "challengeStage": "implementation",
      "challengeIntent": {"pairId": "HOK-5", "challenger": {"expectedRoute": {"coder": "qwen-3"}}},
      "challengeExecutionIntent": {"variation": "coding"},
      "challengeVariedModel": "kimi-k2",
      "challengeVariedAgent": "native-openrouter",
      "plannerModel": "gpt-5-planner",
      "coderModel": "gpt-5",
      "reviewerModel": "gpt-5-reviewer",
      "planDepth": "medium",
      "codeDepth": "deep",
      "reviewMode": "llm",
      "traceId": "trace-abc-123",
      "phase": "executing",
      "windowId": "win-42",
      "evalCompleted": true,
      "evalFailed": false,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "evalRunning": {"side": "primary"},
      "comparisonRunning": {"job": "cmp-1"},
      "comparisonState": "pending",
      "comparisonBlockedReason": "waiting",
      "comparisonRetryCount": 1,
      "comparisonRetryMaxAttempts": 3,
      "comparisonRetryTargetIssue": "HOK-5_c",
      "comparisonTimedOutSides": ["primary"],
      "manualComparisonArtifact": "artifact-url",
      "launchFailure": null,
      "linearIssueId": "LIN-99",
      "updated": "2026-01-01T00:00:00Z"
    }
  }
}' > "$SF5"

STATE_FILE="$SF5"
# Thin write: only update pr and status
save_task_state "HOK-5" "hok-5" "task/hok-5" "/tmp/hok-5" "101" "merged" "codex"

check_eq "challengeIntent preserved on thin write" \
  "qwen-3" "$(jq_get "$SF5" '.tasks["HOK-5"].challengeIntent.challenger.expectedRoute.coder')"
check_eq "challengeExecutionIntent preserved on thin write" \
  "coding" "$(jq_get "$SF5" '.tasks["HOK-5"].challengeExecutionIntent.variation')"
check_eq "challengeVariedModel preserved on thin write" \
  "kimi-k2" "$(jq_get "$SF5" '.tasks["HOK-5"].challengeVariedModel')"
check_eq "challengeVariedAgent preserved on thin write" \
  "native-openrouter" "$(jq_get "$SF5" '.tasks["HOK-5"].challengeVariedAgent')"
check_eq "evalCompleted preserved on thin write" \
  "true" "$(jq_get "$SF5" '.tasks["HOK-5"].evalCompleted')"
check_eq "evalHardFailureRetryCount preserved on thin write" \
  "2" "$(jq_get "$SF5" '.tasks["HOK-5"].evalHardFailureRetryCount')"
check_eq "evalRunning preserved on thin write" \
  "primary" "$(jq_get "$SF5" '.tasks["HOK-5"].evalRunning.side')"
check_eq "comparisonState preserved on thin write" \
  "pending" "$(jq_get "$SF5" '.tasks["HOK-5"].comparisonState')"
check_eq "comparisonRetryCount preserved on thin write" \
  "1" "$(jq_get "$SF5" '.tasks["HOK-5"].comparisonRetryCount')"
check_eq "comparisonTimedOutSides preserved on thin write" \
  '["primary"]' "$(jq_get "$SF5" '.tasks["HOK-5"].comparisonTimedOutSides | tojson')"
check_eq "manualComparisonArtifact preserved on thin write" \
  "artifact-url" "$(jq_get "$SF5" '.tasks["HOK-5"].manualComparisonArtifact')"
check_eq "traceId preserved when no trace file" \
  "trace-abc-123" "$(jq_get "$SF5" '.tasks["HOK-5"].traceId')"
check_eq "phase preserved when not passed" \
  "executing" "$(jq_get "$SF5" '.tasks["HOK-5"].phase')"
check_eq "windowId preserved when not passed" \
  "win-42" "$(jq_get "$SF5" '.tasks["HOK-5"].windowId')"
check_eq "linearIssueId defaults to issue key when not passed" \
  "HOK-5" "$(jq_get "$SF5" '.tasks["HOK-5"].linearIssueId')"
check_eq "pr updated by thin write" \
  "101" "$(jq_get "$SF5" '.tasks["HOK-5"].pr')"
check_eq "status updated to merged" \
  "merged" "$(jq_get "$SF5" '.tasks["HOK-5"].status')"

# ── 4. Trace ID resolution ────────────────────────────────────────────────────

echo ""
echo "-- Trace ID resolution --"

# Feature trace
T6="$TEST_TMP/trace-feature"
SF6="$(new_state "$T6")"
mkdir -p "$T6/wt/features/hok-6"
printf '{"traceId":"feat-trace-xyz"}\n' > "$T6/wt/features/hok-6/.trace-context.json"
STATE_FILE="$SF6"
save_task_state "HOK-6" "hok-6" "task/hok-6" "$T6/wt" "" "" "claude"
check_eq "traceId resolved from features/ context" \
  "feat-trace-xyz" "$(jq_get "$SF6" '.tasks["HOK-6"].traceId')"

# Bug trace
T7="$TEST_TMP/trace-bug"
SF7="$(new_state "$T7")"
mkdir -p "$T7/wt/bugs/hok-7"
printf '{"traceId":"bug-trace-abc"}\n' > "$T7/wt/bugs/hok-7/.trace-context.json"
STATE_FILE="$SF7"
save_task_state "HOK-7" "hok-7" "task/hok-7" "$T7/wt" "" "" "claude"
check_eq "traceId resolved from bugs/ context" \
  "bug-trace-abc" "$(jq_get "$SF7" '.tasks["HOK-7"].traceId')"

# Malformed trace context
T8="$TEST_TMP/trace-malformed"
SF8="$(new_state "$T8")"
printf '%s\n' '{"tasks":{"HOK-8":{"slug":"hok-8","branch":"task/hok-8","worktree":"/tmp/hok-8","traceId":"prev-trace","status":"active"}}}' > "$SF8"
mkdir -p "$T8/wt/features/hok-8"
printf 'not valid json\n' > "$T8/wt/features/hok-8/.trace-context.json"
STATE_FILE="$SF8"
save_task_state "HOK-8" "hok-8" "task/hok-8" "$T8/wt" "" "" "claude"
check_eq "malformed trace context retains previous traceId" \
  "prev-trace" "$(jq_get "$SF8" '.tasks["HOK-8"].traceId')"

# Missing trace context
T9="$TEST_TMP/trace-missing"
SF9="$(new_state "$T9")"
printf '%s\n' '{"tasks":{"HOK-9":{"slug":"hok-9","branch":"task/hok-9","worktree":"/tmp/hok-9","traceId":"kept-trace","status":"active"}}}' > "$SF9"
STATE_FILE="$SF9"
save_task_state "HOK-9" "hok-9" "task/hok-9" "/tmp/hok-9" "" "" "claude"
check_eq "missing trace context retains previous traceId" \
  "kept-trace" "$(jq_get "$SF9" '.tasks["HOK-9"].traceId')"

# ── 5. Phase and windowId (positions 20, 21) ──────────────────────────────────

echo ""
echo "-- Phase and windowId --"

T10="$TEST_TMP/phase-window"
SF10="$(new_state "$T10")"
STATE_FILE="$SF10"
save_task_state "HOK-10" "hok-10" "task/hok-10" "/tmp/hok-10" "" "" "claude" "HOK-10" "" "" "" "" "" "" "" "" "" "" "" "planning" "win-99"
check_eq "phase set at position 20" \
  "planning" "$(jq_get "$SF10" '.tasks["HOK-10"].phase')"
check_eq "windowId set at position 21" \
  "win-99" "$(jq_get "$SF10" '.tasks["HOK-10"].windowId')"

# ── 6. challengeStage (position 19) ──────────────────────────────────────────

echo ""
echo "-- challengeStage (position 19) --"

T11="$TEST_TMP/challenge-stage"
SF11="$(new_state "$T11")"
STATE_FILE="$SF11"
save_task_state "HOK-11" "hok-11" "task/hok-11" "/tmp/hok-11" "" "active" "claude" "HOK-11" "true" "HOK-11" "primary" "gpt-5" "gpt-5" "gpt-5" "gpt-5" "medium" "medium" "llm" "review"
check_eq "challengeStage set at position 19" \
  "review" "$(jq_get "$SF11" '.tasks["HOK-11"].challengeStage')"

# ── summary ───────────────────────────────────────────────────────────────────

echo ""
echo "save-task-state: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
