#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "blocked-dependency"
create_task_branch "task/blocked-dependency" "blocked dependency"
write_integration_config false

body="$(metadata_body 'task: HOK-1442
depends_on_linear: ["HOK-9999"]')"
export PR_LIST_JSON="[$(pr_json 11 "Blocked dependency" "task/blocked-dependency" "2026-04-01T00:00:00Z" "$body")]"

output="$(run_tend_dry_run)"

assert_contains "$output" "eligible=0 blocked=1 health=ok" "dependency-blocked PR should be held"
assert_log_count "gh pr merge" 0 "$GH_LOG"

echo "PASS: blocked dependency halted merge"
