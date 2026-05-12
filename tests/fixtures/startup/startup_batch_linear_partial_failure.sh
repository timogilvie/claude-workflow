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

LOG_FILE="$(mktemp /tmp/wavemill-startup-linear-warn.XXXXXX)"
NPX_LOG="$(mktemp /tmp/wavemill-startup-linear-npx.XXXXXX)"
trap 'rm -f "$LOG_FILE" "$NPX_LOG"' EXIT

startup_log() {
  printf '%s\n' "$*" >> "$LOG_FILE"
}

npx() {
  printf '%s\n' "$*" >> "$NPX_LOG"
  if [[ "$*" == *"set-issues-state.ts"* ]]; then
    cat <<'EOF'
{
  "updated": ["HOK-101"],
  "failed": [
    {
      "issueId": "HOK-102",
      "error": "Linear API request failed with HTTP 429: rate limited",
      "category": "rate_limit",
      "httpStatus": 429,
      "isRetryable": true
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

linear_batch_set_state "In Progress" "HOK-101" "HOK-102"

if ! grep -q "WARN: Linear state update to 'In Progress' failed for HOK-102: Linear API request failed with HTTP 429: rate limited \[category=rate_limit, http=429, retryable=true\]" "$LOG_FILE"; then
  echo "missing per-issue startup warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if grep -q "WARN: Batch Linear state update to 'In Progress' failed for 2 issue(s)" "$LOG_FILE"; then
  echo "unexpected generic batch warning" >&2
  cat "$LOG_FILE" >&2
  exit 1
fi

if ! grep -q "linear-retry-drain.ts enqueue --state In Progress --issues HOK-102 --category rate_limit --http 429" "$NPX_LOG"; then
  echo "missing retry queue enqueue call" >&2
  cat "$NPX_LOG" >&2
  exit 1
fi
