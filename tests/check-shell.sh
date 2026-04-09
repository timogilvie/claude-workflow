#!/usr/bin/env bash
set -euo pipefail

# Shell Script Validation Tests
# Checks bash syntax and verifies heredoc function availability
# to prevent the bug class from PRs 48 and 52 (undefined functions
# in the standalone monitor script).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# ============================================================================
# TEST 1: Bash syntax check on all shell scripts
# ============================================================================
echo "=== Syntax Check (bash -n) ==="

for f in \
  "$LIB_DIR"/wavemill-*.sh \
  "$LIB_DIR"/agent-adapters.sh \
  "$REPO_DIR/wavemill" \
; do
  if [[ ! -f "$f" ]]; then
    fail "File not found: $f"
    continue
  fi
  if bash -n "$f" 2>/dev/null; then
    pass "$(basename "$f")"
  else
    fail "$(basename "$f") has syntax errors"
  fi
done

# ============================================================================
# TEST 2: Heredoc function-availability check
# ============================================================================
# The monitor script in wavemill-mill.sh is generated as a standalone bash
# script via heredoc. It does NOT inherit functions from the parent shell.
# Every function it calls must be:
#   (a) defined inline in the heredoc, OR
#   (b) defined in agent-adapters.sh (which is sourced), OR
#   (c) an external command or bash builtin
#
# This test extracts the heredoc, parses function definitions and calls,
# and flags any function called but not defined.

echo ""
echo "=== Heredoc Function Availability (wavemill-mill.sh monitor script) ==="

MILL_SCRIPT="$LIB_DIR/wavemill-mill.sh"

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
else
  # Extract heredoc content (between <<'MONITOR_EOF' and ^MONITOR_EOF)
  # Use awk to extract just the content (excluding the cat line and closing marker)
  HEREDOC_CONTENT=$(awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
    /^MONITOR_EOF$/ { found=0; next }
    found { print }
  ' "$MILL_SCRIPT")

  if [[ -z "$HEREDOC_CONTENT" ]]; then
    fail "Could not extract MONITOR_EOF heredoc from wavemill-mill.sh"
  else
    # Extract function definitions from the heredoc (name followed by () with optional space and {)
    HEREDOC_FUNCS=$(echo "$HEREDOC_CONTENT" | grep -oE '^[a-z_][a-z0-9_]*\(\)' | sed 's/()//' | sort -u)

    # Extract function definitions from agent-adapters.sh (sourced by the heredoc)
    ADAPTER_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/agent-adapters.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from wavemill-common.sh (also sourced by monitor)
    COMMON_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/wavemill-common.sh" | sed 's/()//' | sort -u)

    # Combine all available function definitions
    ALL_DEFINED=$(printf '%s\n%s\n%s' "$HEREDOC_FUNCS" "$ADAPTER_FUNCS" "$COMMON_FUNCS" | sort -u)

    # Known external commands and bash builtins that are NOT custom functions
    # This list covers standard utilities, coreutils, and tools used by wavemill
    KNOWN_EXTERNALS="bash|cat|cd|chmod|column|command|continue|cut|date|declare|diff|dirname|echo|eval|exec|exit|export|false|find|fold|git|grep|gh|head|jq|kill|local|ls|mkdir|mktemp|mv|npx|printf|read|readlink|return|rm|sed|set|shift|sleep|sort|source|sqlite3|stat|tail|tee|test|tmux|touch|tr|trap|true|tput|uniq|unset|wait|wc|xargs|basename|awk|seq|ascii_downcase"

    # Extract function calls from the heredoc
    # Look for word-boundary function-like names that appear as commands
    # (start of line after optional whitespace, or after $(), ||, &&, if, then, etc.)
    CALLED_FUNCS=$(echo "$HEREDOC_CONTENT" \
      | grep -oE '\b[a-z_][a-z0-9_]{2,}\b' \
      | sort -u \
      | grep -vE "^($KNOWN_EXTERNALS)$" \
      | grep -vE '^(done|else|elif|esac|fi|for|function|if|in|then|until|while|do|case)$' \
      | grep -vE '^(err|out|dev|null|tmp|usr|bin|opt|homebrew|lib|etc|var|tmp|home)$' \
      | grep -vE '^(pipefail|euo|noglob|errexit|nounset)$' \
      | grep -vE '^(env|stdin|stdout|stderr|json|txt|csv|pid|utf)$' \
      | grep -vE '^(true|false|yes|string|number|empty|null|undefined)$' \
      | grep -vE '^(try|catch|fromjson|rollout_path|thread_id|thread_row|updated_at|exits)$')

    # Check which called names look like they could be custom functions
    # and verify they're defined
    MISSING=""
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      # Check if this name is defined in our known functions
      if ! echo "$ALL_DEFINED" | grep -qx "$name"; then
        # Only flag names that are actually used as function calls in the heredoc
        # (appear at start of a line after whitespace, or after || or && or $( )
        if echo "$HEREDOC_CONTENT" | grep -qE "(^|[;&|] *|\$\( *)$name " 2>/dev/null; then
          MISSING="$MISSING $name"
        fi
      fi
    done <<< "$CALLED_FUNCS"

    if [[ -z "$MISSING" ]]; then
      pass "All function calls in monitor heredoc are defined"
    else
      fail "Undefined function(s) called in monitor heredoc:$MISSING"
    fi

    # Also verify that functions used in the main monitoring loop are defined
    # These are the critical functions that caused PRs 48 and 52
    CRITICAL_FUNCTIONS=(
      log log_error log_warn
      save_task_state remove_task_state set_task_phase get_task_phase
      find_pr_for_branch pr_state validate_pr_merge
      linear_set_state linear_is_completed
      check_routing_complete check_plan_approved check_coding_complete check_workflow_aborted
      fetch_candidates filter_active_issues
      launch_task is_task_packet
      cleanup_dashboard_pane
    )

    for func in "${CRITICAL_FUNCTIONS[@]}"; do
      if echo "$ALL_DEFINED" | grep -qx "$func"; then
        pass "Critical function '$func' is defined in monitor scope"
      else
        fail "Critical function '$func' is NOT defined in monitor scope"
      fi
    done
  fi
fi

# ============================================================================
# TEST 3: Monitor PR-detection regression guards
# ============================================================================
echo ""
echo "=== Monitor PR Detection Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for monitor regression checks"
elif [[ -z "${HEREDOC_CONTENT:-}" ]]; then
  fail "Monitor heredoc content unavailable for regression checks"
else
  # NOTE: Use here-strings (<<<) instead of echo pipes for grepping HEREDOC_CONTENT.
  # The heredoc is ~84KB; with `echo ... | grep -q`, grep exits on first match and
  # closes the pipe while echo is still writing, causing SIGPIPE (exit 141).
  # With `set -euo pipefail`, this makes the pipeline fail even though the pattern matched.

  if grep -qE 'gh pr list --head "\$branch" --state all --json number' <<< "$HEREDOC_CONTENT"; then
    pass "monitor find_pr_for_branch queries all PR states"
  else
    fail "monitor find_pr_for_branch is missing --state all"
  fi

  if grep -qE '^pr_state\(\) \{' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines pr_state helper"
  else
    fail "monitor is missing pr_state helper definition"
  fi

  if grep -q 'linear_set_state .*"In Review"' <<< "$HEREDOC_CONTENT" && grep -q 'get_linear_issue_id' <<< "$HEREDOC_CONTENT"; then
    pass "monitor sets Linear issue to In Review when PR is detected"
  else
    fail "monitor does not set Linear issue to In Review on PR detection"
  fi

  if grep -q 'linear_set_state .*"Done"' <<< "$HEREDOC_CONTENT" && grep -q 'get_linear_issue_id' <<< "$HEREDOC_CONTENT"; then
    pass "monitor sets Linear issue to Done when work is completed"
  else
    fail "monitor does not set Linear issue to Done on completion"
  fi

  if grep -q 'set-issue-state.ts' <<< "$HEREDOC_CONTENT"; then
    pass "monitor linear_set_state uses set-issue-state.ts"
  else
    fail "monitor linear_set_state is not calling set-issue-state.ts"
  fi

  if grep -Fq '.tasks | to_entries[]' <<< "$HEREDOC_CONTENT"; then
    pass "monitor rehydrates tracked tasks from state file on startup"
  else
    fail "monitor does not rehydrate tracked tasks from state file"
  fi

  if grep -q 'done < \"\$TASKS_FILE\"' <<< "$HEREDOC_CONTENT"; then
    pass "monitor overlays newly selected tasks from TASKS_FILE"
  else
    fail "monitor does not overlay new tasks from TASKS_FILE"
  fi

  if grep -q 'update-linear-state.ts' <<< "$HEREDOC_CONTENT"; then
    fail "monitor references removed update-linear-state.ts tool"
  else
    pass "monitor does not reference update-linear-state.ts"
  fi

  LINEAR_SET_STATE_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^linear_set_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ')
  if echo "$LINEAR_SET_STATE_BLOCK" | grep -q 'return 1'; then
    fail "monitor linear_set_state must not return 1 (would exit under set -e)"
  else
    pass "monitor linear_set_state failures are non-fatal"
  fi

  MONITOR_LOOP_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^while :; do$/ { in_loop=1 }
    in_loop { print }
    in_loop && /^done$/ { exit }
  ')
  if echo "$MONITOR_LOOP_BLOCK" | grep -qE '^[[:space:]]*local[[:space:]]'; then
    fail "monitor loop contains top-level local declarations (invalid outside functions)"
  else
    pass "monitor loop has no top-level local declarations"
  fi

  if echo "$MONITOR_LOOP_BLOCK" | grep -q 'monitor_issue_state "$ISSUE"' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'issue_rc=$?' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'set +e' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'set -e'; then
    pass "monitor loop guards per-issue processing with explicit error handling"
  else
    fail "monitor loop is missing guarded per-issue processing checks"
  fi

  MONITOR_ISSUE_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^monitor_issue_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ')
  # HOK-1177: check_plan_approved/check_workflow_aborted replaced by check_stage_complete/check_stage_aborted
  PLAN_CHECK_LINE=$(echo "$MONITOR_ISSUE_BLOCK" | grep -n 'check_stage_complete "\$FEATURE_DIR" "planning"' | head -n1 | cut -d: -f1 || true)
  ABORT_CHECK_LINE=$(echo "$MONITOR_ISSUE_BLOCK" | grep -n 'check_stage_aborted "\$FEATURE_DIR"' | head -n1 | cut -d: -f1 || true)
  PANE_EARLY_RETURN_LINE=$(echo "$MONITOR_ISSUE_BLOCK" | grep -n 'Not completed externally - check if agent pane is still alive' | head -n1 | cut -d: -f1 || true)
  if [[ -n "$PLAN_CHECK_LINE" && -n "$PANE_EARLY_RETURN_LINE" ]] && (( PLAN_CHECK_LINE < PANE_EARLY_RETURN_LINE )); then
    pass "monitor checks planning approval before no-PR pane-alive early return"
  else
    fail "monitor planning approval check runs too late (after pane-alive early return)"
  fi

  if [[ -n "$ABORT_CHECK_LINE" && -n "$PLAN_CHECK_LINE" ]] && (( ABORT_CHECK_LINE < PLAN_CHECK_LINE )); then
    pass "monitor checks workflow abort before phase completion markers"
  else
    fail "monitor abort check does not take precedence over completion markers"
  fi

  if echo "$MONITOR_ISSUE_BLOCK" | grep -qE '^[[:space:]]*aborted\)$' \
    && echo "$MONITOR_ISSUE_BLOCK" | grep -q 'Workflow aborted (pane exited)'; then
    pass "monitor handles aborted state and pane-exit abort fallback"
  else
    fail "monitor is missing aborted-state handling or pane-exit abort fallback"
  fi

  CLOSED_BLOCK=$(echo "$MONITOR_ISSUE_BLOCK" | awk '
    /elif \[\[ "\$\(pr_state "\$PR"\)" == "CLOSED" \]\]; then/ { in_block=1 }
    in_block { print }
    in_block && /^[[:space:]]*else$/ { exit }
  ')

  if echo "$CLOSED_BLOCK" | grep -q 'log_warn "\$ISSUE → PR #\$PR CLOSED without merge"'; then
    pass "closed PR path preserves warning log"
  else
    fail "closed PR path is missing warning log"
  fi

  if grep -Fq 'should_cleanup_closed_pr() {' <<< "$HEREDOC_CONTENT" \
    && grep -Fq 'role=$(get_task_meta "$issue" "challengeRole")' <<< "$HEREDOC_CONTENT" \
    && grep -Fq '[[ "$role" == "challenger" && "${_CFG_CHALLENGE_AUTO_MERGE:-false}" != "true" ]]' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines closed-PR cleanup helper for manual-review challengers"
  else
    fail "monitor is missing closed-PR cleanup helper for manual-review challengers"
  fi

  if echo "$CLOSED_BLOCK" | grep -q 'if should_cleanup_closed_pr "\$ISSUE"; then' \
    && echo "$CLOSED_BLOCK" | grep -q 'cleanup_completed_task "\$ISSUE" "\$SLUG" "closed without merge"' \
    && echo "$CLOSED_BLOCK" | grep -q 'Auto-cleaning closed challenger pane/worktree'; then
    pass "closed challenger PRs trigger automatic pane/worktree cleanup"
  else
    fail "closed challenger PRs do not trigger automatic cleanup"
  fi

  if grep -qE '^read_state_value\(\) \{' <<< "$HEREDOC_CONTENT"; then
    pass "monitor defines read_state_value helper for non-fatal state reads"
  else
    fail "monitor is missing read_state_value helper"
  fi

  GET_TASK_PHASE_BLOCK=$(awk '
    /^get_task_phase\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -q 'read_state_value "executing"' <<< "$GET_TASK_PHASE_BLOCK"; then
    pass "monitor get_task_phase defaults safely when state reads fail"
  else
    fail "monitor get_task_phase is not using read_state_value"
  fi

  if grep -q 'current_agent=$(read_state_value ""' <<< "$MONITOR_ISSUE_BLOCK" \
    && grep -q 'task_status=$(read_state_value ""' <<< "$MONITOR_ISSUE_BLOCK"; then
    pass "monitor_issue_state guards agent and status reads from STATE_FILE"
  else
    fail "monitor_issue_state is missing guarded state-file reads"
  fi

  READ_STATE_VALUE_BLOCK=$(awk '
    /^read_state_value\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ' <<< "$HEREDOC_CONTENT")
  if grep -q '! -r "\$STATE_FILE" || ! -s "\$STATE_FILE"' <<< "$READ_STATE_VALUE_BLOCK"; then
    pass "read_state_value defaults on missing, unreadable, or zero-byte state files"
  else
    fail "read_state_value is missing a zero-byte state-file guard"
  fi
fi

# ============================================================================
# TEST 4: FORCE_MODEL challenge bypass guards
# ============================================================================
echo ""
echo "=== FORCE_MODEL Challenge Bypass Guards ==="

FORCE_SKIP_COUNT=$(grep -c 'Challenge skipped because FORCE_MODEL is set (\$FORCE_MODEL)' "$MILL_SCRIPT" || true)
if [[ "$FORCE_SKIP_COUNT" -eq 2 ]]; then
  pass "wavemill-mill.sh logs FORCE_MODEL challenge skips in both launch paths"
else
  fail "wavemill-mill.sh is missing FORCE_MODEL challenge skip logs in one or more launch paths"
fi

FIRST_FORCE_GUARD_LINE=$(grep -n 'if \[\[ -n "\${FORCE_MODEL:-}" \]\]; then' "$MILL_SCRIPT" | sed -n '1p' | cut -d: -f1 || true)
FIRST_RESOLVE_LINE=$(grep -n 'challenge_plan=$(npx tsx "\$TOOLS_DIR/resolve-challenge-task.ts"' "$MILL_SCRIPT" | sed -n '1p' | cut -d: -f1 || true)
if [[ -n "$FIRST_FORCE_GUARD_LINE" && -n "$FIRST_RESOLVE_LINE" ]] && (( FIRST_FORCE_GUARD_LINE < FIRST_RESOLVE_LINE )); then
  pass "initial launch path bypasses resolve-challenge-task.ts when FORCE_MODEL is set"
else
  fail "initial launch path does not guard resolve-challenge-task.ts behind FORCE_MODEL"
fi

SECOND_FORCE_GUARD_LINE=$(grep -n 'if \[\[ -n "\${FORCE_MODEL:-}" \]\]; then' "$MILL_SCRIPT" | sed -n '2p' | cut -d: -f1 || true)
SECOND_RESOLVE_LINE=$(grep -nF 'challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts"' "$MILL_SCRIPT" | sed -n '1p' | cut -d: -f1 || true)
if [[ -n "$SECOND_FORCE_GUARD_LINE" && -n "$SECOND_RESOLVE_LINE" ]] && (( SECOND_FORCE_GUARD_LINE < SECOND_RESOLVE_LINE )); then
  pass "runtime launch path bypasses resolve-challenge-task.ts when FORCE_MODEL is set"
else
  fail "runtime launch path does not guard resolve-challenge-task.ts behind FORCE_MODEL"
fi

# ============================================================================
# TEST 5: Codex attention-style regression guard
# ============================================================================
echo ""
echo "=== Codex Attention Style Regression Guard ==="

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && ! grep -q 'window-status-activity-style bg=red,fg=white,bold' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill no longer uses codex activity-style override"
else
  fail "mill still uses codex activity-style override"
fi

if [[ -f "$LIB_DIR/wavemill-orchestrator.sh" ]] && ! grep -q 'window-status-activity-style bg=red,fg=white,bold' "$LIB_DIR/wavemill-orchestrator.sh"; then
  pass "orchestrator no longer uses codex activity-style override"
else
  fail "orchestrator still uses codex activity-style override"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && grep -qE '^set_window_attention_state\(\) \{' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill defines explicit window attention helper"
else
  fail "mill is missing explicit window attention helper"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] && grep -q 'tmux refresh-client -S' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill forces tmux status refresh after attention changes"
else
  fail "mill is missing tmux status refresh after attention changes"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] \
  && grep -qE '^codex_has_pending_approval\(\) \{' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'sandbox_permissions.*require_escalated' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'function_call_output' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill defines codex pending-approval detection from session call state"
else
  fail "mill is missing codex pending-approval detection"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] \
  && grep -q 'codex_has_pending_approval "\$WT_DIR"' "$LIB_DIR/wavemill-mill.sh" \
  && grep -q 'set_window_attention_state "\$WIN" "needs-user"' "$LIB_DIR/wavemill-mill.sh"; then
  pass "monitor drives tab attention from explicit waiting states"
else
  fail "monitor is missing explicit tab attention state wiring"
fi

if [[ -f "$LIB_DIR/wavemill-mill.sh" ]] \
  && grep -qE '^launch_background_post_merge_eval\(\) \{' "$LIB_DIR/wavemill-mill.sh"; then
  pass "mill defines detached post-merge eval helper"
else
  fail "mill is missing detached post-merge eval helper"
fi

MERGED_BLOCK=$(awk '
  /log "status" "✓ \$ISSUE → PR #\$PR MERGED"/ { in_block=1 }
  in_block { print }
  in_block && /if \[\[ "\$REQUIRE_CONFIRM" == "true" \]\]; then/ { exit }
' "$LIB_DIR/wavemill-mill.sh")
if echo "$MERGED_BLOCK" | grep -q 'launch_background_post_merge_eval "\$ISSUE" "\$PR"'; then
  pass "merged PR path launches eval asynchronously"
else
  fail "merged PR path does not launch detached eval"
fi

if ! echo "$MERGED_BLOCK" | grep -q '_with_timeout 120 npx tsx "\$TOOLS_DIR/run-eval-hook.ts"'; then
  pass "merged PR path no longer runs eval inline"
else
  fail "merged PR path still runs eval inline"
fi

EXTERNAL_BLOCK=$(awk '
  /log "status" "✓ \$ISSUE → Completed externally \(cross-repo or manual\)"/ { in_block=1 }
  in_block { print }
  in_block && /if \[\[ "\$REQUIRE_CONFIRM" == "true" \]\]; then/ { exit }
' "$LIB_DIR/wavemill-mill.sh")
if echo "$EXTERNAL_BLOCK" | grep -q 'launch_background_post_merge_eval "\$ISSUE" ""'; then
  pass "external completion path launches eval asynchronously"
else
  fail "external completion path does not launch detached eval"
fi

if ! echo "$EXTERNAL_BLOCK" | grep -q '_with_timeout 120 npx tsx "\$TOOLS_DIR/run-eval-hook.ts"'; then
  pass "external completion path no longer runs eval inline"
else
  fail "external completion path still runs eval inline"
fi

if [[ -f "$LIB_DIR/wavemill-orchestrator.sh" ]] \
  && grep -q 'set-window-option -u -t "\$SESSION:\$WIN" window-status-style' "$LIB_DIR/wavemill-orchestrator.sh" \
  && grep -q 'set-window-option -u -t "\$SESSION:\$WIN" window-status-current-style' "$LIB_DIR/wavemill-orchestrator.sh"; then
  pass "orchestrator clears per-window attention styling at launch"
else
  fail "orchestrator is missing launch-time attention-style reset"
fi

# ============================================================================
# TEST 6: Dashboard planning-review status guards
# ============================================================================
echo ""
echo "=== Dashboard Planning Review Guards ==="

STATUS_SCRIPT="$LIB_DIR/wavemill-status.sh"

if [[ ! -f "$STATUS_SCRIPT" ]]; then
  fail "wavemill-status.sh not found for dashboard regression checks"
else
  if grep -qE '^plan_waiting_for_review\(\) \{' "$STATUS_SCRIPT"; then
    pass "dashboard defines plan_waiting_for_review helper"
  else
    fail "dashboard is missing plan_waiting_for_review helper"
  fi

  if grep -q '\[\[ "\$task_phase" == "planning" \]\]' "$STATUS_SCRIPT" \
    && grep -q '\[\[ "\$agent_state" == "exited" \]\]' "$STATUS_SCRIPT" \
    && grep -q '\.plan-approved' "$STATUS_SCRIPT"; then
    pass "dashboard review-waiting helper checks planning, exited agent, and approval marker"
  else
    fail "dashboard review-waiting helper is missing one or more gating conditions"
  fi

  if grep -q 'reported="Plan ready — waiting for approval"' "$STATUS_SCRIPT"; then
    pass "dashboard overrides stale status with plan review message"
  else
    fail "dashboard does not override stale status with plan review message"
  fi
fi

# ============================================================================
# TEST 7: Abort prompt guidance regression guards
# ============================================================================
echo ""
echo "=== Abort Prompt Guidance Guards ==="

if grep -q 'touch features/{{SLUG}}/.workflow-aborted' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && grep -q 'Do NOT create any phase completion or approval markers' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/planning-phase.md"; then
  pass "planning template documents abort marker flow"
else
  fail "planning template is missing abort marker guidance"
fi

if grep -q 'touch features/{{SLUG}}/.workflow-aborted' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && grep -q 'Do NOT create the phase completion marker (.coding-complete)' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/coding-phase.md"; then
  pass "coding template documents abort marker flow"
else
  fail "coding template is missing abort marker guidance"
fi

if grep -q 'touch features/{{SLUG}}/.workflow-aborted' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'Do NOT create additional completion output or a PR' "$REPO_DIR/tools/prompts/review-phase.md" \
  && grep -q 'Stop after creating the marker and reporting the abort.' "$REPO_DIR/tools/prompts/review-phase.md"; then
  pass "review template documents abort marker flow"
else
  fail "review template is missing abort marker guidance"
fi

if ! grep -q '/exit command' "$REPO_DIR/tools/prompts/planning-phase.md" \
  && ! grep -q '/exit command' "$REPO_DIR/tools/prompts/coding-phase.md" \
  && ! grep -q '/exit command' "$REPO_DIR/tools/prompts/review-phase.md"; then
  pass "shared phase templates no longer hardcode /exit"
else
  fail "shared phase templates still hardcode /exit"
fi

PROMPT_RENDER_DIR=$(mktemp -d)
trap 'rm -rf "$PROMPT_RENDER_DIR"' EXIT

source "$LIB_DIR/agent-adapters.sh"

build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" > "$PROMPT_RENDER_DIR/planning-codex.txt"
build_planning_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "claude" > "$PROMPT_RENDER_DIR/planning-claude.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "codex" > "$PROMPT_RENDER_DIR/coding-codex.txt"
build_coding_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "medium" "claude" > "$PROMPT_RENDER_DIR/coding-claude.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "codex" > "$PROMPT_RENDER_DIR/review-codex.txt"
build_review_prompt "Test title" "HOK-1130" "$REPO_DIR" "branch" "main" \
  "Issue Description:
Test
" "/tmp/status.txt" "$REPO_DIR/tools" "test-slug" "claude-sonnet" "static" "claude" > "$PROMPT_RENDER_DIR/review-claude.txt"

if grep -q '/exit' "$PROMPT_RENDER_DIR/planning-codex.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/coding-codex.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/review-codex.txt"; then
  fail "codex-facing prompts still mention /exit"
else
  pass "codex-facing prompts omit /exit"
fi

# HOK-1177: agent-agnostic lifecycle — prompts no longer tell agents to run /exit
if grep -q '/exit' "$PROMPT_RENDER_DIR/planning-claude.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/coding-claude.txt" \
  || grep -q '/exit' "$PROMPT_RENDER_DIR/review-claude.txt"; then
  fail "claude-facing prompts still reference /exit (should be agent-agnostic)"
else
  pass "claude-facing prompts use agent-agnostic lifecycle (no /exit)"
fi

EXIT_SEMANTICS_PATTERN='(/exit|remain in session|exit the process|stay running|keep running|close the session|let the session end)'

for template in planning-phase.md coding-phase.md review-phase.md; do
  if grep -qiE "$EXIT_SEMANTICS_PATTERN" "$REPO_DIR/tools/prompts/$template"; then
    fail "$template still contains agent-managed exit semantics"
  else
    pass "$template omits agent-managed exit semantics"
  fi
done

for rendered in \
  "$PROMPT_RENDER_DIR/planning-codex.txt" \
  "$PROMPT_RENDER_DIR/planning-claude.txt" \
  "$PROMPT_RENDER_DIR/coding-codex.txt" \
  "$PROMPT_RENDER_DIR/coding-claude.txt" \
  "$PROMPT_RENDER_DIR/review-codex.txt" \
  "$PROMPT_RENDER_DIR/review-claude.txt" \
; do
  if grep -qiE "$EXIT_SEMANTICS_PATTERN" "$rendered"; then
    fail "$(basename "$rendered") still contains agent-managed exit semantics"
  else
    pass "$(basename "$rendered") omits agent-managed exit semantics"
  fi
done

TMUX_CAPTURE=()
tmux() {
  if [[ "${1:-}" == "send-keys" ]]; then
    shift
    while [[ $# -gt 0 ]]; do
      case "$1" in
        -t|--)
          shift
          if [[ "${1:-}" == *:* ]]; then
            shift
          fi
          ;;
        -l|C-m)
          shift
          ;;
        *)
          TMUX_CAPTURE+=("$1")
          shift
          ;;
      esac
    done
    return 0
  fi
  return 0
}

agent_prepare_pane_for_launch() {
  return 0
}

CODEX_PROMPT_FILE="$PROMPT_RENDER_DIR/interactive-codex-prompt.txt"
printf 'planning prompt\n' > "$CODEX_PROMPT_FILE"
agent_launch_interactive "wavemill-test" "planning" "$CODEX_PROMPT_FILE" "codex" "gpt-5.4"

CODEX_LAUNCHER_PATH=""
for captured in "${TMUX_CAPTURE[@]}"; do
  if [[ "$captured" == */*-launcher.sh ]]; then
    printf -v CODEX_LAUNCHER_PATH '%b' "${captured//\\/\\\\}"
    break
  fi
done

if [[ -f "$CODEX_LAUNCHER_PATH" ]] \
  && grep -q 'codex --model gpt-5.4 --dangerously-bypass-approvals-and-sandbox --no-alt-screen "\$(cat ' "$CODEX_LAUNCHER_PATH"; then
  pass "interactive Codex launcher uses interactive codex with bypass flag"
else
  fail "interactive Codex launcher is missing interactive codex flags"
fi

if [[ -f "$CODEX_LAUNCHER_PATH" ]] \
  && grep -q 'echo "\[wavemill\] Agent exited (\$?)"' "$CODEX_LAUNCHER_PATH"; then
  pass "interactive Codex launcher reports agent exit status"
else
  fail "interactive Codex launcher is missing exit status echo"
fi

# ============================================================================
# TEST 8: Dashboard log filtering behavior
# ============================================================================
echo ""
echo "=== Dashboard Log Filtering ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for log filtering checks"
else
  LOG_FUNCTION_BLOCK=$(awk '
    /^_log_level_num\(\) \{/ && !captured { capture=1; captured=1 }
    capture && /^render_prompt_template\(\) \{/ { exit }
    capture { print }
  ' "$MILL_SCRIPT")

  if [[ -z "$LOG_FUNCTION_BLOCK" ]]; then
    fail "Could not extract log function block"
  else
    LOG_TEST_DIR=$(mktemp -d)
    LOG_TEST_SCRIPT="$LOG_TEST_DIR/log-functions.sh"
    printf '%s\n' "$LOG_FUNCTION_BLOCK" > "$LOG_TEST_SCRIPT"

    SINGLE_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      log "plain message"
    ' 2>/dev/null || true)
    if [[ "$SINGLE_OUTPUT" == *"plain message"* ]]; then
      pass "single-arg log defaults to info output"
    else
      fail "single-arg log does not default to info output"
    fi

    ERROR_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=error
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      log "error" "always visible"
    ' 2>/dev/null || true)
    if [[ "$ERROR_OUTPUT" == *"always visible"* ]]; then
      pass "error-level log shows at error verbosity"
    else
      fail "error-level log is hidden at error verbosity"
    fi

    DEBUG_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=info
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      log "debug" "hidden debug"
    ' 2>/dev/null || true)
    if [[ -z "$DEBUG_OUTPUT" ]]; then
      pass "debug-level log is suppressed at info verbosity"
    else
      fail "debug-level log is not suppressed at info verbosity"
    fi

    STATUS_OUTPUT=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      DASHBOARD_VERBOSITY=status
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=false
      log "info" "hidden info"
    ' 2>/dev/null || true)
    if [[ -z "$STATUS_OUTPUT" ]]; then
      pass "info-level log is suppressed at status verbosity"
    else
      fail "info-level log is not suppressed at status verbosity"
    fi

    LOG_FILE_CHECK=$(bash -lc '
      source "'"$LOG_TEST_SCRIPT"'"
      TMP_LOG=$(mktemp)
      DASHBOARD_VERBOSITY=error
      VERBOSITY_NUM=$(_log_level_num "$DASHBOARD_VERBOSITY")
      DASHBOARD_LOG_TO_FILE=true
      MILL_LOG_FILE="$TMP_LOG"
      log "debug" "persisted debug"
      cat "$TMP_LOG"
    ' 2>/dev/null || true)
    if [[ "$LOG_FILE_CHECK" == *"[debug] persisted debug"* ]]; then
      pass "suppressed logs still write to session log file"
    else
      fail "suppressed logs do not write to session log file"
    fi

    rm -rf "$LOG_TEST_DIR"
  fi
fi

# ============================================================================
# TEST 9: Mill drift refresh prompt wiring
# ============================================================================
echo ""
echo "=== Mill Drift Refresh Wiring ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for drift refresh checks"
else
  if grep -q 'check_subsystem_drift() {' "$MILL_SCRIPT" \
    && grep -q 'npx tsx tools/check-drift.ts "\$REPO_DIR"' "$MILL_SCRIPT"; then
    pass "mill script defines subsystem drift wrapper"
  else
    fail "mill script is missing subsystem drift wrapper"
  fi

  if grep -q "Warning: Subsystem docs stale" "$MILL_SCRIPT" \
    && grep -q "press d to refresh" "$MILL_SCRIPT"; then
    pass "mill script shows stale docs advisory"
  else
    fail "mill script is missing stale docs advisory"
  fi

  if grep -q "d to refresh docs" "$MILL_SCRIPT" \
    && grep -q '\[\[ "\$SELECTED" =~ ^\[dD\](ocs)?\$ \]\]' "$MILL_SCRIPT"; then
    pass "mill script supports docs refresh hotkey"
  else
    fail "mill script is missing docs refresh hotkey support"
  fi

  if grep -q 'npx tsx tools/init-project-context.ts --force "\$REPO_DIR"' "$MILL_SCRIPT" \
    && grep -q 'Subsystem docs are up to date' "$MILL_SCRIPT"; then
    pass "mill script refreshes docs and handles clean state"
  else
    fail "mill script is missing docs refresh command or clean-state message"
  fi
fi

# ============================================================================
# TEST 10: Verify sourced libraries exist
# ============================================================================
echo ""
echo "=== Sourced Library Verification ==="

# Check that all source statements in shell scripts reference existing files
for script in "$LIB_DIR"/wavemill-*.sh; do
  [[ -f "$script" ]] || continue
  while IFS= read -r line; do
    # Extract the sourced file path (handle both $SCRIPT_DIR and $LIB_DIR variables)
    sourced=$(echo "$line" | sed -E 's/^source "//;s/"$//' \
      | sed "s|\\\$SCRIPT_DIR|$LIB_DIR|g" \
      | sed "s|\\\$LIB_DIR|$LIB_DIR|g" \
      | sed "s|\\\${BASH_SOURCE\[0\]}|$script|g")
    # Skip variable-only paths we can't resolve statically
    if echo "$sourced" | grep -q '\$'; then
      continue
    fi
    if [[ -f "$sourced" ]]; then
      pass "$(basename "$script") sources $(basename "$sourced") (exists)"
    else
      fail "$(basename "$script") sources $sourced (NOT FOUND)"
    fi
  done < <(grep -E '^\s*source\s+"' "$script" 2>/dev/null || true)
done

# ============================================================================
# TEST 11: Optional ShellCheck
# ============================================================================
if command -v shellcheck >/dev/null 2>&1; then
  echo ""
  echo "=== ShellCheck (error severity) ==="
  for f in "$LIB_DIR"/wavemill-common.sh "$LIB_DIR"/agent-adapters.sh; do
    [[ -f "$f" ]] || continue
    if shellcheck --severity=error "$f" 2>/dev/null; then
      pass "shellcheck $(basename "$f")"
    else
      fail "shellcheck $(basename "$f")"
    fi
  done
fi

# ============================================================================
# RESULTS
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
