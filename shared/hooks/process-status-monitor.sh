#!/usr/bin/env bash
set -euo pipefail

# Fallback status monitor for agent CLIs without hooks or structured event
# streams. If the tmux pane's foreground shell has active descendants, the agent
# is considered working; otherwise it is idle/done.

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
writer="$script_dir/wavemill-status-writer.sh"
agent_pid="${1:-}"
poll_interval="${WAVEMILL_PROCESS_STATUS_POLL_INTERVAL:-2}"

[[ -n "$agent_pid" ]] || exit 1

while kill -0 "$agent_pid" 2>/dev/null; do
  child_count=$(pgrep -P "$agent_pid" 2>/dev/null | wc -l | tr -d ' ')
  if (( child_count > 0 )); then
    "$writer" "working"
  else
    "$writer" "done"
  fi
  sleep "$poll_interval"
done

"$writer" "done"
