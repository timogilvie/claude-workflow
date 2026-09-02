#!/usr/bin/env bash
set -euo pipefail

# Runner for test files that use custom assert/test harnesses.
# These files use process.exit(1) on failure, so we just check exit codes.
#
# Usage:
#   bash tests/run-custom-tests.sh                 # run every test
#   bash tests/run-custom-tests.sh --shard 2/3     # run shard 2 of 3
#   bash tests/run-custom-tests.sh --list          # print selected tests and exit
#
# Sharded selection is weight-based: the combined test list is piped to
# tools/ci-test-timings.ts, which partitions deterministically by measured
# median runtimes (tests/timings/custom-weights.json). A failure in the
# partitioner fails the shard loudly -- selection must never silently change.
# The unsharded default runs everything serially, exactly as before.
#
# Per-file wall time is recorded to a JSON artifact (default
# test-timings/custom-shard-<n>.json, override with
# WAVEMILL_TEST_TIMINGS_FILE) so CI can rebalance shards from real data.
# The artifact contains repo-relative paths and integers only.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"

# tsx tests live under shared/lib/ and are invoked via the tsx loader.
TS_TESTS=(
  check-routing.test.ts
  challenge-coverage-selector.test.ts
  challenge-mode.test.ts
  challenge-score-selector.test.ts
  challenge-scheduler.test.ts
  constraint-parser.test.ts
  constraint-storage.test.ts
  difficulty-analyzer.test.ts
  eval-export.test.ts
  eval-aggregator.test.ts
  eval-backfill.test.ts
  eval-persistence.test.ts
  eval-schema.test.ts
  hokusai-adapter.test.ts
  hokusai-router.test.ts
  context-linter.test.ts
  config-sync.test.ts
  sync-config-classifier.test.ts
  llm-router.test.ts
  issue-expander.test.ts
  ready-stage.test.ts
  repo-context-analyzer.test.ts
  review-context-gatherer.test.ts
  route-batch.test.ts
  router-diversity.test.ts
  router-exploration.test.ts
  rule-generator.test.ts
  stage-aware-router.test.ts
  task-descriptor-backfill.test.ts
  task-context-analyzer.test.ts
  post-completion-hook.test.ts
  task-packet-validator.test.ts
  openrouter-generation-api.test.ts
  workflow-router.test.ts
  workflow-cost.test.ts
  native-agent/certification/router-filter.test.ts
)

# Shell-harness tests live under tests/ and are invoked with bash.
SH_TESTS=(
  agent-resolve-from-model.test.sh
)

# Known-broken tests (pre-existing issues, tracked separately)
SKIP_TESTS=(
  constraint-validator.test.ts
)

SHARD_INDEX=1
SHARD_TOTAL=1
LIST_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shard)
      if [[ ! "${2:-}" =~ ^[0-9]+/[0-9]+$ ]]; then
        echo "run-custom-tests.sh: --shard requires INDEX/TOTAL (e.g. 2/3)" >&2
        exit 2
      fi
      SHARD_INDEX="${2%%/*}"
      SHARD_TOTAL="${2##*/}"
      shift 2
      ;;
    --list)
      LIST_ONLY=1
      shift
      ;;
    *)
      echo "run-custom-tests.sh: unknown argument '$1'" >&2
      exit 2
      ;;
  esac
done

if (( SHARD_TOTAL < 1 || SHARD_INDEX < 1 || SHARD_INDEX > SHARD_TOTAL )); then
  echo "run-custom-tests.sh: invalid shard ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
  exit 2
fi

COMBINED=( "${TS_TESTS[@]}" "${SH_TESTS[@]}" )

SELECTED=()
if (( SHARD_TOTAL > 1 )); then
  # Weighted deterministic assignment. `set -o pipefail` is active, so a
  # partitioner failure (missing/malformed manifest, bad shard spec) fails
  # here instead of silently changing which tests run.
  if ! assignment="$(printf '%s\n' "${COMBINED[@]}" \
      | npx tsx "$REPO_DIR/tools/ci-test-timings.ts" assign --suite custom --shard "${SHARD_INDEX}/${SHARD_TOTAL}")"; then
    echo "run-custom-tests.sh: shard assignment failed for ${SHARD_INDEX}/${SHARD_TOTAL}" >&2
    exit 1
  fi
  while IFS= read -r line; do
    [[ -n "$line" ]] && SELECTED+=("$line")
  done <<< "$assignment"
else
  SELECTED=( "${COMBINED[@]}" )
fi

# A shard with no work is a configuration error, not a silent pass.
if (( ${#SELECTED[@]} == 0 )); then
  echo "run-custom-tests.sh: shard ${SHARD_INDEX}/${SHARD_TOTAL} selected no tests" >&2
  exit 2
fi

if (( LIST_ONLY == 1 )); then
  printf '%s\n' "${SELECTED[@]}"
  exit 0
fi

# Try local tsx first, fall back to global
TSX_LOADER="$(npm root)/tsx/dist/loader.mjs"
if [[ ! -f "$TSX_LOADER" ]]; then
  TSX_LOADER="$(npm root -g)/tsx/dist/loader.mjs"
fi

if [[ ! -f "$TSX_LOADER" ]]; then
  echo "tsx loader not found at: $TSX_LOADER" >&2
  echo "Install tsx: npm install --save-dev tsx" >&2
  exit 1
fi

TIMINGS_FILE="${WAVEMILL_TEST_TIMINGS_FILE:-$REPO_DIR/test-timings/custom-shard-${SHARD_INDEX}.json}"
mkdir -p "$(dirname "$TIMINGS_FILE")"

PASS=0
FAIL=0
SKIP=0
TIMING_ROWS=""

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

record_timing() {
  local file="$1" ms="$2" result="$3"
  (( ms < 1 )) && ms=1
  if [[ -n "$TIMING_ROWS" ]]; then
    TIMING_ROWS+=$',\n'
  fi
  TIMING_ROWS+="    {\"file\": \"${file}\", \"ms\": ${ms}, \"result\": \"${result}\"}"
}

run_one() {
  local f="$1" start_ms end_ms rc=0 result
  echo -n "  $f: "
  start_ms="$(now_ms)"
  case "$f" in
    *.ts)
      node --import "$TSX_LOADER" "$LIB_DIR/$f" > /dev/null 2>&1 || rc=$?
      ;;
    *.sh)
      bash "$SCRIPT_DIR/$f" > /dev/null 2>&1 || rc=$?
      ;;
    *)
      echo "UNKNOWN TEST TYPE" >&2
      rc=1
      ;;
  esac
  end_ms="$(now_ms)"
  if (( rc == 0 )); then
    echo "PASS"
    PASS=$((PASS + 1))
    result=pass
  else
    echo "FAIL"
    FAIL=$((FAIL + 1))
    result=fail
  fi
  record_timing "$f" "$(( end_ms - start_ms ))" "$result"
}

for f in "${SELECTED[@]}"; do
  run_one "$f"
done

# Print the skip list once (shard 1 or unsharded) so aggregate output does not
# multiply skips by the shard count.
if (( SHARD_INDEX == 1 )); then
  for f in "${SKIP_TESTS[@]}"; do
    echo "  $f: SKIP (known import issue)"
    SKIP=$((SKIP + 1))
  done
fi

# Timing artifact write failure must never fail the test run.
{
  printf '{\n  "suite": "custom",\n  "shard": "%s",\n  "generatedAt": "%s",\n  "results": [\n%s\n  ]\n}\n' \
    "$SHARD_INDEX" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$TIMING_ROWS" > "$TIMINGS_FILE"
} 2>/dev/null || echo "run-custom-tests.sh: warning: could not write timings to $TIMINGS_FILE" >&2

echo ""
if (( SHARD_TOTAL > 1 )); then
  echo "--- Results (shard ${SHARD_INDEX}/${SHARD_TOTAL}): $PASS passed, $FAIL failed, $SKIP skipped ---"
else
  echo "--- Results: $PASS passed, $FAIL failed, $SKIP skipped ---"
fi

if (( FAIL > 0 )); then
  exit 1
fi
