#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "expected to find: $needle"
    exit 1
  fi
}

dispatch_fn="$(extract_function "$MILL_SCRIPT" dispatch_task_and_persist)"
if [[ -z "$dispatch_fn" ]]; then
  echo "FAIL: dispatch_task_and_persist is missing"
  exit 1
fi

source "$TMP_DIR/empty.sh" 2>/dev/null || true
eval "$dispatch_fn"

MARK_CALLED=""
LOGS=""
ERR_TRAP_COUNT=0
launch_task() {
  LAST_LAUNCHED_SLOTS=0
  return 37
}
mark_task_needs_user_and_defer() {
  MARK_CALLED="$1|$2|$3|$4"
  return 0
}
log_error() {
  LOGS+="$*"$'\n'
}
trap 'ERR_TRAP_COUNT=$((ERR_TRAP_COUNT + 1))' ERR

if ! dispatch_task_and_persist "HOK-2721" "router-fallback" "Router fallback" 1; then
  echo "FAIL: dispatch wrapper should always return 0"
  exit 1
fi
if [[ "$ERR_TRAP_COUNT" != "0" ]]; then
  echo "FAIL: dispatch wrapper fired ERR trap"
  exit 1
fi
assert_contains "needs-user marker called" "$MARK_CALLED" "HOK-2721|router-fallback|launch_failed|launch_task exit 37"
assert_contains "operator log says monitor continues" "$LOGS" "monitor continues"

fallback_block="$(awk '
  /Workflow routing unavailable/ {
    for (i = NR - 20; i <= NR + 4; i += 1) {
      if (lines[i] != "") print lines[i]
    }
  }
  { lines[NR] = $0 }
' "$MILL_SCRIPT")"
assert_contains "fallback resets coder agent" "$fallback_block" 'task_agent_cmd="$AGENT_CMD"'
assert_contains "fallback clears coder model to agent default" "$fallback_block" 'task_model=""'
assert_contains "fallback records recovery action" "$fallback_block" "wavemill config migrate-model-settings"

if grep -n 'launch_task "$sel_issue"' "$MILL_SCRIPT"; then
  echo "FAIL: selected monitor launches must use dispatch_task_and_persist"
  exit 1
fi
if ! grep -q 'dispatch_task_and_persist "$sel_issue"' "$MILL_SCRIPT"; then
  echo "FAIL: selected monitor dispatch wrapper call is missing"
  exit 1
fi
if grep -q 'Selected coder route is not launchable: agent= model=' "$MILL_SCRIPT"; then
  echo "FAIL: empty coder route diagnostic should no longer be emitted"
  exit 1
fi

echo "PASS: router fallback and dispatch failures are contained"
