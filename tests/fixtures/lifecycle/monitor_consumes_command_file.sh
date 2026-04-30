#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

for required in read_command_offset write_command_offset drain_command_events consume_next_command wavemill_command_file_path wavemill_command_offset_path; do
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
