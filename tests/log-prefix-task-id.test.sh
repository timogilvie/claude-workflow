#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# ============================================================================
# Source the formatter
# ============================================================================

source "$LIB_DIR/wavemill-common.sh"

fmt() { wavemill_format_task_log_message "$@"; }

# ============================================================================
# wavemill_format_task_log_message direct tests
# ============================================================================

echo "=== wavemill_format_task_log_message ==="

# INFO with implicit scope
result=$(WAVEMILL_ISSUE=HOK-1585 fmt "Routing: planner=x")
if [[ "$result" == "[HOK-1585] Routing: planner=x" ]]; then
  pass "implicit WAVEMILL_ISSUE prefixes message"
else
  fail "implicit WAVEMILL_ISSUE: expected '[HOK-1585] Routing: planner=x', got '$result'"
fi

# INFO with explicit scope
result=$(fmt "⛔ → Workflow aborted by user during planning phase" "HOK-113")
if [[ "$result" == "[HOK-113] ⛔ → Workflow aborted by user during planning phase" ]]; then
  pass "explicit issue arg prefixes message"
else
  fail "explicit issue arg: expected '[HOK-113] ⛔ → Workflow aborted by user during planning phase', got '$result'"
fi

# Emoji ordering
result=$(fmt "📊 Eval queued in background" "HOK-113")
if [[ "$result" == "[HOK-113] 📊 Eval queued in background" ]]; then
  pass "emoji is preserved after prefix"
else
  fail "emoji ordering: expected '[HOK-113] 📊 Eval queued in background', got '$result'"
fi

# Unscoped INFO: WAVEMILL_ISSUE unset and no explicit issue
result=$(unset WAVEMILL_ISSUE 2>/dev/null; WAVEMILL_ISSUE="" fmt "some message")
if [[ "$result" == "some message" ]]; then
  pass "unscoped call returns message unchanged"
else
  fail "unscoped call: expected 'some message', got '$result'"
fi

# Duplicate bracket token: no double prefix
result=$(WAVEMILL_ISSUE=HOK-113 fmt "[HOK-113] foo")
if [[ "$result" == "[HOK-113] foo" ]]; then
  pass "duplicate bracket prefix is deduplicated"
else
  fail "duplicate bracket prefix: expected '[HOK-113] foo', got '$result'"
fi

# Duplicate arrow token: "$issue → " stripped and re-prefixed
result=$(fmt "⛔ HOK-113 → aborted" "HOK-113")
if [[ "$result" == "[HOK-113] ⛔ → aborted" ]]; then
  pass "duplicate arrow token is deduplicated"
else
  fail "duplicate arrow token: expected '[HOK-113] ⛔ → aborted', got '$result'"
fi

# Different issue reference: preserve cross-reference
result=$(WAVEMILL_ISSUE=HOK-113 fmt "[HOK-999] child task")
if [[ "$result" == "[HOK-113] [HOK-999] child task" ]]; then
  pass "different issue cross-reference is preserved after prefix"
else
  fail "different issue cross-reference: expected '[HOK-113] [HOK-999] child task', got '$result'"
fi

# Leading whitespace trim
result=$(fmt "   trimmed message" "HOK-1")
if [[ "$result" == "[HOK-1] trimmed message" ]]; then
  pass "leading whitespace is trimmed from message"
else
  fail "leading whitespace trim: expected '[HOK-1] trimmed message', got '$result'"
fi

# Whitespace-only issue treated as no-scope
result=$(WAVEMILL_ISSUE="   " fmt "no scope message")
if [[ "$result" == "no scope message" ]]; then
  pass "whitespace-only WAVEMILL_ISSUE treated as no-scope"
else
  fail "whitespace-only issue: expected 'no scope message', got '$result'"
fi

# Injection-like issue value is rendered literally, not executed
result=$(fmt "hello" 'HOK-113; rm -rf /')
if [[ "$result" == '[HOK-113; rm -rf /] hello' ]]; then
  pass "injection-like issue value is rendered as literal data"
else
  fail "injection-like issue: expected '[HOK-113; rm -rf /] hello', got '$result'"
fi

# ============================================================================
# mill log() with --issue flag tests
# Uses a minimal stub context (not the full mill) to test log() behavior.
# ============================================================================

echo ""
echo "=== mill log() --issue integration ==="

# Build a minimal bash context that mirrors what log() needs from the mill:
# wavemill_format_task_log_message (from common.sh), _log_level_num,
# append_status_log, log, log_error, log_warn.
_MILL_LOG_PREAMBLE='
source "'"$LIB_DIR"'/wavemill-common.sh"

_log_level_num() {
  case "$1" in
    error) echo 0 ;; status) echo 1 ;; info) echo 2 ;; debug) echo 3 ;; *) echo 2 ;;
  esac
}

STATUS_LOG_FILE="$_status_log"
VERBOSITY_NUM=3
DASHBOARD_LOG_TO_FILE=false

append_status_log() {
  local payload="$1"
  [[ -n "${STATUS_LOG_FILE:-}" ]] || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '"'"'%s\n'"'"' "$line" >> "$STATUS_LOG_FILE"
  done <<< "$payload"
}

log() {
  local level="info" issue_override="" msg
  case "${1:-}" in error|status|info|debug) level="$1"; shift ;; esac
  if [[ "${1:-}" == "--issue" ]]; then issue_override="${2:-}"; shift 2; fi
  msg=$(wavemill_format_task_log_message "$*" "$issue_override")
  local ts formatted msg_num
  ts="$(date '"'"'+%H:%M:%S'"'"')"
  formatted="$ts  $msg"
  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}

log_error() {
  local m="$*"; m="${m#"${m%%[![:space:]]*}"}"; echo "$(date '"'"'+%H:%M:%S'"'"')  ERROR: $m" >&2
}

log_warn() {
  local m="$*"; m="${m#"${m%%[![:space:]]*}"}"; echo "$(date '"'"'+%H:%M:%S'"'"')  WARN: $m" >&2
}
'

run_mill_log() {
  local _status_log
  _status_log="$(mktemp)"
  local result
  result=$(bash -c "
    set -euo pipefail
    export _status_log='$_status_log'
    $_MILL_LOG_PREAMBLE
    $1
  " 2>/dev/null || true)
  cat "$_status_log"
  rm -f "$_status_log"
}

# log "status" --issue produces [ISSUE] prefix
output=$(run_mill_log 'log "status" --issue "HOK-113" "⛔ → Workflow aborted by user during planning phase"')
if echo "$output" | grep -qF "[HOK-113] ⛔ → Workflow aborted by user during planning phase"; then
  pass "mill log status --issue produces bracketed prefix in pane output"
else
  fail "mill log status --issue: expected [HOK-113] prefix in '$output'"
fi

# log "info" --issue produces [ISSUE] prefix
output=$(run_mill_log 'log "info" --issue "HOK-1585" "Routing: planner=claude-sonnet-4-6"')
if echo "$output" | grep -qF "[HOK-1585] Routing: planner=claude-sonnet-4-6"; then
  pass "mill log info --issue produces bracketed prefix in pane output"
else
  fail "mill log info --issue: expected [HOK-1585] prefix in '$output'"
fi

# log without --issue and no WAVEMILL_ISSUE — output unchanged
output=$(run_mill_log 'WAVEMILL_ISSUE="" log "status" "global system message"')
if echo "$output" | grep -qF "global system message" && ! echo "$output" | grep -qE '\[HOK-'; then
  pass "mill log without --issue stays unscoped"
else
  fail "mill log without --issue: unexpected prefix in '$output'"
fi

# ERROR log: never prefixed even with WAVEMILL_ISSUE set
output=$(bash -c "
  set -euo pipefail
  export _status_log=\$(mktemp)
  $_MILL_LOG_PREAMBLE
  WAVEMILL_ISSUE=HOK-113 log_error 'quota exhausted'
" 2>&1 || true)
if ! echo "$output" | grep -qF "[HOK-113]"; then
  pass "log_error output is never prefixed by WAVEMILL_ISSUE"
else
  fail "log_error should not include [HOK-113] prefix, got '$output'"
fi

# WARN log: never prefixed
output=$(bash -c "
  set -euo pipefail
  export _status_log=\$(mktemp)
  $_MILL_LOG_PREAMBLE
  WAVEMILL_ISSUE=HOK-113 log_warn 'near limit'
" 2>&1 || true)
if ! echo "$output" | grep -qF "[HOK-113]"; then
  pass "log_warn output is never prefixed by WAVEMILL_ISSUE"
else
  fail "log_warn should not include [HOK-113] prefix, got '$output'"
fi

# ============================================================================
# RESULTS
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
