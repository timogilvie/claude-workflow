#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "approval-required"
create_task_branch "task/high-risk" "high risk"
write_integration_config true "block"

body="$(metadata_body 'task: HOK-1442
risk: high')"
export PR_LIST_JSON="[$(pr_json 12 "High risk" "task/high-risk" "2026-04-01T00:00:00Z" "$body" '[{"name":"wavemill"},{"name":"wm:ready"},{"name":"Risk: High"}]')]"
export PR_VIEW_DIR="$TMP_DIR/pr-view"
mkdir -p "$PR_VIEW_DIR"
BODY="$body" node -e '
  process.stdout.write(JSON.stringify({
    number: 12,
    title: "High risk",
    body: process.env.BODY,
    state: "OPEN",
    author: { login: "bot" },
    headRefName: "task/high-risk",
    baseRefName: "auto/integration",
    labels: [{ name: "wavemill" }, { name: "wm:ready" }, { name: "Risk: High" }],
    url: "https://github.com/example/repo/pull/12",
    createdAt: "2026-04-01T00:00:00Z",
    updatedAt: "2026-04-01T00:00:00Z",
    mergedAt: null,
    closedAt: null,
  }));
' > "$PR_VIEW_DIR/12.json"

output="$(run_tend_once)"

assert_contains "$output" "action=blocked-#12" "high-risk PR should be blocked by ready policy"
assert_log_count "gh pr merge 12" 0 "$GH_LOG"
if ! grep -q "High-risk PRs are blocked" "$GH_LOG"; then
  echo "FAIL: high-risk block reason was not posted"
  cat "$GH_LOG"
  exit 1
fi

echo "PASS: approval requirement blocked merge"
