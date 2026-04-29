#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "integration-red"
create_task_branch "task/wait-for-green" "wait for green"
write_integration_config false

body="$(metadata_body 'task: HOK-1442')"
export PR_LIST_JSON="[$(pr_json 13 "Wait for green" "task/wait-for-green" "2026-04-01T00:00:00Z" "$body")]"
export CHECK_RUNS_JSON='{"check_runs":[{"name":"ci","conclusion":"failure"}]}'

output="$(run_tend_once)"

assert_contains "$output" "eligible=0 blocked=0 health=degraded" "red integration branch should stop candidate selection"
assert_contains "$output" "action=idle" "red integration branch should idle instead of merging"
assert_log_count "gh pr merge" 0 "$GH_LOG"

echo "PASS: integration red halted merge"
