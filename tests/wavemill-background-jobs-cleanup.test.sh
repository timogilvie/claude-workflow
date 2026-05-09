#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_jq() {
  local name="$1" expr="$2" file="$3"
  if jq -e "$expr" "$file" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Background Jobs Cleanup ==="

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

STATE_FILE="$TMP_DIR/state.json"
SESSION="test-session"
export STATE_FILE SESSION

# shellcheck source=/dev/null
source "$COMMON_LIB"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "old-session",
  "tasks": {},
  "jobs": {
    "current-job": {
      "id": "current-job",
      "kind": "eval",
      "session": "test-session"
    },
    "stale-job": {
      "id": "stale-job",
      "kind": "comparison",
      "session": "prior-session"
    }
  }
}
JSON

cleanup_background_jobs_startup
assert_jq "startup keeps current-session jobs" '.jobs | has("current-job")' "$STATE_FILE"
assert_jq "startup prunes prior-session jobs" '.jobs | has("stale-job") | not' "$STATE_FILE"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "old-session",
  "tasks": {},
  "jobs": {
    "legacy-job": {
      "id": "legacy-job",
      "kind": "eval"
    },
    "current-job": {
      "id": "current-job",
      "kind": "comparison",
      "session": "test-session"
    }
  }
}
JSON

cleanup_background_jobs_startup
assert_jq "startup treats session-less jobs as stale" '.jobs | has("legacy-job") | not' "$STATE_FILE"
assert_jq "startup still keeps tagged current jobs" '.jobs | has("current-job")' "$STATE_FILE"

cat > "$STATE_FILE" <<'JSON'
{
  "session": "old-session",
  "tasks": {},
  "jobs": {
    "current-job": {
      "id": "current-job",
      "kind": "eval",
      "session": "test-session"
    },
    "other-job": {
      "id": "other-job",
      "kind": "comparison",
      "session": "other-session"
    }
  }
}
JSON

cleanup_background_jobs_shutdown
assert_jq "shutdown removes current-session jobs" '.jobs | has("current-job") | not' "$STATE_FILE"
assert_jq "shutdown preserves other-session jobs" '.jobs | has("other-job")' "$STATE_FILE"

MISSING_STATE_FILE="$TMP_DIR/missing.json"
STATE_FILE="$MISSING_STATE_FILE"
export STATE_FILE
rm -f "$STATE_FILE"

if cleanup_background_jobs_startup && [[ ! -e "$STATE_FILE" ]]; then
  pass "startup is a no-op without state file"
else
  fail "startup is a no-op without state file"
fi

if cleanup_background_jobs_shutdown && [[ ! -e "$STATE_FILE" ]]; then
  pass "shutdown is a no-op without state file"
else
  fail "shutdown is a no-op without state file"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
