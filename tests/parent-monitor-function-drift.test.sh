#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_DIR/tools/check-parent-monitor-drift.ts"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
MONITOR_SCRIPT_FILE="$REPO_DIR/shared/lib/wavemill-monitor.sh"

EXPECTED_DIVERGENT=$'_with_timeout\ncleanup_completed_task\ncleanup_remote_task_branch\nget_task_phase\nlinear_is_completed\nlinear_set_state\npr_state\nremove_task_state\nresolve_challenge_pair_hard_failure\nsave_task_state\nvalidate_pr_merge'

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-parent-monitor-drift.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

run_json() {
  local parent="$1"
  local monitor="$2"
  npx tsx "$CLI" --parent "$parent" --monitor "$monitor" --json
}

print_human_report() {
  local parent="$1"
  local monitor="$2"
  npx tsx "$CLI" --parent "$parent" --monitor "$monitor" || true
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local parent="${4:-$MILL_SCRIPT}"
  local monitor="${5:-$MONITOR_SCRIPT_FILE}"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $message" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    echo "" >&2
    print_human_report "$parent" "$monitor" >&2
    exit 1
  fi
}

baseline_json="$work_dir/baseline.json"
run_json "$MILL_SCRIPT" "$MONITOR_SCRIPT_FILE" > "$baseline_json"

duplicated_count="$(jq '.duplicated | length' "$baseline_json")"
identical_count="$(jq '.identical | length' "$baseline_json")"
divergent_count="$(jq '.divergent | length' "$baseline_json")"
divergent_names="$(jq -r '.divergent[].name' "$baseline_json" | sort)"

assert_eq "$duplicated_count" "45" "duplicated parent/monitor function count changed"
assert_eq "$identical_count" "34" "byte-identical parent/monitor function count changed"
assert_eq "$divergent_count" "11" "allowlisted divergent parent/monitor function count changed"
assert_eq "$divergent_names" "$EXPECTED_DIVERGENT" "allowlisted divergent parent/monitor function names changed"

mutated_monitor="$work_dir/mutated-identical-monitor.sh"
cp "$MONITOR_SCRIPT_FILE" "$mutated_monitor"
node - "$mutated_monitor" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
const marker = 'indent_block() {\n';
const text = readFileSync(file, 'utf8');
const index = text.indexOf(marker);
if (index === -1) throw new Error(`missing mutation marker ${marker}`);
writeFileSync(file, `${text.slice(0, index + marker.length)}  # monitor drift probe\n${text.slice(index + marker.length)}`);
NODE

mutated_json="$work_dir/mutated-identical.json"
run_json "$MILL_SCRIPT" "$mutated_monitor" > "$mutated_json"
mutated_divergent="$(jq -r '.divergent[].name' "$mutated_json" | sort)"
if ! grep -qx 'indent_block' <<< "$mutated_divergent"; then
  echo "FAIL: mutating one copy of an identical function was not detected" >&2
  print_human_report "$MILL_SCRIPT" "$mutated_monitor" >&2
  exit 1
fi

new_duplicate_parent="$work_dir/new-duplicate-parent.sh"
new_duplicate_monitor="$work_dir/new-duplicate-monitor.sh"
cp "$MILL_SCRIPT" "$new_duplicate_parent"
cp "$MONITOR_SCRIPT_FILE" "$new_duplicate_monitor"
probe_function=$'hok_2897_probe_duplicate() {\n  echo parent-monitor-drift-probe\n}\n'
printf '%s' "$probe_function" >> "$new_duplicate_parent"
printf '%s' "$probe_function" >> "$new_duplicate_monitor"

new_duplicate_json="$work_dir/new-duplicate.json"
run_json "$new_duplicate_parent" "$new_duplicate_monitor" > "$new_duplicate_json"
new_duplicate_count="$(jq '.duplicated | length' "$new_duplicate_json")"
assert_eq "$new_duplicate_count" "46" "introducing a new duplicated function was not detected" "$new_duplicate_parent" "$new_duplicate_monitor"

echo "parent-monitor-function-drift: ok"
