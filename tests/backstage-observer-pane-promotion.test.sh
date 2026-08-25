#!/usr/bin/env bash
# Verifies that the observer pane gets the larger half of the backstage window,
# and that promotion is idempotent across repeated startup/reconcile passes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

if ! command -v tmux >/dev/null 2>&1; then
  echo "tmux not available; skipping backstage pane promotion test"
  exit 0
fi

SESSION="wavemill-pane-promo-test-$$"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 200 -y 60 'sleep 300' 2>/dev/null || {
  echo "could not start tmux session; skipping"
  exit 0
}
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true' EXIT

big_pane="$(tmux display-message -p -t "$SESSION:0.0" '#{pane_id}')"
# Small pane on the right, mimicking the observer's original corner.
tmux split-window -t "$SESSION:0.0" -h -p 25 'sleep 300' >/dev/null 2>&1
small_pane="$(tmux display-message -p -t "$SESSION:0" '#{pane_id}' 2>/dev/null)"
small_pane="$(tmux list-panes -t "$SESSION:0" -F '#{pane_id} #{pane_width}' | sort -k2 -n | head -1 | cut -d' ' -f1)"

echo "=== Observer Pane Promotion ==="

area_of() { wavemill_pane_area "$1"; }

observer_area_before="$(area_of "$small_pane")"
tend_area_before="$(area_of "$big_pane")"

if [[ "$observer_area_before" =~ ^[0-9]+$ && "$tend_area_before" =~ ^[0-9]+$ ]]; then
  pass "wavemill_pane_area reports numeric areas"
else
  fail "wavemill_pane_area reports numeric areas (got '$observer_area_before' / '$tend_area_before')"
fi

if (( observer_area_before < tend_area_before )); then
  pass "observer starts in the smaller pane"
else
  fail "observer starts in the smaller pane"
fi

# Promote: the observer's content should end up in the larger pane.
wavemill_promote_observer_pane "$small_pane" "$big_pane"

observer_area_after="$(area_of "$small_pane")"
if (( observer_area_after > observer_area_before )); then
  pass "observer pane grew after promotion"
else
  fail "observer pane grew after promotion ($observer_area_before -> $observer_area_after)"
fi

# Idempotence: a second pass must not swap back.
wavemill_promote_observer_pane "$small_pane" "$big_pane"
observer_area_twice="$(area_of "$small_pane")"
if [[ "$observer_area_twice" == "$observer_area_after" ]]; then
  pass "promotion is idempotent across repeated passes"
else
  fail "promotion is idempotent across repeated passes ($observer_area_after -> $observer_area_twice)"
fi

# Degenerate inputs must be no-ops rather than errors.
if wavemill_promote_observer_pane "" "$big_pane" && wavemill_promote_observer_pane "$small_pane" "" \
  && wavemill_promote_observer_pane "$small_pane" "$small_pane"; then
  pass "missing or identical pane ids are a safe no-op"
else
  fail "missing or identical pane ids are a safe no-op"
fi

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
