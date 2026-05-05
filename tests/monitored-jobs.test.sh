#!/usr/bin/env bash
# Unit tests for shared/lib/monitored-job.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MJ_SCRIPT="$REPO_DIR/shared/lib/monitored-job.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

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

# ── Harness setup ────────────────────────────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

export REPO_DIR="$TEST_TMP/repo"
mkdir -p "$REPO_DIR"

# Stub log / log_warn so we don't need the full mill environment
log()      { :; }
log_warn() { echo "WARN: $*" >&2; }

# Stub state_mutate: atomic jq write
state_mutate() {
  local sf="$1" filter="$2"; shift 2
  local tmp
  tmp=$(mktemp)
  jq "$@" "$filter" < "$sf" > "$tmp" && mv "$tmp" "$sf"
}

# Source the module under test
# shellcheck source=../shared/lib/monitored-job.sh
source "$MJ_SCRIPT"

echo "=== Monitored Job Unit Tests ==="

# ── Test: _mj_init creates state file ────────────────────────────────────────
test_init_creates_state_file() {
  local dir="$TEST_TMP/t1"
  export REPO_DIR="$dir"
  mkdir -p "$dir"

  _mj_init
  local sf; sf=$(_mj_state_file)
  if [[ -f "$sf" ]]; then
    local content; content=$(jq -r '.jobs | type' "$sf")
    check_eq "init: jobs key is object" "object" "$content"
  else
    fail "init: state file not created"
  fi
}

# ── Test: mj_status unknown for missing job ───────────────────────────────────
test_status_unknown_for_missing() {
  local dir="$TEST_TMP/t2"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  check_eq "status: unknown for missing job" "unknown" "$(mj_status "no-such-job")"
}

# ── Test: mj_launch creates running record ────────────────────────────────────
test_launch_creates_running_record() {
  local dir="$TEST_TMP/t3"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  mj_launch "challenge_eval" "test_eval:HOK-1:primary" 420 "" -- sleep 60 &
  local child=$!
  sleep 0.2  # allow record to be written

  local status; status=$(mj_status "test_eval:HOK-1:primary")
  check_eq "launch: status is running" "running" "$status"

  kill "$child" 2>/dev/null || true
  wait "$child" 2>/dev/null || true
}

# ── Test: poll transitions succeeded when exit sentinel is 0 ─────────────────
test_poll_transitions_succeeded() {
  local dir="$TEST_TMP/t4"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  # Launch a job that exits 0 quickly
  mj_launch "challenge_eval" "eval:quick:primary" 420 "" -- bash -c 'sleep 0.1; exit 0'
  sleep 0.5  # wait for child + sentinel

  poll_monitored_jobs

  check_eq "poll: quick job succeeded" "succeeded" "$(mj_status "eval:quick:primary")"
}

# ── Test: poll transitions failed when exit code is non-zero ─────────────────
test_poll_transitions_failed() {
  local dir="$TEST_TMP/t5"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  mj_launch "challenge_eval" "eval:fail:primary" 420 "" -- bash -c 'sleep 0.2; exit 3'
  sleep 1.0

  poll_monitored_jobs

  check_eq "poll: failed job status" "failed" "$(mj_status "eval:fail:primary")"
  local code; code=$(mj_get "eval:fail:primary" | jq -r '.exit_code')
  check_eq "poll: failed job exit_code" "3" "$code"
}

# ── Test: poll transitions timed_out ─────────────────────────────────────────
test_poll_transitions_timed_out() {
  local dir="$TEST_TMP/t6"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  # Launch with 1s timeout; job sleeps 60s
  mj_launch "challenge_eval" "eval:timeout:primary" 1 "" -- sleep 60
  sleep 0.2  # let child start

  # Manually back-date started_at so elapsed > timeout
  local sf; sf=$(_mj_state_file)
  state_mutate "$sf" \
    '.jobs["eval:timeout:primary"].started_at = $ts' \
    --arg ts "2000-01-01T00:00:00Z"

  poll_monitored_jobs

  check_eq "poll: timed_out status" "timed_out" "$(mj_status "eval:timeout:primary")"
}

# ── Test: mj_launch is idempotent for running job ────────────────────────────
test_launch_idempotent() {
  local dir="$TEST_TMP/t7"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  mj_launch "challenge_eval" "eval:idem:primary" 420 "" -- sleep 30
  sleep 0.2
  local pid1; pid1=$(mj_get "eval:idem:primary" | jq -r '.pid')

  # Second launch should be a no-op
  mj_launch "challenge_eval" "eval:idem:primary" 420 "" -- sleep 30
  local pid2; pid2=$(mj_get "eval:idem:primary" | jq -r '.pid')

  check_eq "launch: idempotent pid unchanged" "$pid1" "$pid2"

  # Cleanup
  kill "$pid1" 2>/dev/null || true
}

# ── Test: mj_is_terminal ─────────────────────────────────────────────────────
test_is_terminal() {
  local dir="$TEST_TMP/t8"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  local sf; sf=$(_mj_state_file)
  # Manually inject records
  state_mutate "$sf" '.jobs["j:running"] = {status:"running",reaped:false}'
  state_mutate "$sf" '.jobs["j:succeeded"] = {status:"succeeded",reaped:false}'
  state_mutate "$sf" '.jobs["j:failed"] = {status:"failed",reaped:false}'
  state_mutate "$sf" '.jobs["j:timed_out"] = {status:"timed_out",reaped:false}'

  mj_is_terminal "j:running"  && fail "is_terminal: running should be false" || pass "is_terminal: running is non-terminal"
  mj_is_terminal "j:succeeded" && pass "is_terminal: succeeded is terminal"  || fail "is_terminal: succeeded should be true"
  mj_is_terminal "j:failed"    && pass "is_terminal: failed is terminal"     || fail "is_terminal: failed should be true"
  mj_is_terminal "j:timed_out" && pass "is_terminal: timed_out is terminal"  || fail "is_terminal: timed_out should be true"
}

# ── Test: extra_json is merged into record ────────────────────────────────────
test_extra_json_merged() {
  local dir="$TEST_TMP/t9"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  local extra; extra='{"issue_id":"HOK-42","side":"challenger","pr_number":"99"}'
  mj_launch "challenge_eval" "eval:extra:challenger" 420 "$extra" -- sleep 0.1
  sleep 0.2

  local rec; rec=$(mj_get "eval:extra:challenger")
  check_eq "extra_json: issue_id" "HOK-42" "$(printf '%s' "$rec" | jq -r '.issue_id')"
  check_eq "extra_json: side"     "challenger" "$(printf '%s' "$rec" | jq -r '.side')"
  check_eq "extra_json: pr_number" "99" "$(printf '%s' "$rec" | jq -r '.pr_number')"
}

# ── Test: mj_log_excerpt works ───────────────────────────────────────────────
test_log_excerpt() {
  local dir="$TEST_TMP/t10"
  export REPO_DIR="$dir"
  mkdir -p "$dir"
  _mj_init

  mj_launch "challenge_eval" "eval:log:primary" 420 "" -- bash -c 'echo "line1"; echo "line2"; echo "line3"; sleep 0.5'
  sleep 0.3

  local excerpt; excerpt=$(mj_log_excerpt "eval:log:primary" 3 2>/dev/null)
  if printf '%s' "$excerpt" | grep -q "line1"; then
    pass "log_excerpt: contains output"
  else
    fail "log_excerpt: missing output (got: $excerpt)"
  fi
}

# ── Run all tests ─────────────────────────────────────────────────────────────
test_init_creates_state_file
test_status_unknown_for_missing
test_launch_creates_running_record
test_poll_transitions_succeeded
test_poll_transitions_failed
test_poll_transitions_timed_out
test_launch_idempotent
test_is_terminal
test_extra_json_merged
test_log_excerpt

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 )) && exit 0 || exit 1
