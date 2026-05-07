#!/usr/bin/env bash
set -euo pipefail

# End-to-end test runner for dependency-aware task queue lifecycle.
#
# Scenarios covered here (shell fixtures):
#   1. Read-only analysis produces queue metadata (REQ-F2)
#   3. First-wave launch holds queued children (REQ-F4)
#   4. Parent PR triggers child launch (REQ-F5) — via existing fixture
#   8b. Missing parent branch fails clearly (REQ-F9b) — via existing fixture
#   8a. Queue disabled falls back cleanly (REQ-F9a)
#
# Scenarios covered at unit test level (not duplicated here):
#   6. Plan cache reuse (REQ-F7) — shared/lib/task-dependency-plan-cache.test.ts
#   7. Partial refresh (REQ-F8) — shared/lib/queue-partial-refresh.test.ts

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE_DIR="$SCRIPT_DIR/fixtures/lifecycle"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

run_fixture() {
  local name="$1"
  local path="$2"
  local output=""
  local status=0

  output="$(bash "$path" 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    pass "$name"
  else
    printf '%s\n' "$output" | sed 's/^/    /'
    fail "$name"
  fi
}

echo "=== Dependency-Aware Task Queue (End-to-End) ==="

run_fixture "read-only analysis produces queue metadata"  "$FIXTURE_DIR/queue_readonly_analysis.sh"
run_fixture "first-wave launch holds queued children"     "$FIXTURE_DIR/queue_first_wave_launch.sh"
run_fixture "parent PR triggers child launch"             "$FIXTURE_DIR/parent_pr_triggers_child_launch.sh"
run_fixture "missing parent branch fails clearly"         "$FIXTURE_DIR/parent_branch_missing_fails_clearly.sh"
run_fixture "queue disabled falls back cleanly"           "$FIXTURE_DIR/queue_fallback_disabled.sh"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
