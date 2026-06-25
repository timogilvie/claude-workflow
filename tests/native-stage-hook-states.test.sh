#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected" >&2
    echo "    actual:   $actual" >&2
    fail "$name"
  fi
}

TEST_DIR="$(mktemp -d)"
trap 'rm -rf "$TEST_DIR"' EXIT

write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" notes="${6:-}"
  local result_file="$feature_dir/.${stage}-result.json"
  local now="2026-06-25T12:00:00Z"
  mkdir -p "$feature_dir"
  cat > "$result_file" <<EOF
{
  "stage": "$stage",
  "status": "$status",
  "startedAt": "$now",
  "finishedAt": null,
  "agent": "$agent",
  "model": "$model",
  "notes": "$notes"
}
EOF
}

read_stage_status() {
  local feature_dir="$1" stage="$2"
  jq -r '.status // empty' "$feature_dir/.${stage}-result.json"
}

simulate_planning_transition() {
  local feature_dir="$1"
  local planning_status
  planning_status="$(read_stage_status "$feature_dir" "planning")"
  if [[ "$planning_status" == "awaiting_user" ]]; then
    printf 'awaiting_user\n'
    return
  fi
  printf '%s\n' "$planning_status"
}

simulate_coding_transition() {
  local feature_dir="$1"
  local coding_status existing_model existing_agent
  coding_status="$(read_stage_status "$feature_dir" "coding")"
  if [[ "$coding_status" == "running" && -f "$feature_dir/.coding-complete" ]]; then
    existing_model="$(jq -r '.model // empty' "$feature_dir/.coding-result.json")"
    existing_agent="$(jq -r '.agent // empty' "$feature_dir/.coding-result.json")"
    write_stage_result "$feature_dir" "coding" "completed" "$existing_agent" "$existing_model" "Coding complete"
    printf 'completed\n'
    return
  fi
  printf '%s\n' "$coding_status"
}

simulate_review_keepalive() {
  local feature_dir="$1"
  if [[ "$(read_stage_status "$feature_dir" "review")" == "running" ]]; then
    printf 'active\n'
    return
  fi
  printf 'idle\n'
}

echo "=== Native Hook State Reuse ==="

FEATURE_DIR="$TEST_DIR/feature"
write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "native-openai" "gpt-5.1" "Plan ready"
check_eq \
  "native planning awaiting_user reuses existing state" \
  "awaiting_user" \
  "$(simulate_planning_transition "$FEATURE_DIR")"
check_eq \
  "native planning identity is preserved" \
  "native-openai|gpt-5.1" \
  "$(jq -r '[.agent,.model] | join("|")' "$FEATURE_DIR/.planning-result.json")"

write_stage_result "$FEATURE_DIR" "coding" "running" "native-openrouter" "openai/gpt-5-mini" "Coding"
touch "$FEATURE_DIR/.coding-complete"
check_eq \
  "native coding completion reuses existing transition" \
  "completed" \
  "$(simulate_coding_transition "$FEATURE_DIR")"
check_eq \
  "native coding completion preserves identity" \
  "native-openrouter|openai/gpt-5-mini|completed" \
  "$(jq -r '[.agent,.model,.status] | join("|")' "$FEATURE_DIR/.coding-result.json")"

write_stage_result "$FEATURE_DIR" "review" "running" "native-openai" "gpt-5.1" "Reviewing"
check_eq \
  "native review running reuses keepalive state" \
  "active" \
  "$(simulate_review_keepalive "$FEATURE_DIR")"

write_stage_result "$FEATURE_DIR" "review" "failed" "native-openai" "gpt-5.1" "Blocked"
check_eq \
  "native review failure reuses failed state" \
  "failed" \
  "$(read_stage_status "$FEATURE_DIR" "review")"

echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
