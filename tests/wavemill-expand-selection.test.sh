#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
EXPAND_SCRIPT="$REPO_DIR/shared/lib/wavemill-expand.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

FUNCTIONS_FILE="$TEST_TMP/wavemill-expand-selection-funcs.sh"
extract_function "$EXPAND_SCRIPT" "is_expand_quit_selection" > "$FUNCTIONS_FILE"

if [[ ! -s "$FUNCTIONS_FILE" ]]; then
  echo "Could not extract is_expand_quit_selection from $EXPAND_SCRIPT"
  exit 1
fi

run_helper() {
  local input="$1"
  FUNCTIONS_FILE="$FUNCTIONS_FILE" INPUT="$input" bash -lc '
    set -euo pipefail
    # shellcheck source=/dev/null
    source "$FUNCTIONS_FILE"
    if is_expand_quit_selection "$INPUT"; then
      echo true
    else
      echo false
    fi
  '
}

test_quit_helper_cases() {
  check_eq "q is quit" "true" "$(run_helper "q")"
  check_eq "Q is quit" "true" "$(run_helper "Q")"
  check_eq "whitespace-padded q is quit" "true" "$(run_helper "  q  ")"
  check_eq "empty input is not quit" "false" "$(run_helper "")"
  check_eq "whitespace-only is not quit" "false" "$(run_helper "   ")"
  check_eq "quit word is not quit alias" "false" "$(run_helper "quit")"
  check_eq "double-letter q is not quit" "false" "$(run_helper "qQ")"
  check_eq "mixed numeric input is not quit" "false" "$(run_helper "1 q 3")"
  check_eq "numeric input is not quit" "false" "$(run_helper "1")"
}

test_quit_branch_is_wired_before_empty_branch() {
  local quit_line empty_line
  quit_line=$(awk '/if is_expand_quit_selection "\$SELECTED"; then/ { print NR; exit }' "$EXPAND_SCRIPT")
  empty_line=$(awk '/if \[\[ -z "\$SELECTED" \]\]; then/ { print NR; exit }' "$EXPAND_SCRIPT")

  if [[ -n "$quit_line" && -n "$empty_line" && "$quit_line" -lt "$empty_line" ]]; then
    pass "quit branch precedes empty-input branch"
  else
    echo "    quit line:  ${quit_line:-missing}"
    echo "    empty line: ${empty_line:-missing}"
    fail "quit branch precedes empty-input branch"
  fi
}

test_quit_message_present() {
  if grep -Fq 'log "Quit. No issues expanded."' "$EXPAND_SCRIPT"; then
    pass "quit message is logged"
  else
    fail "quit message is logged"
  fi
}

test_quit_helper_cases
test_quit_branch_is_wired_before_empty_branch
test_quit_message_present

if [[ $FAIL -gt 0 ]]; then
  echo
  echo "Failed: $FAIL"
  exit 1
fi

echo
echo "Passed: $PASS"
