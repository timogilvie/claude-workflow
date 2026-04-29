#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-startup-concurrent.XXXXXX)"
SESSION="startup-concurrent-$$"
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

now_ms() {
  perl -MTime::HiRes=time -e 'printf "%.0f\n", time() * 1000'
}

PLAN_FILE="$TMP_DIR/plan.json"
STATUS_LOG_FILE="$TMP_DIR/status.log"
RUN_LOG="$TMP_DIR/run.log"
export PLAN_FILE STATUS_LOG_FILE RUN_LOG

jq -n '
  {
    tasks: [range(1; 7) as $i | {
      issue: ("HOK-" + ($i | tostring)),
      slug: ("task-" + ($i | tostring))
    }]
  }
' > "$PLAN_FILE"

startup_log() {
  printf '%s\n' "$*" >> "$STATUS_LOG_FILE"
}

launch_task_from_plan() {
  local task_json="$1"
  local issue
  issue="$(printf '%s' "$task_json" | jq -r '.issue')"
  printf 'START %s %s\n' "$issue" "$(now_ms)" >> "$RUN_LOG"
  sleep 1
  printf 'END %s %s\n' "$issue" "$(now_ms)" >> "$RUN_LOG"
}

eval "$(extract_launch_dispatcher)"

start_s=$(date +%s)
WAVEMILL_STARTUP_CONCURRENCY=3 launch_startup_concurrent 6
elapsed=$(( $(date +%s) - start_s ))

if [[ "$elapsed" -gt 4 ]]; then
  echo "FAIL: launch took ${elapsed}s, expected <= 4s"
  exit 1
fi

max_overlap="$(node - "$RUN_LOG" <<'NODE'
const fs = require('fs');
const file = process.argv[2];
const events = fs.readFileSync(file, 'utf8')
  .trim()
  .split(/\n+/)
  .filter(Boolean)
  .map((line) => {
    const [kind, issue, at] = line.split(/\s+/);
    return { kind, issue, at: Number(at) };
  })
  .sort((a, b) => a.at - b.at || (a.kind === 'END' ? -1 : 1));

let running = 0;
let max = 0;
for (const event of events) {
  if (event.kind === 'START') {
    running += 1;
    max = Math.max(max, running);
  } else if (event.kind === 'END') {
    running -= 1;
  }
}
process.stdout.write(String(max));
NODE
)"
if [[ "$max_overlap" -gt 3 ]]; then
  echo "FAIL: max overlap was $max_overlap, expected <= 3"
  exit 1
fi

set +e
WAVEMILL_STARTUP_CONCURRENCY=0 launch_startup_concurrent 6
invalid_rc=$?
set -e
if [[ "$invalid_rc" -ne 2 ]] || ! grep -q 'WAVEMILL_STARTUP_CONCURRENCY must be a positive integer' "$STATUS_LOG_FILE"; then
  echo "FAIL: invalid concurrency did not return 2 with an error"
  exit 1
fi

echo "PASS: startup dispatcher launches tasks concurrently"
