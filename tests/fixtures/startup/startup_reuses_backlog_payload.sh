#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

COMPLETE='{"identifier":"HOK-1","title":"Test Issue","description":"A description","labels":{"nodes":[{"name":"Area: Core"}]},"priority":2,"estimate":3,"state":{"name":"Backlog"}}'

if ! issue_payload_is_complete "$COMPLETE"; then
  echo "FAIL: complete record returned non-zero from issue_payload_is_complete" >&2
  exit 1
fi

refetch_log="$(mktemp)"
linear_get_issue() { echo "REFETCH:$1" >> "$refetch_log"; echo '{}'; }
BACKLOG="[$COMPLETE]"
SESSION="startup-reuse-$$"

ISSUE="HOK-1"
backlog_record=$(printf '%s' "$BACKLOG" | jq -c --arg id "$ISSUE" '.[] | select(.identifier == $id)' 2>/dev/null || true)
if [[ -n "$backlog_record" ]] && issue_payload_is_complete "$backlog_record"; then
  printf '%s\n' "$backlog_record" > "/tmp/${SESSION}-${ISSUE}-issue.json"
else
  json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
  printf '%s\n' "$json" > "/tmp/${SESSION}-${ISSUE}-issue.json"
fi

refetch_calls="$(wc -l < "$refetch_log" | tr -d ' ')"
if [[ "$refetch_calls" != "0" ]]; then
  echo "FAIL: expected 0 re-fetches, got $refetch_calls" >&2
  rm -f "$refetch_log" "/tmp/${SESSION}-${ISSUE}-issue.json"
  exit 1
fi

written="$(jq -r '.description' "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "")"
if [[ "$written" != "A description" ]]; then
  echo "FAIL: issue.json description mismatch: '$written'" >&2
  rm -f "$refetch_log" "/tmp/${SESSION}-${ISSUE}-issue.json"
  exit 1
fi

rm -f "$refetch_log" "/tmp/${SESSION}-${ISSUE}-issue.json"
