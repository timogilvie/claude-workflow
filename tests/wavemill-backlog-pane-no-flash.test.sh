#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

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

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

FUNC_FILE="$TMP_DIR/pane-repaint.sh"
extract_function "$COMMON_SCRIPT" "wavemill_pane_repaint" > "$FUNC_FILE"

if [[ ! -s "$FUNC_FILE" ]]; then
  echo "Could not extract wavemill_pane_repaint"
  exit 1
fi

render_with_helper() {
  local first_frame="$1" second_frame="$2"
  FUNCTIONS_FILE="$FUNC_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"

    frame1=$(wavemill_pane_repaint "$0")
    frame2=$(wavemill_pane_repaint "$1")
    printf "%s<FRAME2>%s" "$frame1" "$frame2"
  ' "$first_frame" "$second_frame"
}

test_repaint_never_uses_full_screen_clear() {
  local output long short
  long=$'Next tasks:\n  1. HOK-1 - Long item\n  2. HOK-2 - Another item\n\nEnter number(s)...'
  short=$'Next tasks:\n  1. HOK-1 - Long item\n\nEnter number(s)...'
  output="$(render_with_helper "$long" "$short")"

  check_not_contains "no full-screen clear" "$output" $'\033[2J'
  check_not_contains "no terminal reset" "$output" $'\033c'
}

test_repaint_starts_with_content() {
  local output frame first_ten
  frame=$'Next tasks:\n  1. HOK-1 - Item\n\nEnter number(s)...'
  output="$(render_with_helper "$frame" "$frame")"
  first_ten="${output:0:10}"
  check_contains "starts with heading" "$first_ten" "Next tasks"
}

test_shorter_frame_clears_trailing_lines() {
  local output frame2
  output="$(render_with_helper $'Next tasks:\n  1. A\n  2. B\n\nPrompt' $'Next tasks:\n  1. A\n\nPrompt')"
  frame2="${output#*<FRAME2>}"
  check_contains "short frame ends with clear-to-end-screen" "$frame2" $'\033[J'
}

test_monitor_render_path_uses_helper() {
  # The render block for "Next tasks:" must call paint_task_list_frame.
  local snippet
  snippet="$(awk '
    /_task_frame="Next tasks:"/ { capture = 1 }
    capture { print }
    capture && /paint_task_list_frame/ { exit }
  ' "$MONITOR_SCRIPT_FILE")"

  check_contains "render path calls paint_task_list_frame" "$snippet" "paint_task_list_frame"
  check_not_contains "render path omits tput ed" "$snippet" "tput ed"
  check_not_contains "render path omits tput rc" "$snippet" "tput rc"

  # paint_task_list_frame must call wavemill_pane_repaint
  local helper_def
  helper_def="$(awk '
    /^paint_task_list_frame\(\)/ { capture = 1; depth = 0 }
    capture {
      print
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
      }
      if (capture && depth == 0) exit
    }
  ' "$MONITOR_SCRIPT_FILE")"

  check_contains "paint_task_list_frame calls wavemill_pane_repaint" "$helper_def" "wavemill_pane_repaint"
}

# ---------------------------------------------------------------------------
# Terminal buffer simulator
#
# apply_repaint_to_buffer <bytes>
#   Applies ANSI escape bytes to a virtual terminal buffer and prints the
#   visible lines (non-empty rows only).  Handles the sequences emitted by
#   wavemill_pane_repaint and the monitor cursor-anchor management:
#     \n        — newline (advance row, reset column to 0)
#     ESC[K     — erase current line from cursor to EOL
#     ESC[J     — erase from cursor to end of buffer
#     ESC[s     — save cursor position
#     ESC[u     — restore cursor position
#     other     — regular character written at current position
# ---------------------------------------------------------------------------
apply_repaint_to_buffer() {
  local bytes="$1"
  # Sparse indexed array: unset elements accessed with ${buf[$r]+${buf[$r]}}
  # so that set -u is not triggered.
  local -a buf=()
  local row=0 col=0 sv_row=0 sv_col=0 max_row=0
  local i=0 len=${#bytes}
  local _line _cur

  while (( i < len )); do
    local c="${bytes:$i:1}"
    if [[ "$c" == $'\033' && "${bytes:$((i+1)):1}" == '[' ]]; then
      # Collect CSI sequence: optional params then a final letter
      local j=$((i+2)) seq=""
      while (( j < len )); do
        local x="${bytes:$j:1}"
        seq+="$x"
        j=$((j+1))
        if [[ "$x" =~ [A-Za-z] ]]; then break; fi
      done
      _cur="${buf[$row]+${buf[$row]}}"
      case "${seq: -1}" in
        K) buf[$row]="${_cur:0:$col}" ;;
        J) buf[$row]="${_cur:0:$col}"
           local k
           for (( k = row + 1; k <= max_row; k++ )); do buf[$k]=""; done ;;
        s) sv_row=$row; sv_col=$col ;;
        u) row=$sv_row; col=$sv_col ;;
      esac
      i=$j
    elif [[ "$c" == $'\n' ]]; then
      row=$((row + 1)); col=0
      if (( row > max_row )); then max_row=$row; fi
      i=$((i + 1))
    else
      _line="${buf[$row]+${buf[$row]}}"
      while (( ${#_line} < col )); do _line+=" "; done
      buf[$row]="${_line:0:$col}${c}${_line:$((col + 1))}"
      col=$((col + 1))
      i=$((i + 1))
    fi
  done

  # Output non-empty rows.  Using if/then avoids a false-returning &&
  # becoming the function's exit code under set -e.
  local r
  for (( r = 0; r <= max_row; r++ )); do
    local _v="${buf[$r]+${buf[$r]}}"
    if [[ -n "$_v" ]]; then printf '%s\n' "$_v"; fi
  done
}

# Render three frames through the full monitor flow (cursor save/restore +
# wavemill_pane_repaint) in a single shell so WAVEMILL_PANE_REPAINT_LAST_LINES
# accumulates across all three calls, exactly as it does in the live monitor.
render_three_frames() {
  local frame_a="$1" frame_b="$2" frame_c="$3"
  FUNCTIONS_FILE="$FUNC_FILE" bash -c '
    set -euo pipefail
    source "$FUNCTIONS_FILE"
    WAVEMILL_PANE_REPAINT_LAST_LINES=0

    # Frame A: first paint — blank separator + save anchor
    printf "\n"
    printf "\033[s"
    wavemill_pane_repaint "$1"

    # Frame B: restore anchor and repaint
    printf "\033[u"
    wavemill_pane_repaint "$2"

    # Frame C: restore anchor and repaint
    printf "\033[u"
    wavemill_pane_repaint "$3"
  ' _ "$frame_a" "$frame_b" "$frame_c"
}

# Three-frame visible-pane regression
# Frame A: tall grouped list; Frame B: short flat fallback; Frame C: medium list.
# After all three repaints only one "Next tasks:" must be visible.
test_three_frame_regression() {
  local frame_a frame_b frame_c raw visible count

  frame_a=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-100 - Task Alpha (score: 95)\n  2. HOK-101 - Task Beta (score: 88)\n  Queued\n  3. HOK-102 - Task Gamma (waiting)\n  4. HOK-103 - Task Delta (waiting)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'
  frame_b=$'Next tasks:\n  1. HOK-200 - Flat task (score: 70)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'
  frame_c=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-300 - New task (score: 80)\n  2. HOK-301 - Other task (score: 75)\n\nEnter number(s) to start (e.g. 1 3), wait 10s to refresh:'

  raw="$(render_three_frames "$frame_a" "$frame_b" "$frame_c")"
  visible="$(apply_repaint_to_buffer "$raw")"

  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "three-frame regression: exactly one 'Next tasks:' visible"
  else
    printf '    visible buffer:\n'
    printf '%s\n' "$visible" | head -30 | sed 's/^/    | /'
    fail "three-frame regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "three-frame: no stale HOK-100" "$visible" "HOK-100"
  check_not_contains "three-frame: no stale HOK-200" "$visible" "HOK-200"
  check_contains     "three-frame: current frame visible (HOK-300)" "$visible" "HOK-300"
}

# Shrink regression: tall grouped → short flat.
# Old trailing rows from the grouped frame must not remain visible.
test_shrink_regression() {
  local frame_tall frame_short raw visible

  frame_tall=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-10 - Alpha\n  2. HOK-11 - Beta\n  Queued - Wave 2\n  3. HOK-12 - Gamma\n\nEnter number(s) to start, wait 10s to refresh:'
  frame_short=$'Next tasks:\n  1. HOK-20 - Only task\n\nEnter number(s) to start, wait 10s to refresh:'

  raw="$(render_three_frames "$frame_tall" "$frame_short" "$frame_short")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "shrink regression: exactly one 'Next tasks:' visible"
  else
    fail "shrink regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "shrink: stale Wave 1 header gone" "$visible" "Parallel Wave 1"
  check_not_contains "shrink: stale HOK-10 gone" "$visible" "HOK-10"
  check_contains     "shrink: current task visible" "$visible" "HOK-20"
}

# Grow regression: short flat → tall grouped.
# The full tall frame must be rendered without duplication.
test_grow_regression() {
  local frame_short frame_tall raw visible

  frame_short=$'Next tasks:\n  1. HOK-20 - Only task\n\nEnter number(s) to start:'
  frame_tall=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-10 - Alpha\n  2. HOK-11 - Beta\n  Queued - Wave 2\n  3. HOK-12 - Gamma\n\nEnter number(s) to start:'

  raw="$(render_three_frames "$frame_short" "$frame_tall" "$frame_tall")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "grow regression: exactly one 'Next tasks:' visible"
  else
    fail "grow regression: expected 1 'Next tasks:', got $count"
  fi

  check_contains "grow: tall frame fully rendered (Wave 1)" "$visible" "Parallel Wave 1"
  check_contains "grow: tall frame task visible (HOK-12)" "$visible" "HOK-12"
  check_not_contains "grow: stale short frame task gone" "$visible" "HOK-20"
}

# Fallback regression: grouped frame → queue-analysis-unavailable flat frame.
# Grouped headings from the first frame must be cleared after fallback paints.
test_fallback_regression() {
  local frame_grouped frame_flat raw visible

  frame_grouped=$'Next tasks:\n  Available Now - Parallel Wave 1\n  1. HOK-50 - Group task A\n  2. HOK-51 - Group task B\n  Queued - Wave 2\n  3. HOK-52 - Group task C\n\nEnter number(s) to start (grouped view):'
  frame_flat=$'Next tasks:\n  1. HOK-50 - Group task A (score: 80)\n  2. HOK-51 - Group task B (score: 75)\n\nEnter number(s) to start (flat fallback):'

  raw="$(render_three_frames "$frame_grouped" "$frame_flat" "$frame_flat")"
  visible="$(apply_repaint_to_buffer "$raw")"

  local count
  count=$(printf '%s' "$visible" | grep -c "Next tasks:" 2>/dev/null || echo "0")
  if [[ "$count" == "1" ]]; then
    pass "fallback regression: exactly one 'Next tasks:' visible"
  else
    fail "fallback regression: expected 1 'Next tasks:', got $count"
  fi

  check_not_contains "fallback: grouped heading cleared" "$visible" "Parallel Wave 1"
  check_not_contains "fallback: stale Wave 2 heading cleared" "$visible" "Queued - Wave 2"
  check_contains     "fallback: flat task visible" "$visible" "flat fallback"
}

echo "=== Backlog Pane No Flash ==="
test_repaint_never_uses_full_screen_clear
test_repaint_starts_with_content
test_shorter_frame_clears_trailing_lines
test_monitor_render_path_uses_helper

echo
echo "=== Repaint Visible-Buffer Regression ==="
test_three_frame_regression
test_shrink_regression
test_grow_regression
test_fallback_regression

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
