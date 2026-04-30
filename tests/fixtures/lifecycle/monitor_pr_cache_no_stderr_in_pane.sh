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

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/gh" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail

case "${GH_STUB_MODE:-json}" in
  fail)
    exit 1
    ;;
  empty)
    exit 0
    ;;
  json)
    if [[ -n "${GH_STUB_SLEEP:-}" ]]; then
      sleep "$GH_STUB_SLEEP"
    fi
    cat <<'JSON'
[
  {"number":42,"headRefName":"task/foo","state":"OPEN","statusCheckRollup":[]}
]
JSON
    ;;
  *)
    echo "unsupported GH_STUB_MODE=${GH_STUB_MODE:-}" >&2
    exit 2
    ;;
esac
STUB
chmod +x "$BIN_DIR/gh"

export PATH="$BIN_DIR:$PATH"
export SESSION="test-pr-cache-stderr"
export MONITOR_PR_CACHE="$TMP/pr-cache.json"

source "$COMMON"

tmp_file_count() {
  find "$TMP" -maxdepth 1 -name 'pr-cache.json.tmp.*' | wc -l | tr -d ' '
}

run_refresh() {
  local stderr_file="$1"
  if wavemill_pr_cache_refresh 2>"$stderr_file"; then
    return 0
  fi
  return $?
}

echo "=== Monitor PR Cache Stderr Hygiene ==="

# --- Test 1: failed gh stays silent and leaves no temp files ---
export GH_STUB_MODE=fail
if run_refresh "$TMP/fail.stderr"; then
  pass "failed gh returns success"
else
  fail "failed gh returned non-zero"
fi

if [[ ! -s "$TMP/fail.stderr" ]] && ! grep -q 'mv:' "$TMP/fail.stderr"; then
  pass "failed gh emits no pane-visible mv error"
else
  fail "failed gh emitted stderr: $(cat "$TMP/fail.stderr")"
fi

if [[ ! -f "$MONITOR_PR_CACHE" ]]; then
  pass "failed gh leaves no cache file"
else
  fail "failed gh wrote cache file"
fi

if [[ "$(tmp_file_count)" == "0" ]]; then
  pass "failed gh leaves no temp files"
else
  fail "failed gh left temp files behind"
fi

# --- Test 2: empty stdout stays silent and does not write malformed cache ---
export GH_STUB_MODE=empty
if run_refresh "$TMP/empty.stderr"; then
  pass "empty stdout returns success"
else
  fail "empty stdout returned non-zero"
fi

if [[ ! -s "$TMP/empty.stderr" ]] && ! grep -q 'mv:' "$TMP/empty.stderr"; then
  pass "empty stdout emits no pane-visible mv error"
else
  fail "empty stdout emitted stderr: $(cat "$TMP/empty.stderr")"
fi

if [[ ! -f "$MONITOR_PR_CACHE" ]]; then
  pass "empty stdout leaves cache absent"
elif jq empty "$MONITOR_PR_CACHE" >/dev/null 2>&1; then
  pass "empty stdout leaves valid JSON cache"
else
  fail "empty stdout wrote malformed cache"
fi

if [[ "$(tmp_file_count)" == "0" ]]; then
  pass "empty stdout leaves no temp files"
else
  fail "empty stdout left temp files behind"
fi

# --- Test 3: concurrent refreshes stay silent and both succeed ---
export GH_STUB_MODE=json
export GH_STUB_SLEEP=0.1
(
  wavemill_pr_cache_refresh 2>"$TMP/concurrent-1.stderr"
) &
pid1=$!
(
  wavemill_pr_cache_refresh 2>"$TMP/concurrent-2.stderr"
) &
pid2=$!

status1=0
status2=0
wait "$pid1" || status1=$?
wait "$pid2" || status2=$?
unset GH_STUB_SLEEP

if [[ "$status1" == "0" && "$status2" == "0" ]]; then
  pass "concurrent refreshes both return success"
else
  fail "concurrent refreshes exited $status1 and $status2"
fi

if [[ ! -s "$TMP/concurrent-1.stderr" ]] && [[ ! -s "$TMP/concurrent-2.stderr" ]] \
  && ! grep -q 'mv:' "$TMP"/concurrent-*.stderr; then
  pass "concurrent refreshes emit no pane-visible mv error"
else
  fail "concurrent refreshes emitted stderr"
fi

if [[ -f "$MONITOR_PR_CACHE" ]] && jq empty "$MONITOR_PR_CACHE" >/dev/null 2>&1; then
  pass "concurrent refreshes leave valid JSON cache"
else
  fail "concurrent refreshes did not leave valid JSON cache"
fi

if [[ "$(tmp_file_count)" == "0" ]]; then
  pass "concurrent refreshes leave no temp files"
else
  fail "concurrent refreshes left temp files behind"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
