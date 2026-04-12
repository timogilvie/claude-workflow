#!/usr/bin/env bash
set -euo pipefail

# Read Codex JSONL events from stdin and map them onto the shared wavemill
# status file contract. Unknown events are ignored; end-of-stream marks the
# session as done so crashed or exited agents do not remain "working" forever.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
writer="$script_dir/wavemill-status-writer.sh"

while IFS= read -r line; do
  [[ -n "$line" ]] || continue

  status=$(
    printf '%s\n' "$line" | jq -r '
      if .type == "response_item" and .payload.type == "function_call" then
        "working"
      elif .type == "response_item" and ((.payload.type // "") | test("function_call_output|tool_result")) then
        "working"
      elif .type == "exec_command" or .type == "tool_use" or .type == "function_call" or .type == "agent_message" then
        "working"
      elif .type == "notification" then
        "waiting"
      elif .type == "task_complete" or .type == "agent_turn_complete" then
        "done"
      elif .type == "response.completed" or .type == "response_complete" then
        "done"
      else
        empty
      end
    ' 2>/dev/null
  ) || continue

  [[ -n "$status" ]] || continue
  "$writer" "$status"
done

"$writer" "done"
