#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "one-at-a-time"
create_task_branch "task/first" "first"
create_task_branch "task/second" "second"
create_task_branch "task/third" "third"
write_integration_config true "require-label"

body_1="$(metadata_body 'task: HOK-1442')"
body_2="$(metadata_body 'task: HOK-1443')"
body_3="$(metadata_body 'task: HOK-1444')"
export PR_LIST_JSON="[$(pr_json 21 "First" "task/first" "2026-04-01T00:00:00Z" "$body_1"),$(pr_json 22 "Second" "task/second" "2026-04-02T00:00:00Z" "$body_2"),$(pr_json 23 "Third" "task/third" "2026-04-03T00:00:00Z" "$body_3")]"

output="$(run_tend_once)"

assert_contains "$output" "eligible=3 blocked=0 health=ok" "all three PRs should be eligible before selection"
assert_contains "$output" "action=merged-#21" "oldest eligible PR should merge"
assert_log_count "gh pr merge" 1 "$GH_LOG"
assert_log_count "gh pr merge 21" 1 "$GH_LOG"

echo "PASS: one-at-a-time merge selected only one PR"
