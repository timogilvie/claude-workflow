#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
COMMON="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GH_CALL_COUNT_FILE="$TMP/gh-call-count.txt"
echo "0" > "$GH_CALL_COUNT_FILE"

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${GH_STUB_FAIL:-0}" == "1" ]]; then
  exit 1
fi
count=$(cat "${GH_CALL_COUNT_FILE:?}")
printf '%s\n' $((count + 1)) > "$GH_CALL_COUNT_FILE"
cat <<'JSON'
[
  {"number":42,"headRefName":"task/foo","state":"OPEN","statusCheckRollup":[]},
  {"number":99,"headRefName":"task/bar","state":"OPEN","statusCheckRollup":[]}
]
JSON
STUB
chmod +x "$BIN_DIR/gh"

export PATH="$BIN_DIR:$PATH"
export SESSION="test-pr-cache"
export MONITOR_PR_CACHE="$TMP/pr-cache.json"
export GH_CALL_COUNT_FILE

source "$COMMON"

echo "=== Monitor PR Cache Behavior ==="

# --- Test 1: single gh call after refresh ---
wavemill_pr_cache_refresh
count=$(cat "$GH_CALL_COUNT_FILE")
if [[ "$count" == "1" ]]; then
  pass "refresh calls gh exactly once"
else
  fail "refresh called gh $count times, expected 1"
fi

# --- Test 2: lookups use cache, no extra gh calls ---
result_foo=$(wavemill_pr_lookup_by_branch "task/foo")
result_bar=$(wavemill_pr_lookup_by_branch "task/bar")
result_missing=$(wavemill_pr_lookup_by_branch "task/missing")
count=$(cat "$GH_CALL_COUNT_FILE")

if [[ "$count" == "1" ]]; then
  pass "3 lookups produce no additional gh calls"
else
  fail "lookups triggered gh calls: count=$count, expected 1"
fi

if [[ "$result_foo" == "42" ]]; then
  pass "lookup returns correct PR for task/foo"
else
  fail "lookup for task/foo returned '$result_foo', expected '42'"
fi

if [[ "$result_bar" == "99" ]]; then
  pass "lookup returns correct PR for task/bar"
else
  fail "lookup for task/bar returned '$result_bar', expected '99'"
fi

if [[ -z "$result_missing" ]]; then
  pass "lookup returns empty for missing branch"
else
  fail "lookup for missing branch returned '$result_missing', expected empty"
fi

# --- Test 3: second refresh re-fetches (no cross-cycle staleness) ---
wavemill_pr_cache_refresh
count=$(cat "$GH_CALL_COUNT_FILE")
if [[ "$count" == "2" ]]; then
  pass "second refresh re-fetches (no cross-cycle staleness)"
else
  fail "second refresh: count=$count, expected 2"
fi

# --- Test 4: failed gh leaves no cache file ---
rm -f "$MONITOR_PR_CACHE"
echo "0" > "$GH_CALL_COUNT_FILE"
export GH_STUB_FAIL=1
wavemill_pr_cache_refresh
unset GH_STUB_FAIL

if [[ ! -f "$MONITOR_PR_CACHE" ]]; then
  pass "failed gh leaves no cache file"
else
  fail "failed gh wrote cache file"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
