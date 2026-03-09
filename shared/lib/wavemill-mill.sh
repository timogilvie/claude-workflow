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
  local tmp
  tmp=$(mktemp) || { log_warn "save_task_state: mktemp failed"; return 0; }
  if jq --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" --arg agent "$agent" \
     --arg linearIssue "$linear_issue" --arg challenge "$challenge" --arg challengePair "$challenge_pair" \
     --arg challengeRole "$challenge_role" --arg challengeModel "$challenge_model" \
     '.tasks[$issue] = (.tasks[$issue] // {}) + {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, linearIssueId: $linearIssue, updated: (now | todate)}
      | if $agent != "" then .tasks[$issue].agent = $agent else . end
      | if $challenge != "" then .tasks[$issue].challenge = ($challenge == "true") else . end
      | if $challengePair != "" then .tasks[$issue].challengePairId = $challengePair else . end
      | if $challengeRole != "" then .tasks[$issue].challengeRole = $challengeRole else . end
      | if $challengeModel != "" then .tasks[$issue].challengeModel = $challengeModel else . end' \
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


check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
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
  if retry npx tsx "$TOOLS_DIR/get-issue-json.ts" "$1" 2>"$stderr_file"; then
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
    local slug branch worktree pr
    slug=$(echo "$task_json" | jq -r '.slug')
    branch=$(echo "$task_json" | jq -r '.branch')
    worktree=$(echo "$task_json" | jq -r '.worktree')
    pr=$(echo "$task_json" | jq -r '.pr // empty')

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
EXPANSION_NEEDED=false


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


# ── Phase 2: Expand task packets in parallel ──────────────────────────────
# When planningMode=interactive, skip expansion — the agent will research
# the codebase itself during the interactive planning session.
EXPAND_PIDS=()
EXPAND_ISSUES=()

if [[ "$PLANNING_MODE" == "interactive" ]]; then
  log "  Skipping task packet expansion (planningMode=interactive)"
  # Still write raw descriptions to packet files so the orchestrator
  # can use them for the selected-task.json context
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
    echo "$current_desc" > "$PACKET_FILE"
    log "  ✓ $ISSUE raw description saved"
  done
else
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

    if is_task_packet "$current_desc"; then
      log "  ✓ $ISSUE has task packet"
      echo "$current_desc" > "$PACKET_FILE"
    else
      log "  ⚠ $ISSUE needs expansion - launching..."
      EXPANSION_NEEDED=true
      (
        write_task_packet "$ISSUE" "$PACKET_FILE"
      ) > "/tmp/${SESSION}-${ISSUE}-expand.log" 2>&1 &
      EXPAND_PIDS+=("$!")
      EXPAND_ISSUES+=("$ISSUE")
    fi
  done
fi

EXPANSION_FAILED=false
if (( ${#EXPAND_PIDS[@]} > 0 )); then
  log "Expanding ${#EXPAND_PIDS[@]} issue(s) in parallel..."
  for i in "${!EXPAND_PIDS[@]}"; do
    if wait "${EXPAND_PIDS[$i]}"; then
      log "  ✓ ${EXPAND_ISSUES[$i]} expanded"
    else
      log_warn "  ✗ ${EXPAND_ISSUES[$i]} expansion failed (see /tmp/${SESSION}-${EXPAND_ISSUES[$i]}-expand.log)"
      EXPANSION_FAILED=true
    fi
  done
fi


# ── Phase 3: Migration detection + state saving ──────────────────────────
for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
  current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Check if task involves database migration
  # Detection order: 1) label match  2) keyword in expanded task packet  3) keyword in raw description
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)
  packet_text=$(cat "$PACKET_FILE" 2>/dev/null || echo "")
  is_migration=false

  if [[ -n "$has_migration_label" ]]; then
    log "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$packet_text" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration\|add.*column.*table\|create.*table\|alter.*table"; then
    log "  → Migration detected (task packet keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
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


# Warn if expansion failed
if [[ "$EXPANSION_FAILED" == "true" ]]; then
  echo ""
  log_warn "Some issues failed to expand. Consider running /issue-writer on them first:"
  log_warn "  See: skills/issue-writer/SKILL.md"
  echo ""
  if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
    if ! confirm "Continue anyway?"; then
      # User declined - clean up state ledger for these issues
      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        remove_task_state "$ISSUE"
      done
      log "Cancelled by user"
      exit 0
    fi
  fi
fi


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

  challenge_args=(--issue "$ISSUE" --slug "$SLUG" --title "$TITLE" --repo-dir "$REPO_DIR" --remaining-slots "$((MAX_PARALLEL - slots_used))")
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
    slots_used=$((slots_used + 2))
    log "  $ISSUE: Challenge selected (${primary_model} vs ${challenger_model})"
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
INITIAL_PHASE="executing"
[[ "$PLANNING_MODE" == "interactive" ]] && INITIAL_PHASE="planning"

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

check_plan_approved() {
  local slug="$1"
  local wt="${WORKTREE_ROOT}/${slug}"
  [[ -f "$wt/features/$slug/.plan-approved" ]] && return 0
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

  log "  ⚖ Running challenge comparison for $pair_id"
  if _with_timeout 240 npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --repo-dir "$REPO_DIR" --comment >/tmp/${SESSION}-compare-${pair_id}.log 2>&1; then
    while IFS= read -r line; do log "  [challenge-compare] $line"; done < "/tmp/${SESSION}-compare-${pair_id}.log"
    mark_challenge_compared "$pair_id"
  else
    while IFS= read -r line; do log_warn "  [challenge-compare] $line"; done < "/tmp/${SESSION}-compare-${pair_id}.log"
  fi
  rm -f "/tmp/${SESSION}-compare-${pair_id}.log"
}

cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"

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
  raw_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue-json.ts" "$issue" 2>/dev/null || echo "{}")
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
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30)
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
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue-json.ts" "$linear_issue" 2>/dev/null || echo "{}")
    echo "$issue_json" > "/tmp/${SESSION}-${issue}-issue.json"
  fi
  local issue_desc
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  # Task packet handling
  local packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  if [[ -f "$packet_file" ]]; then
    :
  elif [[ "$PLANNING_MODE" == "interactive" ]]; then
    echo "$issue_desc" > "$packet_file"
  elif is_task_packet "$issue_desc"; then
    echo "$issue_desc" > "$packet_file"
  else
    log "  Expanding task packet for $issue..."
    if [[ -f "$TOOLS_DIR/expand-issue.ts" ]]; then
      _with_timeout 120 npx tsx "$TOOLS_DIR/expand-issue.ts" "$issue" --output "$packet_file" --update >/dev/null 2>&1 || echo "$issue_desc" > "$packet_file"
    else
      echo "$issue_desc" > "$packet_file"
    fi
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Fetch latest base branch
  git -C "$REPO_DIR" fetch origin "$BASE_BRANCH" 2>/dev/null || true

  # ── Migration detection for dynamically launched tasks ──────────────
  local is_migration=false
  local has_migration_label
  has_migration_label=$(echo "$issue_json" | jq -r '.labels.nodes[]? | select(.name | ascii_downcase | test("migration|database|schema|alembic")) | .name' 2>/dev/null | head -1)

  if [[ -n "$has_migration_label" ]]; then
    is_migration=true
  elif echo "$packet_content" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration\|add.*column.*table\|create.*table\|alter.*table"; then
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
  local challenge_enabled_for_launch="false"
  local challenge_pair=""
  local challenge_role
  challenge_role=$(get_task_meta "$issue" "challengeRole")
  local should_launch_challenger="false"
  local challenger_key="" challenger_slug="" challenger_title="$title"
  if [[ -n "$challenge_model" ]]; then
    task_model="$challenge_model"
    task_agent_cmd="$(agent_resolve_from_model "$task_model")"
    log "  Challenge: $task_agent_cmd --model $task_model"
  elif [[ -n "${FORCE_MODEL:-}" ]]; then
    # Validate model (should have been validated earlier, but double-check)
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "  Invalid FORCE_MODEL for $issue: $FORCE_MODEL"
      log_error "  Skipping this task."
      continue
    fi
    task_model="$FORCE_MODEL"
    task_agent_cmd="$(agent_resolve_from_model "$FORCE_MODEL")"
    log "  FORCE_MODEL: $task_agent_cmd --model $task_model"
  elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]]; then
    local suggest_tool="$TOOLS_DIR/suggest-model.ts"
    if [[ "${ROUTER_ENABLED:-true}" == "true" ]] && [[ -f "$suggest_tool" ]] && [[ -f "$packet_file" ]]; then
      local suggestion
      suggestion=$(_with_timeout "$API_TIMEOUT" npx tsx "$suggest_tool" --json --file "$packet_file" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
      if [[ -n "$suggestion" ]]; then
        local rec_model rec_agent rec_insufficient rec_confidence
        rec_model=$(echo "$suggestion" | jq -r '.recommendedModel // empty' 2>/dev/null)
        rec_agent=$(echo "$suggestion" | jq -r '.recommendedAgent // empty' 2>/dev/null)
        rec_insufficient=$(echo "$suggestion" | jq -r '.insufficientData // false' 2>/dev/null)
        rec_confidence=$(echo "$suggestion" | jq -r '.confidence // empty' 2>/dev/null)

        # Always use recommended agent if provided (even when data is insufficient)
        # The router correctly maps default models to their agents
        if [[ -n "$rec_agent" ]]; then
          task_agent_cmd="$rec_agent"
        fi

        # Only gate model selection on data sufficiency
        if [[ "$rec_insufficient" != "true" ]] && [[ -n "$rec_model" ]]; then
          task_model="$rec_model"
          log "  Router: $task_agent_cmd --model $task_model (confidence: $rec_confidence)"
        elif [[ -n "$rec_model" ]]; then
          # Insufficient data - using default model but still log it
          log "  Router: $task_agent_cmd --model $rec_model (insufficient data, using default)"
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

  if [[ -z "${WAVEMILL_DISABLE_CHALLENGE:-}" ]] && should_update_linear_state "$issue" && (( remaining_slots >= 2 )); then
    local challenge_args challenge_plan challenge_mode challenge_reason
    challenge_args=(--issue "$issue" --slug "$slug" --title "$title" --repo-dir "$REPO_DIR" --remaining-slots "$remaining_slots")
    [[ -n "$task_model" ]] && challenge_args+=(--primary-model "$task_model")
    challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
    challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
    challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
    if [[ "$challenge_mode" == "challenge" ]]; then
      challenge_enabled_for_launch="true"
      challenge_pair="$issue"
      task_model=$(echo "$challenge_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
      task_agent_cmd=$(echo "$challenge_plan" | jq -r '.entries[0].agent // empty' 2>/dev/null)
      challenger_key=$(echo "$challenge_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
      challenger_slug=$(echo "$challenge_plan" | jq -r '.entries[1].slug // empty' 2>/dev/null)
      challenger_model=$(echo "$challenge_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
      challenger_agent=$(echo "$challenge_plan" | jq -r '.entries[1].agent // empty' 2>/dev/null)

      cp "$packet_file" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
      cp "/tmp/${SESSION}-${issue}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

      save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "true" "$challenge_pair" "primary" "$task_model"
      save_task_state "$challenger_key" "$challenger_slug" "task/${challenger_slug}" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "$challenger_agent" "$linear_issue" "true" "$challenge_pair" "challenger" "$challenger_model"
      should_launch_challenger="true"
      LAST_LAUNCHED_SLOTS=2
      log "  Challenge selected (${task_model} vs ${challenger_model})"
    elif [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "  Challenge skipped ($challenge_reason), launching single-model run"
    fi
  fi

  # Save to state ledger (after routing so agent is known)
  local initial_phase="executing"
  [[ "$PLANNING_MODE" == "interactive" ]] && initial_phase="planning"
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "$challenge_enabled_for_launch" "$challenge_pair" "${challenge_role:-}" "$task_model"
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
    # Pre-seed selected-task.json
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

    local prompt_file="/tmp/${SESSION}-${issue}-plan-prompt.txt"
    build_interactive_prompt "$title" "$issue" "$wt_dir" "$branch" "$BASE_BRANCH" \
      "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" > "$prompt_file"

    agent_launch_interactive "$SESSION" "$win" "$prompt_file" "$task_agent_cmd" "$task_model"
  else
    local instr_file="/tmp/${SESSION}-${issue}-instructions.txt"
    build_autonomous_prompt "$title" "$issue" "$wt_dir" "$branch" "$BASE_BRANCH" \
      "$issue_context" "$status_file" "$TOOLS_DIR" > "$instr_file"

    agent_launch_autonomous "$SESSION" "$win" "$instr_file" "$task_agent_cmd" "$task_model"
  fi

  log "  ✓ $issue launched (phase: ${initial_phase}, agent: ${task_agent_cmd}${task_model:+ --model $task_model})"

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

  # If already merged (requireConfirm), wait for window close then cleanup
  task_status=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].status // empty' "$STATE_FILE" 2>/dev/null)
  if [[ "$task_status" == "merged" ]]; then
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
      log "✓ $ISSUE → PR #$PR (In Review)"

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

      # Planning phase tracking (must run before pane-alive early return)
      current_phase=$(get_task_phase "$ISSUE")

      if [[ "$current_phase" == "planning" ]]; then
        if check_plan_approved "$SLUG"; then
          set_task_phase "$ISSUE" "executing"
          set_window_attention_state "$WIN" "clear"
          log "✓ $ISSUE → Plan approved, now executing"
        else
          if tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
            set_window_attention_state "$WIN" "clear"
            # Keep unapproved planning tasks active while agent is still running.
            active_count=$((active_count + 1))
            return 0
          fi
          needs_attention="true"
        fi
      fi

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
    active_count=$((active_count + 1))
  fi

  return 0
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  active_count=0

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
  done

  # ── Phase B: Check for stop signal ──────────────────────────────────
  if [[ -f "$STATE_DIR/.stop-loop" ]]; then
    if (( active_count == 0 )); then
      log "Stop signal detected and all tasks complete. Exiting."
      rm -f "$STATE_DIR/.stop-loop"
      exit 0
    fi
    log "Stop signal detected. Finishing $active_count active task(s)..."
    sleep "$POLL_SECONDS"
    continue
  fi

  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      log "All tasks complete. Exiting."
      exit 0
    fi
    # Still have active tasks — keep monitoring but don't offer new ones
    sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  free_slots=$((MAX_PARALLEL - active_count))

  if (( free_slots > 0 )); then
    candidates=$(fetch_candidates)

    if [[ -n "$candidates" ]]; then
      available=$(filter_active_issues "$candidates")

      if [[ -n "$available" ]]; then
        # Split into unblocked and blocked
        # Field 7 is blocked_by_count (field 6 is has_detailed_plan)
        avail_unblocked=$(echo "$available" | awk -F'|' '$7 == 0 || $7 == ""')
        avail_blocked=$(echo "$available" | awk -F'|' '$7 > 0')
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
              log "Quitting."
              exit 0
            else
              log "Will quit after $active_count active task(s) finish."
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
            [[ "$REPLY" =~ ^[Qq] ]] && exit 0
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
          [[ "$REPLY" =~ ^[Qq] ]] && exit 0
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
