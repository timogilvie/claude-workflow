#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

# Read Codex JSONL events from stdin and map them onto the shared wavemill
# status protocol. Unknown events are ignored; end-of-stream marks the
# session as idle so crashed or exited agents do not remain "working" forever.

while IFS= read -r line; do
  [[ -n "$line" ]] || continue

  # Extract event type and detail from JSONL
  event=$(printf '%s\n' "$line" | jq -r '.type // empty' 2>/dev/null || true)
  [[ -n "$event" ]] || continue

  detail=""
  case "$event" in
    response_item)
      payload_type=$(printf '%s\n' "$line" | jq -r '.payload.type // empty' 2>/dev/null || true)
      case "$payload_type" in
        function_call)
          detail=$(printf '%s\n' "$line" | jq -r '.payload.function.name // empty' 2>/dev/null || true)
          wavemill_hook_write "working" "$event" "$detail" "codex"
          ;;
        function_call_output|tool_result)
          wavemill_hook_write "working" "$event" "$payload_type" "codex"
          ;;
      esac
      ;;
    exec_command|tool_use|function_call|agent_message)
      wavemill_hook_write "working" "$event" "" "codex"
      ;;
    notification)
      detail=$(printf '%s\n' "$line" | jq -r '.message // .text // empty' 2>/dev/null || true)
      wavemill_hook_write "waiting" "$event" "$detail" "codex"
      ;;
    task_complete|agent_turn_complete|response.completed|response_complete)
      wavemill_hook_write "idle" "$event" "" "codex"
      ;;
  esac
done

# Stream ended - mark as idle
wavemill_hook_write "idle" "stream_end" "" "codex"
