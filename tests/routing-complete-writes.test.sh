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

if grep -Fq 'provenance' "$MILL_SCRIPT" \
  && grep -Fq 'provenance' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "routing-complete writes include provenance metadata"
else
  fail "routing-complete writes are missing provenance metadata"
fi

if grep -Fq 'if [[ -f "$feature_dir/.initial-route.json" ]]' "$MILL_SCRIPT" \
  && grep -Fq 'if [[ -f "$feature_dir/.initial-route.json" ]]' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "initial-route writes are guarded for immutability"
else
  fail "initial-route immutability guard is missing"
fi

if grep -Fq 'apply_expanded_route_if_present()' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -Fq '.post-expansion-route.json' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -Fq '.expanded-route.json' "$REPO_DIR/shared/lib/wavemill-common.sh"; then
  pass "shared expanded-route apply helper prefers post-expansion artifacts"
else
  fail "expanded-route apply helper or precedence guard is missing"
fi

if grep -Fq 'apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG"' "$MILL_SCRIPT" \
  && grep -Fq 'apply_expanded_route_if_present "$feature_dir" "$issue" "$slug"' "$MILL_SCRIPT"; then
  pass "mill applies expanded route before coding launch and coding resume"
else
  fail "mill is missing expanded-route apply call sites"
fi

if grep -Fq 'reroute_expanded_packets_for_coding_handoff' "$MILL_SCRIPT" \
  && grep -Fq -- '--expanded-jsonl' "$MILL_SCRIPT"; then
  pass "mill batches expanded reroute through route-tasks expanded mode"
else
  fail "mill is missing expanded reroute batch handoff"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
