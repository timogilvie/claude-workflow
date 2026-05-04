#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
FIXTURE="$REPO_DIR/tests/fixtures/challenge-task-packet.md"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

echo "=== Challenge Routing --file Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

STARTUP_BLOCK="$(awk '
  /challenge_args=\(--issue "\$ISSUE"/ { capture=1 }
  capture { print }
  /challenge_plan=\$\(npx tsx "\$TOOLS_DIR\/resolve-challenge-task\.ts"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

RUNTIME_BLOCK="$(awk '
  /challenge_args=\(--issue "\$issue"/ { capture=1 }
  capture { print }
  /challenge_plan=\$\(_with_timeout "\$API_TIMEOUT" npx tsx "\$TOOLS_DIR\/resolve-challenge-task\.ts"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

if [[ -n "$STARTUP_BLOCK" ]]; then
  check_contains "startup block includes feature-dir hook" "$STARTUP_BLOCK" 'challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}")'
  check_contains "startup block passes task packet file" "$STARTUP_BLOCK" 'challenge_args+=(--file "/tmp/${SESSION}-${ISSUE}-taskpacket.md")'
  check_contains "startup block resolves challenge task" "$STARTUP_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract startup challenge block"
fi

if [[ -n "$RUNTIME_BLOCK" ]]; then
  check_contains "runtime block still passes packet file" "$RUNTIME_BLOCK" 'challenge_args+=(--file "$packet_file")'
  check_contains "runtime block resolves challenge task" "$RUNTIME_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract runtime challenge block"
fi

if [[ -f "$FIXTURE" ]] && grep -q '^# Challenge Task Packet Fixture$' "$FIXTURE"; then
  pass "challenge task packet fixture exists"
else
  fail "challenge task packet fixture missing or malformed"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
