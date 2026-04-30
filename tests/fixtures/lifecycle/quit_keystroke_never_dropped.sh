#!/usr/bin/env bash
set -euo pipefail

# Verify that:
# 1. The monitor heredoc contains a quit-now fast-path check at the start of each loop iteration
# 2. All sleep calls use interruptible_sleep rather than bare sleep

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

# Check for quit-now fast-path comment
if ! grep -q "# Fast-path for quit-now" <<< "$HEREDOC_CONTENT"; then
  echo "FAIL: quit-now fast-path comment not found"
  exit 1
fi

# Check that fast-path loops through COMMAND_QUEUE checking for quit-now
if ! grep -q 'for _qi in "${!COMMAND_QUEUE\[@\]}"' <<< "$HEREDOC_CONTENT"; then
  echo "FAIL: fast-path loop over COMMAND_QUEUE not found"
  exit 1
fi

# Extract fast-path section
FAST_PATH_SECTION=$(awk '
  /# Fast-path for quit-now/ { found=1 }
  found { print }
  found && /^  done$/ { exit }
' <<< "$HEREDOC_CONTENT")

# Verify it checks for quit-now and calls quit_and_kill_session
if ! grep -q "quit-now" <<< "$FAST_PATH_SECTION"; then
  echo "FAIL: fast-path does not check for quit-now"
  exit 1
fi

if ! grep -q "quit_and_kill_session" <<< "$FAST_PATH_SECTION"; then
  echo "FAIL: fast-path does not call quit_and_kill_session"
  exit 1
fi

# Verify all POLL_SECONDS sleeps use interruptible_sleep (not bare sleep)
# Use grep with pattern that matches lines starting with sleep (not interruptible_sleep)
BARE_SLEEP_LINES=$(grep -E '^\s*sleep "\$POLL_SECONDS"' <<< "$HEREDOC_CONTENT" || true)
if [[ -n "$BARE_SLEEP_LINES" ]]; then
  BARE_SLEEP_COUNT=$(echo "$BARE_SLEEP_LINES" | wc -l | tr -d ' ')
  echo "FAIL: found $BARE_SLEEP_COUNT bare sleep calls (should use interruptible_sleep)"
  exit 1
fi

# Verify interruptible_sleep function is defined
if ! grep -q "^interruptible_sleep()" <<< "$HEREDOC_CONTENT"; then
  echo "FAIL: interruptible_sleep function not defined in monitor"
  exit 1
fi

# Verify USR1 trap for waking from sleep
if ! grep -q "trap.*USR1" <<< "$HEREDOC_CONTENT"; then
  echo "FAIL: USR1 trap not found (needed for interruptible sleep)"
  exit 1
fi

# Verify at least 8 interruptible_sleep calls exist (the minimum from plan)
INTERRUPTIBLE_COUNT=$(grep -c 'interruptible_sleep "\$POLL_SECONDS"' <<< "$HEREDOC_CONTENT" || echo 0)
if (( INTERRUPTIBLE_COUNT < 8 )); then
  echo "FAIL: expected at least 8 interruptible_sleep calls, found $INTERRUPTIBLE_COUNT"
  exit 1
fi

echo "PASS: quit-now fast-path exists and all sleeps are interruptible"
