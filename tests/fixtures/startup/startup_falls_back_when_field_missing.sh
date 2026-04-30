#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

MISSING_DESC='{"identifier":"HOK-2","title":"Issue 2","description":"","labels":{"nodes":[]},"priority":1,"estimate":2}'
MISSING_TITLE='{"identifier":"HOK-3","title":"","description":"desc","labels":{"nodes":[]}}'
NULL_LABELS='{"identifier":"HOK-4","title":"Issue 4","description":"desc","labels":null}'

for record in "$MISSING_DESC" "$MISSING_TITLE" "$NULL_LABELS"; do
  if issue_payload_is_complete "$record"; then
    echo "FAIL: incomplete record returned exit 0: $record" >&2
    exit 1
  fi
done

COMPLETE='{"identifier":"HOK-1","title":"Issue 1","description":"A desc","labels":{"nodes":[]},"state":{"name":"Backlog"}}'
INCOMPLETE="$MISSING_DESC"
BACKLOG="[$COMPLETE,$INCOMPLETE]"
SESSION="startup-fallback-$$"
refetch_log="$(mktemp)"

for ISSUE in HOK-1 HOK-2; do
  (
    backlog_record=$(printf '%s' "$BACKLOG" | jq -c --arg id "$ISSUE" '.[] | select(.identifier == $id)' 2>/dev/null || true)
    if [[ -n "$backlog_record" ]] && issue_payload_is_complete "$backlog_record"; then
      printf '%s\n' "$backlog_record" > "/tmp/${SESSION}-${ISSUE}-issue.json"
    else
      echo "REFETCH:$ISSUE" >> "$refetch_log"
      printf '{"identifier":"%s","title":"Issue","description":"fetched","labels":{"nodes":[]}}\n' "$ISSUE" \
        > "/tmp/${SESSION}-${ISSUE}-issue.json"
    fi
  ) &
done
wait

refetch_calls="$(wc -l < "$refetch_log" | tr -d ' ')"
if [[ "$refetch_calls" != "1" ]]; then
  echo "FAIL: expected exactly 1 re-fetch, got $refetch_calls" >&2
  cat "$refetch_log" >&2
  rm -f "$refetch_log" /tmp/${SESSION}-HOK-{1,2}-issue.json
  exit 1
fi

if ! grep -q "REFETCH:HOK-2" "$refetch_log"; then
  echo "FAIL: expected HOK-2 to be re-fetched, got: $(cat "$refetch_log")" >&2
  rm -f "$refetch_log" /tmp/${SESSION}-HOK-{1,2}-issue.json
  exit 1
fi

rm -f "$refetch_log" /tmp/${SESSION}-HOK-{1,2}-issue.json
