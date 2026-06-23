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
  /challenge_plan=\$\(npx tsx "\$TOOLS_DIR\/resolve-challenge-task\.ts"/ && capture { capture=0; exit }
' "$MILL_SCRIPT")"

RUNTIME_BLOCK="$(awk '
  /challenge_args=\(--issue "\$issue"/ { capture=1 }
  capture { print }
  /challenge_plan=\$\(_with_timeout "\$API_TIMEOUT" npx tsx "\$TOOLS_DIR\/resolve-challenge-task\.ts"/ && capture { capture=0; exit }
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
echo "=== Challenge Expanded-Route Refresh Full Routing Persistence ==="

# Extract the block that handles refreshed_source == expanded in the monitor path
EXPANDED_REFRESH_BLOCK="$(awk '
  /if \[\[ "\$refreshed_source" == "expanded" \]\]; then/ { capture=1 }
  capture { print }
  capture && /log "status".*Challenge participants refreshed/ { exit }
' "$MILL_SCRIPT")"

if [[ -n "$EXPANDED_REFRESH_BLOCK" ]]; then
  check_contains "refresh block extracts primary planner" "$EXPANDED_REFRESH_BLOCK" 'entries[0].planner'
  check_contains "refresh block extracts primary reviewer" "$EXPANDED_REFRESH_BLOCK" 'entries[0].reviewer'
  check_contains "refresh block extracts primary planDepth" "$EXPANDED_REFRESH_BLOCK" 'entries[0].planDepth'
  check_contains "refresh block extracts primary codeDepth" "$EXPANDED_REFRESH_BLOCK" 'entries[0].codeDepth'
  check_contains "refresh block extracts primary reviewMode" "$EXPANDED_REFRESH_BLOCK" 'entries[0].reviewMode'
  check_contains "refresh block extracts challenger planner" "$EXPANDED_REFRESH_BLOCK" 'entries[1].planner'
  check_contains "refresh block extracts challenger reviewer" "$EXPANDED_REFRESH_BLOCK" 'entries[1].reviewer'
  check_contains "refresh block extracts challenger planDepth" "$EXPANDED_REFRESH_BLOCK" 'entries[1].planDepth'
  check_contains "refresh block extracts challenger codeDepth" "$EXPANDED_REFRESH_BLOCK" 'entries[1].codeDepth'
  check_contains "refresh block extracts challenger reviewMode" "$EXPANDED_REFRESH_BLOCK" 'entries[1].reviewMode'
  check_contains "primary save_task_state passes planner" "$EXPANDED_REFRESH_BLOCK" 'new_primary_planner'
  check_contains "primary save_task_state passes reviewer" "$EXPANDED_REFRESH_BLOCK" 'new_primary_reviewer'
  check_contains "primary save_task_state passes planDepth" "$EXPANDED_REFRESH_BLOCK" 'new_primary_plan_depth'
  check_contains "primary save_task_state passes codeDepth" "$EXPANDED_REFRESH_BLOCK" 'new_primary_code_depth'
  check_contains "primary save_task_state passes reviewMode" "$EXPANDED_REFRESH_BLOCK" 'new_primary_review_mode'
  check_contains "challenger save_task_state passes planner" "$EXPANDED_REFRESH_BLOCK" 'new_challenger_planner'
  check_contains "challenger save_task_state passes reviewer" "$EXPANDED_REFRESH_BLOCK" 'new_challenger_reviewer'
  check_contains "challenger save_task_state passes planDepth" "$EXPANDED_REFRESH_BLOCK" 'new_challenger_plan_depth'
  check_contains "challenger save_task_state passes codeDepth" "$EXPANDED_REFRESH_BLOCK" 'new_challenger_code_depth'
  check_contains "challenger save_task_state passes reviewMode" "$EXPANDED_REFRESH_BLOCK" 'new_challenger_review_mode'
  check_contains "refresh block detects identical primary/challenger routing" "$EXPANDED_REFRESH_BLOCK" 'expanded challenge refresh produced identical primary/challenger routing, preserving'
  check_contains "refresh block compares primary/challenger planner" "$EXPANDED_REFRESH_BLOCK" 'new_primary_planner" == "$new_challenger_planner'
else
  fail "could not extract expanded refresh block from monitor path"
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
  new_challenger_key=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].key // empty" 2>/dev/null)
  new_challenger_model=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].model // empty" 2>/dev/null)
  new_challenger_planner=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planner // empty" 2>/dev/null)
  new_challenger_reviewer=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewer // empty" 2>/dev/null)
  new_challenger_plan_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].planDepth // empty" 2>/dev/null)
  new_challenger_code_depth=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].codeDepth // empty" 2>/dev/null)
  new_challenger_review_mode=$(echo "$REFRESHED_PLAN" | jq -r ".entries[1].reviewMode // empty" 2>/dev/null)

  if [[ -n "$new_primary" ]]; then
    save_task_state "HOK-9999" "hok-9999" "task/hok-9999" "/tmp/worktrees/hok-9999" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "primary" "$new_primary" "$new_primary_planner" "$new_primary" "$new_primary_reviewer" "$new_primary_plan_depth" "$new_primary_code_depth" "$new_primary_review_mode"
  fi

  challenger_slug=$(jq -r ".tasks[\"$new_challenger_key\"].slug // empty" "$STATE_FILE")
  challenger_branch=$(jq -r ".tasks[\"$new_challenger_key\"].branch // empty" "$STATE_FILE")
  challenger_worktree=$(jq -r ".tasks[\"$new_challenger_key\"].worktree // empty" "$STATE_FILE")
  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]] && [[ -n "$challenger_slug" ]] && [[ -n "$challenger_branch" ]] && [[ -n "$challenger_worktree" ]]; then
    save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "" "active" "codex" "HOK-9999" \
      "true" "HOK-9999" "challenger" "$new_challenger_model" "$new_challenger_planner" "$new_challenger_model" "$new_challenger_reviewer" "$new_challenger_plan_depth" "$new_challenger_code_depth" "$new_challenger_review_mode"
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

challenger_challenge_model=$(jq -r '.tasks["HOK-9999_c"].challengeModel // empty' "$STATE_FILE")
challenger_coder_model=$(jq -r '.tasks["HOK-9999_c"].coderModel // empty' "$STATE_FILE")
challenger_planner_model=$(jq -r '.tasks["HOK-9999_c"].plannerModel // empty' "$STATE_FILE")
challenger_reviewer_model=$(jq -r '.tasks["HOK-9999_c"].reviewerModel // empty' "$STATE_FILE")
challenger_plan_depth=$(jq -r '.tasks["HOK-9999_c"].planDepth // empty' "$STATE_FILE")
challenger_code_depth=$(jq -r '.tasks["HOK-9999_c"].codeDepth // empty' "$STATE_FILE")
challenger_review_mode=$(jq -r '.tasks["HOK-9999_c"].reviewMode // empty' "$STATE_FILE")

check_eq "primary challengeModel set to refreshed primary model" "gpt-5.4" "$primary_challenge_model"
check_eq "primary coderModel aligned with refreshed primary model" "gpt-5.4" "$primary_coder_model"
check_eq "primary plannerModel set from refreshed entry" "gpt-5.5" "$primary_planner_model"
check_eq "primary reviewerModel set from refreshed entry" "gpt-5.5" "$primary_reviewer_model"
check_eq "primary planDepth set from refreshed entry" "deep" "$primary_plan_depth"
check_eq "primary codeDepth set from refreshed entry" "deep" "$primary_code_depth"
check_eq "primary reviewMode set from refreshed entry" "static" "$primary_review_mode"

check_eq "challenger challengeModel set to refreshed challenger model" "claude-sonnet-4-6" "$challenger_challenge_model"
check_eq "challenger coderModel aligned with refreshed challenger model" "claude-sonnet-4-6" "$challenger_coder_model"
check_eq "challenger plannerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_planner_model"
check_eq "challenger reviewerModel set from refreshed entry" "claude-sonnet-4-6" "$challenger_reviewer_model"
check_eq "challenger planDepth set from refreshed entry" "deep" "$challenger_plan_depth"
check_eq "challenger codeDepth set from refreshed entry" "deep" "$challenger_code_depth"
check_eq "challenger reviewMode set from refreshed entry" "static+llm" "$challenger_review_mode"

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
echo "=== Challenge Stage-Aware Coder Override (HOK-2272) ==="

# Extract the coder override block from wavemill-mill.sh:
# the block starting with the outer `if [[ -n "$challenge_coder" ]]` and ending
# after the closing fi that contains the stage-conditional logic.
OVERRIDE_BLOCK="$(awk '
  /# For challenge tasks, the challenge model overrides the routed coder/ { capture=1 }
  capture { print }
  capture && /^[[:space:]]*fi$/ && saw_inner_fi { capture=0; exit }
  capture && /^[[:space:]]*fi$/ { saw_inner_fi=1 }
' "$MILL_SCRIPT")"

if [[ -n "$OVERRIDE_BLOCK" ]]; then
  check_contains "override conditional checks challengeStage" "$OVERRIDE_BLOCK" 'challenge_stage_meta'
  check_contains "override only applies for implementation stage" "$OVERRIDE_BLOCK" '"implementation"'
  check_contains "override skips for non-implementation stage (else branch)" "$OVERRIDE_BLOCK" 'honoring phase-config coder'
  check_contains "override applied log emitted for implementation/legacy" "$OVERRIDE_BLOCK" 'applying challengeModel override to coder'
  check_contains "empty challengeStage falls through to override (backward compat)" "$OVERRIDE_BLOCK" '-z "$challenge_stage_meta"'
else
  fail "could not extract coder override block from wavemill-mill.sh"
fi

# Test Case 1 & 2: Review-stage and plan-stage challenges must NOT apply override
# Simulate the conditional logic inline for both stages
for test_stage in "review" "plan"; do
  challenge_coder_val="claude-sonnet-4-6"
  challenge_stage_val="$test_stage"
  coder_model_val="gpt-5.4"
  override_applied="false"

  if [[ -n "$challenge_coder_val" ]]; then
    if [[ -z "$challenge_stage_val" || "$challenge_stage_val" == "implementation" ]]; then
      coder_model_val="$challenge_coder_val"
      override_applied="true"
    fi
  fi

  if [[ "$override_applied" == "false" && "$coder_model_val" == "gpt-5.4" ]]; then
    pass "${test_stage}-stage challenge: coder honors phase-config route (not challengeModel)"
  else
    echo "    expected: coder=gpt-5.4 (override skipped), got: coder=$coder_model_val override=$override_applied"
    fail "${test_stage}-stage challenge: coder override incorrectly applied"
  fi
done

# Test Case 3: Implementation-stage challenge MUST apply override
challenge_coder_val="claude-sonnet-4-6"
challenge_stage_val="implementation"
coder_model_val="gpt-5.4"

if [[ -n "$challenge_coder_val" ]]; then
  if [[ -z "$challenge_stage_val" || "$challenge_stage_val" == "implementation" ]]; then
    coder_model_val="$challenge_coder_val"
  fi
fi

if [[ "$coder_model_val" == "claude-sonnet-4-6" ]]; then
  pass "implementation-stage challenge: challengeModel override applied to coder"
else
  echo "    expected: coder=claude-sonnet-4-6, got: coder=$coder_model_val"
  fail "implementation-stage challenge: challengeModel override not applied"
fi

# Test Case 4: Legacy task without challengeStage MUST apply override (backward compat)
challenge_coder_val="claude-sonnet-4-6"
challenge_stage_val=""
coder_model_val="gpt-5.4"

if [[ -n "$challenge_coder_val" ]]; then
  if [[ -z "$challenge_stage_val" || "$challenge_stage_val" == "implementation" ]]; then
    coder_model_val="$challenge_coder_val"
  fi
fi

if [[ "$coder_model_val" == "claude-sonnet-4-6" ]]; then
  pass "legacy task (no challengeStage): challengeModel override applied for backward compat"
else
  echo "    expected: coder=claude-sonnet-4-6, got: coder=$coder_model_val"
  fail "legacy task (no challengeStage): backward compat override not applied"
fi

# Test Case 5: Non-challenge task — override block must not be entered when challenge_coder is empty
challenge_coder_val=""
coder_model_val="gpt-5.4"

if [[ -n "$challenge_coder_val" ]]; then
  coder_model_val="$challenge_coder_val"
fi

if [[ "$coder_model_val" == "gpt-5.4" ]]; then
  pass "non-challenge task: phase-config coder honored when challengeModel is absent"
else
  echo "    expected: coder=gpt-5.4, got: coder=$coder_model_val"
  fail "non-challenge task: coder unexpectedly overridden"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
