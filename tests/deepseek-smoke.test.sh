#!/usr/bin/env bash
# Shell-level integration tests for tools/smoke-deepseek.ts
# Run with: bash tests/deepseek-smoke.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

if ! command -v npx >/dev/null 2>&1; then
  echo "  SKIP  npx not available"
  exit 0
fi

# ============================================================================
# TEST: dry-run mode exits 0 and shows expected markers (no API key needed)
# ============================================================================
echo ""
echo "=== dry-run mode ==="

rc=0
output=""
output="$(DEEPSEEK_API_KEY="" npx tsx "$REPO_DIR/tools/smoke-deepseek.ts" 2>&1)" || rc=$?

if [[ "$rc" -eq 0 ]]; then
  pass "dry-run exits 0 without DEEPSEEK_API_KEY"
else
  fail "dry-run exit code" "expected 0, got $rc"
fi

if printf '%s' "$output" | grep -q "Dry Run"; then
  pass "dry-run output contains 'Dry Run'"
else
  fail "dry-run output 'Dry Run'" "not found in: $output"
fi

if printf '%s' "$output" | grep -q "ANTHROPIC_BASE_URL"; then
  pass "dry-run output lists ANTHROPIC_BASE_URL"
else
  fail "dry-run output ANTHROPIC_BASE_URL" "not found in: $output"
fi

if printf '%s' "$output" | grep -q "ANTHROPIC_AUTH_TOKEN"; then
  pass "dry-run output lists ANTHROPIC_AUTH_TOKEN"
else
  fail "dry-run output ANTHROPIC_AUTH_TOKEN" "not found in: $output"
fi

if printf '%s' "$output" | grep -q "ANTHROPIC_MODEL"; then
  pass "dry-run output lists ANTHROPIC_MODEL"
else
  fail "dry-run output ANTHROPIC_MODEL" "not found in: $output"
fi

# ============================================================================
# TEST: --live without API key exits 0 with skip message
# ============================================================================
echo ""
echo "=== --live without API key ==="

rc=0
output=""
output="$(DEEPSEEK_API_KEY="" npx tsx "$REPO_DIR/tools/smoke-deepseek.ts" --live 2>&1)" || rc=$?

if [[ "$rc" -eq 0 ]]; then
  pass "--live without API key exits 0"
else
  fail "--live without API key exit code" "expected 0, got $rc"
fi

if printf '%s' "$output" | grep -qi "skipping"; then
  pass "--live without API key shows skip message"
else
  fail "--live without API key skip message" "not found in: $output"
fi

# ============================================================================
# TEST: --live with stub succeeds without leaking secret
# ============================================================================
echo ""
echo "=== --live with stub ==="

rc=0
output=""
output="$(DEEPSEEK_API_KEY="deepseek-secret-value" WAVEMILL_DEEPSEEK_SMOKE_STUB=1 \
  npx tsx "$REPO_DIR/tools/smoke-deepseek.ts" --live 2>&1)" || rc=$?

if [[ "$rc" -eq 0 ]]; then
  pass "--live with stub exits 0"
else
  fail "--live with stub exit code" "expected 0, got $rc"
fi

if printf '%s' "$output" | grep -q "deepseek-secret-value"; then
  fail "--live with stub no secret leakage" "output contains API key"
else
  pass "--live with stub does not leak API key"
fi

# ============================================================================
# TEST: --help exits 0
# ============================================================================
echo ""
echo "=== --help ==="

rc=0
output=""
output="$(npx tsx "$REPO_DIR/tools/smoke-deepseek.ts" --help 2>&1)" || rc=$?

if [[ "$rc" -eq 0 ]]; then
  pass "--help exits 0"
else
  fail "--help exit code" "expected 0, got $rc"
fi

if printf '%s' "$output" | grep -q "Usage:"; then
  pass "--help shows usage"
else
  fail "--help shows usage" "not found in: $output"
fi

# ============================================================================
# Results
# ============================================================================

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
echo ""

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
