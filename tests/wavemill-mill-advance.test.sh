#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

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

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" != "$actual" ]]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

assert_contains() {
  local label="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "  expected substring: $needle"
    echo "  actual: $haystack"
    exit 1
  fi
}

assert_file_exists() {
  local label="$1" path="$2"
  [[ -f "$path" ]] || {
    echo "FAIL: $label"
    echo "  missing file: $path"
    exit 1
  }
}

assert_file_missing() {
  local label="$1" path="$2"
  [[ ! -e "$path" ]] || {
    echo "FAIL: $label"
    echo "  unexpected file: $path"
    exit 1
  }
}

source "$COMMON_SCRIPT"

HEREDOC_CONTENT="$(awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT")"

FUNCS_FILE="$TMP_DIR/advance-monitor-funcs.sh"
: > "$FUNCS_FILE"
for fn in \
  read_state_value \
  get_task_phase \
  read_stage_result \
  read_stage_status \
  check_stage_complete \
  check_stage_awaiting_user \
  check_stage_aborted \
  _persist_phase \
  resolve_phase \
  normalize_prompt_command_reply \
  handle_advance_command \
  execute_or_defer_monitor_command
do
  extracted="$(extract_function <(printf '%s\n' "$HEREDOC_CONTENT") "$fn")"
  if [[ -z "$extracted" ]]; then
    echo "FAIL: missing extracted function $fn"
    exit 1
  fi
  printf '%s\n\n' "$extracted" >> "$FUNCS_FILE"
done
source "$FUNCS_FILE"

log_lines=()
warn_lines=()
log() {
  local level="$1"
  shift
  log_lines+=("$level:$*")
}
log_warn() {
  warn_lines+=("$*")
}
acknowledge_command_offset() {
  ACKED_OFFSETS+=("$1")
}
monitor_defer_command() { :; }
monitor_remove_deferred_command() { :; }

reset_harness() {
  log_lines=()
  warn_lines=()
  ACKED_OFFSETS=()
  MONITOR_COMMAND_STATUS=""
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""
}

init_state() {
  local state_file="$1"
  cat > "$state_file" <<'EOF'
{
  "tasks": {}
}
EOF
}

write_task_state() {
  local issue="$1" slug="$2" worktree="$3" phase="$4"
  jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg worktree "$worktree" \
    --arg phase "$phase" \
    '{tasks: {($issue): {slug: $slug, worktree: $worktree, phase: $phase}}}' > "$STATE_FILE"
}

write_coding_result() {
  local feature_dir="$1" status="$2" json_body="${3:-}"
  if [[ -n "$json_body" ]]; then
    printf '%s\n' "$json_body" > "$feature_dir/.coding-result.json"
    return
  fi

  cat > "$feature_dir/.coding-result.json" <<EOF
{
  "stage": "coding",
  "status": "$status",
  "agent": "codex",
  "model": "gpt-5.4",
  "notes": "blocked on integration",
  "artifacts": {
    "log": "coding.log",
    "summary": "blocked"
  }
}
EOF
}

run_advance() {
  local event="$1"
  reset_harness
  execute_or_defer_monitor_command "new" "$event" "7" "0" "" "" "" ""
}

run_advance_quiet() {
  local event="$1"
  run_advance "$event" 2>/dev/null
}

SCENARIO_DIR="$TMP_DIR/scenario"
mkdir -p "$SCENARIO_DIR"
STATE_FILE="$SCENARIO_DIR/state.json"
init_state "$STATE_FILE"

# Success
WORKTREE_SUCCESS="$SCENARIO_DIR/worktree-success"
FEATURE_SUCCESS="$WORKTREE_SUCCESS/features/test-slug"
mkdir -p "$FEATURE_SUCCESS"
write_task_state "HOK-1639" "test-slug" "$WORKTREE_SUCCESS" "coding"
write_coding_result "$FEATURE_SUCCESS" "running"
run_advance "advance HOK-1639"
assert_eq "success status" "handled" "$MONITOR_COMMAND_STATUS"
assert_file_exists "success writes audit artifact" "$FEATURE_SUCCESS/.coding-advance-override.json"
assert_file_exists "success writes coding complete marker" "$FEATURE_SUCCESS/.coding-complete"
assert_eq "success acks command offset" "7" "${ACKED_OFFSETS[0]:-}"
assert_contains "success log message" "HOK-1639 -> advance recorded; review will launch on the next monitor tick" "${log_lines[*]}"
assert_eq "success audit issue" "HOK-1639" "$(jq -r '.issue' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit reason" "manual advance via mill input" "$(jq -r '.reason' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit path" "features/test-slug/.coding-result.json" "$(jq -r '.artifact_summary.path' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit status" "running" "$(jq -r '.artifact_summary.status' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "success audit artifact keys count" "2" "$(jq -r '.artifact_summary.artifact_keys | length' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_contains "success audit timestamp present" "T" "$(jq -r '.timestamp' "$FEATURE_SUCCESS/.coding-advance-override.json")"
assert_eq "backlog prompt preserves advance command" "advance HOK-1639" "$(normalize_prompt_command_reply "advance HOK-1639")"

# Unknown issue
init_state "$STATE_FILE"
run_advance "advance HOK-9999"
assert_eq "unknown issue invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "unknown issue message" "HOK-9999 is not tracked" "${warn_lines[*]}"

# Not in coding
WORKTREE_REVIEW="$SCENARIO_DIR/worktree-review"
FEATURE_REVIEW="$WORKTREE_REVIEW/features/review-slug"
mkdir -p "$FEATURE_REVIEW"
write_task_state "HOK-2000" "review-slug" "$WORKTREE_REVIEW" "review"
cat > "$FEATURE_REVIEW/.review-result.json" <<'EOF'
{"stage":"review","status":"running"}
EOF
run_advance "advance HOK-2000"
assert_eq "review phase invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "review phase message" "HOK-2000 is in phase review" "${warn_lines[*]}"
assert_file_missing "review phase no audit" "$FEATURE_REVIEW/.coding-advance-override.json"
assert_file_missing "review phase no marker" "$FEATURE_REVIEW/.coding-complete"

# Missing artifact
WORKTREE_MISSING="$SCENARIO_DIR/worktree-missing"
FEATURE_MISSING="$WORKTREE_MISSING/features/missing-slug"
mkdir -p "$FEATURE_MISSING"
write_task_state "HOK-2001" "missing-slug" "$WORKTREE_MISSING" "coding"
cat > "$FEATURE_MISSING/.planning-result.json" <<'EOF'
{"stage":"planning","status":"completed"}
EOF
run_advance "advance HOK-2001"
assert_eq "missing artifact invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "missing artifact message" "blocked-completion artifact" "${warn_lines[*]}"
assert_file_missing "missing artifact no audit" "$FEATURE_MISSING/.coding-advance-override.json"
assert_file_missing "missing artifact no marker" "$FEATURE_MISSING/.coding-complete"

# Invalid artifact JSON
WORKTREE_BAD_JSON="$SCENARIO_DIR/worktree-bad-json"
FEATURE_BAD_JSON="$WORKTREE_BAD_JSON/features/bad-json-slug"
mkdir -p "$FEATURE_BAD_JSON"
write_task_state "HOK-2002" "bad-json-slug" "$WORKTREE_BAD_JSON" "coding"
cat > "$FEATURE_BAD_JSON/.planning-result.json" <<'EOF'
{"stage":"planning","status":"completed"}
EOF
printf '{broken json\n' > "$FEATURE_BAD_JSON/.coding-result.json"
run_advance "advance HOK-2002"
assert_eq "bad json invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "bad json message" "blocked-completion artifact" "${warn_lines[*]}"

# Invalid artifact status
WORKTREE_BAD_STATUS="$SCENARIO_DIR/worktree-bad-status"
FEATURE_BAD_STATUS="$WORKTREE_BAD_STATUS/features/bad-status-slug"
mkdir -p "$FEATURE_BAD_STATUS"
write_task_state "HOK-2003" "bad-status-slug" "$WORKTREE_BAD_STATUS" "coding"
write_coding_result "$FEATURE_BAD_STATUS" "failed"
run_advance "advance HOK-2003"
assert_eq "bad status invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "bad status message" "blocked-completion artifact" "${warn_lines[*]}"
assert_file_missing "bad status no audit" "$FEATURE_BAD_STATUS/.coding-advance-override.json"
assert_file_missing "bad status no marker" "$FEATURE_BAD_STATUS/.coding-complete"

# Usage errors
for bad_event in "advance" "advance hok-1639" "advance HOK-1 extra"; do
  init_state "$STATE_FILE"
  run_advance "$bad_event"
  assert_eq "usage invalid for $bad_event" "invalid" "$MONITOR_COMMAND_STATUS"
  assert_contains "usage message for $bad_event" "usage: advance <issue-id>" "${warn_lines[*]}"
done

# Audit-before-advance
WORKTREE_AUDIT_FAIL="$SCENARIO_DIR/worktree-audit-fail"
FEATURE_AUDIT_FAIL="$WORKTREE_AUDIT_FAIL/features/audit-fail-slug"
mkdir -p "$FEATURE_AUDIT_FAIL"
write_task_state "HOK-2004" "audit-fail-slug" "$WORKTREE_AUDIT_FAIL" "coding"
write_coding_result "$FEATURE_AUDIT_FAIL" "running"
chmod 500 "$FEATURE_AUDIT_FAIL"
run_advance_quiet "advance HOK-2004"
assert_eq "audit failure invalid" "invalid" "$MONITOR_COMMAND_STATUS"
assert_contains "audit failure message" "could not create audit artifact" "${warn_lines[*]}"
assert_file_missing "audit failure does not create marker" "$FEATURE_AUDIT_FAIL/.coding-complete"
chmod 700 "$FEATURE_AUDIT_FAIL"

# Idempotency
WORKTREE_IDEMP="$SCENARIO_DIR/worktree-idempotent"
FEATURE_IDEMP="$WORKTREE_IDEMP/features/idempotent-slug"
mkdir -p "$FEATURE_IDEMP"
write_task_state "HOK-2005" "idempotent-slug" "$WORKTREE_IDEMP" "coding"
write_coding_result "$FEATURE_IDEMP" "running"
touch "$FEATURE_IDEMP/.coding-complete"
run_advance "advance HOK-2005"
assert_eq "idempotent handled" "handled" "$MONITOR_COMMAND_STATUS"
assert_file_exists "idempotent audit exists" "$FEATURE_IDEMP/.coding-advance-override.json"
assert_file_exists "idempotent marker still exists" "$FEATURE_IDEMP/.coding-complete"

echo "PASS: advance command validates, audits, and advances coding tasks"
