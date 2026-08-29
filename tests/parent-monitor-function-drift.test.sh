#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CLI="$REPO_DIR/tools/check-parent-monitor-drift.ts"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

EXPECTED_DIVERGENT=$'_with_timeout\ncleanup_completed_task\ncleanup_remote_task_branch\nget_task_phase\nlinear_is_completed\nlinear_set_state\npr_state\nremove_task_state\nresolve_challenge_pair_hard_failure\nsave_task_state\nvalidate_pr_merge'

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/wavemill-parent-monitor-drift.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT

run_json() {
  local file="$1"
  npx tsx "$CLI" --file "$file" --json
}

print_human_report() {
  local file="$1"
  npx tsx "$CLI" --file "$file" || true
}

assert_eq() {
  local actual="$1"
  local expected="$2"
  local message="$3"
  local file="${4:-$MILL_SCRIPT}"

  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $message" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    echo "" >&2
    print_human_report "$file" >&2
    exit 1
  fi
}

baseline_json="$work_dir/baseline.json"
run_json "$MILL_SCRIPT" > "$baseline_json"

duplicated_count="$(jq '.duplicated | length' "$baseline_json")"
identical_count="$(jq '.identical | length' "$baseline_json")"
divergent_count="$(jq '.divergent | length' "$baseline_json")"
divergent_names="$(jq -r '.divergent[].name' "$baseline_json" | sort)"

assert_eq "$duplicated_count" "45" "duplicated parent/monitor function count changed"
assert_eq "$identical_count" "34" "byte-identical parent/monitor function count changed"
assert_eq "$divergent_count" "11" "allowlisted divergent parent/monitor function count changed"
assert_eq "$divergent_names" "$EXPECTED_DIVERGENT" "allowlisted divergent parent/monitor function names changed"

mutated="$work_dir/mutated-identical.sh"
cp "$MILL_SCRIPT" "$mutated"
node - "$mutated" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
const marker = 'indent_block() {\n';
const text = readFileSync(file, 'utf8');
const index = text.indexOf(marker);
if (index === -1) throw new Error(`missing mutation marker ${marker}`);
writeFileSync(file, `${text.slice(0, index + marker.length)}  # parent drift probe\n${text.slice(index + marker.length)}`);
NODE

mutated_json="$work_dir/mutated-identical.json"
run_json "$mutated" > "$mutated_json"
mutated_divergent="$(jq -r '.divergent[].name' "$mutated_json" | sort)"
if ! grep -qx 'indent_block' <<< "$mutated_divergent"; then
  echo "FAIL: mutating one copy of an identical function was not detected" >&2
  print_human_report "$mutated" >&2
  exit 1
fi

new_duplicate="$work_dir/new-duplicate.sh"
cp "$MILL_SCRIPT" "$new_duplicate"
node - "$new_duplicate" <<'NODE'
const { readFileSync, writeFileSync } = require('node:fs');
const file = process.argv[2];
let text = readFileSync(file, 'utf8');
const parentFunction = 'hok_2897_probe_duplicate() {\n  echo parent-monitor-drift-probe\n}\n';
const monitorFunction = 'hok_2897_probe_duplicate() {\n  echo parent-monitor-drift-probe\n}\n';
const opener = text.match(/^.*<<-?['"]?MONITOR_EOF['"]?.*\n/m);
if (!opener?.index) throw new Error('missing MONITOR_EOF opener');
text = `${text.slice(0, opener.index)}${parentFunction}${text.slice(opener.index)}`;
const terminator = text.match(/^MONITOR_EOF$/m);
if (!terminator?.index) throw new Error('missing MONITOR_EOF terminator');
text = `${text.slice(0, terminator.index)}${monitorFunction}${text.slice(terminator.index)}`;
writeFileSync(file, text);
NODE

new_duplicate_json="$work_dir/new-duplicate.json"
run_json "$new_duplicate" > "$new_duplicate_json"
new_duplicate_count="$(jq '.duplicated | length' "$new_duplicate_json")"
assert_eq "$new_duplicate_count" "46" "introducing a new duplicated function was not detected" "$new_duplicate"

echo "parent-monitor-function-drift: ok"
