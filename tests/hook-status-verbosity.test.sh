#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_last_log() {
  local name="$1" expected_level="$2" expected_fragment="$3"

  if [[ "${LOG_LEVELS[-1]:-}" == "$expected_level" ]] \
    && [[ "${LOG_MESSAGES[-1]:-}" == *"$expected_fragment"* ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

echo "=== Hook Status Verbosity ==="

if [[ ! -f "$COMMON_LIB" ]]; then
  fail "wavemill-common.sh not found"
else
  # shellcheck source=/dev/null
  source "$COMMON_LIB"

  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT

  declare -a LOG_LEVELS=()
  declare -a LOG_MESSAGES=()

  log() {
    local level message
    if (( $# == 1 )); then
      level="info"
      message="$1"
    else
      level="$1"
      message="$2"
    fi
    LOG_LEVELS+=("$level")
    LOG_MESSAGES+=("$message")
  }

  mkdir -p "$TMP_DIR/repo/shared/hooks"
  cat > "$TMP_DIR/repo/shared/hooks/claude-status-hook.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$TMP_DIR/repo/shared/hooks/claude-status-hook.sh"

  mkdir -p "$TMP_DIR/worktree/.claude"
  echo '{}' > "$TMP_DIR/worktree/.claude/settings.local.json"
  configure_agent_hooks "claude" "$TMP_DIR/worktree" "$TMP_DIR/repo"
  assert_last_log "claude hook setup logs at debug" "debug" "Configured Claude hook status in"

  configure_agent_hooks "codex" "$TMP_DIR/worktree" "$TMP_DIR/repo"
  assert_last_log "codex hook setup logs at debug" "debug" "Codex status tracking via JSONL event stream"

  configure_agent_hooks "cursor" "$TMP_DIR/worktree" "$TMP_DIR/repo"
  assert_last_log "generic hook setup logs at debug" "debug" "Generic agent status tracking via process monitor"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
