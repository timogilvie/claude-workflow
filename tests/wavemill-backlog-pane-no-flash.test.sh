#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

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

test_monitor_no_longer_clears_before_backlog_print() {
  local snippet
  snippet="$(awk '
    /_task_frame="Next tasks:"/ { capture = 1 }
    capture { print }
    capture && /TASK_LIST_RENDERED=1/ { exit }
  ' "$MILL_SCRIPT")"

  check_contains "render path uses pane repaint" "$snippet" "wavemill_pane_repaint"
  check_not_contains "render path omits tput ed" "$snippet" "tput ed"
}

echo "=== Backlog Pane No Flash ==="
test_repaint_never_uses_full_screen_clear
test_repaint_starts_with_content
test_shorter_frame_clears_trailing_lines
test_monitor_no_longer_clears_before_backlog_print

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
