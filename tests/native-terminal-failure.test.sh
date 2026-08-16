#!/usr/bin/env bash
# Regression coverage for hook-driven terminal native failure handling.
#
# Background: a provider that accepts the launch and then rejects the request
# (unknown model ID, prompt larger than the context window) produces none of the
# exec-level signatures the pane-scraping heuristics look for. Those arms stayed
# in `phase: coding` indefinitely and blocked the merge lane. The agent's status
# hook records the failure as {"state":"error"}; the monitor now consumes it.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

extract_function() {
  local name="$1"
  awk -v name="$name" '
    $0 ~ "^" name "\\(\\) \\{" { capture=1 }
    capture { print }
    /^}/ && capture { exit }
  ' "$MILL_SCRIPT"
}

eval "$(extract_function native_hook_terminal_failure_detail)"
eval "$(extract_function native_terminal_failure_kind)"
eval "$(extract_function native_terminal_failure_next_action)"
eval "$(extract_function emit_native_terminal_failure_attention)"
eval "$(extract_function challenge_abort_pair)"

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

SESSION="testsess"
STATE_FILE="$TMP_ROOT/state.json"
ATTENTION_FILE="$TMP_ROOT/attention.txt"
WARN_FILE="$TMP_ROOT/warn.txt"
active_count=0

log_warn() { printf '%s\n' "$1" >> "$WARN_FILE"; }
set_window_attention_state() { printf '%s=%s\n' "$1" "$2" >> "$ATTENTION_FILE"; }
challenge_result_stage_for_launch() { printf '%s\n' "${1/#coding/coding}"; }
challenge_stage_for_launch_env() { printf '%s\n' "$1"; }
state_mutate() {
  local state_path="$1" filter="$2"
  shift 2
  jq "$@" "$filter" "$state_path" > "$state_path.tmp"
  mv "$state_path.tmp" "$state_path"
}
get_task_meta() {
  jq -r --arg issue "$1" --arg field "$2" '.tasks[$issue][$field] // empty' "$STATE_FILE"
}
read_stage_status() {
  jq -r '.status // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
stage_result_field() {
  jq -r --arg f "$3" '.[$f] // empty' "$1/.${2}-result.json" 2>/dev/null || true
}
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts="${7:-}"
  mkdir -p "$feature_dir"
  jq -n \
    --arg stage "$stage" --arg status "$status" --arg agent "$agent" \
    --arg model "$model" --arg notes "$notes" --argjson artifacts "${artifacts:-null}" \
    '{stage:$stage,status:$status,agent:$agent,model:$model,notes:$notes,artifacts:$artifacts}' \
    > "$feature_dir/.${stage}-result.json"
}

write_hook() {
  local issue="$1" state="$2" detail="$3"
  jq -n --arg s "$state" --arg d "$detail" \
    '{state:$s,event:"process_exit",agent:"native",timestamp:1,detail:$d}' \
    > "/tmp/wavemill-${SESSION}-${issue}.hook"
}

seed() {
  local issue="$1" challenge="${2:-true}"
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "$issue":    { "challengePairId": "PAIR-1", "challengeRole": "challenger", "challenge": $challenge },
    "PAIR-1":    { "challengePairId": "PAIR-1", "challengeRole": "primary",    "challenge": $challenge }
  }
}
JSON
  : > "$ATTENTION_FILE"
  : > "$WARN_FILE"
}

echo "=== Native Terminal Failure Handling ==="

# ── Classifier ────────────────────────────────────────────────────────
ctx_detail="Native coding failed: 400 This endpoint's maximum context length is 131072 tokens. However, you requested about 131182 tokens"
bad_model_detail="Native coding failed: 400 qwen-2.5-coder-32b is not a valid model ID"

if [[ "$(native_terminal_failure_kind "$ctx_detail")" == "context-window-exceeded" ]]; then
  pass "context overflow is classified"
else
  fail "context overflow misclassified as $(native_terminal_failure_kind "$ctx_detail")"
fi

if [[ "$(native_terminal_failure_kind "$bad_model_detail")" == "invalid-model-id" ]]; then
  pass "invalid model ID is classified"
else
  fail "invalid model ID misclassified as $(native_terminal_failure_kind "$bad_model_detail")"
fi

if [[ "$(native_terminal_failure_kind "something else entirely")" == "native-provider-error" ]]; then
  pass "unrecognised provider errors fall back to a generic kind"
else
  fail "generic provider error fallback changed"
fi

if [[ "$(native_terminal_failure_next_action context-window-exceeded)" == *"compressed context"* ]]; then
  pass "context overflow surfaces a specific recovery action"
else
  fail "context overflow recovery action missing"
fi

# ── Context overflow end-to-end ───────────────────────────────────────
seed "PAIR-1_c"
fd="$TMP_ROOT/f-ctx"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"

if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-1" "%1" "native" "kimi-k2"; then
  if [[ "$(jq -r '.status' "$fd/.coding-result.json")" == "failed" ]] \
    && [[ "$(jq -r '.artifacts.failureKind' "$fd/.coding-result.json")" == "context-window-exceeded" ]] \
    && [[ "$(jq -r '.artifacts.nextAction' "$fd/.coding-result.json")" == *"compressed context"* ]] \
    && grep -q 'win-1=needs-user' "$ATTENTION_FILE"; then
    pass "context overflow marks the stage failed with a recovery action"
  else
    fail "context overflow stage side effects incomplete"
  fi
else
  fail "context overflow was not detected"
fi

# Both arms of the pair must be quarantined: a dead arm invalidates the comparison.
if [[ "$(jq -r '.tasks["PAIR-1_c"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:context-window-exceeded" ]] \
  && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:context-window-exceeded" ]] \
  && [[ -f "$fd/.challenge-aborted.json" ]] \
  && [[ "$(jq -r '.nextAction' "$fd/.challenge-aborted.json")" == *"compressed context"* ]]; then
  pass "context overflow quarantines both challenge arms"
else
  fail "challenge pair was not quarantined on context overflow"
fi

# ── Invalid model ID end-to-end ───────────────────────────────────────
seed "PAIR-1_c"
fd="$TMP_ROOT/f-model"
write_stage_result "$fd" "coding" "running" "native" "qwen-2.5-coder-32b"
write_hook "PAIR-1_c" "error" "$bad_model_detail"

if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-2" "%2" "native" "qwen-2.5-coder-32b"; then
  if [[ "$(jq -r '.artifacts.failureKind' "$fd/.coding-result.json")" == "invalid-model-id" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted' "$STATE_FILE")" == "terminal_launch_failure:invalid-model-id" ]]; then
    pass "invalid model ID fails the stage and quarantines the pair"
  else
    fail "invalid model ID side effects incomplete"
  fi
else
  fail "invalid model ID was not detected"
fi

# ── Guards ────────────────────────────────────────────────────────────
# A terminal hook is deliberately NOT TTL-gated, but it must never override a
# run that actually produced its completion artifact.
seed "PAIR-1_c"
fd="$TMP_ROOT/f-complete"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"
touch "$fd/.coding-complete"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-3" "%3" "native" "kimi-k2"; then
  fail "terminal handler overrode a completed run"
else
  pass "completion artifact wins over a stale terminal hook"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-working"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "working" "Phase 3: editing files"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-4" "%4" "native" "kimi-k2"; then
  fail "a healthy working hook was treated as terminal"
else
  pass "non-error hook states are ignored"
fi

seed "PAIR-1_c"
fd="$TMP_ROOT/f-nohook"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
rm -f "/tmp/wavemill-${SESSION}-PAIR-1_c.hook"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-5" "%5" "native" "kimi-k2"; then
  fail "missing hook was treated as terminal"
else
  pass "missing hook file is a no-op"
fi

# Non-challenge tasks fail the stage but must not write challenge quarantine state.
seed "PAIR-1_c" false
fd="$TMP_ROOT/f-solo"
write_stage_result "$fd" "coding" "running" "native" "kimi-k2"
write_hook "PAIR-1_c" "error" "$ctx_detail"
if emit_native_terminal_failure_attention "PAIR-1_c" "$fd" "coding" "win-6" "%6" "native" "kimi-k2"; then
  if [[ "$(jq -r '.status' "$fd/.coding-result.json")" == "failed" ]] \
    && [[ ! -f "$fd/.challenge-aborted.json" ]] \
    && [[ "$(jq -r '.tasks["PAIR-1"].challengeAborted // "none"' "$STATE_FILE")" == "none" ]]; then
    pass "non-challenge tasks fail without challenge quarantine"
  else
    fail "non-challenge task wrote challenge quarantine state"
  fi
else
  fail "non-challenge terminal failure was not detected"
fi

rm -f "/tmp/wavemill-${SESSION}-PAIR-1_c.hook"

echo
echo "--- Results: $PASS passed, $FAIL failed ---"
[[ "$FAIL" -eq 0 ]]
