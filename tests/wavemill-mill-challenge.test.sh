#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
FIXTURE="$REPO_DIR/tests/fixtures/challenge-task-packet.md"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

echo "=== Challenge Routing --file Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
  echo ""
  echo "--- Results: $PASS passed, $FAIL failed ---"
  exit 1
fi

STARTUP_BLOCK="$(awk '
  /challenge_args=\(--issue "\$ISSUE"/ { capture=1 }
  capture { print }
  /log_warn "  \$ISSUE: Planner challenge deferred until expanded route is available"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

RUNTIME_BLOCK="$(awk '
  /challenge_args=\(--issue "\$issue"/ { capture=1 }
  capture { print }
  /log_warn "  \$issue: Planner challenge deferred until expanded route is available"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

if [[ -n "$STARTUP_BLOCK" ]]; then
  check_contains "startup block includes feature-dir hook" "$STARTUP_BLOCK" 'challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}")'
  check_contains "startup block passes task packet file" "$STARTUP_BLOCK" 'challenge_args+=(--file "/tmp/${SESSION}-${ISSUE}-taskpacket.md")'
  check_contains "startup block resolves challenge task" "$STARTUP_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract startup challenge block"
fi

if [[ -n "$RUNTIME_BLOCK" ]]; then
  check_contains "runtime block still passes packet file" "$RUNTIME_BLOCK" 'challenge_args+=(--file "$packet_file")'
  check_contains "runtime block resolves challenge task" "$RUNTIME_BLOCK" 'resolve-challenge-task.ts'
else
  fail "could not extract runtime challenge block"
fi

if [[ -f "$FIXTURE" ]] && grep -q '^# Challenge Task Packet Fixture$' "$FIXTURE"; then
  pass "challenge task packet fixture exists"
else
  fail "challenge task packet fixture missing or malformed"
fi

echo ""
echo "=== Challenge Phase-Specific Agent Persistence Guards ==="

CHALLENGE_PERSISTENCE_BLOCK="$(awk '
  /if \[\[ "\$challenge_mode" == "challenge" \]\]; then/ { capture=1 }
  capture { print }
  /FINAL_LAUNCH_ARGS\+=\("\$challenger_key\|\$challenger_slug\|\$TITLE"\)/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$CHALLENGE_PERSISTENCE_BLOCK" ]]; then
  check_contains "startup challenge extracts primary planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'entries[0].plannerAgent'
  check_contains "startup challenge extracts challenger planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'entries[1].plannerAgent'
  check_contains "startup primary task agent starts as planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'TASK_AGENT_BY_ISSUE["$ISSUE"]="${primary_entry_planner_agent:-${primary_agent:-$rec_agent}}"'
  check_contains "startup challenger task agent starts as planner agent" "$CHALLENGE_PERSISTENCE_BLOCK" 'TASK_AGENT_BY_ISSUE["$challenger_key"]="${challenger_entry_planner_agent:-${challenger_agent:-$AGENT_CMD}}"'
else
  fail "could not extract startup challenge persistence block"
fi

RUNTIME_SAVE_BLOCK="$(awk '
  /# Save to state ledger/ { capture=1 }
  capture { print }
  /# Verify agent was saved correctly/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$RUNTIME_SAVE_BLOCK" ]]; then
  check_contains "runtime primary state saves planner agent for planning phase" "$RUNTIME_SAVE_BLOCK" '"${planner_agent:-$task_agent_cmd}"'
  check_contains "runtime challenger state saves planner agent for planning phase" "$RUNTIME_SAVE_BLOCK" '"${challenger_planner_agent:-$challenger_agent}"'
else
  fail "could not extract runtime state save block"
fi

CODING_HANDOFF_BLOCK="$(awk '
  /if ! coder_agent="\$\(agent_resolve_from_model "\$coder_launch_model" "coding"\)"; then/ { capture=1 }
  capture { print }
  /launch_coding_phase "\$ISSUE"/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$CODING_HANDOFF_BLOCK" ]]; then
  check_contains "coding handoff updates task agent to coder" "$CODING_HANDOFF_BLOCK" '.tasks[$issue].agent = $agent'
  check_contains "coding handoff writes resolved coder agent" "$CODING_HANDOFF_BLOCK" '--arg agent "$coder_agent"'
else
  fail "could not extract coding handoff block"
fi

echo ""
echo "=== Challenge Execution Intent Finalization Guards ==="

FINALIZATION_HELPER="$(awk '
  /^finalize_challenge_execution_intent_before_coding\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MILL_SCRIPT")"

CODING_FINALIZATION_BLOCK="$(awk '
  /FINALIZED_CHALLENGE_CODER=""/ { capture=1 }
  capture { print }
  /if \[\[ -n "\$FINALIZED_CHALLENGE_CODER" \]\]/ && capture { seen=1 }
  seen && /fi/ { exit }
' "$MILL_SCRIPT")"

if [[ -n "$FINALIZATION_HELPER" ]]; then
  check_contains "finalizer skips challenger side" "$FINALIZATION_HELPER" '[[ "$challenge_role_meta" != "challenger" ]] || return 0'
  check_contains "finalizer requires expanded artifact" "$FINALIZATION_HELPER" '[[ -f "$feature_dir/.post-expansion-route.json" ]] || return 0'
  check_contains "finalizer passes feature-dir to resolver" "$FINALIZATION_HELPER" '--feature-dir "$feature_dir"'
  check_contains "finalizer passes task packet when present" "$FINALIZATION_HELPER" 'packet_arg=(--file "$feature_dir/task-packet.md")'
  check_contains "finalizer requires expanded or preserved source" "$FINALIZATION_HELPER" 'refreshed_source" != "expanded" && "$refreshed_source" != "preserved"'
  check_contains "finalizer extracts challenge intent" "$FINALIZATION_HELPER" '.challengeExecutionIntent // empty'
  check_contains "finalizer persists no-challenge intent" "$FINALIZATION_HELPER" 'persist_challenge_execution_intent "$issue" "" "$feature_dir" "$intent_json"'
  check_contains "finalizer saves primary planner" "$FINALIZATION_HELPER" 'new_primary_planner'
  check_contains "finalizer saves challenger planner" "$FINALIZATION_HELPER" 'new_challenger_planner'
  check_contains "finalizer persists paired intent" "$FINALIZATION_HELPER" 'persist_challenge_execution_intent "$issue" "$new_challenger_key" "$feature_dir" "$intent_json"'
  check_contains "finalizer exposes in-memory coder" "$FINALIZATION_HELPER" 'FINALIZED_CHALLENGE_CODER="$new_primary"'
else
  fail "could not extract challenge execution finalizer"
fi

PLANNER_GATE_HELPER="$(awk '
  /^challenge_plan_stage_requires_effective_route\(\) \{/ { capture=1 }
  capture { print }
  /^}/ && capture { exit }
' "$MILL_SCRIPT")"

if [[ -n "$PLANNER_GATE_HELPER" ]]; then
  check_contains "planner challenge gate detects planning stage" "$PLANNER_GATE_HELPER" '[[ "$challenge_stage" == "planning" || "$challenge_stage" == "plan" || "$challenge_stage" == "planner" ]]'
  check_contains "planner challenge gate requires effective route source" "$PLANNER_GATE_HELPER" '[[ "$decision_source" != "expanded" && "$decision_source" != "preserved" ]]'
else
  fail "could not extract planner challenge route gate"
fi

check_contains "startup planner challenge defers without effective route" "$STARTUP_BLOCK" 'challenge_plan_stage_requires_effective_route "$challenge_plan"'
check_contains "startup planner challenge records defer reason" "$STARTUP_BLOCK" 'plan_stage_expanded_route_unavailable'
check_contains "runtime planner challenge defers without effective route" "$RUNTIME_BLOCK" 'challenge_plan_stage_requires_effective_route "$challenge_plan"'
check_contains "runtime planner challenge records defer reason" "$RUNTIME_BLOCK" 'plan_stage_expanded_route_unavailable'

if [[ -n "$CODING_FINALIZATION_BLOCK" ]]; then
  check_contains "coding handoff calls finalizer" "$CODING_FINALIZATION_BLOCK" 'finalize_challenge_execution_intent_before_coding "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$FEATURE_DIR" "$coder_model"'
  check_contains "coding handoff updates challenge coder from final intent" "$CODING_FINALIZATION_BLOCK" 'challenge_coder="$FINALIZED_CHALLENGE_CODER"'
else
  fail "could not extract coding finalization block"
fi

echo ""
echo "=== Challenge Expanded-Route Refresh State Persistence (functional) ==="

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

STATE_FILE="$TEST_TMP/state.json"

# Pre-refresh state: both sides show gpt-5.4 (the bug scenario)
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-9999": {
      "slug": "hok-9999",
      "branch": "task/hok-9999",
      "worktree": "/tmp/worktrees/hok-9999",
      "pr": "",
      "status": "active",
      "agent": "codex",
      "phase": "planning",
      "challenge": true,
      "challengePairId": "HOK-9999",
      "challengeRole": "primary",
      "challengeModel": "gpt-5.4",
      "coderModel": "gpt-5.4",
      "plannerModel": "gpt-5.4",
      "reviewerModel": "gpt-5.4",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static",
      "linearIssueId": "HOK-9999"
    },
    "HOK-9999_c": {
      "slug": "hok-9999-c",
      "branch": "task/hok-9999-c",
      "worktree": "/tmp/worktrees/hok-9999-c",
      "pr": "",
      "status": "active",
      "agent": "codex",
      "phase": "planning",
      "challenge": true,
      "challengePairId": "HOK-9999",
      "challengeRole": "challenger",
      "challengeModel": "gpt-5.4",
      "coderModel": "gpt-5.4",
      "plannerModel": "gpt-5.4",
      "reviewerModel": "gpt-5.4",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static",
      "linearIssueId": "HOK-9999"
    }
  }
}
JSON

REFRESHED_PLAN='{"decisionSource":"expanded","entries":[
  {"model":"gpt-5.4","planner":"gpt-5.5","reviewer":"gpt-5.5","planDepth":"deep","codeDepth":"deep","reviewMode":"static","key":"HOK-9999"},
  {"model":"claude-sonnet-4-6","planner":"claude-sonnet-4-6","reviewer":"claude-sonnet-4-6","planDepth":"deep","codeDepth":"deep","reviewMode":"static+llm","key":"HOK-9999_c"}
]}'

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"

  STATE_FILE="$1"
  REFRESHED_PLAN="$2"

  log() { :; }
  log_warn() { printf "WARN: %s\n" "$1" >&2; }

  save_task_state() {
    local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-active}" agent="${7:-}"
    local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
    local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
    local challenge_stage="${19:-}"

    state_mutate "$STATE_FILE" \
      "(.tasks[\$issue].agent // \"\") as \$old_agent |
       (.tasks[\$issue].phase // \"executing\") as \$old_phase |
       (.tasks[\$issue].evalCompleted // false) as \$old_eval |
       (.tasks[\$issue].evalFailed // false) as \$old_eval_failed |
       (.tasks[\$issue].challengeCompared // false) as \$old_challenge_compared |
       (.tasks[\$issue].challenge // false) as \$old_challenge |
       (.tasks[\$issue].challengePairId // \"\") as \$old_challenge_pair |
       (.tasks[\$issue].challengeRole // \"\") as \$old_challenge_role |
       (.tasks[\$issue].challengeModel // \"\") as \$old_challenge_model |
       (.tasks[\$issue].challengeStage // \"\") as \$old_challenge_stage |
       (.tasks[\$issue].evalRunning // null) as \$old_eval_running |
       (.tasks[\$issue].comparisonRunning // null) as \$old_comparison_running |
       (.tasks[\$issue].linearIssueId // \$issue) as \$old_linear_issue |
       (.tasks[\$issue].coderModel // \"\") as \$old_coderModel |
       (.tasks[\$issue].plannerModel // \"\") as \$old_plannerModel |
       (.tasks[\$issue].reviewerModel // \"\") as \$old_reviewerModel |
       (.tasks[\$issue].planDepth // \"\") as \$old_planDepth |
       (.tasks[\$issue].codeDepth // \"\") as \$old_codeDepth |
       (.tasks[\$issue].reviewMode // \"\") as \$old_reviewMode |
       .tasks[\$issue] = {
         slug: \$slug, branch: \$branch, worktree: \$worktree, pr: \$pr, status: \$status,
         linearIssueId: (if \$linearIssue != \"\" then \$linearIssue else \$old_linear_issue end),
         agent: (if \$agent != \"\" then \$agent else \$old_agent end),
         challenge: (if \$challenge != \"\" then (\$challenge == \"true\") else \$old_challenge end),
         challengePairId: (if \$challengePair != \"\" then \$challengePair else \$old_challenge_pair end),
         challengeRole: (if \$challengeRole != \"\" then \$challengeRole else \$old_challenge_role end),
         challengeModel: (if \$challengeModel != \"\" then \$challengeModel else \$old_challenge_model end),
         challengeStage: (if \$challengeStage != \"\" then \$challengeStage else \$old_challenge_stage end),
         coderModel: (if \$coderModel != \"\" then \$coderModel else \$old_coderModel end),
         plannerModel: (if \$plannerModel != \"\" then \$plannerModel else \$old_plannerModel end),
         reviewerModel: (if \$reviewerModel != \"\" then \$reviewerModel else \$old_reviewerModel end),
         planDepth: (if \$planDepth != \"\" then \$planDepth else \$old_planDepth end),
         codeDepth: (if \$codeDepth != \"\" then \$codeDepth else \$old_codeDepth end),
         reviewMode: (if \$reviewMode != \"\" then \$reviewMode else \$old_reviewMode end),
         phase: \$old_phase, evalCompleted: \$old_eval, evalFailed: \$old_eval_failed,
         challengeCompared: \$old_challenge_compared, evalRunning: \$old_eval_running,
         comparisonRunning: \$old_comparison_running, updated: (now | todate)
       }" \
      --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
      --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
      --arg agent "$agent" --arg linearIssue "$linear_issue" --arg challenge "$challenge" \
      --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
      --arg challengeModel "$challenge_model" \
      --arg challengeStage "$challenge_stage" \
      --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
      --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode"
  }

  # Simulate the fixed expanded refresh extraction + persistence
  new_primary=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].model // empty" 2>/dev/null)
  new_primary_planner=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].planner // empty" 2>/dev/null)
  new_primary_reviewer=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].reviewer // empty" 2>/dev/null)
  new_primary_plan_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].planDepth // empty" 2>/dev/null)
  new_primary_code_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].codeDepth // empty" 2>/dev/null)
  new_primary_review_mode=$(echo "$REFRESHED_PLAN" | jq -r ".entries[0].reviewMode // empty" 2>/dev/null)
  new_challenge_stage=$(echo "$REFRESHED_PLAN" | jq -r ".challengeStage // \"implementation\"" 2>/dev/null || echo "implementation")
  new_challenger_key=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].key // empty" 2>/dev/null)
  new_challenger_model=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].model // empty" 2>/dev/null)
  new_challenger_planner=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planner // empty" 2>/dev/null)
  new_challenger_reviewer=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewer // empty" 2>/dev/null)
  new_challenger_plan_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planDepth // empty" 2>/dev/null)
  new_challenger_code_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].codeDepth // empty" 2>/dev/null)
  new_challenger_review_mode=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewMode // empty" 2>/dev/null)

  if [[ -n "$new_primary" ]]; then
    save_task_state "HOK-9999" "hok-9999" "task/hok-9999" "/tmp/worktrees/hok-9999" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "primary" "$new_primary" "$new_primary_planner" "$new_primary" "$new_primary_reviewer" "$new_primary_plan_depth" "$new_primary_code_depth" "$new_primary_review_mode" "$new_challenge_stage"
  fi

  challenger_slug=$(jq -r ".tasks[\"$new_challenger_key\"].slug // empty" "$STATE_FILE")
  challenger_branch=$(jq -r ".tasks[\"$new_challenger_key\"].branch // empty" "$STATE_FILE")
  challenger_worktree=$(jq -r ".tasks[\"$new_challenger_key\"].worktree // empty" "$STATE_FILE")
  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]] && [[ -n "$challenger_slug" ]] && [[ -n "$challenger_branch" ]] && [[ -n "$challenger_worktree" ]]; then
    save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "challenger" "$new_challenger_model" "$new_challenger_planner" "$new_challenger_model" "$new_challenger_reviewer" "$new_challenger_plan_depth" "$new_challenger_code_depth" "$new_challenger_review_mode" "$new_challenge_stage"
  fi
' bash "$STATE_FILE" "$REFRESHED_PLAN" "$REPO_DIR"

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$label"
  fi
}

primary_challenge_model=$(jq -r '.tasks["HOK-9999"].challengeModel // empty' "$STATE_FILE")
primary_coder_model=$(jq -r '.tasks["HOK-9999"].coderModel // empty' "$STATE_FILE")
primary_planner_model=$(jq -r '.tasks["HOK-9999"].plannerModel // empty' "$STATE_FILE")
primary_reviewer_model=$(jq -r '.tasks["HOK-9999"].reviewerModel // empty' "$STATE_FILE")
primary_plan_depth=$(jq -r '.tasks["HOK-9999"].planDepth // empty' "$STATE_FILE")
primary_code_depth=$(jq -r '.tasks["HOK-9999"].codeDepth // empty' "$STATE_FILE")
primary_review_mode=$(jq -r '.tasks["HOK-9999"].reviewMode // empty' "$STATE_FILE")
primary_challenge_stage=$(jq -r '.tasks["HOK-9999"].challengeStage // empty' "$STATE_FILE")

challenger_challenge_model=$(jq -r '.tasks["HOK-9999_c"].challengeModel // empty' "$STATE_FILE")
challenger_coder_model=$(jq -r '.tasks["HOK-9999_c"].coderModel // empty' "$STATE_FILE")
challenger_planner_model=$(jq -r '.tasks["HOK-9999_c"].plannerModel // empty' "$STATE_FILE")
challenger_reviewer_model=$(jq -r '.tasks["HOK-9999_c"].reviewerModel // empty' "$STATE_FILE")
challenger_plan_depth=$(jq -r '.tasks["HOK-9999_c"].planDepth // empty' "$STATE_FILE")
challenger_code_depth=$(jq -r '.tasks["HOK-9999_c"].codeDepth // empty' "$STATE_FILE")
challenger_review_mode=$(jq -r '.tasks["HOK-9999_c"].reviewMode // empty' "$STATE_FILE")
challenger_challenge_stage=$(jq -r '.tasks["HOK-9999_c"].challengeStage // empty' "$STATE_FILE")

check_eq "primary challengeModel set to refreshed primary model" "gpt-5.4" "$primary_challenge_model"
check_eq "primary coderModel aligned with refreshed primary model" "gpt-5.4" "$primary_coder_model"
check_eq "primary plannerModel set from refreshed entry" "gpt-5.5" "$primary_planner_model"
check_eq "primary reviewerModel set from refreshed entry" "gpt-5.5" "$primary_reviewer_model"
check_eq "primary planDepth set from refreshed entry" "deep" "$primary_plan_depth"
check_eq "primary codeDepth set from refreshed entry" "deep" "$primary_code_depth"
check_eq "primary reviewMode set from refreshed entry" "static" "$primary_review_mode"
check_eq "primary challengeStage repaired during refresh" "implementation" "$primary_challenge_stage"

check_eq "challenger challengeModel set to refreshed challenger model" "claude-sonnet-4-6" "$challenger_challenge_model"
check_eq "challenger coderModel aligned with refreshed challenger model" "claude-sonnet-4-6" "$challenger_coder_model"
check_eq "challenger plannerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_planner_model"
check_eq "challenger reviewerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_reviewer_model"
check_eq "challenger planDepth set from refreshed entry" "deep" "$challenger_plan_depth"
check_eq "challenger codeDepth set from refreshed entry" "deep" "$challenger_code_depth"
check_eq "challenger reviewMode set from refreshed entry" "static+llm" "$challenger_review_mode"
check_eq "challenger challengeStage repaired during refresh" "implementation" "$challenger_challenge_stage"

# Guard: challenger model must differ from primary (cannot be gpt-5.4 vs gpt-5.4)
if [[ "$primary_challenge_model" != "$challenger_challenge_model" ]]; then
  pass "expanded refresh does not collapse to same-model comparison"
else
  echo "    primary: $primary_challenge_model  challenger: $challenger_challenge_model (should differ)"
  fail "expanded refresh collapsed to same-model comparison"
fi

# Defensive: missing entries[1].model must not clobber challenger state
STATE_FILE_GUARD="$TEST_TMP/state-guard.json"
cp "$STATE_FILE" "$STATE_FILE_GUARD"

MISSING_MODEL_PLAN='{"decisionSource":"expanded","entries":[
  {"model":"gpt-5.4","planner":"gpt-5.5","reviewer":"gpt-5.5","planDepth":"deep","codeDepth":"deep","reviewMode":"static","key":"HOK-9999"},
  {"planner":"claude-sonnet-4-6","key":"HOK-9999_c"}
]}'

bash -lc '
  set -euo pipefail
  source "$3/shared/lib/wavemill-common.sh"
  STATE_FILE="$1"
  PLAN="$2"
  log() { :; }
  log_warn() { :; }
  save_task_state() { :; }

  new_challenger_key=$(echo "$PLAN" | jq -r ".entries[1].key // empty" 2>/dev/null)
  new_challenger_model=$(echo "$PLAN" | jq -r ".entries[1].model // empty" 2>/dev/null)
  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]]; then
    echo "SHOULD_NOT_SAVE"
  else
    echo "GUARD_OK"
  fi
' bash "$STATE_FILE_GUARD" "$MISSING_MODEL_PLAN" "$REPO_DIR" | grep -q "GUARD_OK" \
  && pass "missing entries[1].model does not trigger challenger save" \
  || fail "missing entries[1].model incorrectly triggered challenger save"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
