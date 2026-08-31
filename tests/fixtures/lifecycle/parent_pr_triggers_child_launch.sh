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
GH_BODY_FILE="$TMP_DIR/pr-body.txt"
GH_EDIT_FILE="$TMP_DIR/pr-edit.txt"
FUNCTION_FILE="$TMP_DIR/dependent-launch-functions.sh"
BIN_DIR="$TMP_DIR/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" != "pr" ]]; then
  exit 1
fi
shift

subcommand="${1:-}"
shift || true

case "$subcommand" in
  view)
    pr_number="${1:-}"
    shift || true
    if [[ "$pr_number" == "9001" ]]; then
      printf '{"headRefName":"task/hok-1534-parent","url":"https://github.com/x/y/pull/9001","number":9001}\n'
      exit 0
    fi
    if [[ "$pr_number" == "9010" ]]; then
      if [[ "${*: -1}" == ".body // \"\"" ]]; then
        cat "$GH_BODY_FILE"
      else
        jq -n --arg body "$(cat "$GH_BODY_FILE")" '{body: $body}'
      fi
      exit 0
    fi
    exit 1
    ;;
  edit)
    pr_number="${1:-}"
    shift || true
    if [[ "$pr_number" != "9010" || "${1:-}" != "--body" ]]; then
      exit 1
    fi
    printf '%s' "${2:-}" > "$GH_EDIT_FILE"
    printf '%s' "${2:-}" > "$GH_BODY_FILE"
    ;;
  *)
    exit 1
    ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

export PATH="$BIN_DIR:$PATH"
export STATE_FILE GH_BODY_FILE GH_EDIT_FILE SESSION="dependent-launch" API_TIMEOUT=5

printf 'Existing child PR body\n' > "$GH_BODY_FILE"
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
    },
    {
      "issue_id": "HOK-1600",
      "blocker_issue_id": "HOK-1601",
      "blocker_pr_number": null,
      "desired_base_branch": "HOK-1601",
      "linear_issue_url": "https://linear.app/issue/HOK-1600",
      "slug": "hok-1600-other",
      "title": "Other task"
    }
  ]
}
JSON

# shellcheck source=/dev/null
source "$COMMON_LIB"

extract_function "$MONITOR_LIB" "inject_depends_on_pr_block" >> "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function "$MONITOR_LIB" "dispatch_queued_children_for_parent" >> "$FUNCTION_FILE"

_with_timeout() {
  local _timeout="$1"
  shift
  "$@"
}

log_warn() {
  printf 'WARN:%s\n' "$*" >> "$LOG_FILE"
}

launch_task() {
  printf 'LAUNCHED:%s:%s\n' "$1" "${5:-}" >> "$LOG_FILE"
}

declare -Ag BRANCH_BY_ISSUE=()
declare -Ag SLUG_BY_ISSUE=()

# shellcheck source=/dev/null
source "$FUNCTION_FILE"

echo "=== Parent PR Triggers Child Launch ==="

dispatch_queued_children_for_parent "HOK-1534" "9001"

if grep -q 'LAUNCHED:HOK-1535:task/hok-1534-parent' "$LOG_FILE"; then
  pass "child launches from parent PR branch"
else
  fail "child launches from parent PR branch"
fi

if jq -e '(.queued_tasks // []) | length == 1 and .[0].issue_id == "HOK-1600"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "only unrelated queued tasks remain"
else
  fail "only unrelated queued tasks remain"
fi

if jq -e '.tasks["HOK-1535"].dependsOnPr.number == 9001' "$STATE_FILE" >/dev/null 2>&1; then
  pass "dependsOnPr number recorded"
else
  fail "dependsOnPr number recorded"
fi

if jq -e '.tasks["HOK-1535"].dependsOnPr.branch == "task/hok-1534-parent"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "dependsOnPr branch recorded"
else
  fail "dependsOnPr branch recorded"
fi

if jq -e '.tasks["HOK-1535"].dependsOnPr.parent_issue == "HOK-1534"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "dependsOnPr parent issue recorded"
else
  fail "dependsOnPr parent issue recorded"
fi

meta_json="$(jq -c '.tasks["HOK-1535"].dependsOnPr' "$STATE_FILE")"
inject_depends_on_pr_block "HOK-1535" "9010" "$meta_json"

if grep -q '^depends_on:' "$GH_EDIT_FILE" && grep -q 'issue: "HOK-1534"' "$GH_EDIT_FILE" && grep -q 'branch: "task/hok-1534-parent"' "$GH_EDIT_FILE"; then
  pass "child PR body receives depends_on block"
else
  fail "child PR body receives depends_on block"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
