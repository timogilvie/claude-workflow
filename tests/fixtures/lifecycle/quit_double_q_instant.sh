#!/usr/bin/env bash
set -euo pipefail

# Verify that the input reader has the logic to emit quit-now when two q events
# arrive within the 2-second window (static analysis test).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
INPUT_READER="$REPO_DIR/shared/lib/wavemill-input-reader.sh"

READER_CONTENT=$(cat "$INPUT_READER")

# Check for _LAST_QUIT_TIME variable declaration
if ! grep -q "_LAST_QUIT_TIME=0" <<< "$READER_CONTENT"; then
  echo "FAIL: _LAST_QUIT_TIME variable not initialized"
  exit 1
fi

# Check for quit-now event emission logic
if ! grep -q 'event="quit-now"' <<< "$READER_CONTENT"; then
  echo "FAIL: quit-now event not emitted by input reader"
  exit 1
fi

# Check for 2-second window check
if ! grep -q 'now - _LAST_QUIT_TIME <= 2' <<< "$READER_CONTENT"; then
  echo "FAIL: 2-second window check not found"
  exit 1
fi

# Check for timestamp update after quit
if ! grep -q '_LAST_QUIT_TIME=$now' <<< "$READER_CONTENT"; then
  echo "FAIL: timestamp update not found"
  exit 1
fi

# Check for date +%s to get current timestamp
QUIT_SECTION=$(awk '
  /elif.*quit.*exit/ { found=1 }
  found { print }
  found && /shopt -u nocasematch/ { exit }
' <<< "$READER_CONTENT")

if ! grep -q 'now=$(date +%s)' <<< "$QUIT_SECTION"; then
  echo "FAIL: timestamp capture not found in quit handling"
  exit 1
fi

echo "PASS: input reader has double-q detection logic with 2-second window"
