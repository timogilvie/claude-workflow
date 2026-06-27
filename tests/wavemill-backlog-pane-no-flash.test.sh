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

REPAINT_FUNC_FILE="$TMP_DIR/pane-repaint.sh"
extract_function "$COMMON_SCRIPT" "wavemill_pane_repaint" > "$REPAINT_FUNC_FILE"

if [[ ! -s "$REPAINT_FUNC_FILE" ]]; then
  echo "Could not extract wavemill_pane_repaint"
  exit 1
fi

# Extract the repaint_task_list_display wrapper from the monitor heredoc.
MILL_MONITOR_BODY="$TMP_DIR/monitor-body.sh"
awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT" > "$MILL_MONITOR_BODY"

WRAPPER_FUNC_FILE="$TMP_DIR/wrapper-funcs.sh"
{
  extract_function "$MILL_MONITOR_BODY" "_count_task_frame_rows"
  echo
  extract_function "$MILL_MONITOR_BODY" "repaint_task_list_display"
  cat "$REPAINT_FUNC_FILE"
} > "$WRAPPER_FUNC_FILE"

render_with_helper() {
  local first_frame="$1" second_frame="$2"
  FUNCTIONS_FILE="$REPAINT_FUNC_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"

    frame1=$(wavemill_pane_repaint "$0")
    frame2=$(wavemill_pane_repaint "$1")
    printf "%s<FRAME2>%s" "$frame1" "$frame2"
  ' "$first_frame" "$second_frame"
}

render_frames_via_wrapper() {
  local frames_var="$1"
  WRAPPER_FUNC_FILE="$WRAPPER_FUNC_FILE" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$WRAPPER_FUNC_FILE"
    TASK_LIST_RENDERED=0
    TASK_LIST_RENDERED_ROWS=0

    # Simulate what the monitor loop does: call repaint_task_list_display
    # for each frame in the array, separated by <FRAMEn> markers.
    eval "frames=($0)"
    i=0
    for frame in "${frames[@]}"; do
      i=$((i + 1))
      printf "<FRAME%d>" "$i"
      repaint_task_list_display "$frame"
    done
  ' "$frames_var"
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
    capture && /repaint_task_list_display/ { exit }
  ' "$MILL_SCRIPT")"

  check_contains "render path uses repaint wrapper" "$snippet" "repaint_task_list_display"
  check_not_contains "render path omits tput ed" "$snippet" "tput ed"
}

test_repaint_wrapper_calls_pane_repaint() {
  local wrapper_body
  wrapper_body="$(extract_function "$MILL_MONITOR_BODY" "repaint_task_list_display")"
  check_contains "wrapper delegates to wavemill_pane_repaint" "$wrapper_body" "wavemill_pane_repaint"
  check_not_contains "wrapper omits full-screen clear" "$wrapper_body" $'\033[2J'
}

# Terminal buffer simulator: applies repaint bytes from a fixed saved cursor origin.
# Interprets: printable text, newline, ESC[K (clear-to-eol), ESC[J (clear-to-eos),
# ESC[<n>A (cursor up), explicit blank-row ESC[K sequences from pre-clear.
simulate_terminal_buffer() {
  local output="$1" width="${2:-80}" height="${3:-40}"
  python3 - "$output" "$width" "$height" <<'PYEOF'
import sys, re

raw = sys.argv[1]
W = int(sys.argv[2])
H = int(sys.argv[3])

buf = [[' ' * W] for _ in range(H)]
row, col = 0, 0

def clamp_row():
    global row
    if row >= H:
        row = H - 1

def put_char(c):
    global row, col
    clamp_row()
    line = list(buf[row][0])
    if col < W:
        line[col] = c
        buf[row][0] = ''.join(line)
    col += 1

i = 0
# Track saved cursor (tput sc/rc uses \0337/\0338 or \033[s/\033[u)
saved_row, saved_col = 0, 0

while i < len(raw):
    c = raw[i]
    if c == '\n':
        row += 1
        col = 0
        clamp_row()
        i += 1
    elif c == '\033':
        i += 1
        if i >= len(raw):
            break
        nc = raw[i]
        if nc == '[':
            # CSI sequence
            i += 1
            param = ''
            while i < len(raw) and (raw[i].isdigit() or raw[i] == ';'):
                param += raw[i]
                i += 1
            if i < len(raw):
                cmd = raw[i]
                i += 1
                if cmd == 'K':
                    # Clear to end of line
                    clamp_row()
                    line = list(buf[row][0])
                    for j in range(col, W):
                        line[j] = ' '
                    buf[row][0] = ''.join(line)
                elif cmd == 'J':
                    # Clear to end of screen
                    clamp_row()
                    line = list(buf[row][0])
                    for j in range(col, W):
                        line[j] = ' '
                    buf[row][0] = ''.join(line)
                    for r in range(row + 1, H):
                        buf[r][0] = ' ' * W
                elif cmd == 'A':
                    # Cursor up
                    n = int(param) if param else 1
                    row = max(0, row - n)
                elif cmd == 's':
                    saved_row, saved_col = row, col
                elif cmd == 'u':
                    row, col = saved_row, saved_col
        elif nc == '7':
            saved_row, saved_col = row, col
            i += 1
        elif nc == '8':
            row, col = saved_row, saved_col
            i += 1
        else:
            i += 1
    else:
        put_char(c)
        i += 1

# Output non-empty lines
for r in range(H):
    line = buf[r][0].rstrip()
    if line:
        print(line)
PYEOF
}

test_three_consecutive_frames_no_stale_content() {
  # F1: tall grouped frame with "Next tasks:" and "Available Now" section
  local f1 f2 f3 output visible

  f1="Next tasks:"$'\n'"  Available Now - Parallel Wave 1"$'\n'"  1. HOK-10 - Foundation task (score: 98)"$'\n'"  2. HOK-13 - Shared surface task (score: 90)"$'\n'"  Queued After Dependencies"$'\n'"  3. HOK-11 - Depends on foundation (score: 95)"$'\n'"  4. HOK-12 - Also depends (score: 92)"$'\n'$'\n'"Enter number(s) to start, 'q' to quit, or wait 10s to refresh:"$'\n'

  # F2: shorter flat frame (queue analysis fell back) with different candidates
  f2="Next tasks:"$'\n'"  1. HOK-10 - Foundation task (score: 98)"$'\n'"  2. HOK-13 - Shared surface task (score: 90)"$'\n'$'\n'"Enter number(s) to start, 'q' to quit, or wait 10s to refresh:"$'\n'

  # F3: queue-analysis fallback with just one task
  f3="Next tasks:"$'\n'"  1. HOK-10 - Foundation task (score: 98)"$'\n'$'\n'"Enter number(s) to start, 'q' to quit, or wait 10s to refresh:"$'\n'

  output=$(WRAPPER_FUNC_FILE="$WRAPPER_FUNC_FILE" bash -lc '
    set -euo pipefail
    source "$WRAPPER_FUNC_FILE"
    TASK_LIST_RENDERED=0
    TASK_LIST_RENDERED_ROWS=0
    repaint_task_list_display "$0"
    repaint_task_list_display "$1"
    repaint_task_list_display "$2"
  ' "$f1" "$f2" "$f3" 2>/dev/null || true)

  visible=$(simulate_terminal_buffer "$output")

  # Exactly one "Next tasks:" in the final visible buffer
  local nt_count
  nt_count=$(grep -c "Next tasks:" <<<"$visible" 2>/dev/null || echo "0")
  if (( nt_count == 1 )); then
    pass "three frames: exactly one Next tasks: header visible"
  else
    echo "    visible buffer:"
    echo "$visible" | sed 's/^/    /'
    fail "three frames: expected 1 Next tasks: header, got $nt_count"
  fi

  # F1-only grouped section header must not be visible after F3
  check_not_contains "three frames: no stale Available Now section" "$visible" "Available Now - Parallel Wave 1"

  # F1/F2 task IDs that are NOT in F3 must not be visible
  check_not_contains "three frames: no stale Queued After Dependencies" "$visible" "Queued After Dependencies"

  # F3 content must be present
  check_contains "three frames: final frame content visible" "$visible" "HOK-10 - Foundation task"
}

echo "=== Backlog Pane No Flash ==="
test_repaint_never_uses_full_screen_clear
test_repaint_starts_with_content
test_shorter_frame_clears_trailing_lines
test_monitor_no_longer_clears_before_backlog_print
test_repaint_wrapper_calls_pane_repaint
test_three_consecutive_frames_no_stale_content

echo
echo "Passed: $PASS"
echo "Failed: $FAIL"

if (( FAIL > 0 )); then
  exit 1
fi
