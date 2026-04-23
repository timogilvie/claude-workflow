#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
RUNNER_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

make_mock_bin() {
  local dir="$1"
  mkdir -p "$dir"

  cat > "$dir/tmux" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'tmux %s\n' "$*" >> "${MOCK_TMUX_LOG:?}"
case "${1:-}" in
  list-panes)
    printf '0\n'
    ;;
  *)
    ;;
esac
EOF
  chmod +x "$dir/tmux"

  cat > "$dir/git" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'git %s\n' "$*" >> "${MOCK_GIT_LOG:?}"
if [[ "${1:-}" == "show-ref" ]]; then
  exit 1
fi
if [[ "${1:-}" == "worktree" && "${2:-}" == "add" ]]; then
  wt_dir="${3:-}"
  if [[ -n "${FAIL_WORKTREE_MATCH:-}" && "$wt_dir" == *"$FAIL_WORKTREE_MATCH"* ]]; then
    exit 1
  fi
  mkdir -p "$wt_dir"
  exit 0
fi
exit 0
EOF
  chmod +x "$dir/git"

  cat > "$dir/npx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'npx %s\n' "$*" >> "${MOCK_NPX_LOG:?}"
if [[ "$*" == *"set-issue-state.ts"* ]]; then
  printf '%s|%s\n' "${3:-}" "${4:-}" >> "${MOCK_LINEAR_LOG:?}"
fi
exit 0
EOF
  chmod +x "$dir/npx"

  cat > "$dir/claude" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "auth" && "${2:-}" == "status" ]]; then
  exit 0
fi
cat >/dev/null || true
exit 0
EOF
  chmod +x "$dir/claude"
}

write_plan() {
  local plan_file="$1"
  local repo_dir="$2"
  local state_dir="$3"
  local state_file="$4"
  local session="$5"
  local monitor_env="$6"
  local monitor_script="$7"
  local status_log="$8"
  local launched_file="$9"
  local tasks_json="${10}"

  jq -n \
    --arg session "$session" \
    --arg repoDir "$repo_dir" \
    --arg baseBranch "main" \
    --arg worktreeRoot "$repo_dir/worktrees" \
    --arg planningMode "interactive" \
    --arg agentCmd "claude" \
    --arg stateDir "$state_dir" \
    --arg stateFile "$state_file" \
    --arg toolsDir "$repo_dir/tools" \
    --arg libDir "$repo_dir/shared/lib" \
    --arg initialPhase "planning" \
    --arg statusLogFile "$status_log" \
    --arg monitorEnv "$monitor_env" \
    --arg monitorScript "$monitor_script" \
    --arg launchedIssuesFile "$launched_file" \
    --argjson tasks "$tasks_json" \
    '{
      session: $session,
      repoDir: $repoDir,
      baseBranch: $baseBranch,
      worktreeRoot: $worktreeRoot,
      planningMode: $planningMode,
      agentCmd: $agentCmd,
      agentCmdExplicit: false,
      forceModel: null,
      routerEnabled: true,
      maxParallel: 2,
      stateDir: $stateDir,
      stateFile: $stateFile,
      toolsDir: $toolsDir,
      libDir: $libDir,
      initialPhase: $initialPhase,
      startupConfig: {
        statusLogFile: $statusLogFile,
        monitorEnv: $monitorEnv,
        monitorScript: $monitorScript,
        launchedIssuesFile: $launchedIssuesFile
      },
      monitorConfig: {
        pollSeconds: 30,
        requireConfirm: true,
        dryRun: false,
        projectName: "Hokusai",
        autoEval: true,
        dashboardVerbosity: "info",
        dashboardLogToFile: true
      },
      tasks: $tasks
    }' > "$plan_file"
}

echo "=== Startup Handoff Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" || ! -f "$RUNNER_SCRIPT" ]]; then
  fail "required mill/startup-runner scripts are missing"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

PRE_TMUX_BLOCK="$(awk '
  /^LAUNCH_ARGS=\(\)$/ { capture=1 }
  /^# Now attach to the session$/ { capture=0 }
  capture { print }
' "$MILL_SCRIPT")"

OUTER_PRE_HANDOFF_BLOCK="$(awk '
  /^LAUNCH_ARGS=\(\)$/ { capture=1 }
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { capture=0 }
  capture { print }
' "$MILL_SCRIPT")"

if [[ "$PRE_TMUX_BLOCK" == *'write_launch_plan "$LAUNCH_PLAN_FILE"'* ]] \
  && [[ "$PRE_TMUX_BLOCK" == *'create_tmux_session'* ]]; then
  pass "mill writes the launch plan and creates tmux before startup handoff"
else
  fail "mill is missing the launch-plan handoff or tmux bootstrap"
fi

if [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'linear_set_state'* ]] \
  || [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'set_task_phase'* ]] \
  || [[ "$OUTER_PRE_HANDOFF_BLOCK" == *'save_task_state'* ]]; then
  fail "mill still mutates workflow state before tmux startup"
else
  pass "mill avoids workflow-state and Linear mutations before tmux startup"
fi

TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

TEST_REPO="$TMP_ROOT/repo"
mkdir -p "$TEST_REPO/shared/lib" "$TEST_REPO/tools/prompts" "$TEST_REPO/worktrees" "$TEST_REPO/.claude"
mkdir -p "$TMP_ROOT/home/.claude" "$TMP_ROOT/home/.codex"
cp "$REPO_DIR/shared/lib/wavemill-startup-runner.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-common.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/agent-adapters.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/model-validator.ts" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/shared/lib/wavemill-status.sh" "$TEST_REPO/shared/lib/"
cp "$REPO_DIR/tools/prompts/"*.md "$TEST_REPO/tools/prompts/"
printf '{}' > "$TMP_ROOT/home/.claude.json"
printf '{"token":"ok"}' > "$TMP_ROOT/home/.codex/auth.json"

MOCK_BIN="$TMP_ROOT/mock-bin"
make_mock_bin "$MOCK_BIN"

export HOME="$TMP_ROOT/home"
export PATH="$MOCK_BIN:$PATH"
export MOCK_TMUX_LOG="$TMP_ROOT/tmux.log"
export MOCK_GIT_LOG="$TMP_ROOT/git.log"
export MOCK_NPX_LOG="$TMP_ROOT/npx.log"
export MOCK_LINEAR_LOG="$TMP_ROOT/linear.log"
touch "$MOCK_TMUX_LOG" "$MOCK_GIT_LOG" "$MOCK_NPX_LOG" "$MOCK_LINEAR_LOG"

STATE_DIR="$TEST_REPO/.wavemill"
STATE_FILE="$STATE_DIR/workflow-state.json"
mkdir -p "$STATE_DIR"
printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"

TASK_ONE_JSON="$(jq -n \
  --arg issue "HOK-1001" \
  --arg slug "alpha-task" \
  --arg title "Alpha Task" \
  --arg branch "task/alpha-task" \
  --arg worktreeDir "$TEST_REPO/worktrees/alpha-task" \
  --arg linearIssueId "HOK-1001" \
  --arg taskPacketFile "$TMP_ROOT/HOK-1001-taskpacket.md" \
  --arg taskPacketDetailsFile "$TMP_ROOT/HOK-1001-taskpacket-details.md" \
  --arg issueJsonFile "$TMP_ROOT/HOK-1001-issue.json" \
  '{
    issue: $issue,
    slug: $slug,
    title: $title,
    branch: $branch,
    worktreeDir: $worktreeDir,
    linearIssueId: $linearIssueId,
    taskPacketFile: $taskPacketFile,
    taskPacketDetailsFile: $taskPacketDetailsFile,
    issueJsonFile: $issueJsonFile,
    route: {
      planner: "claude-sonnet-4-5-20250929",
      coder: "claude-opus-4-6",
      reviewer: "claude-sonnet-4-5-20250929",
      planDepth: "deep",
      codeDepth: "medium",
      reviewMode: "static",
      maxCostUsd: 12.5
    },
    challenge: false,
    challengePairId: null,
    challengeRole: null,
    challengeModel: null,
    migrationNumber: null,
    agent: "claude"
  }')"

TASK_TWO_JSON="$(jq -n \
  --arg issue "HOK-1002" \
  --arg slug "broken-task" \
  --arg title "Broken Task" \
  --arg branch "task/broken-task" \
  --arg worktreeDir "$TEST_REPO/worktrees/broken-task" \
  --arg linearIssueId "HOK-1002" \
  --arg taskPacketFile "$TMP_ROOT/HOK-1002-taskpacket.md" \
  --arg taskPacketDetailsFile "$TMP_ROOT/HOK-1002-taskpacket-details.md" \
  --arg issueJsonFile "$TMP_ROOT/HOK-1002-issue.json" \
  '{
    issue: $issue,
    slug: $slug,
    title: $title,
    branch: $branch,
    worktreeDir: $worktreeDir,
    linearIssueId: $linearIssueId,
    taskPacketFile: $taskPacketFile,
    taskPacketDetailsFile: $taskPacketDetailsFile,
    issueJsonFile: $issueJsonFile,
    route: {
      planner: "claude-sonnet-4-5-20250929",
      coder: "claude-opus-4-6",
      reviewer: "claude-sonnet-4-5-20250929",
      planDepth: "deep",
      codeDepth: "medium",
      reviewMode: "static"
    },
    challenge: false,
    challengePairId: null,
    challengeRole: null,
    challengeModel: null,
    migrationNumber: null,
    agent: "claude"
  }')"

for issue in HOK-1001 HOK-1002; do
  printf 'Task packet for %s\n' "$issue" > "$TMP_ROOT/${issue}-taskpacket.md"
  printf 'Detailed packet for %s\n' "$issue" > "$TMP_ROOT/${issue}-taskpacket-details.md"
  jq -n --arg desc "Description for $issue" '{description: $desc, labels: {nodes: []}}' > "$TMP_ROOT/${issue}-issue.json"
done

SUCCESS_PLAN="$TMP_ROOT/success-plan.json"
SUCCESS_MONITOR_ENV="$TMP_ROOT/success-monitor.env"
SUCCESS_MONITOR_SCRIPT="$TMP_ROOT/success-monitor.sh"
SUCCESS_STATUS_LOG="$TMP_ROOT/success-status.log"
SUCCESS_LAUNCHED="$TMP_ROOT/success-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$SUCCESS_MONITOR_SCRIPT"
chmod +x "$SUCCESS_MONITOR_SCRIPT"
write_plan "$SUCCESS_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-success" "$SUCCESS_MONITOR_ENV" "$SUCCESS_MONITOR_SCRIPT" "$SUCCESS_STATUS_LOG" "$SUCCESS_LAUNCHED" "[$TASK_ONE_JSON]"

SUCCESS_OUTPUT="$TMP_ROOT/success-output.txt"
bash "$RUNNER_SCRIPT" "$SUCCESS_PLAN" > "$SUCCESS_OUTPUT" 2>&1

if jq -e '.tasks["HOK-1001"].phase == "coding"' "$STATE_FILE" >/dev/null 2>&1; then
  pass "startup runner writes workflow state only after in-tmux startup succeeds"
else
  fail "startup runner did not persist workflow state for the launched task"
fi

if grep -q 'HOK-1001|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner updates Linear after a successful launch"
else
  fail "startup runner did not update Linear for the successful task"
fi

if [[ -f "$SUCCESS_MONITOR_ENV" ]] && grep -q '^TASKS_FILE=' "$SUCCESS_MONITOR_ENV"; then
  pass "startup runner writes the monitor env inside tmux startup"
else
  fail "startup runner did not write the monitor env"
fi

if grep -q "respawn-pane -k -t startup-success:control.0" "$MOCK_TMUX_LOG"; then
  pass "startup runner hands control-pane startup off to the monitor"
else
  fail "startup runner did not launch the monitor in the control pane"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"
: > "$MOCK_TMUX_LOG"
INTERACTIVE_PLAN="$TMP_ROOT/interactive-plan.json"
INTERACTIVE_MONITOR_ENV="$TMP_ROOT/interactive-monitor.env"
INTERACTIVE_MONITOR_SCRIPT="$TMP_ROOT/interactive-monitor.sh"
INTERACTIVE_STATUS_LOG="$TMP_ROOT/interactive-status.log"
INTERACTIVE_LAUNCHED="$TMP_ROOT/interactive-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$INTERACTIVE_MONITOR_SCRIPT"
chmod +x "$INTERACTIVE_MONITOR_SCRIPT"
write_plan "$INTERACTIVE_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-interactive" "$INTERACTIVE_MONITOR_ENV" "$INTERACTIVE_MONITOR_SCRIPT" "$INTERACTIVE_STATUS_LOG" "$INTERACTIVE_LAUNCHED" "[$TASK_ONE_JSON]"
jq '.planningMode = "interactive"' "$INTERACTIVE_PLAN" > "$INTERACTIVE_PLAN.tmp"
mv "$INTERACTIVE_PLAN.tmp" "$INTERACTIVE_PLAN"

INTERACTIVE_OUTPUT="$TMP_ROOT/interactive-output.txt"
bash "$RUNNER_SCRIPT" "$INTERACTIVE_PLAN" > "$INTERACTIVE_OUTPUT" 2>&1

INTERACTIVE_ROUTING_FILE="$TEST_REPO/worktrees/alpha-task/features/alpha-task/.routing-complete"
if jq -e '.maxCostUsd == 12.5' "$INTERACTIVE_ROUTING_FILE" >/dev/null 2>&1; then
  pass "startup runner preserves route.maxCostUsd in interactive .routing-complete"
else
  fail "startup runner did not persist route.maxCostUsd in interactive .routing-complete"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{"HOK-1999":{"slug":"resumed-task","branch":"task/resumed-task","phase":"executing"}}}\n' > "$STATE_FILE"
: > "$MOCK_TMUX_LOG"
EMPTY_PLAN="$TMP_ROOT/empty-plan.json"
EMPTY_MONITOR_ENV="$TMP_ROOT/empty-monitor.env"
EMPTY_MONITOR_SCRIPT="$TMP_ROOT/empty-monitor.sh"
EMPTY_STATUS_LOG="$TMP_ROOT/empty-status.log"
EMPTY_LAUNCHED="$TMP_ROOT/empty-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$EMPTY_MONITOR_SCRIPT"
chmod +x "$EMPTY_MONITOR_SCRIPT"
write_plan "$EMPTY_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-empty" "$EMPTY_MONITOR_ENV" "$EMPTY_MONITOR_SCRIPT" "$EMPTY_STATUS_LOG" "$EMPTY_LAUNCHED" "[]"

EMPTY_OUTPUT="$TMP_ROOT/empty-output.txt"
bash "$RUNNER_SCRIPT" "$EMPTY_PLAN" > "$EMPTY_OUTPUT" 2>&1

if [[ -f "$EMPTY_MONITOR_ENV" ]] && grep -q '^TASKS_FILE=' "$EMPTY_MONITOR_ENV"; then
  pass "startup runner writes the monitor env when there are no new tasks"
else
  fail "startup runner did not write the monitor env for resume-only startup"
fi

if grep -q 'No new tasks selected. Resuming 1 in-flight task(s) from previous session.' "$EMPTY_STATUS_LOG"; then
  pass "startup runner logs resume-only startup when launch plan is empty"
else
  fail "startup runner did not report resume-only startup"
fi

if grep -q "respawn-pane -k -t startup-empty:control.0" "$MOCK_TMUX_LOG"; then
  pass "startup runner still launches the monitor for resume-only startup"
else
  fail "startup runner did not launch the monitor for resume-only startup"
fi

printf '{"session":"startup-test","started":"2026-04-12T00:00:00Z","tasks":{}}\n' > "$STATE_FILE"
: > "$MOCK_LINEAR_LOG"
: > "$MOCK_TMUX_LOG"
FAIL_PLAN="$TMP_ROOT/failure-plan.json"
FAIL_MONITOR_ENV="$TMP_ROOT/failure-monitor.env"
FAIL_MONITOR_SCRIPT="$TMP_ROOT/failure-monitor.sh"
FAIL_STATUS_LOG="$TMP_ROOT/failure-status.log"
FAIL_LAUNCHED="$TMP_ROOT/failure-launched.txt"
printf '#!/usr/bin/env bash\nexit 0\n' > "$FAIL_MONITOR_SCRIPT"
chmod +x "$FAIL_MONITOR_SCRIPT"
write_plan "$FAIL_PLAN" "$TEST_REPO" "$STATE_DIR" "$STATE_FILE" "startup-failure" "$FAIL_MONITOR_ENV" "$FAIL_MONITOR_SCRIPT" "$FAIL_STATUS_LOG" "$FAIL_LAUNCHED" "[$TASK_ONE_JSON,$TASK_TWO_JSON]"

FAIL_OUTPUT="$TMP_ROOT/failure-output.txt"
export FAIL_WORKTREE_MATCH="broken-task"
bash "$RUNNER_SCRIPT" "$FAIL_PLAN" > "$FAIL_OUTPUT" 2>&1
unset FAIL_WORKTREE_MATCH

if jq -e '.tasks["HOK-1001"]' "$STATE_FILE" >/dev/null 2>&1 \
  && ! jq -e '.tasks["HOK-1002"]' "$STATE_FILE" >/dev/null 2>&1; then
  pass "startup runner isolates per-task startup failures without orphaned state"
else
  fail "startup runner left orphaned workflow state after a task startup failure"
fi

if grep -q 'HOK-1001|In Progress' "$MOCK_LINEAR_LOG" && ! grep -q 'HOK-1002|In Progress' "$MOCK_LINEAR_LOG"; then
  pass "startup runner only updates Linear for tasks that fully launched"
else
  fail "startup runner updated Linear for a failed task launch"
fi

if grep -q 'FAILED at step' "$FAIL_STATUS_LOG" && grep -q '── Task 2/2: HOK-1002' "$FAIL_STATUS_LOG"; then
  pass "startup failures stay visible in the tmux startup log output"
else
  fail "startup failure logging is missing from the control-pane output"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
