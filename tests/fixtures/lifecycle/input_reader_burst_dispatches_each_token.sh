#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
SESSION="input-reader-burst-$$"

source "$COMMON_SCRIPT"

COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
COMMAND_OFFSET_FILE="$(wavemill_command_offset_path "$SESSION")"
STATE_FILE="$(mktemp)"
printf '{"tasks":{}}\n' > "$STATE_FILE"

cleanup() {
  rm -f "$COMMAND_FILE" "$COMMAND_OFFSET_FILE" "$STATE_FILE"
}
trap cleanup EXIT

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

COMMAND_QUEUE=()
COMMAND_OFFSET_WARNED=false
POLL_SECONDS=10
REPLY=""

log_warn() {
  :
}

eval "$(awk '
  /^read_command_offset\(\) \{/ { capture=1 }
  capture { print }
  /^monitor_issue_state\(\) \{/ { exit }
' <<< "$HEREDOC_CONTENT" | sed '$d')"

printf 'select 1\nenter\nmore\nquit\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

drain_command_events

queued_count="$(jq '(.queued_commands // []) | length' "$STATE_FILE")"
if [[ "$queued_count" != "3" ]]; then
  echo "FAIL: expected 3 durable queued commands after drain, got $queued_count"
  exit 1
fi

expected_queue="$(cat <<'OUT'
select 1
enter
more
OUT
)"
actual_queue="$(jq -r '(.queued_commands // []) | sort_by(.line) | .[].command' "$STATE_FILE")"
if [[ "$actual_queue" != "$expected_queue" ]]; then
  echo "FAIL: queued commands were not preserved in order"
  echo "Expected:"
  printf '%s\n' "$expected_queue"
  echo "Actual:"
  printf '%s\n' "$actual_queue"
  exit 1
fi

if (( ${#COMMAND_QUEUE[@]} != 1 )) || [[ "${COMMAND_QUEUE[0]}" != "quit" ]]; then
  echo "FAIL: expected quit command to remain in the immediate command queue"
  exit 1
fi

start_time="$(date +%s)"
poll_sleep 10
elapsed=$(( $(date +%s) - start_time ))

if (( elapsed >= 2 )); then
  echo "FAIL: poll_sleep did not return promptly for queued commands (elapsed=${elapsed}s)"
  exit 1
fi

expected_consumed=(
  "quit"
)

for expected in "${expected_consumed[@]}"; do
  if ! consume_next_command; then
    echo "FAIL: expected queued command '$expected' to be consumable"
    exit 1
  fi
  if [[ "$REPLY" != "$expected" ]]; then
    echo "FAIL: expected '$expected', got '$REPLY'"
    exit 1
  fi
done

if consume_next_command; then
  echo "FAIL: command queue should be empty after consuming all events"
  exit 1
fi

expected_selection=(
  "select 1"
  "enter"
  "more"
)

for expected in "${expected_selection[@]}"; do
  if ! consume_queued_command_for_selection; then
    echo "FAIL: expected durable queued command '$expected' to be consumable"
    exit 1
  fi
  if [[ "$REPLY" != "$expected" ]]; then
    echo "FAIL: expected durable command '$expected', got '$REPLY'"
    exit 1
  fi
  queued_command_remove "$QUEUED_CMD_ID"
done

if consume_queued_command_for_selection; then
  echo "FAIL: durable command queue should be empty after consuming all events"
  exit 1
fi

if [[ "$(cat "$COMMAND_OFFSET_FILE")" != "4" ]]; then
  echo "FAIL: expected offset file to advance to 4"
  exit 1
fi

echo "PASS: burst command events wake poll_sleep and preserve ordering"
