#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

extract_linear_batch_set_state() {
  awk '
    /^linear_batch_set_state\(\) \{/ { capture=1 }
    capture { print }
    capture && /^}/ { exit }
  ' "$RUNNER"
}

LOG_FILE="$(mktemp /tmp/wavemill-startup-linear-warn.XXXXXX)"
trap 'rm -f "$LOG_FILE"' EXIT

startup_log() {
  printf '%s\n' "$*" >> "$LOG_FILE"
}

npx() {
  cat <<'EOF'
{
  "updated": ["HOK-101"],
  "failed": [
    {
      "issueId": "HOK-102",
      "error": "Issue cannot transition from Backlog"
    }
  ]
}
EOF
  return 1
}

TOOLS_DIR="$REPO_DIR/tools"
DRY_RUN="false"

eval "$(extract_linear_batch_set_state)"

linear_batch_set_state "In Progress" "HOK-101" "HOK-102"

if ! grep -q "WARN: Linear state update to 'In Progress' failed for HOK-102: Issue cannot transition from Backlog" "$LOG_FILE"; then
  echo "missing per-issue startup warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -q "WARN: Batch Linear state update to 'In Progress' failed for 2 issue(s)" "$LOG_FILE"; then
  echo "unexpected generic batch warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
