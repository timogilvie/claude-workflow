#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

# Read JSON payload from stdin (Claude sends hook context as JSON)
payload=$(cat 2>/dev/null || true)
[[ -n "$payload" ]] || exit 0

# Extract event name (Claude uses different field names across versions)
event=$(printf '%s' "$payload" | jq -r '.hook_event_name // .hookEventName // .event // empty' 2>/dev/null || true)
[[ -n "$event" ]] || exit 0

case "$event" in
  UserPromptSubmit)
    wavemill_hook_write "working" "$event" "" "claude"
    ;;
  PreToolUse)
    detail=$(printf '%s' "$payload" | jq -r '.tool_name // .toolName // .tool.name // empty' 2>/dev/null || true)
    wavemill_hook_write "working" "$event" "$detail" "claude"
    ;;
  Stop)
    wavemill_hook_write "idle" "$event" "" "claude"
    ;;
  StopFailure)
    detail=$(printf '%s' "$payload" | jq -r '.error.message // .message // .error_type // .errorType // .error.type // empty' 2>/dev/null || true)
    if [[ -z "$detail" ]]; then
      detail=$(printf '%s' "$payload" | jq -r '. | tostring' 2>/dev/null | head -c 200 || true)
    fi
    wavemill_hook_write "error" "$event" "$detail" "claude"
    ;;
  Notification)
    detail=$(printf '%s' "$payload" | jq -r '.message // .notification_message // .text // .notification_type // .notificationType // .type // empty' 2>/dev/null || true)
    if [[ -z "$detail" ]]; then
      detail="awaiting user input"
    fi
    detail="${detail:0:120}"
    wavemill_hook_write "waiting" "$event" "$detail" "claude"
    ;;
  *)
    ;;
esac

exit 0
