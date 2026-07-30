#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON="$REPO_ROOT/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BIN_DIR="$TMP/bin"
mkdir -p "$BIN_DIR"

cat > "$BIN_DIR/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "-C" ]]; then
  shift 2
fi

case "${1:-}" in
  fetch)
    exit "${GIT_STUB_FETCH_RC:-0}"
    ;;
  show-ref)
    shift
    if [[ "${1:-}" == "--verify" ]]; then shift; fi
    if [[ "${1:-}" == "--quiet" ]]; then shift; fi
    ref="${1:-}"
    if [[ -f "${GIT_STUB_REFS_FILE:?}" ]] && grep -Fxq "$ref" "$GIT_STUB_REFS_FILE"; then
      exit 0
    fi
    exit 1
    ;;
  symbolic-ref)
    if [[ "${GIT_STUB_DEFAULT_BRANCH:-}" ]]; then
      printf '%s\n' "$GIT_STUB_DEFAULT_BRANCH"
      exit 0
    fi
    exit 1
    ;;
  rev-parse)
    exit 1
    ;;
esac

exit 1
EOF
chmod +x "$BIN_DIR/git"

export PATH="$BIN_DIR:$PATH"
export REPO_DIR="$TMP/repo"
export STATE_FILE="$TMP/workflow-state.json"
export GIT_STUB_REFS_FILE="$TMP/refs.txt"
export GIT_FETCH_TTL_SECONDS=0
mkdir -p "$REPO_DIR"
printf '{"tasks":{}}\n' > "$STATE_FILE"
source "$COMMON"

run_preflight() {
  local branch="$1" out="$TMP/preflight.json" rc=0
  rm -f "$out"
  wavemill_base_ref_preflight "$branch" --force-fetch --json-out "$out" || rc=$?
  printf '%s\n' "$rc"
}

echo "=== Base Ref Preflight ==="

: > "$GIT_STUB_REFS_FILE"
printf '%s\n' "refs/remotes/origin/main" >> "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=0
export GIT_STUB_DEFAULT_BRANCH="origin/main"
rc="$(run_preflight "auto/integration")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_unavailable" ]]; then
  pass "absent remote branch reports unavailable"
else
  fail "absent remote branch did not report base_ref_unavailable"
fi
if [[ "$(jq -r '.checkedRefs | join(",")' <<<"$json")" == "refs/heads/auto/integration,refs/remotes/origin/auto/integration" ]]; then
  pass "checked refs include local and origin refs"
else
  fail "checked refs missing expected local/origin refs"
fi
diagnostic="$(wavemill_format_base_ref_preflight_failure "$json")"
if grep -q 'Available default branch: origin/main.' <<<"$diagnostic"; then
  pass "failure diagnostic includes default branch"
else
  fail "failure diagnostic omitted default branch"
fi

: > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=0
unset GIT_STUB_DEFAULT_BRANCH
rc="$(run_preflight "missing")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_unavailable" ]] && [[ "$(jq -r 'has("resolvedRef")' <<<"$json")" == "false" ]]; then
  pass "absent local and remote branch has no resolved ref"
else
  fail "absent local and remote branch resolved unexpectedly"
fi

printf '%s\n' "refs/heads/main" > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -eq 0 ]] && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]] && [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/heads/main" ]]; then
  pass "fetch failure proceeds with valid local branch"
else
  fail "fetch failure did not use valid local branch"
fi

printf '%s\n' "refs/remotes/origin/main" > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -eq 0 ]] && [[ "$(jq -r '.fetchDegraded' <<<"$json")" == "true" ]] && [[ "$(jq -r '.resolvedRef' <<<"$json")" == "refs/remotes/origin/main" ]]; then
  pass "fetch failure proceeds with valid remote-tracking branch"
else
  fail "fetch failure did not use valid remote-tracking branch"
fi

: > "$GIT_STUB_REFS_FILE"
export GIT_STUB_FETCH_RC=42
rc="$(run_preflight "main")"
json="$(cat "$TMP/preflight.json")"
if [[ "$rc" -ne 0 ]] && [[ "$(jq -r '.reason' <<<"$json")" == "base_ref_fetch_failed" ]]; then
  pass "fetch failure with no fallback reports fetch failure"
else
  fail "fetch failure with no fallback reason was not base_ref_fetch_failed"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
