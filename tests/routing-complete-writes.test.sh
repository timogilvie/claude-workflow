#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Routing Complete Write Guards ==="

if grep -Fq 'route_max_cost_usd' "$MILL_SCRIPT" \
  && grep -Fq '{maxCostUsd: $maxCostUsd}' "$MILL_SCRIPT"; then
  pass "mill carries maxCostUsd through route payload and routing writes"
else
  fail "mill is missing maxCostUsd propagation in routing writes"
fi

if grep -Fq 'route.maxCostUsd' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" \
  && grep -Fq '{maxCostUsd: $maxCostUsd}' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "startup runner writes maxCostUsd into .routing-complete"
else
  fail "startup runner is missing maxCostUsd in .routing-complete writes"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
