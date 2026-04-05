#!/opt/homebrew/bin/bash
set -euo pipefail

# Wavemill Mill - Continuous Task Execution System
#
# This script implements a continuous loop that:
# 1. Fetches prioritized tasks from Linear backlog
# 2. Launches parallel agent workers in tmux windows
# 3. Monitors PR creation and merge status
# 4. Auto-cleans completed tasks
# 5. Prompts user to select next batch (with 10s auto-continue)
#
# Exit conditions:
#   - Empty backlog (no tasks available)
#   - User declines to continue at prompt
#   - Stop signal file exists: touch $STATE_DIR/.stop-loop
#
# Manual controls:
#   - Ctrl+B D: Detach from tmux (loop continues in background)
#   - touch ~/.wavemill/.stop-loop: Stop loop after current cycle
#   - Ctrl+C: Interrupt and reset in-progress tasks to Backlog

REPO_DIR="${REPO_DIR:-$PWD}"

# Source common library and load layered config
# Resolution: env vars > .wavemill-config.json > ~/.wavemill/config.json > defaults
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/agent-adapters.sh"
load_config "$REPO_DIR"

# Derived variables (not in config files)
DRY_RUN="${DRY_RUN:-false}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"


command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
command -v gh >/dev/null || { echo "Error: gh required (install: brew install gh && gh auth login)"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
command -v tmux >/dev/null || { echo "Error: tmux required (install: brew install tmux)"; exit 1; }
agent_validate "$AGENT_CMD" || { echo "Error: agent '$AGENT_CMD' not found"; exit 1; }

# Check agent authentication before launching tasks
if ! agent_check_auth "$AGENT_CMD"; then
  exit 1
fi


# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================


# Logging with timestamps
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }

# Kept local to this script because the generated monitor script below runs as a
# standalone shell and must carry its own copy of any helpers it calls.
render_prompt_template() {
  local template_path="$1"
  shift

  if [[ ! -f "$template_path" ]]; then
    log_error "Prompt template not found: $template_path"
    return 1
  fi

  local content
  content="$(cat "$template_path")"

  local pair key value
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    content="${content//\{\{$key\}\}/$value}"
  done

  printf '%s' "$content"
}


indent_block() {
  local prefix="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s%s\n' "$prefix" "$line"
  done
}


# Dry-run wrapper
execute() {
  if [[ "$DRY_RUN" == "true" ]]; then
    echo "[DRY-RUN] $*"
    return 0
  else
    "$@"
  fi
}


# Confirmation prompt
confirm() {
  local prompt="$1"
  if [[ "$REQUIRE_CONFIRM" != "true" ]]; then
    return 0
  fi
  read -p "$prompt [y/N] " -n 1 -r
  echo
  [[ $REPLY =~ ^[Yy]$ ]]
}


# Run a command with a hard wall-clock timeout (works on macOS without coreutils).
# Usage: _with_timeout <seconds> <command> [args...]
_with_timeout() {
  local secs=$1
  shift

  # Prefer system timeout / gtimeout if available
  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
    return $?
  fi

  # Fallback: background process + fire-and-forget watchdog.
  # Redirect watchdog output to /dev/null so it doesn't hold file
  # descriptors open inside $() command substitutions.
  "$@" &
  local pid=$!
  ( sleep "$secs" && kill "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  local wd=$!

  # Wait ONLY for the actual command — returns as soon as it exits.
  # Do NOT wait for the watchdog: on macOS, killing the watchdog subshell
  # does not kill its child `sleep`, so `wait $wd` blocks for the full
  # timeout duration even when the command finished quickly.
  wait "$pid" 2>/dev/null
  local rc=$?

  # Best-effort cleanup of the watchdog (fire-and-forget).
  kill "$wd" 2>/dev/null || true

  return "$rc"
}


# Per-attempt timeout for retried commands (seconds)
RETRY_TIMEOUT="${RETRY_TIMEOUT:-30}"


# Retry wrapper with exponential backoff and per-attempt timeout
retry() {
  local max_attempts="$MAX_RETRIES"
  local delay="$RETRY_DELAY"
  local attempt=1
  local exit_code=0


  while (( attempt <= max_attempts )); do
    _with_timeout "$RETRY_TIMEOUT" "$@" && return 0
    exit_code=$?


    if (( attempt < max_attempts )); then
      log_warn "Command failed (attempt $attempt/$max_attempts), retrying in ${delay}s..."
      sleep "$delay"
      delay=$((delay * 2))
    fi
    attempt=$((attempt + 1))
  done


  log_error "Command failed after $max_attempts attempts"
  return "$exit_code"
}


# State ledger functions
init_state_ledger() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"session":"'$SESSION'","started":"'$(date -u +%Y-%m-%dT%H:%M:%SZ)'","tasks":{}}' > "$STATE_FILE"
  fi
}


save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
  local tmp
  tmp=$(mktemp) || { log_warn "save_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" --arg agent "$agent" \
     --arg linearIssue "$linear_issue" --arg challenge "$challenge" --arg challengePair "$challenge_pair" \
     --arg challengeRole "$challenge_role" --arg challengeModel "$challenge_model" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode" \
     '.tasks[$issue] = (.tasks[$issue] // {}) + {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, linearIssueId: $linearIssue, updated: (now | todate)}
      | if $agent != "" then .tasks[$issue].agent = $agent else . end
      | if $challenge != "" then .tasks[$issue].challenge = ($challenge == "true") else . end
      | if $challengePair != "" then .tasks[$issue].challengePairId = $challengePair else . end
      | if $challengeRole != "" then .tasks[$issue].challengeRole = $challengeRole else . end
      | if $challengeModel != "" then .tasks[$issue].challengeModel = $challengeModel else . end
      | if $plannerModel != "" then .tasks[$issue].plannerModel = $plannerModel else . end
      | if $coderModel != "" then .tasks[$issue].coderModel = $coderModel else . end
      | if $reviewerModel != "" then .tasks[$issue].reviewerModel = $reviewerModel else . end
      | if $planDepth != "" then .tasks[$issue].planDepth = $planDepth else . end
      | if $codeDepth != "" then .tasks[$issue].codeDepth = $codeDepth else . end
      | if $reviewMode != "" then .tasks[$issue].reviewMode = $reviewMode else . end' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "save_task_state: failed to update $issue"
  fi
}


get_task_state() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue] // empty' "$STATE_FILE"
}


# Migration state helpers — persist reservations in the state ledger
# so both the initial mill and the monitoring loop stay coordinated.
scan_highest_migration() {
  # Scan the git tree (not filesystem) for the highest migration number.
  # Requires a prior `git fetch` so origin/$BASE_BRANCH is up-to-date.
  local highest
  highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
    | grep -oE '^[0-9]+' | sort -n | tail -1)
  echo "${highest:-0}"
}

get_next_migration_num() {
  # Read from state file; returns empty if not yet set.
  jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null
}

save_migration_reservation() {
  local issue="$1"
  local num="$2"
  local tmp
  tmp=$(mktemp) || return 0
  if jq --arg issue "$issue" --argjson num "$num" \
     '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}

save_next_migration_num() {
  local num="$1"
  local tmp
  tmp=$(mktemp) || return 0
  if jq --argjson num "$num" '.nextMigrationNum = $num' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
  fi
}


remove_task_state() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "remove_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" 'del(.tasks[$issue])' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "remove_task_state: failed to remove $issue"
  fi
}


set_task_phase() {
  local issue="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || { log_warn "set_task_phase: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "set_task_phase: failed to update $issue"
  fi
}


get_task_phase() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue].phase // "executing"' "$STATE_FILE" 2>/dev/null
}


check_routing_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.routing-complete" ]] && return 0
  return 1
}


check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
  return 1
}


check_coding_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.coding-complete" ]] && return 0
  return 1
}


set_window_attention_state() {
  local win="$1" state="${2:-clear}"
  if [[ "$state" == "needs-user" ]]; then
    tmux set-window-option -t "$SESSION:$win" window-status-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    tmux set-window-option -t "$SESSION:$win" window-status-current-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  else
    tmux set-window-option -u -t "$SESSION:$win" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$SESSION:$win" window-status-current-style >/dev/null 2>&1 || true
  fi
  tmux refresh-client -S >/dev/null 2>&1 || true
}


codex_has_pending_approval() {
  local worktree="$1"
  local codex_db="$HOME/.codex/state_5.sqlite"
  [[ -n "$worktree" ]] || return 1
  [[ -f "$codex_db" ]] || return 1

  local escaped_worktree thread_row thread_id rollout_path
  escaped_worktree=${worktree//\'/\'\'}
  thread_row=$(sqlite3 "$codex_db" \
    "SELECT id || '|' || rollout_path FROM threads WHERE cwd = '$escaped_worktree' ORDER BY updated_at DESC LIMIT 1;" \
    2>/dev/null || true)
  [[ -n "$thread_row" ]] || return 1

  thread_id="${thread_row%%|*}"
  rollout_path="${thread_row#*|}"
  [[ -n "$thread_id" && -f "$rollout_path" ]] || return 1

  declare -A pending_calls=()
  local event_type call_id
  while IFS=$'\t' read -r event_type call_id; do
    [[ -n "$call_id" ]] || continue
    case "$event_type" in
      pending) pending_calls["$call_id"]=1 ;;
      resolved) unset 'pending_calls[$call_id]' ;;
    esac
  done < <(
    jq -r '
      if .type == "response_item" and .payload.type == "function_call" then
        ((.payload.arguments? // "{}") | try fromjson catch {}) as $args |
        if ($args.sandbox_permissions // "") == "require_escalated" then
          "pending\t\(.payload.call_id // "")"
        else
          empty
        end
      elif .type == "response_item" and .payload.type == "function_call_output" then
        "resolved\t\(.payload.call_id // "")"
      else
        empty
      end
    ' "$rollout_path" 2>/dev/null
  )

  (( ${#pending_calls[@]} > 0 ))
}


check_plan_exists() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/plan.md" ]] && return 0
  return 1
}


# Clean up completed task: close window, remove worktree/branch, update state
# Args: issue_id, slug, completion_reason (optional, for logging)
cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"

  # Kill tmux window (unconditional - no race condition)
  local win="$issue-$slug"
  execute tmux kill-window -t "$SESSION:$win" 2>/dev/null || true
  log "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    execute git -C "$REPO_DIR" worktree remove "$wt_dir" --force 2>/dev/null || true
    log "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch
  local task_branch="task/${slug}"
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    execute git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
    log "  ✓ Deleted branch: $task_branch"
  fi

  # Clean up state
  execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  # Log completion with optional reason
  if [[ -n "$completion_reason" ]]; then
    log "  ✓ Complete: $issue ($completion_reason)"
  else
    log "  ✓ Complete: $issue"
  fi
}


# ============================================================================
# LINEAR API WITH RETRY
# ============================================================================


linear_list_backlog() {
  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if retry npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>"$stderr_file"; then
    rm -f "$stderr_file"
  else
    local rc=$?
    log_error "Backlog fetch failed. stderr:"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return "$rc"
  fi
}
linear_get_issue() {
  # Capture stdout (JSON); collect stderr so we can show it on failure
  local stderr_file
  stderr_file=$(mktemp)
  if retry npx tsx "$TOOLS_DIR/get-issue.ts" "$1" --json 2>"$stderr_file"; then
    rm -f "$stderr_file"
  else
    local rc=$?
    log_error "Issue fetch failed for $1. stderr:"
    cat "$stderr_file" >&2
    rm -f "$stderr_file"
    return "$rc"
  fi
}


linear_set_description() {
  local issue="$1"
  local file="$2"


  if [[ "$DRY_RUN" == "true" ]]; then
    log "[DRY-RUN] Would update $issue description from $file"
    return 0
  fi


  retry npx tsx "$TOOLS_DIR/update-issue.ts" "$issue" --file "$file" >/dev/null 2>&1
}


linear_set_state() {
  local issue="$1" state="$2"
  [[ "$DRY_RUN" == "true" ]] && { log "[DRY-RUN] Would set $issue → $state"; return 0; }
  retry npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1 || log_warn "Failed to set $issue → $state in Linear"
}


linear_is_completed() {
  local issue="$1"
  local state
  state=$(_with_timeout "$RETRY_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue-state.ts" "$issue" 2>/dev/null || echo "active")
  [[ "$state" == "completed" ]] && return 0
  return 1
}


# Note: is_task_packet() and write_task_packet() now provided by wavemill-common.sh


# Conflict-aware task selection with multi-factor priority scoring
# Fetches up to 30 candidates so we have enough unblocked items after filtering
# Output: identifier|slug|title|area|score|blocked_by_count
pick_candidates() {
  local backlog_json="$1"
  local show_limit=30

  # Use shared scoring function; strip has_detailed_plan (field 6), keep blocked_by_count (field 7→6)
  score_and_rank_issues "$backlog_json" "$show_limit" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}'
}


# Smart selection that avoids area conflicts
smart_select_from_candidates() {
  local candidates="$1"
  local selected_numbers="$2"


  if [[ -z "$selected_numbers" ]]; then
    # Auto-select up to MAX_PARALLEL with conflict avoidance
    local -A area_used=()
    local -a result=()
    local count=0


    while IFS= read -r line && [[ $count -lt $MAX_PARALLEL ]]; do
      IFS='|' read -r issue slug title area score blocked_by <<<"$line"


      # Check area conflict - skip if area already in use
      if [[ -n "$area" ]] && [[ -n "${area_used[$area]:-}" ]]; then
        continue
      fi


      # Accept this task
      result+=("$issue|$slug|$title")
      [[ -n "$area" ]] && area_used["$area"]=1
      ((count++))
    done <<<"$candidates"


    printf '%s\n' "${result[@]}"
  else
    # User selected specific numbers - extract first 3 fields only
    while read -r n; do
      echo "$candidates" | sed -n "${n}p" | cut -d'|' -f1-3
    done <<<"$(echo "$selected_numbers" | tr ' ' '\n')"
  fi
}


# ============================================================================
# GITHUB API WITH RETRY AND VALIDATION
# ============================================================================


find_pr_for_branch() {
  local branch="$1"
  gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || true
}


pr_state() {
  local pr="$1"
  gh pr view "$pr" --json state --jq .state 2>/dev/null || echo ""
}


# Get PR details with base branch validation
pr_details() {
  local pr="$1"
  gh pr view "$pr" --json state,baseRefName,statusCheckRollup 2>/dev/null || echo ""
}


# Check if PR is merged and ready for cleanup
# Returns 0 if merged, 1 if not
# Note: Once PR is merged, CI status is irrelevant for cleanup decisions
validate_pr_merge() {
  local pr="$1"
  local details


  details="$(pr_details "$pr" 2>/dev/null || echo "")"


  if [[ -z "$details" ]]; then
    log_error "Failed to fetch PR #$pr details"
    return 1
  fi


  local state base_branch
  state=$(echo "$details" | jq -r '.state' 2>/dev/null) || return 1
  base_branch=$(echo "$details" | jq -r '.baseRefName' 2>/dev/null) || return 1


  # Check 1: Must be MERGED (not CLOSED)
  if [[ "$state" != "MERGED" ]]; then
    log_warn "PR #$pr state is $state (not MERGED)"
    return 1
  fi


  # Check 2: Must be merged to correct base branch
  if [[ "$base_branch" != "$BASE_BRANCH" ]]; then
    log_error "PR #$pr merged to wrong base: $base_branch (expected: $BASE_BRANCH)"
    return 1
  fi


  # Once PR is merged, proceed with cleanup regardless of CI status.
  # The merge has already happened; CI validation is for pre-merge safety.
  return 0
}


# ============================================================================
# MAIN WORKFLOW
# ============================================================================


# Trap handler for cleanup on exit/interrupt
ISSUES_IN_PROGRESS=()
cleanup_on_exit() {
  local exit_code=$?
  if [[ ${#ISSUES_IN_PROGRESS[@]} -gt 0 ]]; then
    log_warn "Interrupted - resetting Linear state for unfinished tasks..."
    log_warn "Worktrees and branches preserved for resumption on next run."
    for issue in "${ISSUES_IN_PROGRESS[@]}"; do
      role=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE" 2>/dev/null)
      linear_issue=$(jq -r --arg issue "$issue" '.tasks[$issue].linearIssueId // .tasks[$issue].challengePairId // $issue' "$STATE_FILE" 2>/dev/null)
      if [[ "$role" != "challenger" ]]; then
        linear_set_state "${linear_issue:-$issue}" "Backlog" 2>/dev/null || true
      fi
      remove_task_state "$issue" 2>/dev/null || true
    done
  fi
  exit $exit_code
}
trap cleanup_on_exit INT TERM


# Initialize state ledger
init_state_ledger


# Prune stale tasks from previous runs
# Check each task: if PR merged or branch deleted, clean up worktree + state
cleanup_stale_tasks() {
  local stale_issues
  stale_issues=$(jq -r '.tasks | to_entries[] | .key' "$STATE_FILE" 2>/dev/null)
  [[ -z "$stale_issues" ]] && return 0

  local cleaned=0
  while IFS= read -r issue; do
    [[ -z "$issue" ]] && continue
    local task_json
    task_json=$(jq -r --arg i "$issue" '.tasks[$i]' "$STATE_FILE")
    local slug branch worktree pr linear_issue eval_completed
    slug=$(echo "$task_json" | jq -r '.slug')
    branch=$(echo "$task_json" | jq -r '.branch')
    worktree=$(echo "$task_json" | jq -r '.worktree')
    pr=$(echo "$task_json" | jq -r '.pr // empty')
    linear_issue=$(echo "$task_json" | jq -r '.linearIssueId // empty')
    eval_completed=$(echo "$task_json" | jq -r '.evalCompleted // false')

    local should_clean=false
    local full_clean=false  # true = also remove worktree+branch
    local reason=""

    # Check if branch still exists
    if ! git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      should_clean=true
      full_clean=true
      reason="branch deleted"
    # Check if Linear issue is completed (handles cross-repo PRs)
    elif linear_is_completed "$issue" 2>/dev/null; then
      should_clean=true
      full_clean=true
      reason="Linear issue completed externally"
    # Check if PR was merged or closed
    elif [[ -n "$pr" ]]; then
      local pr_st
      pr_st=$(gh pr view "$pr" --json state --jq .state 2>/dev/null || echo "")
      if [[ "$pr_st" == "MERGED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr merged"
      elif [[ "$pr_st" == "CLOSED" ]]; then
        should_clean=true
        full_clean=true
        reason="PR #$pr closed"
        # Run failure eval before cleanup so closed PRs are scored
        if [[ "$AUTO_EVAL" == "true" && "$eval_completed" == "false" ]]; then
          log "  📊 Running failure eval for closed PR #$pr..."
          local eval_log="/tmp/${SESSION}-eval-${issue}.log"
          : >"$eval_log"
          (
            {
              printf 'Launching pr-closed eval in background\n'
              _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
                --issue "${linear_issue:-$issue}" --pr "$pr" --branch "$branch" \
                --worktree "${WORKTREE_ROOT}/${slug}" \
                --workflow-type mill --repo-dir "$REPO_DIR" \
                --agent "$AGENT_CMD" \
                --debug
              printf 'Eval process exited with code %s\n' "$?"
            } >>"$eval_log" 2>&1 || true
            # Mark eval completed in state (harmless if task already removed)
            local tmp
            tmp=$(mktemp) || true
            if [[ -n "${tmp:-}" ]] && jq --arg issue "$issue" \
               '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
               "$STATE_FILE" > "$tmp" 2>/dev/null; then
              mv "$tmp" "$STATE_FILE"
            else
              rm -f "${tmp:-}"
            fi
          ) >/dev/null 2>&1 &
          log "  ↳ Eval running in background; log: $eval_log"
        fi
      fi
    fi

    # Keep non-terminal tasks in state across restarts so the monitor can
    # resume PR/state reconciliation after crashes.

    if [[ "$should_clean" == "true" ]]; then
      log "  Pruning $issue ($reason)"
      if [[ "$full_clean" == "true" ]]; then
        # Clean up worktree + branch for completed tasks
        if [[ -d "$worktree" ]]; then
          execute git -C "$REPO_DIR" worktree remove "$worktree" --force 2>/dev/null || true
        fi
        if [[ "$reason" != "branch deleted" ]]; then
          git -C "$REPO_DIR" branch -D "$branch" 2>/dev/null || true
        fi
      fi
      # Remove from state file (dashboard will stop showing it)
      remove_task_state "$issue"
      cleaned=$((cleaned + 1))
    fi
  done <<<"$stale_issues"

  if (( cleaned > 0 )); then
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    log "  Cleaned $cleaned stale task(s)"
  fi
}

stale_count=$(jq '.tasks | length' "$STATE_FILE" 2>/dev/null || echo 0)
if (( stale_count > 0 )); then
  log "Found $stale_count task(s) in state file from previous run. Checking..."
  cleanup_stale_tasks
fi


# Display configuration
if [[ "$DRY_RUN" == "true" ]]; then
  echo "============================================"
  echo "DRY-RUN MODE - No actions will be executed"
  echo "============================================"
fi


log "Configuration:"
log "  Repository: $REPO_DIR"
log "  Base branch: $BASE_BRANCH"
log "  Worktree root: $WORKTREE_ROOT"
log "  Project: ${PROJECT_NAME:-(all projects)}"
log "  Agent: $AGENT_CMD ($(agent_name "$AGENT_CMD"))${AGENT_CMD_EXPLICIT:+ [explicit override]}"
log "  Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)"
log "  Max parallel: $MAX_PARALLEL"
log "  Planning mode: $PLANNING_MODE"
[[ -n "${SETUP_CMD:-}" ]] && log "  Setup command: $SETUP_CMD"
log "  State file: $STATE_FILE"
echo ""


# Safety check: first-time repo confirmation
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]]; then
  echo "⚠️  First-time run in this repository"
  confirm "Continue with autonomous workflow in $REPO_DIR?" || exit 1
  execute touch "$STATE_DIR/.initialized"
fi


log "Fetching backlog..."
BACKLOG="$(linear_list_backlog)" || {
  log_error "Failed to fetch backlog from Linear. Check your LINEAR_API_KEY and network."
  exit 1
}

if [[ -z "$BACKLOG" ]] || [[ "$BACKLOG" == "[]" ]]; then
  log "No backlog items returned from Linear."
  exit 0
fi

CANDIDATES="$(pick_candidates "$BACKLOG")"
if [[ -z "$CANDIDATES" ]]; then
  log "No backlog candidates found."
  exit 0
fi


# Split candidates into unblocked and blocked
# pick_candidates() outputs 6 fields (has_detailed_plan is stripped), so field 6 is blocked_by_count
UNBLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 == 0 || $6 == ""')
BLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 > 0')
BLOCKED_COUNT=0
[[ -n "$BLOCKED" ]] && BLOCKED_COUNT=$(echo "$BLOCKED" | grep -c .)

echo ""
log "Available tasks (ranked by priority):"
if [[ -n "$UNBLOCKED" ]]; then
  echo "$UNBLOCKED" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
else
  echo "  (no unblocked tasks)"
fi

if (( BLOCKED_COUNT > 0 )); then
  echo ""
  echo "  ($BLOCKED_COUNT blocked task(s) hidden — enter 'm' to show all)"
fi

echo ""
if (( BLOCKED_COUNT > 0 )); then
  echo "Enter numbers to run (e.g. 1 3 5), m for more, q to quit, or Enter to auto-select first $MAX_PARALLEL:"
else
  echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to auto-select first $MAX_PARALLEL:"
fi
read -r SELECTED

# Handle 'm' to show all tasks including blocked
if [[ "$SELECTED" =~ ^[mM] ]]; then
  ALL_CANDIDATES=$(printf '%s\n%s' "$UNBLOCKED" "$BLOCKED" | grep .)
  echo ""
  log "All tasks (ranked by priority):"
  line_num=0
  while IFS= read -r line; do
    line_num=$((line_num + 1))
    IFS='|' read -r id slug title area score blocked_by <<<"$line"
    if (( blocked_by > 0 )); then
      printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$line_num" "$id" "$title" "$score"
    else
      printf "  %s. %s - %s (score: %.0f)\n" "$line_num" "$id" "$title" "$score"
    fi
  done <<<"$ALL_CANDIDATES"
  echo ""
  echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to auto-select first $MAX_PARALLEL:"
  read -r SELECTED
  # Use full list for selection
  CANDIDATES="$ALL_CANDIDATES"
fi

if [[ "$SELECTED" =~ ^[qQ](uit)?$ ]]; then
  log "Cancelled by user."
  exit 0
fi

# When auto-selecting (empty input), only pick from unblocked candidates
if [[ -z "$SELECTED" ]] && [[ -n "$UNBLOCKED" ]]; then
  CANDIDATES="$UNBLOCKED"
fi

# Use smart selection
TASKS=()
SELECTED_LINES="$(smart_select_from_candidates "$CANDIDATES" "$SELECTED")"
while IFS= read -r line; do
  [[ -n "$line" ]] && TASKS+=("$line")
done <<<"$SELECTED_LINES"


log "Normalizing issues with task packets and launching work..."
LAUNCH_ARGS=()


# Pre-allocate migration numbers for parallel work
# Fetch first so we scan the latest state of the base branch (not stale local files)
log "Fetching latest $BASE_BRANCH for migration scan..."
git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>/dev/null || true

# Scan the git tree (not local filesystem) for the highest existing migration number
HIGHEST=$(scan_highest_migration)
NEXT_MIGRATION_NUM=$((HIGHEST + 1))
save_next_migration_num "$NEXT_MIGRATION_NUM"
log "Next available migration number: $NEXT_MIGRATION_NUM (highest in origin/$BASE_BRANCH: $HIGHEST)"


# ── Phase 1: Fetch issue details in parallel ──────────────────────────────
log "Fetching issue details..."
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  (
    json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
    echo "$json" > "/tmp/${SESSION}-${ISSUE}-issue.json"
  ) &
done
wait
log "  ✓ All issues fetched"


# ── Phase 2: Write task packets (no expansion — agent expands in-pane) ────
# If the Linear description is already a task packet, use it directly.
# Otherwise, write the raw description — the planning agent will expand later.
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  if is_task_packet "$current_desc"; then
    log "  ✓ $ISSUE has task packet"
  else
    log "  ✓ $ISSUE raw description saved (agent will expand)"
  fi
  echo "$current_desc" > "$PACKET_FILE"
done


# ── Phase 3: Migration detection + state saving ──────────────────────────
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Check if task involves database migration
  # Detection order: 1) label match  2) keyword in raw description
  # Note: expanded packet keyword scan moved to planning agent (post-expansion)
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)
  is_migration=false

  if [[ -n "$has_migration_label" ]]; then
    log "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$current_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    log "  → Migration detected (raw description keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
    is_migration=true
  fi

  if [[ "$is_migration" == "true" ]]; then
    # Append migration hint to task packet
    echo "" >> "$PACKET_FILE"
    echo "---" >> "$PACKET_FILE"
    echo "**ASSIGNED MIGRATION NUMBER**: $NEXT_MIGRATION_NUM" >> "$PACKET_FILE"
    echo "" >> "$PACKET_FILE"
    echo "Use revision='$(printf '%03d' $NEXT_MIGRATION_NUM)' in your Alembic migration file." >> "$PACKET_FILE"
    echo "CRITICAL: This number has been reserved to avoid conflicts with parallel tasks." >> "$PACKET_FILE"
    # Persist reservation so the monitoring loop can continue the sequence
    save_migration_reservation "$ISSUE" "$NEXT_MIGRATION_NUM"
    NEXT_MIGRATION_NUM=$((NEXT_MIGRATION_NUM + 1))
  fi

  # Don't set state yet - wait until user confirms
  # Save to state ledger (for tracking)
  BRANCH="task/${SLUG}"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  # Initialize with correct agent (resolve from FORCE_MODEL if set)
  initial_agent="$AGENT_CMD"
  if [[ -n "${FORCE_MODEL:-}" ]]; then
    # Validate model before proceeding
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "Invalid FORCE_MODEL: $FORCE_MODEL"
      log_error "Run 'wavemill mill' without FORCE_MODEL to use the router, or fix the model name."
      exit 1
    fi
    initial_agent="$(agent_resolve_from_model "$FORCE_MODEL")"
  fi
  save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "" "$initial_agent"

  log "  ✓ $ISSUE ready"
  LAUNCH_ARGS+=("$t")
done


# ── Phase 4: Model routing suggestions ─────────────────────────────────
if [[ -n "${FORCE_MODEL:-}" ]]; then
  log "FORCE_MODEL=$FORCE_MODEL — skipping router"
elif [[ "${ROUTER_ENABLED:-true}" == "true" ]]; then
  SUGGEST_TOOL="$TOOLS_DIR/suggest-model.ts"
  if [[ -f "$SUGGEST_TOOL" ]]; then
    log "Running model router..."
    for t in "${TASKS[@]}"; do
      IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
      PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
      if [[ -f "$PACKET_FILE" ]]; then
        SUGGESTION=$(npx tsx "$SUGGEST_TOOL" --json --file "$PACKET_FILE" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
        if [[ -n "$SUGGESTION" ]]; then
          RECOMMENDED=$(echo "$SUGGESTION" | jq -r '.recommendedModel // empty' 2>/dev/null)
          CONFIDENCE=$(echo "$SUGGESTION" | jq -r '.confidence // empty' 2>/dev/null)
          TASK_TYPE=$(echo "$SUGGESTION" | jq -r '.taskType // empty' 2>/dev/null)
          INSUFFICIENT=$(echo "$SUGGESTION" | jq -r '.insufficientData // false' 2>/dev/null)
          REASONING=$(echo "$SUGGESTION" | jq -r '.reasoning // empty' 2>/dev/null)

          RECOMMENDED_AGENT=$(echo "$SUGGESTION" | jq -r '.recommendedAgent // empty' 2>/dev/null)
          if [[ "$INSUFFICIENT" == "true" ]]; then
            log "  $ISSUE: Using default agent (insufficient eval data)"
          else
            log "  $ISSUE: Recommended: $RECOMMENDED_AGENT --model $RECOMMENDED (confidence: $CONFIDENCE, task type: $TASK_TYPE)"
          fi

          # Store recommendation for orchestrator
          echo "$SUGGESTION" > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
        fi
      fi
    done
    echo ""
  fi
fi


# ── Phase 5: Challenge-mode launch planning ──────────────────────────────
FINAL_LAUNCH_ARGS=()
slots_used=0

for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  if (( slots_used >= MAX_PARALLEL )); then
    log "  $ISSUE: Deferring launch (no remaining slots after challenge allocation)"
    remove_task_state "$ISSUE" 2>/dev/null || true
    continue
  fi
  rec_model=""
  rec_agent="$AGENT_CMD"

  if [[ -n "${FORCE_MODEL:-}" ]]; then
    rec_model="$FORCE_MODEL"
    rec_agent="$(agent_resolve_from_model "$FORCE_MODEL")"
  else
    suggestion_file="/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
    if [[ -f "$suggestion_file" ]]; then
      rec_model=$(jq -r '.recommendedModel // empty' "$suggestion_file" 2>/dev/null)
      suggestion_agent=$(jq -r '.recommendedAgent // empty' "$suggestion_file" 2>/dev/null)
      if [[ -n "$suggestion_agent" ]]; then
        rec_agent="$suggestion_agent"
      fi
    fi
  fi

  # Challengers are free overhead (don't consume a slot), so always pass
  # remaining-slots >= 2 as long as the primary slot is available.
  _rs=$((MAX_PARALLEL - slots_used))
  (( _rs < 2 )) && _rs=2
  challenge_args=(--issue "$ISSUE" --slug "$SLUG" --title "$TITLE" --repo-dir "$REPO_DIR" --remaining-slots "$_rs")
  [[ -n "$rec_model" ]] && challenge_args+=(--primary-model "$rec_model")
  challenge_plan=$(npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
  challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
  challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")

  if [[ "$challenge_mode" == "challenge" ]]; then
    primary_model=$(echo "$challenge_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
    challenger_key=$(echo "$challenge_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
    challenger_slug=$(echo "$challenge_plan" | jq -r '.entries[1].slug // empty' 2>/dev/null)
    challenger_branch=$(echo "$challenge_plan" | jq -r '.entries[1].branch // empty' 2>/dev/null)
    challenger_model=$(echo "$challenge_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
    challenger_agent=$(echo "$challenge_plan" | jq -r '.entries[1].agent // empty' 2>/dev/null)
    primary_agent=$(echo "$challenge_plan" | jq -r '.entries[0].agent // empty' 2>/dev/null)

    cp "/tmp/${SESSION}-${ISSUE}-taskpacket.md" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

    save_task_state "$ISSUE" "$SLUG" "task/${SLUG}" "${WORKTREE_ROOT}/${SLUG}" "" "" "${primary_agent:-$rec_agent}" "$ISSUE" "true" "$ISSUE" "primary" "$primary_model"
    save_task_state "$challenger_key" "$challenger_slug" "$challenger_branch" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "${challenger_agent:-$AGENT_CMD}" "$ISSUE" "true" "$ISSUE" "challenger" "$challenger_model"

    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    FINAL_LAUNCH_ARGS+=("$challenger_key|$challenger_slug|$TITLE")
    slots_used=$((slots_used + 1))  # Challenger is free overhead
    log "  $ISSUE: Challenge selected (${primary_model} vs ${challenger_model}) [challenger is extra pane]"
  else
    if [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "  $ISSUE: Challenge skipped ($challenge_reason), launching single-model run"
    fi
    save_task_state "$ISSUE" "$SLUG" "task/${SLUG}" "${WORKTREE_ROOT}/${SLUG}" "" "" "$rec_agent" "$ISSUE" "false" "" "" "$rec_model"
    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    slots_used=$((slots_used + 1))
  fi
done

LAUNCH_ARGS=("${FINAL_LAUNCH_ARGS[@]}")


# User confirmed (or no confirmation needed) - now set issues to In Progress
INITIAL_PHASE="routing"
# Legacy mode: skip routing and planning phases if autonomous
[[ "$PLANNING_MODE" == "skip" ]] && INITIAL_PHASE="executing"

for t in "${LAUNCH_ARGS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  ISSUES_IN_PROGRESS+=("$ISSUE")
  if [[ "$ISSUE" != *"__challenger" ]]; then
    linear_set_state "$ISSUE" "In Progress"
  fi
  set_task_phase "$ISSUE" "$INITIAL_PHASE"
  log "Set $ISSUE → In Progress (phase: $INITIAL_PHASE)"
done


# Find orchestrator script (should be in same directory as this script)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORCHESTRATOR="$SCRIPT_DIR/wavemill-orchestrator.sh"


if [[ ! -f "$ORCHESTRATOR" ]]; then
  echo "Error: wavemill-orchestrator.sh not found at $ORCHESTRATOR"
  exit 1
fi


# Fetch latest base branch so worktrees start from up-to-date main
log "Fetching latest $BASE_BRANCH from remote..."
git -C "$REPO_DIR" fetch origin "$BASE_BRANCH"

# Call the launcher script (don't attach yet)
# Pass state file so the dashboard can show richer info
WAVEMILL_STATE_FILE="$STATE_FILE" ORCHESTRATOR_NO_ATTACH=1 "$ORCHESTRATOR" "$SESSION" "${LAUNCH_ARGS[@]}"


# Write monitor env file (avoids long command lines in tmux pane)
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
cat > "$MONITOR_ENV" <<ENVEOF
SESSION='$SESSION'
REPO_DIR='$REPO_DIR'
WORKTREE_ROOT='$WORKTREE_ROOT'
TOOLS_DIR='$TOOLS_DIR'
LIB_DIR='$SCRIPT_DIR'
STATE_DIR='$STATE_DIR'
STATE_FILE='$STATE_FILE'
POLL_SECONDS='$POLL_SECONDS'
REQUIRE_CONFIRM='$REQUIRE_CONFIRM'
DRY_RUN='$DRY_RUN'
BASE_BRANCH='$BASE_BRANCH'
PROJECT_NAME='$PROJECT_NAME'
PLANNING_MODE='$PLANNING_MODE'
AGENT_CMD='$AGENT_CMD'
AGENT_CMD_EXPLICIT='${AGENT_CMD_EXPLICIT:-}'
ROUTER_ENABLED='${ROUTER_ENABLED:-true}'
MAX_PARALLEL='$MAX_PARALLEL'
AUTO_EVAL='$AUTO_EVAL'
ENVEOF


# Create monitoring script that will run in tmux
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/opt/homebrew/bin/bash
set -Eeuo pipefail


# Import environment from env file
source "$1"

# Logging functions - defined early so they're available for all error handling
log() { echo "$(date '+%H:%M:%S') $*"; }
log_error() { echo "$(date '+%H:%M:%S') ERROR: $*" >&2; }
log_warn() { echo "$(date '+%H:%M:%S') WARN: $*" >&2; }

# Duplicated intentionally from the parent script because the monitor runs as a
# standalone generated shell script and does not inherit parent functions.
render_prompt_template() {
  local template_path="$1"
  shift

  if [[ ! -f "$template_path" ]]; then
    log_error "Prompt template not found: $template_path"
    return 1
  fi

  local content
  content="$(cat "$template_path")"

  local pair key value
  for pair in "$@"; do
    key="${pair%%=*}"
    value="${pair#*=}"
    content="${content//\{\{$key\}\}/$value}"
  done

  printf '%s' "$content"
}

indent_block() {
  local prefix="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s%s\n' "$prefix" "$line"
  done
}

# Timeout for external API calls (Linear, GitHub) to prevent monitor freeze.
# If an API call hangs, the entire monitoring loop blocks and the user cannot
# type 'q' or select tasks.  This value caps individual calls.
API_TIMEOUT="${API_TIMEOUT:-30}"

# Run a command with a hard wall-clock timeout (works on macOS without coreutils).
# Returns at the earlier of: command completion or timeout expiry.
# Usage: _with_timeout <seconds> <command> [args...]
_with_timeout() {
  local secs=$1
  shift

  if command -v timeout &>/dev/null; then
    timeout "$secs" "$@"
    return $?
  fi
  if command -v gtimeout &>/dev/null; then
    gtimeout "$secs" "$@"
    return $?
  fi

  # Fallback: background process + fire-and-forget watchdog.
  # Redirect watchdog output to /dev/null so it doesn't hold file
  # descriptors open inside $() command substitutions.
  "$@" &
  local cmd_pid=$!
  ( sleep "$secs" && kill "$cmd_pid" 2>/dev/null ) >/dev/null 2>&1 &
  local wd_pid=$!

  # Wait ONLY for the actual command — returns as soon as it exits.
  # Do NOT wait for the watchdog: on macOS, killing the watchdog subshell
  # does not kill its child `sleep`, so `wait $wd_pid` blocks for the full
  # timeout duration even when the command finished quickly.
  wait "$cmd_pid" 2>/dev/null
  local rc=$?

  # Best-effort cleanup of the watchdog (fire-and-forget).
  kill "$wd_pid" 2>/dev/null || true

  return "$rc"
}

# Load shared agent launch adapters used by launch_task()
if [[ ! -f "$LIB_DIR/agent-adapters.sh" ]]; then
  log_error "Missing adapter library: $LIB_DIR/agent-adapters.sh"
  exit 1
fi
source "$LIB_DIR/agent-adapters.sh"

# Fail fast if required adapter functions are unavailable.
command -v agent_launch_autonomous >/dev/null 2>&1 || { log_error "agent_launch_autonomous is not defined"; exit 1; }
command -v agent_launch_interactive >/dev/null 2>&1 || { log_error "agent_launch_interactive is not defined"; exit 1; }

# Load shared functions (scoring, task packet detection)
if [[ ! -f "$LIB_DIR/wavemill-common.sh" ]]; then
  log_error "Missing common library: $LIB_DIR/wavemill-common.sh"
  exit 1
fi
source "$LIB_DIR/wavemill-common.sh"

# Ensure gh commands target the correct GitHub repo (not inherited CWD)
cd "$REPO_DIR"

# Close dashboard pane when monitor exits so quitting control is a single action.
_DASHBOARD_CLEANED=0
cleanup_dashboard_pane() {
  [[ "$_DASHBOARD_CLEANED" -eq 1 ]] && return 0
  _DASHBOARD_CLEANED=1

  tmux list-panes -t "$SESSION:control.1" >/dev/null 2>&1 || return 0
  tmux kill-pane -t "$SESSION:control.1" >/dev/null 2>&1 || true
}
trap cleanup_dashboard_pane EXIT INT TERM

# Kill entire tmux session for single-step quit.
quit_and_kill_session() {
  local message="${1:-Quitting.}"
  log "$message"

  # If running inside tmux, kill the entire session for single-step quit
  if [[ -n "${TMUX:-}" ]]; then
    # Use exec to replace current process with tmux kill-session
    # This prevents "session destroyed" message and provides clean exit
    exec tmux kill-session -t "$SESSION"
  else
    # Not in tmux (e.g., testing or direct execution) - exit normally
    exit 0
  fi
}

monitor_err_trap() {
  local rc=$?
  # Ignore SIGINT (130) and SIGTERM (143) - these are intentional user interruptions
  if [[ $rc -eq 130 || $rc -eq 143 ]]; then
    return 0
  fi
  local line="${BASH_LINENO[0]:-$LINENO}"
  log_error "Monitor command failed at line $line (exit $rc): $BASH_COMMAND"
}
trap monitor_err_trap ERR


# ============================================================================
# STATE MANAGEMENT FUNCTIONS
# ============================================================================
# These functions manage task state in the workflow state file.
# Defined inline to avoid sourcing dependencies (similar to logging functions).

save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-active}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local tmp
  tmp=$(mktemp) || { log_warn "save_task_state: mktemp failed"; return 0; }

  if jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
     --arg agent "$agent" --arg linearIssue "$linear_issue" --arg challenge "$challenge" \
     --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
     --arg challengeModel "$challenge_model" \
     '(.tasks[$issue].agent // "") as $old_agent |
      (.tasks[$issue].phase // "executing") as $old_phase |
      (.tasks[$issue].evalCompleted // false) as $old_eval |
      (.tasks[$issue].challenge // false) as $old_challenge |
      (.tasks[$issue].challengePairId // "") as $old_challenge_pair |
      (.tasks[$issue].challengeRole // "") as $old_challenge_role |
      (.tasks[$issue].challengeModel // "") as $old_challenge_model |
      (.tasks[$issue].linearIssueId // $issue) as $old_linear_issue |
      (.tasks[$issue].coderModel // "") as $old_coderModel |
      (.tasks[$issue].plannerModel // "") as $old_plannerModel |
      (.tasks[$issue].reviewerModel // "") as $old_reviewerModel |
      (.tasks[$issue].planDepth // "") as $old_planDepth |
      (.tasks[$issue].codeDepth // "") as $old_codeDepth |
      (.tasks[$issue].reviewMode // "") as $old_reviewMode |
      .tasks[$issue] = {
        slug: $slug,
        branch: $branch,
        worktree: $worktree,
        pr: $pr,
        status: $status,
        linearIssueId: (if $linearIssue != "" then $linearIssue else $old_linear_issue end),
        agent: (if $agent != "" then $agent else $old_agent end),
        challenge: (if $challenge != "" then ($challenge == "true") else $old_challenge end),
        challengePairId: (if $challengePair != "" then $challengePair else $old_challenge_pair end),
        challengeRole: (if $challengeRole != "" then $challengeRole else $old_challenge_role end),
        challengeModel: (if $challengeModel != "" then $challengeModel else $old_challenge_model end),
        coderModel: $old_coderModel,
        plannerModel: $old_plannerModel,
        reviewerModel: $old_reviewerModel,
        planDepth: $old_planDepth,
        codeDepth: $old_codeDepth,
        reviewMode: $old_reviewMode,
        phase: $old_phase,
        evalCompleted: $old_eval,
        updated: (now | todate)
      }' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "save_task_state: failed to save $issue"
  fi
}

remove_task_state() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "remove_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" 'del(.tasks[$issue]) | .updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "remove_task_state: failed to remove $issue"
  fi
}

set_task_phase() {
  local issue="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || { log_warn "set_task_phase: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "set_task_phase: failed to update $issue"
  fi
}

get_task_phase() {
  local issue="$1"
  jq -r --arg issue "$issue" '.tasks[$issue].phase // "executing"' "$STATE_FILE" 2>/dev/null
}

mark_eval_completed() {
  local issue="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "mark_eval_completed: mktemp failed"; return 0; }
  if jq --arg issue "$issue" \
     '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
     "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "mark_eval_completed: failed to update $issue"
  fi
}

validate_agent_set() {
  local issue="$1"
  local agent
  agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
  if [[ -z "$agent" ]]; then
    log_warn "  ⚠ BUG: Agent not set for $issue (should have been set at launch), auto-fixing to: $AGENT_CMD"
    # Auto-fix: update the task state with the default agent
    local slug branch worktree pr status
    slug=$(jq -r --arg i "$issue" '.tasks[$i].slug // ""' "$STATE_FILE" 2>/dev/null)
    branch=$(jq -r --arg i "$issue" '.tasks[$i].branch // ""' "$STATE_FILE" 2>/dev/null)
    worktree=$(jq -r --arg i "$issue" '.tasks[$i].worktree // ""' "$STATE_FILE" 2>/dev/null)
    pr=$(jq -r --arg i "$issue" '.tasks[$i].pr // ""' "$STATE_FILE" 2>/dev/null)
    status=$(jq -r --arg i "$issue" '.tasks[$i].status // ""' "$STATE_FILE" 2>/dev/null)
    save_task_state "$issue" "$slug" "$branch" "$worktree" "$pr" "$status" "$AGENT_CMD"
  fi
}

# Phase completion checks (must be defined inside monitor script)
check_routing_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.routing-complete" ]] && return 0
  return 1
}

check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
  return 1
}

check_coding_complete() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.coding-complete" ]] && return 0
  return 1
}

# Ensure a tmux window exists, creating it if missing (e.g. after monitor restart).
_ensure_window_exists() {
  local session="$1" win="$2" wt_dir="$3"
  if ! tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    log_warn "  Window $win missing, recreating..."
    tmux new-window -t "$session" -n "$win" -c "$wt_dir" 2>/dev/null || true
    tmux set-option -t "$session:$win" remain-on-exit on 2>/dev/null || true
    sleep 1
  fi
}

# Launch an agent in a tmux window, ensuring any previous agent is terminated first.
# This is the single point of control for all phase launches — it guarantees:
#   1. Previous agent is killed (Ctrl-C + wait for shell)
#   2. Pane is verified ready before sending commands
#   3. Agent is launched with the correct model (no LLM discretion)
#
# Args:
#   $1 = tmux session:window target
#   $2 = agent command (claude/codex)
#   $3 = model ID
#   $4 = path to prompt file
_launch_agent_in_pane() {
  local target="$1" agent_cmd="$2" model="$3" prompt_file="$4"
  local session="${target%%:*}"
  local window="${target#*:}"

  # Terminate any running agent and wait for shell prompt
  if ! agent_terminate_in_pane "$session" "$window" 15; then
    log_warn "  Timed out waiting for previous agent to exit in $target"
  fi

  # Verify pane is ready — force-kill and respawn if needed
  if ! agent_pane_is_ready "$session" "$window"; then
    log_warn "  Pane $target not ready, force-killing children..."
    local pane_pid
    pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
    if [[ -n "$pane_pid" ]]; then
      pkill -KILL -P "$pane_pid" 2>/dev/null || true
      sleep 1
    fi
    if ! agent_pane_is_ready "$session" "$window"; then
      log_warn "  Pane $target STILL not ready after force-kill, respawning pane..."
      tmux respawn-pane -k -t "$target" 2>/dev/null || true
      sleep 1
    fi
  fi

  # Launch agent with enforced model
  local model_flag=""
  [[ -n "$model" ]] && model_flag=" --model $model"
  case "$agent_cmd" in
    claude)
      tmux send-keys -t "$target" "claude${model_flag} --dangerously-skip-permissions \"\$(cat '$prompt_file')\"" C-m
      ;;
    codex)
      tmux send-keys -t "$target" "codex${model_flag} --dangerously-bypass-approvals-and-sandbox \"\$(cat '$prompt_file')\"" C-m
      ;;
    *)
      tmux send-keys -t "$target" "$agent_cmd${model_flag} \"\$(cat '$prompt_file')\"" C-m
      ;;
  esac
}

# Launch the planning phase in an existing tmux window
launch_planning_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local planner_model="$7" planner_agent="$8" plan_depth="$9"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"

  # Build planning prompt
  local prompt_file="/tmp/${SESSION}-${issue}-planning-prompt.txt"
  build_planning_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$plan_depth" > "$prompt_file"

  log "  Launching planning phase for $issue (model: $planner_model, depth: $plan_depth)"
  _launch_agent_in_pane "$SESSION:$win" "$planner_agent" "$planner_model" "$prompt_file"
}

# Launch the coding phase in an existing tmux window
launch_coding_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local coder_model="$7" coder_agent="$8" code_depth="$9"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"

  # Build coding prompt
  local prompt_file="/tmp/${SESSION}-${issue}-coding-prompt.txt"
  build_coding_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$code_depth" > "$prompt_file"

  log "  Launching coding phase for $issue (model: $coder_model, depth: $code_depth)"
  _launch_agent_in_pane "$SESSION:$win" "$coder_agent" "$coder_model" "$prompt_file"
}

# Launch the review phase in an existing tmux window
launch_review_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local reviewer_model="$7" reviewer_agent="$8" review_mode="$9"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"

  # Build review prompt
  local prompt_file="/tmp/${SESSION}-${issue}-review-prompt.txt"
  build_review_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$reviewer_model" "$review_mode" > "$prompt_file"

  log "  Launching review phase for $issue (model: $reviewer_model, mode: $review_mode)"
  _launch_agent_in_pane "$SESSION:$win" "$reviewer_agent" "$reviewer_model" "$prompt_file"
}

set_window_attention_state() {
  local win="$1" state="${2:-clear}"
  if [[ "$state" == "needs-user" ]]; then
    tmux set-window-option -t "$SESSION:$win" window-status-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    tmux set-window-option -t "$SESSION:$win" window-status-current-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  else
    tmux set-window-option -u -t "$SESSION:$win" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$SESSION:$win" window-status-current-style >/dev/null 2>&1 || true
  fi
  tmux refresh-client -S >/dev/null 2>&1 || true
}

codex_has_pending_approval() {
  local worktree="$1"
  local codex_db="$HOME/.codex/state_5.sqlite"
  [[ -n "$worktree" ]] || return 1
  [[ -f "$codex_db" ]] || return 1

  local escaped_worktree thread_row thread_id rollout_path
  escaped_worktree=${worktree//\'/\'\'}
  thread_row=$(sqlite3 "$codex_db" \
    "SELECT id || '|' || rollout_path FROM threads WHERE cwd = '$escaped_worktree' ORDER BY updated_at DESC LIMIT 1;" \
    2>/dev/null || true)
  [[ -n "$thread_row" ]] || return 1

  thread_id="${thread_row%%|*}"
  rollout_path="${thread_row#*|}"
  [[ -n "$thread_id" && -f "$rollout_path" ]] || return 1

  declare -A pending_calls=()
  local event_type call_id
  while IFS=$'\t' read -r event_type call_id; do
    [[ -n "$call_id" ]] || continue
    case "$event_type" in
      pending) pending_calls["$call_id"]=1 ;;
      resolved) unset 'pending_calls[$call_id]' ;;
    esac
  done < <(
    jq -r '
      if .type == "response_item" and .payload.type == "function_call" then
        ((.payload.arguments? // "{}") | try fromjson catch {}) as $args |
        if ($args.sandbox_permissions // "") == "require_escalated" then
          "pending\t\(.payload.call_id // "")"
        else
          empty
        end
      elif .type == "response_item" and .payload.type == "function_call_output" then
        "resolved\t\(.payload.call_id // "")"
      else
        empty
      end
    ' "$rollout_path" 2>/dev/null
  )

  (( ${#pending_calls[@]} > 0 ))
}

get_task_meta() {
  local issue="$1" field="$2"
  jq -r --arg issue "$issue" --arg field "$field" '.tasks[$issue][$field] // empty' "$STATE_FILE" 2>/dev/null
}

get_linear_issue_id() {
  local issue="$1"
  local linear_issue
  linear_issue=$(get_task_meta "$issue" "linearIssueId")
  [[ -n "$linear_issue" ]] && echo "$linear_issue" || echo "$issue"
}

should_update_linear_state() {
  local issue="$1"
  local role
  role=$(get_task_meta "$issue" "challengeRole")
  [[ "$role" != "challenger" ]]
}

is_challenge_task() {
  local issue="$1"
  [[ "$(get_task_meta "$issue" "challenge")" == "true" ]]
}

mark_challenge_compared() {
  local pair_id="$1"
  local tmp
  tmp=$(mktemp) || { log_warn "mark_challenge_compared: mktemp failed"; return 0; }
  if jq --arg pair "$pair_id" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.challengeCompared = true
      else
        .
      end
    )' "$STATE_FILE" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$STATE_FILE"
  else
    rm -f "$tmp"
    log_warn "mark_challenge_compared: failed for $pair_id"
  fi
}

maybe_run_challenge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4"
  local eval_completed pair_id solution_model linear_issue eval_agent
  eval_completed=$(jq -r --arg i "$issue" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
  [[ "$eval_completed" == "true" ]] && return 0

  pair_id=$(get_task_meta "$issue" "challengePairId")
  solution_model=$(get_task_meta "$issue" "challengeModel")
  linear_issue=$(get_linear_issue_id "$issue")
  eval_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
  [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"

  local eval_log="/tmp/${SESSION}-eval-${issue}.log"
  _with_timeout 180 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
    --issue "$linear_issue" --pr "$pr" --branch "$branch" \
    --worktree "${WORKTREE_ROOT}/${slug}" \
    --workflow-type mill --repo-dir "$REPO_DIR" \
    --agent "$eval_agent" \
    --solution-model "$solution_model" \
    --challenge-pair "$pair_id" \
    --debug \
    >"$eval_log" 2>&1 || true
  while IFS= read -r line; do log "  [challenge-eval] $line"; done < "$eval_log"
  rm -f "$eval_log"
  mark_eval_completed "$issue"
}

launch_background_post_merge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4" issue_ref="$5" reason="$6"
  local eval_agent eval_log rc

  validate_agent_set "$issue"
  eval_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
  [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"

  eval_log="/tmp/${SESSION}-eval-${issue}.log"
  : >"$eval_log"

  (
    {
      printf 'Launching %s eval in background\n' "$reason"
      if [[ -n "$pr" ]]; then
        _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --pr "$pr" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --debug
      else
        _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --debug
      fi
      rc=$?
      printf 'Eval process exited with code %s\n' "$rc"
    } >>"$eval_log" 2>&1 || true
    mark_eval_completed "$issue"
  ) >/dev/null 2>&1 &

  log "  ↳ Eval running in background; log: $eval_log"
}

maybe_run_challenge_comparison() {
  local issue="$1"
  local pair_id primary_key challenger_key compared primary_pr challenger_pr primary_eval challenger_eval linear_issue primary_model challenger_model
  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -z "$pair_id" ]] && return 0
  primary_key="$pair_id"
  challenger_key="${pair_id}__challenger"
  compared=$(jq -r --arg i "$primary_key" '.tasks[$i].challengeCompared // false' "$STATE_FILE" 2>/dev/null)
  [[ "$compared" == "true" ]] && return 0

  primary_pr=$(jq -r --arg i "$primary_key" '.tasks[$i].pr // empty' "$STATE_FILE" 2>/dev/null)
  challenger_pr=$(jq -r --arg i "$challenger_key" '.tasks[$i].pr // empty' "$STATE_FILE" 2>/dev/null)
  primary_eval=$(jq -r --arg i "$primary_key" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
  challenger_eval=$(jq -r --arg i "$challenger_key" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
  [[ -z "$primary_pr" || -z "$challenger_pr" || "$primary_eval" != "true" || "$challenger_eval" != "true" ]] && return 0

  linear_issue=$(get_linear_issue_id "$primary_key")
  primary_model=$(get_task_meta "$primary_key" "challengeModel")
  challenger_model=$(get_task_meta "$challenger_key" "challengeModel")

  # Read routing metadata for both sides
  primary_planner=$(get_task_meta "$primary_key" "plannerModel")
  primary_reviewer=$(get_task_meta "$primary_key" "reviewerModel")
  primary_plan_depth=$(get_task_meta "$primary_key" "planDepth")
  primary_code_depth=$(get_task_meta "$primary_key" "codeDepth")
  primary_review_mode=$(get_task_meta "$primary_key" "reviewMode")

  challenger_planner=$(get_task_meta "$challenger_key" "plannerModel")
  challenger_reviewer=$(get_task_meta "$challenger_key" "reviewerModel")
  challenger_plan_depth=$(get_task_meta "$challenger_key" "planDepth")
  challenger_code_depth=$(get_task_meta "$challenger_key" "codeDepth")
  challenger_review_mode=$(get_task_meta "$challenger_key" "reviewMode")

  log "  ⚖ Running challenge comparison for $pair_id"
  if _with_timeout 240 npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --primary-planner "$primary_planner" --primary-reviewer "$primary_reviewer" \
    --primary-plan-depth "$primary_plan_depth" --primary-code-depth "$primary_code_depth" --primary-review-mode "$primary_review_mode" \
    --challenger-planner "$challenger_planner" --challenger-reviewer "$challenger_reviewer" \
    --challenger-plan-depth "$challenger_plan_depth" --challenger-code-depth "$challenger_code_depth" --challenger-review-mode "$challenger_review_mode" \
    --repo-dir "$REPO_DIR" --comment >/tmp/${SESSION}-compare-${pair_id}.log 2>&1; then
    mark_challenge_compared "$pair_id"

    # Read comparison result from challenge records
    local compare_json winner winner_model rationale
    local cor_p cor_c qual_p qual_c comp_p comp_c scope_p scope_c
    local primary_eval_score challenger_eval_score
    compare_json=$(tail -1 "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" 2>/dev/null)
    winner=$(echo "$compare_json" | jq -r '.winner // empty' 2>/dev/null)
    winner_model=$(echo "$compare_json" | jq -r '.winnerModel // empty' 2>/dev/null)
    rationale=$(echo "$compare_json" | jq -r '.rationale // empty' 2>/dev/null)
    primary_eval_score=$(echo "$compare_json" | jq -r '.primaryEvalScore // "—"' 2>/dev/null)
    challenger_eval_score=$(echo "$compare_json" | jq -r '.challengerEvalScore // "—"' 2>/dev/null)
    cor_p=$(echo "$compare_json" | jq -r '.dimensions.correctness.primary // "—"' 2>/dev/null)
    cor_c=$(echo "$compare_json" | jq -r '.dimensions.correctness.challenger // "—"' 2>/dev/null)
    qual_p=$(echo "$compare_json" | jq -r '.dimensions.codeQuality.primary // "—"' 2>/dev/null)
    qual_c=$(echo "$compare_json" | jq -r '.dimensions.codeQuality.challenger // "—"' 2>/dev/null)
    comp_p=$(echo "$compare_json" | jq -r '.dimensions.completeness.primary // "—"' 2>/dev/null)
    comp_c=$(echo "$compare_json" | jq -r '.dimensions.completeness.challenger // "—"' 2>/dev/null)
    scope_p=$(echo "$compare_json" | jq -r '.dimensions.scopeDiscipline.primary // "—"' 2>/dev/null)
    scope_c=$(echo "$compare_json" | jq -r '.dimensions.scopeDiscipline.challenger // "—"' 2>/dev/null)

    # Shorten model names for display (strip date suffix)
    local disp_primary disp_challenger disp_winner
    disp_primary=$(echo "$primary_model" | sed 's/-[0-9]\{8\}$//')
    disp_challenger=$(echo "$challenger_model" | sed 's/-[0-9]\{8\}$//')
    disp_winner=$(echo "$winner_model" | sed 's/-[0-9]\{8\}$//')

    # Display formatted comparison summary
    log ""
    log "  ┌────────────────────────────────────────────────────────────┐"
    log "  │  ⚖  Challenge Comparison: $pair_id"
    log "  ├────────────────────────────────────────────────────────────┤"
    log "  │                    Primary            Challenger           │"
    log "  │  Model          $(printf '%-20s' "$disp_primary") $(printf '%-19s' "$disp_challenger")│"
    log "  │  PR              #$(printf '%-19s' "$primary_pr") #$(printf '%-18s' "$challenger_pr")│"
    log "  │  Eval Score      $(printf '%-20s' "$primary_eval_score") $(printf '%-19s' "$challenger_eval_score")│"
    log "  ├────────────────────────────────────────────────────────────┤"
    log "  │  Correctness     $(printf '%-20s' "$cor_p") $(printf '%-19s' "$cor_c")│"
    log "  │  Code Quality    $(printf '%-20s' "$qual_p") $(printf '%-19s' "$qual_c")│"
    log "  │  Completeness    $(printf '%-20s' "$comp_p") $(printf '%-19s' "$comp_c")│"
    log "  │  Scope           $(printf '%-20s' "$scope_p") $(printf '%-19s' "$scope_c")│"
    log "  ├────────────────────────────────────────────────────────────┤"
    if [[ "$winner" == "primary" ]]; then
      log "  │  ★ Winner: Primary ($disp_winner) — PR #$primary_pr"
    else
      log "  │  ★ Winner: Challenger ($disp_winner) — PR #$challenger_pr"
    fi
    log "  │                                                            │"
    # Word-wrap rationale to ~56 chars per line
    echo "$rationale" | fold -s -w 56 | while IFS= read -r rline; do
      log "  │  $(printf '%-58s' "$rline")│"
    done
    log "  └────────────────────────────────────────────────────────────┘"
    log ""

    # Determine loser for cleanup
    local loser_key loser_slug loser_pr
    if [[ "$winner" == "primary" ]]; then
      loser_key="$challenger_key"
    elif [[ "$winner" == "challenger" ]]; then
      loser_key="$primary_key"
    fi
    if [[ -n "${loser_key:-}" ]]; then
      loser_slug=$(get_task_meta "$loser_key" "slug")
      loser_pr=$(get_task_meta "$loser_key" "pr")
      if [[ -n "$loser_slug" ]]; then
        if [[ "${_CFG_CHALLENGE_AUTO_MERGE:-false}" == "true" ]]; then
          log "  ⚖ Auto-merge enabled: cleaning up losing side: $loser_key"
          # Close PR if not already closed/merged
          if [[ -n "$loser_pr" ]] && [[ "$(pr_state "$loser_pr")" == "OPEN" ]]; then
            gh pr close "$loser_pr" \
              --comment "Closing: lost challenge comparison to ${winner} side." 2>/dev/null || true
            log "  ✓ Closed losing PR #$loser_pr"
          fi
          cleanup_completed_task "$loser_key" "$loser_slug" "challenge loser"
        else
          log "  ⚖ Both PRs remain open for manual review (autoMergeWinner=false)"
        fi
      fi
    fi
  else
    while IFS= read -r line; do log_warn "  [challenge-compare] $line"; done < "/tmp/${SESSION}-compare-${pair_id}.log"
  fi
  rm -f "/tmp/${SESSION}-compare-${pair_id}.log"
}

# Archive stage artifacts from worktree before cleanup.
# Copies plan.md, task-packet.md, and routing decision to a durable location
# so post-merge eval can still access them after the worktree is removed.
#
# Args: $1 = issue ID, $2 = slug
archive_stage_artifacts() {
  local issue="$1" slug="$2"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local archive_dir="${REPO_DIR}/.wavemill/evals/artifacts/${issue}"

  [[ -d "$wt_dir" ]] || return 0

  # Create archive dir
  mkdir -p "$archive_dir" 2>/dev/null || return 0

  # Search both features/ and bugs/ dirs in the worktree
  local feature_dir=""
  for dir in features bugs; do
    if [[ -d "$wt_dir/$dir/$slug" ]]; then
      feature_dir="$wt_dir/$dir/$slug"
      break
    fi
  done

  if [[ -n "$feature_dir" ]]; then
    # Plan
    [[ -f "$feature_dir/plan.md" ]] && \
      cp "$feature_dir/plan.md" "$archive_dir/plan.md" 2>/dev/null || true

    # Task packet (full or split format)
    if [[ -f "$feature_dir/task-packet.md" ]]; then
      cp "$feature_dir/task-packet.md" "$archive_dir/task-packet.md" 2>/dev/null || true
    elif [[ -f "$feature_dir/task-packet-header.md" ]]; then
      cp "$feature_dir/task-packet-header.md" "$archive_dir/task-packet-header.md" 2>/dev/null || true
      [[ -f "$feature_dir/task-packet-details.md" ]] && \
        cp "$feature_dir/task-packet-details.md" "$archive_dir/task-packet-details.md" 2>/dev/null || true
    fi

    # Routing decision
    [[ -f "$feature_dir/.routing-complete" ]] && \
      cp "$feature_dir/.routing-complete" "$archive_dir/routing-complete.json" 2>/dev/null || true

    # Post-expansion route
    [[ -f "$feature_dir/.post-expansion-route.json" ]] && \
      cp "$feature_dir/.post-expansion-route.json" "$archive_dir/post-expansion-route.json" 2>/dev/null || true
  fi

  # Count archived files for logging
  local count
  count=$(find "$archive_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    log "  ✓ Archived $count stage artifact(s) to .wavemill/evals/artifacts/$issue/"
  fi
}

cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"

  # Archive stage artifacts before removing worktree (for eval judge attribution)
  archive_stage_artifacts "$issue" "$slug"

  # Kill tmux window (unconditional - no race condition)
  local win="$issue-$slug"
  tmux kill-window -t "$SESSION:$win" 2>/dev/null || true
  log "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    git -C "$REPO_DIR" worktree remove "$wt_dir" --force 2>/dev/null || true
    log "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch
  local task_branch="task/${slug}"
  if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    git -C "$REPO_DIR" branch -D "$task_branch" 2>/dev/null || true
    log "  ✓ Deleted branch: $task_branch"
  fi

  # Clean up state
  git -C "$REPO_DIR" worktree prune 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  # Log completion with optional reason
  if [[ -n "$completion_reason" ]]; then
    log "  ✓ Complete: $issue ($completion_reason)"
  else
    log "  ✓ Complete: $issue"
  fi
}


# ============================================================================
# GIT/GITHUB FUNCTIONS
# ============================================================================
# Functions for PR detection and merge validation.

find_pr_for_branch() {
  local branch="$1"
  _with_timeout "$API_TIMEOUT" gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || echo ""
}

pr_state() {
  local pr="$1"
  _with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state --jq '.state' 2>/dev/null || echo ""
}

validate_pr_merge() {
  local pr="$1"
  [[ -z "$pr" ]] && return 1
  local state
  state=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr" --json state --jq '.state' 2>/dev/null || echo "")
  [[ "$state" == "MERGED" ]] && return 0
  return 1
}


# ============================================================================
# LINEAR API FUNCTIONS
# ============================================================================
# Functions for updating Linear issue states.

linear_set_state() {
  local issue="$1" state="$2"
  local stderr_file rc
  stderr_file=$(mktemp) || { log_warn "Failed to update Linear state for $issue to $state (mktemp failed)"; return 0; }

  if _with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>"$stderr_file"; then
    rm -f "$stderr_file"
    return 0
  fi

  rc=$?
  if [[ -s "$stderr_file" ]]; then
    local err_line
    err_line=$(tail -n 1 "$stderr_file")
    log_warn "Failed to update Linear state for $issue to $state (exit $rc): $err_line"
  else
    log_warn "Failed to update Linear state for $issue to $state (exit $rc)"
  fi
  rm -f "$stderr_file"
  return 0
}

linear_is_completed() {
  local issue="$1"
  local raw_json issue_state
  raw_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$issue" --json 2>/dev/null || echo "{}")
  issue_state=$(echo "$raw_json" | jq -r '.state.name // ""' 2>/dev/null)
  [[ "$issue_state" == "Done" || "$issue_state" == "Completed" || "$issue_state" == "Canceled" ]]
}


# ============================================================================
# BACKLOG FETCHING & CANDIDATE SCORING
# ============================================================================

BACKLOG_CACHE=""
LAST_BACKLOG_FETCH=0
BACKLOG_CACHE_TTL=60  # seconds between backlog refreshes

fetch_candidates() {
  local now
  now=$(date +%s)

  # Use cache if fresh enough
  if (( now - LAST_BACKLOG_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$BACKLOG_CACHE" ]]; then
    echo "$BACKLOG_CACHE"
    return
  fi

  local backlog_json
  backlog_json=$(_with_timeout 60 npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>/dev/null) || true

  if [[ -z "$backlog_json" ]] || [[ "$backlog_json" == "[]" ]]; then
    BACKLOG_CACHE=""
    LAST_BACKLOG_FETCH=$now
    return
  fi

  # Use shared scoring function from wavemill-common.sh (eliminates duplication)
  # Strip has_detailed_plan (field 6) to match pick_candidates() 6-field format:
  # identifier|slug|title|area|score|blocked_by_count
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30 | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}')
  LAST_BACKLOG_FETCH=$now
  echo "$BACKLOG_CACHE"
}


# Filter out issues that are already tracked (active or cleaned)
filter_active_issues() {
  local candidates="$1"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    local cand_issue
    cand_issue=$(echo "$line" | cut -d'|' -f1)
    # Skip if already tracked
    if [[ -n "${BRANCH_BY_ISSUE[$cand_issue]:-}" ]] || [[ -n "${CLEANED[$cand_issue]:-}" ]]; then
      continue
    fi
    echo "$line"
  done <<<"$candidates"
}


# ============================================================================
# TASK LAUNCH (worktree + agent + state)
# ============================================================================
# Note: is_task_packet() is now provided by wavemill-common.sh (sourced above)

LAST_LAUNCHED_SLOTS=1

launch_task() {
  local issue="$1" slug="$2" title="$3" remaining_slots="${4:-1}"
  local branch="task/${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local linear_issue="$issue"
  local challenge_model=""
  LAST_LAUNCHED_SLOTS=1

  linear_issue=$(get_linear_issue_id "$issue")
  challenge_model=$(get_task_meta "$issue" "challengeModel")

  log "Launching $issue: $title"

  # Fetch issue details
  local issue_json
  if [[ -f "/tmp/${SESSION}-${issue}-issue.json" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  else
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    echo "$issue_json" > "/tmp/${SESSION}-${issue}-issue.json"
  fi
  local issue_desc
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Task packet handling — write raw description (agent will expand in-pane)
  local packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  if [[ -f "$packet_file" ]]; then
    :
  else
    if is_task_packet "$issue_desc"; then
      log "  ✓ $issue has task packet"
    else
      log "  ✓ $issue raw description saved (agent will expand)"
    fi
    echo "$issue_desc" > "$packet_file"
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Fetch latest base branch
  git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>/dev/null || true

  # ── Migration detection for dynamically launched tasks ──────────────
  # Detection: 1) label match  2) raw description keywords
  # Post-expansion migration detection happens in the planning agent
  local is_migration=false
  local has_migration_label
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)

  if [[ -n "$has_migration_label" ]]; then
    is_migration=true
  elif echo "$issue_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    is_migration=true
  fi

  if [[ "$is_migration" == "true" ]]; then
    # Read next migration number from state file (persisted by initial mill or prior launches)
    local next_num
    next_num=$(jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null)
    if [[ -z "$next_num" ]]; then
      # Fallback: compute from git tree
      local highest
      highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
        | grep -oE '^[0-9]+' | sort -n | tail -1)
      next_num=$(( ${highest:-0} + 1 ))
    fi

    # Append migration hint to task packet
    echo "" >> "$packet_file"
    echo "---" >> "$packet_file"
    echo "**ASSIGNED MIGRATION NUMBER**: $next_num" >> "$packet_file"
    echo "" >> "$packet_file"
    echo "Use revision='$(printf '%03d' $next_num)' in your Alembic migration file." >> "$packet_file"
    echo "CRITICAL: This number has been reserved to avoid conflicts with parallel tasks." >> "$packet_file"

    # Persist reservation so subsequent launches continue the sequence
    local _mig_tmp
    _mig_tmp=$(mktemp) || true
    if [[ -n "$_mig_tmp" ]] && jq --arg issue "$issue" --argjson num "$next_num" \
       '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
       "$STATE_FILE" > "$_mig_tmp" 2>/dev/null; then
      mv "$_mig_tmp" "$STATE_FILE"
    else
      rm -f "$_mig_tmp"
      log_warn "Failed to persist migration reservation for $issue"
    fi

    # Re-read packet content with migration hint included
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
    log "  → Migration detected, assigned number: $next_num"
  fi

  # Create worktree + branch
  local created_new=false
  if [[ -d "$wt_dir" ]]; then
    log "  Worktree exists: $wt_dir (resuming)"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    log "  Branch $branch exists, resuming"
    git -C "$REPO_DIR" worktree add "$wt_dir" "$branch"
    created_new=true
  else
    log "  Creating branch $branch from origin/$BASE_BRANCH"
    git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$BASE_BRANCH"
    created_new=true
  fi

  # Set Linear state
  if should_update_linear_state "$issue"; then
    linear_set_state "$linear_issue" "In Progress"
  fi

  # Track in monitor arrays
  BRANCH_BY_ISSUE["$issue"]="$branch"
  SLUG_BY_ISSUE["$issue"]="$slug"

  # ── Per-task model routing ──────────────────────────────────────────
  local task_agent_cmd="$AGENT_CMD"
  local task_model=""
  local planner_model="" planner_agent="" plan_depth=""
  local reviewer_model="" reviewer_agent="" review_mode=""
  local code_depth=""
  local challenge_enabled_for_launch="false"
  local challenge_pair=""
  local challenge_role
  challenge_role=$(get_task_meta "$issue" "challengeRole")
  local should_launch_challenger="false"
  local challenger_key="" challenger_slug="" challenger_title="$title"
  if [[ -n "$challenge_model" ]]; then
    task_model="$challenge_model"
    task_agent_cmd="$(agent_resolve_from_model "$task_model")"
    # Read stored routing for this challenge entry
    planner_model=$(get_task_meta "$issue" "plannerModel")
    reviewer_model=$(get_task_meta "$issue" "reviewerModel")
    plan_depth=$(get_task_meta "$issue" "planDepth")
    code_depth=$(get_task_meta "$issue" "codeDepth")
    review_mode=$(get_task_meta "$issue" "reviewMode")
    planner_agent="$(agent_resolve_from_model "${planner_model:-$task_model}")"
    reviewer_agent="$(agent_resolve_from_model "${reviewer_model:-$task_model}")"
    log "  Challenge: $task_agent_cmd --model $task_model (planner=$planner_model, reviewer=$reviewer_model)"
  elif [[ -n "${FORCE_MODEL:-}" ]]; then
    # Validate model (should have been validated earlier, but double-check)
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "  Invalid FORCE_MODEL for $issue: $FORCE_MODEL"
      log_error "  Skipping this task."
      continue
    fi
    task_model="$FORCE_MODEL"
    task_agent_cmd="$(agent_resolve_from_model "$FORCE_MODEL")"
    planner_model="$FORCE_MODEL"
    planner_agent="$task_agent_cmd"
    reviewer_model="$FORCE_MODEL"
    reviewer_agent="$task_agent_cmd"
    log "  FORCE_MODEL: $task_agent_cmd --model $task_model"
  elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]]; then
    local route_tool="$TOOLS_DIR/route-task.ts"
    if [[ "${ROUTER_ENABLED:-true}" == "true" ]] && [[ -f "$route_tool" ]] && [[ -f "$packet_file" ]]; then
      local route_json
      route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --file "$packet_file" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
      if [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner' >/dev/null 2>&1; then
        # Extract stage-specific models from workflow routing decision
        planner_model=$(echo "$route_json" | jq -r '.planner // empty' 2>/dev/null)
        task_model=$(echo "$route_json" | jq -r '.coder // empty' 2>/dev/null)
        reviewer_model=$(echo "$route_json" | jq -r '.reviewer // empty' 2>/dev/null)
        plan_depth=$(echo "$route_json" | jq -r '.planDepth // "light"' 2>/dev/null)
        code_depth=$(echo "$route_json" | jq -r '.codeDepth // "medium"' 2>/dev/null)
        review_mode=$(echo "$route_json" | jq -r '.reviewRecommended // "static"' 2>/dev/null)

        # Resolve agents for each stage
        if [[ -n "$planner_model" ]]; then
          planner_agent="$(agent_resolve_from_model "$planner_model")"
        fi
        if [[ -n "$task_model" ]]; then
          task_agent_cmd="$(agent_resolve_from_model "$task_model")"
        fi
        if [[ -n "$reviewer_model" ]]; then
          reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"
        fi

        log "  Workflow route: planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
      else
        # Fallback to single-model routing if workflow routing failed
        log "  Workflow routing unavailable, falling back to single-model routing"
        local suggest_tool="$TOOLS_DIR/suggest-model.ts"
        if [[ -f "$suggest_tool" ]]; then
          local suggestion
          suggestion=$(_with_timeout "$API_TIMEOUT" npx tsx "$suggest_tool" --json --file "$packet_file" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
          if [[ -n "$suggestion" ]]; then
            local rec_model rec_agent rec_insufficient rec_confidence rec_reasoning
            rec_model=$(echo "$suggestion" | jq -r '.recommendedModel // empty' 2>/dev/null)
            rec_agent=$(echo "$suggestion" | jq -r '.recommendedAgent // empty' 2>/dev/null)
            rec_insufficient=$(echo "$suggestion" | jq -r '.insufficientData // false' 2>/dev/null)
            rec_confidence=$(echo "$suggestion" | jq -r '.confidence // empty' 2>/dev/null)
            rec_reasoning=$(echo "$suggestion" | jq -r '.reasoning // empty' 2>/dev/null)

            # Always use recommended agent if provided
            if [[ -n "$rec_agent" ]]; then
              task_agent_cmd="$rec_agent"
            fi

            # Only gate model selection on data sufficiency
            if [[ "$rec_insufficient" != "true" ]] && [[ -n "$rec_model" ]]; then
              task_model="$rec_model"
              log "  Router: $task_agent_cmd --model $task_model (confidence: $rec_confidence)"
            elif [[ -n "$rec_model" ]]; then
              log "  Router: $task_agent_cmd --model $rec_model - $rec_reasoning"
            fi
          fi
        fi
      fi
    fi
  fi

  # Validate the selected agent exists
  if ! agent_validate "$task_agent_cmd"; then
    log_warn "  Agent '$task_agent_cmd' not found, falling back to '$AGENT_CMD'"
    task_agent_cmd="$AGENT_CMD"
    task_model=""
  fi

  # Validate planner and reviewer agents if they were set
  if [[ -n "$planner_agent" ]] && ! agent_validate "$planner_agent"; then
    log_warn "  Planner agent '$planner_agent' not found, using coder agent"
    planner_agent="$task_agent_cmd"
    planner_model="$task_model"
  fi
  if [[ -n "$reviewer_agent" ]] && ! agent_validate "$reviewer_agent"; then
    log_warn "  Reviewer agent '$reviewer_agent' not found, using coder agent"
    reviewer_agent="$task_agent_cmd"
    reviewer_model="$task_model"
  fi

  if [[ -z "${WAVEMILL_DISABLE_CHALLENGE:-}" ]] && should_update_linear_state "$issue" && (( remaining_slots >= 1 )); then
    local challenge_args challenge_plan challenge_mode challenge_reason
    # Challengers are free overhead — always pass remaining-slots >= 2
    local _dyn_rs=$remaining_slots
    (( _dyn_rs < 2 )) && _dyn_rs=2
    challenge_args=(--issue "$issue" --slug "$slug" --title "$title" --repo-dir "$REPO_DIR" --remaining-slots "$_dyn_rs")
    [[ -n "$task_model" ]] && challenge_args+=(--primary-model "$task_model")
    [[ -n "$packet_file" ]] && challenge_args+=(--file "$packet_file")
    challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
    challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
    challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
    if [[ "$challenge_mode" == "challenge" ]]; then
      challenge_enabled_for_launch="true"
      challenge_pair="$issue"
      task_model=$(echo "$challenge_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
      task_agent_cmd=$(echo "$challenge_plan" | jq -r '.entries[0].agent // empty' 2>/dev/null)

      # Extract primary routing fields
      planner_model=$(echo "$challenge_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
      reviewer_model=$(echo "$challenge_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
      plan_depth=$(echo "$challenge_plan" | jq -r '.entries[0].planDepth // "light"' 2>/dev/null)
      code_depth=$(echo "$challenge_plan" | jq -r '.entries[0].codeDepth // "medium"' 2>/dev/null)
      review_mode=$(echo "$challenge_plan" | jq -r '.entries[0].reviewMode // "static"' 2>/dev/null)

      # Extract challenger info
      challenger_key=$(echo "$challenge_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
      challenger_slug=$(echo "$challenge_plan" | jq -r '.entries[1].slug // empty' 2>/dev/null)
      challenger_model=$(echo "$challenge_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
      challenger_agent=$(echo "$challenge_plan" | jq -r '.entries[1].agent // empty' 2>/dev/null)

      # Extract challenger routing fields
      challenger_planner=$(echo "$challenge_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
      challenger_reviewer=$(echo "$challenge_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
      challenger_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[1].planDepth // "light"' 2>/dev/null)
      challenger_code_depth=$(echo "$challenge_plan" | jq -r '.entries[1].codeDepth // "medium"' 2>/dev/null)
      challenger_review_mode=$(echo "$challenge_plan" | jq -r '.entries[1].reviewMode // "static"' 2>/dev/null)

      cp "$packet_file" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

      save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "true" "$challenge_pair" "primary" "$task_model" "$planner_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"
      save_task_state "$challenger_key" "$challenger_slug" "task/${challenger_slug}" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "$challenger_agent" "$linear_issue" "true" "$challenge_pair" "challenger" "$challenger_model" "$challenger_planner" "$challenger_reviewer" "$challenger_plan_depth" "$challenger_code_depth" "$challenger_review_mode"
      should_launch_challenger="true"
      LAST_LAUNCHED_SLOTS=1  # Challenger is free overhead, doesn't consume a slot
      log "  Challenge selected (${task_model} vs ${challenger_model}) [challenger is extra pane]"
    elif [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "  Challenge skipped ($challenge_reason), launching single-model run"
    fi
  fi

  # Save to state ledger (after routing so agent is known)
  local initial_phase="executing"
  [[ "$PLANNING_MODE" == "interactive" ]] && initial_phase="planning"
  # If this task was already marked as a challenge participant (e.g. challenger
  # launched via recursive call with WAVEMILL_DISABLE_CHALLENGE=1), preserve
  # the existing challenge flag rather than overwriting with "false".
  local effective_challenge="$challenge_enabled_for_launch"
  if [[ "$effective_challenge" != "true" && -n "$challenge_role" ]]; then
    effective_challenge="true"
  fi
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "$task_model" "$planner_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"
  set_task_phase "$issue" "$initial_phase"

  # Verify agent was saved correctly (helps debug future issues)
  if [[ "${DEBUG_AGENT:-}" == "1" ]]; then
    local saved_agent
    saved_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
    if [[ "$saved_agent" != "$task_agent_cmd" ]]; then
      log_warn "  ⚠ Agent save mismatch: expected='$task_agent_cmd' but got='$saved_agent'"
    else
      log "  ✓ Agent set to: $task_agent_cmd"
    fi
  fi

  # Pre-trust worktree directory so Claude doesn't prompt
  if [[ "$task_agent_cmd" == "claude" ]] && [[ -f "$HOME/.claude.json" ]]; then
    local already_trusted
    already_trusted=$(jq -r --arg p "$wt_dir" '.projects[$p].hasTrustDialogAccepted // false' "$HOME/.claude.json" 2>/dev/null)
    if [[ "$already_trusted" != "true" ]]; then
      local _tmp
      _tmp=$(mktemp)
      if jq --arg p "$wt_dir" '
        .projects[$p] = (.projects[$p] // {}) |
        .projects[$p].hasTrustDialogAccepted = true |
        .projects[$p].hasCompletedProjectOnboarding = true
      ' "$HOME/.claude.json" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$HOME/.claude.json"
      else
        rm -f "$_tmp"
      fi
    fi
  fi

  # Create tmux window
  local win="$issue-$slug"
  tmux new-window -t "$SESSION" -n "$win" -c "$wt_dir"
  # Prevent window destruction if the pane shell exits (e.g. from a stray Ctrl-D).
  # This lets _pane_is_dead_or_idle detect and respawn dead panes during phase transitions.
  tmux set-option -t "$SESSION:$win" remain-on-exit on 2>/dev/null || true
  set_window_attention_state "$win" "clear"

  # Run setup command in new worktrees (e.g., npm install)
  if [[ -n "${SETUP_CMD:-}" ]] && [[ "$created_new" == "true" ]]; then
    log "  Running setup: $SETUP_CMD"
    local _sentinel="/tmp/.wavemill-setup-${issue//[^a-zA-Z0-9_-]/_}"
    rm -f "$_sentinel"
    tmux send-keys -t "$SESSION:$win" \
      "$SETUP_CMD && touch '$_sentinel' || touch '$_sentinel'" C-m
    local _t=0
    while [[ ! -f "$_sentinel" ]] && (( _t < 180 )); do
      sleep 2; (( _t += 2 ))
    done
    rm -f "$_sentinel"
    if (( _t >= 180 )); then
      log_warn "  Setup timed out after 180s, proceeding anyway"
    else
      log "  Setup complete"
    fi
  fi

  # ── Build issue context and launch agent ──────────────────────────────
  # Prompt assembly uses shared builders in agent-adapters.sh (single
  # source of truth shared with wavemill-orchestrator.sh).

  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  local details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
  local details_context=""

  # Copy details file to worktree and build details context string
  if [[ -f "$details_file" ]]; then
    if [[ "$PLANNING_MODE" == "interactive" ]]; then
      local feature_dir="$wt_dir/features/$slug"
      mkdir -p "$feature_dir"
      cp "$details_file" "$feature_dir/task-packet-details.md"
      # Also persist header for eval artifact discovery (HOK-1033)
      local header_source="/tmp/${SESSION}-${issue}-taskpacket.md"
      if [[ -f "$header_source" ]]; then
        cp "$header_source" "$feature_dir/task-packet-header.md"
      fi
      details_context="
📖 Full Details: Comprehensive task packet with all 9 sections available at:
   features/$slug/task-packet-details.md

Read specific sections on-demand as you plan and implement:
- Section 1: Complete Objective & Scope
- Section 2: Technical Context (dependencies, architecture)
- Section 3: Implementation Approach (step-by-step)
- Section 4: Success Criteria (all requirements with [REQ-FX] tags)
- Section 5: Implementation Constraints (all rules)
- Section 6: Validation Steps (concrete test scenarios)
- Section 7: Definition of Done
- Section 8: Rollback Plan
- Section 9: Proposed Labels"
    else
      cp "$details_file" "$wt_dir/task-packet-details.md"
      # Also persist header for eval artifact discovery (HOK-1033)
      local header_source="/tmp/${SESSION}-${issue}-taskpacket.md"
      if [[ -f "$header_source" ]]; then
        cp "$header_source" "$wt_dir/task-packet-header.md"
      fi
      details_context="
📖 Full Details: Read task-packet-details.md in the repo root for:
- Complete implementation approach (Section 3)
- All success criteria with [REQ-FX] tags (Section 4)
- Concrete validation steps with test scenarios (Section 6)
- Implementation constraints and rules (Section 5)"
    fi
  fi

  local issue_context
  if [[ -n "$packet_content" ]]; then
    issue_context="Issue Description (Brief Overview):
$packet_content
$details_context"
  elif [[ -n "$details_context" ]]; then
    issue_context="$details_context"
  else
    issue_context="NOTE: Task packet details file was not pre-seeded in this worktree.
Implement from the issue description plus direct codebase analysis."
  fi

  if [[ "$PLANNING_MODE" == "interactive" ]]; then
    # Launch in routing phase - monitor will handle phase transitions
    local feature_dir="${feature_dir:-$wt_dir/features/$slug}"
    mkdir -p "$feature_dir"
    local labels_json="[]"
    labels_json=$(echo "$issue_json" | jq '[.labels.nodes[]?.name // empty]' 2>/dev/null || echo "[]")

    jq -n \
      --arg taskId "$issue" \
      --arg title "$title" \
      --arg description "$packet_content" \
      --argjson labels "$labels_json" \
      --arg featureName "$slug" \
      --arg contextPath "features/$slug/selected-task.json" \
      '{
        taskId: $taskId,
        title: $title,
        description: $description,
        labels: $labels,
        workflowType: "feature",
        featureName: $featureName,
        contextPath: $contextPath,
        selectedAt: (now | todate)
      }' > "$feature_dir/selected-task.json"

    # Write routing results directly (no LLM needed — routing is deterministic)
    # The routing tool was already called at lines above (route-task.ts).
    # We just need to write the .routing-complete file and launch planning.
    local routing_file="$feature_dir/.routing-complete"
    jq -n \
      --arg planner "${planner_model:-claude-sonnet-4-5-20250929}" \
      --arg coder "${task_model:-claude-opus-4-6}" \
      --arg reviewer "${reviewer_model:-claude-sonnet-4-5-20250929}" \
      --arg planDepth "${plan_depth:-light}" \
      --arg codeDepth "${code_depth:-medium}" \
      --arg reviewMode "${review_mode:-static}" \
      '{
        planner: $planner,
        coder: $coder,
        reviewer: $reviewer,
        planDepth: $planDepth,
        codeDepth: $codeDepth,
        reviewMode: $reviewMode
      }' > "$routing_file"

    # Save initial route for eval comparison (routed on raw description)
    cp "$routing_file" "$feature_dir/.initial-route.json"

    # Launch planning phase directly with the routed model (skip routing agent)
    local resolved_planner_agent
    resolved_planner_agent="$(agent_resolve_from_model "${planner_model:-claude-sonnet-4-5-20250929}")"
    launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
      "${planner_model:-claude-sonnet-4-5-20250929}" "$resolved_planner_agent" "${plan_depth:-light}"
    log "  ✓ Routing complete (direct), launched planning with ${planner_model:-claude-sonnet-4-5-20250929}"
  else
    local instr_file="/tmp/${SESSION}-${issue}-instructions.txt"
    build_autonomous_prompt "$title" "$issue" "$wt_dir" "$branch" "$BASE_BRANCH" \
      "$issue_context" "$status_file" "$TOOLS_DIR" "$reviewer_model" "$review_mode" > "$instr_file"

    # Use coder model for implementation phase
    agent_launch_autonomous "$SESSION" "$win" "$instr_file" "$task_agent_cmd" "$task_model"
  fi

  log "  ✓ $issue launched (phase: ${initial_phase}, agent: ${task_agent_cmd}${task_model:+ --model $task_model})"
  [[ -n "$planner_model" ]] && log "  ✓ Routing: planner=$planner_model, coder=$task_model, reviewer=$reviewer_model"

  if [[ "$should_launch_challenger" == "true" ]]; then
    WAVEMILL_DISABLE_CHALLENGE=1 launch_task "$challenger_key" "$challenger_slug" "$challenger_title" 0
  fi
}


# ============================================================================
# MAIN MONITORING LOOP
# ============================================================================

# Parse initial tasks from file
declare -A PR_BY_ISSUE BRANCH_BY_ISSUE SLUG_BY_ISSUE CLEANED

# Rehydrate tracked tasks from persisted state first so restarts continue
# monitoring prior in-flight issues.
if [[ -f "$STATE_FILE" ]]; then
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r ISSUE SLUG BRANCH PR <<<"$line"
    [[ -z "$ISSUE" ]] && continue

    if [[ -z "$SLUG" && -n "$BRANCH" ]]; then
      SLUG="${BRANCH#task/}"
    fi
    if [[ -z "$BRANCH" && -n "$SLUG" ]]; then
      BRANCH="task/${SLUG}"
    fi

    [[ -z "$SLUG" || -z "$BRANCH" ]] && continue
    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    [[ -n "$PR" ]] && PR_BY_ISSUE["$ISSUE"]="$PR"
  done < <(jq -r '.tasks | to_entries[] | "\(.key)|\(.value.slug // "")|\(.value.branch // "")|\(.value.pr // "")"' "$STATE_FILE" 2>/dev/null)
fi

# Overlay tasks selected in this launch.
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  IFS='|' read -r ISSUE SLUG TITLE <<<"$line"
  [[ -z "$ISSUE" || -z "$SLUG" ]] && continue
  BRANCH_BY_ISSUE["$ISSUE"]="task/${SLUG}"
  SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
done < "$TASKS_FILE"


log "Monitoring tasks and managing work queue..."
[[ "$PLANNING_MODE" == "interactive" ]] && log "  Planning mode: interactive (watching for plan approval)"
log "  Max parallel: $MAX_PARALLEL"
log "  Checking every ${POLL_SECONDS}s"
log "  Type 'q' to quit, or 'touch $STATE_DIR/.stop-loop' to stop"
echo ""

QUIT_REQUESTED=false
LAST_DISPLAY=""       # fingerprint of what was last printed
LAST_ACTIVE_COUNT=-1  # force first render
LAST_WAITING_MSG=""   # track last waiting message to avoid repetition

monitor_issue_state() {
  local ISSUE="$1"
  local BRANCH SLUG PR
  local task_status WIN WT_DIR task_branch current_phase eval_agent debug_flag current_agent needs_attention

  BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
  SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
  PR="${PR_BY_ISSUE[$ISSUE]:-}"
  WIN="$ISSUE-$SLUG"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
  needs_attention="false"

  # If already merged or completed-external (requireConfirm), wait for window close then cleanup
  task_status=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].status // empty' "$STATE_FILE" 2>/dev/null)
  if [[ "$task_status" == "merged" || "$task_status" == "completed-external" ]]; then
    set_window_attention_state "$WIN" "clear"
    if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
      active_count=$((active_count + 1))
      return 0
    fi

    cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"

    # Prune worktrees after cleanup
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    return 0
  fi

  # Check if PR exists
  if [[ -z "$PR" ]]; then
    PR="$(find_pr_for_branch "$BRANCH")"
    if [[ -n "$PR" ]]; then
      PR_BY_ISSUE["$ISSUE"]="$PR"
      # Preserve agent when updating with PR number
      current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
      linear_issue=$(get_linear_issue_id "$ISSUE")
      challenge_flag=$(get_task_meta "$ISSUE" "challenge")
      challenge_pair=$(get_task_meta "$ISSUE" "challengePairId")
      challenge_role=$(get_task_meta "$ISSUE" "challengeRole")
      challenge_model=$(get_task_meta "$ISSUE" "challengeModel")
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "" "$current_agent" "$linear_issue" "$challenge_flag" "$challenge_pair" "$challenge_role" "$challenge_model"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$linear_issue" "In Review"
      fi
      # Fetch PR details for user-visible summary
      pr_details=$(_with_timeout "$API_TIMEOUT" gh pr view "$PR" --json title,url --jq '"  " + .title + "\n  " + .url' 2>/dev/null || echo "")
      log "✓ $ISSUE → PR #$PR (In Review)"
      if [[ -n "$pr_details" ]]; then
        log "$pr_details"
      fi

      if is_challenge_task "$ISSUE"; then
        maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
        maybe_run_challenge_comparison "$ISSUE"
      fi
    else
      # No PR in current repo - check Linear issue state for cross-repo completion
      if should_update_linear_state "$ISSUE" && linear_is_completed "$(get_linear_issue_id "$ISSUE")"; then
        log "✓ $ISSUE → Completed externally (cross-repo or manual)"
        set_window_attention_state "$WIN" "clear"

        # Post-completion eval (non-blocking: always exits 0)
        if [[ "$AUTO_EVAL" == "true" ]]; then
          eval_completed=$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
          if [[ "$eval_completed" == "false" ]]; then
            log "  📊 Running post-completion eval..."
            launch_background_post_merge_eval "$ISSUE" "" "$BRANCH" "$SLUG" "$ISSUE" "post-completion"
          else
            log "  ✓ Eval already completed for $ISSUE"
          fi
        fi

        if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
          log "  → Window stays open for review - close it when ready"
          if should_update_linear_state "$ISSUE"; then
            linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
          fi
          # Preserve agent when marking as completed-external
          current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "" "completed-external" "$current_agent"
          active_count=$((active_count + 1))
          return 0
        fi

        # Clean up worktree and state
        if should_update_linear_state "$ISSUE"; then
          linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
        fi
        cleanup_completed_task "$ISSUE" "$SLUG" "external completion"
        return 0
      fi

      # Multi-phase workflow tracking (must run before pane-alive early return)
      current_phase=$(get_task_phase "$ISSUE")

      case "$current_phase" in
        routing)
          if check_routing_complete "$SLUG"; then
            # Read routing results
            routing_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.routing-complete"
            if [[ -f "$routing_file" ]]; then
              # Validate JSON before parsing
              if ! jq empty "$routing_file" 2>/dev/null; then
                log_warn "$ISSUE → Routing file contains invalid JSON, using defaults"
                planner_model="claude-sonnet-4-5-20250929"
                coder_model="claude-opus-4-6"
                reviewer_model="claude-sonnet-4-5-20250929"
                plan_depth="light"
                code_depth="medium"
                review_mode="static"
              else
                planner_model=$(jq -r '.planner // "claude-sonnet-4-5-20250929"' "$routing_file" 2>/dev/null || echo "claude-sonnet-4-5-20250929")
                coder_model=$(jq -r '.coder // "claude-opus-4-6"' "$routing_file" 2>/dev/null || echo "claude-opus-4-6")
                reviewer_model=$(jq -r '.reviewer // "claude-sonnet-4-5-20250929"' "$routing_file" 2>/dev/null || echo "claude-sonnet-4-5-20250929")
                plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
              fi

              # Save routing results to state
              current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
              linear_issue=$(get_linear_issue_id "$ISSUE")
              save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "" "" "$current_agent" "$linear_issue" "" "" "" "" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"

              # Transition to planning phase
              set_task_phase "$ISSUE" "planning"
              planner_agent="$(agent_resolve_from_model "$planner_model")"

              # Get title from state or Linear
              title=$(jq -r --arg i "$ISSUE" '.tasks[$i].title // ""' "$STATE_FILE" 2>/dev/null)
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              launch_planning_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$planner_model" "$planner_agent" "$plan_depth"
              set_window_attention_state "$WIN" "clear"
              log "✓ $ISSUE → Routing complete, launching planning phase"
              active_count=$((active_count + 1))
              return 0
            else
              log_warn "$ISSUE → Routing file missing: $routing_file"
              needs_attention="true"
            fi
          else
            if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
              set_window_attention_state "$WIN" "clear"
              # Keep routing tasks active while agent is still running
              active_count=$((active_count + 1))
              return 0
            fi
            needs_attention="true"
          fi
          ;;

        planning)
          # Late migration detection: agent writes .migration-detected after expanding
          local mig_marker="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-detected"
          local mig_num_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-number"
          if [[ -f "$mig_marker" ]] && [[ ! -f "$mig_num_file" ]]; then
            # Check if reservation already exists
            local existing_reservation
            existing_reservation=$(jq -r --arg i "$ISSUE" '.migrationReservations[$i] // empty' "$STATE_FILE" 2>/dev/null)
            if [[ -z "$existing_reservation" ]]; then
              local next_num
              next_num=$(jq -r '.nextMigrationNum // empty' "$STATE_FILE" 2>/dev/null)
              if [[ -z "$next_num" ]]; then
                local highest
                highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
                  | grep -oE '^[0-9]+' | sort -n | tail -1)
                next_num=$(( ${highest:-0} + 1 ))
              fi
              echo "$next_num" > "$mig_num_file"
              save_migration_reservation "$ISSUE" "$next_num"
              log "  → Late migration detected for $ISSUE, assigned number: $next_num"
            else
              echo "$existing_reservation" > "$mig_num_file"
            fi
          fi

          if check_plan_approved "$SLUG"; then
            # Read routing results from state (stored during routing → planning transition)
            coder_model=$(get_task_meta "$ISSUE" "coderModel")
            # For challenge tasks, the challenge model MUST override the routed coder
            challenge_coder=$(get_task_meta "$ISSUE" "challengeModel")
            if [[ -n "$challenge_coder" ]]; then
              coder_model="$challenge_coder"
            fi
            [[ -z "$coder_model" ]] && coder_model="claude-opus-4-6"
            code_depth=$(get_task_meta "$ISSUE" "codeDepth")
            [[ -z "$code_depth" ]] && code_depth="medium"

            # Transition to coding phase
            set_task_phase "$ISSUE" "coding"
            coder_agent="$(agent_resolve_from_model "$coder_model")"

            # Get title
            title=$(jq -r --arg i "$ISSUE" '.tasks[$i].title // ""' "$STATE_FILE" 2>/dev/null)
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            launch_coding_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$coder_model" "$coder_agent" "$code_depth"
            set_window_attention_state "$WIN" "clear"
            log "✓ $ISSUE → Plan approved, launching coding phase"
            active_count=$((active_count + 1))
            return 0
          else
            if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
              set_window_attention_state "$WIN" "clear"
              # Keep unapproved planning tasks active while agent is still running
              active_count=$((active_count + 1))
              return 0
            fi
            needs_attention="true"
          fi
          ;;

        coding)
          if check_coding_complete "$SLUG"; then
            # Read routing results from state
            reviewer_model=$(get_task_meta "$ISSUE" "reviewerModel")
            [[ -z "$reviewer_model" ]] && reviewer_model="claude-sonnet-4-5-20250929"
            review_mode=$(get_task_meta "$ISSUE" "reviewMode")
            [[ -z "$review_mode" ]] && review_mode="static"

            # Transition to review phase
            set_task_phase "$ISSUE" "review"
            reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"

            # Get title
            title=$(jq -r --arg i "$ISSUE" '.tasks[$i].title // ""' "$STATE_FILE" 2>/dev/null)
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            launch_review_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$reviewer_model" "$reviewer_agent" "$review_mode"
            set_window_attention_state "$WIN" "clear"
            log "✓ $ISSUE → Coding complete, launching review phase"
            active_count=$((active_count + 1))
            return 0
          else
            if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
              set_window_attention_state "$WIN" "clear"
              # Keep coding tasks active while agent is still running
              active_count=$((active_count + 1))
              return 0
            fi
            needs_attention="true"
          fi
          ;;

        review)
          # Review phase is complete when PR is created (handled above)
          if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
            set_window_attention_state "$WIN" "clear"
            # Keep review tasks active while agent is still running
            active_count=$((active_count + 1))
            return 0
          fi
          # Agent exited but no PR - might need attention
          needs_attention="true"
          ;;

        executing)
          # Legacy autonomous mode - no phase transitions
          if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
          ;;
      esac

      if [[ "$current_agent" == "codex" ]] && codex_has_pending_approval "$WT_DIR"; then
        needs_attention="true"
      fi

      if [[ "$needs_attention" == "true" ]]; then
        set_window_attention_state "$WIN" "needs-user"
      else
        set_window_attention_state "$WIN" "clear"
      fi

      # Not completed externally - check if agent pane is still alive
      if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
        # Pane still running - agent is working, keep slot active
        active_count=$((active_count + 1))
        return 0
      fi

      # Check if the pane is dead but window still exists (remain-on-exit).
      # Respawn and re-launch the current phase instead of cleaning up.
      if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
        log "⚠ $ISSUE → Pane died during $current_phase phase, respawning..."
        tmux respawn-pane -t "$SESSION:$WIN" 2>/dev/null || true
        sleep 1
        active_count=$((active_count + 1))
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      # Window itself is gone (shouldn't happen with remain-on-exit, but
      # handle gracefully). Flag for attention instead of cleaning up
      # immediately — the worktree and branch still have value.
      if ! tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qF "$WIN"; then
        log "⚠ $ISSUE → Window disappeared during $current_phase phase, recreating..."
        tmux new-window -t "$SESSION" -n "$WIN" -c "${WORKTREE_ROOT}/${SLUG}" 2>/dev/null || true
        tmux set-option -t "$SESSION:$WIN" remain-on-exit on 2>/dev/null || true
        sleep 1
        active_count=$((active_count + 1))
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      # Agent exited without creating a PR - clean up the slot
      set_window_attention_state "$WIN" "clear"
      log "⚠ $ISSUE → Agent exited without PR - releasing slot"
      cleanup_completed_task "$ISSUE" "$SLUG" "no PR created"
      return 0
    fi
  fi

  # Check if merged
  if validate_pr_merge "$PR"; then
    log "✓ $ISSUE → PR #$PR MERGED"
    set_window_attention_state "$WIN" "clear"

    # Post-merge eval (non-blocking: always exits 0)
    if [[ "$AUTO_EVAL" == "true" ]]; then
      eval_completed=$(jq -r --arg i "$ISSUE" '.tasks[$i].evalCompleted // false' "$STATE_FILE" 2>/dev/null)
      if [[ "$eval_completed" == "false" ]]; then
        log "  📊 Running post-merge eval..."
        launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge"
      else
        log "  ✓ Eval already completed for $ISSUE"
      fi
    fi

    if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
      log "  → Window stays open for review - close it when ready"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
      fi
      # Preserve agent when marking as merged
      current_agent=$(jq -r --arg i "$ISSUE" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "merged" "$current_agent"
      active_count=$((active_count + 1))
      return 0
    fi

    if should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
    fi
    cleanup_completed_task "$ISSUE" "$SLUG"
  elif [[ "$(pr_state "$PR")" == "CLOSED" ]]; then
    log_warn "$ISSUE → PR #$PR CLOSED without merge"
    if should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "Backlog"
    fi
    CLEANED["$ISSUE"]=1
  else
    # PR open but not merged — re-check challenge eval and comparison
    # in case the eval was missed on initial PR detection (e.g. challenge
    # flag was incorrect when PR was first found)
    if is_challenge_task "$ISSUE"; then
      maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
      maybe_run_challenge_comparison "$ISSUE"
    fi
    active_count=$((active_count + 1))
  fi

  return 0
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  active_count=0
  active_challenger_count=0

  for ISSUE in "${!BRANCH_BY_ISSUE[@]}"; do
    [[ -n "${CLEANED[$ISSUE]:-}" ]] && continue
    set +e
    monitor_issue_state "$ISSUE"
    issue_rc=$?
    set -e
    if (( issue_rc != 0 )); then
      log_warn "$ISSUE → Monitor step failed (exit $issue_rc). Keeping slot active."
      active_count=$((active_count + 1))
    fi
    # Track active challengers separately (they are free overhead for slot counting)
    _cr=$(jq -r --arg i "$ISSUE" '.tasks[$i].challengeRole // ""' "$STATE_FILE" 2>/dev/null || echo "")
    if [[ "$_cr" == "challenger" ]] && [[ -z "${CLEANED[$ISSUE]:-}" ]]; then
      active_challenger_count=$((active_challenger_count + 1))
    fi
  done

  # ── Phase B: Check for stop signal ──────────────────────────────────
  if [[ -f "$STATE_DIR/.stop-loop" ]]; then
    if (( active_count == 0 )); then
      rm -f "$STATE_DIR/.stop-loop"
      quit_and_kill_session "Stop signal detected and all tasks complete. Exiting."
    fi
    log "Stop signal detected. Finishing $active_count active task(s)..."
    sleep "$POLL_SECONDS"
    continue
  fi

  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      quit_and_kill_session "All tasks complete. Exiting."
    fi
    # Still have active tasks — keep monitoring but don't offer new ones
    sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  # Challengers are free overhead — don't count them against MAX_PARALLEL
  free_slots=$((MAX_PARALLEL - (active_count - active_challenger_count)))

  if (( free_slots > 0 )); then
    candidates=$(fetch_candidates)

    if [[ -n "$candidates" ]]; then
      available=$(filter_active_issues "$candidates")

      if [[ -n "$available" ]]; then
        # Split into unblocked and blocked
        # Field 6 is blocked_by_count (has_detailed_plan stripped by fetch_candidates)
        avail_unblocked=$(echo "$available" | awk -F'|' '$6 == 0 || $6 == ""')
        avail_blocked=$(echo "$available" | awk -F'|' '$6 > 0')
        avail_blocked_count=0
        [[ -n "$avail_blocked" ]] && avail_blocked_count=$(echo "$avail_blocked" | grep -c .)

        # Only re-render the prompt when the display would actually change
        display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          echo ""
          log "$free_slots slot(s) available. Next tasks:"
          if [[ -n "$avail_unblocked" ]]; then
            echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
          else
            echo "  (no unblocked tasks)"
          fi
          if (( avail_blocked_count > 0 )); then
            echo ""
            echo "  ($avail_blocked_count blocked task(s) hidden — enter 'm' to show all)"
          fi
          echo ""
          if (( avail_blocked_count > 0 )); then
            echo "Enter number(s) to start (e.g. 1 3), 'm' for more, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          else
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          fi
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
          LAST_WAITING_MSG=""  # Clear waiting state when tasks are available
        fi

        # Default: selection against unblocked list only
        select_from="$avail_unblocked"

        if read -t "$POLL_SECONDS" -r REPLY; then
          # Strip ANSI escape sequences (e.g. arrow keys buffered during wait)
          REPLY=$(printf '%s' "$REPLY" | LC_ALL=C tr -d '\033' | sed 's/\[[A-Za-z0-9;]*//g')

          # Handle 'm' to show all tasks including blocked
          if [[ "$REPLY" =~ ^[mM] ]]; then
            all_avail=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
            echo ""
            log "$free_slots slot(s) available. All tasks:"
            ln=0
            while IFS= read -r mline; do
              ln=$((ln + 1))
              IFS='|' read -r mid mslug mtitle marea mscore mblocked <<<"$mline"
              if (( mblocked > 0 )); then
                printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$ln" "$mid" "$mtitle" "$mscore"
              else
                printf "  %s. %s - %s (score: %.0f)\n" "$ln" "$mid" "$mtitle" "$mscore"
              fi
            done <<<"$all_avail"
            echo ""
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
            select_from="$all_avail"
            # Re-read for actual selection
            if read -t "$POLL_SECONDS" -r REPLY; then
              REPLY=$(printf '%s' "$REPLY" | LC_ALL=C tr -d '\033' | sed 's/\[[A-Za-z0-9;]*//g')
            else
              REPLY=""
            fi
          fi

          if [[ "$REPLY" =~ ^[Qq] ]]; then
            if (( active_count == 0 )); then
              quit_and_kill_session "Quitting."
            elif [[ "$QUIT_REQUESTED" == "true" ]]; then
              quit_and_kill_session "Force quitting ($active_count task(s) still active)."
            else
              log "Will quit after $active_count active task(s) finish. Press q again to force quit."
              QUIT_REQUESTED=true
            fi
          elif [[ -n "$REPLY" ]]; then
            # Parse user selection and launch tasks (up to free_slots)
            launched=0
            for n in $REPLY; do
              # Validate n is a positive integer to prevent sed injection
              if ! [[ "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then
                log_warn "Invalid selection: $n (must be a number)"
                continue
              fi
              if (( launched >= free_slots )); then
                log_warn "No more free slots — skipping remaining selections"
                break
              fi
              local_line=$(echo "$select_from" | sed -n "${n}p")
              if [[ -z "$local_line" ]]; then
                log_warn "Invalid selection: $n"
                continue
              fi
              IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
              launch_task "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
              launched=$((launched + LAST_LAUNCHED_SLOTS))
            done
            # Invalidate caches after launching so next cycle re-renders
            LAST_BACKLOG_FETCH=0
            LAST_DISPLAY=""
            LAST_WAITING_MSG=""  # Clear waiting state
          fi
          # User pressed Enter with no input — just continue monitoring
        fi
        # read timed out — continue monitoring
      else
        # All candidates are already active
        if (( active_count == 0 )); then
          waiting_msg="No new tasks available. Waiting... (type 'q' to quit)"
          if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
            log "$waiting_msg"
            LAST_WAITING_MSG="$waiting_msg"
          fi
          if read -t "$POLL_SECONDS" -r REPLY; then
            [[ "$REPLY" =~ ^[Qq] ]] && quit_and_kill_session
          fi
        else
          sleep "$POLL_SECONDS"
        fi
      fi
    else
      # Backlog empty
      if (( active_count == 0 )); then
        waiting_msg="Backlog empty. Waiting for new tasks... (type 'q' to quit)"
        if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
          log "$waiting_msg"
          LAST_WAITING_MSG="$waiting_msg"
        fi
        # Invalidate cache so we re-fetch next cycle
        LAST_BACKLOG_FETCH=0
        if read -t "$POLL_SECONDS" -r REPLY; then
          [[ "$REPLY" =~ ^[Qq] ]] && quit_and_kill_session
        fi
      else
        sleep "$POLL_SECONDS"
      fi
    fi
  else
    # All slots full — just monitor
    sleep "$POLL_SECONDS"
  fi
done
MONITOR_EOF


chmod +x "$MONITOR_SCRIPT"


# Launch monitor in control window's first pane
log "Starting monitoring in tmux control window..."


# Write tasks to temp file and add to env
TASKS_FILE="/tmp/${SESSION}-tasks.txt"
printf '%s\n' "${LAUNCH_ARGS[@]}" > "$TASKS_FILE"
echo "TASKS_FILE='$TASKS_FILE'" >> "$MONITOR_ENV"


tmux send-keys -t "$SESSION:control.0" "clear && '$MONITOR_SCRIPT' '$MONITOR_ENV'" C-m


# Now attach to the session
log "Attaching to session: $SESSION"
log "  Ctrl+B then W to switch windows"
log "  Ctrl+B then D to detach"
log "  Type 'q' in control window to quit"
log "  Or: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
tmux attach -t "$SESSION"

log "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
