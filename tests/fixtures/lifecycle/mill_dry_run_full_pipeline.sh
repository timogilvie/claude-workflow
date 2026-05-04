#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/tend-fixture-lib.sh"

require_tend_runtime

# Test: wavemill mill --dry-run exercises the full startup pipeline construction
# without actually launching agents, creating tmux sessions, or touching Linear/GitHub.
#
# Validates:
# - Route payload jq filter compiles and produces valid JSON
# - Launch plan structure is complete (all required fields)
# - Startup runner validates the plan without requiring tmux
# - No network calls to Linear, GitHub, or LLM APIs

create_tend_fixture_root "mill-dry-run"
trap cleanup_tend_fixture_root EXIT

# Initialize minimal git-like fixture repo
cd "$REPO_DIR"
git init >/dev/null 2>&1 || true

# Create minimal .wavemill-config.json
cat > "$REPO_DIR/.wavemill-config.json" <<EOF
{
  "mill": {
    "baseBranch": "main",
    "worktreeRoot": "$TMP_DIR/worktrees",
    "maxParallel": 2
  },
  "router": {
    "enabled": true
  },
  "linear": {
    "teamKey": "TEST",
    "projectIds": ["test-project-id"]
  }
}
EOF

# Create minimal project context to bypass init prompts
mkdir -p "$REPO_DIR/.wavemill"
cat > "$REPO_DIR/.wavemill/project-context.md" <<'EOF'
# Project Context

Test fixture repository for dry-run validation.
EOF

# Synthetic backlog with two tasks (must match Linear API schema)
BACKLOG_FILE="$TMP_DIR/backlog.json"
cat > "$BACKLOG_FILE" <<'EOF'
[
  {
    "identifier": "TEST-1",
    "title": "Implement feature A",
    "description": "Add a new feature",
    "state": {
      "name": "Backlog"
    },
    "priority": 1,
    "estimate": 3,
    "labels": {
      "nodes": []
    },
    "relations": {
      "nodes": []
    },
    "inverseRelations": {
      "nodes": []
    }
  },
  {
    "identifier": "TEST-2",
    "title": "Fix bug B",
    "description": "Fix a critical bug",
    "state": {
      "name": "Todo"
    },
    "priority": 2,
    "estimate": 2,
    "labels": {
      "nodes": []
    },
    "relations": {
      "nodes": []
    },
    "inverseRelations": {
      "nodes": []
    }
  }
]
EOF

# Fake gh command
GH_CALL_LOG="$TMP_DIR/gh-calls.log"
cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GH_CALL_LOG"
case "${1:-} ${2:-}" in
  "repo view")
    printf '{"nameWithOwner":"test/repo"}\n'
    ;;
  *)
    echo "unexpected gh args in dry-run: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_BIN/gh"
export GH_CALL_LOG

# Fake git command (minimal implementation for rev-parse checks)
GIT_CALL_LOG="$TMP_DIR/git-calls.log"
cat > "$FAKE_BIN/git" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$GIT_CALL_LOG"

# Handle worktree detection (make this look like main repo, not a worktree)
if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--git-dir" ]]; then
  printf '%s\n' ".git"
  exit 0
fi

if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--git-common-dir" ]]; then
  printf '%s\n' ".git"
  exit 0
fi

# Other common git operations for dry-run
if [[ "${1:-}" == "rev-parse" && "${2:-}" == "--show-toplevel" ]]; then
  pwd
  exit 0
fi

if [[ "${1:-}" == "config" ]]; then
  printf 'test@example.com\n'
  exit 0
fi

if [[ "${1:-}" == "fetch" ]]; then
  exit 0
fi

# Dry-run should not call most other git operations
exit 0
EOF
chmod +x "$FAKE_BIN/git"
export GIT_CALL_LOG

# Fake tmux (should not be invoked in dry-run)
TMUX_CALL_LOG="$TMP_DIR/tmux-calls.log"
cat > "$FAKE_BIN/tmux" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$TMUX_CALL_LOG"

# Allow version check
if [[ "${1:-}" == "-V" ]]; then
  printf 'tmux 3.3\n'
  exit 0
fi

# Any other tmux call in dry-run is unexpected
echo "ERROR: tmux should not be called in dry-run mode: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/tmux"
export TMUX_CALL_LOG

# Fake npx that stubs routing tools but delegates everything else to real tsx
real_npx="$(command -v npx)"
real_tsx="$(command -v tsx)"

cat > "$FAKE_BIN/npx" <<EOF
#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" == "tsx" ]]; then
  shift
  tool="\${1:-}"

  # Stub routing and challenge tools with deterministic responses
  case "\$tool" in
    */route-task.ts|*/route-tasks.ts)
      # Return deterministic single-model routing
      cat <<'ROUTE_EOF'
{
  "planner": "claude-sonnet-4-6",
  "coder": "claude-sonnet-4-6",
  "reviewer": "claude-sonnet-4-6",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewRecommended": "static"
}
ROUTE_EOF
      exit 0
      ;;
    */plan-queue.ts|*/select-wave.ts)
      # Return the input tasks as-is for queue planning
      cat
      exit 0
      ;;
    */resolve-challenge-task.ts)
      # Return no challenge for simplicity
      printf '{"mode":"single"}\n'
      exit 0
      ;;
    */list-backlog-json.ts)
      # Should not be called in dry-run (backlog fixture is used instead)
      echo "ERROR: list-backlog-json.ts should not be called in dry-run" >&2
      exit 1
      ;;
    */get-issue.ts)
      # Should not be called in dry-run (backlog cache is used instead)
      echo "ERROR: get-issue.ts should not be called in dry-run" >&2
      exit 1
      ;;
    *)
      # Delegate to real tsx for everything else
      export PATH="$FAKE_BIN:\$PATH"
      exec "$real_tsx" "\$@"
      ;;
  esac
fi

# For non-tsx npx calls, delegate to real npx
exec "$real_npx" "\$@"
EOF
chmod +x "$FAKE_BIN/npx"

# Set up environment for dry-run
SESSION="test-dry-run-$$"
PLAN_FILE="$TMP_DIR/launch-plan.json"
export SESSION
export WAVEMILL_DRY_RUN_BACKLOG_FILE="$BACKLOG_FILE"
export WAVEMILL_DRY_RUN_OUT_PATH="$PLAN_FILE"
export REPO_DIR
export STATE_DIR="$REPO_DIR/.wavemill"
export TOOLS_DIR="$REPO_ROOT/tools"
export LIB_DIR="$REPO_ROOT/shared/lib"
export PATH="$FAKE_BIN:$PATH"
export SKIP_CONFIG_CHECK=true
export SKIP_CONTEXT_CHECK=true
# Unset nested mill guard so fixture can run cleanly
unset WAVEMILL_MILL_ACTIVE

# Run wavemill mill --dry-run (pipe empty line to auto-select recommended wave)
STDERR_FILE="$TMP_DIR/stderr.log"
STDOUT_FILE="$TMP_DIR/stdout.log"
EXIT_CODE=0
echo "" | "$REPO_ROOT/wavemill" mill --dry-run > "$STDOUT_FILE" 2> "$STDERR_FILE" || EXIT_CODE=$?

# Assertions
if [[ "$EXIT_CODE" -ne 0 ]]; then
  echo "FAIL: wavemill mill --dry-run exited with code $EXIT_CODE"
  echo "=== STDOUT ==="
  cat "$STDOUT_FILE"
  echo "=== STDERR ==="
  cat "$STDERR_FILE"
  exit 1
fi

# Plan file must exist
if [[ ! -f "$PLAN_FILE" ]]; then
  echo "FAIL: Launch plan file not created at $PLAN_FILE"
  exit 1
fi

# Plan must be valid JSON
if ! jq -e . "$PLAN_FILE" >/dev/null 2>&1; then
  echo "FAIL: Launch plan is not valid JSON"
  cat "$PLAN_FILE"
  exit 1
fi

# Plan must have dry-run flag set
if ! jq -e '.monitorConfig.dryRun == true' "$PLAN_FILE" >/dev/null 2>&1; then
  echo "FAIL: Launch plan does not have dryRun=true"
  jq '.monitorConfig' "$PLAN_FILE"
  exit 1
fi

# Plan must have at least one task (from our 2-task backlog)
TASK_COUNT=$(jq '.tasks | length' "$PLAN_FILE")
if [[ "$TASK_COUNT" -lt 1 ]]; then
  echo "FAIL: Launch plan has no tasks (expected at least 1)"
  jq '.tasks' "$PLAN_FILE"
  exit 1
fi

# Validate task structure
TASK_0=$(jq '.tasks[0]' "$PLAN_FILE")
for field in issue slug title branch worktreeDir linearIssueId taskPacketFile issueJsonFile routeFile route agent; do
  if ! printf '%s' "$TASK_0" | jq -e ".$field" >/dev/null 2>&1; then
    echo "FAIL: Task 0 missing required field: $field"
    printf '%s\n' "$TASK_0"
    exit 1
  fi
done

# Validate route object structure
ROUTE_0=$(printf '%s' "$TASK_0" | jq '.route')
for field in planner coder reviewer planDepth codeDepth reviewMode; do
  if ! printf '%s' "$ROUTE_0" | jq -e ".$field" >/dev/null 2>&1; then
    echo "FAIL: Task 0 route missing required field: $field"
    printf '%s\n' "$ROUTE_0"
    exit 1
  fi
done

# Stderr must not contain jq errors or common shell errors
if grep -q "jq:" "$STDERR_FILE"; then
  echo "FAIL: stderr contains jq errors"
  grep "jq:" "$STDERR_FILE"
  exit 1
fi

if grep -qE "unbound variable|command not found" "$STDERR_FILE"; then
  echo "FAIL: stderr contains shell errors"
  grep -E "unbound variable|command not found" "$STDERR_FILE"
  exit 1
fi

# Tmux should not be called (dry-run skips tmux entirely)
if [[ -s "$TMUX_CALL_LOG" ]]; then
  # Allow tmux -V for version check
  if ! grep -q "^-V$" "$TMUX_CALL_LOG" || [[ $(wc -l < "$TMUX_CALL_LOG") -gt 1 ]]; then
    echo "FAIL: tmux was called unexpectedly in dry-run mode"
    cat "$TMUX_CALL_LOG"
    exit 1
  fi
fi

# Validate no network-bound tool calls leaked through
if [[ -s "$GH_CALL_LOG" ]]; then
  # Only repo view is allowed for repository detection
  if ! grep -qE "^repo view" "$GH_CALL_LOG"; then
    echo "FAIL: gh was called unexpectedly"
    cat "$GH_CALL_LOG"
    exit 1
  fi
fi

# Success
echo "PASS: mill_dry_run_full_pipeline"
echo "  ✓ Launch plan created at $PLAN_FILE"
echo "  ✓ Plan structure validated by startup runner"
echo "  ✓ $TASK_COUNT task(s) in plan with complete route metadata"
echo "  ✓ No jq compilation errors"
echo "  ✓ No network calls to Linear or GitHub API"
echo "  ✓ No tmux session created"
exit 0
