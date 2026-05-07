#!/usr/bin/env bash
set -euo pipefail

# Validates that the launch-plan-with-queue.json fixture contains well-formed
# queue metadata (availableNow, queuedAfterDependencies) and that parsing it
# via seed_queued_tasks_from_plan produces the expected state without any
# external side effects (no gh/tmux calls, no worktree dirs).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
STARTUP_RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_FILE="$TMP_DIR/state.json"
PLAN_FILE="$REPO_DIR/tests/fixtures/startup/launch-plan-with-queue.json"
FUNCTION_FILE="$TMP_DIR/seed-functions.sh"
BIN_DIR="$TMP_DIR/bin"
GH_CALL_LOG="$TMP_DIR/gh-calls.log"
TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
WORKTREE_DIR="$TMP_DIR/worktrees"
mkdir -p "$BIN_DIR" "$WORKTREE_DIR"

cat > "$BIN_DIR/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$GH_CALL_LOG"
echo "unexpected gh call" >&2
exit 1
STUB
chmod +x "$BIN_DIR/gh"

cat > "$BIN_DIR/tmux" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMUX_CALL_LOG"
echo "unexpected tmux call" >&2
exit 1
STUB
chmod +x "$BIN_DIR/tmux"

export PATH="$BIN_DIR:$PATH"
: > "$GH_CALL_LOG"
: > "$TMUX_CALL_LOG"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "test-readonly",
  "tasks": {},
  "queued_tasks": []
}
JSON

export STATE_FILE SESSION="readonly-queue-test"

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$STARTUP_RUNNER" "seed_queued_tasks_from_plan" > "$FUNCTION_FILE"

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== Queue Read-Only Analysis ==="

if ! jq -e '.queuePlan | has("availableNow")' "$PLAN_FILE" >/dev/null 2>&1; then
  fail "queuePlan.availableNow present in fixture plan"
  exit 1
fi
pass "queuePlan.availableNow present in fixture plan"

if ! jq -e '.queuePlan.availableNow | type == "array" and length > 0' "$PLAN_FILE" >/dev/null 2>&1; then
  fail "queuePlan.availableNow is a non-empty array"
  exit 1
fi
pass "queuePlan.availableNow is a non-empty array"

if ! jq -e '.queuePlan | has("queuedAfterDependencies")' "$PLAN_FILE" >/dev/null 2>&1; then
  fail "queuePlan.queuedAfterDependencies present"
  exit 1
fi
pass "queuePlan.queuedAfterDependencies present"

if ! jq -e '.queuePlan.queuedAfterDependencies | type == "array" and length > 0' "$PLAN_FILE" >/dev/null 2>&1; then
  fail "queuePlan.queuedAfterDependencies is a non-empty array"
  exit 1
fi
pass "queuePlan.queuedAfterDependencies is a non-empty array"

if ! jq -e '.queuePlan.queuedAfterDependencies[0] | has("taskId") and has("ancestors")' "$PLAN_FILE" >/dev/null 2>&1; then
  fail "queued entry has taskId and ancestors"
  exit 1
fi
pass "queued entry has taskId and ancestors"

seed_queued_tasks_from_plan "$PLAN_FILE"

queued_count="$(jq '.queued_tasks | length' "$STATE_FILE")"
if [[ "$queued_count" -ge 1 ]]; then
  pass "seeding produces queued_tasks entries"
else
  fail "seeding produces queued_tasks entries (got $queued_count)"
fi

if [[ -s "$GH_CALL_LOG" ]]; then
  fail "no gh calls during read-only analysis"
else
  pass "no gh calls during read-only analysis"
fi

if [[ -s "$TMUX_CALL_LOG" ]]; then
  fail "no tmux calls during read-only analysis"
else
  pass "no tmux calls during read-only analysis"
fi

if ls "$WORKTREE_DIR"/* >/dev/null 2>&1; then
  fail "no worktree directories created"
else
  pass "no worktree directories created"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
