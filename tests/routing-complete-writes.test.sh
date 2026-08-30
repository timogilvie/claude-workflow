#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

echo "=== Routing Complete Write Guards ==="

if grep -Fq 'route_max_cost_usd' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" \
  && grep -Fq '{maxCostUsd: $maxCostUsd}' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE"; then
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

if grep -Fq 'provenance' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" \
  && grep -Fq 'provenance' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh"; then
  pass "routing-complete writes include provenance metadata"
else
  fail "routing-complete writes are missing provenance metadata"
fi

if grep -Fq 'if [[ -f "$feature_dir/.initial-route.json" ]]' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" \
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

if grep -Fq 'write_json_artifact()' "$REPO_DIR/shared/lib/wavemill-common.sh" \
  && grep -Fq 'write_json_artifact "$feature_dir/.routing-complete"' "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" \
  && grep -Fq 'write_json_artifact "$routing_file"' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE"; then
  pass "route artifacts use strict JSON writer helper"
else
  fail "strict JSON writer helper is missing from route artifact writes"
fi

assert_strict_json() {
  local artifact="$1" label="$2"
  if jq -e . "$artifact" >/dev/null 2>&1; then
    pass "$label is strict JSON"
  else
    fail "$label is not strict JSON"
  fi
}

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

printf '{"ok":true}\n' > "$tmpdir/.routing-complete"
printf '{"ok":true}\n' > "$tmpdir/routing-complete.json"
printf '{"ok":true}\n' > "$tmpdir/.post-expansion-route.json"
printf '{"ok":true}\n' > "$tmpdir/post-expansion-route.json"

assert_strict_json "$tmpdir/.routing-complete" ".routing-complete"
assert_strict_json "$tmpdir/routing-complete.json" "routing-complete.json"
assert_strict_json "$tmpdir/.post-expansion-route.json" ".post-expansion-route.json"
assert_strict_json "$tmpdir/post-expansion-route.json" "post-expansion-route.json"

printf 'Router: warning\n{"ok":true}\n' > "$tmpdir/prepended.json"
if jq -e . "$tmpdir/prepended.json" >/dev/null 2>&1; then
  fail "prepended log text should fail strict JSON parsing"
else
  pass "prepended log text fails strict JSON parsing"
fi

printf '{"ok":true}\nAuto-aggregated stats\n' > "$tmpdir/appended.json"
if jq -e . "$tmpdir/appended.json" >/dev/null 2>&1; then
  fail "appended log text should fail strict JSON parsing"
else
  pass "appended log text fails strict JSON parsing"
fi

: > "$tmpdir/empty.json"
if jq -e . "$tmpdir/empty.json" >/dev/null 2>&1; then
  fail "empty artifact should fail strict JSON parsing"
else
  pass "empty artifact fails strict JSON parsing"
fi

restore_body="$(awk '
  /^_restore_inflight_task_window_if_missing\(\) \{/ { capture=1; depth=0 }
  capture {
    print
    depth += gsub(/\{/, "{")
    depth -= gsub(/\}/, "}")
    if (depth == 0) exit
  }
' "$MONITOR_SCRIPT_FILE")"
if grep -Fq 'apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG"' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" \
  && ! grep -Fq 'apply_expanded_route_if_present' <<<"$restore_body"; then
  pass "mill applies expanded route at initial coding handoff; recovery replays its persisted contract"
else
  fail "mill does not preserve initial routing while keeping recovery contract-bound"
fi

if grep -Fq 'agent: ${resolved_planner_agent}${planner_launch_model:+ --model $planner_launch_model}' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE"; then
  pass "initial planning launch log reports planner agent and model"
else
  fail "initial planning launch log does not report planner agent and model"
fi

if grep -Fq 'reroute_expanded_packets_for_coding_handoff' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" \
  && grep -Fq -- '--expanded-jsonl' "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE"; then
  pass "mill batches expanded reroute through route-tasks expanded mode"
else
  fail "mill is missing expanded reroute batch handoff"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
