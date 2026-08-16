#!/usr/bin/env bash
# Regression coverage for wavemill_hook_write() outside a wavemill agent context.
#
# wavemill_hook_check() enforces the no-op contract for adapter scripts by
# exiting, but wavemill_hook_write() is also called directly from long-running
# processes (the monitor loop, worktree setup). Several of those callers guard
# only on `declare -F wavemill_hook_write`, not on the env, so under `set -u`
# the unguarded expansion killed the monitor outright:
#
#   wavemill-hook-protocol.sh: line NNN: WAVEMILL_SESSION: unbound variable
#
# This took the mill down on 2026-08-16 during a resume that had to relaunch
# stale windows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== wavemill_hook_write context guard ==="

# Each case runs in its own `set -u` subshell: an unbound expansion must not
# terminate the caller, so a crash shows up as a non-zero exit here.
run_case() {
  local script="$1"
  bash -c "
    set -Eeuo pipefail
    source '$HOOK_PROTOCOL'
    $script
  " 2>&1
}

# ── No context at all ─────────────────────────────────────────────────
if out=$(run_case '
  unset WAVEMILL_SESSION WAVEMILL_ISSUE 2>/dev/null || true
  wavemill_hook_write "working" "evt" "detail" "agent"
  echo SURVIVED
'); then
  if [[ "$out" == *SURVIVED* ]]; then
    pass "unset session and issue is a no-op, not a fatal expansion"
  else
    fail "hook write did not complete with unset context: $out"
  fi
else
  fail "hook write killed the caller with unset context: $out"
fi

# ── Session set, issue missing ────────────────────────────────────────
if out=$(run_case '
  export WAVEMILL_SESSION=guardtest
  unset WAVEMILL_ISSUE 2>/dev/null || true
  wavemill_hook_write "working" "evt" "detail" "agent"
  echo SURVIVED
'); then
  [[ "$out" == *SURVIVED* ]] && pass "missing issue alone is a no-op" \
    || fail "unexpected output with missing issue: $out"
else
  fail "hook write killed the caller with missing issue: $out"
fi

# ── Issue set, session missing ────────────────────────────────────────
if out=$(run_case '
  unset WAVEMILL_SESSION 2>/dev/null || true
  export WAVEMILL_ISSUE=ISS-1
  wavemill_hook_write "working" "evt" "detail" "agent"
  echo SURVIVED
'); then
  [[ "$out" == *SURVIVED* ]] && pass "missing session alone is a no-op" \
    || fail "unexpected output with missing session: $out"
else
  fail "hook write killed the caller with missing session: $out"
fi

# ── Full context still writes normally ────────────────────────────────
GUARD_HOOK="/tmp/wavemill-guardtest-$$-ISS-2.hook"
rm -f "$GUARD_HOOK"
if out=$(run_case "
  export WAVEMILL_SESSION='guardtest-$$'
  export WAVEMILL_ISSUE='ISS-2'
  wavemill_hook_write 'working' 'evt' 'the-detail' 'agent'
  echo SURVIVED
"); then
  if [[ -f "$GUARD_HOOK" ]] \
    && [[ "$(jq -r '.state' "$GUARD_HOOK" 2>/dev/null)" == "working" ]] \
    && [[ "$(jq -r '.detail' "$GUARD_HOOK" 2>/dev/null)" == "the-detail" ]]; then
    pass "full context still writes the hook file"
  else
    fail "hook file was not written correctly with full context"
  fi
else
  fail "hook write failed with full context: $out"
fi
rm -f "$GUARD_HOOK"

# ── Unknown states remain dropped ─────────────────────────────────────
GUARD_HOOK2="/tmp/wavemill-guardtest2-$$-ISS-3.hook"
rm -f "$GUARD_HOOK2"
run_case "
  export WAVEMILL_SESSION='guardtest2-$$'
  export WAVEMILL_ISSUE='ISS-3'
  wavemill_hook_write 'bogus-state' 'evt' 'detail' 'agent'
" >/dev/null 2>&1 || true
if [[ ! -f "$GUARD_HOOK2" ]]; then
  pass "unrecognized states are still dropped"
else
  fail "unrecognized state wrote a hook file"
fi
rm -f "$GUARD_HOOK2"

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
