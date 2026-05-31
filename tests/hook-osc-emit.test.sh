#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_PROTOCOL="$REPO_DIR/shared/hooks/wavemill-hook-protocol.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not available; skipping hook OSC tests" >&2
  exit 0
fi

# shellcheck source=/dev/null
source "$HOOK_PROTOCOL"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

hook_file_for() {
  local session="$1" issue="$2"
  printf '/tmp/wavemill-%s-%s.hook' "$session" "$issue"
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

run_write() {
  local stderr_file="$1"
  local session="$2"
  local issue="$3"
  local phase="$4"
  local tmux_value="$5"
  local state="$6"
  local event="$7"
  local detail="$8"
  local agent="$9"
  local repo_dir="${10:-$REPO_DIR}"
  local hook_file

  hook_file="$(hook_file_for "$session" "$issue")"
  rm -f "$hook_file" "$stderr_file"

  (
    cd "$repo_dir"
    export WAVEMILL_SESSION="$session"
    export WAVEMILL_ISSUE="$issue"
    export WAVEMILL_DASHBOARD_PID=""
    if [[ -n "$phase" ]]; then
      export WAVEMILL_PHASE="$phase"
    else
      unset WAVEMILL_PHASE
    fi
    if [[ -n "$tmux_value" ]]; then
      export TMUX="$tmux_value"
    else
      unset TMUX
    fi
    wavemill_hook_write "$state" "$event" "$detail" "$agent"
  ) 2>"$stderr_file"

  printf '%s\n' "$hook_file"
}

echo "=== Hook OSC Emission ==="

esc=$'\033'
bel=$'\a'

session="hook-osc-$$-1"
issue="HOK-1856-A"
stderr_file="$TMP_ROOT/raw.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "working" "PreToolUse" "Read" "claude")"
raw_output="$(cat "$stderr_file")"
if [[ -z "$raw_output" ]] \
  && jq -e '.state == "working" and .event == "PreToolUse" and .detail == "Read" and .agent == "claude"' "$hook_file" >/dev/null 2>&1; then
  pass "working PreToolUse writes JSON without OSC"
else
  fail "working PreToolUse should not emit OSC"
fi
rm -f "$hook_file"

session="hook-osc-$$-2"
issue="HOK-1856-B"
stderr_file="$TMP_ROOT/waiting.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "review" "claude")"
waiting_output="$(cat "$stderr_file")"
expected_waiting="${esc}]777;notify;wavemill ${issue};waiting on review${esc}\\"
if [[ "$waiting_output" == "$expected_waiting" ]] \
  && [[ "$waiting_output" != *"Ptmux;"* ]] \
  && jq -e '.state == "waiting" and .event == "Notification" and .detail == "review" and .agent == "claude"' "$hook_file" >/dev/null 2>&1; then
  pass "waiting Notification emits raw OSC after JSON write"
else
  fail "waiting Notification raw OSC emission"
fi
rm -f "$hook_file"

session="hook-osc-$$-3"
issue="HOK-1856-C"
stderr_file="$TMP_ROOT/tmux.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "tmux-session" "waiting" "Notification" "Read" "claude")"
tmux_output="$(cat "$stderr_file")"
if [[ "$tmux_output" == *"${esc}Ptmux;"* ]] \
  && [[ "$tmux_output" == *"${esc}${esc}]777;notify;wavemill ${issue};waiting on Read"* ]] \
  && [[ "$tmux_output" == *"${esc}${esc}\\${esc}\\" ]] \
  && jq -e '.state == "waiting" and .event == "Notification" and .detail == "Read"' "$hook_file" >/dev/null 2>&1; then
  pass "tmux passthrough wraps and escapes OSC payload"
else
  fail "tmux passthrough framing"
fi
rm -f "$hook_file"

optout_repo="$TMP_ROOT/optout-repo"
mkdir -p "$optout_repo"
printf '%s\n' '{"hooks":{"emitOsc":false}}' > "$optout_repo/.wavemill-config.json"
session="hook-osc-$$-4"
issue="HOK-1856-D"
stderr_file="$TMP_ROOT/optout.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "review" "claude" "$optout_repo")"
if [[ ! -s "$stderr_file" ]] \
  && jq -e '.state == "waiting" and .detail == "review"' "$hook_file" >/dev/null 2>&1; then
  pass "hooks.emitOsc=false disables OSC fan-out without blocking JSON"
else
  fail "config opt-out"
fi
rm -f "$hook_file"

session="hook-osc-$$-5"
issue='HOK-1856;bad'
detail="semi;line${esc}break${bel}bell"$'\n'"tail"
stderr_file="$TMP_ROOT/sanitize.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "waiting" "Notification" "$detail" "claude")"
sanitized_output="$(cat "$stderr_file")"
expected_sanitized="${esc}]777;notify;wavemill HOK-1856bad;waiting on semilinebreakbelltail${esc}\\"
if [[ "$sanitized_output" == "$expected_sanitized" ]] \
  && jq -e '.detail == $detail' --arg detail "$detail" "$hook_file" >/dev/null 2>&1; then
  pass "OSC payload sanitizes delimiters and control bytes"
else
  fail "OSC payload sanitization"
fi
rm -f "$hook_file"

session="hook-osc-$$-6"
issue="HOK-1856-E"
stderr_file="$TMP_ROOT/no-phase.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "" "" "working" "PreToolUse" "Read" "claude")"
if [[ ! -s "$stderr_file" ]] \
  && jq -e '.state == "working" and .detail == "Read"' "$hook_file" >/dev/null 2>&1; then
  pass "missing phase keeps controller-side hook writes JSON-only"
else
  fail "phase gate for OSC emission"
fi
rm -f "$hook_file"

session="hook-osc-$$-7"
issue="HOK-1856-F"
stderr_file="$TMP_ROOT/invalid.stderr"
hook_file="$(run_write "$stderr_file" "$session" "$issue" "coding" "" "unknown" "PreToolUse" "Read" "claude")"
if [[ ! -e "$hook_file" && ! -s "$stderr_file" ]]; then
  pass "invalid states remain a no-op"
else
  fail "invalid state no-op behavior"
fi
rm -f "$hook_file"

routing_function="$(extract_function "$HOOK_PROTOCOL" "wavemill_hook_write_routing")"
if [[ "$routing_function" == *"wavemill_hook_notify"* ]] && [[ "$routing_function" != *"_wavemill_hook_emit_osc"* ]]; then
  pass "routing hook writes do not emit OSC notifications"
else
  fail "routing hook write should stay JSON + notify only"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
