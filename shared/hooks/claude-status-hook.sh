#!/usr/bin/env bash
set -euo pipefail

# Claude Code hook adapter for wavemill lifecycle status tracking.
# Claude sends a JSON payload on stdin for each hook invocation; drain it so the
# hook never blocks Claude, even though this adapter only needs the hook type.
cat >/dev/null 2>&1 || true

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
hook_type="${1:-}"

case "$hook_type" in
  UserPromptSubmit|PreToolUse)
    "$script_dir/wavemill-status-writer.sh" "working"
    ;;
  Stop)
    "$script_dir/wavemill-status-writer.sh" "done"
    ;;
  Notification)
    "$script_dir/wavemill-status-writer.sh" "waiting"
    ;;
esac
