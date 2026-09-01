#!/usr/bin/env bash
# HOK-2903: canonical get_task_phase / remove_task_state coverage.
#
# Characterization record of the pre-change divergence this refactor removed.
#
#   get_task_phase
#   - shared/lib/wavemill-mill.sh (parent): raw `jq -r ... 2>/dev/null`, so a
#     missing, unreadable, zero-byte, or malformed $STATE_FILE silently
#     returned an empty string. Downstream comparisons like
#     [[ "$phase" == "planning" ]] then read as "the task is in some other
#     phase" instead of "the state file is gone". Dead code: zero live callers
#     after the HOK-2899 monitor extraction.
#   - shared/lib/wavemill-monitor.sh: wrapped the read in
#     read_state_value "executing", so every failure mode (missing/unreadable/
#     zero-byte file, jq parse error, absent task, absent phase key) fell back
#     to "executing". Three live callers.
#
#   remove_task_state
#   - parent (mill): jq body was only `del(.tasks[$issue])` — the top-level
#     .updated timestamp stayed stale after a removal. Warned via log_warn,
#     always returned 0.
#   - monitor: `del(.tasks[$issue]) | .updated = (now | todate)` — stamped
#     .updated on every removal. Warned via log_warn, always returned 0.
#   - startup runner: same jq body as the monitor but no log_warn and the
#     state_mutate exit code propagated (all four call sites discarded it
#     via `|| true`).
#
# The canonical copies live in shared/lib/wavemill-common.sh and adopt the
# monitor's live semantics: get_task_phase answers "executing" for every
# unreadable state shape (the only production callers were the monitor's),
# and remove_task_state always refreshes the top-level .updated timestamp,
# is idempotent for absent tasks, warns through log_warn when the caller
# defines it, and always returns 0. .migrationReservations[$issue] is
# deliberately preserved on removal — reservation numbers are sticky so they
# can be re-associated with retry worktrees.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    echo "    in:      $haystack"
    fail "$name"
  fi
}

# check_state <name> <expected> <state_file> <jq_expr>
check_state() {
  local name="$1" expected="$2" file="$3" expr="$4" actual
  actual="$(jq -r "$expr" "$file" 2>/dev/null || printf '<jq-error>')"
  check_eq "$name" "$expected" "$actual"
}

echo "=== get_task_phase / remove_task_state Canonicalization (HOK-2903) ==="

# --- Structural guards -------------------------------------------------------

for fn in get_task_phase remove_task_state; do
  DEFINING_FILES=()
  for f in wavemill-mill.sh wavemill-startup-runner.sh wavemill-monitor.sh wavemill-common.sh; do
    if grep -qE "^${fn}\(\) \{" "$REPO_DIR/shared/lib/$f"; then
      DEFINING_FILES+=("shared/lib/$f")
    fi
  done
  check_eq "exactly one $fn definition exists, in wavemill-common.sh" \
    "shared/lib/wavemill-common.sh" "${DEFINING_FILES[*]:-none}"
done

extract_fn() {
  awk -v fn="$1" '
    $0 == fn "() {" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$REPO_DIR/shared/lib/wavemill-common.sh"
}

PHASE_BODY="$(extract_fn get_task_phase)"
REMOVE_BODY="$(extract_fn remove_task_state)"
if [[ -z "$PHASE_BODY" || -z "$REMOVE_BODY" ]]; then
  echo "Could not extract canonical helpers from wavemill-common.sh"
  exit 1
fi

check_contains "canonical get_task_phase inlines the unreadable-state guard" \
  "$PHASE_BODY" '[[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]'
check_contains "canonical remove_task_state mutates atomically via state_mutate" \
  "$REMOVE_BODY" 'state_mutate "$STATE_FILE"'
check_contains "canonical remove_task_state refreshes the top-level .updated stamp" \
  "$REMOVE_BODY" 'del(.tasks[$issue]) | .updated = (now | todate)'
check_contains "canonical remove_task_state guards log_warn for logger-less scopes" \
  "$REMOVE_BODY" 'declare -F log_warn'

# --- Behavioral harness ------------------------------------------------------

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

# run_phase <state_file> <issue>
# Runs get_task_phase in a fresh `set -euo pipefail` bash with the canonical
# helpers sourced, echoing the phase followed by rc=<exit code>.
run_phase() {
  local state_file="$1" issue="$2"
  bash -c '
    set -euo pipefail
    STATE_FILE="$1"
    REPO_DIR="$3"
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    phase="$(get_task_phase "$2")"
    rc=$?
    printf "%s rc=%s\n" "$phase" "$rc"
  ' bash "$state_file" "$issue" "$REPO_DIR"
}

# run_remove <state_file> <issue> <warn_log> [env VAR=... overrides]
# Runs remove_task_state under set -e with log_warn captured to a file,
# echoing rc=<exit code> and "continued" to prove the caller survived.
run_remove() {
  local state_file="$1" issue="$2" warn_log="$3"
  shift 3
  : > "$warn_log"
  env "$@" bash -c '
    set -euo pipefail
    STATE_FILE="$1"
    REPO_DIR="$3"
    WARN_LOG="$4"
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    log_warn() { printf "%s\n" "$*" >> "$WARN_LOG"; }
    remove_task_state "$2"
    printf "rc=%s\n" "$?"
    printf "continued\n"
  ' bash "$state_file" "$issue" "$REPO_DIR" "$warn_log"
}

write_fixture_state() {
  local file="$1"
  cat > "$file" <<'JSON'
{
  "session": "hok-2903-test",
  "started": "2020-01-01T00:00:00Z",
  "updated": "2020-01-01T00:00:00Z",
  "freeSlots": 2,
  "nextMigrationNum": 7,
  "migrationReservations": {
    "HOK-A": 5,
    "HOK-B": 6
  },
  "tasks": {
    "HOK-A": {
      "slug": "hok-a",
      "branch": "task/hok-a",
      "status": "active",
      "phase": "coding"
    },
    "HOK-B": {
      "slug": "hok-b",
      "branch": "task/hok-b",
      "status": "active",
      "phase": "ready"
    },
    "HOK-NULL-PHASE": {
      "slug": "hok-null",
      "phase": null
    },
    "HOK-NO-PHASE": {
      "slug": "hok-no-phase",
      "status": "active"
    }
  }
}
JSON
}

STATE_FILE="$TEST_TMP/state.json"
write_fixture_state "$STATE_FILE"

# --- get_task_phase: every state shape ---------------------------------------

# 1. Missing state file (the old parent copy returned "" here).
check_eq "missing state file reads as executing" \
  "executing rc=0" "$(run_phase "$TEST_TMP/does-not-exist.json" HOK-A)"

# 2. Zero-byte state file.
: > "$TEST_TMP/empty.json"
check_eq "zero-byte state file reads as executing" \
  "executing rc=0" "$(run_phase "$TEST_TMP/empty.json" HOK-A)"

# 3. Unreadable state file (skipped for root, who ignores mode bits).
if [[ $EUID -ne 0 ]]; then
  printf '{"tasks":{"HOK-A":{"phase":"coding"}}}\n' > "$TEST_TMP/unreadable.json"
  chmod 000 "$TEST_TMP/unreadable.json"
  check_eq "unreadable state file reads as executing" \
    "executing rc=0" "$(run_phase "$TEST_TMP/unreadable.json" HOK-A)"
  chmod 644 "$TEST_TMP/unreadable.json"
else
  pass "unreadable state file case skipped (running as root)"
fi

# 4. Malformed JSON (jq parse error path; old parent copy returned "").
printf '{"tasks": {' > "$TEST_TMP/malformed.json"
check_eq "malformed state file reads as executing" \
  "executing rc=0" "$(run_phase "$TEST_TMP/malformed.json" HOK-A)"

# 5. State present, task absent.
check_eq "absent task reads as executing" \
  "executing rc=0" "$(run_phase "$STATE_FILE" HOK-MISSING)"

# 6. Task present with phase: null.
check_eq "null phase reads as executing" \
  "executing rc=0" "$(run_phase "$STATE_FILE" HOK-NULL-PHASE)"

# 7. Task present with no phase key.
check_eq "missing phase key reads as executing" \
  "executing rc=0" "$(run_phase "$STATE_FILE" HOK-NO-PHASE)"

# 8-9. Stored phases pass through untouched.
check_eq "stored coding phase is returned" \
  "coding rc=0" "$(run_phase "$STATE_FILE" HOK-A)"
check_eq "stored ready phase is returned" \
  "ready rc=0" "$(run_phase "$STATE_FILE" HOK-B)"

# --- remove_task_state: removal, timestamps, idempotence ---------------------

WARN_LOG="$TEST_TMP/warn.log"

# 1-2. Existing task removal: entry gone, siblings and unrelated bookkeeping
# intact, and the top-level .updated stamp refreshed (the old parent copy
# left .updated stale — this assertion is the drift record).
write_fixture_state "$STATE_FILE"
OUT="$(run_remove "$STATE_FILE" HOK-A "$WARN_LOG")"
check_eq "removing an existing task returns 0 and does not abort the caller" \
  $'rc=0\ncontinued' "$OUT"
check_state "removed task entry is gone" "false" "$STATE_FILE" '.tasks | has("HOK-A")'
check_state "sibling task entries survive removal" "true" "$STATE_FILE" '.tasks | has("HOK-B")'
check_state "sibling task fields survive removal" "ready" "$STATE_FILE" '.tasks["HOK-B"].phase'
UPDATED_AFTER_REMOVE="$(jq -r '.updated' "$STATE_FILE")"
if [[ "$UPDATED_AFTER_REMOVE" != "2020-01-01T00:00:00Z" && -n "$UPDATED_AFTER_REMOVE" && "$UPDATED_AFTER_REMOVE" != "null" ]]; then
  pass "top-level .updated is refreshed on removal (old parent copy left it stale)"
else
  echo "    .updated after removal: $UPDATED_AFTER_REMOVE"
  fail "top-level .updated is refreshed on removal (old parent copy left it stale)"
fi
check_eq "successful removal emits no warning" "" "$(cat "$WARN_LOG")"

# 3. Idempotent when the task is absent: rc=0, tasks untouched, .updated
# still refreshed so observers see the (attempted) churn.
write_fixture_state "$STATE_FILE"
OUT="$(run_remove "$STATE_FILE" MISSING-999 "$WARN_LOG")"
check_eq "removing an absent task is idempotent (rc=0, caller continues)" \
  $'rc=0\ncontinued' "$OUT"
check_state "absent-task removal leaves existing tasks intact" "4" "$STATE_FILE" '.tasks | length'
check_state "absent-task removal still refreshes .updated" \
  "false" "$STATE_FILE" '.updated == "2020-01-01T00:00:00Z"'
check_eq "absent-task removal emits no warning" "" "$(cat "$WARN_LOG")"

# 4. Related bookkeeping is preserved, documented as a non-goal: removal must
# not silently start cleaning migration reservations or other top-level keys.
write_fixture_state "$STATE_FILE"
run_remove "$STATE_FILE" HOK-A "$WARN_LOG" >/dev/null
check_state "migrationReservations entry for the removed task is preserved" \
  "5" "$STATE_FILE" '.migrationReservations["HOK-A"]'
check_state "other migrationReservations are preserved" \
  "6" "$STATE_FILE" '.migrationReservations["HOK-B"]'
check_state "nextMigrationNum is preserved" "7" "$STATE_FILE" '.nextMigrationNum'
check_state "freeSlots is preserved" "2" "$STATE_FILE" '.freeSlots'
check_state "session metadata is preserved" "hok-2903-test" "$STATE_FILE" '.session'

# 5. state_mutate failure (missing state file): warn once, still return 0.
OUT="$(run_remove "$TEST_TMP/gone/state.json" HOK-A "$WARN_LOG" 2>/dev/null)"
check_eq "failed removal still returns 0 under set -e" $'rc=0\ncontinued' "$OUT"
check_eq "failed removal warns exactly once" "1" "$(wc -l < "$WARN_LOG" | tr -d ' ')"
check_contains "failure warning names the helper and issue" \
  "$(cat "$WARN_LOG")" "remove_task_state: failed to remove HOK-A"

# 6. state_mutate failure (unwritable state directory: the lock cannot be
# taken). Skipped for root, who ignores mode bits.
if [[ $EUID -ne 0 ]]; then
  RO_DIR="$TEST_TMP/readonly"
  mkdir -p "$RO_DIR"
  write_fixture_state "$RO_DIR/state.json"
  chmod 555 "$RO_DIR"
  OUT="$(run_remove "$RO_DIR/state.json" HOK-A "$WARN_LOG" \
    STATE_MUTATE_MAX_RETRIES=2 STATE_MUTATE_SLEEP_SECONDS=0.05 2>/dev/null)"
  chmod 755 "$RO_DIR"
  check_eq "removal against an unwritable state dir still returns 0" \
    $'rc=0\ncontinued' "$OUT"
  check_contains "unwritable-dir failure is warned" \
    "$(cat "$WARN_LOG")" "remove_task_state: failed to remove HOK-A"
  check_state "unwritable-dir failure leaves the state file untouched" \
    "true" "$RO_DIR/state.json" '.tasks | has("HOK-A")'
else
  pass "unwritable state dir case skipped (running as root)"
fi

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
