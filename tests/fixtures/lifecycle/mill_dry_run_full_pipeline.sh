#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tend-fixture-lib.sh"

create_tend_fixture_root "wavemill-mill-dry-run"
trap cleanup_tend_fixture_root EXIT

GH_CALL_LOG="$TMP_DIR/gh-calls.log"
GIT_CALL_LOG="$TMP_DIR/git-calls.log"
TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
STDOUT_FILE="$TMP_DIR/stdout.log"
STDERR_FILE="$TMP_DIR/stderr.log"
LAUNCH_PLAN_FILE="$TMP_DIR/launch-plan.json"
BACKLOG_FILE="$TMP_DIR/backlog.json"
export GH_CALL_LOG GIT_CALL_LOG TMUX_CALL_LOG
: > "$GH_CALL_LOG"
: > "$GIT_CALL_LOG"
: > "$TMUX_CALL_LOG"

mkdir -p "$REPO_DIR/.wavemill" "$TMP_DIR/worktrees" "$TMP_DIR/home"

cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "version": 1,
  "linear": {
    "project": "Fixture Project"
  },
  "mill": {
    "agentCmd": "codex",
    "baseBranch": "auto/integration",
    "worktreeRoot": "$TMP_DIR/worktrees",
    "maxParallel": 2,
    "requireConfirm": false
  },
  "taskSelection": {
    "enterLaunchesWave": true
  }
}
EOF

cat > "$BACKLOG_FILE" <<'EOF'
[
  {
    "id": "issue-1",
    "identifier": "HOK-1545",
    "title": "Add dry run launch plan coverage",
    "description": "## 1. Objective\nValidate the full startup launch-plan path.\n\n## Success Criteria\n- Builds a launch plan from fixture data.\n- Never launches tmux.",
    "priority": 2,
    "estimate": 3,
    "state": { "name": "Backlog" },
    "labels": {
      "nodes": [
        { "name": "Area: Startup" },
        { "name": "Foundational" }
      ]
    },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  },
  {
    "id": "issue-2",
    "identifier": "HOK-1600",
    "title": "Normalize route payload assembly",
    "description": "Route payload assembly must stay valid when review mode and max cost are both present.",
    "priority": 3,
    "estimate": 2,
    "state": { "name": "Todo" },
    "labels": {
      "nodes": [
        { "name": "Component: Routing" }
      ]
    },
    "relations": { "nodes": [] },
    "inverseRelations": { "nodes": [] }
  }
]
EOF

write_fake_git
write_fake_gh
write_fake_tmux
write_fake_npx
export GIT_COMMON_DIR="$GIT_DIR"

export HOME="$TMP_DIR/home"
export STATE_DIR="$TMP_DIR/state"
export SESSION="mill-dry-run-$$"
export SKIP_CONFIG_CHECK=true
export SKIP_CONTEXT_CHECK=true
export WAVEMILL_NO_PROGRESS=1
export REQUIRE_CONFIRM=false
export WAVEMILL_DRY_RUN_BACKLOG_FILE="$BACKLOG_FILE"
export WAVEMILL_DRY_RUN_PLAN_OUT="$LAUNCH_PLAN_FILE"
export GH_REPO="acme/wavemill"

set +e
(
  cd "$REPO_DIR"
  unset WAVEMILL_MILL_ACTIVE
  printf '\n' | "$REPO_ROOT/wavemill" mill \
  --dry-run \
  --dry-run-plan-out "$LAUNCH_PLAN_FILE" \
  --dry-run-backlog "$BACKLOG_FILE" \
  >"$STDOUT_FILE" 2>"$STDERR_FILE"
)
status=$?
set -e

if [[ "$status" -ne 0 ]]; then
  echo "FAIL: wavemill mill --dry-run exited $status"
  if [[ -s "$STDERR_FILE" ]]; then echo "--- stderr ---"; cat "$STDERR_FILE"; fi
  if [[ -s "$STDOUT_FILE" ]]; then echo "--- stdout ---"; cat "$STDOUT_FILE"; fi
  exit 1
fi

if [[ ! -f "$LAUNCH_PLAN_FILE" ]]; then
  echo "FAIL: launch plan was not written"
  exit 1
fi

if ! jq empty "$LAUNCH_PLAN_FILE" >/dev/null 2>&1; then
  echo "FAIL: launch plan is not valid JSON"
  cat "$LAUNCH_PLAN_FILE"
  exit 1
fi

task_count="$(jq '.tasks | length' "$LAUNCH_PLAN_FILE")"
if [[ "$task_count" -lt 1 ]]; then
  echo "FAIL: expected at least one launch-plan task"
  exit 1
fi

if ! jq -e '
  .monitorConfig.dryRun == true and
  (.tasks | length >= 1) and
  all(.tasks[]; (.issue and .slug and .title and .branch and .worktreeDir and .linearIssueId and .taskPacketFile and .issueJsonFile and .route and .agent)) and
  all(.tasks[]; (.route.planner and .route.coder and .route.reviewer and .route.planDepth and .route.codeDepth and .route.reviewMode)) and
  (.tasks[0].route | has("maxCostUsd"))
' "$LAUNCH_PLAN_FILE" >/dev/null; then
  echo "FAIL: launch plan schema assertions failed"
  cat "$LAUNCH_PLAN_FILE"
  exit 1
fi

for pattern in 'jq: error' 'unbound variable' 'command not found' 'unexpected gh' 'unexpected git' 'unexpected tmux'; do
  if grep -q "$pattern" "$STDERR_FILE"; then
    echo "FAIL: stderr contained '$pattern'"
    cat "$STDERR_FILE"
    exit 1
  fi
done

if [[ -s "$GH_CALL_LOG" ]]; then
  echo "FAIL: unexpected gh calls during dry-run"
  cat "$GH_CALL_LOG"
  exit 1
fi

if [[ -s "$TMUX_CALL_LOG" ]]; then
  echo "FAIL: tmux should not be called in default dry-run path"
  cat "$TMUX_CALL_LOG"
  exit 1
fi

if grep -q '^fetch ' "$GIT_CALL_LOG"; then
  echo "FAIL: dry-run should not fetch from git remotes"
  cat "$GIT_CALL_LOG"
  exit 1
fi

echo "PASS: mill dry-run full pipeline"
