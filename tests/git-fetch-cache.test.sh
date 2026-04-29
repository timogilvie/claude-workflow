#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

STATE_FILE="$TMP/workflow-state.json"
FETCH_COUNT_FILE="$TMP/fetch-count.txt"
FETCH_ARGS_FILE="$TMP/fetch-args.txt"
BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${GIT_STUB_FAIL:-0}" == "1" ]]; then
  exit 1
fi
count=0
if [[ -f "${FETCH_COUNT_FILE:?}" ]]; then
  count=$(cat "$FETCH_COUNT_FILE")
fi
printf '%s\n' $((count + 1)) > "$FETCH_COUNT_FILE"
printf '%s\n' "$*" >> "${FETCH_ARGS_FILE:?}"
EOF
chmod +x "$BIN_DIR/git"

export PATH="$BIN_DIR:$PATH"
export REPO_DIR="$TMP/repo"
export STATE_FILE
export FETCH_COUNT_FILE
export FETCH_ARGS_FILE
export GIT_FETCH_TTL_SECONDS=60
mkdir -p "$REPO_DIR"

source "$COMMON"

echo '{"session":"test","tasks":{}}' > "$STATE_FILE"

echo "=== Fetch Cache Behavior ==="

wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "1" ]]; then
  pass "initial fetch hits git"
else
  fail "initial fetch did not hit git exactly once"
fi

initial_fetch_at="$(jq -r '.baseBranchFetchCache.main.last_fetch_at // empty' "$STATE_FILE")"
if [[ "$initial_fetch_at" =~ ^[0-9]+$ ]]; then
  pass "initial fetch stores last_fetch_at"
else
  fail "initial fetch did not store last_fetch_at"
fi

wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "1" ]]; then
  pass "second fetch within TTL is skipped"
else
  fail "second fetch within TTL should have been skipped"
fi

wavemill_fetch_base_branch "main" --force
if [[ "$(cat "$FETCH_COUNT_FILE")" == "2" ]]; then
  pass "forced fetch bypasses cache"
else
  fail "forced fetch did not bypass cache"
fi

GIT_FETCH_TTL_SECONDS=0 wavemill_fetch_base_branch "main"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "3" ]]; then
  pass "TTL 0 always fetches"
else
  fail "TTL 0 did not force a fetch"
fi

wavemill_fetch_base_branch "develop"
if [[ "$(cat "$FETCH_COUNT_FILE")" == "4" ]]; then
  pass "cache is tracked per branch"
else
  fail "branch-specific cache key did not trigger a new fetch"
fi

echo '{"session":"test","tasks":{}}' > "$STATE_FILE"
export GIT_STUB_FAIL=1
if wavemill_fetch_base_branch "main"; then
  fail "failed fetch should return non-zero"
else
  pass "failed fetch returns non-zero"
fi
unset GIT_STUB_FAIL

failed_fetch_at="$(jq -r '.baseBranchFetchCache.main.last_fetch_at // empty' "$STATE_FILE")"
if [[ -z "$failed_fetch_at" ]]; then
  pass "failed fetch does not update cache state"
else
  fail "failed fetch updated cache state"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
