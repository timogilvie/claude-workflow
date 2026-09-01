#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MILL_SCRIPT"
}

eval "$(extract_function challenge_pair_records_file)"
eval "$(extract_function challenge_pair_record_exists)"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT
REPO_DIR="$TMP_ROOT/repo"
mkdir -p "$REPO_DIR/.wavemill/evals"

records="$REPO_DIR/.wavemill/evals/challenge-records.jsonl"
cat > "$records" <<'JSONL'
{"challengePairId":"HOK-2840","comparisonOutcome":"double-forfeit","winner":"primary","winnerModel":"unknown","terminalReason":"orphan_pair","armFailures":[],"primaryCompleted":false,"challengerCompleted":false,"primaryPrUrl":"https://github.com/unknown/unknown/pull/0","challengerPrUrl":"https://github.com/unknown/unknown/pull/1181","timestamp":"2026-08-21T00:00:00.000Z"}
{"challengePairId":"HOK-1","comparisonOutcome":"double-forfeit","terminalReason":"both_challenge_aborted","armFailures":[{"side":"primary","model":"m","failureKind":"provider-transient-error"}],"primaryCompleted":false,"challengerCompleted":false,"timestamp":"2026-08-21T00:01:00.000Z"}
{"challengePairId":"HOK-2","comparisonOutcome":"compared","timestamp":"2026-08-21T00:02:00.000Z"}
JSONL

cat > "$REPO_DIR/.wavemill/evals/challenge-record-voids.jsonl" <<'JSONL'
{"challengePairId":"HOK-2","voidedAt":"2026-08-21T00:03:00.000Z","reason":"bad row","recordTimestamp":"2026-08-21T00:02:00.000Z"}
JSONL

if challenge_pair_record_exists "HOK-2840"; then
  fail "non-decisive stall row was treated as terminal"
else
  pass "non-decisive stall row is ignored"
fi

if challenge_pair_record_exists "HOK-1"; then
  pass "decisive double-forfeit row is honored"
else
  fail "decisive double-forfeit row was ignored"
fi

if challenge_pair_record_exists "HOK-2"; then
  fail "voided comparison row was treated as terminal"
else
  pass "voided comparison row is ignored"
fi

# Ensure the two identical copies of challenge_pair_record_exists do not drift
# (one copy in the parent mill script, one in the committed monitor script)
FIRST_LINE=$(awk '/^challenge_pair_record_exists\(\) \{/ {print NR; exit}' "$MILL_SCRIPT")
SECOND_LINE=$(awk '/^challenge_pair_record_exists\(\) \{/ {print NR; exit}' "$MONITOR_SCRIPT_FILE")
if [ -n "$FIRST_LINE" ] && [ -n "$SECOND_LINE" ]; then
  # Find the end of each function
  FIRST_END=$(awk -v start="$FIRST_LINE" 'NR > start && /^}/ {print NR; exit}' "$MILL_SCRIPT")
  SECOND_END=$(awk -v start="$SECOND_LINE" 'NR > start && /^}/ {print NR; exit}' "$MONITOR_SCRIPT_FILE")
  FIRST_BODY=$(sed -n "${FIRST_LINE},${FIRST_END}p" "$MILL_SCRIPT")
  SECOND_BODY=$(sed -n "${SECOND_LINE},${SECOND_END}p" "$MONITOR_SCRIPT_FILE")
  if [ "$FIRST_BODY" = "$SECOND_BODY" ]; then
    pass "duplicate challenge_pair_record_exists functions are identical"
  else
    fail "duplicate challenge_pair_record_exists functions have drifted"
  fi
else
  fail "could not locate both copies of challenge_pair_record_exists"
fi

if (( FAIL > 0 )); then
  echo "Failed: $FAIL"
  exit 1
fi
echo "Passed: $PASS"
