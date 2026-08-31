#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
MONITOR_LIB="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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
LOG_FILE="$TMP_DIR/launch.log"
FUNCTION_FILE="$TMP_DIR/dependent-launch-functions.sh"
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
echo "branch lookup failed for parent PR" >&2
exit 1
STUB
chmod +x "$BIN_DIR/gh"

export PATH="$BIN_DIR:$PATH"
export STATE_FILE SESSION="dependent-launch-failure" API_TIMEOUT=5

cat > "$STATE_FILE" <<'JSON'
{
  "session": "test",
  "tasks": {
    "HOK-1534": {
      "title": "Parent task"
    }
  },
  "queued_tasks": [
    {
      "issue_id": "HOK-1535",
      "blocker_issue_id": "HOK-1534",
      "blocker_pr_number": null,
      "desired_base_branch": "HOK-1534",
      "linear_issue_url": "https://linear.app/issue/HOK-1535",
      "slug": "hok-1535-child",
      "title": "Child task"
    }
  ]
}
JSON

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$MONITOR_LIB" "dispatch_queued_children_for_parent" >> "$FUNCTION_FILE"

log_warn() {
  printf 'WARN:%s\n' "$*" >> "$LOG_FILE"
}

launch_task() {
  printf 'LAUNCHED:%s\n' "$1" >> "$LOG_FILE"
}

declare -Ag BRANCH_BY_ISSUE=()
declare -Ag SLUG_BY_ISSUE=()

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== Parent Branch Missing Fails Clearly ==="

dispatch_queued_children_for_parent "HOK-1534" "9001"

if jq -e '.queued_tasks[0].issue_id == "HOK-1535"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "child remains queued"
else
  fail "child remains queued"
fi

if jq -e '(.queued_tasks[0].waiting_reason // "") | startswith("parent_pr_branch_unresolvable:")' "$STATE_FILE" >/dev/null 2>&1; then
  pass "waiting_reason explains branch resolution failure"
else
  fail "waiting_reason explains branch resolution failure"
fi

if jq -e '.tasks["HOK-1535"] | not' "$STATE_FILE" >/dev/null 2>&1; then
  pass "child task state is not created"
else
  fail "child task state is not created"
fi

if grep -q 'LAUNCHED:' "$LOG_FILE"; then
  fail "child is not launched"
else
  pass "child is not launched"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
