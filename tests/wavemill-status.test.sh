#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

strip_ansi() {
  perl -pe 's/\e\[[0-9;]*m//g'
}

run_render() {
  local state_file="$1"
  local workspace_root="$2"
  local behavior_file="$3"
  local output_file="$4"

  (
    set -- test-session "$workspace_root" "$state_file"
    source "$REPO_DIR/shared/lib/wavemill-status.sh"

    refresh_pr_cache() { :; }
    clear_dashboard_scrollback() { :; }
    redraw_dashboard_frame() { :; }

    elapsed() {
      local dir="$1"
      case "$(basename "$dir")" in
        plan-task) echo "12m" ;;
        waiting-task) echo "7m" ;;
        active-task) echo "3m" ;;
        stale-task) echo "9m" ;;
        *) echo "1m" ;;
      esac
    }

    is_active() {
      local worktree="$1"
      [[ "$(basename "$worktree")" != "stale-task" ]]
    }

    agent_status() {
      case "$1" in
        HOK-1220-plan-task) echo "exited" ;;
        HOK-1221-waiting-task) echo "waiting" ;;
        HOK-1222-active-task) echo "running" ;;
        *) echo "running" ;;
      esac
    }

    agent_hook_detail() {
      local issue="$1"
      jq -r --arg issue "$issue" '.hook[$issue] // empty' "$behavior_file"
    }

    agent_reported_status() {
      local issue="$1"
      jq -r --arg issue "$issue" '.reported[$issue] // empty' "$behavior_file"
    }

    get_planning_display_status() {
      local _worktree="$1" slug="$2"
      jq -r --arg slug "$slug" '.planning[$slug] // empty' "$behavior_file"
    }

    pr_for_branch() {
      local branch="$1"
      jq -r --arg branch "$branch" '.pr[$branch] // empty' "$behavior_file"
    }

    pr_checks() {
      local branch="$1"
      jq -r --arg branch "$branch" '.checks[$branch] // empty' "$behavior_file"
    }

    render_dashboard
    strip_ansi < "$FRAME" > "$output_file"
  )
}

echo "=== wavemill-status inbox renderer ==="

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

WORKTREES_DIR="$TMP_DIR/worktrees"
mkdir -p \
  "$WORKTREES_DIR/plan-task/features/plan-task" \
  "$WORKTREES_DIR/waiting-task/features/waiting-task" \
  "$WORKTREES_DIR/active-task/features/active-task" \
  "$WORKTREES_DIR/stale-task/features/stale-task"

STATE_FILE_ONE="$TMP_DIR/state-one.json"
cat > "$STATE_FILE_ONE" <<EOF
{
  "freeSlots": 2,
  "tasks": {
    "HOK-1220": {
      "slug": "plan-task",
      "branch": "task/plan-task",
      "worktree": "$WORKTREES_DIR/plan-task",
      "status": "",
      "phase": "planning",
      "pr": ""
    },
    "HOK-1221": {
      "slug": "waiting-task",
      "branch": "task/waiting-task",
      "worktree": "$WORKTREES_DIR/waiting-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    },
    "HOK-1222": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_ONE="$TMP_DIR/behavior-one.json"
cat > "$BEHAVIOR_ONE" <<'EOF'
{
  "hook": {
    "HOK-1221": "Waiting on tests"
  },
  "reported": {},
  "planning": {
    "plan-task": "awaiting_approval"
  },
  "pr": {
    "task/active-task": "45|OPEN"
  },
  "checks": {
    "task/active-task": "pass"
  }
}
EOF

OUTPUT_ONE="$TMP_DIR/output-one.txt"
run_render "$STATE_FILE_ONE" "$WORKTREES_DIR" "$BEHAVIOR_ONE" "$OUTPUT_ONE"

if grep -q '📥 INBOX (2)' "$OUTPUT_ONE" && grep -q '⚡ ACTIVE (1)' "$OUTPUT_ONE"; then
  pass "renders inbox and active sections with counts"
else
  fail "missing inbox or active section counts"
fi

if [[ $(grep -n '📥 INBOX' "$OUTPUT_ONE" | cut -d: -f1) -lt $(grep -n '⚡ ACTIVE' "$OUTPUT_ONE" | cut -d: -f1) ]]; then
  pass "renders inbox before active"
else
  fail "section order is incorrect"
fi

if grep -q 'HOK-1220.*plan-task.*⏳ awaiting.*○ exited' "$OUTPUT_ONE" \
  && grep -q 'Plan ready — waiting for approval' "$OUTPUT_ONE" \
  && grep -q 'HOK-1221.*waiting-task.*⏳ waiting' "$OUTPUT_ONE" \
  && grep -q 'Waiting on tests' "$OUTPUT_ONE"; then
  pass "shows actionable tasks and detail lines in inbox"
else
  fail "inbox rows are missing expected state details"
fi

if grep -q 'HOK-1222.*active-task.*🔨 executing.*● running.*#45 ✓' "$OUTPUT_ONE"; then
  pass "shows active task PR and running status"
else
  fail "active row is missing expected PR or status details"
fi

STATE_FILE_TWO="$TMP_DIR/state-two.json"
cat > "$STATE_FILE_TWO" <<EOF
{
  "tasks": {
    "HOK-1222": {
      "slug": "active-task",
      "branch": "task/active-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_TWO="$TMP_DIR/behavior-two.json"
cat > "$BEHAVIOR_TWO" <<'EOF'
{
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_TWO="$TMP_DIR/output-two.txt"
run_render "$STATE_FILE_TWO" "$WORKTREES_DIR" "$BEHAVIOR_TWO" "$OUTPUT_TWO"

if ! grep -q '📥 INBOX' "$OUTPUT_TWO" && grep -q '⚡ ACTIVE (1)' "$OUTPUT_TWO"; then
  pass "omits inbox section when no actionable tasks exist"
else
  fail "active-only dashboard still rendered an inbox section"
fi

STATE_FILE_THREE="$TMP_DIR/state-three.json"
cat > "$STATE_FILE_THREE" <<EOF
{
  "tasks": {
    "HOK-1999": {
      "slug": "stale-task",
      "branch": "task/stale-task",
      "worktree": "$WORKTREES_DIR/stale-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

OUTPUT_THREE="$TMP_DIR/output-three.txt"
run_render "$STATE_FILE_THREE" "$WORKTREES_DIR" "$BEHAVIOR_TWO" "$OUTPUT_THREE"

if grep -q '⚡ ACTIVE (0)' "$OUTPUT_THREE" && grep -q 'No active tasks' "$OUTPUT_THREE"; then
  pass "shows empty active section after filtering stale tasks"
else
  fail "empty active state after stale filtering is wrong"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
