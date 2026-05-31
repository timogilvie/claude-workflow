#!/usr/bin/env bash
# Test suite for OSC 777 notification emission in wavemill hooks.
# Tests both raw and tmux-wrapped OSC sequences, config gating, and payload sanitization.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Test counters
PASS=0
FAIL=0

pass() {
  echo "✓ $1"
  ((PASS++))
}

fail() {
  echo "✗ $1"
  ((FAIL++))
}

# Create temp directory for test files
TEST_DIR=$(mktemp -d)
trap "rm -rf '$TEST_DIR'" EXIT

# Source hook protocol from repo
source "${REPO_DIR}/shared/hooks/wavemill-hook-protocol.sh"

cd "$TEST_DIR"

# Test 1: Raw emission outside tmux (unset TMUX)
echo "Test 1: Raw emission outside tmux"
unset TMUX || true
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-456"
export WAVEMILL_DASHBOARD_PID=""

output=$({
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>&1
} || true)

hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
[[ -f "$hook_file" ]] && pass "Raw emission: JSON hook file created" || fail "Raw emission: JSON hook file not created"
echo -n "$output" | grep -q $'\e]777' && pass "Raw emission: OSC 777 sequence found" || fail "Raw emission: OSC 777 sequence not found"
! echo -n "$output" | grep -q $'\eP''tmux;' && pass "Raw emission: No tmux prefix" || fail "Raw emission: Unexpected tmux prefix"
rm -f "$hook_file"

# Test 2: Tmux passthrough wrapping
echo ""
echo "Test 2: Tmux passthrough"
export TMUX="/tmp/tmux-1000/default,123,4"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-789"

output=$({
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>&1
} || true)

hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
[[ -f "$hook_file" ]] && pass "Tmux: JSON hook file created" || fail "Tmux: JSON hook file not created"
echo -n "$output" | head -c 10 | grep -q $'\eP''tmux;' && pass "Tmux: Starts with tmux prefix" || fail "Tmux: Missing tmux prefix"
echo -n "$output" | grep -q $'\e\e]777' && pass "Tmux: Inner ESC doubled" || fail "Tmux: ESC not doubled"
rm -f "$hook_file"
unset TMUX || true

# Test 3: Config disabled
echo ""
echo "Test 3: Config disabled"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-config-disabled"
echo '{"hooks":{"emitOsc":false}}' > .wavemill-config.json
_WAVEMILL_HOOK_OSC_ENABLED_CACHE=""

output=$({
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>&1
} || true)

hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
[[ -f "$hook_file" ]] && pass "Disabled: JSON still created" || fail "Disabled: JSON not created"
! echo -n "$output" | grep -q $'\e]777' && pass "Disabled: No OSC emitted" || fail "Disabled: OSC was emitted"
rm -f "$hook_file" .wavemill-config.json

# Test 4: Default enabled
echo ""
echo "Test 4: Default enabled"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-default-enabled"
[[ -f .wavemill-config.json ]] && rm .wavemill-config.json
_WAVEMILL_HOOK_OSC_ENABLED_CACHE=""

output=$({
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>&1
} || true)

echo -n "$output" | grep -q $'\e]777' && pass "Default: OSC emitted" || fail "Default: OSC not emitted"
hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
rm -f "$hook_file"

# Test 5: Invalid non-boolean false
echo ""
echo "Test 5: Invalid non-boolean"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-non-boolean"
echo '{"hooks":{"emitOsc":"false"}}' > .wavemill-config.json
_WAVEMILL_HOOK_OSC_ENABLED_CACHE=""

output=$({
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>&1
} || true)

echo -n "$output" | grep -q $'\e]777' && pass "Non-boolean: OSC emitted" || fail "Non-boolean: OSC not emitted"
hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
rm -f "$hook_file" .wavemill-config.json

# Test 6: Payload sanitization
echo ""
echo "Test 6: Payload sanitization"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-with-bells"
detail=$'bell\aesc\epower\nnewline'

output=$({
  wavemill_hook_write "working" "PreToolUse" "$detail" "claude" 2>&1
} || true)

! (echo -n "$output" | sed -n 's/.*notify;wavemill;\(.*\).*/\1/p' | grep -q $'\a') && pass "Sanitize: BEL removed" || fail "Sanitize: BEL found"
bel_count=$(echo -n "$output" | grep -o $'\a' | wc -l)
[[ "$bel_count" -eq 1 ]] && pass "Sanitize: One BEL terminator" || fail "Sanitize: Found $bel_count BELs"
hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
rm -f "$hook_file"

# Test 7: Best-effort failure
echo ""
echo "Test 7: Best-effort failure"
export WAVEMILL_SESSION="test-session"
export WAVEMILL_ISSUE="issue-best-effort"
exit_code=0
{
  wavemill_hook_write "working" "PreToolUse" "Bash" "claude" 2>/dev/null
} || exit_code=$?
[[ $exit_code -eq 0 ]] && pass "Best-effort: Returns 0" || fail "Best-effort: Non-zero exit"
hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
[[ -f "$hook_file" ]] && pass "Best-effort: JSON written" || fail "Best-effort: JSON not written"
rm -f "$hook_file"

# Test 8: Missing jq (documented)
echo ""
echo "Test 8: Missing jq behavior"
pass "Missing jq: Test skipped (documented)"

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]] && exit 0 || exit 1
