#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

strip_ansi() {
  perl -pe 's/\e\[[0-9;]*[A-Za-z]//g'
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

    window_index() {
      local win="$1"
      jq -r --arg win "$win" '.pane[$win] // "—"' "$behavior_file"
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
    cp "$FRAME" "${output_file}.raw"
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
  "$WORKTREES_DIR/coding-task/features/coding-task" \
  "$WORKTREES_DIR/review-task/features/review-task" \
  "$WORKTREES_DIR/ready-task/features/ready-task" \
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
  "pane": {
    "HOK-1220-plan-task": "3",
    "HOK-1221-waiting-task": "7",
    "HOK-1222-active-task": "12"
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

if grep -q $'\033\\[K' "${OUTPUT_ONE}.raw"; then
  pass "includes end-of-line clearing in raw dashboard frame"
else
  fail "raw dashboard frame is missing end-of-line clearing"
fi

if grep -q '📥 INBOX (2)' "$OUTPUT_ONE" && grep -q '⚡ ACTIVE (1)' "$OUTPUT_ONE"; then
  pass "renders inbox and active sections with counts"
else
  fail "missing inbox or active section counts"
fi

if grep -q 'ISSUE       PANE  TASK' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1220 +3 +plan-task' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1221 +7 +waiting-task' "$OUTPUT_ONE" \
  && grep -Eq 'HOK-1222 +12 +active-task' "$OUTPUT_ONE"; then
  pass "renders pane column and per-task tmux window indices"
else
  fail "pane column or window indices are missing"
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

STATE_FILE_SKIPPED="$TMP_DIR/state-skipped.json"
cat > "$STATE_FILE_SKIPPED" <<EOF
{
  "tasks": {
    "HOK-1224": {
      "slug": "skipped-check-task",
      "branch": "task/skipped-check-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": "tracked"
    }
  }
}
EOF

BEHAVIOR_SKIPPED="$TMP_DIR/behavior-skipped.json"
cat > "$BEHAVIOR_SKIPPED" <<'EOF'
{
  "pane": {
    "HOK-1224-skipped-check-task": "14"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {
    "task/skipped-check-task": "348|OPEN"
  },
  "checks": {
    "task/skipped-check-task": "pass"
  }
}
EOF

OUTPUT_SKIPPED="$TMP_DIR/output-skipped.txt"
run_render "$STATE_FILE_SKIPPED" "$WORKTREES_DIR" "$BEHAVIOR_SKIPPED" "$OUTPUT_SKIPPED"

if grep -q 'HOK-1224.*skipped-check-task.*🔨 executing.*● running.*#348 ✓' "$OUTPUT_SKIPPED"; then
  pass "treats skipped or neutral PR checks as passing in dashboard output"
else
  fail "dashboard did not render skipped-check PR as passing"
fi

if grep -q 'Ctrl+B <PANE>: switch task' "$OUTPUT_ONE"; then
  pass "footer advertises pane-number switching"
else
  fail "footer is missing pane-number switching hint"
fi

# Test truncation of long detail strings
STATE_FILE_LONG="$TMP_DIR/state-long.json"
cat > "$STATE_FILE_LONG" <<EOF
{
  "tasks": {
    "HOK-1223": {
      "slug": "long-detail-task",
      "branch": "task/long-detail-task",
      "worktree": "$WORKTREES_DIR/active-task",
      "status": "",
      "phase": "executing",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_LONG="$TMP_DIR/behavior-long.json"
cat > "$BEHAVIOR_LONG" <<'EOF'
{
  "pane": {
    "HOK-1223-long-detail-task": "8"
  },
  "hook": {
    "HOK-1223": "This is a very long detail string that should be truncated to prevent overflow beyond the terminal width and causing text bleeding into adjacent cells"
  },
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_LONG="$TMP_DIR/output-long.txt"
run_render "$STATE_FILE_LONG" "$WORKTREES_DIR" "$BEHAVIOR_LONG" "$OUTPUT_LONG"

# Check that truncated detail string is present and doesn't exceed reasonable length
if grep -q '└─.*\.\.\.' "$OUTPUT_LONG"; then
  # Find the detail line and check its length
  detail_line=$(grep '└─' "$OUTPUT_LONG" | head -1)
  line_len=${#detail_line}
  if (( line_len <= 85 )); then
    pass "truncates very long detail strings to prevent overflow"
  else
    fail "truncated detail line is still too long ($line_len chars)"
  fi
else
  fail "very long detail string was not truncated"
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
  "pane": {
    "HOK-1222-active-task": "12"
  },
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

STATE_FILE_PHASES="$TMP_DIR/state-phases.json"
cat > "$STATE_FILE_PHASES" <<EOF
{
  "tasks": {
    "HOK-1300": {
      "slug": "coding-task",
      "branch": "task/coding-task",
      "worktree": "$WORKTREES_DIR/coding-task",
      "status": "",
      "phase": "coding",
      "pr": ""
    },
    "HOK-1301": {
      "slug": "review-task",
      "branch": "task/review-task",
      "worktree": "$WORKTREES_DIR/review-task",
      "status": "",
      "phase": "review",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_PHASES="$TMP_DIR/behavior-phases.json"
cat > "$BEHAVIOR_PHASES" <<'EOF'
{
  "pane": {
    "HOK-1300-coding-task": "4",
    "HOK-1301-review-task": "5"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_PHASES="$TMP_DIR/output-phases.txt"
run_render "$STATE_FILE_PHASES" "$WORKTREES_DIR" "$BEHAVIOR_PHASES" "$OUTPUT_PHASES"

if grep -q 'HOK-1300.*coding-task.*💻 coding.*● running' "$OUTPUT_PHASES"; then
  pass "shows coding phase with emoji"
else
  fail "coding phase row is missing emoji"
fi

if grep -q 'HOK-1301.*review-task.*🔍 review.*● running' "$OUTPUT_PHASES"; then
  pass "shows review phase with emoji"
else
  fail "review phase row is missing emoji"
fi

STATE_FILE_READY="$TMP_DIR/state-ready.json"
cat > "$STATE_FILE_READY" <<EOF
{
  "tasks": {
    "HOK-1302": {
      "slug": "ready-task",
      "branch": "task/ready-task",
      "worktree": "$WORKTREES_DIR/ready-task",
      "status": "",
      "phase": "ready",
      "pr": ""
    }
  }
}
EOF

BEHAVIOR_READY="$TMP_DIR/behavior-ready.json"
cat > "$BEHAVIOR_READY" <<'EOF'
{
  "pane": {
    "HOK-1302-ready-task": "6"
  },
  "hook": {},
  "reported": {},
  "planning": {},
  "pr": {},
  "checks": {}
}
EOF

OUTPUT_READY="$TMP_DIR/output-ready.txt"
run_render "$STATE_FILE_READY" "$WORKTREES_DIR" "$BEHAVIOR_READY" "$OUTPUT_READY"

if grep -q 'HOK-1302.*ready-task.*🚦 ready.*● running' "$OUTPUT_READY"; then
  pass "shows ready phase with emoji"
else
  fail "ready phase row is missing emoji"
fi

echo ""
echo "=== wavemill-status pr_checks rollup handling ==="

run_pr_checks() {
  local cache="$1"
  local branch="$2"
  (
    SESSION_NAME="pr-checks-$RANDOM"
    cache_path="/tmp/${SESSION_NAME}-pr-cache.json"
    cp "$cache" "$cache_path"
    set -- "$SESSION_NAME" "$TMP_DIR" ""
    # Preserve stdout on fd 3; silence everything else so tput cursor codes
    # (civis/cnorm) emitted by the sourced script don't pollute captured output.
    exec 3>&1
    exec >/dev/null 2>&1
    source "$REPO_DIR/shared/lib/wavemill-status.sh"
    trap - EXIT
    pr_checks "$branch" >&3
    rm -f "$cache_path"
  )
}

assert_pr_check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$label (got '$actual')"
  else
    fail "$label (expected '$expected', got '$actual')"
  fi
}

ROLLUP_FIXTURE="$TMP_DIR/rollup.json"
cat > "$ROLLUP_FIXTURE" <<'EOF'
[
  {
    "headRefName": "task/status-context-success",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"SUCCESS","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/status-context-pending",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"PENDING","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/status-context-failure",
    "statusCheckRollup": [
      {"__typename":"StatusContext","context":"Vercel","state":"FAILURE","conclusion":null},
      {"__typename":"CheckRun","name":"build","state":null,"conclusion":"SUCCESS"}
    ]
  },
  {
    "headRefName": "task/check-run-skipped",
    "statusCheckRollup": [
      {"__typename":"CheckRun","name":"optional","conclusion":"SKIPPED"}
    ]
  },
  {
    "headRefName": "task/check-run-timed-out",
    "statusCheckRollup": [
      {"__typename":"CheckRun","name":"build","conclusion":"TIMED_OUT"}
    ]
  },
  {
    "headRefName": "task/empty-rollup",
    "statusCheckRollup": []
  }
]
EOF

assert_pr_check "StatusContext SUCCESS + CheckRun SUCCESS -> pass" \
  "pass" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-success")"
assert_pr_check "StatusContext PENDING -> pending" \
  "pending" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-pending")"
assert_pr_check "StatusContext FAILURE -> fail" \
  "fail" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/status-context-failure")"
assert_pr_check "CheckRun SKIPPED -> pass" \
  "pass" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/check-run-skipped")"
assert_pr_check "CheckRun TIMED_OUT -> fail" \
  "fail" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/check-run-timed-out")"
assert_pr_check "Empty rollup -> none" \
  "none" "$(run_pr_checks "$ROLLUP_FIXTURE" "task/empty-rollup")"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
