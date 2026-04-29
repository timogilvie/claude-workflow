#!/usr/bin/env bash
set -euo pipefail

if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=tests/fixtures/lifecycle/autonomous_integration_helpers.sh
source "$SCRIPT_DIR/autonomous_integration_helpers.sh"

init_autonomous_integration_fixture "challenge-winner"
create_task_branch "task/challenge-primary" "primary"
create_task_branch "task/challenge-loser" "loser"
write_integration_config true "require-label"

mkdir -p "$REPO_DIR/.wavemill/evals"
cat > "$REPO_DIR/.wavemill/workflow-state.json" <<'EOF'
{
  "tasks": {
    "HOK_1442": {
      "pr": 101,
      "challengePairId": "pair-1442",
      "challengeRole": "primary"
    },
    "HOK_1442_c": {
      "pr": 102,
      "challengePairId": "pair-1442",
      "challengeRole": "challenger"
    }
  }
}
EOF
cat > "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" <<'EOF'
{"challengePairId":"pair-1442","primaryModel":"primary","challengerModel":"challenger","primaryPrUrl":"https://github.com/example/repo/pull/101","challengerPrUrl":"https://github.com/example/repo/pull/102","primaryEvalScore":0.9,"challengerEvalScore":0.5,"winner":"primary","winnerModel":"primary","rationale":"primary wins","dimensions":{"completeness":{"primary":1,"challenger":0.5},"correctness":{"primary":1,"challenger":0.5},"code_quality":{"primary":1,"challenger":0.5},"intervention_impact":{"primary":1,"challenger":0.5},"autonomy":{"primary":1,"challenger":0.5}},"timestamp":"2026-04-28T12:00:00Z"}
EOF

winner_body="$(metadata_body 'task: HOK-1442
challenge: true
challengePairId: pair-1442')"
loser_body="$(metadata_body 'task: HOK-1442_c
challenge: true
challengePairId: pair-1442')"
export PR_LIST_JSON="[$(pr_json 101 "Winner" "task/challenge-primary" "2026-04-01T00:00:00Z" "$winner_body"),$(pr_json 102 "Loser" "task/challenge-loser" "2026-04-02T00:00:00Z" "$loser_body")]"

output="$(run_tend_once)"

assert_contains "$output" "eligible=1 blocked=1 health=ok" "challenge loser should be blocked while winner is eligible"
assert_contains "$output" "action=merged-#101" "challenge winner should merge"
assert_log_count "gh pr merge 101" 1 "$GH_LOG"
assert_log_count "gh pr close 102" 1 "$GH_LOG"

echo "PASS: challenge winner merged and loser dropped"
