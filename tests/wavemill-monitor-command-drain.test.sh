#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_LIB="$REPO_DIR/shared/lib/wavemill-common.sh"
STATUS_LIB="$REPO_DIR/shared/lib/wavemill-status.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

assert_jq() {
  local name="$1" expr="$2" file="$3"
  if jq -e "$expr" "$file" >/dev/null 2>&1; then
    pass "$name"
  else
    fail "$name"
    echo "    jq expr: $expr"
    jq '.' "$file" 2>/dev/null | head -10 || true
  fi
}

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# Extract named functions from the monitor heredoc into a reusable file.
HEREDOC_CONTENT=$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'"'"'MONITOR_EOF'"'"'$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")

SHARED_FN_FILE="$TEST_TMP/monitor-fns.sh"
for fn_name in \
  read_command_offset write_command_offset \
  queued_command_upsert queued_command_remove queued_commands_set_reason \
  drain_command_events consume_next_command consume_queued_command_for_selection \
  poll_sleep run_with_command_drain; do
  awk -v name="$fn_name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    capture && /^\}$/ { capture=0 }
  ' <<< "$HEREDOC_CONTENT" >> "$SHARED_FN_FILE"
  printf '\n' >> "$SHARED_FN_FILE"
done

if [[ ! -s "$SHARED_FN_FILE" ]]; then
  echo "FATAL: Could not extract monitor functions from $MILL_SCRIPT"
  exit 1
fi

# Helper: run a test body as a separate bash process with stubs.
# Usage: run_case <output_file> <<'BODY' ... BODY
run_case() {
  local out_file="$1"
  local body_file="$TEST_TMP/body_$$.sh"
  cat > "$body_file"
  bash "$body_file" \
    "$COMMON_LIB" "$SHARED_FN_FILE" "$TEST_TMP" \
    > "$out_file" 2>/dev/null
  rm -f "$body_file"
}

# ============================================================================
# TEST 1: drain_command_events persists select command to state during lifecycle work
# ============================================================================
echo "=== Test 1: select drains to state during simulated comparison ==="

run_case "$TEST_TMP/t1.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"  # wavemill-common.sh
source "$2"  # monitor functions

SESSION="drain-test-1"
STATE_FILE="$3/state-1.json"
COMMAND_FILE="$3/cmds-1"
COMMAND_OFFSET_FILE="$3/cmds-1.offset"
COMMAND_OFFSET_WARNED=false
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
printf 'select 1 2\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

drain_command_events

jq -r '(.queued_commands // []) | length' "$STATE_FILE"
jq -r '(.queued_commands // [])[0].command' "$STATE_FILE"
jq -r '(.queued_commands // [])[0].reason' "$STATE_FILE"
jq -r '(.command_queue.offset // "missing")' "$STATE_FILE"
echo "${#COMMAND_QUEUE[@]}"
BODY

mapfile -t T1 < "$TEST_TMP/t1.out"
[[ "${T1[0]:-0}" == "1" ]]              && pass "drain queues select to state"                    || fail "drain queues select to state (got ${T1[0]:-?})"
[[ "${T1[1]:-}" == "select 1 2" ]]      && pass "drain preserves raw command text"                || fail "drain preserves raw command text (got ${T1[1]:-?})"
[[ "${T1[2]:-}" == "pending" ]]         && pass "drain sets pending reason"                       || fail "drain sets pending reason (got ${T1[2]:-?})"
[[ "${T1[3]:-}" == "1" ]]               && pass "drain advances state offset to 1"                || fail "drain advances state offset to 1 (got ${T1[3]:-?})"
[[ "${T1[4]:-}" == "0" ]]               && pass "select does not enter in-memory COMMAND_QUEUE"   || fail "select does not enter in-memory COMMAND_QUEUE (got ${T1[4]:-?})"

# ============================================================================
# TEST 2: quit command goes to in-memory COMMAND_QUEUE, not state
# ============================================================================
echo ""
echo "=== Test 2: quit command goes to in-memory queue ==="

run_case "$TEST_TMP/t2.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="quit-test-2"
STATE_FILE="$3/state-2.json"
COMMAND_FILE="$3/cmds-2"
COMMAND_OFFSET_FILE="$3/cmds-2.offset"
COMMAND_OFFSET_WARNED=false
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
printf 'quit\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

drain_command_events

echo "${#COMMAND_QUEUE[@]}"
jq -r '(.queued_commands // []) | length' "$STATE_FILE"
BODY

mapfile -t T2 < "$TEST_TMP/t2.out"
[[ "${T2[0]:-0}" == "1" ]] && pass "quit enters in-memory COMMAND_QUEUE"               || fail "quit enters in-memory COMMAND_QUEUE (got ${T2[0]:-?})"
[[ "${T2[1]:-0}" == "0" ]] && pass "quit does not persist to state queued_commands"    || fail "quit does not persist to state queued_commands (got ${T2[1]:-?})"

# ============================================================================
# TEST 3: Offset restart correctness
# ============================================================================
echo ""
echo "=== Test 3: offset restart correctness ==="

run_case "$TEST_TMP/t3.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="restart-test-3"
STATE_FILE="$3/state-3.json"
COMMAND_FILE="$3/cmds-3"
COMMAND_OFFSET_FILE="$3/cmds-3.offset"
COMMAND_OFFSET_WARNED=false
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
printf 'select 1\nselect 2\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

# First drain: consumes both lines
drain_command_events
q1=$(jq '(.queued_commands // []) | length' "$STATE_FILE")
off1=$(jq '.command_queue.offset' "$STATE_FILE")

# Simulate restart: clear in-memory state, preserve STATE_FILE + command file
COMMAND_QUEUE=()
COMMAND_OFFSET_WARNED=false

# Append line 3
printf 'enter\n' >> "$COMMAND_FILE"

# Second drain: should only add line 3
drain_command_events
q2=$(jq '(.queued_commands // []) | length' "$STATE_FILE")
off2=$(jq '.command_queue.offset' "$STATE_FILE")

echo "$q1"
echo "$off1"
echo "$q2"
echo "$off2"
BODY

mapfile -t T3 < "$TEST_TMP/t3.out"
[[ "${T3[0]:-0}" == "2" ]] && pass "first drain queues both commands"                          || fail "first drain queues both commands (got ${T3[0]:-?})"
[[ "${T3[1]:-}" == "2" ]]  && pass "state offset is 2 after first drain"                       || fail "state offset is 2 after first drain (got ${T3[1]:-?})"
[[ "${T3[2]:-0}" == "3" ]] && pass "second drain adds only new command (no replay)"            || fail "second drain adds only new command (no replay) (got ${T3[2]:-?})"
[[ "${T3[3]:-}" == "3" ]]  && pass "state offset is 3 after second drain"                      || fail "state offset is 3 after second drain (got ${T3[3]:-?})"

# ============================================================================
# TEST 4: Queued commands dashboard rendering
# ============================================================================
echo ""
echo "=== Test 4: queued commands dashboard rendering ==="

cat > "$TEST_TMP/state-4.json" <<'JSON'
{
  "tasks": {},
  "queued_commands": [
    {
      "id": "test-session:1",
      "line": 1,
      "command": "select 1 2",
      "status": "queued",
      "reason": "pending",
      "enqueued_at": "2026-01-01T00:00:00Z",
      "updated_at": "2026-01-01T00:00:00Z"
    }
  ]
}
JSON

FRAME="$TEST_TMP/frame-4.txt"
: > "$FRAME"
EL=''
B=''
N=''
D=''
G=''
STATE_FILE="$TEST_TMP/state-4.json"

set -- test-session /tmp "$TEST_TMP/state-4.json"
# shellcheck disable=SC1090
source <(sed '/^if \[\[ "\${BASH_SOURCE\[0\]:-}" == "\$0" \]\]; then/,/^fi$/d' "$STATUS_LIB")

render_queued_commands_section

if grep -q "QUEUED COMMANDS" "$FRAME"; then
  pass "dashboard renders QUEUED COMMANDS section"
else
  fail "dashboard renders QUEUED COMMANDS section"
fi
if grep -q "select 1 2" "$FRAME"; then
  pass "dashboard shows queued command text"
else
  fail "dashboard shows queued command text"
fi
if grep -q "pending" "$FRAME"; then
  pass "dashboard shows reason"
else
  fail "dashboard shows reason"
fi

# Empty queued_commands: no section
printf '{"tasks":{},"queued_commands":[]}\n' > "$TEST_TMP/state-4b.json"
STATE_FILE="$TEST_TMP/state-4b.json"
FRAME="$TEST_TMP/frame-4b.txt"
: > "$FRAME"
render_queued_commands_section
if grep -q "QUEUED COMMANDS" "$FRAME"; then
  fail "empty queued_commands does not render section"
else
  pass "empty queued_commands does not render section"
fi

# Missing queued_commands key: no section
printf '{"tasks":{}}\n' > "$TEST_TMP/state-4c.json"
STATE_FILE="$TEST_TMP/state-4c.json"
FRAME="$TEST_TMP/frame-4c.txt"
: > "$FRAME"
render_queued_commands_section
if grep -q "QUEUED COMMANDS" "$FRAME"; then
  fail "missing queued_commands does not render section"
else
  pass "missing queued_commands does not render section"
fi

# ============================================================================
# TEST 5: no-slots reason update
# ============================================================================
echo ""
echo "=== Test 5: no-slots reason update ==="

run_case "$TEST_TMP/t5.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="slots-test-5"
STATE_FILE="$3/state-5.json"
log() { :; }
log_warn() { :; }

printf '{"tasks":{},"queued_commands":[{"id":"s:1","line":1,"command":"select 1","status":"queued","reason":"lifecycle_busy","enqueued_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z"}]}\n' > "$STATE_FILE"

queued_commands_set_reason "no_slots"

jq -r '(.queued_commands // [])[0].reason' "$STATE_FILE"
BODY

mapfile -t T5 < "$TEST_TMP/t5.out"
[[ "${T5[0]:-}" == "no_slots" ]] && pass "queued_commands_set_reason updates reason to no_slots" || fail "queued_commands_set_reason updates reason to no_slots (got ${T5[0]:-?})"

# ============================================================================
# TEST 6: consume_queued_command_for_selection returns oldest by line
# ============================================================================
echo ""
echo "=== Test 6: consume_queued_command_for_selection returns oldest ==="

run_case "$TEST_TMP/t6.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="consume-test-6"
STATE_FILE="$3/state-6.json"
QUEUED_CMD_ID=""
log() { :; }
log_warn() { :; }

# Line 3 comes before line 1 in the array, but oldest by line should win
printf '{"tasks":{},"queued_commands":[{"id":"s:3","line":3,"command":"select 3","status":"queued","reason":"lifecycle_busy"},{"id":"s:1","line":1,"command":"select 1 2","status":"queued","reason":"lifecycle_busy"}]}\n' > "$STATE_FILE"

REPLY=""
if consume_queued_command_for_selection; then
  echo "$REPLY"
  echo "$QUEUED_CMD_ID"
else
  echo "NONE"
fi
BODY

mapfile -t T6 < "$TEST_TMP/t6.out"
[[ "${T6[0]:-}" == "select 1 2" ]] && pass "consume_queued_command_for_selection returns oldest by line"  || fail "consume_queued_command_for_selection returns oldest by line (got ${T6[0]:-?})"
[[ "${T6[1]:-}" == "s:1" ]]        && pass "consume_queued_command_for_selection returns correct id"      || fail "consume_queued_command_for_selection returns correct id (got ${T6[1]:-?})"

# ============================================================================
# TEST 7: queued_command_remove deletes by id
# ============================================================================
echo ""
echo "=== Test 7: queued_command_remove ==="

run_case "$TEST_TMP/t7.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="remove-test-7"
STATE_FILE="$3/state-7.json"
log() { :; }
log_warn() { :; }

printf '{"tasks":{},"queued_commands":[{"id":"s:1","line":1,"command":"select 1","status":"queued","reason":"lifecycle_busy"},{"id":"s:2","line":2,"command":"enter","status":"queued","reason":"lifecycle_busy"}]}\n' > "$STATE_FILE"

queued_command_remove "s:1"

jq -r '(.queued_commands // []) | length' "$STATE_FILE"
jq -r '(.queued_commands // [])[0].id' "$STATE_FILE"
BODY

mapfile -t T7 < "$TEST_TMP/t7.out"
[[ "${T7[0]:-}" == "1" ]]  && pass "queued_command_remove removes one entry"       || fail "queued_command_remove removes one entry (got ${T7[0]:-?})"
[[ "${T7[1]:-}" == "s:2" ]] && pass "queued_command_remove preserves other entries" || fail "queued_command_remove preserves other entries (got ${T7[1]:-?})"

# ============================================================================
# TEST 8: run_with_command_drain drains while child runs
# ============================================================================
echo ""
echo "=== Test 8: run_with_command_drain drains during lifecycle work ==="

run_case "$TEST_TMP/t8.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="wrap-test-8"
STATE_FILE="$3/state-8.json"
COMMAND_FILE="$3/cmds-8"
COMMAND_OFFSET_FILE="$3/cmds-8.offset"
COMMAND_OFFSET_WARNED=false
POLL_SECONDS=5
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

# Background writer: waits 0.5s then appends command to simulate user input
# arriving while a lifecycle command is running
(
  sleep 0.5
  printf 'select 1 2\n' > "$3/cmds-8"
) &
writer_pid=$!

# run_with_command_drain wraps a 2-second sleep (simulating lifecycle work)
# The background writer fires midway, and drain should pick it up
run_with_command_drain sleep 2

wait "$writer_pid" 2>/dev/null || true

jq -r '(.queued_commands // []) | length' "$STATE_FILE"
BODY

mapfile -t T8 < "$TEST_TMP/t8.out"
[[ "${T8[0]:-0}" == "1" ]] && pass "run_with_command_drain drains commands during child execution" || fail "run_with_command_drain drains commands during child execution (got ${T8[0]:-?})"

# ============================================================================
# TEST 9: Structural guard — run_with_command_drain wraps lifecycle calls
# ============================================================================
echo ""
echo "=== Test 9: structural guard — run_with_command_drain in lifecycle ==="

EVAL_FN=$(awk '/^maybe_run_challenge_eval\(\) \{/,/^\}/' <<< "$HEREDOC_CONTENT")
COMP_FN=$(awk '/^maybe_run_challenge_comparison\(\) \{/,/^\}/' <<< "$HEREDOC_CONTENT")

if grep -q 'run_with_command_drain' <<< "$EVAL_FN"; then
  pass "maybe_run_challenge_eval uses run_with_command_drain"
else
  fail "maybe_run_challenge_eval uses run_with_command_drain"
fi

if grep -q 'run_with_command_drain' <<< "$COMP_FN"; then
  pass "maybe_run_challenge_comparison uses run_with_command_drain"
else
  fail "maybe_run_challenge_comparison uses run_with_command_drain"
fi

if grep -qE '^run_with_command_drain\(\) \{' <<< "$HEREDOC_CONTENT"; then
  pass "monitor heredoc defines run_with_command_drain"
else
  fail "monitor heredoc defines run_with_command_drain"
fi

if grep -qE '^queued_command_upsert\(\) \{' <<< "$HEREDOC_CONTENT"; then
  pass "monitor heredoc defines queued_command_upsert"
else
  fail "monitor heredoc defines queued_command_upsert"
fi

if grep -qE '^consume_queued_command_for_selection\(\) \{' <<< "$HEREDOC_CONTENT"; then
  pass "monitor heredoc defines consume_queued_command_for_selection"
else
  fail "monitor heredoc defines consume_queued_command_for_selection"
fi

# ============================================================================
# TEST 10: Empty lines in command file are no-ops
# ============================================================================
echo ""
echo "=== Test 10: empty lines in command file are skipped ==="

run_case "$TEST_TMP/t10.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="empty-test-10"
STATE_FILE="$3/state-10.json"
COMMAND_FILE="$3/cmds-10"
COMMAND_OFFSET_FILE="$3/cmds-10.offset"
COMMAND_OFFSET_WARNED=false
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
# Three lines: two empty, one real
printf '\n\nselect 1\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

drain_command_events

jq -r '(.queued_commands // []) | length' "$STATE_FILE"
jq -r '.command_queue.offset' "$STATE_FILE"
BODY

mapfile -t T10 < "$TEST_TMP/t10.out"
[[ "${T10[0]:-0}" == "1" ]] && pass "empty lines skipped — only real command queued"  || fail "empty lines skipped — only real command queued (got ${T10[0]:-?})"
[[ "${T10[1]:-}" == "3" ]]  && pass "offset advances past empty lines"                || fail "offset advances past empty lines (got ${T10[1]:-?})"

# ============================================================================
# TEST 11: enter command is queued to state during lifecycle work
# ============================================================================
echo ""
echo "=== Test 11: enter command drains to state ==="

run_case "$TEST_TMP/t11.out" <<'BODY'
#!/usr/bin/env bash
set -euo pipefail
source "$1"
source "$2"

SESSION="enter-test-11"
STATE_FILE="$3/state-11.json"
COMMAND_FILE="$3/cmds-11"
COMMAND_OFFSET_FILE="$3/cmds-11.offset"
COMMAND_OFFSET_WARNED=false
declare -a COMMAND_QUEUE=()
log() { :; }
log_warn() { :; }

printf '{"tasks":{}}\n' > "$STATE_FILE"
printf 'enter\n' > "$COMMAND_FILE"
printf '0\n' > "$COMMAND_OFFSET_FILE"

drain_command_events

jq -r '(.queued_commands // []) | length' "$STATE_FILE"
jq -r '(.queued_commands // [])[0].command' "$STATE_FILE"
BODY

mapfile -t T11 < "$TEST_TMP/t11.out"
[[ "${T11[0]:-0}" == "1" ]]    && pass "enter command persisted to state"            || fail "enter command persisted to state (got ${T11[0]:-?})"
[[ "${T11[1]:-}" == "enter" ]] && pass "enter command text preserved in state"       || fail "enter command text preserved in state (got ${T11[1]:-?})"

# ============================================================================
# Summary
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
