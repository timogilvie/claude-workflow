#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
SESSION="input-reader-burst-$$"

source "$COMMON_SCRIPT"

COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
STATE_FILE="$(mktemp "/tmp/wavemill-${SESSION}-state.XXXXXX.json")"

cleanup() {
  rm -f "$COMMAND_FILE" "$STATE_FILE"
}
trap cleanup EXIT

HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

COMMAND_QUEUE=()
COMMAND_QUEUE_OFFSETS=()
COMMAND_OFFSET_WARNED=false
POLL_SECONDS=10
REPLY=""
REPLY_OFFSET=""
cat > "$STATE_FILE" <<'EOF'
{
  "monitorCommandOffset": 0,
  "monitorDeferredCommands": []
}
EOF

log_warn() {
  :
}

eval "$(awk '
  /^monitor_command_timestamp\(\) \{/ { capture=1 }
  capture { print }
  /^monitor_issue_state\(\) \{/ { exit }
' <<< "$HEREDOC_CONTENT" | sed '$d')"

printf 'select 1\nenter\nmore\nquit\n' > "$COMMAND_FILE"

drain_command_events

if (( ${#COMMAND_QUEUE[@]} != 4 )); then
  echo "FAIL: expected 4 queued commands after drain, got ${#COMMAND_QUEUE[@]}"
  exit 1
fi

expected_queue="$(cat <<'OUT'
select 1
enter
more
quit
OUT
)"
actual_queue="$(printf '%s\n' "${COMMAND_QUEUE[@]}")"
if [[ "$actual_queue" != "$expected_queue" ]]; then
  echo "FAIL: queued commands were not preserved in order"
  echo "Expected:"
  printf '%s\n' "$expected_queue"
  echo "Actual:"
  printf '%s\n' "$actual_queue"
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
  "select 1"
  "enter"
  "more"
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

acknowledge_command_offset 4
if [[ "$(jq -r '.monitorCommandOffset' "$STATE_FILE")" != "4" ]]; then
  echo "FAIL: expected durable command offset to advance to 4"
  exit 1
fi

echo "PASS: burst command events wake poll_sleep and preserve ordering"
