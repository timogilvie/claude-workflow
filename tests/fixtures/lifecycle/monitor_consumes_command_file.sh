#!/usr/bin/env bash
set -euo pipefail

# Guard against being sourced by lifecycle-scenarios.test.sh
[[ "${BASH_SOURCE[0]}" != "${0}" ]] && return 0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

HEREDOC_CONTENT=$(cat "$MONITOR_SCRIPT_FILE")

for required in read_command_offset write_command_offset drain_command_events consume_next_command wavemill_command_file_path acknowledge_command_offset monitor_defer_command; do
  if ! grep -q "^${required}()" <<< "$HEREDOC_CONTENT" && ! grep -q "${required}" <<< "$HEREDOC_CONTENT"; then
    echo "FAIL: monitor heredoc missing ${required}"
    exit 1
  fi
done

if grep -q 'read -t "\$POLL_SECONDS"' <<< "$HEREDOC_CONTENT"; then
  echo "FAIL: blocking timed read still present in monitor loop"
  exit 1
fi

echo "PASS: monitor consumes command file without timed reads"
