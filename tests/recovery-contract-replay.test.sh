#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local function_name="$1"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1; depth=0 }
    capture {
      print
      depth += gsub(/\{/, "{")
      depth -= gsub(/\}/, "}")
      if (depth == 0) exit
    }
  ' "$MILL_SCRIPT"
}

echo "=== Recovery Contract Replay ==="

body="$(extract_function "_restore_inflight_task_window_if_missing")"
for forbidden in \
  workflow-router \
  stage-aware-router \
  challenge-scheduler \
  resolve_model_for_ \
  resolve_phase_model \
  agent_resolve_model \
  agent_resolve_from_model \
  apply_expanded_route_if_present \
  reroute_expanded_packets_for_coding_handoff
do
  if grep -Fq "$forbidden" <<<"$body"; then
    fail "restore function does not call $forbidden"
  else
    pass "restore function does not call $forbidden"
  fi
done

if grep -Fq 'recovery_args=(read-and-validate' <<<"$body" \
  && grep -Fq 'recovery-contract.ts" "${recovery_args[@]}"' <<<"$body"; then
  pass "restore function validates persisted contract"
else
  fail "restore function validates persisted contract"
fi

if grep -Fq 'write_stage_result_with_history' <<<"$body"; then
  pass "restore function clears stale terminal stage state"
else
  fail "restore function clears stale terminal stage state"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

[[ "$FAIL" -eq 0 ]]
