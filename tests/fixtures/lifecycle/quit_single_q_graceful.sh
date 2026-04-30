#!/usr/bin/env bash
set -euo pipefail

# Verify that consume_next_command is called in every sleep-containing branch
# of the monitor heredoc, including the "all slots full" path.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

# Extract sections that contain interruptible_sleep and check if consume_next_command
# appears before the sleep call in the same logical branch

# Extract the "all slots full" branch section
ALL_SLOTS_SECTION=$(awk '
  /# All slots full/ { found=1 }
  found { print }
  /^  fi$/ && found { exit }
' <<< "$HEREDOC_CONTENT")

# Check for "all slots full" branch - should have consume_next_command before sleep
if ! grep -q "consume_next_command" <<< "$ALL_SLOTS_SECTION"; then
  echo "FAIL: 'all slots full' branch does not call consume_next_command before sleep"
  exit 1
fi

if ! grep -q "interruptible_sleep" <<< "$ALL_SLOTS_SECTION"; then
  echo "FAIL: 'all slots full' branch does not use interruptible_sleep"
  exit 1
fi

# Verify quit-now handling exists in the "all slots full" branch
if ! grep -q "quit-now" <<< "$ALL_SLOTS_SECTION"; then
  echo "FAIL: 'all slots full' branch does not handle quit-now"
  exit 1
fi

echo "PASS: consume_next_command is called in all sleep-containing branches including 'all slots full'"
