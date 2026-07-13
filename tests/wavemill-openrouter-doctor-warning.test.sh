#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/fixtures/lifecycle/tend-fixture-lib.sh"

require_tend_runtime
create_tend_fixture_root "wavemill-openrouter-warning"
trap cleanup_tend_fixture_root EXIT

STDOUT_FILE="$TMP_DIR/stdout.log"
STDERR_FILE="$TMP_DIR/stderr.log"
LAUNCH_PLAN_FILE="$TMP_DIR/launch-plan.json"
BACKLOG_FILE="$TMP_DIR/backlog.json"
GIT_CALL_LOG="$TMP_DIR/git-calls.log"
STATUS_LOG_FILE="/tmp/openrouter-warning-$$-mill-status.log"
export GIT_CALL_LOG
: > "$GIT_CALL_LOG"
rm -f "$STATUS_LOG_FILE"

mkdir -p "$REPO_DIR/.wavemill" "$TMP_DIR/worktrees" "$TMP_DIR/home"

cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "linear": { "project": "Fixture Project" },
  "mill": {
    "agentCmd": "codex",
    "baseBranch": "auto/integration",
    "worktreeRoot": "$TMP_DIR/worktrees",
    "maxParallel": 1,
    "requireConfirm": false
  },
  "taskSelection": { "enterLaunchesWave": true }
}
EOF

cat > "$BACKLOG_FILE" <<'EOF'
[
  {
    "id": "issue-1",
    "identifier": "HOK-2502",
    "title": "Test OpenRouter warning",
    "description": "Dry-run launch plan fixture.",
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

REAL_NPX="$(command -v npx)"
REAL_TSX="$(command -v tsx)"
cat > "$FAKE_BIN/npx" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "tsx" && "\${2:-}" == *"/openrouter-doctor.ts" ]]; then
  case "\${OPENROUTER_DOCTOR_MODE:-warn}" in
    warn)
      printf '%s\n' 'OpenRouter configured but no eligible openrouter candidates (missing_api_key). Run wavemill doctor openrouter.'
      exit 0
      ;;
    fail)
      printf '%s\n' 'doctor failed' >&2
      exit 1
      ;;
  esac
fi

if [[ "\${1:-}" == "tsx" ]]; then
  shift
  export PATH="$FAKE_BIN:\$PATH"
  exec "$REAL_TSX" "\$@"
fi

exec "$REAL_NPX" "\$@"
EOF
chmod +x "$FAKE_BIN/npx"

export GIT_COMMON_DIR="$GIT_DIR"
export HOME="$TMP_DIR/home"
export STATE_DIR="$TMP_DIR/state"
export SESSION="openrouter-warning-$$"
export SKIP_CONFIG_CHECK=true
export SKIP_CONTEXT_CHECK=true
export WAVEMILL_NO_PROGRESS=1
export REQUIRE_CONFIRM=false

run_case() {
  local expected_status="$1"
  local doctor_mode="$2"

  : > "$STDOUT_FILE"
  : > "$STDERR_FILE"
  rm -f "$LAUNCH_PLAN_FILE"
  rm -f "$STATUS_LOG_FILE"

  set +e
  (
    cd "$REPO_DIR"
    unset WAVEMILL_MILL_ACTIVE
    export OPENROUTER_DOCTOR_MODE="$doctor_mode"
    printf '\n' | "$REPO_ROOT/wavemill" mill \
      --dry-run \
      --dry-run-plan-out "$LAUNCH_PLAN_FILE" \
      --dry-run-backlog "$BACKLOG_FILE" \
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

run_case 0 warn

stderr_warning_count="$(grep -c 'wavemill doctor openrouter' "$STDERR_FILE" || true)"
stdout_warning_count="$(grep -c 'wavemill doctor openrouter' "$STDOUT_FILE" || true)"
status_warning_count="$(grep -c 'wavemill doctor openrouter' "$STATUS_LOG_FILE" || true)"
warning_count=$((stderr_warning_count + stdout_warning_count + status_warning_count))
if [[ "$warning_count" -ne 1 ]]; then
  echo "FAIL: expected one OpenRouter warning log"
  [[ -s "$STDOUT_FILE" ]] && { echo "--- stdout ---"; cat "$STDOUT_FILE"; }
  [[ -s "$STDERR_FILE" ]] && { echo "--- stderr ---"; cat "$STDERR_FILE"; }
  exit 1
fi

run_case 0 fail

if grep -q 'wavemill doctor openrouter' "$STDERR_FILE" \
  || grep -q 'wavemill doctor openrouter' "$STDOUT_FILE" \
  || grep -q 'wavemill doctor openrouter' "$STATUS_LOG_FILE"; then
  echo "FAIL: expected failing doctor path to stay silent"
  [[ -s "$STDOUT_FILE" ]] && { echo "--- stdout ---"; cat "$STDOUT_FILE"; }
  [[ -s "$STDERR_FILE" ]] && { echo "--- stderr ---"; cat "$STDERR_FILE"; }
  exit 1
fi

echo "PASS: wavemill mill emits one OpenRouter warning and ignores doctor failures"
