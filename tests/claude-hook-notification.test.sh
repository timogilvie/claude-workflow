#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SCRIPT="$REPO_DIR/shared/hooks/claude-status-hook.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_hook_field() {
  local file="$1" field="$2" expected="$3" name="$4"
  local actual
  actual="$(jq -r "$field" "$file" 2>/dev/null || true)"
  if [[ "$actual" == "$expected" ]]; then
    pass "$name"
  else
    fail "$name (expected '$expected', got '$actual')"
  fi
}

echo "=== Claude Hook Notification Handling ==="

if [[ ! -f "$HOOK_SCRIPT" ]]; then
  fail "claude-status-hook.sh not found"
else
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  export WAVEMILL_ISSUE="HOK-1731"
  export WAVEMILL_SESSION="notif-test-$$"
  HOOK_FILE="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  rm -f "$HOOK_FILE"

  # 1) Notification with message field
  printf '%s\n' '{"hook_event_name":"Notification","message":"Please choose option A or B"}' | bash "$HOOK_SCRIPT"
  assert_hook_field "$HOOK_FILE" '.state' 'waiting' 'notification message sets waiting state'
  assert_hook_field "$HOOK_FILE" '.detail' 'Please choose option A or B' 'notification message copied to detail'

  # 2) Notification with notification_type fallback
  printf '%s\n' '{"hook_event_name":"Notification","notification_type":"idle_prompt"}' | bash "$HOOK_SCRIPT"
  assert_hook_field "$HOOK_FILE" '.detail' 'idle_prompt' 'notification_type used when message missing'

  # 3) Notification with no detail fields
  printf '%s\n' '{"hook_event_name":"Notification"}' | bash "$HOOK_SCRIPT"
  assert_hook_field "$HOOK_FILE" '.detail' 'awaiting user input' 'missing detail falls back to default text'

  # 4) Notification message truncated to 120 chars
  long_message="$(printf 'x%.0s' {1..160})"
  printf '{"hook_event_name":"Notification","message":"%s"}\n' "$long_message" | bash "$HOOK_SCRIPT"
  detail_len="$(jq -r '.detail | length' "$HOOK_FILE" 2>/dev/null || echo 0)"
  if [[ "$detail_len" == "120" ]]; then
    pass 'notification detail truncates at 120 chars'
  else
    fail "notification detail truncation expected 120, got $detail_len"
  fi

  # 5) Missing WAVEMILL_SESSION remains a no-op
  unset WAVEMILL_SESSION
  no_session_hook_file="/tmp/wavemill--${WAVEMILL_ISSUE}.hook"
  rm -f "$no_session_hook_file"
  printf '%s\n' '{"hook_event_name":"Notification","message":"Need input"}' | bash "$HOOK_SCRIPT"
  if [[ ! -f "$no_session_hook_file" ]]; then
    pass 'missing WAVEMILL_SESSION does not write hook file'
  else
    fail 'missing WAVEMILL_SESSION unexpectedly wrote hook file'
  fi

  # 6) UserPromptSubmit transitions waiting -> working
  export WAVEMILL_SESSION="notif-test-$$"
  printf '%s\n' '{"hook_event_name":"Notification","message":"Need your answer"}' | bash "$HOOK_SCRIPT"
  printf '%s\n' '{"hook_event_name":"UserPromptSubmit"}' | bash "$HOOK_SCRIPT"
  assert_hook_field "$HOOK_FILE" '.state' 'working' 'user prompt submit transitions state to working'
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
