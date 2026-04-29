#!/usr/bin/env bash
# Verify that startup_render_set enforces monotonic cell advancement
# (cells can only advance to higher states, never regress).
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

SESSION="test-monotonic-$$"
TMP_DIR="$(mktemp -d /tmp/wavemill-render-monotonic-test.XXXXXX)"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# ── Test: Monotonic cell advancement ──────────────────────────────────────────
# Set up a test row with tty mode to allow state tracking
export STARTUP_RENDER_MODE=tty
export STARTUP_RENDER_ROWS=1
export STARTUP_RENDER_ROWS_DIR="$TMP_DIR/rows"
export STARTUP_RENDER_DRAW_LOCK="$TMP_DIR/draw.lock"
export STARTUP_RENDER_LAST_DRAW="$TMP_DIR/last-draw"
mkdir -p "$TMP_DIR/rows"

# Initialize row file with defaults
printf -- "—\t—\t—\t—\t—\t—\t\n" > "$STARTUP_RENDER_ROWS_DIR/row-0"

# Helper: read a specific field from row-0
read_cell() {
  local field_idx="$1"
  local row_file="$STARTUP_RENDER_ROWS_DIR/row-0"
  [[ ! -f "$row_file" ]] && echo "—" && return 0
  cut -f"$((field_idx + 1))" "$row_file"
}

# Test sequence: worktree field (index 2)
field_idx=2
field_name="worktree"

# 1. Set worktree to ✓ (complete state)
startup_render_set 0 "$field_name" "✓"
cell1="$(read_cell "$field_idx")"
if [[ "$cell1" != "✓" ]]; then
  echo "FAIL: expected ✓ after first set, got: $cell1"
  exit 1
fi
echo "PASS: initial advancement to ✓ succeeded"

# 2. Attempt to set worktree back to — (regress)
startup_render_set 0 "$field_name" "—"
cell2="$(read_cell "$field_idx")"
if [[ "$cell2" != "✓" ]]; then
  echo "FAIL: expected cell to remain at ✓ after regression attempt, got: $cell2"
  exit 1
fi
echo "PASS: cell remained at ✓ (regression was prevented)"

# 3. Test with different field (route field, index 1)
field_idx=1
field_name="route"

# Set route to an intermediate state
startup_render_set 0 "$field_name" "sonnet"
cell3="$(read_cell "$field_idx")"
if [[ "$cell3" != "sonnet" ]]; then
  echo "FAIL: expected sonnet after set, got: $cell3"
  exit 1
fi
echo "PASS: set route to sonnet"

# Attempt to set route to a lower state
startup_render_set 0 "$field_name" "—"
cell4="$(read_cell "$field_idx")"
if [[ "$cell4" != "sonnet" ]]; then
  echo "FAIL: expected cell to remain at sonnet after regression attempt, got: $cell4"
  exit 1
fi
echo "PASS: cell remained at sonnet (regression was prevented)"

# 4. Test advancement through multiple states (agent field, index 4)
field_idx=4
field_name="agent"

states=("⏳" "🚀" "✓")
for state in "${states[@]}"; do
  startup_render_set 0 "$field_name" "$state"
  cell_val="$(read_cell "$field_idx")"
  if [[ "$cell_val" != "$state" ]]; then
    echo "FAIL: expected $state, got: $cell_val"
    exit 1
  fi
done
echo "PASS: advanced through multiple states successfully"

# 5. Verify final state doesn't regress
startup_render_set 0 "$field_name" "⏳"
cell_final="$(read_cell "$field_idx")"
if [[ "$cell_final" != "✓" ]]; then
  echo "FAIL: final regression attempt changed cell to: $cell_final (expected ✓)"
  exit 1
fi
echo "PASS: prevented regression from ✓ to ⏳"

exit 0
