#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

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

extract_function_occurrence() {
  local source_file="$1"
  local function_name="$2"
  local occurrence="$3"
  awk -v name="$function_name" -v target="$occurrence" '
    $0 ~ "^" name "\\(\\) \\{" {
      count++
      if (count == target) {
        capture=1
      }
    }
    capture { print }
    capture && $0 == "}" { exit }
  ' "$source_file"
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNCTION_FILE="$TEST_TMP/challenge-comparison-functions.sh"
extract_function_occurrence "$MILL_SCRIPT" "save_task_state" 2 > "$FUNCTION_FILE"
printf '\n' >> "$FUNCTION_FILE"
extract_function_occurrence "$MILL_SCRIPT" "maybe_run_challenge_comparison" 1 >> "$FUNCTION_FILE"

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract monitor save_task_state()"
  exit 1
fi

echo "=== Challenge Comparison State Persistence ==="

TEST_DIR="$TEST_TMP/case"
mkdir -p "$TEST_DIR"
STATE_FILE="$TEST_DIR/state.json"

cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "pair-1": {
      "slug": "pair-1",
      "branch": "task/pair-1",
      "worktree": "/tmp/pair-1",
      "pr": "324",
      "status": "review",
      "agent": "codex",
      "phase": "review",
      "evalCompleted": true,
      "challengeCompared": true,
      "challenge": true,
      "challengePairId": "pair-1",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "pair-1_c": {
      "slug": "pair-1-c",
      "branch": "task/pair-1-c",
      "worktree": "/tmp/pair-1-c",
      "pr": "325",
      "status": "review",
      "agent": "codex",
      "phase": "review",
      "evalCompleted": true,
      "challengeCompared": true,
      "challenge": true,
      "challengePairId": "pair-1",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"
  source "$1"

  SESSION="challenge-comparison-state-test"
  TOOLS_DIR="/tmp"
  REPO_DIR="/tmp"
  STATE_FILE="$2"
  COMPARE_CALLS=0

  log() { :; }
  log_warn() { :; }
  get_linear_issue_id() { printf "%s\n" "$1"; }

  read_state_value() {
    local default="${1:-}"
    shift || true
    local expr="${*: -1}"
    local jq_args=()
    if (( $# > 1 )); then
      jq_args=("${@:1:$#-1}")
    fi
    local result=""
    if result=$(jq -r "${jq_args[@]}" "$expr" "$STATE_FILE" 2>/dev/null); then
      :
    else
      result=""
    fi
    if [[ -z "$result" || "$result" == "null" ]]; then
      printf "%s\n" "$default"
    else
      printf "%s\n" "$result"
    fi
  }

  get_task_meta() {
    local issue="$1" field="$2"
    jq -r --arg issue "$issue" --arg field "$field" \
      ".tasks[\$issue][\$field] // empty" "$STATE_FILE"
  }

  _with_timeout() {
    COMPARE_CALLS=$((COMPARE_CALLS + 1))
    return 1
  }

  save_task_state "pair-1" "pair-1" "task/pair-1" "/tmp/pair-1" "324" "merged" "codex"

  compared_after_merge=$(jq -r ".tasks[\"pair-1\"].challengeCompared" "$STATE_FILE")
  status_after_merge=$(jq -r ".tasks[\"pair-1\"].status" "$STATE_FILE")

  maybe_run_challenge_comparison "pair-1_c"

  printf "%s\n%s\n%s\n" "$compared_after_merge" "$status_after_merge" "$COMPARE_CALLS"
' bash "$FUNCTION_FILE" "$STATE_FILE" "$REPO_DIR" > "$TEST_DIR/output.txt"

mapfile -t RESULTS < "$TEST_DIR/output.txt"

check_eq "challengeCompared survives monitor save_task_state" "true" "${RESULTS[0]:-}"
check_eq "merge update still sets merged status" "merged" "${RESULTS[1]:-}"
check_eq "comparison does not rerun after merged update" "0" "${RESULTS[2]:-}"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
