#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=shared/hooks/wavemill-hook-protocol.sh
source "$SCRIPT_DIR/wavemill-hook-protocol.sh"

wavemill_hook_check

# Fallback status monitor for agent CLIs without hooks or structured event
# streams. If the tmux pane's foreground shell has active descendants, the agent
# is considered working; otherwise it is idle.

agent_pid="${1:-}"
poll_interval="${WAVEMILL_PROCESS_STATUS_POLL_INTERVAL:-2}"

[[ -n "$agent_pid" ]] || exit 1

# Initial state
wavemill_hook_write "working" "process_start" "pid:$agent_pid" "generic"

while kill -0 "$agent_pid" 2>/dev/null; do
  child_count=$(pgrep -P "$agent_pid" 2>/dev/null | wc -l | tr -d ' ')
  if (( child_count > 0 )); then
    wavemill_hook_write "working" "process_active" "children:$child_count" "generic"
  else
    wavemill_hook_write "idle" "process_idle" "" "generic"
  fi
  sleep "$poll_interval"
done

# Process exited
wavemill_hook_write "idle" "process_exit" "" "generic"
