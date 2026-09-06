#!/usr/bin/env bash
set -euo pipefail

# Regression coverage for a Wavemill worker killing the controller tmux server.
# A worker inherits TMUX, so changing TMUX_TMPDIR does not isolate tmux clients;
# destructive server-wide commands must use an explicit -S or -L target.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SCRIPT="$REPO_DIR/shared/hooks/claude-status-hook.sh"

PASS=0
FAIL=0
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"; rm -f "/tmp/wavemill-${TEST_SESSION:-}-"*.hook' EXIT

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not available; skipping Claude tmux server guard tests" >&2
  exit 0
fi

TEST_SESSION="tmux-guard-$$"
RUN_INDEX=0
HOOK_RC=0
HOOK_STDERR=""
HOOK_FILE=""

run_bash_hook() {
  local command_text="$1" payload
  RUN_INDEX=$((RUN_INDEX + 1))
  HOOK_FILE="/tmp/wavemill-${TEST_SESSION}-CASE-${RUN_INDEX}.hook"
  rm -f "$HOOK_FILE"
  payload=$(jq -nc --arg command "$command_text" \
    '{hook_event_name:"PreToolUse", tool_name:"Bash", tool_input:{command:$command}}')

  set +e
  WAVEMILL_SESSION="$TEST_SESSION" \
  WAVEMILL_ISSUE="CASE-${RUN_INDEX}" \
  WAVEMILL_DASHBOARD_PID="" \
    bash "$HOOK_SCRIPT" <<<"$payload" >"$TMP_ROOT/stdout" 2>"$TMP_ROOT/stderr"
  HOOK_RC=$?
  set -e
  HOOK_STDERR="$(cat "$TMP_ROOT/stderr")"
}

assert_denied() {
  local name="$1" command_text="$2"
  run_bash_hook "$command_text"
  if [[ "$HOOK_RC" -eq 2 ]] \
    && [[ "$HOOK_STDERR" == *"Blocked tmux kill-server"* ]] \
    && [[ "$HOOK_STDERR" == *"tmux -S <private-socket>"* ]] \
    && jq -e '.state == "policy-denied" and .event == "PreToolUse" and .agent == "claude"' "$HOOK_FILE" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name (rc=$HOOK_RC, stderr=$HOOK_STDERR)"
  fi
}

assert_allowed() {
  local name="$1" command_text="$2"
  run_bash_hook "$command_text"
  if [[ "$HOOK_RC" -eq 0 ]] \
    && [[ -z "$HOOK_STDERR" ]] \
    && jq -e '.state == "working" and .event == "PreToolUse" and .detail == "Bash"' "$HOOK_FILE" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name (rc=$HOOK_RC, stderr=$HOOK_STDERR)"
  fi
}

echo "=== Claude tmux server guard ==="

assert_denied \
  "TMUX_TMPDIR does not make kill-server safe inside tmux" \
  'TMUX_TMPDIR=/tmp/tmuxtest1 tmux kill-server'

assert_denied \
  "multi-command incident reproduction is denied" \
  $'D=$(mktemp -d)\nTMUX_TMPDIR="$D" tmux new-session -d -s smoketest\nTMUX_TMPDIR="$D" tmux kill-server\nrm -rf "$D"'

assert_denied \
  "wrapped tmux invocation with implicit socket is denied" \
  'env TMUX_TMPDIR=/tmp/test command tmux kill-server'

assert_denied \
  "one unsafe invocation makes a mixed command batch fail closed" \
  $'tmux -S /tmp/private.sock kill-server\ntmux kill-server'

# The hook must inspect the literal agent command, including its socket variable.
# shellcheck disable=SC2016
assert_allowed \
  "explicit private socket is allowed" \
  'TMUX_TMPDIR=/tmp/test tmux -S "$TMUX_SOCK" kill-server'

assert_allowed \
  "explicit named server is allowed" \
  'tmux -L incident-fixture kill-server'

assert_allowed \
  "quoted documentation is not treated as an invocation" \
  'printf "%s\n" "tmux kill-server"'

assert_allowed \
  "non-destructive tmux command is allowed" \
  'tmux list-sessions'

# The adapter must stay inert outside a Wavemill-launched agent context.
outside_payload='{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"tmux kill-server"}}'
set +e
env -u WAVEMILL_SESSION -u WAVEMILL_ISSUE \
  bash "$HOOK_SCRIPT" <<<"$outside_payload" >"$TMP_ROOT/outside.stdout" 2>"$TMP_ROOT/outside.stderr"
outside_rc=$?
set -e
if [[ "$outside_rc" -eq 0 && ! -s "$TMP_ROOT/outside.stdout" && ! -s "$TMP_ROOT/outside.stderr" ]]; then
  pass "standalone Claude sessions remain unaffected"
else
  fail "standalone Claude session should be a no-op (rc=$outside_rc)"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
