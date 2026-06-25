#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ADAPTERS="$REPO_DIR/shared/lib/agent-adapters.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_file() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$name"
  else
    echo "    missing: $path"
    fail "$name"
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "=== Native Planning Fixture ==="
node --test shared/lib/native-agent/launch-planning.test.ts >/dev/null
pass "unit fixture proves native planning artifacts and mutation denial"

echo
echo "=== Shell Dispatch Guard ==="
TMUX_LOG="$TMPDIR_TEST/tmux.log"
NATIVE_LAUNCHER="/tmp/sess-HOK-2313-autonomous-launcher.sh"
source "$ADAPTERS"

tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
agent_resolve_dashboard_pid() { printf '%s\n' "123"; }
agent_hooks_dir() { printf '%s\n' "$REPO_DIR/shared/hooks"; }
agent_validate_model() { return 0; }
agent_resolve_model() { printf '%s\n' "$2"; }
agent_write_initial_status() { :; }
routing_role_from_window() { printf '%s\n' "planner"; }
routing_emit_phase() { :; }
agent_native_planning_eligible() {
  AGENT_NATIVE_PLANNING_MODEL="scripted-native"
  return 0
}

mkdir -p "$TMPDIR_TEST/repo/features/demo"
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
WAVEMILL_FEATURE_SLUG="demo" \
WAVEMILL_PLAN_DEPTH="medium" \
WAVEMILL_OPERATING_MODE="normal" \
WAVEMILL_BRANCH="task/demo" \
WAVEMILL_BASE_BRANCH="auto/integration" \
WAVEMILL_TITLE="Demo" \
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "planning" "/tmp/instr.txt" "codex" "gpt-5.4" "HOK-2313"

check_contains "native branch dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_LAUNCHER"
check_contains "native launcher invokes launch-native-planning tool" "$(cat "$NATIVE_LAUNCHER")" "tools/launch-native-planning.ts"

unset -f agent_native_planning_eligible
source "$ADAPTERS"

if WAVEMILL_PHASE="coding" agent_native_planning_eligible "$REPO_DIR" "coding"; then
  fail "coding phase isolation"
else
  pass "coding phase isolation"
fi

if agent_native_planning_eligible "$REPO_DIR" "planning"; then
  fail "disabled config stays ineligible"
else
  pass "disabled config stays ineligible"
fi

echo
if [[ "$FAIL" -ne 0 ]]; then
  echo "FAIL: $FAIL checks failed ($PASS passed)"
  exit 1
fi
echo "PASS: $PASS checks passed"
