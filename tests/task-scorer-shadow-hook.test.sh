#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MILL="$REPO_DIR/shared/lib/wavemill-mill.sh"

grep -q '^run_task_scorer_shadow() {' "$MILL"
grep -q 'WAVEMILL_TASK_SCORER_SHADOW:-1' "$MILL"
grep -q '_with_timeout 5 npx tsx "\$TOOLS_DIR/score-task-packet.ts"' "$MILL"
grep -q 'run_task_scorer_shadow "\$ISSUE" "\$FEATURE_DIR" "\$WT_DIR"' "$MILL"
grep -q 'task-scorer-result.json' "$MILL"
echo 'PASS task scorer shadow hook is fail-open and registered in the coding handoff'
