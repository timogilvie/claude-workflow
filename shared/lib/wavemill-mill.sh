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

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-progress)
      export WAVEMILL_NO_PROGRESS=1
      shift
      ;;
    *)
      break
      ;;
  esac
done

if [[ ! -t 2 ]]; then
  export WAVEMILL_NO_PROGRESS=1
fi

# Source common library and load layered config
# Resolution: env vars > .wavemill-config.json > ~/.wavemill/config.json > defaults
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/wavemill-common.sh"
source "$SCRIPT_DIR/agent-adapters.sh"
load_config "$REPO_DIR"

# ── Nested invocation guards (HOK-1214) ──────────────────────────

# Guard 1: Detect if running inside a git worktree
_git_dir=$(git rev-parse --git-dir 2>/dev/null || echo "")
_git_common_dir=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
if [[ -n "$_git_dir" && -n "$_git_common_dir" && "$_git_dir" != "$_git_common_dir" ]]; then
  echo "ERROR: wavemill mill cannot run inside a git worktree." >&2
  echo "  Detected worktree: $(git rev-parse --show-toplevel 2>/dev/null)" >&2
  echo "  Main repository:   $(cd "$_git_common_dir/.." && pwd)" >&2
  echo "  Run 'wavemill mill' from the main repository root instead." >&2
  exit 1
fi
unset _git_dir _git_common_dir

# Guard 2: Detect nested mill invocation via environment
# Stores repo path so separate repos in separate terminals don't conflict
if [[ -n "${WAVEMILL_MILL_ACTIVE:-}" ]]; then
  echo "ERROR: wavemill mill is already running for: $WAVEMILL_MILL_ACTIVE" >&2
  echo "  Nested mill invocations are not allowed." >&2
  echo "  If this is unexpected, unset WAVEMILL_MILL_ACTIVE and retry." >&2
  exit 1
fi
export WAVEMILL_MILL_ACTIVE="$REPO_DIR"

# ─────────────────────────────────────────────────────────────────

# Derived variables (not in config files)
DRY_RUN="${DRY_RUN:-false}"
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"
MILL_LOG_DIR="$REPO_DIR/.wavemill/logs"
mkdir -p "$MILL_LOG_DIR"
MILL_LOG_FILE="$MILL_LOG_DIR/mill-${SESSION}.log"
TOOLS_DIR="${TOOLS_DIR:-$REPO_DIR/tools}"
LIB_DIR="${LIB_DIR:-$REPO_DIR/shared/lib}"
MONITOR_PR_CACHE="/tmp/${SESSION}-pr-cache.json"
export MONITOR_PR_CACHE
EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"

trim_outer_whitespace() {
  local value="${1-}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

_global_operating_mode() {
  npx tsx "$TOOLS_DIR/get-operating-mode.ts" global --repo-dir "$REPO_DIR" 2>/dev/null || echo "normal"
}

_update_effective_max_parallel() {
  EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"

  if has_any_healthy_model "$REPO_DIR"; then
    return 0
  fi

  local global_mode
  global_mode="$(_global_operating_mode)"
  case "$global_mode" in
    survival)
      if (( MAX_PARALLEL > 1 )); then
        EFFECTIVE_MAX_PARALLEL=1
      fi
      ;;
    constrained)
      if (( MAX_PARALLEL > 3 )); then
        EFFECTIVE_MAX_PARALLEL=3
      fi
      ;;
  esac
}

_update_effective_max_parallel

FORCE_MODEL="$(trim_outer_whitespace "${FORCE_MODEL:-}")"
if [[ -z "$FORCE_MODEL" ]]; then
  unset FORCE_MODEL
fi


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


# Logging with timestamps and dashboard verbosity filtering
_log_level_num() {
  case "$1" in
    error) echo 0 ;;
    status) echo 1 ;;
    info) echo 2 ;;
    debug) echo 3 ;;
    *) echo 2 ;;
  esac
}

VERBOSITY_NUM=$(_log_level_num "${DASHBOARD_VERBOSITY:-info}")

append_status_log() {
  local payload="$1"
  [[ -n "${STATUS_LOG_FILE:-}" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$line" >> "$STATUS_LOG_FILE" 2>/dev/null || return 1
  done <<< "$payload"
}

log() {
  local level="info"
  local msg
  case "${1:-}" in
    error|status|info|debug)
      level="$1"
      shift
      ;;
  esac
  msg="$*"

  local ts formatted msg_num
  ts="$(date '+%H:%M:%S')"
  formatted="$ts $msg"

  if [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] && [[ -n "${MILL_LOG_FILE:-}" ]]; then
    printf '%s [%s] %s\n' "$ts" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
  fi

  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}
log_error() {
  local formatted
  formatted="$(date '+%H:%M:%S') ERROR: $*"
  append_status_log "$formatted" || echo "$formatted" >&2
}
log_warn() {
  local formatted
  formatted="$(date '+%H:%M:%S') WARN: $*"
  append_status_log "$formatted" || echo "$formatted" >&2
}

replay_route_transparency_logs() {
  local stderr_file="$1"
  [[ -s "$stderr_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "[router]"*|"[coder]"*|"[planner]"*|"[reviewer]"*|"[classifier]"*)
        log "info" "$line"
        ;;
    esac
  done < "$stderr_file"
}

# Future submission hook for Hokusai data export. This is intentionally kept
# lightweight so the mill can gate outbound submission without duplicating the
# consent/version logic that lives in TypeScript.
hokusai_submission_allowed() {
  local hokusai_tool="$SCRIPT_DIR/../../tools/hokusai-manage.ts"
  [[ -f "$hokusai_tool" ]] || return 1
  npx tsx "$hokusai_tool" check-consent >/dev/null 2>&1
}

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

write_shell_assignment() {
  local name="$1" value="${2-}"
  printf '%s=' "$name"
  printf '%q\n' "$value"
}

create_tmux_session() {
  local tmux_conf
  local next_done_script
  tmux_conf="$(cd "$SCRIPT_DIR/../.." && pwd)/.tmux.conf"
  next_done_script="$SCRIPT_DIR/wavemill-next-done.sh"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    local existing_dir
    existing_dir=$(tmux show-environment -t "$SESSION" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//') || true
    if [[ -n "$existing_dir" && "$existing_dir" != "$REPO_DIR" ]]; then
      echo "ERROR: tmux session '$SESSION' is already active in: $existing_dir" >&2
      echo "Cannot start a new session for: $REPO_DIR" >&2
      echo "" >&2
      echo "Options:" >&2
      echo "  - Stop the existing session first (tmux kill-session -t '$SESSION')" >&2
      echo "  - Use a different session name: SESSION=my-session wavemill mill" >&2
      return 1
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi

  tmux -f "$tmux_conf" new-session -d -s "$SESSION" -c "$REPO_DIR" -n control
  # Prevent control panes from being destroyed if their process crashes.
  # Without this, a dashboard crash collapses the entire control layout.
  tmux set-option -t "$SESSION:control" remain-on-exit on 2>/dev/null || true
  tmux set-environment -t "$SESSION" REPO_DIR "$REPO_DIR"
  tmux set-environment -t "$SESSION" WAVEMILL_MILL_ACTIVE "$REPO_DIR"
  [[ -n "${WAVEMILL_NO_PROGRESS:-}" ]] && tmux set-environment -t "$SESSION" WAVEMILL_NO_PROGRESS "$WAVEMILL_NO_PROGRESS"
  if [[ -x "$next_done_script" ]]; then
    tmux bind-key -T prefix N run-shell "WAVEMILL_SESSION='#{session_name}' '$next_done_script'"
  fi
  tmux send-keys -t "$SESSION:control" "echo 'Control window for $SESSION'" C-m
}

write_launch_plan() {
  local launch_plan_file="$1"
  local initial_phase="planning"

  local tasks_json='[]'
  local t issue slug title branch wt_dir linear_issue task_packet_file details_file issue_json_file route_file
  local route_json route_planner route_coder route_reviewer route_plan_depth route_code_depth route_review_mode route_max_cost_usd
  local route_payload challenge_flag challenge_pair challenge_role challenge_model migration_number task_agent

  for t in "${LAUNCH_ARGS[@]}"; do
    IFS='|' read -r issue slug title <<<"$t"
    branch="task/${slug}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    linear_issue="${TASK_LINEAR_ISSUE_BY_ISSUE[$issue]:-$issue}"
    task_packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
    details_file="/tmp/${SESSION}-${issue}-taskpacket-details.md"
    issue_json_file="/tmp/${SESSION}-${issue}-issue.json"
    route_file="/tmp/${SESSION}-${issue}-route.json"
    route_json='{}'
    [[ -f "$route_file" ]] && route_json="$(cat "$route_file" 2>/dev/null || echo '{}')"

    route_planner="${TASK_PLANNER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.planner // empty' 2>/dev/null)}"
    route_coder="${TASK_CODER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.coder // empty' 2>/dev/null)}"
    route_reviewer="${TASK_REVIEWER_MODEL_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.reviewer // empty' 2>/dev/null)}"
    route_plan_depth="${TASK_PLAN_DEPTH_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.planDepth // "light"' 2>/dev/null)}"
    route_code_depth="${TASK_CODE_DEPTH_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.codeDepth // "medium"' 2>/dev/null)}"
    route_review_mode="${TASK_REVIEW_MODE_BY_ISSUE[$issue]:-$(echo "$route_json" | jq -r '.reviewRecommended // .reviewMode // "static"' 2>/dev/null)}"
    route_max_cost_usd="$(echo "$route_json" | jq -r '.constraints.maxCostUsd // empty' 2>/dev/null)"
    [[ -z "$route_max_cost_usd" ]] && route_max_cost_usd="${DEFAULT_MAX_COST_USD:-}"
    challenge_flag="${TASK_CHALLENGE_BY_ISSUE[$issue]:-false}"
    challenge_pair="${TASK_CHALLENGE_PAIR_BY_ISSUE[$issue]:-}"
    challenge_role="${TASK_CHALLENGE_ROLE_BY_ISSUE[$issue]:-}"
    challenge_model="${TASK_CHALLENGE_MODEL_BY_ISSUE[$issue]:-}"
    migration_number="$(jq -r --arg issue "$issue" '.migrationReservations[$issue] // empty' "$STATE_FILE" 2>/dev/null || echo "")"
    task_agent="${TASK_AGENT_BY_ISSUE[$issue]:-$AGENT_CMD}"

    route_payload="$(jq -n \
      --arg planner "$route_planner" \
      --arg coder "$route_coder" \
      --arg reviewer "$route_reviewer" \
      --arg planDepth "$route_plan_depth" \
      --arg codeDepth "$route_code_depth" \
      --arg reviewMode "$route_review_mode" \
      --argjson maxCostUsd "${route_max_cost_usd:-null}" \
      '{
        planner: $planner,
        coder: $coder,
        reviewer: $reviewer,
        planDepth: $planDepth,
        codeDepth: $codeDepth,
        reviewMode: $reviewMode
      } + (if $maxCostUsd == null then {} else {maxCostUsd: $maxCostUsd} end)')"

    tasks_json="$(jq -n \
      --argjson tasks "$tasks_json" \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg title "$title" \
      --arg branch "$branch" \
      --arg worktreeDir "$wt_dir" \
      --arg linearIssueId "$linear_issue" \
      --arg taskPacketFile "$task_packet_file" \
      --arg taskPacketDetailsFile "$details_file" \
      --arg issueJsonFile "$issue_json_file" \
      --arg routeFile "$route_file" \
      --argjson route "$route_payload" \
      --arg challenge "$challenge_flag" \
      --arg challengePairId "$challenge_pair" \
      --arg challengeRole "$challenge_role" \
      --arg challengeModel "$challenge_model" \
      --arg migrationNumber "$migration_number" \
      --arg agent "$task_agent" \
      '$tasks + [{
        issue: $issue,
        slug: $slug,
        title: $title,
        branch: $branch,
        worktreeDir: $worktreeDir,
        linearIssueId: $linearIssueId,
        taskPacketFile: $taskPacketFile,
        taskPacketDetailsFile: $taskPacketDetailsFile,
        issueJsonFile: $issueJsonFile,
        routeFile: $routeFile,
        route: $route,
        challenge: ($challenge == "true"),
        challengePairId: (if $challengePairId == "" then null else $challengePairId end),
        challengeRole: (if $challengeRole == "" then null else $challengeRole end),
        challengeModel: (if $challengeModel == "" then null else $challengeModel end),
        migrationNumber: (if $migrationNumber == "" then null else ($migrationNumber | tonumber) end),
        agent: $agent
      }]')"
  done

  jq -n \
    --arg session "$SESSION" \
    --arg repoDir "$REPO_DIR" \
    --arg baseBranch "$BASE_BRANCH" \
    --arg worktreeRoot "$WORKTREE_ROOT" \
    --arg planningMode "$PLANNING_MODE" \
    --arg agentCmd "$AGENT_CMD" \
    --arg agentCmdExplicit "${AGENT_CMD_EXPLICIT:-}" \
    --arg forceModel "${FORCE_MODEL:-}" \
    --arg routerEnabled "${ROUTER_ENABLED:-true}" \
    --arg maxParallel "$MAX_PARALLEL" \
    --arg stateDir "$STATE_DIR" \
    --arg stateFile "$STATE_FILE" \
    --arg toolsDir "$TOOLS_DIR" \
    --arg libDir "$SCRIPT_DIR" \
    --arg initialPhase "$initial_phase" \
    --arg statusLogFile "$STATUS_LOG_FILE" \
    --arg monitorEnv "$MONITOR_ENV" \
    --arg monitorScript "$MONITOR_SCRIPT" \
    --arg launchedIssuesFile "$LAUNCHED_ISSUES_FILE" \
    --argjson tasks "$tasks_json" \
    --arg pollSeconds "$POLL_SECONDS" \
    --arg requireConfirm "$REQUIRE_CONFIRM" \
    --arg dryRun "$DRY_RUN" \
    --arg projectName "$PROJECT_NAME" \
    --arg autoEval "$AUTO_EVAL" \
    --arg dashboardVerbosity "$DASHBOARD_VERBOSITY" \
    --arg dashboardLogToFile "$DASHBOARD_LOG_TO_FILE" \
    --arg millLogFile "$MILL_LOG_FILE" \
    '{
      session: $session,
      repoDir: $repoDir,
      baseBranch: $baseBranch,
      worktreeRoot: $worktreeRoot,
      planningMode: $planningMode,
      agentCmd: $agentCmd,
      agentCmdExplicit: ($agentCmdExplicit == "true"),
      forceModel: (if $forceModel == "" then null else $forceModel end),
      routerEnabled: ($routerEnabled == "true"),
      maxParallel: ($maxParallel | tonumber),
      stateDir: $stateDir,
      stateFile: $stateFile,
      toolsDir: $toolsDir,
      libDir: $libDir,
      initialPhase: $initialPhase,
      tasks: $tasks,
      startupConfig: {
        statusLogFile: $statusLogFile,
        monitorEnv: $monitorEnv,
        monitorScript: $monitorScript,
        launchedIssuesFile: $launchedIssuesFile,
        millLogFile: $millLogFile
      },
      monitorConfig: {
        pollSeconds: ($pollSeconds | tonumber),
        requireConfirm: ($requireConfirm == "true"),
        dryRun: ($dryRun == "true"),
        projectName: $projectName,
        autoEval: ($autoEval == "true"),
        dashboardVerbosity: $dashboardVerbosity,
        dashboardLogToFile: ($dashboardLogToFile == "true")
      }
    }' > "$launch_plan_file"
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
  if ! state_mutate "$STATE_FILE" \
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
     --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" --arg agent "$agent" \
     --arg linearIssue "$linear_issue" --arg challenge "$challenge" --arg challengePair "$challenge_pair" \
     --arg challengeRole "$challenge_role" --arg challengeModel "$challenge_model" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode"; then
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
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

save_next_migration_num() {
  local num="$1"
  state_mutate "$STATE_FILE" '.nextMigrationNum = $num' --argjson num "$num" >/dev/null || true
}


remove_task_state() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" 'del(.tasks[$issue])' --arg issue "$issue"; then
    log_warn "remove_task_state: failed to remove $issue"
  fi
}


set_task_phase() {
  local issue="$1" phase="$2"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     --arg issue "$issue" --arg phase "$phase"; then
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
  log "debug" "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    execute git -C "$REPO_DIR" worktree remove "$wt_dir" --force >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch after removing the worktree so Git can detach cleanly first.
  local task_branch="task/${slug}"
  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    execute git -C "$REPO_DIR" branch -D "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "  ✓ Deleted local branch: $task_branch"
    if execute git -C "$REPO_DIR" push origin --delete "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "  ✓ Deleted remote branch: $task_branch"
    else
      log "debug" "  ℹ Remote branch already deleted or push failed: $task_branch"
    fi
  fi

  # Clean up state
  execute git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
  reset_retry_count "$SESSION" "$issue"
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
  local selection_limit="${STARTUP_SLOT_LIMIT:-$MAX_PARALLEL}"


  if [[ -z "$selected_numbers" ]]; then
    # Auto-select up to the startup slot limit with conflict avoidance
    local -A area_used=()
    local -a result=()
    local count=0


    while IFS= read -r line && [[ $count -lt $selection_limit ]]; do
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
  local launched_issue_file="/tmp/${SESSION}-launched-issues.txt"

  # Enhanced error context for debugging forced exit issues (HOK-1297)
  if [[ -n "${DEBUG_CLEANUP:-}" ]]; then
    log_warn "cleanup_on_exit: Starting cleanup (exit_code=$exit_code, session=${SESSION:-unknown})"
  fi

  if [[ ${#ISSUES_IN_PROGRESS[@]} -eq 0 && -f "$launched_issue_file" ]]; then
    while IFS= read -r issue; do
      [[ -n "$issue" ]] && ISSUES_IN_PROGRESS+=("$issue")
    done < <(sort -u "$launched_issue_file" 2>/dev/null || true)
  fi

  if [[ ${#ISSUES_IN_PROGRESS[@]} -gt 0 ]]; then
    log_warn "Interrupted - resetting Linear state for unfinished tasks..."
    log_warn "Worktrees and branches preserved for resumption on next run."
    for issue in "${ISSUES_IN_PROGRESS[@]}"; do
      role=$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE" 2>/dev/null)
      linear_issue=$(jq -r --arg issue "$issue" '.tasks[$issue].linearIssueId // .tasks[$issue].challengePairId // $issue' "$STATE_FILE" 2>/dev/null)
      if [[ "$role" != "challenger" ]]; then
        linear_set_state "${linear_issue:-$issue}" "Backlog" 2>/dev/null || {
          [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Failed to reset Linear state for $issue"
          true
        }
      fi
      remove_task_state "$issue" 2>/dev/null || {
        [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Failed to remove task state for $issue"
        true
      }
    done
  fi

  [[ -n "${DEBUG_CLEANUP:-}" ]] && log_warn "cleanup_on_exit: Cleanup complete"
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
            state_mutate "$STATE_FILE" \
              '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
              --arg issue "$issue" >/dev/null 2>&1 || true
          ) >/dev/null 2>&1 &
    log "debug" "  ↳ Eval running in background; log: $eval_log"
        fi
      fi
    fi

    # Keep non-terminal tasks in state across restarts so the monitor can
    # resume PR/state reconciliation after crashes.

    if [[ "$should_clean" == "true" ]]; then
      log "debug" "  Pruning $issue ($reason)"
      if [[ "$full_clean" == "true" ]]; then
        # Clean up worktree + branch for completed tasks
        if [[ -d "$worktree" ]]; then
          execute git -C "$REPO_DIR" worktree remove "$worktree" --force 2>/dev/null || true
        fi
        if [[ "$reason" != "branch deleted" ]]; then
          if [[ "$branch" == "main" || "$branch" == "master" ]]; then
            log_warn "  Refusing to delete protected branch: $branch"
          else
            git -C "$REPO_DIR" branch -D "$branch" 2>/dev/null || true
            git -C "$REPO_DIR" push origin --delete "$branch" 2>/dev/null || true
          fi
        fi
      fi
      # Remove from state file (dashboard will stop showing it)
      remove_task_state "$issue"
      cleaned=$((cleaned + 1))
    fi
  done <<<"$stale_issues"

  if (( cleaned > 0 )); then
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    log "debug" "  Cleaned $cleaned stale task(s)"
  fi
}

detect_inflight_tasks() {
  [[ -f "$STATE_FILE" ]] || return 0
  jq -r '
    (.tasks // {})
    | to_entries[]
    | select((.value.status // "") as $status
        | $status != "merged"
        and $status != "completed-external"
        and $status != "aborted")
    | "\(.key)|\(.value.slug // "")|\(.value.phase // "executing")|\(.value.agent // "")|\(.value.branch // "")|\(.value.worktree // "")|\(.value.challengeRole // "")"
  ' "$STATE_FILE" 2>/dev/null || true
}

count_inflight_primary_tasks() {
  local inflight_tasks="$1"
  local count=0
  local issue slug phase agent branch worktree challenge_role
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug phase agent branch worktree challenge_role <<<"$line"
    [[ "$challenge_role" == "challenger" ]] && continue
    count=$((count + 1))
  done <<<"$inflight_tasks"
  echo "$count"
}

clear_inflight_tasks_from_state() {
  state_mutate "$STATE_FILE" '.tasks = {} | .updated = (now | todate)'
}

stale_count=$(jq '.tasks | length' "$STATE_FILE" 2>/dev/null || echo 0)
if (( stale_count > 0 )); then
  log "debug" "Found $stale_count task(s) in state file from previous run. Checking..."
  cleanup_stale_tasks
fi

SKIP_BACKLOG_SELECTION=false
STARTUP_SLOT_LIMIT="$EFFECTIVE_MAX_PARALLEL"
inflight_tasks="$(detect_inflight_tasks)"
if [[ -n "$inflight_tasks" ]]; then
  inflight_count=$(printf '%s\n' "$inflight_tasks" | grep -c .)
  inflight_primary_count=$(count_inflight_primary_tasks "$inflight_tasks")

  echo ""
  log "status" "Found $inflight_count in-flight task(s) from a previous session:"
  menu_index=0
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug phase agent branch worktree challenge_role <<<"$line"
    menu_index=$((menu_index + 1))
    display_slug="$slug"
    [[ -z "$display_slug" && -n "$branch" ]] && display_slug="${branch#task/}"
    [[ -z "$display_slug" ]] && display_slug="unknown-slug"
    display_phase="$phase"
    [[ -z "$display_phase" ]] && display_phase="executing"
    display_agent="$agent"
    [[ -z "$display_agent" ]] && display_agent="unknown"
    printf '  %s. %s (%s) - %s phase [%s]\n' "$menu_index" "$issue" "$display_slug" "$display_phase" "$display_agent"

    if [[ -z "$worktree" ]]; then
      worktree="${WORKTREE_ROOT}/${display_slug}"
    fi
    if [[ -n "$worktree" && ! -d "$worktree" ]]; then
      log_warn "  Worktree missing for $issue - will be recreated on resume"
    fi
  done <<<"$inflight_tasks"

  echo ""
  echo "Options:"
  echo "  r  Resume these tasks (skip backlog selection)"
  echo "  f  Ignore old state and start fresh"
  echo "  q  Quit"

  while true; do
    echo ""
    echo "Choose: [r/f/q]"
    read -r RESUME_CHOICE
    case "${RESUME_CHOICE:-}" in
      r|R)
        SKIP_BACKLOG_SELECTION=true
        STARTUP_SLOT_LIMIT=0
        break
        ;;
      f|F)
        if clear_inflight_tasks_from_state; then
          log "status" "Cleared in-flight task state. Starting fresh."
          inflight_tasks=""
          inflight_count=0
          inflight_primary_count=0
          STARTUP_SLOT_LIMIT="$EFFECTIVE_MAX_PARALLEL"
        else
          log_error "Failed to clear in-flight task state."
          exit 1
        fi
        break
        ;;
      q|Q)
        log "status" "Cancelled by user."
        exit 0
        ;;
      *)
        log_warn "Invalid selection: ${RESUME_CHOICE:-<empty>}"
        ;;
    esac
  done
fi


# Display configuration
if [[ "$DRY_RUN" == "true" ]]; then
  echo "============================================"
  echo "DRY-RUN MODE - No actions will be executed"
  echo "============================================"
fi


log "info" "Configuration:"
log "info" "  Repository: $REPO_DIR"
log "info" "  Base branch: $BASE_BRANCH"
log "info" "  Worktree root: $WORKTREE_ROOT"
log "info" "  Project: ${PROJECT_NAME:-(all projects)}"
log "info" "  Agent: $AGENT_CMD ($(agent_name "$AGENT_CMD"))${AGENT_CMD_EXPLICIT:+ [explicit override]}"
log "info" "  Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)"
if (( EFFECTIVE_MAX_PARALLEL < MAX_PARALLEL )); then
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)"
else
  log "info" "  Max parallel: $MAX_PARALLEL"
fi
log "info" "  Planning mode: $PLANNING_MODE"
log "info" "  Dashboard verbosity: ${DASHBOARD_VERBOSITY:-info}"
[[ -n "${SETUP_CMD:-}" ]] && log "info" "  Setup command: $SETUP_CMD"
log "info" "  State file: $STATE_FILE"
if [[ -n "${inflight_tasks:-}" ]]; then
  log "info" "  Resume detected: ${inflight_count:-0} in-flight task(s), startup slot limit: $STARTUP_SLOT_LIMIT"
fi
echo ""


# Safety check: first-time repo confirmation
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]]; then
  echo "⚠️  First-time run in this repository"
  confirm "Continue with autonomous workflow in $REPO_DIR?" || exit 1
  execute touch "$STATE_DIR/.initialized"
fi


TASKS=()
if [[ "$SKIP_BACKLOG_SELECTION" != "true" ]]; then
  log "info" "Fetching backlog..."
  BACKLOG="$(linear_list_backlog)" || {
    log_error "Failed to fetch backlog from Linear. Check your LINEAR_API_KEY and network."
    exit 1
  }

  if [[ -z "$BACKLOG" ]] || [[ "$BACKLOG" == "[]" ]]; then
    log "status" "No backlog items returned from Linear."
    exit 0
  fi

  CANDIDATES="$(pick_candidates "$BACKLOG")"
  if [[ -z "$CANDIDATES" ]]; then
    log "status" "No backlog candidates found."
    exit 0
  fi
fi

check_subsystem_drift() {
  local drift_output
  drift_output="$(npx tsx tools/check-drift.ts "$REPO_DIR" 2>/dev/null)" || return 1
  printf '%s\n' "$drift_output"
}


if [[ "$SKIP_BACKLOG_SELECTION" != "true" ]]; then
  # Split candidates into unblocked and blocked
  # pick_candidates() outputs 6 fields (has_detailed_plan is stripped), so field 6 is blocked_by_count
  UNBLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 == 0 || $6 == ""')
  BLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 > 0')
  BLOCKED_COUNT=0
  [[ -n "$BLOCKED" ]] && BLOCKED_COUNT=$(echo "$BLOCKED" | grep -c .)
  SHOW_BLOCKED_TASKS=false
  while true; do
    DRIFT_SUBSYSTEMS=""
    if DRIFT_SUBSYSTEMS="$(check_subsystem_drift)"; then
      :
    fi

    if [[ "$SHOW_BLOCKED_TASKS" == "true" ]]; then
      CANDIDATES=$(printf '%s\n%s' "$UNBLOCKED" "$BLOCKED" | grep .)
    else
      CANDIDATES="$UNBLOCKED"
    fi

    if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
      echo ""
      echo "  Warning: Subsystem docs stale ($DRIFT_SUBSYSTEMS) - press d to refresh"
    fi

    echo ""
    if [[ "$SHOW_BLOCKED_TASKS" == "true" ]]; then
      log "info" "All tasks (ranked by priority):"
      line_num=0
      while IFS= read -r line; do
        line_num=$((line_num + 1))
        IFS='|' read -r id slug title area score blocked_by <<<"$line"
        if (( blocked_by > 0 )); then
          printf "  %s. %s - %s (score: %.0f) [blocked]\n" "$line_num" "$id" "$title" "$score"
        else
          printf "  %s. %s - %s (score: %.0f)\n" "$line_num" "$id" "$title" "$score"
        fi
      done <<<"$CANDIDATES"
    else
      log "status" "Available tasks (ranked by priority):"
      if [[ -n "$UNBLOCKED" ]]; then
        echo "$UNBLOCKED" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
      else
        echo "  (no unblocked tasks)"
      fi
    fi

    if [[ "$SHOW_BLOCKED_TASKS" != "true" ]] && (( BLOCKED_COUNT > 0 )); then
      echo ""
      echo "  ($BLOCKED_COUNT blocked task(s) hidden - enter 'm' to show all)"
    fi

    echo ""
    if (( STARTUP_SLOT_LIMIT < MAX_PARALLEL )); then
      log "info" "Startup launch capacity: $STARTUP_SLOT_LIMIT new task(s) (max parallel $MAX_PARALLEL, accounting for resumed work)"
    fi
    if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
      if (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
        echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, m for more, q to quit, or Enter to auto-select first $STARTUP_SLOT_LIMIT:"
      else
        echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, q to quit, or Enter to auto-select first $STARTUP_SLOT_LIMIT:"
      fi
    else
      if (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
        echo "Enter numbers to run (e.g. 1 3 5), m for more, q to quit, or Enter to auto-select first $STARTUP_SLOT_LIMIT:"
      else
        echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to auto-select first $STARTUP_SLOT_LIMIT:"
      fi
    fi
    read -r SELECTED

    if [[ "$SELECTED" =~ ^[dD](ocs)?$ ]]; then
      echo ""
      if [[ -n "$DRIFT_SUBSYSTEMS" ]]; then
        log "info" "Refreshing subsystem docs..."
        npx tsx tools/init-project-context.ts --force "$REPO_DIR"
        echo ""
        log "info" "Refresh complete. Re-displaying task list..."
      else
        echo "Subsystem docs are up to date"
      fi
      SHOW_BLOCKED_TASKS=false
      continue
    fi

    if [[ "$SELECTED" =~ ^[mM] ]] && (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
      SHOW_BLOCKED_TASKS=true
      continue
    fi

    if [[ "$SELECTED" =~ ^[qQ](uit)?$ ]]; then
      log "status" "Cancelled by user."
      exit 0
    fi

    if [[ -z "$SELECTED" ]] && [[ -n "$UNBLOCKED" ]]; then
      CANDIDATES="$UNBLOCKED"
    fi

    break
  done

  # Use smart selection
  SELECTED_LINES="$(smart_select_from_candidates "$CANDIDATES" "$SELECTED")"
  while IFS= read -r line; do
    [[ -n "$line" ]] && TASKS+=("$line")
  done <<<"$SELECTED_LINES"
fi


if [[ "$SKIP_BACKLOG_SELECTION" == "true" ]]; then
  log "info" "Skipping backlog selection and new task launch; monitor will resume in-flight tasks."
else
  log "info" "Normalizing issues with task packets and launching work..."
fi
LAUNCH_ARGS=()
declare -A TASK_LINEAR_ISSUE_BY_ISSUE
declare -A TASK_CHALLENGE_BY_ISSUE
declare -A TASK_CHALLENGE_PAIR_BY_ISSUE
declare -A TASK_CHALLENGE_ROLE_BY_ISSUE
declare -A TASK_CHALLENGE_MODEL_BY_ISSUE
declare -A TASK_AGENT_BY_ISSUE
declare -A TASK_PLANNER_MODEL_BY_ISSUE
declare -A TASK_CODER_MODEL_BY_ISSUE
declare -A TASK_REVIEWER_MODEL_BY_ISSUE
declare -A TASK_PLAN_DEPTH_BY_ISSUE
declare -A TASK_CODE_DEPTH_BY_ISSUE
declare -A TASK_REVIEW_MODE_BY_ISSUE


if (( ${#TASKS[@]} > 0 )); then
  # Pre-allocate migration numbers for parallel work
  # Fetch first so we scan the latest state of the base branch (not stale local files)
  log "debug" "Fetching latest $BASE_BRANCH for migration scan..."
  wavemill_fetch_base_branch "$BASE_BRANCH" --force 2>/dev/null || true

  # Scan the git tree (not local filesystem) for the highest existing migration number
  HIGHEST=$(scan_highest_migration)
  NEXT_MIGRATION_NUM=$((HIGHEST + 1))
  save_next_migration_num "$NEXT_MIGRATION_NUM"
  log "debug" "Next available migration number: $NEXT_MIGRATION_NUM (highest in origin/$BASE_BRANCH: $HIGHEST)"


  # ── Phase 1: Fetch issue details (reuse backlog payload when possible) ───
  log "info" "Fetching issue details..."
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    (
      backlog_record=""

      if [[ -n "${BACKLOG:-}" ]]; then
        backlog_record=$(printf '%s' "$BACKLOG" | jq -c --arg id "$ISSUE" \
          '.[] | select(.identifier == $id)' 2>/dev/null || true)
      fi

      if [[ -n "$backlog_record" ]] && issue_payload_is_complete "$backlog_record"; then
        log "debug" "  $ISSUE: reuse-backlog (skipping re-fetch)"
        printf '%s\n' "$backlog_record" > "/tmp/${SESSION}-${ISSUE}-issue.json"
      else
        log "debug" "  $ISSUE: refetch"
        json=$(linear_get_issue "$ISSUE" 2>/dev/null || echo "{}")
        printf '%s\n' "$json" > "/tmp/${SESSION}-${ISSUE}-issue.json"
      fi
    ) &
  done
  wait
  log "info" "  ✓ All issues fetched"


  # ── Phase 2: Write task packets (no expansion — agent expands in-pane) ────
  # If the Linear description is already a task packet, use it directly.
  # Otherwise, write the raw description — the planning agent will expand later.
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

    if is_task_packet "$current_desc"; then
      log "info" "  ✓ $ISSUE has task packet"
    else
      log "info" "  ✓ $ISSUE raw description saved (agent will expand)"
    fi
    echo "$current_desc" > "$PACKET_FILE"
  done
fi


# ── Phase 3: Migration detection ──────────────────────────────────────────
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
    log "debug" "  → Migration detected (label: $has_migration_label), assigning number: $NEXT_MIGRATION_NUM"
    is_migration=true
  elif echo "$current_desc" | grep -qi "alembic\|migration.*file\|database.*migration\|schema.*migration"; then
    log "debug" "  → Migration detected (raw description keyword match), assigning number: $NEXT_MIGRATION_NUM"
    log "debug" "    Tip: Add 'migration' label to $ISSUE for more reliable detection"
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

  log "status" "  ✓ $ISSUE ready"
  LAUNCH_ARGS+=("$t")
done


# ── Phase 4: Stage-aware model routing ─────────────────────────────────
if [[ -n "${FORCE_MODEL:-}" ]]; then
  if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
    log_error "Invalid FORCE_MODEL: $FORCE_MODEL"
    log_error "Run 'wavemill mill' without FORCE_MODEL to use the router, or fix the model name."
    exit 1
  fi
  log "info" "FORCE_MODEL=$FORCE_MODEL - skipping router"
elif [[ "${ROUTER_ENABLED:-true}" == "true" ]]; then
  ROUTE_TOOL="$TOOLS_DIR/route-task.ts"
  ROUTE_BATCH_TOOL="$TOOLS_DIR/route-tasks.ts"
  if [[ -f "$ROUTE_TOOL" ]]; then
    log "info" "Running model router..."
    ROUTE_MAX_COST_ARGS=()
    if [[ -n "${DEFAULT_MAX_COST_USD:-}" ]]; then
      ROUTE_MAX_COST_ARGS=(--max-cost "$DEFAULT_MAX_COST_USD")
    fi
    STARTUP_BATCH_ROUTED=false
    if [[ -f "$ROUTE_BATCH_TOOL" ]]; then
      ROUTE_BATCH_INPUT="/tmp/${SESSION}-route-batch-input.jsonl"
      ROUTE_BATCH_OUTPUT="/tmp/${SESSION}-route-batch-output.jsonl"
      ROUTE_BATCH_STDERR="/tmp/${SESSION}-route-batch.stderr"
      BATCH_ROUTE_ISSUES=()
      : > "$ROUTE_BATCH_INPUT"

      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
        if [[ -f "$PACKET_FILE" ]]; then
          jq -cn --arg issueId "$ISSUE" --arg file "$PACKET_FILE" '{issueId: $issueId, file: $file}' >> "$ROUTE_BATCH_INPUT"
          printf '\n' >> "$ROUTE_BATCH_INPUT"
          BATCH_ROUTE_ISSUES+=("$ISSUE")
        fi
      done

      if (( ${#BATCH_ROUTE_ISSUES[@]} > 0 )); then
        rm -f "$ROUTE_BATCH_OUTPUT" "$ROUTE_BATCH_STDERR"
        if npx tsx "$ROUTE_BATCH_TOOL" --jsonl "$ROUTE_BATCH_INPUT" --repo-dir "$REPO_DIR" "${ROUTE_MAX_COST_ARGS[@]}" >"$ROUTE_BATCH_OUTPUT" 2>"$ROUTE_BATCH_STDERR"; then
          replay_route_transparency_logs "$ROUTE_BATCH_STDERR"
          mapfile -t BATCH_ROUTE_LINES < <(grep -v '^[[:space:]]*$' "$ROUTE_BATCH_OUTPUT" 2>/dev/null || true)
          if (( ${#BATCH_ROUTE_LINES[@]} == ${#BATCH_ROUTE_ISSUES[@]} )); then
            STARTUP_BATCH_ROUTED=true
            for idx in "${!BATCH_ROUTE_LINES[@]}"; do
              ISSUE="${BATCH_ROUTE_ISSUES[$idx]}"
              ROUTE_JSON="${BATCH_ROUTE_LINES[$idx]}"
              if ! echo "$ROUTE_JSON" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
                STARTUP_BATCH_ROUTED=false
                log_warn "  $ISSUE: Batch router returned invalid JSON, falling back to per-task routing"
                break
              fi

              PLANNER=$(echo "$ROUTE_JSON" | jq -r '.planner // empty' 2>/dev/null)
              CODER=$(echo "$ROUTE_JSON" | jq -r '.coder // empty' 2>/dev/null)
              REVIEWER=$(echo "$ROUTE_JSON" | jq -r '.reviewer // empty' 2>/dev/null)
              PLAN_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.planDepth // "light"' 2>/dev/null)
              CODE_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.codeDepth // "medium"' 2>/dev/null)
              REVIEW_MODE=$(echo "$ROUTE_JSON" | jq -r '.reviewRecommended // "static"' 2>/dev/null)
              ROUTING_MODE=$(echo "$ROUTE_JSON" | jq -r '.routingMode // "unknown"' 2>/dev/null)
              NEIGHBOR_COUNT=$(echo "$ROUTE_JSON" | jq -r '.neighborCount // 0' 2>/dev/null)

              log "info" "  $ISSUE: planner=$PLANNER ($PLAN_DEPTH), coder=$CODER ($CODE_DEPTH), reviewer=$REVIEWER ($REVIEW_MODE)"
              log "info" "          routing=$ROUTING_MODE, neighbors=$NEIGHBOR_COUNT"

              echo "$ROUTE_JSON" > "/tmp/${SESSION}-${ISSUE}-route.json"

              CODER_AGENT=$(agent_resolve_from_model "${CODER:-}")
              jq -n \
                --arg model "${CODER:-}" \
                --arg agent "$CODER_AGENT" \
                --arg taskType "$(echo "$ROUTE_JSON" | jq -r '.signals.taskType // "unknown"')" \
                --arg reasoning "$(echo "$ROUTE_JSON" | jq -r '.reasoning[0] // ""')" \
                --argjson neighborCount "${NEIGHBOR_COUNT:-0}" \
                --arg routingMode "${ROUTING_MODE:-unknown}" \
                '{
                  recommendedModel: $model,
                  recommendedAgent: $agent,
                  taskType: $taskType,
                  confidence: (if $neighborCount > 0 then "medium" elif $routingMode == "heuristic-fallback" then "low" else "medium" end),
                  insufficientData: ($neighborCount == 0 and $routingMode == "heuristic-fallback"),
                  reasoning: $reasoning
                }' > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
            done
          else
            log_warn "  Batch router returned ${#BATCH_ROUTE_LINES[@]} result(s) for ${#BATCH_ROUTE_ISSUES[@]} task(s); falling back to per-task routing"
          fi
        else
          replay_route_transparency_logs "$ROUTE_BATCH_STDERR"
          log_warn "  Batch router failed, falling back to per-task routing"
        fi
        rm -f "$ROUTE_BATCH_INPUT" "$ROUTE_BATCH_OUTPUT" "$ROUTE_BATCH_STDERR"
      fi
    fi

    if [[ "$STARTUP_BATCH_ROUTED" != "true" ]]; then
      for t in "${TASKS[@]}"; do
        IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
        PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
        if [[ -f "$PACKET_FILE" ]]; then
          ROUTE_STDERR="/tmp/${SESSION}-${ISSUE}-route.stderr"
          rm -f "$ROUTE_STDERR"
          ROUTE_JSON=$(npx tsx "$ROUTE_TOOL" --json --file "$PACKET_FILE" --repo-dir "$REPO_DIR" "${ROUTE_MAX_COST_ARGS[@]}" 2>"$ROUTE_STDERR" || echo "")
          replay_route_transparency_logs "$ROUTE_STDERR"
          rm -f "$ROUTE_STDERR"
          if [[ -n "$ROUTE_JSON" ]] && echo "$ROUTE_JSON" | jq -e '.planner' >/dev/null 2>&1; then
            PLANNER=$(echo "$ROUTE_JSON" | jq -r '.planner // empty' 2>/dev/null)
            CODER=$(echo "$ROUTE_JSON" | jq -r '.coder // empty' 2>/dev/null)
            REVIEWER=$(echo "$ROUTE_JSON" | jq -r '.reviewer // empty' 2>/dev/null)
            PLAN_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.planDepth // "light"' 2>/dev/null)
            CODE_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.codeDepth // "medium"' 2>/dev/null)
            REVIEW_MODE=$(echo "$ROUTE_JSON" | jq -r '.reviewRecommended // "static"' 2>/dev/null)
            ROUTING_MODE=$(echo "$ROUTE_JSON" | jq -r '.routingMode // "unknown"' 2>/dev/null)
            NEIGHBOR_COUNT=$(echo "$ROUTE_JSON" | jq -r '.neighborCount // 0' 2>/dev/null)

            log "info" "  $ISSUE: planner=$PLANNER ($PLAN_DEPTH), coder=$CODER ($CODE_DEPTH), reviewer=$REVIEWER ($REVIEW_MODE)"
            log "info" "          routing=$ROUTING_MODE, neighbors=$NEIGHBOR_COUNT"

            echo "$ROUTE_JSON" > "/tmp/${SESSION}-${ISSUE}-route.json"

            CODER_AGENT=$(agent_resolve_from_model "${CODER:-}")
            jq -n \
              --arg model "${CODER:-}" \
              --arg agent "$CODER_AGENT" \
              --arg taskType "$(echo "$ROUTE_JSON" | jq -r '.signals.taskType // "unknown"')" \
              --arg reasoning "$(echo "$ROUTE_JSON" | jq -r '.reasoning[0] // ""')" \
              --argjson neighborCount "${NEIGHBOR_COUNT:-0}" \
              --arg routingMode "${ROUTING_MODE:-unknown}" \
              '{
                recommendedModel: $model,
                recommendedAgent: $agent,
                taskType: $taskType,
                confidence: (if $neighborCount > 0 then "medium" elif $routingMode == "heuristic-fallback" then "low" else "medium" end),
                insufficientData: ($neighborCount == 0 and $routingMode == "heuristic-fallback"),
                reasoning: $reasoning
              }' > "/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
          else
            log "info" "  $ISSUE: Router returned no result, using defaults"
          fi
        fi
      done
    fi
    echo ""
  fi
fi


# ── Phase 5: Challenge-mode launch planning ──────────────────────────────
FINAL_LAUNCH_ARGS=()
slots_used=0

for t in "${TASKS[@]}"; do
  IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
  if (( slots_used >= STARTUP_SLOT_LIMIT )); then
    log "status" "  $ISSUE: Deferring launch (no remaining slots after challenge allocation)"
    continue
  fi
  rec_model=""
  rec_agent="$AGENT_CMD"
  route_planner=""
  route_reviewer=""
  route_plan_depth="light"
  route_code_depth="medium"
  route_review_mode="static"

  if [[ -n "${FORCE_MODEL:-}" ]]; then
    rec_model="$FORCE_MODEL"
    rec_agent="$(agent_resolve_from_model "$FORCE_MODEL")"
    route_planner="$FORCE_MODEL"
    route_reviewer="$FORCE_MODEL"
    route_plan_depth="light"
    route_code_depth="medium"
    route_review_mode="static"
  else
    rec_model=$(read_route_json "$SESSION" "$ISSUE" "coder")
    route_planner=$(read_route_json "$SESSION" "$ISSUE" "planner")
    route_reviewer=$(read_route_json "$SESSION" "$ISSUE" "reviewer")
    route_plan_depth=$(read_route_json "$SESSION" "$ISSUE" "planDepth" "light")
    route_code_depth=$(read_route_json "$SESSION" "$ISSUE" "codeDepth" "medium")
    route_review_mode=$(read_route_json "$SESSION" "$ISSUE" "reviewRecommended" "static")
    if [[ -n "$rec_model" ]]; then
      rec_agent="$(agent_resolve_from_model "$rec_model")"
    fi
  fi

  # Challengers are free overhead (don't consume a slot), so always pass
  # remaining-slots >= 2 as long as the primary slot is available.
  challenge_mode="single"
  challenge_reason=""
  if [[ -n "${FORCE_MODEL:-}" ]]; then
    challenge_reason="forced_model"
    log "debug" "  $ISSUE: Challenge skipped because FORCE_MODEL is set ($FORCE_MODEL)"
  else
    _rs=$((STARTUP_SLOT_LIMIT - slots_used))
    (( _rs < 2 )) && _rs=2
    challenge_args=(--issue "$ISSUE" --slug "$SLUG" --title "$TITLE" --repo-dir "$REPO_DIR" --remaining-slots "$_rs")
    if [[ -d "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}" ]]; then
      challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${SLUG}/features/${SLUG}")
    fi
    [[ -n "$rec_model" ]] && challenge_args+=(--primary-model "$rec_model")
    challenge_plan=$(npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
    challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
    challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
  fi

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

    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]="primary"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_AGENT_BY_ISSUE["$ISSUE"]="${primary_agent:-$rec_agent}"
    TASK_PLANNER_MODEL_BY_ISSUE["$ISSUE"]="$route_planner"
    TASK_CODER_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$ISSUE"]="$route_reviewer"
    TASK_PLAN_DEPTH_BY_ISSUE["$ISSUE"]="$route_plan_depth"
    TASK_CODE_DEPTH_BY_ISSUE["$ISSUE"]="$route_code_depth"
    TASK_REVIEW_MODE_BY_ISSUE["$ISSUE"]="$route_review_mode"

    TASK_LINEAR_ISSUE_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$challenger_key"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$challenger_key"]="challenger"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_AGENT_BY_ISSUE["$challenger_key"]="${challenger_agent:-$AGENT_CMD}"
    TASK_PLANNER_MODEL_BY_ISSUE["$challenger_key"]="$route_planner"
    TASK_CODER_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$challenger_key"]="$route_reviewer"
    TASK_PLAN_DEPTH_BY_ISSUE["$challenger_key"]="$route_plan_depth"
    TASK_CODE_DEPTH_BY_ISSUE["$challenger_key"]="$route_code_depth"
    TASK_REVIEW_MODE_BY_ISSUE["$challenger_key"]="$route_review_mode"

    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    FINAL_LAUNCH_ARGS+=("$challenger_key|$challenger_slug|$TITLE")
    slots_used=$((slots_used + 1))  # Challenger is free overhead
    log "status" "  $ISSUE: Challenge selected (${primary_model} vs ${challenger_model}) [challenger is extra pane]"
  else
    if [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  $ISSUE: Challenge skipped ($challenge_reason), launching single-model run"
    fi
    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="false"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]=""
    TASK_AGENT_BY_ISSUE["$ISSUE"]="$rec_agent"
    TASK_PLANNER_MODEL_BY_ISSUE["$ISSUE"]="$route_planner"
    TASK_CODER_MODEL_BY_ISSUE["$ISSUE"]="$rec_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$ISSUE"]="$route_reviewer"
    TASK_PLAN_DEPTH_BY_ISSUE["$ISSUE"]="$route_plan_depth"
    TASK_CODE_DEPTH_BY_ISSUE["$ISSUE"]="$route_code_depth"
    TASK_REVIEW_MODE_BY_ISSUE["$ISSUE"]="$route_review_mode"
    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    slots_used=$((slots_used + 1))
  fi
done

LAUNCH_ARGS=("${FINAL_LAUNCH_ARGS[@]}")
# Create monitoring script that will run in tmux
STATUS_LOG_FILE="/tmp/${SESSION}-control-status.log"
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
LAUNCHED_ISSUES_FILE="/tmp/${SESSION}-launched-issues.txt"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/opt/homebrew/bin/bash
set -Eeuo pipefail


# Import environment from env file
source "$1"

# Logging functions - defined early so they're available for all error handling
_log_level_num() {
  case "$1" in
    error) echo 0 ;;
    status) echo 1 ;;
    info) echo 2 ;;
    debug) echo 3 ;;
    *) echo 2 ;;
  esac
}

VERBOSITY_NUM=$(_log_level_num "${DASHBOARD_VERBOSITY:-info}")

append_status_log() {
  local payload="$1"
  [[ -n "${STATUS_LOG_FILE:-}" ]] || return 1

  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '%s\n' "$line" >> "$STATUS_LOG_FILE" 2>/dev/null || return 1
  done <<< "$payload"
}

log() {
  local level="info"
  local msg
  case "${1:-}" in
    error|status|info|debug)
      level="$1"
      shift
      ;;
  esac
  msg="$*"

  local ts formatted msg_num
  ts="$(date '+%H:%M:%S')"
  formatted="$ts $msg"

  if [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] && [[ -n "${MILL_LOG_FILE:-}" ]]; then
    printf '%s [%s] %s\n' "$ts" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
  fi

  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}
log_error() {
  local formatted
  formatted="$(date '+%H:%M:%S') ERROR: $*"
  append_status_log "$formatted" || echo "$formatted" >&2
}
log_warn() {
  local formatted
  formatted="$(date '+%H:%M:%S') WARN: $*"
  append_status_log "$formatted" || echo "$formatted" >&2
}

replay_route_transparency_logs() {
  local stderr_file="$1"
  [[ -s "$stderr_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "[router]"*|"[coder]"*|"[planner]"*|"[reviewer]"*|"[classifier]"*)
        log "info" "$line"
        ;;
    esac
  done < "$stderr_file"
}

# Mirrors save_migration_reservation() from the parent script (see HOK-1377, c6dbb1c precedent).
# Duplicated here because the monitor runs as a standalone shell and does not inherit parent functions.
save_migration_reservation() {
  local issue="$1"
  local num="$2"
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

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

_global_operating_mode() {
  npx tsx "$TOOLS_DIR/get-operating-mode.ts" global --repo-dir "$REPO_DIR" 2>/dev/null || echo "normal"
}

_update_effective_max_parallel() {
  EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"

  if has_any_healthy_model "$REPO_DIR"; then
    return 0
  fi

  local global_mode
  global_mode="$(_global_operating_mode)"
  case "$global_mode" in
    survival)
      if (( MAX_PARALLEL > 1 )); then
        EFFECTIVE_MAX_PARALLEL=1
      fi
      ;;
    constrained)
      if (( MAX_PARALLEL > 3 )); then
        EFFECTIVE_MAX_PARALLEL=3
      fi
      ;;
  esac
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
_update_effective_max_parallel

# Ensure gh commands target the correct GitHub repo (not inherited CWD)
cd "$REPO_DIR"

# Classify API failures conservatively so the monitor only retries errors that
# are likely to succeed on a later attempt.
is_transient_error() {
  local detail="${1:-}"

  [[ -n "$detail" ]] || return 1

  if printf '%s\n' "$detail" | grep -Eiq '(500|502|503|529|internal server error|service unavailable|bad gateway|overloaded)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(429|too many requests|rate limit|rate.limit)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(timeout|timed out|connection.*reset|connection.*refused|network.*error)'; then
    return 0
  fi

  if printf '%s\n' "$detail" | grep -Eiq '(401|403|400|unauthorized|forbidden|bad request|invalid.*key)'; then
    return 1
  fi

  return 1
}

retry_state_file() {
  local session="$1"
  local issue="$2"
  printf '/tmp/wavemill-%s-%s.retry\n' "$session" "$issue"
}

get_retry_count() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"

  if [[ ! -f "$retry_file" ]]; then
    echo "0"
    return 0
  fi

  jq -r '.count // 0' "$retry_file" 2>/dev/null || echo "0"
}

get_retry_timestamp() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"

  if [[ ! -f "$retry_file" ]]; then
    echo "0"
    return 0
  fi

  jq -r '.timestamp // 0' "$retry_file" 2>/dev/null || echo "0"
}

increment_retry_count() {
  local session="$1"
  local issue="$2"
  local retry_file tmp_file current_count new_count timestamp

  retry_file="$(retry_state_file "$session" "$issue")"
  tmp_file="${retry_file}.tmp.$$"
  current_count="$(get_retry_count "$session" "$issue")"
  new_count=$((current_count + 1))
  timestamp="$(date +%s)"

  if jq -n \
    --argjson count "$new_count" \
    --argjson timestamp "$timestamp" \
    '{count: $count, timestamp: $timestamp}' > "$tmp_file" 2>/dev/null; then
    mv "$tmp_file" "$retry_file" 2>/dev/null || rm -f "$tmp_file"
  else
    rm -f "$tmp_file"
  fi
}

reset_retry_count() {
  local retry_file
  retry_file="$(retry_state_file "$1" "$2")"
  rm -f "$retry_file" 2>/dev/null || true
}

get_backoff_delay() {
  local count="${1:-0}"
  case "$count" in
    1) echo "30" ;;
    2) echo "60" ;;
    3) echo "120" ;;
    *) echo "240" ;;
  esac
}

handle_agent_error_recovery() {
  local issue="$1"
  local agent_cmd="$2"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local retry_file hook_state error_detail hook_ts now staleness retry_count last_retry_ts backoff_delay
  local time_since_last_retry time_since_error next_retry max_retries

  retry_file="$(retry_state_file "$SESSION" "$issue")"
  [[ -f "$hook_file" ]] || return 0

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  error_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")

  now="$(date +%s)"
  staleness=$(( now - hook_ts ))
  (( staleness < 300 )) || return 0

  if [[ "$hook_state" != "error" ]]; then
    if [[ -f "$retry_file" ]] && [[ "$hook_state" == "working" || "$hook_state" == "waiting" || "$hook_state" == "idle" ]]; then
      last_retry_ts="$(get_retry_timestamp "$SESSION" "$issue")"
      if (( hook_ts >= last_retry_ts )); then
        log "info" "Agent recovered for $issue, resetting retry count"
        reset_retry_count "$SESSION" "$issue"
      fi
    fi
    return 0
  fi

  if ! is_transient_error "$error_detail"; then
    return 0
  fi

  retry_count="$(get_retry_count "$SESSION" "$issue")"
  max_retries=4
  if (( retry_count >= max_retries )); then
    return 0
  fi

  last_retry_ts="$(get_retry_timestamp "$SESSION" "$issue")"
  backoff_delay="$(get_backoff_delay $((retry_count + 1)))"
  time_since_last_retry=$(( now - last_retry_ts ))

  if (( retry_count == 0 )); then
    time_since_error=$(( now - hook_ts ))
    (( time_since_error >= backoff_delay )) || return 0
  else
    (( time_since_last_retry >= backoff_delay )) || return 0
  fi

  next_retry=$((retry_count + 1))
  log "info" "Retrying $issue after transient error (attempt $next_retry/$max_retries, backoff ${backoff_delay}s): $error_detail"
  increment_retry_count "$SESSION" "$issue"

  if agent_resume_after_error "$SESSION" "$issue" "$agent_cmd"; then
    log "debug" "  Resume command sent to $issue"
  else
    log_error "  Failed to resume $issue after transient error"
  fi
}

transient_error_recovery_pending() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state error_detail hook_ts now staleness retry_count

  [[ -f "$hook_file" ]] || return 1

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  [[ "$hook_state" == "error" ]] || return 1

  error_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  is_transient_error "$error_detail" || return 1

  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")
  now="$(date +%s)"
  staleness=$(( now - hook_ts ))
  (( staleness < 300 )) || return 1

  retry_count="$(get_retry_count "$SESSION" "$issue")"
  (( retry_count < 4 ))
}

# Close auxiliary panes when monitor exits so quitting control is a single action.
_AUX_PANES_CLEANED=0
cleanup_dashboard_pane() {
  [[ "$_AUX_PANES_CLEANED" -eq 1 ]] && return 0
  _AUX_PANES_CLEANED=1

  for pane in 1 2; do
    tmux list-panes -t "$SESSION:control.$pane" >/dev/null 2>&1 || continue
    tmux kill-pane -t "$SESSION:control.$pane" >/dev/null 2>&1 || true
  done
}
trap cleanup_dashboard_pane EXIT INT TERM

# Kill entire tmux session for single-step quit.
quit_and_kill_session() {
  local message="${1:-Quitting.}"
  log "status" "$message"

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
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"

  if ! state_mutate "$STATE_FILE" \
     '(.tasks[$issue].agent // "") as $old_agent |
      (.tasks[$issue].phase // "executing") as $old_phase |
      (.tasks[$issue].evalCompleted // false) as $old_eval |
      (.tasks[$issue].challengeCompared // false) as $old_challenge_compared |
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
        coderModel: (if $coderModel != "" then $coderModel else $old_coderModel end),
        plannerModel: (if $plannerModel != "" then $plannerModel else $old_plannerModel end),
        reviewerModel: (if $reviewerModel != "" then $reviewerModel else $old_reviewerModel end),
        planDepth: (if $planDepth != "" then $planDepth else $old_planDepth end),
        codeDepth: (if $codeDepth != "" then $codeDepth else $old_codeDepth end),
        reviewMode: (if $reviewMode != "" then $reviewMode else $old_reviewMode end),
        phase: $old_phase,
        evalCompleted: $old_eval,
        challengeCompared: $old_challenge_compared,
        updated: (now | todate)
      }' \
     --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
     --arg agent "$agent" --arg linearIssue "$linear_issue" --arg challenge "$challenge" \
     --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
     --arg challengeModel "$challenge_model" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode"; then
    log_warn "save_task_state: failed to save $issue"
  fi
}

update_free_slots_state() {
  local slots="$1"
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  if ! state_mutate "$STATE_FILE" \
     '.freeSlots = $slots | .updated = (now | todate)' \
     --argjson slots "$slots"; then
    log_warn "update_free_slots_state: failed to update free slots"
  fi
}

remove_task_state() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     'del(.tasks[$issue]) | .updated = (now | todate)' \
     --arg issue "$issue"; then
    log_warn "remove_task_state: failed to remove $issue"
  fi
}

set_task_phase() {
  local issue="$1" phase="$2"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     --arg issue "$issue" --arg phase "$phase"; then
    log_warn "set_task_phase: failed to update $issue"
  fi
}

read_state_value() {
  local default="$1"
  shift
  local value

  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '%s\n' "$default"
    return 0
  fi

  if value=$(jq -r "$@" "$STATE_FILE" 2>/dev/null); then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$default"
  fi
}

# Duplicated intentionally: the pre-heredoc definition (~line 595) does not
# enter the generated monitor script, so the monitor needs its own copy to
# service late migration reservations.
save_migration_reservation() {
  local issue="$1"
  local num="$2"
  state_mutate "$STATE_FILE" \
    '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
    --arg issue "$issue" --argjson num "$num" >/dev/null || true
}

get_task_phase() {
  local issue="$1"
  read_state_value "executing" --arg issue "$issue" '.tasks[$issue].phase // "executing"'
}

mark_eval_completed() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].evalCompleted = true | .tasks[$issue].updated = (now | todate)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_completed: failed to update $issue"
  fi
}

mark_eval_failed() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].evalFailed = true | .tasks[$issue].updated = (now | todate)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_failed: failed to update $issue"
  fi
}

eval_record_exists_for_issue_pr() {
  local issue="$1" pr="$2"
  local pr_url evals_dir evals_file

  [[ -z "$issue" || -z "$pr" ]] && return 1

  pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  [[ -z "$pr_url" ]] && return 1

  evals_dir=$(jq -r '.eval.evalsDir // ".wavemill/evals"' "$REPO_DIR/.wavemill-config.json" 2>/dev/null || echo ".wavemill/evals")
  [[ "$evals_dir" != /* ]] && evals_dir="$REPO_DIR/$evals_dir"
  evals_file="$evals_dir/evals.jsonl"
  [[ -r "$evals_file" ]] || return 1

  jq -e --arg issue "$issue" --arg pr_url "$pr_url" '
    select(.issueId == $issue and .prUrl == $pr_url)
  ' "$evals_file" >/dev/null 2>&1
}

validate_agent_set() {
  local issue="$1"
  local agent
  agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  if [[ -z "$agent" ]]; then
    log_warn "  ⚠ BUG: Agent not set for $issue (should have been set at launch), auto-fixing to: $AGENT_CMD"
    # Auto-fix: update the task state with the default agent
    local slug branch worktree pr status
    slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // ""')
    branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // ""')
    worktree=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
    pr=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')
    status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // ""')
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

# ────────────────────────────────────────────────────────────────
# Controller-owned stage result functions (HOK-1177)
# ────────────────────────────────────────────────────────────────

# Write a structured stage result JSON file.
# Usage: write_stage_result <feature_dir> <stage> <status> [agent] [model] [notes] [artifacts_json]
# Stages: routing, planning, coding, review, ready
# Statuses: running, awaiting_user, completed, aborted, failed
# artifacts_json: optional JSON string for stage-specific artifacts (HOK-1192)
write_stage_result() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}" artifacts_json="${7:-}"

  # Try the TypeScript CLI first (HOK-1192: structured writes with artifacts support)
  if [[ -n "${TOOLS_DIR:-}" ]]; then
    local cli_args=("$feature_dir" "$stage" "$status")
    [[ -n "$agent" ]] && cli_args+=(--agent "$agent")
    [[ -n "$model" ]] && cli_args+=(--model "$model")
    [[ -n "$notes" ]] && cli_args+=(--notes "$notes")
    [[ -n "$artifacts_json" ]] && cli_args+=(--artifacts "$artifacts_json")

    if npx tsx "$TOOLS_DIR/stage-result-cli.ts" write "${cli_args[@]}" 2>/dev/null; then
      return 0
    fi
    log_warn "write_stage_result: TypeScript CLI failed, falling back to shell"
  fi

  # Fallback: inline JSON construction (legacy path)
  local result_file="$feature_dir/.${stage}-result.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$feature_dir"

  local started_at="$now"
  if [[ -f "$result_file" ]]; then
    local prev_start
    prev_start=$(jq -r '.startedAt // empty' "$result_file" 2>/dev/null || echo "")
    [[ -n "$prev_start" ]] && started_at="$prev_start"
  fi

  local finished_at="null"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$now\""
  fi

  local tmp
  tmp=$(mktemp) || { log_warn "write_stage_result: mktemp failed"; return 0; }
  cat > "$tmp" <<EOF
{
  "stage": "$stage",
  "status": "$status",
  "startedAt": "$started_at",
  "finishedAt": $finished_at,
  "agent": "$agent",
  "model": "$model",
  "notes": "$notes"
}
EOF
  mv "$tmp" "$result_file"
}

clear_stage_result() {
  local feature_dir="$1" stage="$2"
  rm -f "$feature_dir/.${stage}-result.json"
}

# Read a stage result file, returning its JSON content or empty string.
# Usage: read_stage_result <feature_dir> <stage>
read_stage_result() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]] && jq empty "$result_file" 2>/dev/null; then
    cat "$result_file"
  else
    echo ""
  fi
}

# Read the status field from a stage result file.
# Usage: read_stage_status <feature_dir> <stage>
# Returns the status string or empty.
read_stage_status() {
  local feature_dir="$1" stage="$2"
  local result_file="$feature_dir/.${stage}-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.status // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

# Check if a stage is complete from controller-owned stage results.
# Usage: check_stage_complete <feature_dir> <stage>
# Returns 0 if completed, 1 otherwise.
check_stage_complete() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  [[ "$status" == "completed" ]] && return 0
  return 1
}

# Check if a stage is in awaiting_user state.
# Usage: check_stage_awaiting_user <feature_dir> <stage>
check_stage_awaiting_user() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")
  [[ "$status" == "awaiting_user" ]] && return 0
  return 1
}

# Check whether a stage is actively in progress according to controller-owned state.
# Usage: stage_result_is_in_progress <feature_dir> <stage>
stage_result_is_in_progress() {
  local feature_dir="$1" stage="$2"
  local status
  status=$(read_stage_status "$feature_dir" "$stage")

  case "$stage" in
    planning)
      [[ "$status" == "running" || "$status" == "awaiting_user" ]]
      return $?
      ;;
    coding|review|ready)
      [[ "$status" == "running" ]]
      return $?
      ;;
  esac

  return 1
}

ready_conflict_launch_head() {
  local feature_dir="$1"
  local result_file="$feature_dir/.ready-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.artifacts.launchHead // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

ready_conflict_attention_head() {
  local feature_dir="$1"
  local attention_head_file="$feature_dir/.conflict-attention-head"
  if [[ -f "$attention_head_file" ]]; then
    cat "$attention_head_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

record_ready_conflict_attention() {
  local feature_dir="$1" head="$2"
  mkdir -p "$feature_dir"
  printf '%s\n' "$head" > "$feature_dir/.conflict-attention-head"
  touch "$feature_dir/.conflict-attention-reported"
}

clear_ready_conflict_attention() {
  local feature_dir="$1"
  rm -f "$feature_dir/.conflict-attention-head" "$feature_dir/.conflict-attention-reported"
}

ready_remediation_attempts() {
  local feature_dir="$1"
  local result_file="$feature_dir/.ready-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.artifacts.remediationAttempts // 0' "$result_file" 2>/dev/null || echo "0"
  else
    echo "0"
  fi
}

ready_remediation_launch_head() {
  local feature_dir="$1"
  local result_file="$feature_dir/.ready-result.json"
  if [[ -f "$result_file" ]]; then
    jq -r '.artifacts.remediationLaunchHead // empty' "$result_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

ready_remediation_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local user_json='{}'
  local repo_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    '
    ({ready:{remediation:{enabled:true,maxAttempts:3,agentCmd:""}}} * $user * $repo).ready.remediation
    ' 2>/dev/null || echo '{"enabled":true,"maxAttempts":3,"agentCmd":""}'
}

ready_remediation_enabled() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.enabled // true' <<< "$remediation_json" 2>/dev/null || echo "true"
}

ready_remediation_max_attempts() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.maxAttempts // 3' <<< "$remediation_json" 2>/dev/null || echo "3"
}

ready_remediation_agent_cmd() {
  local wt_dir="$1"
  local remediation_json
  remediation_json=$(ready_remediation_config_json "$wt_dir")
  jq -r '.agentCmd // empty' <<< "$remediation_json" 2>/dev/null || echo ""
}

phase_should_remain_active_without_pr() {
  local feature_dir="$1" phase="$2" slug="$3"

  case "$phase" in
    routing)
      ! check_routing_complete "$slug"
      return $?
      ;;
    planning|coding|review|ready)
      stage_result_is_in_progress "$feature_dir" "$phase"
      return $?
      ;;
  esac

  return 1
}

# Approve a plan: transition planning from awaiting_user to completed.
# Usage: approve_plan <feature_dir> [agent] [model]
approve_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "completed" "$agent" "$model" "Plan approved by user" '{"type":"planning","planFile":"plan.md"}'
}

resolve_stage_result_model() {
  local feature_dir="$1" stage="$2" fallback="${3:-}"
  local model=""

  case "$stage" in
    coding)
      model=$(read_phase_config "$feature_dir" "coding" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "coderModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.coding-result.json" 2>/dev/null || echo "")
      model="$(resolve_phase_model "coding" "$model" "${fallback:-claude-opus-4-7}")"
      ;;
    review)
      model=$(read_phase_config "$feature_dir" "review" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "reviewerModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.review-result.json" 2>/dev/null || echo "")
      model="$(resolve_phase_model "review" "$model" "${fallback:-claude-sonnet-4-6}")"
      ;;
    *)
      model="$fallback"
      ;;
  esac

  printf '%s\n' "$model"
}

# Validate that planning stayed within its phase boundary before coding starts.
# Usage: validate_planning_phase_output <wt_dir>
# Returns non-zero after reverting out-of-scope changes and removing approval.
validate_planning_phase_output() {
  local wt_dir="$1"
  local feature_dir="$wt_dir/features/$(basename "$wt_dir")"
  local changed_file
  local -a out_of_scope_files=()
  local -a tracked_out_of_scope=()
  local -a untracked_out_of_scope=()

  [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]] || return 0

  while IFS= read -r changed_file; do
    [[ -n "$changed_file" ]] || continue
    case "$changed_file" in
      features/*) ;;
      .wavemill/*) ;;
      .claude/settings.local.json) ;;
      *)
        out_of_scope_files+=("$changed_file")
        if git -C "$wt_dir" ls-files --error-unmatch -- "$changed_file" >/dev/null 2>&1; then
          tracked_out_of_scope+=("$changed_file")
        else
          untracked_out_of_scope+=("$changed_file")
        fi
        ;;
    esac
  done < <(
    {
      git -C "$wt_dir" diff --name-only HEAD -- 2>/dev/null || true
      git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null || true
    } | sort -u
  )

  if [[ ${#out_of_scope_files[@]} -eq 0 ]]; then
    return 0
  fi

  log_warn "WARNING: Planning phase modified source code files: ${out_of_scope_files[*]}"

  local cleanup_failed=0

  # Attempt tracked file cleanup
  if [[ ${#tracked_out_of_scope[@]} -gt 0 ]]; then
    git -C "$wt_dir" reset -q HEAD -- "${tracked_out_of_scope[@]}" 2>/dev/null || true

    # Try to checkout each file individually to handle files that don't exist in HEAD
    local file
    for file in "${tracked_out_of_scope[@]}"; do
      if ! git -C "$wt_dir" checkout -- "$file" 2>/dev/null; then
        # If checkout failed, check if file is now untracked and delete it
        if ! git -C "$wt_dir" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
          rm -f "$wt_dir/$file" 2>/dev/null || {
            log_warn "Planning phase validation could not remove untracked file: $file"
            cleanup_failed=1
          }
        else
          log_warn "Planning phase validation could not revert tracked file: $file"
          cleanup_failed=1
        fi
      fi
    done
  fi

  # Always attempt untracked file cleanup (don't skip if tracked cleanup failed)
  if [[ ${#untracked_out_of_scope[@]} -gt 0 ]]; then
    rm -f -- "${untracked_out_of_scope[@]/#/$wt_dir/}" 2>/dev/null || {
      log_warn "Planning phase validation could not remove untracked source changes"
      cleanup_failed=1
    }
  fi

  # Report overall cleanup status
  if [[ $cleanup_failed -eq 1 ]]; then
    log_warn "Planning phase validation encountered cleanup errors"
  fi

  rm -f "$feature_dir/.plan-approved"
  return 1
}

# Warn if coding already created a PR before the review phase can run.
# Usage: validate_coding_phase_output <branch>
validate_coding_phase_output() {
  local branch="$1"
  local pr_number

  pr_number=$(gh pr list --head "$branch" --json number --jq '.[0].number // empty' 2>/dev/null || true)
  if [[ -n "$pr_number" ]]; then
    log_warn "WARNING: Coding phase created PR #$pr_number before review phase"
  fi

  return 0
}

# Reject a plan: transition planning from awaiting_user to failed.
# Usage: reject_plan <feature_dir> [agent] [model]
reject_plan() {
  local feature_dir="$1"
  local agent="${2:-}" model="${3:-}"
  write_stage_result "$feature_dir" "planning" "failed" "$agent" "$model" "Plan rejected by user"
}

# Check if the workflow is aborted (new-style result or legacy marker).
# Usage: check_stage_aborted <feature_dir>
# Checks any stage result for aborted status, then falls back to .workflow-aborted marker.
check_stage_aborted() {
  local feature_dir="$1"

  # 1. Check new-style: any stage result with status=aborted
  local stage result_file
  for stage in planning coding review ready; do
    result_file="$feature_dir/.${stage}-result.json"
    if [[ -f "$result_file" ]]; then
      local status
      status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
      [[ "$status" == "aborted" ]] && return 0
    fi
  done

  # 2. Fallback to legacy marker
  [[ -f "$feature_dir/.workflow-aborted" ]] && return 0

  return 1
}

# Normalize launch outcomes after the controller has already advanced phase state.
# On launch failure, revert the controller phase so the next monitor cycle retries
# the same transition instead of waiting for artifacts that will never arrive.
#
# Usage:
#   handle_phase_launch_result <issue> <feature_dir> <launched_phase> <retry_phase> \
#     <launch_rc> <win> [agent] [model]
# Returns:
#   0 if launch succeeded and callers should continue success handling
#   1 if the outcome was handled here (abort or failure) and callers should stop
handle_phase_launch_result() {
  local issue="$1" feature_dir="$2" launched_phase="$3" retry_phase="$4"
  local launch_rc="$5" win="$6" agent="${7:-}" model="${8:-}"

  if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$feature_dir"; then
    log "status" "⛔ $issue → Workflow aborted during ${launched_phase} launch"
    write_stage_result "$feature_dir" "$launched_phase" "aborted" "$agent" "$model"
    set_task_phase "$issue" "aborted"
    set_window_attention_state "$win" "needs-user"
    return 1
  fi

  if [[ "$launch_rc" -ne 0 ]]; then
    clear_stage_result "$feature_dir" "$launched_phase"
    set_task_phase "$issue" "$retry_phase"
    set_window_attention_state "$win" "needs-user"
    log "warn" "⚠ $issue → ${launched_phase^} phase launch failed (rc=$launch_rc), reverting to $retry_phase for retry"
    return 1
  fi

  return 0
}

# Resolve the current workflow phase from controller-owned stage state.
# Priority: stage result files > default.
# Writes the resolved phase to .resolved-phase for downstream consumers.
#
# Usage: resolve_phase <feature_dir>
# Returns: prints one of: planning, coding, review, ready, aborted, awaiting_user, unknown
resolve_phase() {
  local feature_dir="$1"

  if [[ ! -d "$feature_dir" ]]; then
    echo "unknown"
    return 0
  fi

  # 1. Check for abort first (any stage or legacy marker)
  if check_stage_aborted "$feature_dir"; then
    _persist_phase "$feature_dir" "aborted"
    echo "aborted"
    return 0
  fi

  # 2. Check stages in reverse order (highest stage wins)
  # Ready
  local ready_status
  ready_status=$(read_stage_status "$feature_dir" "ready")
  if [[ "$ready_status" == "completed" ]]; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  # Review
  if check_stage_complete "$feature_dir" "review"; then
    _persist_phase "$feature_dir" "ready"
    echo "ready"
    return 0
  fi

  local review_status
  review_status=$(read_stage_status "$feature_dir" "review")
  if [[ -n "$review_status" ]]; then
    # Review stage exists (running/failed/etc) — we're in review
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  # Coding
  if check_stage_complete "$feature_dir" "coding"; then
    _persist_phase "$feature_dir" "review"
    echo "review"
    return 0
  fi

  local coding_status
  coding_status=$(read_stage_status "$feature_dir" "coding")
  if [[ -n "$coding_status" ]]; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  # Planning
  if check_stage_awaiting_user "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "awaiting_user"
    echo "awaiting_user"
    return 0
  fi

  if check_stage_complete "$feature_dir" "planning"; then
    _persist_phase "$feature_dir" "coding"
    echo "coding"
    return 0
  fi

  local planning_status
  planning_status=$(read_stage_status "$feature_dir" "planning")
  if [[ -n "$planning_status" ]]; then
    _persist_phase "$feature_dir" "planning"
    echo "planning"
    return 0
  fi

  # 3. Default
  _persist_phase "$feature_dir" "planning"
  echo "planning"
  return 0
}

_persist_phase() {
  local feature_dir="$1" phase="$2"
  local tmp
  tmp=$(mktemp) || return 0
  printf '%s\n' "$phase" > "$tmp"
  mv "$tmp" "$feature_dir/.resolved-phase"
}

# Write .phase-config.json with resolved per-stage configuration.
# Usage: write_phase_config <feature_dir> <planner_model> <coder_model> <reviewer_model> \
#                           <plan_depth> <code_depth> <review_mode> [force_model]
write_phase_config() {
  local feature_dir="$1"
  local planner_model="$2" coder_model="$3" reviewer_model="$4"
  local plan_depth="$5" code_depth="$6" review_mode="$7"
  local force_model="${8:-}"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  mkdir -p "$feature_dir"
  local tmp
  tmp=$(mktemp) || { log_warn "write_phase_config: mktemp failed"; return 0; }

  local force_model_json="null"
  [[ -n "$force_model" ]] && force_model_json="\"$force_model\""

  local planner_agent coder_agent reviewer_agent
  planner_agent="$(agent_resolve_from_model "$planner_model")"
  coder_agent="$(agent_resolve_from_model "$coder_model")"
  reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"

  cat > "$tmp" <<EOF
{
  "planning": {
    "model": "$planner_model",
    "agent": "$planner_agent",
    "depth": "$plan_depth"
  },
  "coding": {
    "model": "$coder_model",
    "agent": "$coder_agent",
    "depth": "$code_depth"
  },
  "review": {
    "model": "$reviewer_model",
    "agent": "$reviewer_agent",
    "mode": "$review_mode"
  },
  "resolvedAt": "$now",
  "forceModel": $force_model_json
}
EOF
  mv "$tmp" "$feature_dir/.phase-config.json"
}

# Read a field from .phase-config.json for a given stage.
# Usage: read_phase_config <feature_dir> <stage> <field>
# Example: read_phase_config "$dir" "coding" "model"
read_phase_config() {
  local feature_dir="$1" stage="$2" field="$3"
  local config_file="$feature_dir/.phase-config.json"
  if [[ -f "$config_file" ]]; then
    jq -r --arg s "$stage" --arg f "$field" '.[$s][$f] // empty' "$config_file" 2>/dev/null || echo ""
  else
    echo ""
  fi
}

resolve_phase_model() {
  local stage="$1" model="${2:-}" fallback_model="$3"

  if [[ -z "$model" ]]; then
    printf '%s\n' "$fallback_model"
    return 0
  fi

  if agent_validate_model "$model" "$REPO_DIR" >/dev/null 2>&1; then
    printf '%s\n' "$model"
    return 0
  fi

  if agent_model_looks_like_depth_tag "$model"; then
    log_warn "  Invalid ${stage} model '$model' looks like a depth tag; using '$fallback_model'"
  else
    log_warn "  Invalid ${stage} model '$model'; using '$fallback_model'"
  fi

  printf '%s\n' "$fallback_model"
}

# Ensure a tmux window exists, creating it if missing (e.g. after monitor restart).
_ensure_window_exists() {
  local session="$1" win="$2" wt_dir="$3"
  if ! tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    log_warn "  Window $win missing, recreating..."
    tmux new-window -d -t "$session" -n "$win" -c "$wt_dir" 2>/dev/null || true
    tmux set-option -t "$session:$win" remain-on-exit on 2>/dev/null || true
    sleep 1
  fi
}

# Relaunch an in-flight task's phase agent when its tmux window has been lost
# (typically after a `r`/`a` session resume, which kills the prior tmux session
# before restarting the monitor).
#
# Always returns 0 — the monitor runs under `set -Eeuo pipefail` with an ERR
# trap, so signalling via non-zero return codes would either bail out of the
# monitor or spam error logs. Callers read the outcome from the shell variable
# `_RESTORE_STATE`:
#   none       — window already existed, caller should continue normal processing
#   restored   — agent was relaunched, caller should mark task active and return
#   failed     — restoration failed, caller should flag needs-user and return
_RESTORE_STATE=""
_restore_inflight_task_window_if_missing() {
  local issue="$1" slug="$2" branch="$3" phase="$4"
  local win="${issue}-${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local feature_dir="${wt_dir}/features/${slug}"
  _RESTORE_STATE="none"

  if tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    return 0
  fi

  log "status" "⚡ $issue → tmux window missing after resume, relaunching $phase phase"

  local title issue_json
  title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  if [[ -z "$title" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
    title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
  fi

  local model agent_cmd depth rc=0
  case "$phase" in
    planning)
      model=$(read_phase_config "$feature_dir" "planning" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$issue" "plannerModel")
      model="$(resolve_phase_model "planning" "$model" "claude-sonnet-4-6")"
      depth=$(read_phase_config "$feature_dir" "planning" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "planDepth")
      [[ -z "$depth" ]] && depth="light"
      agent_cmd="$(agent_resolve_from_model "$model")"
      launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent_cmd" "$depth" || rc=$?
      ;;
    coding)
      if ! reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"; then
        log_warn "$issue → expanded reroute helper failed, attempting promotion from existing artifacts"
      fi
      if ! apply_expanded_route_if_present "$feature_dir" "$issue" "$slug" "$wt_dir" "$STATE_FILE"; then
        log_warn "$issue → expanded route invalid; using existing execution state for coding relaunch"
      fi
      model=$(read_phase_config "$feature_dir" "coding" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$issue" "coderModel")
      model="$(resolve_phase_model "coding" "$model" "claude-opus-4-7")"
      depth=$(read_phase_config "$feature_dir" "coding" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "codeDepth")
      [[ -z "$depth" ]] && depth="medium"
      agent_cmd="$(agent_resolve_from_model "$model")"
      launch_coding_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
        "$model" "$agent_cmd" "$depth" || rc=$?
      ;;
    *)
      log_warn "$issue → Cannot restore window for unsupported phase: $phase"
      _RESTORE_STATE="failed"
      return 0
      ;;
  esac

  if [[ "$rc" -ne 0 ]]; then
    log_warn "$issue → Failed to relaunch $phase phase after resume (rc=$rc)"
    _RESTORE_STATE="failed"
    return 0
  fi

  log "status" "✓ $issue → $phase phase relaunched in restored window"
  _RESTORE_STATE="restored"
  return 0
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
#   $5 = slug (optional)
#   $6 = issue ID (optional)
_launch_agent_in_pane() {
  local target="$1" agent_cmd="$2" model="$3" prompt_file="$4" slug="${5:-}" issue="${6:-}"
  local session="${target%%:*}"
  local window="${target#*:}"
  local agent_flags=""
  local abort_check_cmd=""
  local esc_session esc_issue esc_slug

  [[ "$agent_cmd" == "codex" ]] && agent_flags="--dangerously-bypass-approvals-and-sandbox"
  if [[ -n "$slug" ]]; then
    local feature_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
    abort_check_cmd="check_stage_aborted '$feature_dir'"
  fi

  # Export wavemill context environment variables for hook protocol
  esc_session=${session//\'/\'\\\'\'}
  esc_issue=${issue//\'/\'\\\'\'}
  esc_slug=${slug//\'/\'\\\'\'}
  tmux send-keys -t "$target" \
    "export WAVEMILL_SESSION='$esc_session' WAVEMILL_ISSUE='$esc_issue' WAVEMILL_SLUG='$esc_slug'" C-m

  agent_launch_interactive "$session" "$window" "$prompt_file" "$agent_cmd" "$model" "$agent_flags" "$abort_check_cmd"
}

# Launch the planning phase in an existing tmux window
launch_planning_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local planner_model="$7" planner_agent="$8" plan_depth="$9"
  local operating_mode="normal"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"
  configure_agent_hooks "$planner_agent" "$wt_dir" "$REPO_DIR"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$planner_model" "$REPO_DIR")"

  # Build planning prompt
  local prompt_file="/tmp/${SESSION}-${issue}-planning-prompt.txt"
  build_planning_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$plan_depth" "$planner_agent" "$operating_mode" > "$prompt_file"

  log "status" "  Launching planning phase for $issue (model: $planner_model, depth: $plan_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$SESSION:$win" "$planner_agent" "$planner_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Launch the coding phase in an existing tmux window
launch_coding_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local coder_model="$7" coder_agent="$8" code_depth="$9"
  local operating_mode="normal"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"
  configure_agent_hooks "$coder_agent" "$wt_dir" "$REPO_DIR"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$coder_model" "$REPO_DIR")"

  # Build coding prompt
  local prompt_file="/tmp/${SESSION}-${issue}-coding-prompt.txt"
  build_coding_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$code_depth" "$coder_agent" "$operating_mode" > "$prompt_file"

  log "status" "  Launching coding phase for $issue (model: $coder_model, depth: $code_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$SESSION:$win" "$coder_agent" "$coder_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Launch the review phase in an existing tmux window
launch_review_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local reviewer_model="$7" reviewer_agent="$8" review_mode="$9"
  local operating_mode="normal"
  local win="${issue}-${slug}"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  _ensure_window_exists "$SESSION" "$win" "$wt_dir"
  configure_agent_hooks "$reviewer_agent" "$wt_dir" "$REPO_DIR"

  # Read issue context
  local issue_json issue_desc issue_context
  issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")
  issue_context="Issue Description:
$issue_desc
"
  operating_mode="$(get_model_operating_mode "$reviewer_model" "$REPO_DIR")"

  # Build review prompt
  local prompt_file="/tmp/${SESSION}-${issue}-review-prompt.txt"
  build_review_prompt "$title" "$issue" "$wt_dir" "$branch" "$base_branch" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$reviewer_model" "$review_mode" "$reviewer_agent" "$operating_mode" > "$prompt_file"

  log "status" "  Launching review phase for $issue (model: $reviewer_model, mode: $review_mode, operating mode: $operating_mode)"
  _launch_agent_in_pane "$SESSION:$win" "$reviewer_agent" "$reviewer_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Restore the operator-facing review window for an in-review task that already
# has an open PR. On resume we should rebuild the local task context and a
# usable shell window, but we must not relaunch the review prompt because that
# prompt includes PR creation instructions and would conflict with the existing
# PR-backed workflow state.
restore_review_task_window() {
  local issue="$1" slug="$2" branch="$3" pr="$4" wt_dir="$5"
  local win="${issue}-${slug}"
  local feature_dir="$wt_dir/features/$slug"
  local issue_json_file="/tmp/${SESSION}-${issue}-issue.json"
  local task_header_file="$feature_dir/task-packet-header.md"
  local task_details_file="$feature_dir/task-packet-details.md"
  local title issue_json issue_desc linear_issue restored_window recreated_worktree
  local branch_exists=1

  restored_window="false"
  recreated_worktree="false"

  if [[ ! -d "$wt_dir" ]]; then
    if git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      branch_exists=0
    fi

    if [[ "$branch_exists" -ne 0 ]]; then
      log_warn "$issue → Cannot restore review task: branch $branch is missing"
      return 1
    fi

    log "status" "⚡ $issue → Recreating worktree for review task"
    if ! git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >/dev/null 2>&1; then
      log_warn "$issue → Failed to recreate worktree for review task"
      return 1
    fi
    recreated_worktree="true"
  fi

  mkdir -p "$feature_dir"

  if [[ -f "$issue_json_file" ]]; then
    issue_json=$(cat "$issue_json_file" 2>/dev/null || echo "{}")
  else
    linear_issue=$(get_linear_issue_id "$issue")
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    if [[ -n "$issue_json" ]]; then
      printf '%s\n' "$issue_json" > "$issue_json_file"
    fi
  fi

  # Fetch title and description from state or issue data (used for both packet and agent launch)
  title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // ""')
  [[ -z "$title" ]] && title=$(printf '%s' "$issue_json" | jq -r '.title // empty' 2>/dev/null || echo "")
  [[ -z "$title" ]] && title="Task"
  issue_desc=$(printf '%s' "$issue_json" | jq -r '.description // empty' 2>/dev/null || echo "")

  if [[ ! -f "$task_header_file" ]]; then
    cat > "$task_header_file" <<EOF
# $issue - $title

## Resume Context

- Review task restored after session resume
- Branch: \`$branch\`
- Open PR: #$pr
- Worktree: \`$wt_dir\`

## Objective

${issue_desc:-Review the existing PR and complete any follow-up work.}
EOF
  fi

  if [[ ! -f "$task_details_file" ]]; then
    cat > "$task_details_file" <<EOF
# $issue - Review Resume Details

## Current Status

This task already has an open pull request: **#$pr**.

The original review-phase tmux window was not available during resume, so
wavemill recreated the local review context here instead of relaunching PR
creation.

## Review Workspace

- Branch: \`$branch\`
- Worktree: \`$wt_dir\`
- Summary file: \`features/$slug/task-packet-header.md\`

## Issue Description

${issue_desc:-No issue description was available from cached or live issue data.}
EOF
  fi

  if ! tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    log "status" "⚡ $issue → Restoring review window (PR #$pr)"
    tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir" 2>/dev/null || return 1
    tmux set-option -t "$SESSION:$win" remain-on-exit on 2>/dev/null || true
    restored_window="true"
    sleep 1
  fi

  if _pane_is_dead_or_idle "$SESSION:$win"; then
    if declare -F launch_review_phase >/dev/null 2>&1 && declare -F agent_resolve_from_model >/dev/null 2>&1; then
      # Get review phase configuration from state
      local reviewer_model review_mode reviewer_agent
      reviewer_model=$(read_state_value "claude-sonnet-4-6" --arg i "$issue" '.tasks[$i].reviewerModel // "claude-sonnet-4-6"')
      review_mode=$(read_state_value "static+llm" --arg i "$issue" '.tasks[$i].reviewMode // "static+llm"')

      # Resolve agent from model
      reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"

      # Launch review phase agent
      log "status" "  → Relaunching review agent for $issue (model: $reviewer_model, mode: $review_mode)"
      launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" "$reviewer_model" "$reviewer_agent" "$review_mode"
      if [[ $? -eq 0 ]]; then
        log "status" "✓ $issue → Review context restored and agent relaunched for PR #$pr"
      else
        log_warn "$issue → Failed to relaunch review agent"
        if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
          log "status" "✓ $issue → Review context restored for PR #$pr (but agent launch failed)"
        fi
        return 1
      fi
    else
      # Keep the restored window useful in stripped-down test or utility contexts
      # where the full launch stack has not been sourced yet.
      tmux send-keys -t "$SESSION:$win" "cd '$wt_dir'" C-m 2>/dev/null || true
    fi
  fi

  if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
    log "status" "✓ $issue → Review context restored for PR #$pr"
  fi

  return 0
}

ready_state_dir() {
  local wt_dir="$1" slug="$2"

  for dir in features bugs; do
    if [[ -d "$wt_dir/$dir/$slug" ]]; then
      echo "$wt_dir/$dir/$slug"
      return 0
    fi
  done

  echo "$wt_dir/features/$slug"
}

ready_base_sha() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r '.artifacts.readyBaseSha // empty' "$result_file" 2>/dev/null || echo ""
}

get_main_head_sha() {
  local wt_dir="$1" base_branch="$2"
  git -C "$wt_dir" ls-remote origin "refs/heads/${base_branch}" 2>/dev/null | awk '{print $1}' || echo ""
}

ready_stage_allows_merge() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local status verdict

  [[ -f "$result_file" ]] || return 1

  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
  verdict=$(jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo "")

  [[ "$status" == "completed" && ( "$verdict" == "pass" || "$verdict" == "warn" ) ]]
}

# Keep the merged-before-ready warning one-shot per task instance so the
# attention signal persists without spamming every monitor tick.
ready_stage_warn_bypass_once() {
  local state_dir="$1" issue="$2" pr="$3"
  local sentinel="$state_dir/.ready-bypass-warned"

  mkdir -p "$state_dir"
  if [[ -f "$sentinel" ]]; then
    return 1
  fi

  log "status" "⛔ $issue → PR #$pr was merged before ready checks passed"
  : > "$sentinel"
  return 0
}

ready_stage_pending_verdict() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"

  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo ""
}

write_ready_attention_file() {
  local state_dir="$1" message="$2"
  mkdir -p "$state_dir"
  printf '%s\n' "$message" > "$state_dir/.needs-attention"
}

launch_ready_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local pr_number="$7"
  local win="${issue}-${slug}"
  local state_dir status_file result ready_rc merge_status verdict
  local current_agent current_model prompt_file launch_rc launch_head checks_run checks_passed
  local remediation_attempts remediation_launch_head remediation_enabled remediation_max_attempts
  local remediation_agent failed_check_names failed_check_summary current_head ready_status
  local remediation_artifacts_json ci_failed_checks_json ready_result_file ready_stderr_file
  local prior_ready_status prior_ready_verdict pending_log_level

  _ensure_window_exists "$SESSION" "$win" "$wt_dir"
  state_dir="$(ready_state_dir "$wt_dir" "$slug")"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].model // ""')
  [[ -z "$current_agent" ]] && current_agent="$AGENT_CMD"
  prior_ready_status=$(read_stage_status "$state_dir" "ready")
  prior_ready_verdict=$(ready_stage_pending_verdict "$state_dir")
  if [[ "$prior_ready_status" == "running" && "$prior_ready_verdict" == "pending" ]]; then
    pending_log_level="debug"
  else
    pending_log_level="info"
  fi

  log "$pending_log_level" "  Launching ready phase for $issue (PR #$pr_number)"

  ready_stderr_file=$(mktemp) || {
    log_warn "  Failed to capture ready stderr for $issue (mktemp failed)"
    ready_stderr_file=""
  }
  if [[ -n "$ready_stderr_file" ]]; then
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" 2>"$ready_stderr_file"); then
      ready_rc=0
    else
      ready_rc=$?
    fi
    if [[ -s "$ready_stderr_file" ]]; then
      while IFS= read -r line; do
        if [[ "$ready_rc" -ne 0 ]]; then
          log_error "  [ready stderr] $line"
        else
          log "debug" "  [ready stderr] $line"
        fi
      done < "$ready_stderr_file"
    fi
    rm -f "$ready_stderr_file"
  else
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" 2>/dev/null); then
      ready_rc=0
    else
      ready_rc=$?
    fi
  fi

  merge_status=$(printf '%s' "$result" | jq -r '.mergeConflict.status // empty' 2>/dev/null || echo "")
  verdict=$(printf '%s' "$result" | jq -r '.verdict // empty' 2>/dev/null || echo "")
  checks_run=$(printf '%s' "$result" | jq -r '.checks | if type == "array" then length else 0 end' 2>/dev/null || echo "0")
  checks_passed=$(printf '%s' "$result" | jq -r '[.checks[]? | select(.status == "pass")] | length' 2>/dev/null || echo "0")
  remediation_attempts=$(ready_remediation_attempts "$state_dir")
  remediation_launch_head=$(ready_remediation_launch_head "$state_dir")
  ready_status=$(read_stage_status "$state_dir" "ready")
  ready_result_file="$state_dir/.ready-result.json"

  if [[ -z "$merge_status" ]]; then
    log_error "  Ready checks produced unparseable output for $issue"
    [[ -n "$result" ]] && log_error "$result"
    write_ready_attention_file "$state_dir" "Ready stage produced invalid output for PR #$pr_number."
    return 1
  fi

  if [[ "$merge_status" == "CONFLICTED" ]]; then
    mkdir -p "$state_dir"
    if [[ -f "$state_dir/.conflict-detected" ]]; then
      current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      write_ready_attention_file "$state_dir" "PR #$pr_number still has merge conflicts after automatic remediation."
      record_ready_conflict_attention "$state_dir" "$current_head"
      log_error "  Merge conflicts persist for $issue after remediation attempt"
      return 1
    fi
    touch "$state_dir/.conflict-detected"
    rm -f "$state_dir/.needs-attention"
    log "status" "  ⚠ Merge conflict detected for $issue (PR #$pr_number)"

    prompt_file="/tmp/${SESSION}-${issue}-conflict-prompt.txt"
    build_conflict_resolution_prompt "$pr_number" "$branch" "$wt_dir" "$status_file" "$base_branch" > "$prompt_file"
    _launch_agent_in_pane "$SESSION:$win" "$current_agent" "$current_model" "$prompt_file" "$slug"
    launch_rc=$?

    if [[ "$launch_rc" -eq 0 ]]; then
      launch_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
        "Conflict remediation in progress for PR #$pr_number" \
        "{\"type\":\"ready\",\"prNumber\":$pr_number,\"mergeConflict\":\"CONFLICTED\",\"launchHead\":\"$launch_head\"}"
      return 3
    fi
    if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
      return 2
    fi

    write_ready_attention_file "$state_dir" "Automatic merge-conflict resolution could not be launched for PR #$pr_number."
    log_error "  Failed to launch conflict-resolution agent for $issue"
    return 1
  fi

  if [[ "$merge_status" == "UNKNOWN" || "$merge_status" == "ERROR" ]]; then
    write_ready_attention_file "$state_dir" "Ready stage reported merge status $merge_status for PR #$pr_number."
    log_error "  Ready merge status for $issue is $merge_status"
    [[ -n "$result" ]] && log_error "$result"
    return 1
  fi

  rm -f "$state_dir/.conflict-detected" "$state_dir/.needs-attention"
  clear_ready_conflict_attention "$state_dir"

  if [[ "$ready_rc" -eq 0 ]]; then
    # Record ready stage result (HOK-1177)
    local main_sha
    main_sha=$(get_main_head_sha "$wt_dir" "$base_branch")
    write_stage_result "$state_dir" "ready" "completed" "$current_agent" "$current_model" \
      "verdict: ${verdict:-unknown}" \
      "{\"type\":\"ready\",\"verdict\":\"${verdict:-unknown}\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"readyBaseSha\":\"${main_sha}\"}"
    log "  Ready checks completed for $issue (verdict: ${verdict:-unknown})"
    return 0
  fi

  if [[ "$ready_rc" -eq 2 ]]; then
    local pending_artifacts_json
    pending_artifacts_json=$(jq -cn \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson pr_number "${pr_number}" \
      --argjson attempts "${remediation_attempts:-0}" \
      '{
        type: "ready",
        verdict: "pending",
        checksRun: $checks_run,
        checksPassed: $checks_passed,
        mergeConflict: $merge_status,
        prNumber: $pr_number
      } + (if $attempts > 0 then {remediationAttempts: $attempts, remediationFailures: ["ci-status"]} else {} end)')
    write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
      "CI checks pending for PR #$pr_number" \
      "$pending_artifacts_json"
    log "$pending_log_level" "  CI checks pending for $issue (PR #$pr_number) - will retry"
    return 4
  fi

  failed_check_names=$(printf '%s' "$result" | jq -r '[.checks[]? | select(.status == "fail") | .name] | join(",")' 2>/dev/null || echo "")
  remediation_enabled=$(ready_remediation_enabled "$wt_dir")
  remediation_max_attempts=$(ready_remediation_max_attempts "$wt_dir")
  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")

  if [[ "$verdict" == "fail" ]] && [[ "$remediation_enabled" == "true" ]] && [[ "$failed_check_names" == "ci-status" ]]; then
    if [[ "$ready_status" == "running" ]] && [[ -n "$remediation_launch_head" ]] && [[ "$remediation_launch_head" == "$current_head" ]]; then
      return 5
    fi

    if (( remediation_attempts >= remediation_max_attempts )); then
      write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
        "Ready remediation exhausted after ${remediation_attempts} attempt(s)" \
        "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempts},\"remediationFailures\":[\"ci-status\"]}"
      write_ready_attention_file "$state_dir" "Remediation exhausted after ${remediation_attempts} attempt(s) for PR #$pr_number."
      log_error "  Ready remediation exhausted for $issue (failed checks: ci-status)"
      return 1
    fi

    remediation_agent=$(ready_remediation_agent_cmd "$wt_dir")
    [[ -z "$remediation_agent" ]] && remediation_agent="$current_agent"
    [[ -z "$remediation_agent" ]] && remediation_agent="$AGENT_CMD"

    ci_failed_checks_json=$(printf '%s' "$result" | jq -c '
      [.checks[]? | select(.name == "ci-status") | .details.failedChecks // [] | .[]]
    ' 2>/dev/null || echo '[]')
    failed_check_summary=$(printf '%s' "$result" | jq -r '
      .checks[]?
      | select(.name == "ci-status")
      | "ci-status: " + (.message // "CI checks failing")
        + (if ((.details.failedChecks // []) | length) > 0
            then " (" + ((.details.failedChecks // []) | map(.name) | join(", ")) + ")"
            else ""
          end)
    ' 2>/dev/null || echo "ci-status: CI checks failing")

    prompt_file="/tmp/${SESSION}-${issue}-ready-remediation-prompt.txt"
    build_ready_remediation_prompt \
      "$pr_number" \
      "$branch" \
      "$wt_dir" \
      "$status_file" \
      "$base_branch" \
      "$(( remediation_attempts + 1 ))" \
      "$remediation_max_attempts" \
      "$failed_check_summary" \
      "$ready_result_file" > "$prompt_file"

    _launch_agent_in_pane "$SESSION:$win" "$remediation_agent" "$current_model" "$prompt_file" "$slug" "$issue"
    launch_rc=$?

    if [[ "$launch_rc" -eq 0 ]]; then
      remediation_artifacts_json=$(jq -cn \
        --arg merge_status "${merge_status:-UNKNOWN}" \
        --arg launch_head "$current_head" \
        --argjson pr_number "${pr_number}" \
        --argjson checks_run "${checks_run:-0}" \
        --argjson checks_passed "${checks_passed:-0}" \
        --argjson attempts "$(( remediation_attempts + 1 ))" \
        '{
          type: "ready",
          verdict: "fail",
          checksRun: $checks_run,
          checksPassed: $checks_passed,
          mergeConflict: $merge_status,
          prNumber: $pr_number,
          remediationAttempts: $attempts,
          remediationLaunchHead: $launch_head,
          remediationFailures: ["ci-status"]
        }')
      write_stage_result "$state_dir" "ready" "running" "$remediation_agent" "$current_model" \
        "Ready remediation in progress for PR #$pr_number" \
        "$remediation_artifacts_json"
      rm -f "$state_dir/.needs-attention"
      log "status" "⚙ $issue → Launched ready remediation (attempt $(( remediation_attempts + 1 ))/$remediation_max_attempts) for PR #$pr_number"
      return 5
    fi

    if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
      return 2
    fi

    write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
      "Could not launch ready remediation agent" \
      "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempts},\"remediationFailures\":[\"ci-status\"]}"
    write_ready_attention_file "$state_dir" "Could not launch remediation agent for PR #$pr_number."
    log_error "  Failed to launch ready remediation agent for $issue"
    return 1
  fi

  write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" "Ready checks failed"
  write_ready_attention_file "$state_dir" "Ready checks failed for PR #$pr_number."
  log_error "  Ready checks failed for $issue"
  [[ -n "$result" ]] && log_error "$result"
  return 1
}

# Controller-owned feature-directory readiness check (HOK-1183).
# Evaluates phase state without requiring a PR or GitHub CLI.
# Returns JSON to stdout; exits 0 if ready, 1 otherwise.
#
# Usage: check_ready_stage <feature_dir>
#
# Full phase-transition wiring is deferred to HOK-1177.
check_ready_stage() {
  local feature_dir="$1"
  if [[ -z "$feature_dir" ]]; then
    echo '{"error":"feature_dir argument required"}' >&2
    return 1
  fi
  npx tsx "$TOOLS_DIR/controller-ready.ts" "$feature_dir" 2>/dev/null
  return $?
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
  read_state_value "" --arg issue "$issue" --arg field "$field" '.tasks[$issue][$field] // empty'
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

should_cleanup_closed_pr() {
  local issue="$1"
  local role
  role=$(get_task_meta "$issue" "challengeRole")
  [[ "$role" == "challenger" && "${_CFG_CHALLENGE_AUTO_MERGE:-false}" != "true" ]]
}

is_challenge_task() {
  local issue="$1"
  [[ "$(get_task_meta "$issue" "challenge")" == "true" ]]
}

get_challenge_sibling_pr() {
  local issue="$1"
  local pair_id role sibling_key

  pair_id=$(get_task_meta "$issue" "challengePairId")
  role=$(get_task_meta "$issue" "challengeRole")

  [[ -z "$pair_id" || -z "$role" ]] && return 1

  if [[ "$role" == "primary" ]]; then
    sibling_key="${pair_id}_c"
  elif [[ "$role" == "challenger" ]]; then
    sibling_key="$pair_id"
  else
    return 1
  fi

  read_state_value "" --arg issue "$sibling_key" '.tasks[$issue].pr // empty'
}

# Check if a challenge task's sibling PR was merged.
# Returns 0 if merged, 1 if not merged or unavailable.
check_challenge_sibling_merged() {
  local issue="$1"
  local sibling_pr

  sibling_pr=$(get_challenge_sibling_pr "$issue")
  [[ -z "$sibling_pr" ]] && return 1

  validate_pr_merge "$sibling_pr"
}

mark_challenge_compared() {
  local pair_id="$1"
  if ! state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.challengeCompared = true
      else
        .
      end
    )' --arg pair "$pair_id"; then
    log_warn "mark_challenge_compared: failed for $pair_id"
  fi
}

maybe_run_challenge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4"
  local eval_completed pair_id solution_model linear_issue eval_agent rc
  eval_completed=$(read_state_value "false" --arg i "$issue" '.tasks[$i].evalCompleted // false')
  [[ "$eval_completed" == "true" ]] && return 0

  pair_id=$(get_task_meta "$issue" "challengePairId")
  solution_model=$(get_task_meta "$issue" "challengeModel")
  linear_issue=$(get_linear_issue_id "$issue")
  eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"

  local eval_log="/tmp/${SESSION}-eval-${issue}.log"
  if _with_timeout 420 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
    --issue "$linear_issue" --pr "$pr" --branch "$branch" \
    --worktree "${WORKTREE_ROOT}/${slug}" \
    --workflow-type mill --repo-dir "$REPO_DIR" \
    --agent "$eval_agent" \
    --solution-model "$solution_model" \
    --challenge-pair "$pair_id" \
    --debug \
    >"$eval_log" 2>&1; then
    rc=0
  else
    rc=$?
  fi
  while IFS= read -r line; do log "debug" "  [challenge-eval] $line"; done < "$eval_log"
  rm -f "$eval_log"
  if [[ "$rc" -eq 0 ]]; then
    mark_eval_completed "$issue"
  elif eval_record_exists_for_issue_pr "$linear_issue" "$pr"; then
    log_warn "challenge eval for $issue exited $rc but a persisted eval record exists; marking evalCompleted=true"
    mark_eval_completed "$issue"
  else
    log_warn "challenge eval failed for $issue (exit $rc); setting evalFailed=true"
    mark_eval_failed "$issue"
  fi
}

launch_background_post_merge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4" issue_ref="$5" reason="$6" preresolved_agent="${7:-}"
  local eval_agent eval_log rc

  if [[ -n "$preresolved_agent" ]]; then
    eval_agent="$preresolved_agent"
  else
    validate_agent_set "$issue"
    eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
    [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
  fi

  eval_log="/tmp/${SESSION}-eval-${issue}.log"
  : >"$eval_log"

  (
    {
      printf 'Launching %s eval in background\n' "$reason"
      if [[ -n "$pr" ]]; then
        if _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --pr "$pr" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      else
        if _with_timeout 120 npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      fi
      printf 'Eval process exited with code %s\n' "$rc"
      if [[ "$rc" -eq 0 ]]; then
        mark_eval_completed "$issue"
      else
        printf 'WARN: Eval failed for %s; setting evalFailed=true\n' "$issue"
        mark_eval_failed "$issue"
      fi
    } >>"$eval_log" 2>&1
  ) >/dev/null 2>&1 &

  log "debug" "  ↳ Eval running in background; log: $eval_log"
}

maybe_run_challenge_comparison() {
  local issue="$1"
  local pair_id primary_key challenger_key compared primary_pr challenger_pr primary_eval challenger_eval linear_issue primary_model challenger_model compare_log
  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -z "$pair_id" ]] && return 0
  primary_key="$pair_id"
  challenger_key="${pair_id}_c"
  compared=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].challengeCompared // false')
  [[ "$compared" == "true" ]] && return 0

  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  primary_eval=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_eval=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
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

  compare_log="/tmp/${SESSION}-compare-${pair_id}.log"
  if ! _with_timeout 60 npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --repo-dir "$REPO_DIR" --check-only >"$compare_log" 2>&1; then
    log_warn "challenge comparison skipped for $pair_id: evalCompleted=true but eval records are missing"
    while IFS= read -r line; do log "debug" "  [challenge-compare] $line"; done < "$compare_log"
    rm -f "$compare_log"
    return 0
  fi
  rm -f "$compare_log"

  log "status" "  ⚖ Running challenge comparison for $pair_id"
  compare_log="/tmp/${SESSION}-compare-${pair_id}.log"
  if _with_timeout 240 npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --primary-planner "$primary_planner" --primary-reviewer "$primary_reviewer" \
    --primary-plan-depth "$primary_plan_depth" --primary-code-depth "$primary_code_depth" --primary-review-mode "$primary_review_mode" \
    --challenger-planner "$challenger_planner" --challenger-reviewer "$challenger_reviewer" \
    --challenger-plan-depth "$challenger_plan_depth" --challenger-code-depth "$challenger_code_depth" --challenger-review-mode "$challenger_review_mode" \
    --repo-dir "$REPO_DIR" --comment >"$compare_log" 2>&1; then
    mark_challenge_compared "$pair_id"

    # Read comparison result from challenge records
    local compare_json winner winner_model rationale
    local comp_p comp_c cor_p cor_c qual_p qual_c impact_p impact_c auto_p auto_c
    local primary_eval_score challenger_eval_score
    compare_json=$(tail -1 "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" 2>/dev/null)
    winner=$(echo "$compare_json" | jq -r '.winner // empty' 2>/dev/null)
    winner_model=$(echo "$compare_json" | jq -r '.winnerModel // empty' 2>/dev/null)
    rationale=$(echo "$compare_json" | jq -r '.rationale // empty' 2>/dev/null)
    primary_eval_score=$(echo "$compare_json" | jq -r '.primaryEvalScore // "—"' 2>/dev/null)
    challenger_eval_score=$(echo "$compare_json" | jq -r '.challengerEvalScore // "—"' 2>/dev/null)
    comp_p=$(echo "$compare_json" | jq -r '.dimensions.completeness.primary // "—"' 2>/dev/null)
    comp_c=$(echo "$compare_json" | jq -r '.dimensions.completeness.challenger // "—"' 2>/dev/null)
    cor_p=$(echo "$compare_json" | jq -r '.dimensions.correctness.primary // "—"' 2>/dev/null)
    cor_c=$(echo "$compare_json" | jq -r '.dimensions.correctness.challenger // "—"' 2>/dev/null)
    qual_p=$(echo "$compare_json" | jq -r '.dimensions.code_quality.primary // .dimensions.codeQuality.primary // "—"' 2>/dev/null)
    qual_c=$(echo "$compare_json" | jq -r '.dimensions.code_quality.challenger // .dimensions.codeQuality.challenger // "—"' 2>/dev/null)
    impact_p=$(echo "$compare_json" | jq -r '.dimensions.intervention_impact.primary // .dimensions.scopeDiscipline.primary // "—"' 2>/dev/null)
    impact_c=$(echo "$compare_json" | jq -r '.dimensions.intervention_impact.challenger // .dimensions.scopeDiscipline.challenger // "—"' 2>/dev/null)
    auto_p=$(echo "$compare_json" | jq -r '.dimensions.autonomy.primary // "—"' 2>/dev/null)
    auto_c=$(echo "$compare_json" | jq -r '.dimensions.autonomy.challenger // "—"' 2>/dev/null)

    # Shorten model names for display (strip date suffix)
    local disp_primary disp_challenger disp_winner
    disp_primary=$(echo "$primary_model" | sed 's/-[0-9]\{8\}$//')
    disp_challenger=$(echo "$challenger_model" | sed 's/-[0-9]\{8\}$//')
    disp_winner=$(echo "$winner_model" | sed 's/-[0-9]\{8\}$//')

    # Display formatted comparison summary
    log "status" ""
    log "status" "  ┌────────────────────────────────────────────────────────────┐"
    log "status" "  │  ⚖  Challenge Comparison: $pair_id"
    log "status" "  ├────────────────────────────────────────────────────────────┤"
    log "status" "  │                    Primary            Challenger           │"
    log "status" "  │  Model          $(printf '%-20s' "$disp_primary") $(printf '%-19s' "$disp_challenger")│"
    log "status" "  │  PR              #$(printf '%-19s' "$primary_pr") #$(printf '%-18s' "$challenger_pr")│"
    log "status" "  │  Eval Score      $(printf '%-20s' "$primary_eval_score") $(printf '%-19s' "$challenger_eval_score")│"
    log "status" "  ├────────────────────────────────────────────────────────────┤"
    log "status" "  │  Completeness    $(printf '%-20s' "$comp_p") $(printf '%-19s' "$comp_c")│"
    log "status" "  │  Correctness     $(printf '%-20s' "$cor_p") $(printf '%-19s' "$cor_c")│"
    log "status" "  │  Code Quality    $(printf '%-20s' "$qual_p") $(printf '%-19s' "$qual_c")│"
    log "status" "  │  Intervention    $(printf '%-20s' "$impact_p") $(printf '%-19s' "$impact_c")│"
    log "status" "  │  Autonomy        $(printf '%-20s' "$auto_p") $(printf '%-19s' "$auto_c")│"
    log "status" "  ├────────────────────────────────────────────────────────────┤"
    if [[ "$winner" == "primary" ]]; then
      log "status" "  │  ★ Winner: Primary ($disp_winner) — PR #$primary_pr"
    else
      log "status" "  │  ★ Winner: Challenger ($disp_winner) — PR #$challenger_pr"
    fi
    log "status" "  │                                                            │"
    # Word-wrap rationale to ~56 chars per line
    echo "$rationale" | fold -s -w 56 | while IFS= read -r rline; do
      log "status" "  │  $(printf '%-58s' "$rline")│"
    done
    log "status" "  └────────────────────────────────────────────────────────────┘"
    log "status" ""

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
          log "status" "  ⚖ Auto-merge enabled: cleaning up losing side: $loser_key"
          # Close PR if not already closed/merged
          if [[ -n "$loser_pr" ]] && [[ "$(pr_state "$loser_pr")" == "OPEN" ]]; then
            gh pr close "$loser_pr" \
              --comment "Closing: lost challenge comparison to ${winner} side." 2>/dev/null || true
            log "status" "  ✓ Closed losing PR #$loser_pr"
          fi
          cleanup_completed_task "$loser_key" "$loser_slug" "challenge loser"
        else
          log "status" "  ⚖ Both PRs remain open for manual review (autoMergeWinner=false)"
        fi
      fi
    fi
  else
    while IFS= read -r line; do log_warn "  [challenge-compare] $line"; done < "$compare_log"
  fi
  rm -f "$compare_log"
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
    if [[ -f "$feature_dir/.routing-complete" ]]; then
      if jq -e . "$feature_dir/.routing-complete" >/dev/null 2>&1; then
        cp "$feature_dir/.routing-complete" "$archive_dir/routing-complete.json" 2>/dev/null || true
      else
        log_warn "  Skipping invalid route artifact archive: $feature_dir/.routing-complete"
      fi
    fi

    # Post-expansion route
    if [[ -f "$feature_dir/.post-expansion-route.json" ]]; then
      if jq -e . "$feature_dir/.post-expansion-route.json" >/dev/null 2>&1; then
        cp "$feature_dir/.post-expansion-route.json" "$archive_dir/post-expansion-route.json" 2>/dev/null || true
      else
        log_warn "  Skipping invalid route artifact archive: $feature_dir/.post-expansion-route.json"
      fi
    fi
  fi

  # Count archived files for logging
  local count
  count=$(find "$archive_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    log "debug" "  ✓ Archived $count stage artifact(s) to .wavemill/evals/artifacts/$issue/"
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
  log "debug" "  ✓ Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    git -C "$REPO_DIR" worktree remove "$wt_dir" --force >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "  ✓ Removed worktree: $wt_dir"
  fi

  # Delete branch after removing the worktree so Git can detach cleanly first.
  local task_branch="task/${slug}"
  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    git -C "$REPO_DIR" branch -D "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "  ✓ Deleted local branch: $task_branch"
    if git -C "$REPO_DIR" push origin --delete "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "  ✓ Deleted remote branch: $task_branch"
    else
      log "debug" "  ℹ Remote branch already deleted or push failed: $task_branch"
    fi
  fi

  # Clean up state
  git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
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
  local cached
  cached=$(wavemill_pr_lookup_by_branch "$branch")
  if [[ -n "$cached" ]]; then
    echo "$cached"
    return
  fi
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

prepare_route_input_for_issue() {
  local issue="$1" slug="$2" title="$3"
  local linear_issue issue_json issue_desc packet_file feature_dir selected_task_file

  linear_issue=$(get_linear_issue_id "$issue")
  packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  feature_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
  selected_task_file="$feature_dir/selected-task.json"

  if [[ -f "/tmp/${SESSION}-${issue}-issue.json" ]]; then
    issue_json=$(cat "/tmp/${SESSION}-${issue}-issue.json" 2>/dev/null || echo "{}")
  else
    issue_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/get-issue.ts" "$linear_issue" --json 2>/dev/null || echo "{}")
    echo "$issue_json" > "/tmp/${SESSION}-${issue}-issue.json"
  fi

  issue_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

  if [[ ! -s "$packet_file" ]]; then
    if [[ -f "$selected_task_file" ]] && jq -e '.title or .description' "$selected_task_file" >/dev/null 2>&1; then
      jq -r '[(.title // ""), (.description // "")] | map(select(length > 0)) | join("\n\n")' \
        "$selected_task_file" > "$packet_file" 2>/dev/null || true
      [[ -s "$packet_file" ]] && log "info" "  Created minimal routing packet from selected-task.json"
    fi
  fi

  if [[ ! -s "$packet_file" ]]; then
    printf '%s\n\n%s\n' "$title" "$issue_desc" > "$packet_file"
    log "info" "  Created minimal routing packet from title and description"
  fi

  if [[ -s "$packet_file" ]]; then
    printf '%s\n' "$packet_file"
    return 0
  fi

  return 1
}

apply_route_json_for_issue() {
  local issue="$1" route_json="$2" source="${3:-startup-cache}"
  local route_file="/tmp/${SESSION}-${issue}-route.json"
  local route_source_file="/tmp/${SESSION}-${issue}-route-source.txt"
  local input_kind="cache"
  local route_mode
  route_mode="$(_global_operating_mode)"

  if [[ -z "$route_json" ]] || ! echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
    return 1
  fi

  if [[ "$source" == "heuristic-fallback" ]]; then
    input_kind="heuristic"
  fi

  route_json="$(echo "$route_json" | jq -c \
    --arg source "$source" \
    --arg inputKind "$input_kind" \
    --arg routerMode "$route_mode" \
    '(.provenance // {}) as $p
    | .provenance = ($p + {
        source: $source,
        inputKind: ($p.inputKind // $inputKind),
        inputPath: ($p.inputPath // ""),
        inputHash: ($p.inputHash // ""),
        routedAt: ($p.routedAt // (now | todateiso8601)),
        routerMode: ($p.routerMode // $routerMode)
      })')"

  printf '%s\n' "$route_json" > "$route_file"
  printf '%s\n' "$source" > "$route_source_file"
  return 0
}

batch_route_selected_tasks() {
  local selected_lines="$1"
  local route_batch_tool="$TOOLS_DIR/route-tasks.ts"
  local route_jsonl_file route_output_file route_stderr_file
  local count=0 idx issue slug title packet_file route_json
  local -a route_issues=()
  local -a route_lines=()
  local -a route_max_cost_args=()

  if [[ "${ROUTER_ENABLED:-true}" != "true" ]] || [[ ! -f "$route_batch_tool" ]] || [[ -z "$selected_lines" ]]; then
    return 1
  fi

  route_jsonl_file="/tmp/${SESSION}-dynamic-route-batch-input.jsonl"
  route_output_file="/tmp/${SESSION}-dynamic-route-batch-output.jsonl"
  route_stderr_file="/tmp/${SESSION}-dynamic-route-batch.stderr"

  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")
  : > "$route_jsonl_file"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    IFS='|' read -r issue slug title _sel_area _sel_score _sel_blocked <<<"$line"
    if packet_file=$(prepare_route_input_for_issue "$issue" "$slug" "$title"); then
      jq -cn \
        --arg issueId "$issue" \
        --arg file "$packet_file" \
        --arg source "expanded" \
        --arg inputKind "task-packet" \
        '{issueId: $issueId, file: $file, source: $source, inputKind: $inputKind}' >> "$route_jsonl_file"
      printf '\n' >> "$route_jsonl_file"
      route_issues+=("$issue")
      count=$((count + 1))
    fi
  done <<<"$selected_lines"

  if (( count < 2 )); then
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  if ! _with_timeout "$API_TIMEOUT" npx tsx "$route_batch_tool" --jsonl "$route_jsonl_file" --repo-dir "$REPO_DIR" "${route_max_cost_args[@]}" >"$route_output_file" 2>"$route_stderr_file"; then
    replay_route_transparency_logs "$route_stderr_file"
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  replay_route_transparency_logs "$route_stderr_file"
  mapfile -t route_lines < <(grep -v '^[[:space:]]*$' "$route_output_file" 2>/dev/null || true)
  if (( ${#route_lines[@]} != count )); then
    rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
    return 1
  fi

  for idx in "${!route_lines[@]}"; do
    issue="${route_issues[$idx]}"
    route_json="${route_lines[$idx]}"
    if ! apply_route_json_for_issue "$issue" "$route_json" "batch-cache"; then
      rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
      return 1
    fi
  done

  rm -f "$route_jsonl_file" "$route_output_file" "$route_stderr_file"
  return 0
}

append_expanded_reroute_input() {
  local jsonl_file="$1" issue="$2" slug="$3" feature_dir="$4"
  local output_file="$feature_dir/.post-expansion-route.json"
  local full_packet="$feature_dir/task-packet.md"
  local header_file="$feature_dir/task-packet-header.md"
  local details_file="$feature_dir/task-packet-details.md"

  if [[ -f "$full_packet" ]]; then
    jq -cn \
      --arg issueId "$issue" \
      --arg slug "$slug" \
      --arg featureDir "$feature_dir" \
      --arg packetFile "$full_packet" \
      --arg outputFile "$output_file" \
      '{issueId: $issueId, slug: $slug, featureDir: $featureDir, packetFile: $packetFile, outputFile: $outputFile}' >> "$jsonl_file"
    printf '\n' >> "$jsonl_file"
    return 0
  fi

  if [[ -f "$header_file" && -f "$details_file" ]]; then
    jq -cn \
      --arg issueId "$issue" \
      --arg slug "$slug" \
      --arg featureDir "$feature_dir" \
      --arg headerFile "$header_file" \
      --arg detailsFile "$details_file" \
      --arg outputFile "$output_file" \
      '{issueId: $issueId, slug: $slug, featureDir: $featureDir, headerFile: $headerFile, detailsFile: $detailsFile, outputFile: $outputFile}' >> "$jsonl_file"
    printf '\n' >> "$jsonl_file"
    return 0
  fi

  return 1
}

reroute_expanded_packets_for_coding_handoff() {
  local current_issue="$1" current_slug="$2" current_feature_dir="$3"
  local route_batch_tool="$TOOLS_DIR/route-tasks.ts"
  local input_file output_file stderr_file
  local -a route_max_cost_args=()
  local count=0

  if [[ ! -f "$route_batch_tool" ]]; then
    return 1
  fi

  input_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-input.jsonl"
  output_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-output.jsonl"
  stderr_file="/tmp/${SESSION}-${current_issue}-expanded-reroute.stderr"
  : > "$input_file"

  if ! append_expanded_reroute_input "$input_file" "$current_issue" "$current_slug" "$current_feature_dir"; then
    rm -f "$input_file" "$output_file" "$stderr_file"
    return 1
  fi
  count=$((count + 1))

  if [[ -f "${STATE_FILE:-}" ]]; then
    while IFS=$'\t' read -r issue slug worktree; do
      [[ -n "$issue" && -n "$slug" && -n "$worktree" ]] || continue
      [[ "$issue" == "$current_issue" ]] && continue

      local feature_dir="$worktree/features/$slug"
      [[ -d "$feature_dir" ]] || continue
      [[ -f "$feature_dir/.post-expansion-route.json" ]] && continue
      [[ -f "$feature_dir/.coding-result.json" ]] && continue
      [[ -f "$feature_dir/.planning-result.json" ]] || continue
      if ! jq -e '.status == "completed"' "$feature_dir/.planning-result.json" >/dev/null 2>&1; then
        continue
      fi

      if append_expanded_reroute_input "$input_file" "$issue" "$slug" "$feature_dir"; then
        count=$((count + 1))
      fi
    done < <(jq -r '.tasks | to_entries[] | [.key, (.value.slug // ""), (.value.worktree // "")] | @tsv' "$STATE_FILE" 2>/dev/null || true)
  fi

  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")

  if ! _with_timeout "$API_TIMEOUT" npx tsx "$route_batch_tool" \
    --expanded-jsonl "$input_file" \
    --repo-dir "$REPO_DIR" \
    "${route_max_cost_args[@]}" >"$output_file" 2>"$stderr_file"; then
    replay_route_transparency_logs "$stderr_file"
    if [[ -f "$current_feature_dir/.post-expansion-route.json" ]]; then
      rm -f "$input_file" "$output_file" "$stderr_file"
      return 0
    fi
    rm -f "$input_file" "$output_file" "$stderr_file"
    return 1
  fi

  replay_route_transparency_logs "$stderr_file"
  rm -f "$input_file" "$output_file" "$stderr_file"
  return 0
}


# ============================================================================
# BACKLOG FETCHING & CANDIDATE SCORING
# ============================================================================

BACKLOG_CACHE=""
BACKLOG_JSON_CACHE=""
QUEUE_PLAN_CACHE=""
LAST_BACKLOG_FETCH=0
LAST_QUEUE_PLAN_FETCH=0
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
    BACKLOG_JSON_CACHE=""
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    LAST_BACKLOG_FETCH=$now
    return
  fi

  BACKLOG_JSON_CACHE="$backlog_json"
  QUEUE_PLAN_CACHE=""
  LAST_QUEUE_PLAN_FETCH=0

  # Use shared scoring function from wavemill-common.sh (eliminates duplication)
  # Strip has_detailed_plan (field 6) to match pick_candidates() 6-field format:
  # identifier|slug|title|area|score|blocked_by_count
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30 | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}')
  LAST_BACKLOG_FETCH=$now
  echo "$BACKLOG_CACHE"
}

fetch_queue_plan() {
  local now plan_input queue_plan
  now=$(date +%s)

  if (( now - LAST_QUEUE_PLAN_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$QUEUE_PLAN_CACHE" ]]; then
    echo "$QUEUE_PLAN_CACHE"
    return 0
  fi

  [[ -n "$BACKLOG_JSON_CACHE" ]] || return 1

  plan_input=$(jq -c '
    map({
      id: .identifier,
      title: .title,
      sharedSurface: ((.sharedSurface // []) | sort),
      dependsOn: (
        (.inverseRelations.nodes // [])
        | map(select(.type == "blocks" and .issue.identifier != null) | .issue.identifier)
        | sort
      )
    })
  ' <<<"$BACKLOG_JSON_CACHE" 2>/dev/null) || return 1

  queue_plan=$(printf '%s\n' "$plan_input" | _with_timeout 15 npx tsx "$TOOLS_DIR/plan-queue.ts" --stdin --json 2>/dev/null) || return 1

  jq -e '
    has("availableNow")
    and has("queuedAfterDependencies")
    and has("avoidRunningTogether")
    and has("needsTriage")
  ' >/dev/null 2>&1 <<<"$queue_plan" || return 1

  QUEUE_PLAN_CACHE="$queue_plan"
  LAST_QUEUE_PLAN_FETCH=$now
  echo "$QUEUE_PLAN_CACHE"
}

render_grouped_task_list() {
  local queue_plan="$1" available="$2"
  local counter=0 output="" select_lines="" section_body="" line rec group_index task_id blockers triage_id
  declare -A id_to_record=()

  jq -e . >/dev/null 2>&1 <<<"$queue_plan" || return 1

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    task_id=${line%%|*}
    [[ -n "$task_id" ]] && id_to_record["$task_id"]="$line"
  done <<<"$available"

  section_body=""
  while IFS= read -r task_id; do
    [[ -n "$task_id" ]] || continue
    rec="${id_to_record[$task_id]:-}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    section_body+=$(printf '  %s. %s - %s\n' "$counter" "$task_id" "$title")
    select_lines+="${rec}"$'\n'
  done < <(jq -r '.availableNow[]?' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    output+="Available Now - Parallel Wave 1"$'\n'
    output+="${section_body}"
  fi

  section_body=""
  while IFS=$'\t' read -r task_id blockers; do
    [[ -n "$task_id" ]] || continue
    rec="${id_to_record[$task_id]:-}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    section_body+=$(printf '  %s. %s - %s (blocked by: %s)\n' "$counter" "$task_id" "$title" "$blockers")
    select_lines+="${rec}"$'\n'
  done < <(jq -r '.queuedAfterDependencies[]? | [.taskId, (.ancestors | join(", "))] | @tsv' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Queued After Dependencies"$'\n'
    output+="${section_body}"
  fi

  section_body=""
  group_index=0
  while IFS= read -r blockers; do
    [[ -n "$blockers" ]] || continue
    group_index=$((group_index + 1))
    local cluster_body=""
    while IFS= read -r task_id; do
      [[ -n "$task_id" ]] || continue
      rec="${id_to_record[$task_id]:-}"
      [[ -n "$rec" ]] || continue
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      cluster_body+=$(printf '    %s. %s - %s\n' "$counter" "$task_id" "$title")
      select_lines+="${rec}"$'\n'
    done < <(jq -r '.[]' <<<"$blockers" 2>/dev/null)
    if [[ -n "$cluster_body" ]]; then
      section_body+=$(printf '  [conflict cluster %s]\n%s' "$group_index" "$cluster_body")
    fi
  done < <(jq -c '.avoidRunningTogether[]?' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Avoid Running Together"$'\n'
    output+="${section_body}"
  fi

  section_body=""
  while IFS= read -r triage_id; do
    [[ -n "$triage_id" ]] || continue
    rec="${id_to_record[$triage_id]:-}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    section_body+=$(printf '  %s. %s - %s [triage]\n' "$counter" "$task_id" "$title")
    select_lines+="${rec}"$'\n'
  done < <(jq -r '.needsTriage[]? | .edge.to' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Needs Triage"$'\n'
    output+="${section_body}"
  fi

  (( counter > 0 )) || return 1

  GROUPED_SELECT_FROM="${select_lines%$'\n'}"
  GROUPED_DISPLAY="${output%$'\n'}"
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
  local feature_dir="${wt_dir}/features/${slug}"
  local linear_issue="$issue"
  local challenge_model=""
  LAST_LAUNCHED_SLOTS=1

  linear_issue=$(get_linear_issue_id "$issue")
  challenge_model=$(get_task_meta "$issue" "challengeModel")

  log "status" "Launching $issue: $title"

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
      log "info" "  ✓ $issue has task packet"
    else
      log "info" "  ✓ $issue raw description saved (agent will expand)"
    fi
    echo "$issue_desc" > "$packet_file"
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Refresh base branch on a TTL so repeated dynamic launches avoid redundant fetches.
  wavemill_fetch_base_branch "$BASE_BRANCH" 2>/dev/null || true

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
    if ! state_mutate "$STATE_FILE" \
       '.migrationReservations[$issue] = $num | .nextMigrationNum = ($num + 1)' \
       --arg issue "$issue" --argjson num "$next_num"; then
      log_warn "Failed to persist migration reservation for $issue"
    fi

    # Re-read packet content with migration hint included
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
    log "debug" "  → Migration detected, assigned number: $next_num"
  fi

  # Create worktree + branch
  local created_new=false
  if [[ -d "$wt_dir" ]]; then
    log "info" "  Worktree exists: $wt_dir (resuming)"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
    log "info" "  Branch $branch exists, resuming"
    if ! git -C "$REPO_DIR" worktree add "$wt_dir" "$branch" >>"$MILL_LOG_FILE" 2>&1; then
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    fi
    created_new=true
  else
    log "info" "  Creating branch $branch from origin/$BASE_BRANCH"
    if ! git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$BASE_BRANCH" >>"$MILL_LOG_FILE" 2>&1; then
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    fi
    created_new=true
  fi
  mkdir -p "$feature_dir"

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
    log "info" "  Challenge: $task_agent_cmd --model $task_model (planner=$planner_model, reviewer=$reviewer_model)"
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
    log "info" "  FORCE_MODEL: $task_agent_cmd --model $task_model"
  elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]]; then
    local route_tool="$TOOLS_DIR/route-task.ts"
    if [[ "${ROUTER_ENABLED:-true}" == "true" ]] && [[ -f "$route_tool" ]]; then
      local selected_task_file="$feature_dir/selected-task.json"
      local saved_route="/tmp/${SESSION}-${issue}-route.json"
      local saved_route_source_file="/tmp/${SESSION}-${issue}-route-source.txt"
      local routing_log_file="$feature_dir/.routing-debug.log"
      local routing_failure_file="$feature_dir/.routing-failure"
      local route_input_file="$packet_file"
      local route_json=""
      local route_rc=0
      local route_attempt=1
      local route_reason=""
      local route_source=""
      local route_stderr_file="/tmp/${SESSION}-${issue}-route-live.stderr"
      local route_max_cost_args=()
      local route_mode_args=()
      local route_debug_enabled="false"
      : > "$routing_log_file"
      rm -f "$routing_failure_file"

      if [[ -n "${DEFAULT_MAX_COST_USD:-}" ]]; then
        route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")
      fi
      if [[ "${WAVEMILL_ROUTING_DEBUG:-0}" == "1" ]]; then
        route_debug_enabled="true"
      fi

      if [[ ! -s "$route_input_file" ]]; then
        if [[ -f "$selected_task_file" ]] && jq -e '.title or .description' "$selected_task_file" >/dev/null 2>&1; then
          jq -r '[(.title // ""), (.description // "")] | map(select(length > 0)) | join("\n\n")' \
            "$selected_task_file" > "$route_input_file" 2>/dev/null || true
          if [[ -s "$route_input_file" ]]; then
            packet_content=$(cat "$route_input_file" 2>/dev/null || echo "")
            log "info" "  Created minimal routing packet from selected-task.json"
          fi
        fi

        if [[ ! -s "$route_input_file" ]]; then
          printf '%s\n\n%s\n' "$title" "$issue_desc" > "$route_input_file"
          packet_content=$(cat "$route_input_file" 2>/dev/null || echo "")
          log "info" "  Created minimal routing packet from title and description"
        fi
      fi

      printf 'issue=%s\npacket=%s\nsaved_route=%s\n' "$issue" "$route_input_file" "$saved_route" >> "$routing_log_file"

      if [[ -f "$saved_route" ]] && [[ -f "$saved_route_source_file" ]] && [[ "$(cat "$saved_route_source_file" 2>/dev/null)" == "batch-cache" ]] && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
        route_json=$(cat "$saved_route" 2>/dev/null || echo "")
        route_source="batch-cache"
        log "info" "  Workflow route recovered from batch cache"
      elif [[ ! -s "$route_input_file" ]]; then
        route_reason="missing_packet"
        log_warn "  Workflow routing skipped: no packet content available"
      else
        while (( route_attempt <= 3 )); do
          printf '\n[attempt %d] live route\n' "$route_attempt" >> "$routing_log_file"
          rm -f "$route_stderr_file"
          if [[ "$route_debug_enabled" == "true" ]]; then
            if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --file "$route_input_file" --repo-dir "$REPO_DIR" --source live --input-kind task-packet "${route_max_cost_args[@]}" "${route_mode_args[@]}" 2>"$route_stderr_file"); then
              route_rc=0
            else
              route_rc=$?
            fi
          else
            if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --file "$route_input_file" --repo-dir "$REPO_DIR" --source live --input-kind task-packet "${route_max_cost_args[@]}" "${route_mode_args[@]}" 2>"$route_stderr_file"); then
              route_rc=0
            else
              route_rc=$?
            fi
          fi

          if [[ -s "$route_stderr_file" ]]; then
            cat "$route_stderr_file" >> "$routing_log_file"
            replay_route_transparency_logs "$route_stderr_file"
          fi

          if [[ -n "$route_json" ]]; then
            printf '%s\n' "$route_json" >> "$routing_log_file"
          fi

          if [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
            route_source="live"
            break
          fi

          if [[ -n "$route_json" ]]; then
            route_reason="invalid_json"
          elif (( route_rc == 124 )); then
            route_reason="timeout"
          else
            route_reason="command_failed"
          fi

          log_warn "  Workflow routing attempt $route_attempt failed (${route_reason}, exit=${route_rc:-0})"
          if (( route_attempt < 3 )); then
            local route_backoff=$(( 1 << (route_attempt - 1) ))
            sleep "$route_backoff"
          fi
          route_attempt=$((route_attempt + 1))
        done
      fi

      if [[ -z "$route_source" ]] && [[ -f "$saved_route" ]] && jq -e '.planner and .coder and .reviewer' "$saved_route" >/dev/null 2>&1; then
        route_json=$(cat "$saved_route" 2>/dev/null || echo "")
        route_source="$(cat "$saved_route_source_file" 2>/dev/null || echo "startup-cache")"
        if [[ "$route_source" == "batch-cache" ]]; then
          log "info" "  Workflow route recovered from batch cache"
        else
          route_source="startup-cache"
          log "info" "  Workflow route recovered from startup cache"
        fi
      fi

      if [[ -z "$route_source" ]] && [[ -s "$route_input_file" ]]; then
        printf '\n[heuristic fallback]\n' >> "$routing_log_file"
        rm -f "$route_stderr_file"
        if [[ "$route_debug_enabled" == "true" ]]; then
          if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --mode heuristic --file "$route_input_file" --repo-dir "$REPO_DIR" --source heuristic-fallback --input-kind heuristic "${route_max_cost_args[@]}" 2>"$route_stderr_file"); then
            route_rc=0
          else
            route_rc=$?
          fi
        else
          if route_json=$(_with_timeout "$API_TIMEOUT" npx tsx "$route_tool" --json --mode heuristic --file "$route_input_file" --repo-dir "$REPO_DIR" --source heuristic-fallback --input-kind heuristic "${route_max_cost_args[@]}" 2>"$route_stderr_file"); then
            route_rc=0
          else
            route_rc=$?
          fi
        fi

        if [[ -s "$route_stderr_file" ]]; then
          cat "$route_stderr_file" >> "$routing_log_file"
          replay_route_transparency_logs "$route_stderr_file"
        fi

        if [[ -n "$route_json" ]]; then
          printf '%s\n' "$route_json" >> "$routing_log_file"
        fi

        if [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
          route_source="heuristic-fallback"
          log "info" "  Workflow route recovered via heuristic fallback"
        else
          if [[ -n "$route_json" ]]; then
            route_reason="invalid_json"
          elif (( route_rc == 124 )); then
            route_reason="timeout"
          else
            route_reason="command_failed"
          fi
        fi
      fi

      if [[ -n "$route_source" ]] && [[ -n "$route_json" ]] && echo "$route_json" | jq -e '.planner and .coder and .reviewer' >/dev/null 2>&1; then
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

        if [[ "$route_source" == "live" ]]; then
          log "info" "  Workflow route: planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "batch-cache" ]]; then
          log "info" "  Workflow route (from batch cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "startup-cache" ]]; then
          log "info" "  Workflow route (from startup cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        else
          log "info" "  Workflow route (heuristic fallback): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        fi
      else
        cat > "$routing_failure_file" <<EOF
issue=$issue
packet=$route_input_file
saved_route=$saved_route
reason=${route_reason:-unknown}
exit_code=${route_rc:-0}
debug_log=$routing_log_file
EOF
        log "info" "  Workflow routing unavailable (${route_reason:-unknown}), using default agent"
      fi
      rm -f "$route_stderr_file"
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
    challenge_mode="single"
    challenge_reason=""
    if [[ -n "${FORCE_MODEL:-}" ]]; then
      challenge_reason="forced_model"
      log "debug" "  $issue: Challenge skipped because FORCE_MODEL is set ($FORCE_MODEL)"
    else
      local _dyn_rs=$remaining_slots
      (( _dyn_rs < 2 )) && _dyn_rs=2
      challenge_args=(--issue "$issue" --slug "$slug" --title "$title" --repo-dir "$REPO_DIR" --remaining-slots "$_dyn_rs")
      [[ -n "$task_model" ]] && challenge_args+=(--primary-model "$task_model")
      [[ -n "$packet_file" ]] && challenge_args+=(--file "$packet_file")
      challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
      challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
      challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
    fi
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

      save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "true" "$challenge_pair" "primary" "$task_model" "$planner_model" "$task_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"
      save_task_state "$challenger_key" "$challenger_slug" "task/${challenger_slug}" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "$challenger_agent" "$linear_issue" "true" "$challenge_pair" "challenger" "$challenger_model" "$challenger_planner" "$challenger_model" "$challenger_reviewer" "$challenger_plan_depth" "$challenger_code_depth" "$challenger_review_mode"
      should_launch_challenger="true"
      LAST_LAUNCHED_SLOTS=1  # Challenger is free overhead, doesn't consume a slot
      log "status" "  Challenge selected (${task_model} vs ${challenger_model}) [challenger is extra pane]"
    elif [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  Challenge skipped ($challenge_reason), launching single-model run"
    fi
  fi

  # Save to state ledger (after routing so agent is known)
  local initial_phase="planning"
  # If this task was already marked as a challenge participant (e.g. challenger
  # launched via recursive call with WAVEMILL_DISABLE_CHALLENGE=1), preserve
  # the existing challenge flag rather than overwriting with "false".
  local effective_challenge="$challenge_enabled_for_launch"
  if [[ "$effective_challenge" != "true" && -n "$challenge_role" ]]; then
    effective_challenge="true"
  fi
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent_cmd" "$linear_issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "$task_model" "$planner_model" "$task_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"
  set_task_phase "$issue" "$initial_phase"

  # Verify agent was saved correctly (helps debug future issues)
  if [[ "${DEBUG_AGENT:-}" == "1" ]]; then
    local saved_agent
    saved_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
    if [[ "$saved_agent" != "$task_agent_cmd" ]]; then
      log_warn "  ⚠ Agent save mismatch: expected='$task_agent_cmd' but got='$saved_agent'"
    else
      log "info" "  ✓ Agent set to: $task_agent_cmd"
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
  tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir"
  # Prevent window destruction if the pane shell exits (e.g. from a stray Ctrl-D).
  # This lets _pane_is_dead_or_idle detect and respawn dead panes during phase transitions.
  tmux set-option -t "$SESSION:$win" remain-on-exit on 2>/dev/null || true
  set_window_attention_state "$win" "clear"

  # Run setup command in new worktrees (e.g., npm install)
  if [[ -n "${SETUP_CMD:-}" ]] && [[ "$created_new" == "true" ]]; then
    log "info" "  Running setup: $SETUP_CMD"
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
      log "info" "  Setup complete"
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

  # Launch in routing phase - monitor will handle phase transitions
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
  local routing_max_cost_usd
  routing_max_cost_usd="$(read_route_json "$SESSION" "$issue" "constraints.maxCostUsd" "")"
  [[ -z "$routing_max_cost_usd" ]] && routing_max_cost_usd="${DEFAULT_MAX_COST_USD:-}"

  jq -n \
    --arg planner "${planner_model:-claude-sonnet-4-6}" \
    --arg coder "${task_model:-claude-opus-4-7}" \
    --arg reviewer "${reviewer_model:-claude-sonnet-4-6}" \
    --arg planDepth "${plan_depth:-light}" \
    --arg codeDepth "${code_depth:-medium}" \
    --arg reviewMode "${review_mode:-static}" \
    --arg source "bootstrap" \
    --arg inputKind "issue" \
    --arg inputPath "features/$slug/selected-task.json" \
    --arg provenanceSource "$(read_route_json "$SESSION" "$issue" "source" "")" \
    --arg provenanceInputKind "$(read_route_json "$SESSION" "$issue" "inputKind" "")" \
    --arg provenanceInputPath "$(read_route_json "$SESSION" "$issue" "inputPath" "")" \
    --arg provenanceInputHash "$(read_route_json "$SESSION" "$issue" "inputHash" "")" \
    --arg provenanceRoutedAt "$(read_route_json "$SESSION" "$issue" "routedAt" "")" \
    --arg provenanceRouterMode "$(read_route_json "$SESSION" "$issue" "routerMode" "")" \
    --argjson maxCostUsd "${routing_max_cost_usd:-null}" \
    '{
      planner: $planner,
      coder: $coder,
      reviewer: $reviewer,
      planDepth: $planDepth,
      codeDepth: $codeDepth,
      reviewMode: $reviewMode,
      reviewRecommended: $reviewMode,
      provenance: {
        source: (if $provenanceSource == "" then $source else $provenanceSource end),
        inputKind: (if $provenanceInputKind == "" then $inputKind else $provenanceInputKind end),
        inputPath: (if $provenanceInputPath == "" then $inputPath else $provenanceInputPath end),
        inputHash: $provenanceInputHash,
        routedAt: (if $provenanceRoutedAt == "" then (now | todateiso8601) else $provenanceRoutedAt end),
        routerMode: (if $provenanceRouterMode == "" then "normal" else $provenanceRouterMode end)
      }
    } + (if $maxCostUsd == null then {} else {maxCostUsd: $maxCostUsd} end)' \
    | write_json_artifact "$routing_file"

  # Save initial route for eval comparison (routed on raw description).
  # Always stamp source='bootstrap' regardless of what the batch router recorded,
  # so .initial-route.json remains unambiguous bootstrap evidence.
  if [[ -f "$feature_dir/.initial-route.json" ]]; then
    log "info" "  Keeping existing .initial-route.json for $issue"
  else
    jq '.provenance.source = "bootstrap"' "$routing_file" \
      | write_json_artifact "$feature_dir/.initial-route.json"
  fi

  # Launch planning phase directly with the routed model (skip routing agent)
  local resolved_planner_agent
  resolved_planner_agent="$(agent_resolve_from_model "${planner_model:-claude-sonnet-4-6}")"

  # Record planning stage as running before the first launch so the monitor
  # keeps the task active even before any planning artifacts exist.
  write_stage_result "$feature_dir" "planning" "running" "$resolved_planner_agent" "${planner_model:-claude-sonnet-4-6}"

  launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
    "${planner_model:-claude-sonnet-4-6}" "$resolved_planner_agent" "${plan_depth:-light}"
  local launch_rc=$?
  if ! handle_phase_launch_result "$issue" "$feature_dir" "planning" "routing" "$launch_rc" "$win" \
    "$resolved_planner_agent" "${planner_model:-claude-sonnet-4-6}"; then
    return 0
  fi
  log "status" "  ✓ Routing complete (direct), launched planning with ${planner_model:-claude-sonnet-4-6}"

  log "status" "  ✓ $issue launched (phase: ${initial_phase}, agent: ${task_agent_cmd}${task_model:+ --model $task_model})"
  [[ -n "$planner_model" ]] && log "info" "  ✓ Routing: planner=$planner_model, coder=$task_model, reviewer=$reviewer_model"

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


log "status" "Monitoring tasks and managing work queue..."
[[ "$PLANNING_MODE" == "interactive" ]] && log "info" "  Planning mode: interactive (watching for plan approval)"
if (( EFFECTIVE_MAX_PARALLEL < MAX_PARALLEL )); then
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)"
else
  log "info" "  Max parallel: $MAX_PARALLEL"
fi
log "info" "  Checking every ${POLL_SECONDS}s"
log "info" "  Type 'q' to quit, or 'touch $STATE_DIR/.stop-loop' to stop"
printf '\033[1mTask Backlog\033[0m\n'

QUIT_REQUESTED=false
_active_count_prev=0
LAST_DISPLAY=""       # fingerprint of what was last printed
LAST_ACTIVE_COUNT=-1  # force first render
LAST_WAITING_MSG=""   # track last waiting message to avoid repetition
TASK_LIST_RENDERED=0  # track task list cursor region in control pane
SELECT_SHOW_ALL=false
USING_GROUPED_VIEW=false
GROUPED_SELECT_FROM=""
GROUPED_DISPLAY=""
declare -a COMMAND_QUEUE=()
COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
COMMAND_OFFSET_FILE="$(wavemill_command_offset_path "$SESSION")"
COMMAND_OFFSET_WARNED=false

clear_task_list_display() {
  if (( TASK_LIST_RENDERED == 1 )); then
    tput rc 2>/dev/null || true
    tput ed 2>/dev/null || printf '\033[J'
    TASK_LIST_RENDERED=0
  fi
}

read_command_offset() {
  local line_count offset_raw
  line_count=0
  [[ -f "$COMMAND_FILE" ]] && line_count=$(wc -l < "$COMMAND_FILE" 2>/dev/null | tr -d ' ')
  [[ "$line_count" =~ ^[0-9]+$ ]] || line_count=0

  # Persist any init-at-EOF decision: returning $line_count without writing it
  # back leaves drain_command_events permanently stuck at "line_count <= offset"
  # because every subsequent read recomputes the same EOF position.
  if [[ ! -f "$COMMAND_OFFSET_FILE" ]]; then
    if (( line_count > 0 )); then
      [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset missing (init at EOF)."
      COMMAND_OFFSET_WARNED=true
      write_command_offset "$line_count" || true
      echo "$line_count"
      return 0
    fi
    write_command_offset "0" || true
    echo "0"
    return 0
  fi

  offset_raw="$(cat "$COMMAND_OFFSET_FILE" 2>/dev/null || echo "0")"
  if ! [[ "$offset_raw" =~ ^[0-9]+$ ]]; then
    [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset invalid (init at EOF)."
    COMMAND_OFFSET_WARNED=true
    write_command_offset "$line_count" || true
    echo "$line_count"
    return 0
  fi
  if (( offset_raw > line_count )); then
    write_command_offset "$line_count" || true
    echo "$line_count"
    return 0
  fi
  echo "$offset_raw"
}

write_command_offset() {
  local new_offset="$1" tmp
  tmp="$(mktemp "/tmp/wavemill-${SESSION}-commands.offset.XXXXXX")" || return 1
  printf '%s\n' "$new_offset" > "$tmp"
  mv "$tmp" "$COMMAND_OFFSET_FILE"
}

drain_command_events() {
  local line_count offset start new_lines final_offset
  [[ -f "$COMMAND_FILE" ]] || return 0
  line_count=$(wc -l < "$COMMAND_FILE" 2>/dev/null | tr -d ' ')
  [[ "$line_count" =~ ^[0-9]+$ ]] || line_count=0
  offset="$(read_command_offset)"
  [[ "$offset" =~ ^[0-9]+$ ]] || offset=0
  (( line_count <= offset )) && return 0

  start=$((offset + 1))
  new_lines="$(sed -n "${start},${line_count}p" "$COMMAND_FILE" 2>/dev/null || true)"
  while IFS= read -r evt; do
    [[ -z "$evt" ]] && continue
    COMMAND_QUEUE+=("$evt")
  done <<< "$new_lines"
  final_offset=$line_count
  write_command_offset "$final_offset" || true
}

consume_next_command() {
  if (( ${#COMMAND_QUEUE[@]} == 0 )); then
    return 1
  fi
  REPLY="${COMMAND_QUEUE[0]}"
  if (( ${#COMMAND_QUEUE[@]} == 1 )); then
    COMMAND_QUEUE=()
  else
    COMMAND_QUEUE=("${COMMAND_QUEUE[@]:1}")
  fi
  return 0
}

poll_sleep() {
  local secs="${1:-$POLL_SECONDS}" elapsed
  if ! [[ "$secs" =~ ^[0-9]+$ ]]; then
    sleep "$secs"
    return 0
  fi
  elapsed=0
  while (( elapsed < secs )); do
    drain_command_events
    if (( ${#COMMAND_QUEUE[@]} > 0 )); then
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done
}

monitor_issue_state() {
  local ISSUE="$1"
  local BRANCH SLUG PR
  local task_status WIN WT_DIR task_branch current_phase eval_agent debug_flag current_agent needs_attention

  BRANCH="${BRANCH_BY_ISSUE[$ISSUE]}"
  SLUG="${SLUG_BY_ISSUE[$ISSUE]}"
  PR="${PR_BY_ISSUE[$ISSUE]:-}"
  WIN="$ISSUE-$SLUG"
  WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  local FEATURE_DIR="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}"
  current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
  needs_attention="false"

  # Critical invariant: controller-owned tasks must produce a PR before
  # completion cleanup. If an agent exits without one, preserve the worktree
  # and mark the task for attention so committed or uncommitted work is not
  # silently lost.

  # If already merged or completed-external (requireConfirm), wait for window close then cleanup
  task_status=$(read_state_value "" --arg issue "$ISSUE" '.tasks[$issue].status // empty')
  if [[ "$task_status" == "merged" || "$task_status" == "completed-external" ]]; then
    if [[ "$task_status" == "merged" ]]; then
      local merged_ready_dir merged_before_ready=false
      merged_ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
      if ! ready_stage_allows_merge "$merged_ready_dir"; then
        merged_before_ready=true
        ready_stage_warn_bypass_once "$merged_ready_dir" "$ISSUE" "$PR" || true
        write_ready_attention_file "$merged_ready_dir" "PR #$PR was merged before the Release Readiness Check passed."
      fi
    fi

    set_window_attention_state "$WIN" "clear"
    if [[ "$task_status" == "merged" && "$merged_before_ready" == "true" ]]; then
      cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"
      execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
      return 0
    fi

    # When quit is requested, force-clean merged tasks instead of waiting for the
    # user to close the review window (which blocks shutdown indefinitely).
    if [[ "${QUIT_REQUESTED:-false}" != "true" ]] \
       && tmux list-panes -t "$SESSION:$WIN" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
      active_count=$((active_count + 1))
      return 0
    fi

    cleanup_completed_task "$ISSUE" "$SLUG" "post-review cleanup"

    # Prune worktrees after cleanup
    execute git -C "$REPO_DIR" worktree prune 2>/dev/null || true
    return 0
  fi

  if [[ "$task_status" == "error" ]]; then
    if check_pr_exists "$BRANCH"; then
      local recovered_pr
      recovered_pr=$(find_pr_for_branch "$BRANCH")
      if [[ -n "$recovered_pr" ]]; then
        PR_BY_ISSUE["$ISSUE"]="$recovered_pr"
        log "status" "✓ $ISSUE → Found PR #$recovered_pr for errored task (updating state)"
        save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$recovered_pr" "" "$current_agent"
        set_task_phase "$ISSUE" "review"
      fi
    fi
    set_window_attention_state "$WIN" "needs-user"
    active_count=$((active_count + 1))
    return 0
  fi

  # Recovery runs inside per-issue monitoring so retries share the same task,
  # phase, and cleanup state as the rest of the controller.
  handle_agent_error_recovery "$ISSUE" "${current_agent:-$AGENT_CMD}"

  # Check if PR exists
  if [[ -z "$PR" ]]; then
    PR="$(find_pr_for_branch "$BRANCH")"
    if [[ -n "$PR" ]]; then
      PR_BY_ISSUE["$ISSUE"]="$PR"
      # Preserve agent when updating with PR number
      current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
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
      log "status" "✓ $ISSUE → PR #$PR (In Review)"
      if [[ -n "$pr_details" ]]; then
        log "info" "$pr_details"
      fi

      write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "" "PR #$PR" "{\"type\":\"review\",\"prNumber\":$PR}"
      set_task_phase "$ISSUE" "review"

      local title launch_rc
      set_task_phase "$ISSUE" "ready"
      title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
      if [[ -z "$title" ]]; then
        issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
        title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
      fi

      if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
        launch_rc=0
      else
        launch_rc=$?
      fi
      if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
        log "status" "⛔ $ISSUE → Workflow aborted during ready launch"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      if [[ "$launch_rc" -eq 3 ]]; then
        set_window_attention_state "$WIN" "clear"
        log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 5 ]]; then
        set_window_attention_state "$WIN" "clear"
        log "status" "⚙ $ISSUE → Ready remediation launched (PR #$PR)"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 4 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -ne 0 ]]; then
        log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      set_window_attention_state "$WIN" "needs-user"
      log "status" "✓ $ISSUE → Ready checks completed for PR #$PR"
      return 0
    else
      # No PR in current repo - check Linear issue state for cross-repo completion
      if should_update_linear_state "$ISSUE" && linear_is_completed "$(get_linear_issue_id "$ISSUE")"; then
        log "status" "✓ $ISSUE → Completed externally (cross-repo or manual)"
        set_window_attention_state "$WIN" "clear"

        # Post-completion eval (non-blocking: always exits 0)
        if [[ "$AUTO_EVAL" == "true" ]]; then
          eval_completed=$(read_state_value "false" --arg i "$ISSUE" '.tasks[$i].evalCompleted // false')
          if [[ "$eval_completed" == "false" ]]; then
            log "info" "  📊 Running post-completion eval..."
            launch_background_post_merge_eval "$ISSUE" "" "$BRANCH" "$SLUG" "$ISSUE" "post-completion"
          else
            log "debug" "  ✓ Eval already completed for $ISSUE"
          fi
        fi

        if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
          log "status" "  → Window stays open for review - close it when ready"
          if should_update_linear_state "$ISSUE"; then
            linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
          fi
          # Preserve agent when marking as completed-external
          current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
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

      # Resolve current phase from controller-owned stage state
      local resolved_phase
      resolved_phase=$(resolve_phase "$FEATURE_DIR")

      case "$current_phase" in
        routing)
          if check_stage_aborted "$FEATURE_DIR"; then
            log "status" "⛔ $ISSUE → Workflow aborted by user during routing phase"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          if check_routing_complete "$SLUG"; then
            # Read routing results
            routing_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.routing-complete"
            if [[ -f "$routing_file" ]]; then
              # FORCE_MODEL overrides routing file for all stage models
              if [[ -n "${FORCE_MODEL:-}" ]]; then
                planner_model="$FORCE_MODEL"
                coder_model="$FORCE_MODEL"
                reviewer_model="$FORCE_MODEL"
                # Still read depth/mode from routing file if available
                if jq empty "$routing_file" 2>/dev/null; then
                  plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                  code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                  review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
                else
                  plan_depth="light"
                  code_depth="medium"
                  review_mode="static"
                fi
              elif ! jq empty "$routing_file" 2>/dev/null; then
                log_warn "$ISSUE → Routing file contains invalid JSON, using defaults"
                planner_model="claude-sonnet-4-6"
                coder_model="claude-opus-4-7"
                reviewer_model="claude-sonnet-4-6"
                plan_depth="light"
                code_depth="medium"
                review_mode="static"
              else
                planner_model=$(jq -r '.planner // "claude-sonnet-4-6"' "$routing_file" 2>/dev/null || echo "claude-sonnet-4-6")
                coder_model=$(jq -r '.coder // "claude-opus-4-7"' "$routing_file" 2>/dev/null || echo "claude-opus-4-7")
                reviewer_model=$(jq -r '.reviewer // "claude-sonnet-4-6"' "$routing_file" 2>/dev/null || echo "claude-sonnet-4-6")
                plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
              fi

              planner_model="$(resolve_phase_model "planning" "$planner_model" "claude-sonnet-4-6")"
              coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
              reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-4-6")"

              # Save routing results to state
              current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
              linear_issue=$(get_linear_issue_id "$ISSUE")
              save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "" "" "$current_agent" "$linear_issue" "" "" "" "" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"

              # Write canonical phase config (HOK-1177)
              write_phase_config "$FEATURE_DIR" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "${FORCE_MODEL:-}"

              # Transition to planning phase
              set_task_phase "$ISSUE" "planning"
              planner_agent="$(agent_resolve_from_model "$planner_model")"

              # Get title from state or Linear
              title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              # Record planning stage as running (HOK-1177)
              write_stage_result "$FEATURE_DIR" "planning" "running" "$planner_agent" "$planner_model"

              launch_planning_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$planner_model" "$planner_agent" "$plan_depth"
              local launch_rc=$?
              if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "planning" "routing" "$launch_rc" "$WIN" "$planner_agent" "$planner_model"; then
                return 0
              fi
              set_window_attention_state "$WIN" "clear"
              log "status" "✓ $ISSUE → Routing complete, launching planning phase"
              active_count=$((active_count + 1))
              return 0
            else
              log_warn "$ISSUE → Routing file missing: $routing_file"
              needs_attention="true"
            fi
          else
            if ! check_routing_complete "$SLUG"; then
              set_window_attention_state "$WIN" "clear"
              # Keep routing tasks active while the controller-owned routing state is incomplete
              active_count=$((active_count + 1))
              return 0
            fi
            needs_attention="true"
          fi
          ;;

        planning)
          local approval_wait_var="_approval_wait_logged_${ISSUE//[^a-zA-Z0-9]/_}"

          if [[ "$resolved_phase" == "aborted" ]]; then
            unset "$approval_wait_var" 2>/dev/null || true
            log "status" "⛔ $ISSUE → Workflow aborted by user during planning phase"
            write_stage_result "$FEATURE_DIR" "planning" "aborted" "$current_agent"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          # Resume recovery: if the tmux window was lost (session was quit and
          # restarted via `r`/`a`), relaunch the planning agent so the task is
          # interactable again. On success we treat the task as freshly active
          # and skip the rest of this cycle's processing — the next poll will
          # pick up whatever state the agent produces. This must run before any
          # of the sub-state handlers below, which all assume the pane exists.
          _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "planning"
          if [[ "$_RESTORE_STATE" == "restored" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          elif [[ "$_RESTORE_STATE" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # Late migration detection: agent writes .migration-detected after expanding
          local mig_marker="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-detected"
          local mig_num_file="${WORKTREE_ROOT}/${SLUG}/features/${SLUG}/.migration-number"
          if [[ -f "$mig_marker" ]] && [[ ! -f "$mig_num_file" ]]; then
            # Check if reservation already exists
            local existing_reservation
            existing_reservation=$(read_state_value "" --arg i "$ISSUE" '.migrationReservations[$i] // empty')
            if [[ -z "$existing_reservation" ]]; then
              local next_num
              next_num=$(read_state_value "" '.nextMigrationNum // empty')
              if [[ -z "$next_num" ]]; then
                local highest
                highest=$(git -C "$REPO_DIR" ls-tree --name-only "origin/$BASE_BRANCH" alembic/versions/ 2>/dev/null \
                  | grep -oE '^[0-9]+' | sort -n | tail -1)
                next_num=$(( ${highest:-0} + 1 ))
              fi
              echo "$next_num" > "$mig_num_file"
              save_migration_reservation "$ISSUE" "$next_num"
              log "debug" "  → Late migration detected for $ISSUE, assigned number: $next_num"
            else
              echo "$existing_reservation" > "$mig_num_file"
            fi
          fi

          if [[ "$resolved_phase" == "coding" ]]; then
            unset "$approval_wait_var" 2>/dev/null || true
            # Before launching coding, validate planning did not overreach.
            if ! validate_planning_phase_output "${WORKTREE_ROOT}/${SLUG}"; then
              log_warn "$ISSUE → Planning phase modified source code, reverted changes and blocked transition"
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Planning modified files outside features/, reverted and awaiting re-approval"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
            # Record approval via approve_plan (HOK-1193: controller-owned stage result)
            approve_plan "$FEATURE_DIR" "$current_agent" ""

            if ! reroute_expanded_packets_for_coding_handoff "$ISSUE" "$SLUG" "$FEATURE_DIR"; then
              log_warn "$ISSUE → expanded reroute helper failed, attempting promotion from existing artifacts"
            fi
            if ! apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG" "${WORKTREE_ROOT}/${SLUG}" "$STATE_FILE"; then
              log_warn "$ISSUE → expanded route invalid; using bootstrap execution route for coding"
            fi

            if ! mill_check_expansion_handshake "$FEATURE_DIR" "$ISSUE" "$REPO_DIR"; then
              rm -f "$FEATURE_DIR/.plan-approved"
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" \
                "Expansion handshake blocked: raw input requires wavemill expand $ISSUE"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi

            # FORCE_MODEL takes priority, then challenge, then state, then default
            if [[ -n "${FORCE_MODEL:-}" ]]; then
              coder_model="$FORCE_MODEL"
            else
              coder_model=$(read_phase_config "$FEATURE_DIR" "coding" "model")
              [[ -z "$coder_model" ]] && coder_model=$(get_task_meta "$ISSUE" "coderModel")
              challenge_coder=$(get_task_meta "$ISSUE" "challengeModel")
              if [[ -n "$challenge_coder" ]] && [[ -f "$FEATURE_DIR/.post-expansion-route.json" ]]; then
                refresh_title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
                if [[ -z "$refresh_title" ]]; then
                  issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                  refresh_title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
                fi
                refreshed_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" \
                  --issue "$ISSUE" \
                  --slug "$SLUG" \
                  --title "$refresh_title" \
                  --repo-dir "$REPO_DIR" \
                  --remaining-slots 2 \
                  --primary-model "$challenge_coder" \
                  --feature-dir "$FEATURE_DIR" 2>/dev/null || echo "")
                refreshed_source=$(echo "$refreshed_plan" | jq -r '.decisionSource // "bootstrap"' 2>/dev/null || echo "bootstrap")
                if [[ "$refreshed_source" == "expanded" ]]; then
                  new_primary=$(echo "$refreshed_plan" | jq -r '.entries[0].model // empty' 2>/dev/null)
                  new_challenger_key=$(echo "$refreshed_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
                  new_challenger_model=$(echo "$refreshed_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)

                  if [[ -n "$new_primary" ]]; then
                    current_pr=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].pr // ""')
                    current_status=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].status // ""')
                    current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
                    current_linear_issue=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].linearIssueId // ""')
                    save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$current_pr" "$current_status" "$current_agent" "$current_linear_issue" \
                      "true" "$ISSUE" "primary" "$new_primary"
                    challenge_coder="$new_primary"
                  fi

                  if [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]]; then
                    challenger_slug=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].slug // ""')
                    challenger_branch=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].branch // ""')
                    challenger_worktree=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].worktree // ""')
                    challenger_pr=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].pr // ""')
                    challenger_status=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].status // ""')
                    challenger_agent=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].agent // ""')
                    challenger_linear_issue=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].linearIssueId // ""')
                    if [[ -n "$challenger_slug" ]] && [[ -n "$challenger_branch" ]] && [[ -n "$challenger_worktree" ]]; then
                      save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "$challenger_pr" "$challenger_status" "$challenger_agent" "$challenger_linear_issue" \
                        "true" "$ISSUE" "challenger" "$new_challenger_model"
                    fi
                  fi

                  log "status" "  $ISSUE: Challenge participants refreshed (expanded route): ${new_primary:-$challenge_coder} vs ${new_challenger_model:-unknown}"
                elif [[ "$refreshed_source" == "preserved" ]]; then
                  log "debug" "  $ISSUE: Challenge participants preserved after expanded routing"
                fi
              fi
              # For challenge tasks, the challenge model MUST override the routed coder
              if [[ -n "$challenge_coder" ]]; then
                coder_model="$challenge_coder"
              fi
            fi
            coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
            code_depth=$(read_phase_config "$FEATURE_DIR" "coding" "depth")
            [[ -z "$code_depth" ]] && code_depth=$(get_task_meta "$ISSUE" "codeDepth")
            [[ -z "$code_depth" ]] && code_depth="medium"

            # Transition to coding phase
            set_task_phase "$ISSUE" "coding"
            coder_agent="$(agent_resolve_from_model "$coder_model")"

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            # Record coding stage as running (HOK-1177)
            write_stage_result "$FEATURE_DIR" "coding" "running" "$coder_agent" "$coder_model"

            launch_coding_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$coder_model" "$coder_agent" "$code_depth"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "coding" "planning" "$launch_rc" "$WIN" "$coder_agent" "$coder_model"; then
                return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "✓ $ISSUE → Plan approved, launching coding phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect planning stage transitions
          local planning_status
          planning_status=$(read_stage_status "$FEATURE_DIR" "planning")

          # Transition 1: running/awaiting_user + .plan-approved → completed
          if [[ "$planning_status" == "running" || "$planning_status" == "awaiting_user" ]]; then
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "${WORKTREE_ROOT}/${SLUG}"; then
                log_warn "$ISSUE → Planning phase modified source code, reverted changes and blocked transition"
                write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Planning modified files outside features/, reverted and awaiting re-approval"
                set_window_attention_state "$WIN" "needs-user"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "✓ $ISSUE → Plan approved (via .plan-approved marker), marking as completed"
              approve_plan "$FEATURE_DIR" "$current_agent" ""
              # Next iteration will detect resolved_phase == "coding" and launch coding
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          # Transition 2: running + plan.md → awaiting_user
          if [[ "$planning_status" == "running" ]]; then
            if [[ -f "$FEATURE_DIR/plan.md" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              log "status" "✓ $ISSUE → plan.md detected, marking planning as awaiting_user"
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Plan ready for review"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          # Check if plan exists but not yet approved (awaiting_user)
          if [[ "$resolved_phase" == "awaiting_user" ]]; then
            # Check if user signaled approval by creating .plan-approved marker
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "${WORKTREE_ROOT}/${SLUG}"; then
                log_warn "$ISSUE → Planning phase modified source code, reverted changes and blocked transition"
                write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Planning modified files outside features/, reverted and awaiting re-approval"
                set_window_attention_state "$WIN" "needs-user"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "✓ $ISSUE → User approved plan (via .plan-approved marker)"
              approve_plan "$FEATURE_DIR" "$current_agent" ""
              # Now completed — next poll iteration will pick up and launch coding
              active_count=$((active_count + 1))
              return 0
            fi

            # HOK-1210: Do NOT auto-approve just because the pane is idle.
            # The agent must create .plan-approved after explicit user approval.
            # If the pane is idle or dead without the marker, log once and wait for user.
            if [[ -f "$FEATURE_DIR/plan.md" ]] && _pane_is_dead_or_idle "$SESSION:$WIN"; then
              if [[ "${!approval_wait_var:-}" != "true" ]]; then
                log "status" "⏳ $ISSUE → Plan ready — awaiting user approval (touch .plan-approved to continue)"
                printf -v "$approval_wait_var" '%s' "true"
              fi
            fi

            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # Stage still running — keep task active
          if [[ "$planning_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed transition artifact — needs attention
          needs_attention="true"
          ;;

        coding)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log "status" "⛔ $ISSUE → Workflow aborted by user during coding phase"
            write_stage_result "$FEATURE_DIR" "coding" "aborted" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          # Resume recovery: see matching block in the planning case above.
          _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "coding"
          if [[ "$_RESTORE_STATE" == "restored" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          elif [[ "$_RESTORE_STATE" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          if [[ "$resolved_phase" == "review" ]]; then
            validate_coding_phase_output "$BRANCH"
            # Mark coding as completed (HOK-1177)
            write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"

            # FORCE_MODEL takes priority, then phase config, then state, then default
            if [[ -n "${FORCE_MODEL:-}" ]]; then
              reviewer_model="$FORCE_MODEL"
            else
              reviewer_model=$(read_phase_config "$FEATURE_DIR" "review" "model")
              [[ -z "$reviewer_model" ]] && reviewer_model=$(get_task_meta "$ISSUE" "reviewerModel")
            fi
            reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-4-6")"
            review_mode=$(read_phase_config "$FEATURE_DIR" "review" "mode")
            [[ -z "$review_mode" ]] && review_mode=$(get_task_meta "$ISSUE" "reviewMode")
            [[ -z "$review_mode" ]] && review_mode="static"

            # Transition to review phase
            set_task_phase "$ISSUE" "review"
            reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            # Record review stage as running (HOK-1177)
            write_stage_result "$FEATURE_DIR" "review" "running" "$reviewer_agent" "$reviewer_model"

            launch_review_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$reviewer_model" "$reviewer_agent" "$review_mode"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "review" "coding" "$launch_rc" "$WIN" "$reviewer_agent" "$reviewer_model"; then
              return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "✓ $ISSUE → Coding complete, launching review phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect running→completed transition
          # When stage result is "running" and .coding-complete exists,
          # write completed status (next iteration will launch review)
          local coding_status
          coding_status=$(read_stage_status "$FEATURE_DIR" "coding")
          if [[ "$coding_status" == "running" ]]; then
            if [[ -f "$FEATURE_DIR/.coding-complete" ]]; then
              validate_coding_phase_output "$BRANCH"
              log "status" "✓ $ISSUE → .coding-complete detected, marking coding as completed"
              write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
              # Next iteration will detect resolved_phase == "review" and launch review
              active_count=$((active_count + 1))
              return 0
            fi
            log "debug" "$ISSUE → Coding still running: waiting for .coding-complete"
          fi

          # Stage still running
          if [[ "$coding_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            # Keep coding tasks active while the controller-owned stage is running
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed completion artifact
          needs_attention="true"
          ;;

        review)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log "status" "⛔ $ISSUE → Workflow aborted by user during review phase"
            write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-4-6")"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          local review_status
          local pr_number
          review_status=$(read_stage_status "$FEATURE_DIR" "review")
          pr_number=$(find_pr_for_branch "$BRANCH")

          # Reconcile legacy/stale review state: once a PR exists, review is effectively complete
          # and the controller can move into ready even if the stage file is still "running".
          if [[ "$review_status" == "running" ]]; then
            if [[ -n "$pr_number" ]]; then
              write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-4-6")" "PR #$pr_number" "{\"type\":\"review\",\"prNumber\":$pr_number}"
              review_status="completed"
            else
              set_window_attention_state "$WIN" "clear"
              # Keep review tasks active while the controller-owned stage is running
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          if [[ "$review_status" == "running" ]]; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi

          # This branch is only reachable when no PR is cached yet. The live
          # review -> ready transition for PR-backed tasks runs in the PR
          # lifecycle section below so resumed tasks can still advance.
          # Review is no longer running - check if PR was created and transition to ready phase.
          if [[ -n "$pr_number" ]]; then
            # Mark review as completed with PR artifact (HOK-1177)
            write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-4-6")" "PR #$pr_number" "{\"type\":\"review\",\"prNumber\":$pr_number}"

            # Transition to ready phase
            set_task_phase "$ISSUE" "ready"
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi
            if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$pr_number"; then
              local launch_rc=0
            else
              local launch_rc=$?
            fi
            if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
              log "⛔ $ISSUE → Workflow aborted during ready launch"
              set_task_phase "$ISSUE" "aborted"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
            if [[ "$launch_rc" -eq 3 ]]; then
              set_window_attention_state "$WIN" "clear"
              log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -eq 5 ]]; then
              set_window_attention_state "$WIN" "clear"
              log "status" "⚙ $ISSUE → Ready remediation launched (PR #$pr_number)"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -eq 4 ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "$launch_rc" -ne 0 ]]; then
              # Ready checks failed - mark for user attention
              log "⚠ $ISSUE → Ready checks failed (PR #$pr_number)"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
            set_window_attention_state "$WIN" "needs-user"
            log "✓ $ISSUE → Ready checks completed for PR #$pr_number"
            return 0
          fi
          # No PR created or ready phase disabled - mark for attention
          needs_attention="true"
          ;;

        ready)
          # This branch is only reachable when no PR is cached yet. Normal
          # ready-phase monitoring runs in the PR lifecycle section below,
          # because ready always has a known PR.
          if [[ "$resolved_phase" == "aborted" ]]; then
            log "⛔ $ISSUE → Workflow aborted by user during ready phase"
            write_stage_result "$FEATURE_DIR" "ready" "aborted" "$current_agent"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          local ready_state_dir_path
          ready_state_dir_path="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"

          if [[ -f "$ready_state_dir_path/.conflict-detected" ]]; then
            local ready_status launch_head current_head attention_head
            ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
            launch_head=$(ready_conflict_launch_head "$ready_state_dir_path")
            current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")
            attention_head=$(ready_conflict_attention_head "$ready_state_dir_path")

            if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi

            if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi

            if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
              local pr_number
              pr_number=$(find_pr_for_branch "$BRANCH")
              if [[ -z "$pr_number" ]]; then
                write_ready_attention_file "$ready_state_dir_path" "Unable to find open PR for branch $BRANCH after conflict remediation."
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi

              title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$pr_number"; then
                local launch_rc=0
              else
                local launch_rc=$?
              fi
              if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
                log "⛔ $ISSUE → Workflow aborted during conflict remediation"
                set_task_phase "$ISSUE" "aborted"
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi
              if [[ "$launch_rc" -eq 3 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -eq 5 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -eq 4 ]]; then
                set_window_attention_state "$WIN" "clear"
                active_count=$((active_count + 1))
                return 0
              fi
              if [[ "$launch_rc" -ne 0 ]]; then
                log "⚠ $ISSUE → Conflict remediation still needs attention"
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi

              log "✓ $ISSUE → Conflict remediation complete, ready checks rerun"
              set_window_attention_state "$WIN" "needs-user"
              return 0
            fi
          fi
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;

        aborted)
          set_window_attention_state "$WIN" "needs-user"
          return 0
          ;;

        executing)
          # Legacy autonomous mode - treat an idle shell as exited so stalled
          # autonomous panes do not occupy a slot forever.
          if ! _pane_is_dead_or_idle "$SESSION:$WIN"; then
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

      # Not completed externally - keep controller-owned running stages active
      if phase_should_remain_active_without_pr "$FEATURE_DIR" "$current_phase" "$SLUG"; then
        active_count=$((active_count + 1))
        return 0
      fi

      if check_stage_aborted "$FEATURE_DIR"; then
        log "status" "⛔ $ISSUE → Workflow aborted (controller state)"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      if transient_error_recovery_pending "$ISSUE"; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      # Window itself is gone (shouldn't happen with remain-on-exit, but
      # handle gracefully). Flag for attention instead of cleaning up
      # immediately — the worktree and branch still have value.
      if ! tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qF "$WIN"; then
        log "status" "⚠ $ISSUE → Window disappeared during $current_phase phase, recreating..."
        tmux new-window -d -t "$SESSION" -n "$WIN" -c "${WORKTREE_ROOT}/${SLUG}" 2>/dev/null || true
        tmux set-option -t "$SESSION:$WIN" remain-on-exit on 2>/dev/null || true
        sleep 1
        active_count=$((active_count + 1))
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      # Agent exited without creating a PR. This is an error condition, not
      # normal completion: preserve the worktree and branch for recovery.
      if check_pr_exists "$BRANCH"; then
        local pr_number
        pr_number=$(find_pr_for_branch "$BRANCH")
        if [[ -n "$pr_number" ]]; then
          PR_BY_ISSUE["$ISSUE"]="$pr_number"
          log "status" "✓ $ISSUE → Found PR #$pr_number (updating state)"
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$pr_number" "" "$current_agent"
          set_task_phase "$ISSUE" "review"
          set_window_attention_state "$WIN" "needs-user"
          active_count=$((active_count + 1))
          return 0
        fi
      fi

      log_error "⚠ $ISSUE → Agent exited without creating PR on branch $BRANCH"
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "error" "$current_agent"
      set_task_phase "$ISSUE" "error"

      local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"
      if [[ -f "$hook_protocol" ]]; then
        # Surface the controller-detected lifecycle error through the same
        # hook file dashboard readers use for agent-reported failures.
        source "$hook_protocol" || true
        WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$ISSUE" \
          wavemill_hook_write "error" "NoPR" "Agent exited without creating PR on branch $BRANCH" "${current_agent:-unknown}" || true
      fi

      set_window_attention_state "$WIN" "needs-user"
      log "status" "⛔ $ISSUE → Task requires attention: No PR created (worktree preserved)"
      active_count=$((active_count + 1))
      return 0
    fi
  fi

  current_phase=$(get_task_phase "$ISSUE")
  local pr_status=""
  pr_status=$(pr_state "$PR")

  # Check completion before phase-specific OPEN handling so merged/closed PRs
  # still trigger eval, cleanup, and Linear updates after the ready stage was added.
  if validate_pr_merge "$PR"; then
    local merged_ready_dir merged_before_ready=false
    merged_ready_dir="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
    if ! ready_stage_allows_merge "$merged_ready_dir"; then
      merged_before_ready=true
      ready_stage_warn_bypass_once "$merged_ready_dir" "$ISSUE" "$PR" || true
      write_ready_attention_file "$merged_ready_dir" "PR #$PR was merged before the Release Readiness Check passed."
    fi

    log "status" "✓ $ISSUE → PR #$PR MERGED"
    set_window_attention_state "$WIN" "clear"

    # Capture eval eligibility and agent before cleanup removes task state.
    local _eval_needed=false _eval_agent=""
    if [[ "$AUTO_EVAL" == "true" ]]; then
      local _eval_completed
      _eval_completed=$(read_state_value "false" --arg i "$ISSUE" '.tasks[$i].evalCompleted // false')
      if [[ "$_eval_completed" == "false" ]]; then
        _eval_needed=true
        _eval_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
        [[ -z "$_eval_agent" ]] && _eval_agent="$AGENT_CMD"
      fi
    fi

    if [[ "$REQUIRE_CONFIRM" == "true" && "$merged_before_ready" != "true" ]]; then
      if [[ "$_eval_needed" == "true" ]]; then
        log "info" "  📊 Running post-merge eval..."
        launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge"
      elif [[ "$AUTO_EVAL" == "true" ]]; then
        log "debug" "  ✓ Eval already completed for $ISSUE"
      fi
      log "status" "  → Window stays open for review - close it when ready"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
      fi
      # Preserve agent when marking as merged
      current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "${WORKTREE_ROOT}/${SLUG}" "$PR" "merged" "$current_agent"
      active_count=$((active_count + 1))
      return 0
    fi

    if should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
    fi
    cleanup_completed_task "$ISSUE" "$SLUG"
    if [[ "$_eval_needed" == "true" ]]; then
      log "info" "  📊 Eval queued in background"
      launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge" "$_eval_agent"
    elif [[ "$AUTO_EVAL" == "true" ]]; then
      log "debug" "  ✓ Eval already completed for $ISSUE"
    fi
    return 0
  elif [[ "$pr_status" == "CLOSED" ]]; then
    log_warn "$ISSUE → PR #$PR CLOSED without merge"
    local linear_status="Backlog"
    if is_challenge_task "$ISSUE"; then
      local sibling_pr sibling_state
      sibling_pr=$(get_challenge_sibling_pr "$ISSUE")
      sibling_state=""

      # Challenge tasks should only move once the sibling outcome is definitive.
      if check_challenge_sibling_merged "$ISSUE"; then
        linear_status="Done"
        log "status" "  ✓ Challenge sibling merged → marking Linear as Done"
      fi

      if [[ "$linear_status" != "Done" && -n "$sibling_pr" ]]; then
        sibling_state=$(pr_state "$sibling_pr")
      fi

      case "$linear_status:$sibling_pr:$sibling_state" in
        Done:*) ;;
        Backlog::*)
          linear_status=""
          log "debug" "  ↳ Challenge sibling PR not found yet, deferring Linear state update"
          ;;
        Backlog:*:CLOSED)
          log "status" "  ↺ Challenge sibling also closed → returning Linear to Backlog"
          ;;
        Backlog:*)
          linear_status=""
          log "debug" "  ↳ Challenge sibling still active or unknown, deferring Linear state update"
          ;;
      esac
    fi
    if [[ -n "$linear_status" ]] && should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "$linear_status"
    fi
    if should_cleanup_closed_pr "$ISSUE"; then
      log "debug" "  ↳ Auto-cleaning closed challenger pane/worktree"
      set_window_attention_state "$WIN" "clear"
      cleanup_completed_task "$ISSUE" "$SLUG" "closed without merge" || true
    else
      CLEANED["$ISSUE"]=1
    fi
    return 0
  fi

  if [[ "$current_phase" == "review" ]]; then
    local resolved_phase review_status title launch_rc
    if [[ "$pr_status" == "OPEN" ]]; then
      resolved_phase=$(resolve_phase "$FEATURE_DIR")
      if [[ "$resolved_phase" == "aborted" ]]; then
        log "status" "⛔ $ISSUE → Workflow aborted by user during review phase"
        write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      review_status=$(read_stage_status "$FEATURE_DIR" "review")
      if [[ "$review_status" == "running" || -z "$review_status" || "$review_status" == "completed" ]]; then
        write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "" "PR #$PR" "{\"type\":\"review\",\"prNumber\":$PR}"
        set_task_phase "$ISSUE" "ready"
        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi

        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log "status" "⛔ $ISSUE → Workflow aborted during ready launch"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 ]]; then
          set_window_attention_state "$WIN" "clear"
          log "status" "⚠ $ISSUE → Ready detected conflicts, launching remediation"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 5 ]]; then
          set_window_attention_state "$WIN" "clear"
          log "status" "⚙ $ISSUE → Ready remediation launched (PR #$PR)"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 4 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        set_window_attention_state "$WIN" "needs-user"
        log "status" "✓ $ISSUE → Ready checks completed for PR #$PR"
        return 0
      fi

      if ! restore_review_task_window "$ISSUE" "$SLUG" "$BRANCH" "$PR" "$WT_DIR"; then
        set_window_attention_state "$WIN" "needs-user"
        active_count=$((active_count + 1))
        return 0
      fi
    fi
  elif [[ "$current_phase" == "ready" ]]; then
    local resolved_phase ready_state_dir_path ready_status ready_verdict
    local launch_head current_head title launch_rc
    resolved_phase=$(resolve_phase "$FEATURE_DIR")
    if [[ "$resolved_phase" == "aborted" ]]; then
      log "status" "⛔ $ISSUE → Workflow aborted by user during ready phase"
      write_stage_result "$FEATURE_DIR" "ready" "aborted" "$current_agent"
      set_task_phase "$ISSUE" "aborted"
      set_window_attention_state "$WIN" "needs-user"
      return 0
    fi

    ready_state_dir_path="$(ready_state_dir "${WORKTREE_ROOT}/${SLUG}" "$SLUG")"
    if [[ -f "$ready_state_dir_path/.conflict-detected" ]]; then
      ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
      launch_head=$(ready_conflict_launch_head "$ready_state_dir_path")
      current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")
      local attention_head
      attention_head=$(ready_conflict_attention_head "$ready_state_dir_path")

      if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi

        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log "status" "⛔ $ISSUE → Workflow aborted during conflict remediation"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 5 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -eq 4 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Conflict remediation still needs attention"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi

        log "status" "✓ $ISSUE → Conflict remediation complete, ready checks rerun"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
    fi

    ready_status=$(read_stage_status "$ready_state_dir_path" "ready")
    launch_head=$(ready_remediation_launch_head "$ready_state_dir_path")
    current_head=$(git -C "${WORKTREE_ROOT}/${SLUG}" rev-parse HEAD 2>/dev/null || echo "")

    # Ready stage finished — run challenge eval/comparison before dropping out.
    # Without this, challenge tasks sit in phase=ready forever (resolve_phase
    # keeps them there until merge), and the eval call at the bottom of this
    # function is unreachable.
    if [[ "$ready_status" == "completed" ]]; then
      if is_challenge_task "$ISSUE"; then
        maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
        maybe_run_challenge_comparison "$ISSUE"
      fi

      # Re-run ready if main has advanced since the pass was recorded (HOK-1359)
      local stored_base_sha current_main_sha
      stored_base_sha=$(ready_base_sha "$ready_state_dir_path")
      current_main_sha=$(get_main_head_sha "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH")

      if [[ -n "$current_main_sha" && "$stored_base_sha" != "$current_main_sha" ]]; then
        log "status" "⚠ $ISSUE → Ready result stale (main advanced); re-running ready checks for PR #$PR"
        title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
        if [[ -z "$title" ]]; then
          issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
          title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
        fi
        if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
          launch_rc=0
        else
          launch_rc=$?
        fi
        if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
          log "status" "⛔ $ISSUE → Workflow aborted during stale-ready re-check"
          set_task_phase "$ISSUE" "aborted"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        if [[ "$launch_rc" -eq 3 || "$launch_rc" -eq 4 || "$launch_rc" -eq 5 ]]; then
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
        fi
        if [[ "$launch_rc" -ne 0 ]]; then
          log "status" "⚠ $ISSUE → Ready re-check failed after main advanced (PR #$PR)"
          set_window_attention_state "$WIN" "needs-user"
          return 0
        fi
        log "status" "✓ $ISSUE → Ready re-check passed after main advanced (PR #$PR)"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    if [[ "$ready_status" == "running" ]] && [[ -n "$launch_head" ]] && [[ "$launch_head" == "$current_head" ]]; then
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    ready_verdict=$(ready_stage_pending_verdict "$ready_state_dir_path")
    # Re-run ready checks when CI is still computing (verdict=pending) OR when
    # a remediation agent has pushed new commits past the launch head — without
    # the second case, a successful remediation leaves status=running/verdict=fail
    # and the controller never re-evaluates CI.
    if [[ "$ready_status" == "running" ]] && { [[ "$ready_verdict" == "pending" ]] || [[ -n "$launch_head" && "$launch_head" != "$current_head" ]]; }; then
      title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
      if [[ -z "$title" ]]; then
        issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
        title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
      fi

      if launch_ready_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$PR"; then
        launch_rc=0
      else
        launch_rc=$?
      fi
      if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$FEATURE_DIR"; then
        log "status" "⛔ $ISSUE → Workflow aborted during ready re-check"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi
      if [[ "$launch_rc" -eq 3 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 5 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -eq 4 ]]; then
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi
      if [[ "$launch_rc" -ne 0 ]]; then
        log "status" "⚠ $ISSUE → Ready checks failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      log "status" "✓ $ISSUE → Ready checks completed for PR #$PR"
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

    set_window_attention_state "$WIN" "needs-user"
    return 0
  fi

  # PR open but not merged — re-check challenge eval and comparison
  # in case the eval was missed on initial PR detection (e.g. challenge
  # flag was incorrect when PR was first found)
  if is_challenge_task "$ISSUE"; then
    maybe_run_challenge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG"
    maybe_run_challenge_comparison "$ISSUE"
  fi
  active_count=$((active_count + 1))

  return 0
}

# ── Control pane health watchdog ──────────────────────────────────────
# Respawns dead control panes (dashboard, log) to prevent layout collapse.
# Called each monitor cycle. Relies on remain-on-exit keeping dead panes
# visible so we can detect and respawn them without losing the layout.
LAST_DASHBOARD_HEALTH_CHECK=0
DASHBOARD_HEALTH_INTERVAL=30  # seconds between checks

check_control_pane_health() {
  local now
  now=$(date +%s)
  (( now - LAST_DASHBOARD_HEALTH_CHECK < DASHBOARD_HEALTH_INTERVAL )) && return 0
  LAST_DASHBOARD_HEALTH_CHECK=$now

  local pane_count
  pane_count=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')

  # If panes were destroyed (layout collapsed), rebuild from scratch.
  if (( pane_count < 3 )); then
    log_warn "Control window has $pane_count pane(s) (expected 3). Rebuilding layout..."
    local status_script="$LIB_DIR/wavemill-status.sh"

    if (( pane_count == 1 )); then
      # Single pane remaining — recreate both missing panes
      tmux split-window -t "$SESSION:control.0" -hb -p 50 "exec bash" 2>/dev/null || true
      tmux split-window -t "$SESSION:control.0" -v -p 65 "exec bash" 2>/dev/null || true
    elif (( pane_count == 2 )); then
      # Two panes — add the missing one
      tmux split-window -t "$SESSION:control.0" -v -p 65 "exec bash" 2>/dev/null || true
    fi

    # Re-count after splits
    pane_count=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
    if (( pane_count >= 3 )); then
      # Respawn dashboard (pane 1) and log (pane 2)
      tmux respawn-pane -k -t "$SESSION:control.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
      tmux respawn-pane -k -t "$SESSION:control.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
      # Update dashboard PID
      sleep 0.3
      local new_pid
      new_pid=$(tmux list-panes -t "$SESSION:control.1" -F '#{pane_pid}' 2>/dev/null || true)
      [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
      log "status" "Control panes rebuilt successfully"
    else
      log_warn "Failed to rebuild control panes (got $pane_count)"
    fi
    return 0
  fi

  # All 3 panes exist — check for dead ones and respawn in place.
  local dead_panes
  dead_panes=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index} #{pane_dead}' 2>/dev/null || true)

  while IFS=' ' read -r idx is_dead; do
    [[ "$is_dead" == "1" ]] || continue
    case "$idx" in
      1)
        log_warn "Dashboard pane (control.1) is dead. Respawning..."
        local status_script="$LIB_DIR/wavemill-status.sh"
        tmux respawn-pane -t "$SESSION:control.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
        sleep 0.3
        local new_pid
        new_pid=$(tmux list-panes -t "$SESSION:control.1" -F '#{pane_pid}' 2>/dev/null || true)
        [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
        log "status" "Dashboard pane respawned"
        ;;
      2)
        log_warn "Log pane (control.2) is dead. Respawning..."
        tmux respawn-pane -t "$SESSION:control.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
        log "status" "Log pane respawned"
        ;;
    esac
  done <<<"$dead_panes"
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  _update_effective_max_parallel
  drain_command_events
  while consume_next_command; do
    case "$REPLY" in
      quit)
        if [[ "$QUIT_REQUESTED" == "true" ]]; then
          quit_and_kill_session "Force quitting (${_active_count_prev} task(s) still active)."
        elif (( _active_count_prev == 0 )); then
          quit_and_kill_session "Quitting."
        else
          log "status" "Will quit after ${_active_count_prev} active task(s) finish. Press q again to force quit."
          QUIT_REQUESTED=true
        fi
        ;;
      *)
        COMMAND_QUEUE=("$REPLY" "${COMMAND_QUEUE[@]+"${COMMAND_QUEUE[@]}"}")
        break
        ;;
    esac
  done
  check_control_pane_health
  wavemill_pr_cache_refresh
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
    _cr=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].challengeRole // ""')
    if [[ "$_cr" == "challenger" ]] && [[ -z "${CLEANED[$ISSUE]:-}" ]]; then
      active_challenger_count=$((active_challenger_count + 1))
    fi
  done
  _active_count_prev=$active_count

  # ── Phase B: Check for stop signal ──────────────────────────────────
  if [[ -f "$STATE_DIR/.stop-loop" ]]; then
    if (( active_count == 0 )); then
      rm -f "$STATE_DIR/.stop-loop"
      quit_and_kill_session "Stop signal detected and all tasks complete. Exiting."
    fi
    log "status" "Stop signal detected. Finishing $active_count active task(s)..."
    poll_sleep "$POLL_SECONDS"
    continue
  fi

  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      quit_and_kill_session "All tasks complete. Exiting."
    fi
    # Still have active tasks — keep monitoring but accept 'q' for force-quit
    if consume_next_command; then
      if [[ "$REPLY" == "quit" ]]; then
        quit_and_kill_session "Force quitting ($active_count task(s) still active)."
      fi
    fi
    poll_sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  # Challengers are free overhead — don't count them against MAX_PARALLEL
  free_slots=$((EFFECTIVE_MAX_PARALLEL - (active_count - active_challenger_count)))
  update_free_slots_state "$free_slots"

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
        queue_fp="${QUEUE_PLAN_CACHE:0:50}"
        display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}|${queue_fp}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          SELECT_SHOW_ALL=false
          if (( TASK_LIST_RENDERED == 1 )); then
            tput rc 2>/dev/null || true
            tput ed 2>/dev/null || printf '\033[J'
          else
            echo ""
            tput sc 2>/dev/null || true
          fi
          echo "Next tasks:"
          queue_plan_json=""
          GROUPED_DISPLAY=""
          GROUPED_SELECT_FROM=""
          if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
            render_grouped_task_list "$queue_plan_json" "$available"
            if [[ -n "$GROUPED_DISPLAY" ]]; then
              echo "$GROUPED_DISPLAY"
              select_from="$GROUPED_SELECT_FROM"
              USING_GROUPED_VIEW=true
            fi
          fi
          if [[ -z "$GROUPED_DISPLAY" ]]; then
            USING_GROUPED_VIEW=false
            [[ -n "$queue_plan_json" ]] || log_warn "queue analysis unavailable, falling back to flat list"
            if [[ -n "$avail_unblocked" ]]; then
              echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}'
            else
              echo "  (no unblocked tasks)"
            fi
            if (( avail_blocked_count > 0 )); then
              echo ""
              echo "  ($avail_blocked_count blocked task(s) hidden — enter 'm' to show all)"
            fi
          fi
          echo ""
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          elif (( avail_blocked_count > 0 )); then
            echo "Enter number(s) to start (e.g. 1 3), 'm' for more, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          else
            echo "Enter number(s) to start (e.g. 1 3), 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"
          fi
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
          LAST_WAITING_MSG=""  # Clear waiting state when tasks are available
          TASK_LIST_RENDERED=1
        fi

        # Default: selection against unblocked list only
        select_from="$avail_unblocked"
        if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
          select_from="$GROUPED_SELECT_FROM"
        elif [[ "$SELECT_SHOW_ALL" == "true" ]]; then
          select_from=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
        fi

        REPLY=""
        if consume_next_command; then
          case "$REPLY" in
            select\ *) REPLY="${REPLY#select }" ;;
            more) REPLY="m" ;;
            quit) REPLY="q" ;;
            unknown\ *) REPLY="unknown ${REPLY#unknown }" ;;
            *) REPLY="" ;;
          esac
        fi

        if [[ "$REPLY" =~ ^[Qq]$ ]]; then
          if (( active_count == 0 )); then
            quit_and_kill_session "Quitting."
          elif [[ "$QUIT_REQUESTED" == "true" ]]; then
            quit_and_kill_session "Force quitting ($active_count task(s) still active)."
          else
            log "status" "Will quit after $active_count active task(s) finish. Press q again to force quit."
            QUIT_REQUESTED=true
          fi
        elif [[ "$REPLY" =~ ^[mM]$ ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            :
          else
            clear_task_list_display
            all_avail=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
            echo ""
            log "info" "All tasks:"
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
            SELECT_SHOW_ALL=true
          fi
        elif [[ "$REPLY" =~ ^unknown\  ]]; then
          log_warn "Unknown input: ${REPLY#unknown }"
        elif [[ -n "$REPLY" ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            select_from="$GROUPED_SELECT_FROM"
          elif [[ "$SELECT_SHOW_ALL" == "true" ]]; then
            select_from=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
          fi
          # Parse user selection and launch tasks (up to free_slots)
          launched=0
          selected_lines=""
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
            selected_lines+="${local_line}"$'\n'
            launched=$((launched + 1))
          done

          if (( launched > 1 )); then
            if batch_route_selected_tasks "$selected_lines"; then
              log "info" "Prepared batch routing for $launched selected tasks"
            else
              log_warn "Batch routing failed for selected tasks; falling back to per-task routing"
            fi
          fi

          launched=0
          while IFS= read -r local_line; do
            [[ -z "$local_line" ]] && continue
            IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
            launch_task "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
            launched=$((launched + LAST_LAUNCHED_SLOTS))
            if (( launched >= free_slots )); then
              break
            fi
          done <<<"$selected_lines"
          # Invalidate caches after launching so next cycle re-renders
          LAST_BACKLOG_FETCH=0
          LAST_DISPLAY=""
          LAST_WAITING_MSG=""  # Clear waiting state
          SELECT_SHOW_ALL=false
          USING_GROUPED_VIEW=false
          clear_task_list_display
        fi
        poll_sleep "$POLL_SECONDS"
      else
        # All candidates are already active
        clear_task_list_display
        if (( active_count == 0 )); then
          waiting_msg="No new tasks available. Waiting... (type 'q' to quit)"
          if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
            log "status" "$waiting_msg"
            LAST_WAITING_MSG="$waiting_msg"
          fi
          if consume_next_command && [[ "$REPLY" == "quit" ]]; then
            quit_and_kill_session
          fi
          poll_sleep "$POLL_SECONDS"
        else
          poll_sleep "$POLL_SECONDS"
        fi
      fi
    else
      # Backlog empty
      clear_task_list_display
      if (( active_count == 0 )); then
        waiting_msg="Backlog empty. Waiting for new tasks... (type 'q' to quit)"
        if [[ "$waiting_msg" != "$LAST_WAITING_MSG" ]]; then
          log "status" "$waiting_msg"
          LAST_WAITING_MSG="$waiting_msg"
        fi
        # Invalidate cache so we re-fetch next cycle
        LAST_BACKLOG_FETCH=0
        if consume_next_command && [[ "$REPLY" == "quit" ]]; then
          quit_and_kill_session
        fi
        poll_sleep "$POLL_SECONDS"
      else
        poll_sleep "$POLL_SECONDS"
      fi
    fi
  else
    # All slots full — just monitor
    clear_task_list_display
    poll_sleep "$POLL_SECONDS"
  fi
done
MONITOR_EOF

# HOK-1297 / HOK-1364: Investigate bash syntax errors reported during exit
#
# INVESTIGATION SUMMARY
# =====================
# HOK-1297:
# - Bug report: "syntax error near unexpected token `(' at line 5572"
# - Trigger: Forced exit after challenge panes failed to exit when issues lost their challenge
# - Date: April 15, 2026
#
# HOK-1364:
# - Bug report: "unexpected EOF while looking for matching `\"'" at line 6268
# - Trigger: Reported after tmux attach returned at session exit
# - Date: April 19, 2026
#
# Investigation steps performed:
# 1. ✓ Ran `bash -n shared/lib/wavemill-mill.sh` → PASS (no syntax errors found)
# 2. ✓ Ran `bash -n` on the extracted monitor heredoc content → PASS
# 3. ✓ Examined the reported lines: `sleep "$POLL_SECONDS"` and
#      `log "info" "  Type 'q' in control window to quit"` are syntactically correct
# 4. ✓ Checked git history: No missing quote fix exists between the report and current HEAD
# 5. ✓ Searched for invalid 'local' keywords outside function context → NONE FOUND
#    (Previous bugs: fc198c8, d45ea00 fixed similar runtime errors with 'local')
# 6. ✓ Verified the heredoc terminator and generated monitor script syntax → CORRECT
#
# Conclusions:
# - Current codebase is syntactically valid; no unterminated string is present in this file.
# - Because this repo runs from Dropbox, a mid-execution file replacement can make bash report
#   a misleading EOF or line number while the shell is still reading the script in chunks.
# - The generated monitor script now has CI coverage via `tests/check-shell.sh`, so heredoc
#   quoting regressions are caught before runtime.
# - `_update_effective_max_parallel` is intentionally applied during startup so the main script
#   uses the degraded-model concurrency cap before any slot-selection logic runs.
#
# Defensive safeguards:
#
# 1. Monitor script syntax validation (below)
#    - Attempts to use the bash from monitor script shebang, falls back to system bash
#    - Catches syntax errors from heredoc expansion or variable substitution
#    - Provides diagnostic output if validation fails
#    - Prevents cryptic runtime errors during forced exit scenarios
#
# 2. Enhanced cleanup trap handler (line 928)
#    - Optional DEBUG_CLEANUP=1 for detailed error context
#    - Non-fatal error handling preserved
#
MONITOR_BASH="/opt/homebrew/bin/bash"
[[ ! -x "$MONITOR_BASH" ]] && MONITOR_BASH="bash"
validate_output=$($MONITOR_BASH -n "$MONITOR_SCRIPT" 2>&1)
if [[ -n "$validate_output" ]]; then
  log_error "Generated monitor script has syntax errors:"
  echo "$validate_output" | sed 's/^/  /' >&2
  log_error "Monitor script saved at: $MONITOR_SCRIPT"
  log_error "This may indicate a bug in the monitor script generation."
  exit 1
fi

chmod +x "$MONITOR_SCRIPT"


# Fetch latest base branch so worktrees start from up-to-date main
log "info" "Fetching latest $BASE_BRANCH from remote..."
wavemill_fetch_base_branch "$BASE_BRANCH" --force

: > "$STATUS_LOG_FILE"
: > "$LAUNCHED_ISSUES_FILE"

LAUNCH_PLAN_FILE="/tmp/${SESSION}-launch-plan.json"
write_launch_plan "$LAUNCH_PLAN_FILE"

STARTUP_RUNNER="$SCRIPT_DIR/wavemill-startup-runner.sh"
if [[ ! -f "$STARTUP_RUNNER" ]]; then
  echo "Error: wavemill-startup-runner.sh not found at $STARTUP_RUNNER" >&2
  exit 1
fi

log "status" "Creating tmux session..."
create_tmux_session

printf -v STARTUP_CMD '%q %q' "$STARTUP_RUNNER" "$LAUNCH_PLAN_FILE"
STARTUP_CMD="/opt/homebrew/bin/bash $STARTUP_CMD"
tmux respawn-pane -k -t "$SESSION:control.0" "$STARTUP_CMD"


# Now attach to the session
log "status" "Attaching to session: $SESSION"
log "info" "  Ctrl+B then W to switch windows"
log "info" "  Ctrl+B then D to detach"
log "info" "  Type 'q' in control window to quit"
log "info" "  Or: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
tmux attach -t "$SESSION"

log "status" "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
