#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/fixtures/lifecycle/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-mill-model-flags"
trap cleanup_tend_fixture_root EXIT

GH_CALL_LOG="$TMP_DIR/gh-calls.log"
GIT_CALL_LOG="$TMP_DIR/git-calls.log"
TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
STDOUT_FILE="$TMP_DIR/stdout.log"
STDERR_FILE="$TMP_DIR/stderr.log"
LAUNCH_PLAN_FILE="$TMP_DIR/launch-plan.json"
BACKLOG_FILE="$TMP_DIR/backlog.json"
export GH_CALL_LOG GIT_CALL_LOG TMUX_CALL_LOG
: > "$GH_CALL_LOG"
: > "$GIT_CALL_LOG"
: > "$TMUX_CALL_LOG"

mkdir -p "$REPO_DIR/.wavemill" "$TMP_DIR/worktrees" "$TMP_DIR/home"

cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "linear": {
    "project": "Fixture Project"
  },
  "mill": {
    "agentCmd": "codex",
    "baseBranch": "auto/integration",
    "worktreeRoot": "$TMP_DIR/worktrees",
    "maxParallel": 2,
    "requireConfirm": false
  },
  "taskSelection": {
    "enterLaunchesWave": true
  }
}
EOF

cat > "$BACKLOG_FILE" <<'EOF'
[
  {
    "id": "issue-1",
    "identifier": "HOK-1631",
    "title": "Accept family aliases and inherit on mill flags",
    "description": "Validate selector-token support in wavemill mill dry-run mode.",
    "priority": 2,
    "estimate": 3,
    "state": { "name": "Backlog" },
    "labels": { "nodes": [] },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  }
]
EOF

write_fake_git
write_fake_gh
write_fake_tmux
write_fake_npx
export GIT_COMMON_DIR="$GIT_DIR"
export HOME="$TMP_DIR/home"
export STATE_DIR="$TMP_DIR/state"
export SESSION="mill-model-flags-$$"
export SKIP_CONFIG_CHECK=true
export SKIP_CONTEXT_CHECK=true
export WAVEMILL_SKIP_CERTIFICATION_COVERAGE_GUARD=1
export WAVEMILL_NO_PROGRESS=1
export REQUIRE_CONFIRM=false
export GH_REPO="acme/wavemill"

run_mill_case() {
  local expected_status="$1"
  shift

  : > "$STDOUT_FILE"
  : > "$STDERR_FILE"
  rm -f "$LAUNCH_PLAN_FILE"

  set +e
  (
    cd "$REPO_DIR"
    unset WAVEMILL_MILL_ACTIVE
    printf '\n' | "$REPO_ROOT/wavemill" mill \
      --dry-run \
      --dry-run-plan-out "$LAUNCH_PLAN_FILE" \
      --dry-run-backlog "$BACKLOG_FILE" \
      "$@" \
      >"$STDOUT_FILE" 2>"$STDERR_FILE"
  )
  local status=$?
  set -e

  if [[ "$status" -ne "$expected_status" ]]; then
    echo "FAIL: expected exit $expected_status, got $status"
    [[ -s "$STDERR_FILE" ]] && { echo "--- stderr ---"; cat "$STDERR_FILE"; }
    [[ -s "$STDOUT_FILE" ]] && { echo "--- stdout ---"; cat "$STDOUT_FILE"; }
    exit 1
  fi
}

assert_route_models() {
  local planner="$1"
  local coder="$2"
  local reviewer="$3"

  if [[ ! -f "$LAUNCH_PLAN_FILE" ]]; then
    echo "FAIL: launch plan was not written"
    exit 1
  fi

  if ! jq -e \
    --arg planner "$planner" \
    --arg coder "$coder" \
    --arg reviewer "$reviewer" \
    'all(.tasks[]; .route.planner == $planner and .route.coder == $coder and .route.reviewer == $reviewer)' \
    "$LAUNCH_PLAN_FILE" >/dev/null; then
    echo "FAIL: unexpected route models in launch plan"
    cat "$LAUNCH_PLAN_FILE"
    exit 1
  fi
}

run_mill_case 0 --model opus
assert_route_models "opus" "opus" "opus"

run_mill_case 0 --model inherit
assert_route_models "inherit" "inherit" "inherit"

run_mill_case 0 --planner-model opus --coder-model inherit --reviewer-model claude-haiku-4-5-20251001
assert_route_models "opus" "inherit" "claude-haiku-4-5-20251001"

run_mill_case 1 --model gpt-4
grep -q 'Invalid FORCE_MODEL: gpt-4' "$STDERR_FILE" || {
  echo "FAIL: expected invalid FORCE_MODEL error"
  cat "$STDERR_FILE"
  exit 1
}

run_mill_case 1 --model
grep -q -- '--model requires a value' "$STDERR_FILE" || {
  echo "FAIL: expected missing value error for --model"
  cat "$STDERR_FILE"
  exit 1
}

run_mill_case 1 --coder-model ""
grep -q -- '--coder-model requires a value' "$STDERR_FILE" || {
  echo "FAIL: expected empty value error for --coder-model"
  cat "$STDERR_FILE"
  exit 1
}

run_mill_case 1 --model opus --planner-model sonnet
grep -q -- '--model cannot be combined with --planner-model, --coder-model, or --reviewer-model' "$STDERR_FILE" || {
  echo "FAIL: expected mixed override error"
  cat "$STDERR_FILE"
  exit 1
}

# REQ-F10: validator unavailable → non-zero exit, never silently accept
(
  NO_TSX_BIN="$TMP_DIR/no-tsx-bin"
  REAL_NODE_BIN="$(command -v node || true)"
  mkdir -p "$NO_TSX_BIN"
  for f in "$FAKE_BIN"/*; do
    cp "$f" "$NO_TSX_BIN/"
  done
  # Shadow all TypeScript runner paths with stubs that fail for model-validator calls.
  cat > "$NO_TSX_BIN/node" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--import" && "\${2:-}" == "tsx" ]]; then
  echo "node: tsx loader not available" >&2
  exit 127
fi
exec "$REAL_NODE_BIN" "\$@"
EOF
  printf '#!/usr/bin/env bash\necho "tsx: not available" >&2\nexit 127\n' > "$NO_TSX_BIN/tsx"
  printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "tsx" ]]; then echo "npx: tsx not found" >&2; exit 127; fi\n' > "$NO_TSX_BIN/npx"
  chmod +x "$NO_TSX_BIN/node" "$NO_TSX_BIN/tsx" "$NO_TSX_BIN/npx"
  export PATH="${PATH/$FAKE_BIN/$NO_TSX_BIN}"
  run_mill_case 1 --model opus
  grep -qE 'model validation requires|Invalid FORCE_MODEL' "$STDERR_FILE" || {
    echo "FAIL: expected clear error when validator unavailable (REQ-F10)"
    cat "$STDERR_FILE"
    exit 1
  }
)

echo "PASS: wavemill mill model flag selectors"
