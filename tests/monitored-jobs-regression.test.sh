#!/usr/bin/env bash
# Regression test: monitor loop keeps iterating while background jobs run.
# Simulates a long-running eval/comparison job and verifies that the poll/reap
# functions do not block the caller.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR_ORIG="$(cd "$SCRIPT_DIR/.." && pwd)"
MJ_SCRIPT="$REPO_DIR_ORIG/shared/lib/monitored-job.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS+1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL+1)); }

# ── Harness ──────────────────────────────────────────────────────────────────
TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

export REPO_DIR="$TEST_TMP/repo"
mkdir -p "$REPO_DIR"

log()      { :; }
log_warn() { echo "WARN: $*" >&2; }

state_mutate() {
  local sf="$1" filter="$2"; shift 2
  local tmp; tmp=$(mktemp)
  jq "$@" "$filter" < "$sf" > "$tmp" && mv "$tmp" "$sf"
}

source "$MJ_SCRIPT"

echo "=== Monitored Jobs Regression Test ==="
echo "Verifying: monitor loop does not block on long-running background jobs"

# ── Setup: launch a long-running background job ──────────────────────────────
_mj_init
LONG_JOB_ID="challenge_eval:HOK-REGR:primary"
mj_launch "challenge_eval" "$LONG_JOB_ID" 300 "" -- sleep 30
sleep 0.2

status_before=$(mj_status "$LONG_JOB_ID")
if [[ "$status_before" != "running" ]]; then
  echo "Setup failed: job should be running, got: $status_before"
  exit 1
fi

# ── Measure: poll_monitored_jobs must complete quickly (< 2 seconds) ─────────
T_START=$(date +%s%N 2>/dev/null || date +%s)

ITERATIONS=0
ELAPSED_TOTAL=0

while (( ITERATIONS < 5 )); do
  T_ITER_START=$(date +%s%N 2>/dev/null || date +%s)
  poll_monitored_jobs
  T_ITER_END=$(date +%s%N 2>/dev/null || date +%s)

  # Calculate iteration duration in milliseconds (or seconds if %N unavailable)
  if [[ ${#T_ITER_START} -gt 10 ]]; then
    # nanoseconds available
    ITER_MS=$(( (T_ITER_END - T_ITER_START) / 1000000 ))
    ELAPSED_TOTAL=$(( ELAPSED_TOTAL + ITER_MS ))
  else
    # fallback: seconds
    ITER_MS=$(( (T_ITER_END - T_ITER_START) * 1000 ))
    ELAPSED_TOTAL=$(( ELAPSED_TOTAL + ITER_MS ))
  fi

  ITERATIONS=$((ITERATIONS + 1))
  status_mid=$(mj_status "$LONG_JOB_ID")

  if [[ "$status_mid" != "running" ]]; then
    fail "regression: job should still be running during poll, got: $status_mid"
    break
  fi
done

# Each poll iteration must be non-blocking (< 2000ms)
if (( ELAPSED_TOTAL < 10000 )); then
  pass "regression: 5 poll iterations completed in ${ELAPSED_TOTAL}ms (< 10s)"
else
  fail "regression: poll iterations took ${ELAPSED_TOTAL}ms — may be blocking"
fi

# Verify job is still running (poll does not kill it prematurely)
status_after=$(mj_status "$LONG_JOB_ID")
check_eq() {
  local name="$1" exp="$2" act="$3"
  if [[ "$exp" == "$act" ]]; then pass "$name"; else echo "  expected: $exp / actual: $act"; fail "$name"; fi
}
check_eq "regression: job still running after 5 poll cycles" "running" "$status_after"

# ── Verify: launched job PID is recorded and valid ───────────────────────────
rec=$(mj_get "$LONG_JOB_ID")
pid=$(printf '%s' "$rec" | jq -r '.pid')
if kill -0 "$pid" 2>/dev/null; then
  pass "regression: job PID $pid is alive"
else
  fail "regression: job PID $pid is not alive"
fi

# ── Verify: log file exists and is being written to ──────────────────────────
lp=$(printf '%s' "$rec" | jq -r '.log_path')
if [[ -f "$lp" ]]; then
  pass "regression: log file exists at $lp"
else
  fail "regression: log file not found at $lp"
fi

# ── Verify: state transitions correctly when job completes ───────────────────
# Launch a quick job and verify poll picks it up within 2 cycles
QUICK_JOB="challenge_eval:HOK-REGR-QUICK:primary"
mj_launch "challenge_eval" "$QUICK_JOB" 420 "" -- bash -c 'sleep 0.2; exit 0'
sleep 0.5

poll_monitored_jobs
quick_status=$(mj_status "$QUICK_JOB")
check_eq "regression: quick job transitions to succeeded" "succeeded" "$quick_status"

# ── Cleanup ───────────────────────────────────────────────────────────────────
kill "$pid" 2>/dev/null || true

echo ""
echo "Results: $PASS passed, $FAIL failed"
(( FAIL == 0 )) && exit 0 || exit 1
