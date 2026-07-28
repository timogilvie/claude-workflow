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

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

TMPDIR_TEST="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_TEST"' EXIT

echo "=== Native Planning Fixture ==="
NODE_FIXTURE_LOG="$TMPDIR_TEST/native-planning-node-test.log"
if node --test --test-concurrency=1 shared/lib/native-agent/launch-planning.test.ts >"$NODE_FIXTURE_LOG" 2>&1; then
  pass "unit fixture proves native planning artifacts and mutation denial"
elif node --test --test-concurrency=1 shared/lib/native-agent/launch-planning.test.ts >"$NODE_FIXTURE_LOG" 2>&1; then
  pass "unit fixture proves native planning artifacts and mutation denial"
else
  cat "$NODE_FIXTURE_LOG"
  fail "unit fixture proves native planning artifacts and mutation denial"
fi

echo
echo "=== Shell Dispatch Guard ==="
TMUX_LOG="$TMPDIR_TEST/tmux.log"
NATIVE_LAUNCHER="/tmp/sess-HOK-2313-autonomous-launcher.sh"
NATIVE_REVIEW_LAUNCHER="/tmp/sess-HOK-2314-autonomous-launcher.sh"
source "$ADAPTERS"
unset WAVEMILL_PHASE

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
agent_validate_phase_launch() {
  AGENT_NATIVE_LAUNCH_LAST_JSON='{"ok":true,"model":"scripted-native"}'
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
agent_launch_autonomous "sess" "planning" "/tmp/instr.txt" "native-openrouter" "qwen-3-coder" "HOK-2313"

check_contains "native branch dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_LAUNCHER"
check_contains "native launcher invokes launch-native-planning tool" "$(cat "$NATIVE_LAUNCHER")" "tools/launch-native-planning.ts"
check_not_contains "native planning launcher does not execute logical provider" "$(cat "$NATIVE_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-review.log"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
routing_role_from_window() { printf '%s\n' "reviewer"; }
WAVEMILL_FEATURE_DIR="$TMPDIR_TEST/repo/features/demo" \
WAVEMILL_FEATURE_SLUG="demo" \
WAVEMILL_BRANCH="task/demo" \
WAVEMILL_BASE_BRANCH="auto/integration" \
WAVEMILL_TITLE="Demo" \
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "review" "/tmp/instr.txt" "native-openrouter" "qwen-3-coder" "HOK-2314"

check_contains "native review dispatches launcher path" "$(cat "$TMUX_LOG")" "$NATIVE_REVIEW_LAUNCHER"
check_contains "native review launcher invokes review flow tool" "$(cat "$NATIVE_REVIEW_LAUNCHER")" "tools/launch-native-review.ts"
check_not_contains "native review launcher does not execute logical provider" "$(cat "$NATIVE_REVIEW_LAUNCHER")" "native-openrouter --model"

TMUX_LOG="$TMPDIR_TEST/tmux-coding.log"
tmux() {
  printf '%s\n' "$*" >> "$TMUX_LOG"
}
CODING_PROMPT="/tmp/wavemill-HOK-2516-coding-prompt.txt"
CODING_LAUNCHER="/tmp/sess-HOK-2516-autonomous-launcher.sh"
rm -f "$CODING_LAUNCHER"
REPO_DIR="$REPO_DIR" \
agent_launch_autonomous "sess" "@95" "$CODING_PROMPT" "codex" "gpt-5.4" "HOK-2516"

check_contains "tmux id coding prompt dispatches codex launcher" "$(cat "$TMUX_LOG")" "$CODING_LAUNCHER"
check_contains "coding launcher normalizes phase from prompt" "$(cat "$CODING_LAUNCHER")" "export WAVEMILL_PHASE='coding'"
check_contains "coding launcher uses effective coder route" "$(cat "$CODING_LAUNCHER")" "codex exec --model gpt-5.4"
check_not_contains "coding launcher does not execute native provider" "$(cat "$CODING_LAUNCHER")" "native-openrouter"

BAD_NATIVE_LAUNCHER="/tmp/sess-HOK-2517-autonomous-launcher.sh"
rm -f "$BAD_NATIVE_LAUNCHER"
if REPO_DIR="$REPO_DIR" agent_launch_autonomous "sess" "@96" "/tmp/instr.txt" "native-openrouter" "qwen-3-coder" "HOK-2517" 2>"$TMPDIR_TEST/bad-native.err"; then
  fail "native launch fails closed when phase cannot be normalized"
else
  pass "native launch fails closed when phase cannot be normalized"
fi
if [[ -f "$BAD_NATIVE_LAUNCHER" ]]; then
  fail "invalid native phase does not write launcher"
else
  pass "invalid native phase does not write launcher"
fi

unset -f agent_validate_phase_launch
source "$ADAPTERS"

if WAVEMILL_PHASE="coding" agent_native_planning_eligible "$REPO_DIR" "coding"; then
  fail "coding phase isolation"
else
  pass "coding phase isolation"
fi

CODING_GUARD_REPO="$TMPDIR_TEST/coding-guard-repo"
mkdir -p "$CODING_GUARD_REPO"
cat > "$CODING_GUARD_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["task-expansion", "planning", "review"]
  }
}
EOF

if npx tsx "$REPO_DIR/tools/check-native-eligibility.ts" "$CODING_GUARD_REPO" "coding" >/dev/null 2>&1; then
  fail "native opt-in still excludes coding"
else
  pass "native opt-in still excludes coding"
fi

CODING_DISPATCH_REPO="$TMPDIR_TEST/coding-dispatch-repo"
mkdir -p "$CODING_DISPATCH_REPO"
cat > "$CODING_DISPATCH_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": true,
    "allowedPhases": ["planning", "coding", "review"],
    "patchCoding": {
      "enabled": true
    },
    "providers": {
      "openrouter": {
        "models": ["qwen-3-coder"]
      }
    }
  }
}
EOF

if npx tsx "$REPO_DIR/tools/check-native-agent-launch.ts" \
  --repo-dir "$CODING_DISPATCH_REPO" \
  --phase coding \
  --agent native-openrouter \
  --model qwen-3-coder >/dev/null 2>&1; then
  fail "native coding dispatch stays fail-closed without launcher"
else
  pass "native coding dispatch stays fail-closed without launcher"
fi

DISABLED_CONFIG_REPO="$TMPDIR_TEST/disabled-config-repo"
mkdir -p "$DISABLED_CONFIG_REPO"
cat > "$DISABLED_CONFIG_REPO/.wavemill-config.json" <<'EOF'
{
  "nativeAgent": {
    "enabled": false
  }
}
EOF

if agent_native_planning_eligible "$DISABLED_CONFIG_REPO" "planning"; then
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
