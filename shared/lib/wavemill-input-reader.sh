#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"

session="${1:-${WAVEMILL_SESSION:-}}"
if [[ -z "$session" ]]; then
  echo "Error: session required (arg1 or WAVEMILL_SESSION)" >&2
  exit 1
fi

cmd_file="$(wavemill_command_file_path "$session")"
: >> "$cmd_file"

_LAST_QUIT_TIME=0

normalize_line() {
  local raw="$1"
  printf '%s' "$raw" | awk '{$1=$1; print}'
}

notify_monitor() {
  local pid_file="/tmp/wavemill-${session}-monitor.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -USR1 "$pid" 2>/dev/null || true
}

while :; do
  printf 'mill> '
  if ! IFS= read -r line; then
    exit 0
  fi

  line="$(normalize_line "$line")"
  [[ -z "$line" ]] && continue

  shopt -s nocasematch
  event=""
  if [[ "$line" =~ ^[0-9]+([[:space:]]+[0-9]+)*$ ]]; then
    event="select $line"
  elif [[ "$line" == "m" || "$line" == "more" ]]; then
    event="more"
  elif [[ "$line" == "q" || "$line" == "quit" || "$line" == "exit" ]]; then
    now=$(date +%s)
    if (( now - _LAST_QUIT_TIME <= 2 )); then
      event="quit-now"
    else
      event="quit"
    fi
    _LAST_QUIT_TIME=$now
  else
    event="unknown $line"
  fi
  shopt -u nocasematch

  printf '%s\n' "$event" >> "$cmd_file"
  notify_monitor
done
