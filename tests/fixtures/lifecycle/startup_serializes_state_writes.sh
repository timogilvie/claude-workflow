#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
COMMON="$REPO_DIR/shared/lib/wavemill-common.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-startup-state.XXXXXX)"
SESSION="startup-state-$$"
export SESSION

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_launch_dispatcher() {
  awk '
    /^launch_startup_concurrent\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}/ { exit }
  ' "$RUNNER"
}

# shellcheck source=/dev/null
source "$COMMON"
eval "$(extract_launch_dispatcher)"

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

append_state_line() {
  local issue="$1"
  printf '%s:' "$issue" >> "$STATE_WRITES_FILE"
  sleep 0.05
  printf 'ok\n' >> "$STATE_WRITES_FILE"
}

launch_task_from_plan() {
  local task_json="$1"
  local issue
  issue="$(printf '%s' "$task_json" | jq -r '.issue')"
  wavemill_lock_run "state" append_state_line "$issue"
}

run_case() {
  local name="$1"
  PLAN_FILE="$TMP_DIR/${name}-plan.json"
  STATUS_LOG_FILE="$TMP_DIR/${name}-status.log"
  STATE_WRITES_FILE="$TMP_DIR/${name}-state.txt"
  export PLAN_FILE STATUS_LOG_FILE STATE_WRITES_FILE

  jq -n '
    {
      tasks: [range(1; 7) as $i | {
        issue: ("HOK-" + ($i | tostring)),
        slug: ("task-" + ($i | tostring))
      }]
    }
  ' > "$PLAN_FILE"
  : > "$STATE_WRITES_FILE"

  WAVEMILL_STARTUP_CONCURRENCY=6 launch_startup_concurrent 6

  local line_count
  line_count="$(grep -cve '^[[:space:]]*$' "$STATE_WRITES_FILE")"
  if [[ "$line_count" -ne 6 ]]; then
    echo "FAIL: $name wrote $line_count lines, expected 6"
    exit 1
  fi
  if grep -vqE '^HOK-[1-6]:ok$' "$STATE_WRITES_FILE"; then
    echo "FAIL: $name wrote corrupted state lines"
    cat "$STATE_WRITES_FILE"
    exit 1
  fi
}

run_case "flock-or-default"

command() {
  if [[ "${1:-}" == "-v" && "${2:-}" == "flock" ]]; then
    return 1
  fi
  builtin command "$@"
}

run_case "mkdir-fallback"

echo "PASS: startup state writes are serialized"
