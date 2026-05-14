#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUNNER="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

extract_linear_batch_set_state() {
  awk '
    /^linear_enqueue_retry\(\) \{/ { capture=1 }
    /^linear_batch_set_state\(\) \{/ { capture=1; in_batch=1 }
    capture { print }
    in_batch && /^}/ { exit }
  ' "$RUNNER"
}

LOG_FILE="$(mktemp /tmp/wavemill-startup-linear-malformed.XXXXXX)"
trap 'rm -f "$LOG_FILE"' EXIT

startup_log() {
  printf '%s\n' "$*" >> "$LOG_FILE"
}

npx() {
  if [[ "$*" == *"set-issues-state.ts"* ]]; then
    cat <<'EOF'
{
  "updated": [],
  "failed": [
    {
      "issueId": "HOK-503",
      "error": "Linear API response missing issueUpdate result",
      "category": "graphql",
      "httpStatus": null,
      "isRetryable": false
    }
  ]
}
EOF
    return 1
  fi
  return 0
}

TOOLS_DIR="$REPO_DIR/tools"
DRY_RUN="false"

eval "$(extract_linear_batch_set_state)"

linear_batch_set_state "In Progress" "HOK-503"

if ! grep -q "WARN: Linear state update to 'In Progress' failed for HOK-503: Linear API response missing issueUpdate result \[category=graphql, http=none, retryable=false\]" "$LOG_FILE"; then
  echo "missing structured malformed-response warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -q "WARN: Batch Linear state update to 'In Progress' failed" "$LOG_FILE"; then
  echo "unexpected generic batch warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi
