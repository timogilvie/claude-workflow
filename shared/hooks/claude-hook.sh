#!/opt/homebrew/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

payload=$(cat 2>/dev/null || true)
[[ -n "$payload" ]] || exit 0

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
    detail=$(printf '%s' "$payload" | jq -r '.error_type // .errorType // .error.type // .message // empty' 2>/dev/null || true)
    wavemill_hook_write "error" "$event" "$detail" "claude"
    ;;
  Notification)
    detail=$(printf '%s' "$payload" | jq -r '.notification_type // .notificationType // .type // empty' 2>/dev/null || true)
    case "$detail" in
      permission_prompt|idle_prompt)
        wavemill_hook_write "waiting" "$event" "$detail" "claude"
        ;;
      *)
        ;;
    esac
    ;;
  *)
    ;;
esac

exit 0
