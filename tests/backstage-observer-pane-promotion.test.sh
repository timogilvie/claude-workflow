#!/usr/bin/env bash
# Verifies that the observer pane gets the larger half of the backstage window,
# and that promotion is idempotent across repeated startup/reconcile passes.
#
# Functions are extracted from wavemill-common.sh rather than sourced, matching
# the sibling backstage tests: sourcing the whole library drags in unrelated
# startup state that is not guaranteed to exist in CI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# Top-level helpers in wavemill-common.sh always close with `}` at column 0,
# so terminate on that rather than counting braces. Brace counting has to strip
# quoted spans first, and that stripping is not portable across awk variants
# (BSD awk locally vs mawk in CI) once a function contains tmux format strings
# like '#{pane_width}' or an apostrophe in a comment.
extract_function() {
  local source_file="$1" function_name="$2"
  awk -v name="$function_name" '
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" { capture = 1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "$source_file"
}

echo "=== Observer Pane Promotion ==="

FUNCS="$(mktemp)"
trap 'rm -f "$FUNCS"' EXIT
{
  extract_function "$COMMON_SCRIPT" "wavemill_pane_area"
  echo
  extract_function "$COMMON_SCRIPT" "wavemill_promote_observer_pane"
} > "$FUNCS"

# The functions must actually have been found; an empty extraction would make
# every later assertion vacuously "pass" a no-op.
if grep -q "wavemill_pane_area()" "$FUNCS" && grep -q "wavemill_promote_observer_pane()" "$FUNCS"; then
  pass "extracted both helpers from wavemill-common.sh"
else
  fail "extracted both helpers from wavemill-common.sh"
  echo "Passed: $PASS"; echo "Failed: $FAIL"; exit 1
fi

# A truncated or malformed extraction would otherwise kill the script silently
# under `set -e`, with no indication of which step died.
if bash -n "$FUNCS" 2>/dev/null; then
  pass "extracted helpers parse as valid shell"
else
  fail "extracted helpers parse as valid shell"
  echo "--- extracted ---"; cat "$FUNCS"; echo "--- end ---"
  echo "Passed: $PASS"; echo "Failed: $FAIL"; exit 1
fi

# shellcheck source=/dev/null
source "$FUNCS"

if ! command -v tmux >/dev/null 2>&1; then
  echo "  SKIP  tmux not available; geometry assertions skipped"
  echo
  echo "Passed: $PASS"
  echo "Failed: $FAIL"
  [[ "$FAIL" -eq 0 ]]
  exit 0
fi

SESSION="wavemill-pane-promo-test-$$"
tmux kill-session -t "$SESSION" 2>/dev/null || true
if ! tmux new-session -d -s "$SESSION" -x 200 -y 60 'sleep 300' 2>/dev/null; then
  echo "  SKIP  could not start a tmux session; geometry assertions skipped"
  echo
  echo "Passed: $PASS"
  echo "Failed: $FAIL"
  [[ "$FAIL" -eq 0 ]]
  exit 0
fi
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -f "$FUNCS"' EXIT

tmux split-window -t "$SESSION:0.0" -h -p 25 'sleep 300' >/dev/null 2>&1
small_pane="$(tmux list-panes -t "$SESSION:0" -F '#{pane_id} #{pane_width}' | sort -k2 -n | head -1 | cut -d' ' -f1)"
big_pane="$(tmux list-panes -t "$SESSION:0" -F '#{pane_id} #{pane_width}' | sort -k2 -nr | head -1 | cut -d' ' -f1)"

observer_area_before="$(wavemill_pane_area "$small_pane" || true)"
tend_area_before="$(wavemill_pane_area "$big_pane" || true)"

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

wavemill_promote_observer_pane "$small_pane" "$big_pane"
observer_area_after="$(wavemill_pane_area "$small_pane" || true)"

if [[ "$observer_area_after" =~ ^[0-9]+$ ]] && (( observer_area_after > observer_area_before )); then
  pass "observer pane grew after promotion"
else
  fail "observer pane grew after promotion ($observer_area_before -> $observer_area_after)"
fi

# Idempotence: a second pass must not swap back.
wavemill_promote_observer_pane "$small_pane" "$big_pane"
observer_area_twice="$(wavemill_pane_area "$small_pane" || true)"
if [[ "$observer_area_twice" == "$observer_area_after" ]]; then
  pass "promotion is idempotent across repeated passes"
else
  fail "promotion is idempotent across repeated passes ($observer_area_after -> $observer_area_twice)"
fi

# Degenerate inputs must be no-ops rather than errors.
if wavemill_promote_observer_pane "" "$big_pane" \
  && wavemill_promote_observer_pane "$small_pane" "" \
  && wavemill_promote_observer_pane "$small_pane" "$small_pane"; then
  pass "missing or identical pane ids are a safe no-op"
else
  fail "missing or identical pane ids are a safe no-op"
fi

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"
[[ "$FAIL" -eq 0 ]]
