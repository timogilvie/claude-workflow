#!/usr/bin/env bash
# Verify that the startup worker pool respects WAVEMILL_STARTUP_CONCURRENCY.
# Mocks launch_task_from_plan to write timing traces and checks that at no
# point did more than CONCURRENCY tasks run simultaneously.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RENDER_LIB="$REPO_DIR/shared/lib/wavemill-startup-render.sh"

if [[ ! -f "$RENDER_LIB" ]]; then
  echo "FAIL: wavemill-startup-render.sh not found at $RENDER_LIB"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1 && ! command -v jq >/dev/null 2>&1; then
  echo "SKIP: python3 or jq required for plan generation"
  exit 0
fi

TMP_DIR="$(mktemp -d /tmp/wavemill-concurrency-test.XXXXXX)"
TRACE_FILE="$TMP_DIR/trace"
SESSION="test-concurrency-$$"
TASK_COUNT=5
CONCURRENCY=2
SLEEP_SECS=0.2

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── Millisecond timestamp helper (macOS-compatible) ───────────────────────────
ms_now() {
  python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || \
    printf '%d000' "$(date +%s)"
}

# ── Source the render lib and force plain mode ────────────────────────────────
# shellcheck source=/dev/null
source "$RENDER_LIB"

export STARTUP_RENDER_MODE=plain
export STARTUP_RENDER_ROWS="$TASK_COUNT"
export STARTUP_RENDER_ROWS_DIR="$TMP_DIR/rows"
export STARTUP_RENDER_DRAW_LOCK="$TMP_DIR/draw.lock"
export STARTUP_RENDER_LAST_DRAW="$TMP_DIR/last-draw"
mkdir -p "$TMP_DIR/rows"

export WAVEMILL_STARTUP_CONCURRENCY="$CONCURRENCY"
export SESSION TRACE_FILE SLEEP_SECS TMP_DIR

# ── Mock launch_task_from_plan: records start/end with ms timestamps ──────────
launch_task_from_plan() {
  local _task_json="$1" ordinal="$2"
  local ts
  ts="$(python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || \
        printf '%d000' "$(date +%s)")"
  printf 'start\t%s\t%s\n' "$ordinal" "$ts" >> "$TRACE_FILE"
  sleep "$SLEEP_SECS"
  ts="$(python3 -c 'import time; print(int(time.time() * 1000))' 2>/dev/null || \
        printf '%d000' "$(date +%s)")"
  printf 'end\t%s\t%s\n' "$ordinal" "$ts" >> "$TRACE_FILE"
}
export -f launch_task_from_plan

# ── Build a minimal plan JSON ─────────────────────────────────────────────────
plan_json="$(jq -n --argjson n "$TASK_COUNT" \
  '[range($n) | {issue: "HOK-\(100 + .)", slug: "task-\(.)", title: "Task \(.)"}]
   | {tasks: .}')"

# ── Run the worker pool loop (mirrors main() in wavemill-startup-runner.sh) ───
: > "$TRACE_FILE"
running=0
idx=0

while IFS= read -r task_json; do
  [[ -z "$task_json" ]] && continue
  idx=$(( idx + 1 ))

  while (( running >= WAVEMILL_STARTUP_CONCURRENCY )); do
    # Try wait -n first; fall back to plain wait for older bash
    if wait -n 2>/dev/null; then
      running=$(( running - 1 ))
    elif wait 2>/dev/null; then
      running=$(( running - 1 ))
    fi
  done

  (
    launch_task_from_plan "$task_json" "$idx" "$TASK_COUNT" || true
  ) &
  running=$(( running + 1 ))

done < <(printf '%s' "$plan_json" | jq -c '.tasks[]')

wait

# ── Verify all tasks ran ──────────────────────────────────────────────────────
total_starts="$(grep -c '^start' "$TRACE_FILE" 2>/dev/null || echo 0)"
if [[ "$total_starts" -ne "$TASK_COUNT" ]]; then
  echo "FAIL: expected $TASK_COUNT start events, got $total_starts"
  exit 1
fi
echo "PASS: all $TASK_COUNT tasks started"

total_ends="$(grep -c '^end' "$TRACE_FILE" 2>/dev/null || echo 0)"
if [[ "$total_ends" -ne "$TASK_COUNT" ]]; then
  echo "FAIL: expected $TASK_COUNT end events, got $total_ends"
  exit 1
fi
echo "PASS: all $TASK_COUNT tasks completed"

# ── Compute max concurrent overlap from the trace ────────────────────────────
# For each start event at time T, count tasks whose [start, end] contains T.
max_concurrent=0

while IFS=$'\t' read -r event ordinal ts; do
  [[ "$event" != "start" ]] && continue
  query_ms="$ts"

  concurrent=0
  while IFS=$'\t' read -r ev2 ord2 ts2; do
    [[ "$ev2" != "start" ]] && continue
    s_ms="$ts2"
    e_ms="$(grep -m1 "^end	${ord2}	" "$TRACE_FILE" | cut -f3 || echo 0)"
    [[ -z "$e_ms" || "$e_ms" == "0" ]] && continue
    if (( s_ms <= query_ms && e_ms >= query_ms )); then
      (( concurrent++ )) || true
    fi
  done < "$TRACE_FILE"

  (( concurrent > max_concurrent )) && max_concurrent="$concurrent"
done < "$TRACE_FILE"

echo "Max concurrent tasks observed: $max_concurrent (limit: $CONCURRENCY)"

if (( max_concurrent <= CONCURRENCY )); then
  echo "PASS: concurrency cap respected (max=$max_concurrent, limit=$CONCURRENCY)"
else
  echo "FAIL: concurrency cap violated (max=$max_concurrent > limit=$CONCURRENCY)"
  exit 1
fi

if (( max_concurrent >= 2 )); then
  echo "PASS: parallel execution confirmed (at least 2 tasks overlapped)"
else
  echo "FAIL: tasks appear to have run sequentially despite concurrency=$CONCURRENCY"
  exit 1
fi

exit 0
