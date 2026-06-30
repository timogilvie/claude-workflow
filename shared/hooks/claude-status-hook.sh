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
    # Claude Code SDK sends Notification events with a free-form `.message`
    # field when the agent asks the user a clarifying question or otherwise
    # blocks on input. Older payload shapes used `.notification_type` for
    # permission_prompt/idle_prompt — preserve those as fallbacks so legacy
    # writers keep working.
    #
    # When the payload carries a stable discriminator (notification_type or
    # message pattern) for approval or policy conditions, map to the richer
    # state so the dashboard can surface it distinctly. Falls back to `waiting`
    # for all other notifications.
    notification_type=$(printf '%s' "$payload" | jq -r '.notification_type // .notificationType // empty' 2>/dev/null || true)
    detail=$(printf '%s' "$payload" | jq -r '.message // .notification_type // .notificationType // .type // empty' 2>/dev/null || true)
    detail="${detail:0:120}"
    [[ -z "$detail" ]] && detail="awaiting user input"

    hook_state="waiting"
    case "$notification_type" in
      approval_request|approval-request)
        hook_state="approval-needed"
        ;;
      policy_denied|policy-denied)
        hook_state="policy-denied"
        ;;
    esac

    wavemill_hook_write "$hook_state" "$event" "$detail" "claude"
    ;;
  *)
    ;;
esac

exit 0
