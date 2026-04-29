#!/usr/bin/env bash
# Verify that startup_render_init forces plain mode when stdout is not a TTY
# and that startup_render_set is a no-op (no ANSI escapes written to stdout).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RENDER_LIB="$REPO_DIR/shared/lib/wavemill-startup-render.sh"

if [[ ! -f "$RENDER_LIB" ]]; then
  echo "FAIL: wavemill-startup-render.sh not found at $RENDER_LIB"
  exit 1
fi

# Source render helper into the current shell
# shellcheck source=/dev/null
source "$RENDER_LIB"

SESSION="test-render-plain-$$"
TMP_DIR="$(mktemp -d /tmp/wavemill-render-plain-test.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── Test 1: stdout is non-TTY forces plain mode ──────────────────────────────
# Run startup_render_init in a subshell that captures stdout (non-TTY).
output="$(
  # Re-source to get a clean state in subshell
  # shellcheck source=/dev/null
  source "$RENDER_LIB"
  startup_render_init "$SESSION" 3
  printf '%s' "$STARTUP_RENDER_MODE"
)"

if [[ "$output" == "plain" ]]; then
  echo "PASS: non-TTY stdout → plain mode"
else
  echo "FAIL: expected plain mode, got: $output"
  exit 1
fi

# ── Test 2: WAVEMILL_STARTUP_RENDER=plain forces plain mode ──────────────────
output2="$(
  # shellcheck source=/dev/null
  source "$RENDER_LIB"
  WAVEMILL_STARTUP_RENDER=plain startup_render_init "$SESSION-2" 2
  printf '%s' "$STARTUP_RENDER_MODE"
)"

if [[ "$output2" == "plain" ]]; then
  echo "PASS: WAVEMILL_STARTUP_RENDER=plain → plain mode"
else
  echo "FAIL: expected plain mode with WAVEMILL_STARTUP_RENDER=plain, got: $output2"
  exit 1
fi

# ── Test 3: NO_COLOR set forces plain mode ────────────────────────────────────
output3="$(
  # shellcheck source=/dev/null
  source "$RENDER_LIB"
  NO_COLOR=1 startup_render_init "$SESSION-3" 2
  printf '%s' "$STARTUP_RENDER_MODE"
)"

if [[ "$output3" == "plain" ]]; then
  echo "PASS: NO_COLOR set → plain mode"
else
  echo "FAIL: expected plain mode with NO_COLOR, got: $output3"
  exit 1
fi

# ── Test 4: startup_render_set is a no-op and emits no ANSI in plain mode ─────
ansi_output="$(
  # shellcheck source=/dev/null
  source "$RENDER_LIB"
  export STARTUP_RENDER_MODE=plain
  export STARTUP_RENDER_ROWS=2
  export STARTUP_RENDER_ROWS_DIR="$TMP_DIR/rows"
  export STARTUP_RENDER_DRAW_LOCK="$TMP_DIR/draw.lock"
  export STARTUP_RENDER_LAST_DRAW="$TMP_DIR/last-draw"
  mkdir -p "$TMP_DIR/rows"
  startup_render_set 0 issue "HOK-1234"
  startup_render_set 0 route "sonnet"
)"

if [[ -z "$ansi_output" ]]; then
  echo "PASS: startup_render_set is a no-op in plain mode (no stdout)"
else
  # Check for ANSI escape sequences specifically
  if printf '%s' "$ansi_output" | grep -qP '\x1b\['; then
    echo "FAIL: startup_render_set emitted ANSI escapes in plain mode"
    exit 1
  else
    echo "PASS: startup_render_set produced no ANSI escapes in plain mode"
  fi
fi

# ── Test 5: startup_render_finalize is a no-op in plain mode ─────────────────
finalize_output="$(
  # shellcheck source=/dev/null
  source "$RENDER_LIB"
  export STARTUP_RENDER_MODE=plain
  startup_render_finalize
)"

if [[ -z "$finalize_output" ]]; then
  echo "PASS: startup_render_finalize is a no-op in plain mode"
else
  echo "FAIL: startup_render_finalize produced output in plain mode: $finalize_output"
  exit 1
fi

exit 0
