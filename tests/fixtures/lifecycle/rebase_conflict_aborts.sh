#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "rebase-conflict"
create_task_branch "task/rebase-conflict" "conflict"
write_integration_config true "require-label"

body="$(metadata_body 'task: HOK-1442')"
export PR_LIST_JSON="[$(pr_json 31 "Rebase conflict" "task/rebase-conflict" "2026-04-01T00:00:00Z" "$body")]"
export FAKE_REBASE_CONFLICT=1

output="$(run_tend_once)"

assert_contains "$output" "action=blocked-#31" "rebase conflict should block the PR"
assert_log_count "gh pr merge 31" 0 "$GH_LOG"
assert_log_count "git rebase --abort" 1 "$GIT_LOG"
if ! grep -q "Wavemill Rebase failed" "$GH_LOG"; then
  echo "FAIL: rebase failure comment was not posted"
  cat "$GH_LOG"
  exit 1
fi

echo "PASS: rebase conflict aborted cleanly"
