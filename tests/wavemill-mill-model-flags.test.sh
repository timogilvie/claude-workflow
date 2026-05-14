#!/usr/bin/env bash
set -euo pipefail

# Tests for --model / --planner-model / --coder-model / --reviewer-model flag
# parsing and validation in wavemill-mill.sh.
#
# Tests the validate_model_token shell helper and flag parsing block without
# launching agents. Sourcing only the top of wavemill-mill.sh up to the first
# function definition is fragile; instead we replicate the minimal helpers and
# invoke validate-model-token.ts directly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { printf '  PASS  %s\n' "$1"; PASS=$((PASS + 1)); }
fail() { printf '  FAIL  %s\n  expected: %s\n  got:      %s\n' "$1" "$2" "$3"; FAIL=$((FAIL + 1)); }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$name"; else fail "$name" "$expected" "$actual"; fi
}

check_contains() {
  local name="$1" pattern="$2" actual="$3"
  if echo "$actual" | grep -q "$pattern"; then pass "$name"; else fail "$name" "contains '$pattern'" "$actual"; fi
}

# ---------------------------------------------------------------------------
# Section 1: validate-model-token.ts — direct invocation
# ---------------------------------------------------------------------------

echo ""
echo "Section 1: validate-model-token.ts direct invocation"
echo "------------------------------------------------------"

run_validator() {
  npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "$1" 2>/dev/null
}

run_validator_stderr() {
  npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "$1" 2>&1 >/dev/null || true
}

# Valid family aliases
check "opus alias normalized to bare family" "opus" "$(run_validator "opus")"
check "sonnet alias normalized" "sonnet" "$(run_validator "sonnet")"
check "haiku alias normalized" "haiku" "$(run_validator "haiku")"

# Channel form
check "opus:preview alias normalized" "opus:preview" "$(run_validator "opus:preview")"

# inherit
check "inherit accepted" "inherit" "$(run_validator "inherit")"

# Pinned model ID
check "pinned model ID accepted" "claude-sonnet-4-6" "$(run_validator "claude-sonnet-4-6")"

# Invalid inputs
unknown_exit=$(npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "mystral" >/dev/null 2>&1; echo $?) || true
check "unknown family exits non-zero" "1" "$unknown_exit"

malformed_exit=$(npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "!!bad!!" >/dev/null 2>&1; echo $?) || true
check "malformed input exits non-zero" "1" "$malformed_exit"

# Empty value check (no positional arg → exit 1)
empty_exit=$(npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "" >/dev/null 2>&1; echo $?) || true
check "empty value exits non-zero" "1" "$empty_exit"

# Error messages mention the bad value
err_msg="$(run_validator_stderr "mystral")"
check_contains "unknown family error mentions the value" "mystral" "$err_msg"

err_msg_bad="$(run_validator_stderr "!!bad!!")"
check_contains "malformed error mentions the value" "bad" "$err_msg_bad"

# ---------------------------------------------------------------------------
# Section 2: Shell validate_model_token helper (extracted from wavemill-mill.sh)
# ---------------------------------------------------------------------------

echo ""
echo "Section 2: validate_model_token shell helper"
echo "---------------------------------------------"

# Replicate the helper exactly as defined in wavemill-mill.sh
validate_model_token() {
  local flag_name="$1" value="$2"
  if [[ -z "$value" ]]; then
    printf 'Error: %s requires a non-empty model selector\n' "$flag_name" >&2
    printf '  Accepted: family alias (opus, sonnet, haiku), inherit, or pinned model ID\n' >&2
    return 1
  fi
  local tmp_stderr normalized
  tmp_stderr="$(mktemp)"
  if ! normalized="$(npx tsx "$TOOLS_DIR/validate-model-token.ts" --repo-dir "$REPO_DIR" "$value" 2>"$tmp_stderr")"; then
    local err_msg
    err_msg="$(cat "$tmp_stderr" 2>/dev/null || true)"
    rm -f "$tmp_stderr"
    printf 'Error: %s value '"'"'%s'"'"' is not a valid model selector\n' "$flag_name" "$value" >&2
    if [[ -n "$err_msg" ]]; then printf '  %s\n' "$err_msg" >&2; fi
    printf '  Accepted: family alias (opus, sonnet, haiku), inherit, or pinned model ID\n' >&2
    return 1
  fi
  rm -f "$tmp_stderr"
  printf '%s' "$normalized"
}

# Valid inputs succeed
result="$(validate_model_token "--model" "opus" 2>/dev/null)"
check "helper: opus accepted" "opus" "$result"

result="$(validate_model_token "--model" "inherit" 2>/dev/null)"
check "helper: inherit accepted" "inherit" "$result"

result="$(validate_model_token "--planner-model" "sonnet" 2>/dev/null)"
check "helper: sonnet accepted for --planner-model" "sonnet" "$result"

result="$(validate_model_token "--coder-model" "haiku" 2>/dev/null)"
check "helper: haiku accepted for --coder-model" "haiku" "$result"

result="$(validate_model_token "--reviewer-model" "claude-sonnet-4-6" 2>/dev/null)"
check "helper: pinned model ID accepted for --reviewer-model" "claude-sonnet-4-6" "$result"

result="$(validate_model_token "--model" "opus:preview" 2>/dev/null)"
check "helper: opus:preview accepted" "opus:preview" "$result"

# Invalid inputs fail with helpful errors
err="$(validate_model_token "--model" "mystral" 2>&1 >/dev/null || true)"
check_contains "helper: unknown family names the flag" "\-\-model" "$err"
check_contains "helper: unknown family names the value" "mystral" "$err"

err_empty="$(validate_model_token "--model" "" 2>&1 >/dev/null || true)"
check_contains "helper: empty value names the flag" "\-\-model" "$err_empty"
check_contains "helper: empty value lists accepted forms" "family alias" "$err_empty"

err_bad="$(validate_model_token "--coder-model" "!!bad!!" 2>&1 >/dev/null || true)"
check_contains "helper: malformed names the flag" "\-\-coder-model" "$err_bad"

# ---------------------------------------------------------------------------
# Section 3: No shell alias allow-list in wavemill-mill.sh
# ---------------------------------------------------------------------------

echo ""
echo "Section 3: No shell alias allow-list"
echo "-------------------------------------"

MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

# Check that there's no hardcoded case/pattern matching opus|sonnet|haiku
if grep -E 'case.*opus\|sonnet\|haiku|opus\).*sonnet\).*haiku\)' "$MILL_SCRIPT" >/dev/null 2>&1; then
  fail "no shell alias allow-list" "no case opus|sonnet|haiku pattern" "found hardcoded alias pattern"
else
  pass "no shell alias allow-list (validation delegates to TypeScript)"
fi

# Ensure validate_model_token calls the TS tool (not a shell pattern match)
if grep -q "validate-model-token.ts" "$MILL_SCRIPT"; then
  pass "validate_model_token calls validate-model-token.ts"
else
  fail "validate_model_token calls TS tool" "validate-model-token.ts reference" "not found"
fi

# ---------------------------------------------------------------------------
# Section 4: Per-stage override precedence (helper-level simulation)
# ---------------------------------------------------------------------------

echo ""
echo "Section 4: Per-stage override precedence"
echo "-----------------------------------------"

# Simulate the precedence logic:
# 1. FORCE_MODEL sets all stages
# 2. Per-stage flags override for their stage
apply_model_overrides() {
  local force_model="${FORCE_MODEL:-}" planner coder reviewer
  # Initialize from router/routing file (simulated defaults)
  planner="claude-sonnet-4-6"
  coder="claude-opus-4-7"
  reviewer="claude-sonnet-4-6"

  # Global override
  if [[ -n "$force_model" ]]; then
    planner="$force_model"; coder="$force_model"; reviewer="$force_model"
  fi
  # Per-stage overrides
  if [[ -n "${FORCE_PLANNER_MODEL:-}" ]]; then planner="$FORCE_PLANNER_MODEL"; fi
  if [[ -n "${FORCE_CODER_MODEL:-}" ]]; then coder="$FORCE_CODER_MODEL"; fi
  if [[ -n "${FORCE_REVIEWER_MODEL:-}" ]]; then reviewer="$FORCE_REVIEWER_MODEL"; fi

  printf '%s %s %s\n' "$planner" "$coder" "$reviewer"
}

# No overrides — use router defaults
result="$(FORCE_MODEL= FORCE_PLANNER_MODEL= FORCE_CODER_MODEL= FORCE_REVIEWER_MODEL= apply_model_overrides)"
check "no overrides: router defaults unchanged" "claude-sonnet-4-6 claude-opus-4-7 claude-sonnet-4-6" "$result"

# Global FORCE_MODEL sets all stages
result="$(FORCE_MODEL=opus FORCE_PLANNER_MODEL= FORCE_CODER_MODEL= FORCE_REVIEWER_MODEL= apply_model_overrides)"
check "FORCE_MODEL sets all stages" "opus opus opus" "$result"

# Per-stage override takes precedence over FORCE_MODEL for its stage
result="$(FORCE_MODEL=opus FORCE_PLANNER_MODEL= FORCE_CODER_MODEL=sonnet FORCE_REVIEWER_MODEL= apply_model_overrides)"
check "FORCE_CODER_MODEL overrides FORCE_MODEL for coder" "opus sonnet opus" "$result"

# Per-stage without FORCE_MODEL overrides only its stage
result="$(FORCE_MODEL= FORCE_PLANNER_MODEL=haiku FORCE_CODER_MODEL= FORCE_REVIEWER_MODEL= apply_model_overrides)"
check "FORCE_PLANNER_MODEL only affects planner" "haiku claude-opus-4-7 claude-sonnet-4-6" "$result"

# All three per-stage flags
result="$(FORCE_MODEL= FORCE_PLANNER_MODEL=haiku FORCE_CODER_MODEL=opus FORCE_REVIEWER_MODEL=sonnet apply_model_overrides)"
check "all per-stage flags applied independently" "haiku opus sonnet" "$result"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [[ "$FAIL" -gt 0 ]]; then exit 1; fi
