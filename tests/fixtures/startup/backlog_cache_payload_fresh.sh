#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

TEST_NOW=1000000
date() {
  printf '%s\n' "$TEST_NOW"
}

expect_fresh() {
  local name="$1" fetch_ts="$2" ttl="$3"
  if ! issue_payload_is_fresh "$fetch_ts" "$ttl"; then
    echo "expected fresh payload timestamp: $name" >&2
    exit 1
  fi
}

expect_stale() {
  local name="$1" fetch_ts="$2" ttl="$3"
  if issue_payload_is_fresh "$fetch_ts" "$ttl"; then
    echo "expected stale payload timestamp: $name" >&2
    exit 1
  fi
}

expect_fresh "now" "$TEST_NOW" 300
expect_fresh "ttl boundary" "$((TEST_NOW - 300))" 300
expect_stale "past ttl boundary" "$((TEST_NOW - 301))" 300
expect_stale "missing timestamp" 0 300
