#!/usr/bin/env bash
set -euo pipefail

# Guard: copy this script to /tmp and re-exec from there to prevent Dropbox
# from replacing the file mid-execution, which can surface as a spurious EOF
# parse error when bash seeks back into the large monitor heredoc. (HOK-1755)
if [[ -z "${_WAVEMILL_MILL_REEXEC:-}" ]]; then
  _mm_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  _mm_tmp="$(mktemp /tmp/wavemill-mill.XXXXXX)"
  cp "${BASH_SOURCE[0]}" "$_mm_tmp"
  chmod +x "$_mm_tmp"
  WAVEMILL_MILL_LIB_DIR="$_mm_lib" _WAVEMILL_MILL_REEXEC=1 \
    exec bash "$_mm_tmp" "$@"
fi

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
SCRIPT_DIR="${WAVEMILL_MILL_LIB_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
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
  if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
    echo "ERROR: wavemill mill is already running for: $WAVEMILL_MILL_ACTIVE" >&2
    echo "  Nested mill invocations are not allowed." >&2
    echo "  If this is unexpected, unset WAVEMILL_MILL_ACTIVE and retry." >&2
    exit 1
  fi
else
  export WAVEMILL_MILL_ACTIVE="$REPO_DIR"
fi

# ─────────────────────────────────────────────────────────────────

# Derived variables (not in config files)
if [[ "${WAVEMILL_DRY_RUN:-}" == "1" || "${WAVEMILL_DRY_RUN:-}" == "true" || "${DRY_RUN:-}" == "true" ]]; then
  export WAVEMILL_DRY_RUN=1
  DRY_RUN="true"
else
  DRY_RUN="false"
fi
STATE_DIR="${STATE_DIR:-$REPO_DIR/.wavemill}"
STATE_FILE="$STATE_DIR/workflow-state.json"
MILL_LOG_DIR="$REPO_DIR/.wavemill/logs"
mkdir -p "$MILL_LOG_DIR"
MILL_LOG_FILE="$MILL_LOG_DIR/mill-${SESSION}.log"
TOOLS_DIR="${TOOLS_DIR:-$REPO_DIR/tools}"
LIB_DIR="${LIB_DIR:-$REPO_DIR/shared/lib}"
MONITOR_PR_CACHE="/tmp/${SESSION}-pr-cache.json"
export MONITOR_PR_CACHE
MERGE_QUEUE_SELECTION_FILE="${STATE_DIR}/merge-queue-selection.json"
EFFECTIVE_MAX_PARALLEL="$MAX_PARALLEL"
# Persists queue plan for launch-plan JSON emission (set during task selection).
LAUNCH_QUEUE_PLAN=""

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

if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
  _update_effective_max_parallel
fi

FORCE_MODEL="$(trim_outer_whitespace "${FORCE_MODEL:-}")"
if [[ -z "$FORCE_MODEL" ]]; then
  unset FORCE_MODEL
fi

WAVEMILL_PLANNER_MODEL="$(trim_outer_whitespace "${WAVEMILL_PLANNER_MODEL:-}")"
if [[ -z "$WAVEMILL_PLANNER_MODEL" ]]; then
  unset WAVEMILL_PLANNER_MODEL
fi

WAVEMILL_CODER_MODEL="$(trim_outer_whitespace "${WAVEMILL_CODER_MODEL:-}")"
if [[ -z "$WAVEMILL_CODER_MODEL" ]]; then
  unset WAVEMILL_CODER_MODEL
fi

WAVEMILL_REVIEWER_MODEL="$(trim_outer_whitespace "${WAVEMILL_REVIEWER_MODEL:-}")"
if [[ -z "$WAVEMILL_REVIEWER_MODEL" ]]; then
  unset WAVEMILL_REVIEWER_MODEL
fi


if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" != "1" ]]; then
  command -v jq >/dev/null || { echo "Error: jq required (install: brew install jq)"; exit 1; }
  command -v npx >/dev/null || { echo "Error: npx required (install: brew install node)"; exit 1; }
  command -v git >/dev/null || { echo "Error: git required"; exit 1; }
  if [[ "$DRY_RUN" != "true" ]]; then
    command -v gh >/dev/null || { echo "Error: gh required (install: brew install gh && gh auth login)"; exit 1; }
    command -v tmux >/dev/null || { echo "Error: tmux required (install: brew install tmux)"; exit 1; }
    agent_validate "$AGENT_CMD" || { echo "Error: agent '$AGENT_CMD' not found"; exit 1; }
  fi

  # Check agent authentication before launching tasks
  if [[ "$DRY_RUN" != "true" ]] && ! agent_check_auth "$AGENT_CMD"; then
    exit 1
  fi

  if [[ -n "${FORCE_MODEL:-}" && (-n "${WAVEMILL_PLANNER_MODEL:-}" || -n "${WAVEMILL_CODER_MODEL:-}" || -n "${WAVEMILL_REVIEWER_MODEL:-}") ]]; then
    log_error "FORCE_MODEL cannot be combined with planner/coder/reviewer model overrides"
    exit 1
  fi
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
  msg="${msg#"${msg%%[![:space:]]*}"}"

  local ts formatted msg_num
  ts="$(date '+%H:%M:%S')"
  formatted="$ts  $msg"

  if [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] && [[ -n "${MILL_LOG_FILE:-}" ]]; then
    printf '%s [%s] %s\n' "$ts" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
  fi

  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}
log_task() {
  local level="$1" task_id="$2"
  shift 2
  log "$level" "$(wavemill_task_log_message "$task_id" "$*")"
}
log_error() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  ERROR: $m"
  append_status_log "$formatted" || echo "$formatted" >&2
}
log_warn() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  WARN: $m"
  append_status_log "$formatted" || echo "$formatted" >&2
}

replay_route_transparency_logs() {
  local stderr_file="$1"
  [[ -s "$stderr_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "[router]"*|"[coder]"*|"[planner]"*|"[reviewer]"*|"[classifier]"*|"[hokusai-router]"*)
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

dotenv_value() {
  local env_file="$1" wanted_key="$2"
  local raw line key value first last
  [[ -f "$env_file" ]] || return 1

  while IFS= read -r raw || [[ -n "$raw" ]]; do
    line="$(printf '%s' "$raw" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ -n "$line" && "$line" != \#* ]] || continue
    if [[ "$line" == export\ * ]]; then
      line="${line#export }"
      line="$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    fi
    [[ "$line" == *=* ]] || continue
    key="$(printf '%s' "${line%%=*}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [[ "$key" == "$wanted_key" ]] || continue
    value="$(printf '%s' "${line#*=}" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    if [[ "${#value}" -ge 2 ]]; then
      first="${value:0:1}"
      last="${value: -1}"
      if [[ "$first" == "$last" && ( "$first" == "'" || "$first" == '"' ) ]]; then
        value="${value:1:${#value}-2}"
      fi
    fi
    printf '%s\n' "$value"
    return 0
  done < "$env_file"

  return 1
}

hydrate_provider_env_from_dotenv() {
  local repo_dir="$1" session="${2:-}"
  local env_file="$repo_dir/.env"
  local key value
  local keys=(
    OPENROUTER_API_KEY
    DEEPSEEK_API_KEY
    OPENAI_API_KEY
    ANTHROPIC_API_KEY
  )
  [[ -f "$env_file" ]] || return 0

  for key in "${keys[@]}"; do
    value="${!key:-}"
    if [[ -z "$value" ]]; then
      value="$(dotenv_value "$env_file" "$key" 2>/dev/null || true)"
      [[ -n "$value" ]] && export "$key=$value"
    fi
    if [[ -n "$session" && -n "${!key:-}" ]]; then
      tmux set-environment -t "$session" "$key" "${!key}" 2>/dev/null || true
    fi
  done
}

create_tmux_session() {
  local tmux_conf
  local next_done_script
  tmux_conf="$(cd "$SCRIPT_DIR/../.." && pwd)/.tmux.conf"
  next_done_script="$SCRIPT_DIR/wavemill-next-done.sh"

  if tmux has-session -t "$SESSION" 2>/dev/null; then
    local existing_dir
    existing_dir=$(tmux show-environment -t "$SESSION" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//') || true
    if [[ -z "$existing_dir" ]]; then
      existing_dir="unknown"
    fi
    if [[ "$existing_dir" != "$REPO_DIR" ]]; then
      echo "ERROR: tmux session '$SESSION' is already bound to a different repo." >&2
      echo "  Requested repo: $REPO_DIR" >&2
      echo "  Active repo:    $existing_dir" >&2
      echo "  Attach:         tmux attach -t $SESSION" >&2
      echo "  Kill:           tmux kill-session -t $SESSION" >&2
      echo "  Override:       SESSION=${SESSION}-alt wavemill mill" >&2
      return 1
    fi
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi

  tmux -f "$tmux_conf" new-session -d -s "$SESSION" -c "$REPO_DIR" -n "$WAVEMILL_WINDOW_MILL"
  # Prevent mill panes from being destroyed if their process crashes.
  # Without this, a dashboard crash collapses the entire control layout.
  tmux set-option -t "$SESSION:$WAVEMILL_WINDOW_MILL" remain-on-exit on 2>/dev/null || true
  tmux set-environment -t "$SESSION" REPO_DIR "$REPO_DIR"
  tmux set-environment -t "$SESSION" WAVEMILL_MILL_ACTIVE "$REPO_DIR"
  hydrate_provider_env_from_dotenv "$REPO_DIR" "$SESSION"
  [[ -n "${WAVEMILL_NO_PROGRESS:-}" ]] && tmux set-environment -t "$SESSION" WAVEMILL_NO_PROGRESS "$WAVEMILL_NO_PROGRESS"
  if [[ -x "$next_done_script" ]]; then
    tmux bind-key -T prefix N run-shell "WAVEMILL_SESSION='#{session_name}' '$next_done_script'"
  fi
  tmux send-keys -t "$SESSION:$WAVEMILL_WINDOW_MILL" "echo 'Mill window for $SESSION'" C-m
}

# Write the launch plan JSON for startup runner consumption.
# Optional fields added when queue planning data is available (HOK-1532).
# Runner currently ignores; reserved for future queue execution work.
# queuePlan (object): planner-supplied wave ordering from plan-queue.ts
# tasks[].dependsOn (string[]): task IDs this task depends on
# tasks[].baseFromTask (string|null): task ID to base branch from
write_launch_plan() {
  local launch_plan_file="$1"
  local queue_plan_json="${2:-}"
  local initial_phase="planning"

  local tasks_json='[]'
  local t issue slug title branch wt_dir linear_issue task_packet_file details_file issue_json_file route_file
  local route_json route_planner route_coder route_reviewer route_plan_depth route_code_depth route_review_mode route_max_cost_usd
  local route_payload challenge_flag challenge_pair challenge_role challenge_model migration_number task_agent
  local depends_on base_from_task

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
    challenge_stage="${TASK_CHALLENGE_STAGE_BY_ISSUE[$issue]:-}"
    migration_number="$(jq -r --arg issue "$issue" '.migrationReservations[$issue] // empty' "$STATE_FILE" 2>/dev/null || echo "")"
    task_agent="${TASK_AGENT_BY_ISSUE[$issue]:-$AGENT_CMD}"

    if [[ -n "${FORCE_MODEL:-}" ]]; then
      route_planner="$FORCE_MODEL"
      route_coder="$FORCE_MODEL"
      route_reviewer="$FORCE_MODEL"
    else
      [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && route_planner="$WAVEMILL_PLANNER_MODEL"
      [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && route_coder="$WAVEMILL_CODER_MODEL"
      [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && route_reviewer="$WAVEMILL_REVIEWER_MODEL"
    fi
    # Extract per-task queue metadata when queue plan is available (HOK-1532)
    depends_on="[]"
    base_from_task="null"
    if [[ -n "$queue_plan_json" ]]; then
      depends_on="$(jq -c --arg id "$issue" '
        (.queuedAfterDependencies // [])
        | map(select(.taskId == $id))
        | if length > 0 then .[0].ancestors else [] end
      ' <<<"$queue_plan_json" 2>/dev/null || echo '[]')"
      base_from_task="$(jq -r --arg id "$issue" '
        (.queuedAfterDependencies // [])
        | map(select(.taskId == $id))
        | if length > 0 then (.[0].ancestors[0] // "null") else "null" end
      ' <<<"$queue_plan_json" 2>/dev/null || echo 'null')"
    fi

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
        reviewMode: $reviewMode,
        maxCostUsd: $maxCostUsd
      } + (if $maxCostUsd == null then {} else {constraints: {maxCostUsd: $maxCostUsd}} end)')"

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
      --arg challengeStage "$challenge_stage" \
      --arg migrationNumber "$migration_number" \
      --arg agent "$task_agent" \
      --argjson dependsOn "$depends_on" \
      --arg baseFromTask "$base_from_task" \
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
        challengeStage: (if $challengeStage == "" then null else $challengeStage end),
        migrationNumber: (if $migrationNumber == "" then null else ($migrationNumber | tonumber) end),
        agent: $agent
      } + (if ($baseFromTask != "null" or ($dependsOn | length > 0)) then {dependsOn: $dependsOn, baseFromTask: (if $baseFromTask == "null" then null else $baseFromTask end)} else {} end)]')"
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
    --arg enterLaunchesWave "${ENTER_LAUNCHES_WAVE:-true}" \
    --arg dashboardVerbosity "$DASHBOARD_VERBOSITY" \
    --arg dashboardLogToFile "$DASHBOARD_LOG_TO_FILE" \
    --arg millLogFile "$MILL_LOG_FILE" \
    --argjson queuePlan "$(if [[ -n "$queue_plan_json" ]]; then printf "%s" "$queue_plan_json"; else printf "null"; fi)" \
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
        enterLaunchesWave: ($enterLaunchesWave == "true"),
        dashboardVerbosity: $dashboardVerbosity,
        dashboardLogToFile: ($dashboardLogToFile == "true")
      }
    } + (if $queuePlan != null then {queuePlan: $queuePlan} else {} end)' > "$launch_plan_file"
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
  cleanup_background_jobs_startup
}


save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}"
  local challenge_stage="${19:-}"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue] = (.tasks[$issue] // {}) + {slug: $slug, branch: $branch, worktree: $worktree, pr: $pr, status: $status, linearIssueId: $linearIssue, updated: (now | todate)}
      | if $agent != "" then .tasks[$issue].agent = $agent else . end
      | if $challenge != "" then .tasks[$issue].challenge = ($challenge == "true") else . end
      | if $challengePair != "" then .tasks[$issue].challengePairId = $challengePair else . end
      | if $challengeRole != "" then .tasks[$issue].challengeRole = $challengeRole else . end
      | if $challengeModel != "" then .tasks[$issue].challengeModel = $challengeModel else . end
      | if $challengeStage != "" then .tasks[$issue].challengeStage = $challengeStage else . end
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
     --arg challengeStage "$challenge_stage" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode"; then
    log_warn "save_task_state: failed to update $issue"
  fi
}

mark_challenge_eval_running() {
  local issue="$1" side="$2" pr="$3" phase="${4:-eval}"
  state_mutate "$STATE_FILE" '
    .tasks[$issue].evalRunning = {
      issue: $issue,
      side: $side,
      pr: ($pr | tonumber),
      phase: $phase,
      startedAt: (now | todateiso8601)
    } |
    .tasks[$issue].updated = (now | todateiso8601)
  ' \
    --arg issue "$issue" \
    --arg side "$side" \
    --arg pr "$pr" \
    --arg phase "$phase"
}

clear_challenge_eval_running() {
  local issue="$1"
  state_mutate "$STATE_FILE" '
    if .tasks[$issue]? then
      .tasks[$issue] |= (del(.evalRunning) | .updated = (now | todateiso8601))
    else
      .
    end
  ' --arg issue "$issue"
}

challenge_eval_retry_max_attempts() {
  local max_attempts
  max_attempts=$(wavemill_load_config "$REPO_DIR" | jq -r '.challenge.eval.retryMaxAttempts // 1' 2>/dev/null || echo "1")
  if [[ "$max_attempts" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_attempts"
  else
    printf '1\n'
  fi
}

challenge_eval_hard_failure_max_retries() {
  local max_retries="${WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES:-2}"
  if [[ "$max_retries" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_retries"
  else
    printf '2\n'
  fi
}

clear_challenge_pair_state() {
  local pair_id="$1"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value |= (
          del(
            .comparisonState,
            .comparisonBlockedReason,
            .comparisonRetryCount,
            .comparisonRetryMaxAttempts,
            .comparisonRetryTargetIssue,
            .comparisonTimedOutSides,
            .manualComparisonArtifact
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )
  ' --arg pair "$pair_id"
}

write_challenge_pair_state() {
  local pair_id="$1" state="$2" reason="${3:-}" retry_count="${4:-0}" retry_max="${5:-0}" retry_target="${6:-}" timed_out_sides_csv="${7:-}" artifact_path="${8:-}"
  state_mutate "$STATE_FILE" '
    ($timedOutSidesCsv
      | split(",")
      | map(gsub("^\\s+|\\s+$"; ""))
      | map(select(length > 0))) as $timedOutSides
    | .tasks |= with_entries(
        if (.value.challengePairId // "") == $pair then
          .value.comparisonState = $state
          | .value.comparisonRetryCount = $retryCount
          | .value.comparisonRetryMaxAttempts = $retryMax
          | .value.updated = (now | todateiso8601)
          | if $reason != "" then .value.comparisonBlockedReason = $reason else .value |= del(.comparisonBlockedReason) end
          | if $retryTarget != "" then .value.comparisonRetryTargetIssue = $retryTarget else .value |= del(.comparisonRetryTargetIssue) end
          | if ($timedOutSides | length) > 0 then .value.comparisonTimedOutSides = $timedOutSides else .value |= del(.comparisonTimedOutSides) end
          | if $artifactPath != "" then .value.manualComparisonArtifact = $artifactPath else .value |= del(.manualComparisonArtifact) end
        else
          .
        end
      )
  ' \
    --arg pair "$pair_id" \
    --arg state "$state" \
    --arg reason "$reason" \
    --arg retryTarget "$retry_target" \
    --arg timedOutSidesCsv "$timed_out_sides_csv" \
    --arg artifactPath "$artifact_path" \
    --argjson retryCount "$retry_count" \
    --argjson retryMax "$retry_max"
}

challenge_pair_timed_out_sides_csv() {
  local issue="$1"
  read_state_value "" --arg i "$issue" '.tasks[$i].comparisonTimedOutSides // [] | join(",")'
}

challenge_pair_timeout_reason() {
  local timed_out_sides_csv="$1"
  case ",$timed_out_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_timed_out\n' ;;
    *,primary,*) printf 'primary_eval_timed_out\n' ;;
    *,challenger,*) printf 'challenger_eval_timed_out\n' ;;
    *) printf 'eval_timed_out\n' ;;
  esac
}

challenge_pair_hard_failure_reason() {
  local failed_sides_csv="$1"
  case ",$failed_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_hard_failed\n' ;;
    *,primary,*) printf 'primary_eval_hard_failed\n' ;;
    *,challenger,*) printf 'challenger_eval_hard_failed\n' ;;
    *) printf 'eval_hard_failed\n' ;;
  esac
}

challenge_pair_records_file() {
  local evals_dir="$REPO_DIR/.wavemill/evals"
  mkdir -p "$evals_dir"
  printf '%s/challenge-records.jsonl\n' "$evals_dir"
}

challenge_pr_url_from_number() {
  local pr="$1"
  local pr_url=""
  if [[ -n "$pr" ]]; then
    pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  fi
  if [[ -n "$pr_url" ]]; then
    printf '%s\n' "$pr_url"
  else
    printf 'https://github.com/unknown/unknown/pull/%s\n' "${pr:-0}"
  fi
}

challenge_pair_record_exists() {
  local pair_id="$1"
  local records_file
  records_file=$(challenge_pair_records_file)
  [[ -f "$records_file" ]] || return 1
  jq -e --arg pair "$pair_id" 'select(.challengePairId == $pair)' "$records_file" >/dev/null 2>&1
}

resolve_challenge_pair_hard_failure() {
  local pair_id="$1"
  local primary_key="$pair_id" challenger_key="${pair_id}_c"
  local primary_exists challenger_exists resolve_output resolve_status resolve_reason
  local retry_max primary_failed challenger_failed primary_completed challenger_completed
  local primary_retry_count challenger_retry_count failed_sides_csv terminal_reason outcome
  local primary_pr challenger_pr primary_model challenger_model primary_pr_url challenger_pr_url
  local winner winner_model rationale timestamp record_json

  [[ -n "$pair_id" ]] || return 1

  if challenge_pair_record_exists "$pair_id"; then
    mark_challenge_compared "$pair_id"
    return 0
  fi

  retry_max=$(challenge_eval_hard_failure_max_retries)
  primary_exists=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i] != null')
  challenger_exists=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i] != null')
  primary_failed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalFailed // false')
  challenger_failed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalFailed // false')
  primary_completed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_completed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
  primary_retry_count=$(read_state_value "0" --arg i "$primary_key" '.tasks[$i].evalHardFailureRetryCount // 0')
  challenger_retry_count=$(read_state_value "0" --arg i "$challenger_key" '.tasks[$i].evalHardFailureRetryCount // 0')

  if [[ "$primary_exists" != "true" || "$challenger_exists" != "true" ]]; then
    resolve_output=$(npx tsx "$TOOLS_DIR/resolve-orphan-challenge-pair.ts" \
      --pair-id "$pair_id" \
      --reason orphan-sibling \
      --repo-dir "$REPO_DIR" 2>/dev/null || true)
    resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)
    if [[ "$resolve_status" == "resolved" || "$resolve_status" == "already-resolved" ]]; then
      mark_challenge_compared "$pair_id"
      if [[ "$resolve_status" == "resolved" ]]; then
        resolve_reason=$(jq -r '.reason // "orphan-sibling"' <<<"$resolve_output" 2>/dev/null || echo "orphan-sibling")
        log_warn "challenge pair $pair_id resolved via $resolve_reason"
      fi
      return 0
    fi
  fi

  failed_sides_csv=""
  [[ "$primary_failed" == "true" ]] && failed_sides_csv="primary"
  if [[ "$challenger_failed" == "true" ]]; then
    if [[ -n "$failed_sides_csv" ]]; then
      failed_sides_csv="${failed_sides_csv},challenger"
    else
      failed_sides_csv="challenger"
    fi
  fi
  [[ -n "$failed_sides_csv" ]] || return 1

  if [[ "$primary_failed" == "true" && "$challenger_failed" == "true" ]]; then
    if (( primary_retry_count < retry_max )); then
      return 1
    fi
    if (( challenger_retry_count < retry_max )); then
      return 1
    fi
    outcome="double-forfeit"
    winner="primary"
    rationale="Both sides exhausted hard eval retries without persisting an eval record."
  elif [[ "$primary_failed" == "true" ]]; then
    [[ "$challenger_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="challenger"
    rationale="Primary exhausted hard eval retries without persisting an eval record."
  elif [[ "$challenger_failed" == "true" ]]; then
    [[ "$primary_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="primary"
    rationale="Challenger exhausted hard eval retries without persisting an eval record."
  else
    return 1
  fi

  terminal_reason=$(challenge_pair_hard_failure_reason "$failed_sides_csv")
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  [[ -n "$primary_pr" && -n "$challenger_pr" ]] || return 1
  primary_model=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  challenger_model=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  primary_pr_url=$(challenge_pr_url_from_number "$primary_pr")
  challenger_pr_url=$(challenge_pr_url_from_number "$challenger_pr")
  if [[ "$winner" == "primary" ]]; then
    winner_model="$primary_model"
  else
    winner_model="$challenger_model"
  fi
  [[ -n "$winner_model" ]] || winner_model="unknown"
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  record_json=$(jq -cn \
    --arg challengePairId "$pair_id" \
    --arg primaryModel "$primary_model" \
    --arg challengerModel "$challenger_model" \
    --arg primaryPrUrl "$primary_pr_url" \
    --arg challengerPrUrl "$challenger_pr_url" \
    --arg winner "$winner" \
    --arg winnerModel "$winner_model" \
    --arg rationale "$rationale" \
    --arg timestamp "$timestamp" \
    --arg comparisonOutcome "$outcome" \
    --arg terminalReason "$terminal_reason" \
    '{
      challengePairId: $challengePairId,
      primaryModel: $primaryModel,
      challengerModel: $challengerModel,
      primaryPrUrl: $primaryPrUrl,
      challengerPrUrl: $challengerPrUrl,
      primaryEvalScore: 0,
      challengerEvalScore: 0,
      winner: $winner,
      winnerModel: $winnerModel,
      rationale: $rationale,
      dimensions: {
        completeness: { primary: 0, challenger: 0 },
        correctness: { primary: 0, challenger: 0 },
        code_quality: { primary: 0, challenger: 0 },
        intervention_impact: { primary: 0, challenger: 0 },
        autonomy: { primary: 0, challenger: 0 }
      },
      timestamp: $timestamp,
      comparisonOutcome: $comparisonOutcome,
      terminalReason: $terminalReason
    }')
  if ! challenge_pair_record_exists "$pair_id"; then
    printf '%s\n' "$record_json" >> "$(challenge_pair_records_file)"
  fi
  mark_challenge_compared "$pair_id"
  log_warn "challenge pair $pair_id resolved via $terminal_reason"
}

challenge_pair_manual_artifact_path() {
  local primary_key="$1"
  local slug worktree
  slug=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].slug // empty')
  worktree=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].worktree // empty')
  [[ -z "$worktree" && -n "$slug" ]] && worktree="${WORKTREE_ROOT}/${slug}"
  [[ -n "$slug" && -n "$worktree" ]] || return 1
  printf '%s/features/%s/ready/challenge-comparison-needed.md\n' "$worktree" "$slug"
}

write_manual_challenge_comparison_artifact() {
  local pair_id="$1" primary_key="$2" challenger_key="$3" timed_out_sides_csv="$4" retry_count="$5" retry_max="$6"
  local artifact_path primary_pr challenger_pr
  artifact_path=$(challenge_pair_manual_artifact_path "$primary_key") || return 1
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  mkdir -p "$(dirname "$artifact_path")"
  cat > "$artifact_path" <<EOF
# Challenge Comparison Needs Manual Action

Pair ID: $pair_id
Primary issue: $primary_key
Challenger issue: $challenger_key
Primary PR: ${primary_pr:-unknown}
Challenger PR: ${challenger_pr:-unknown}
Timed out member(s): ${timed_out_sides_csv:-unknown}
Retry count: $retry_count/$retry_max

Next action:
1. Re-run the timed-out eval job(s) manually when infrastructure is healthy.
2. If eval cannot be recovered quickly, compare PRs #${primary_pr:-?} and #${challenger_pr:-?} manually.
3. Close the losing PR and proceed with the winner.
EOF
  printf '%s\n' "$artifact_path"
}

mark_challenge_comparison_running() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.comparisonRunning = {
          pairId: $pair,
          primaryPr: ($primaryPr | tonumber),
          challengerPr: ($challengerPr | tonumber),
          startedAt: (now | todateiso8601)
        } |
        .value.comparisonState = "comparison_running" |
        .value |= del(.comparisonBlockedReason, .comparisonRetryTargetIssue, .comparisonTimedOutSides, .manualComparisonArtifact) |
        .value.updated = (now | todateiso8601)
      else
        .
      end
    )
  ' \
    --arg pair "$pair_id" \
    --arg primaryPr "$primary_pr" \
    --arg challengerPr "$challenger_pr"
}

clear_challenge_comparison_running() {
  local pair_id="$1"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value |= (del(.comparisonRunning) | .updated = (now | todateiso8601))
      else
        .
      end
    )
  ' --arg pair "$pair_id"
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
  local target="$win" issue="" slug=""
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
    slug="${BASH_REMATCH[3]}"
    local expected_worktree=""
    [[ -n "${WORKTREE_ROOT:-}" ]] && expected_worktree="${WORKTREE_ROOT}/${slug}"
    target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$expected_worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$win"
  target="$(_tmux_target_join "$SESSION" "$target" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$target")"
  if [[ "$state" == "needs-user" ]]; then
    tmux set-window-option -t "$target" window-status-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    tmux set-window-option -t "$target" window-status-current-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  else
    tmux set-window-option -u -t "$target" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$target" window-status-current-style >/dev/null 2>&1 || true
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
  local win="$issue-$slug"
  local target=""
  local target_gone="false"

  # Kill tmux window only when the target is confirmed gone afterward.
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "${WORKTREE_ROOT}/${slug}" 2>/dev/null || true)"
  if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
    target_gone="true"
  else
    execute tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
    if ! _tmux_window_target_exists "$SESSION" "$target"; then
      target_gone="true"
    fi
  fi

  if [[ "$target_gone" != "true" ]]; then
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue cleanup could not close tmux window; keeping task state"
    return 1
  fi

  log "debug" "Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    execute git -C "$REPO_DIR" worktree remove "$wt_dir" --force >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "Removed worktree: $wt_dir"
  fi

  # Delete branch after removing the worktree so Git can detach cleanly first.
  local task_branch="task/${slug}"
  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    if execute git -C "$REPO_DIR" branch -D "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "Deleted local branch: $task_branch"
    else
      log_warn "  Local branch cleanup failed after worktree removal: $task_branch"
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
    log "$issue: Complete ($completion_reason)"
  else
    log "$issue: Complete"
  fi
}


# ============================================================================
# LINEAR API WITH RETRY
# ============================================================================


linear_list_backlog() {
  if [[ "$DRY_RUN" == "true" ]]; then
    local backlog_file="${WAVEMILL_DRY_RUN_BACKLOG_FILE:-}"
    if [[ -z "$backlog_file" ]]; then
      log_error "Dry-run requires WAVEMILL_DRY_RUN_BACKLOG_FILE or --dry-run-backlog."
      return 1
    fi
    if [[ ! -f "$backlog_file" ]]; then
      log_error "Dry-run backlog fixture not found: $backlog_file"
      return 1
    fi
    if ! jq empty "$backlog_file" >/dev/null 2>&1; then
      log_error "Dry-run backlog fixture is not valid JSON: $backlog_file"
      return 1
    fi
    cat "$backlog_file"
    return 0
  fi

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
  if [[ "$DRY_RUN" == "true" ]]; then
    local backlog_file="${WAVEMILL_DRY_RUN_BACKLOG_FILE:-}"
    local issue="$1"
    if [[ -z "$backlog_file" || ! -f "$backlog_file" ]]; then
      log_error "Dry-run issue lookup requires backlog fixture file."
      return 1
    fi

    local selected
    selected="$(jq -cer --arg issue "$issue" '
      map(select(.identifier == $issue or .id == $issue)) | .[0]
    ' "$backlog_file" 2>/dev/null || true)"
    if [[ -z "$selected" || "$selected" == "null" ]]; then
      log_error "Dry-run issue fixture not found for: $issue"
      return 1
    fi
    printf '%s\n' "$selected"
    return 0
  fi

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
  local focus_milestones_json="[]"

  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    focus_milestones_json="$(wavemill_load_config "$REPO_DIR" | jq -c '.backlog.focusMilestones // []' 2>/dev/null || printf '[]')"
  fi

  # Use shared scoring function; strip has_detailed_plan (field 6), keep blocked_by_count (field 7→6)
  score_and_rank_issues "$backlog_json" "$show_limit" "$focus_milestones_json" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}'
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
      count=$((count + 1))
    done <<<"$candidates"


    printf '%s\n' "${result[@]}"
  else
    # User selected specific numbers - extract first 3 fields only
    while read -r n; do
      echo "$candidates" | sed -n "${n}p" | cut -d'|' -f1-3
    done <<<"$(echo "$selected_numbers" | tr ' ' '\n')"
  fi
}

invoke_first_wave_helper() {
  local queue_plan="$1" candidates="$2" max_parallel="${3:-$MAX_PARALLEL}"
  [[ -z "$queue_plan" ]] && return 1

  local tasks_json input_json
  tasks_json=$(awk -F'|' 'NF >= 5 && $1 != "" {
    id = $1
    gsub(/"/, "\\\"", id)
    printf "{\"id\":\"%s\",\"score\":%s}\n", id, ($5 + 0)
  }' <<<"$candidates" | jq -s '.') || return 1

  input_json=$(jq -n \
    --argjson p "$queue_plan" \
    --argjson t "$tasks_json" \
    --argjson m "$max_parallel" \
    '{"plan": $p, "tasks": $t, "maxParallel": ($m | tonumber)}') || return 1

  printf '%s\n' "$input_json" | _with_timeout 10 npx tsx "$TOOLS_DIR/select-wave.ts" 2>/dev/null
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

  cleanup_background_jobs_shutdown 2>/dev/null || true

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
log "info" "  Router: ${ROUTER_ENABLED:-true} (per-task agent+model selection)$(wavemill_config_annotation "router.enabled" "${ROUTER_ENABLED:-true}")"
if (( EFFECTIVE_MAX_PARALLEL < MAX_PARALLEL )); then
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
else
  log "info" "  Max parallel: $MAX_PARALLEL$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
fi
log "info" "  Planning mode: $PLANNING_MODE"
log "info" "  Dashboard verbosity: ${DASHBOARD_VERBOSITY:-info}"
[[ -n "${SETUP_CMD:-}" ]] && log "info" "  Setup command: $SETUP_CMD$(wavemill_config_annotation "mill.setupCommand" "$SETUP_CMD")"
log "info" "  State file: $STATE_FILE"
if [[ -n "${inflight_tasks:-}" ]]; then
  log "info" "  Resume detected: ${inflight_count:-0} in-flight task(s), startup slot limit: $STARTUP_SLOT_LIMIT"
fi
echo ""


# Safety check: first-time repo confirmation (skipped in dry-run)
if [[ ! -f "$STATE_DIR/.initialized" ]] && [[ "$REQUIRE_CONFIRM" == "true" ]] && [[ "$DRY_RUN" != "true" ]]; then
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

PROJECT_CONTEXT_OVERSIZED=""
check_project_context_size() {
  local context_file="$REPO_DIR/.wavemill/project-context.md"
  local threshold_kb="${PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB:-100}"
  local threshold_bytes=$(( threshold_kb * 1024 ))

  PROJECT_CONTEXT_OVERSIZED=""
  if [[ ! -f "$context_file" ]]; then
    project_context_suggestion_clear 2>/dev/null || true
    return 0
  fi

  local size_bytes
  size_bytes="$(get_file_size_bytes "$context_file" 2>/dev/null)" || return 0

  if (( size_bytes > threshold_bytes )); then
    PROJECT_CONTEXT_OVERSIZED=$(( size_bytes / 1024 ))
    project_context_suggestion_set "$size_bytes" "$threshold_bytes" 2>/dev/null || true
    log "info" "  project-context.md is ${PROJECT_CONTEXT_OVERSIZED}KB (>${threshold_kb}KB threshold; suggesting compaction)$(wavemill_config_annotation "projectContext.compactionThresholdKb" "$threshold_kb")"
  else
    project_context_suggestion_clear 2>/dev/null || true
  fi
}


check_project_context_size

if [[ "$SKIP_BACKLOG_SELECTION" != "true" ]]; then
  # Split candidates into unblocked and blocked
  # pick_candidates() outputs 6 fields (has_detailed_plan is stripped), so field 6 is blocked_by_count
  UNBLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 == 0 || $6 == ""')
  BLOCKED=$(echo "$CANDIDATES" | awk -F'|' '$6 > 0')
  WAVE_LAUNCH_LINES=""
  WAVE_LAUNCH_USED=false
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

    if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
      echo ""
      echo "  ⚠ project-context.md is ${PROJECT_CONTEXT_OVERSIZED}KB (>${PROJECT_CONTEXT_COMPACTION_THRESHOLD_KB:-100}KB) - press 'c' to compact"
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
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, m for more, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, m for more, q to quit, or Enter to launch recommended wave:"
        fi
      else
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), d to refresh docs, q to quit, or Enter to launch recommended wave:"
        fi
      fi
    else
      if (( BLOCKED_COUNT > 0 )) && [[ "$SHOW_BLOCKED_TASKS" != "true" ]]; then
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), m for more, c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), m for more, q to quit, or Enter to launch recommended wave:"
        fi
      else
        if [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
          echo "Enter numbers to run (e.g. 1 3 5), c to compact context, q to quit, or Enter to launch recommended wave:"
        else
          echo "Enter numbers to run (e.g. 1 3 5), q to quit, or Enter to launch recommended wave:"
        fi
      fi
    fi
    read -r SELECTED

    if [[ "$SELECTED" =~ ^[cC](ompact)?$ ]] && [[ -n "${PROJECT_CONTEXT_OVERSIZED:-}" ]]; then
      echo ""
      log "info" "Compacting project-context.md..."
      if npx tsx "$TOOLS_DIR/compact-project-context.ts" "$REPO_DIR"; then
        PROJECT_CONTEXT_OVERSIZED=""
        project_context_suggestion_clear 2>/dev/null || true
        echo ""
        log "info" "Compaction complete. Re-displaying task list..."
      fi
      continue
    fi

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

    if [[ -z "$SELECTED" ]]; then
      if [[ "${ENTER_LAUNCHES_WAVE:-true}" == "true" ]]; then
        WAVE_LAUNCH_USED=true
        startup_queue_plan=$(build_queue_plan_once "$BACKLOG" 2>/dev/null) || startup_queue_plan=""
        LAUNCH_QUEUE_PLAN="$startup_queue_plan"
        if [[ -n "$startup_queue_plan" ]]; then
          wave_result=$(invoke_first_wave_helper "$startup_queue_plan" "$UNBLOCKED" "$STARTUP_SLOT_LIMIT" 2>/dev/null) || wave_result=""
          wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
          deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
          [[ -n "$deferred_ids" ]] && log "info" "[wave-launch] deferred: $(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
          while IFS= read -r wid; do
            [[ -z "$wid" ]] && continue
            wline=$(grep -m1 "^${wid}|" <<<"$UNBLOCKED" 2>/dev/null || echo "")
            [[ -n "$wline" ]] && WAVE_LAUNCH_LINES+="${wline}"$'\n'
          done <<<"$wave_ids"
          if [[ -z "$wave_ids" ]]; then
            log "status" "No tasks currently available, waiting on dependencies."
          fi
        else
          WAVE_LAUNCH_USED=false
          [[ -n "$UNBLOCKED" ]] && CANDIDATES="$UNBLOCKED"
        fi
      elif [[ -n "$UNBLOCKED" ]]; then
        CANDIDATES="$UNBLOCKED"
      fi
    fi

    break
  done

  if [[ "$WAVE_LAUNCH_USED" == "true" ]]; then
    SELECTED_LINES="${WAVE_LAUNCH_LINES%$'\n'}"
  else
    SELECTED_LINES="$(smart_select_from_candidates "$CANDIDATES" "$SELECTED")"
  fi
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
declare -A TASK_CHALLENGE_STAGE_BY_ISSUE
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
  if [[ "$DRY_RUN" == "true" ]]; then
    log "debug" "Dry-run: skipping base-branch fetch before migration scan."
  else
    log "debug" "Fetching latest $BASE_BRANCH for migration scan..."
    wavemill_fetch_base_branch "$BASE_BRANCH" --force 2>/dev/null || true
  fi

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
  log "info" "All issues fetched"


  # ── Phase 2: Write task packets (no expansion — agent expands in-pane) ────
  # If the Linear description is already a task packet, use it directly.
  # Otherwise, write the title plus raw description — the planning agent will expand later.
  for t in "${TASKS[@]}"; do
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
    current_desc=$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")

    if is_task_packet "$current_desc"; then
      log "info" "$ISSUE has task packet"
      printf '%s\n' "$current_desc" > "$PACKET_FILE"
    else
      log "info" "$ISSUE title and raw description saved (agent will expand)"
      if [[ -n "$current_desc" ]]; then
        printf '%s\n\n%s\n' "$TITLE" "$current_desc" > "$PACKET_FILE"
      else
        printf '%s\n' "$TITLE" > "$PACKET_FILE"
      fi
    fi
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

  log "status" "$ISSUE ready"
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
  if [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_PLANNER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_PLANNER_MODEL: $WAVEMILL_PLANNER_MODEL"
    exit 1
  fi
  if [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_CODER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_CODER_MODEL: $WAVEMILL_CODER_MODEL"
    exit 1
  fi
  if [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && ! agent_validate_model "$WAVEMILL_REVIEWER_MODEL" "$REPO_DIR"; then
    log_error "Invalid WAVEMILL_REVIEWER_MODEL: $WAVEMILL_REVIEWER_MODEL"
    exit 1
  fi
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

              CODER_AGENT=$(agent_resolve_from_model "${CODER:-}" "coding" || true)
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

            CODER_AGENT=$(agent_resolve_from_model "${CODER:-}" "coding" || true)
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
    rec_agent="$(agent_resolve_from_model "$FORCE_MODEL" "coding" || true)"
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
      rec_agent="$(agent_resolve_from_model "$rec_model" "coding" || true)"
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
    [[ -f "/tmp/${SESSION}-${ISSUE}-taskpacket.md" ]] && challenge_args+=(--file "/tmp/${SESSION}-${ISSUE}-taskpacket.md")
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
    challenge_stage=$(echo "$challenge_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
    primary_entry_planner=$(echo "$challenge_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
    primary_entry_reviewer=$(echo "$challenge_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
    primary_entry_planner_agent=$(echo "$challenge_plan" | jq -r '.entries[0].plannerAgent // empty' 2>/dev/null)
    primary_entry_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[0].planDepth // empty' 2>/dev/null)
    primary_entry_code_depth=$(echo "$challenge_plan" | jq -r '.entries[0].codeDepth // empty' 2>/dev/null)
    primary_entry_review_mode=$(echo "$challenge_plan" | jq -r '.entries[0].reviewMode // empty' 2>/dev/null)
    challenger_entry_planner=$(echo "$challenge_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
    challenger_entry_reviewer=$(echo "$challenge_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
    challenger_entry_planner_agent=$(echo "$challenge_plan" | jq -r '.entries[1].plannerAgent // empty' 2>/dev/null)
    challenger_entry_plan_depth=$(echo "$challenge_plan" | jq -r '.entries[1].planDepth // empty' 2>/dev/null)
    challenger_entry_code_depth=$(echo "$challenge_plan" | jq -r '.entries[1].codeDepth // empty' 2>/dev/null)
    challenger_entry_review_mode=$(echo "$challenge_plan" | jq -r '.entries[1].reviewMode // empty' 2>/dev/null)

    cp "/tmp/${SESSION}-${ISSUE}-taskpacket.md" "/tmp/${SESSION}-${challenger_key}-taskpacket.md" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-issue.json" "/tmp/${SESSION}-${challenger_key}-issue.json" 2>/dev/null || true
    cp "/tmp/${SESSION}-${ISSUE}-taskpacket-details.md" "/tmp/${SESSION}-${challenger_key}-taskpacket-details.md" 2>/dev/null || true

    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]="primary"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_CHALLENGE_STAGE_BY_ISSUE["$ISSUE"]="$challenge_stage"
    TASK_AGENT_BY_ISSUE["$ISSUE"]="${primary_entry_planner_agent:-${primary_agent:-$rec_agent}}"
    TASK_PLANNER_MODEL_BY_ISSUE["$ISSUE"]="${primary_entry_planner:-$route_planner}"
    TASK_CODER_MODEL_BY_ISSUE["$ISSUE"]="$primary_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$ISSUE"]="${primary_entry_reviewer:-$route_reviewer}"
    TASK_PLAN_DEPTH_BY_ISSUE["$ISSUE"]="${primary_entry_plan_depth:-$route_plan_depth}"
    TASK_CODE_DEPTH_BY_ISSUE["$ISSUE"]="${primary_entry_code_depth:-$route_code_depth}"
    TASK_REVIEW_MODE_BY_ISSUE["$ISSUE"]="${primary_entry_review_mode:-$route_review_mode}"

    TASK_LINEAR_ISSUE_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$challenger_key"]="true"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$challenger_key"]="$ISSUE"
    TASK_CHALLENGE_ROLE_BY_ISSUE["$challenger_key"]="challenger"
    TASK_CHALLENGE_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_CHALLENGE_STAGE_BY_ISSUE["$challenger_key"]="$challenge_stage"
    TASK_AGENT_BY_ISSUE["$challenger_key"]="${challenger_entry_planner_agent:-${challenger_agent:-$AGENT_CMD}}"
    # Stage-varied challengers carry their own planner/reviewer in the entry
    TASK_PLANNER_MODEL_BY_ISSUE["$challenger_key"]="${challenger_entry_planner:-$route_planner}"
    TASK_CODER_MODEL_BY_ISSUE["$challenger_key"]="$challenger_model"
    TASK_REVIEWER_MODEL_BY_ISSUE["$challenger_key"]="${challenger_entry_reviewer:-$route_reviewer}"
    TASK_PLAN_DEPTH_BY_ISSUE["$challenger_key"]="${challenger_entry_plan_depth:-$route_plan_depth}"
    TASK_CODE_DEPTH_BY_ISSUE["$challenger_key"]="${challenger_entry_code_depth:-$route_code_depth}"
    TASK_REVIEW_MODE_BY_ISSUE["$challenger_key"]="${challenger_entry_review_mode:-$route_review_mode}"

    FINAL_LAUNCH_ARGS+=("$ISSUE|$SLUG|$TITLE")
    FINAL_LAUNCH_ARGS+=("$challenger_key|$challenger_slug|$TITLE")
    slots_used=$((slots_used + 1))  # Challenger is free overhead
    primary_varied=$(echo "$challenge_plan" | jq -r '.entries[0].variedModel // .entries[0].model // empty' 2>/dev/null)
    challenger_varied=$(echo "$challenge_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null)
    log "status" "  $ISSUE: Challenge selected (stage=${challenge_stage}: ${primary_varied} vs ${challenger_varied}) [challenger is extra pane]"
  else
    if [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  $ISSUE: Challenge skipped ($challenge_reason), launching single-model run"
    fi
    TASK_LINEAR_ISSUE_BY_ISSUE["$ISSUE"]="$ISSUE"
    TASK_CHALLENGE_BY_ISSUE["$ISSUE"]="false"
    TASK_CHALLENGE_PAIR_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_ROLE_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_MODEL_BY_ISSUE["$ISSUE"]=""
    TASK_CHALLENGE_STAGE_BY_ISSUE["$ISSUE"]=""
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
STATUS_LOG_FILE="/tmp/${SESSION}-mill-status.log"
MONITOR_ENV="/tmp/${SESSION}-monitor.env"
MONITOR_SCRIPT="/tmp/${SESSION}-monitor.sh"
LAUNCHED_ISSUES_FILE="/tmp/${SESSION}-launched-issues.txt"
cat > "$MONITOR_SCRIPT" <<'MONITOR_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail


# Import environment from env file
source "$1"

run_linear_retry_drain_tick() {
  [[ "$DRY_RUN" == "true" ]] && return 0

  local stamp_file="${STATE_DIR}/linear-retry-drain.last-run"
  local now last_run=0
  now="$(date +%s)"
  if [[ -f "$stamp_file" ]]; then
    last_run="$(cat "$stamp_file" 2>/dev/null || echo 0)"
  fi

  if (( now - last_run < 60 )); then
    return 0
  fi

  printf '%s\n' "$now" > "$stamp_file"
  npx tsx "$TOOLS_DIR/linear-retry-drain.ts" drain --max-entries 10 >/dev/null 2>&1 || true
}

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
  msg="${msg#"${msg%%[![:space:]]*}"}"

  local ts formatted msg_num
  ts="$(date '+%H:%M:%S')"
  formatted="$ts  $msg"

  if [[ "${DASHBOARD_LOG_TO_FILE:-true}" == "true" ]] && [[ -n "${MILL_LOG_FILE:-}" ]]; then
    printf '%s [%s] %s\n' "$ts" "$level" "$msg" >> "$MILL_LOG_FILE" 2>/dev/null || true
  fi

  msg_num=$(_log_level_num "$level")
  if (( msg_num <= VERBOSITY_NUM )); then
    append_status_log "$formatted" || echo "$formatted"
  fi
}
log_task() {
  local level="$1" task_id="$2"
  shift 2
  log "$level" "$(wavemill_task_log_message "$task_id" "$*")"
}
log_error() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  ERROR: $m"
  append_status_log "$formatted" || echo "$formatted" >&2
}
log_warn() {
  local m="$*"
  m="${m#"${m%%[![:space:]]*}"}"
  local formatted
  formatted="$(date '+%H:%M:%S')  WARN: $m"
  append_status_log "$formatted" || echo "$formatted" >&2
}

replay_route_transparency_logs() {
  local stderr_file="$1"
  [[ -s "$stderr_file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      "[router]"*|"[coder]"*|"[planner]"*|"[reviewer]"*|"[classifier]"*|"[hokusai-router]"*)
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

CODEX_CAPACITY_MESSAGE="Selected model is at capacity. Please try a different model."
CODEX_CAPACITY_REASON="model_at_capacity"

wavemill_capacity_stall_seconds() {
  local raw="${WAVEMILL_CAPACITY_STALL_SECONDS:-45}"

  if [[ ! "$raw" =~ ^[0-9]+$ ]]; then
    printf '45\n'
    return 0
  fi

  if (( raw > 299 )); then
    printf '299\n'
    return 0
  fi

  printf '%s\n' "$raw"
}

codex_capacity_recovery_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-capacity-recovery.json"
}

codex_capacity_dwell_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-capacity-dwell.json"
}

codex_capacity_clear_dwell_marker() {
  local feature_dir="$1"
  rm -f "$(codex_capacity_dwell_marker "$feature_dir")" 2>/dev/null || true
}

codex_capacity_pane_tail() {
  local issue="$1" slug="$2" worktree="$3"
  local target=""

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 1

  tmux capture-pane -p -t "$target" -S -80 2>/dev/null || return 1
}

codex_capacity_tail_has_terminal_prompt() {
  local tail="${1-}"
  local last_nonempty=""
  local line=""
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"

  [[ -n "$tail" ]] || return 1
  printf '%s\n' "$tail" | grep -Fq "$capacity_message" || return 1

  while IFS= read -r line; do
    [[ -n "${line//[[:space:]]/}" ]] || continue
    last_nonempty="$line"
  done <<< "$tail"

  [[ -n "$last_nonempty" ]] || return 1
  [[ "$last_nonempty" != "$capacity_message" ]] || return 1

  if [[ "$last_nonempty" =~ ^[[:space:]]*(>|›|❯|\$|%|>>>)[[:space:]]*$ ]]; then
    return 0
  fi

  return 1
}

codex_capacity_hook_status() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state hook_agent hook_detail hook_ts now staleness
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"
  local capacity_reason="${CODEX_CAPACITY_REASON:-model_at_capacity}"

  [[ -f "$hook_file" ]] || return 1

  hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
  hook_agent=$(jq -r '.agent // empty' "$hook_file" 2>/dev/null || echo "")
  hook_detail=$(jq -r '.detail // empty' "$hook_file" 2>/dev/null || echo "")
  hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")

  [[ "$hook_state" == "error" ]] || return 1
  [[ -z "$hook_agent" || "$hook_agent" == "codex" ]] || return 1

  now="$(date +%s)"
  staleness=$(( now - hook_ts ))
  (( staleness >= 0 && staleness < 300 )) || return 1

  if [[ "$hook_detail" == ${capacity_reason}:* ]] || [[ "$hook_detail" == *"$capacity_message"* ]]; then
    return 0
  fi

  return 1
}

codex_capacity_record_dwell() {
  local feature_dir="$1" source="$2"
  local marker tmp_file now existing_first_seen existing_source first_seen

  marker="$(codex_capacity_dwell_marker "$feature_dir")"
  tmp_file="$(mktemp "$marker.tmp.XXXXXX" 2>/dev/null)" || return 1
  now="$(date +%s)"
  existing_first_seen="$(jq -r '.firstSeen // empty' "$marker" 2>/dev/null || echo "")"
  existing_source="$(jq -r '.source // empty' "$marker" 2>/dev/null || echo "")"

  if [[ -n "$existing_first_seen" && "$existing_first_seen" =~ ^[0-9]+$ && "$existing_source" == "$source" ]]; then
    first_seen="$existing_first_seen"
  else
    first_seen="$now"
  fi

  if ! jq -n \
    --arg source "$source" \
    --argjson firstSeen "$first_seen" \
    --argjson lastSeen "$now" \
    '{source: $source, firstSeen: $firstSeen, lastSeen: $lastSeen}' > "$tmp_file" 2>/dev/null; then
    rm -f "$tmp_file"
    return 1
  fi

  mv "$tmp_file" "$marker" 2>/dev/null || {
    rm -f "$tmp_file"
    return 1
  }

  printf '%s\n' "$first_seen"
}

codex_capacity_idle_confirmed() {
  local issue="$1" slug="$2" feature_dir="$3" worktree="$4"
  local source="" first_seen="" now dwell_seconds tail=""

  if codex_capacity_hook_status "$issue"; then
    source="hook"
  else
    tail="$(codex_capacity_pane_tail "$issue" "$slug" "$worktree" 2>/dev/null || true)"
    if codex_capacity_tail_has_terminal_prompt "$tail"; then
      source="pane"
    else
      codex_capacity_clear_dwell_marker "$feature_dir"
      return 1
    fi
  fi

  first_seen="$(codex_capacity_record_dwell "$feature_dir" "$source" 2>/dev/null || true)"
  [[ "$first_seen" =~ ^[0-9]+$ ]] || return 1

  now="$(date +%s)"
  dwell_seconds="$(wavemill_capacity_stall_seconds)"
  (( now - first_seen >= dwell_seconds ))
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
    tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.$pane" >/dev/null 2>&1 || continue
    tmux kill-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.$pane" >/dev/null 2>&1 || true
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
  local challenge_stage="${19:-}"

  # Resolve traceId from feature directory (HOK-2259) — best-effort, never fails
  local _trace_id_for_state=""
  for _dir_prefix in features bugs; do
    local _ctx_candidate="$worktree/$_dir_prefix/$slug/.trace-context.json"
    if [[ -f "$_ctx_candidate" ]]; then
      _trace_id_for_state=$(jq -r '.traceId // empty' "$_ctx_candidate" 2>/dev/null || true)
      break
    fi
  done

  if ! state_mutate "$STATE_FILE" \
     '(.tasks[$issue].agent // "") as $old_agent |
      (.tasks[$issue].phase // "executing") as $old_phase |
      (.tasks[$issue].evalCompleted // false) as $old_eval |
      (.tasks[$issue].evalFailed // false) as $old_eval_failed |
      (.tasks[$issue].evalHardFailureRetryCount // 0) as $old_eval_hard_failure_retry_count |
      (.tasks[$issue].challengeCompared // false) as $old_challenge_compared |
      (.tasks[$issue].challenge // false) as $old_challenge |
      (.tasks[$issue].challengePairId // "") as $old_challenge_pair |
      (.tasks[$issue].challengeRole // "") as $old_challenge_role |
      (.tasks[$issue].challengeModel // "") as $old_challenge_model |
      (.tasks[$issue].challengeStage // "") as $old_challenge_stage |
      (.tasks[$issue].evalRunning // null) as $old_eval_running |
      (.tasks[$issue].comparisonRunning // null) as $old_comparison_running |
      (.tasks[$issue].comparisonState // null) as $old_comparison_state |
      (.tasks[$issue].comparisonBlockedReason // null) as $old_comparison_blocked_reason |
      (.tasks[$issue].comparisonRetryCount // null) as $old_comparison_retry_count |
      (.tasks[$issue].comparisonRetryMaxAttempts // null) as $old_comparison_retry_max_attempts |
      (.tasks[$issue].comparisonRetryTargetIssue // null) as $old_comparison_retry_target_issue |
      (.tasks[$issue].comparisonTimedOutSides // null) as $old_comparison_timed_out_sides |
      (.tasks[$issue].manualComparisonArtifact // null) as $old_manual_comparison_artifact |
      (.tasks[$issue].linearIssueId // $issue) as $old_linear_issue |
      (.tasks[$issue].coderModel // "") as $old_coderModel |
      (.tasks[$issue].plannerModel // "") as $old_plannerModel |
      (.tasks[$issue].reviewerModel // "") as $old_reviewerModel |
      (.tasks[$issue].planDepth // "") as $old_planDepth |
      (.tasks[$issue].codeDepth // "") as $old_codeDepth |
      (.tasks[$issue].reviewMode // "") as $old_reviewMode |
      (.tasks[$issue].traceId // "") as $old_traceId |
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
        challengeStage: (if $challengeStage != "" then $challengeStage else $old_challenge_stage end),
        coderModel: (if $coderModel != "" then $coderModel else $old_coderModel end),
        plannerModel: (if $plannerModel != "" then $plannerModel else $old_plannerModel end),
        reviewerModel: (if $reviewerModel != "" then $reviewerModel else $old_reviewerModel end),
        planDepth: (if $planDepth != "" then $planDepth else $old_planDepth end),
        codeDepth: (if $codeDepth != "" then $codeDepth else $old_codeDepth end),
        reviewMode: (if $reviewMode != "" then $reviewMode else $old_reviewMode end),
        traceId: (if $traceId != "" then $traceId else $old_traceId end),
        phase: $old_phase,
        evalCompleted: $old_eval,
        evalFailed: $old_eval_failed,
        evalHardFailureRetryCount: $old_eval_hard_failure_retry_count,
        challengeCompared: $old_challenge_compared,
        evalRunning: $old_eval_running,
        comparisonRunning: $old_comparison_running,
        comparisonState: $old_comparison_state,
        comparisonBlockedReason: $old_comparison_blocked_reason,
        comparisonRetryCount: $old_comparison_retry_count,
        comparisonRetryMaxAttempts: $old_comparison_retry_max_attempts,
        comparisonRetryTargetIssue: $old_comparison_retry_target_issue,
        comparisonTimedOutSides: $old_comparison_timed_out_sides,
        manualComparisonArtifact: $old_manual_comparison_artifact,
        updated: (now | todate)
      }' \
     --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
     --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" \
     --arg agent "$agent" --arg linearIssue "$linear_issue" --arg challenge "$challenge" \
     --arg challengePair "$challenge_pair" --arg challengeRole "$challenge_role" \
     --arg challengeModel "$challenge_model" \
     --arg challengeStage "$challenge_stage" \
     --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
     --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode" \
     --arg traceId "$_trace_id_for_state"; then
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
     '.tasks[$issue].evalCompleted = true
      | .tasks[$issue].evalFailed = false
      | .tasks[$issue].evalHardFailureRetryCount = 0
      | del(.tasks[$issue].evalRunning)
      | .tasks[$issue].updated = (now | todateiso8601)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_completed: failed to update $issue"
  fi
}

mark_eval_failed() {
  local issue="$1"
  if ! state_mutate "$STATE_FILE" \
     '.tasks[$issue].evalFailed = true
      | del(.tasks[$issue].evalRunning)
      | .tasks[$issue].updated = (now | todateiso8601)' \
     --arg issue "$issue"; then
    log_warn "mark_eval_failed: failed to update $issue"
  fi
}

# Duplicated intentionally: the pre-heredoc definitions do not enter the
# generated monitor script, so challenge launchers need local monitor copies.
mark_challenge_eval_running() {
  local issue="$1" side="$2" pr="$3" phase="${4:-eval}"
  state_mutate "$STATE_FILE" '
    .tasks[$issue].evalRunning = {
      issue: $issue,
      side: $side,
      pr: ($pr | tonumber),
      phase: $phase,
      startedAt: (now | todateiso8601)
    } |
    .tasks[$issue].updated = (now | todateiso8601)
  ' \
    --arg issue "$issue" \
    --arg side "$side" \
    --arg pr "$pr" \
    --arg phase "$phase"
}

mark_challenge_comparison_running() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value.comparisonRunning = {
          pairId: $pair,
          primaryPr: ($primaryPr | tonumber),
          challengerPr: ($challengerPr | tonumber),
          startedAt: (now | todateiso8601)
        } |
        .value.comparisonState = "comparison_running" |
        .value |= del(.comparisonBlockedReason, .comparisonRetryTargetIssue, .comparisonTimedOutSides, .manualComparisonArtifact) |
        .value.updated = (now | todateiso8601)
      else
        .
      end
    )
  ' \
    --arg pair "$pair_id" \
    --arg primaryPr "$primary_pr" \
    --arg challengerPr "$challenger_pr"
}

challenge_eval_retry_max_attempts() {
  local max_attempts
  max_attempts=$(wavemill_load_config "$REPO_DIR" | jq -r '.challenge.eval.retryMaxAttempts // 1' 2>/dev/null || echo "1")
  if [[ "$max_attempts" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_attempts"
  else
    printf '1\n'
  fi
}

challenge_eval_hard_failure_max_retries() {
  local max_retries="${WAVEMILL_EVAL_HARD_FAILURE_MAX_RETRIES:-2}"
  if [[ "$max_retries" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$max_retries"
  else
    printf '2\n'
  fi
}

clear_challenge_pair_state() {
  local pair_id="$1"
  state_mutate "$STATE_FILE" '
    .tasks |= with_entries(
      if (.value.challengePairId // "") == $pair then
        .value |= (
          del(
            .comparisonState,
            .comparisonBlockedReason,
            .comparisonRetryCount,
            .comparisonRetryMaxAttempts,
            .comparisonRetryTargetIssue,
            .comparisonTimedOutSides,
            .manualComparisonArtifact
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )
  ' --arg pair "$pair_id"
}

write_challenge_pair_state() {
  local pair_id="$1" state="$2" reason="${3:-}" retry_count="${4:-0}" retry_max="${5:-0}" retry_target="${6:-}" timed_out_sides_csv="${7:-}" artifact_path="${8:-}"
  state_mutate "$STATE_FILE" '
    ($timedOutSidesCsv
      | split(",")
      | map(gsub("^\\s+|\\s+$"; ""))
      | map(select(length > 0))) as $timedOutSides
    | .tasks |= with_entries(
        if (.value.challengePairId // "") == $pair then
          .value.comparisonState = $state
          | .value.comparisonRetryCount = $retryCount
          | .value.comparisonRetryMaxAttempts = $retryMax
          | .value.updated = (now | todateiso8601)
          | if $reason != "" then .value.comparisonBlockedReason = $reason else .value |= del(.comparisonBlockedReason) end
          | if $retryTarget != "" then .value.comparisonRetryTargetIssue = $retryTarget else .value |= del(.comparisonRetryTargetIssue) end
          | if ($timedOutSides | length) > 0 then .value.comparisonTimedOutSides = $timedOutSides else .value |= del(.comparisonTimedOutSides) end
          | if $artifactPath != "" then .value.manualComparisonArtifact = $artifactPath else .value |= del(.manualComparisonArtifact) end
        else
          .
        end
      )
  ' \
    --arg pair "$pair_id" \
    --arg state "$state" \
    --arg reason "$reason" \
    --arg retryTarget "$retry_target" \
    --arg timedOutSidesCsv "$timed_out_sides_csv" \
    --arg artifactPath "$artifact_path" \
    --argjson retryCount "$retry_count" \
    --argjson retryMax "$retry_max"
}

challenge_pair_timed_out_sides_csv() {
  local issue="$1"
  read_state_value "" --arg i "$issue" '.tasks[$i].comparisonTimedOutSides // [] | join(",")'
}

challenge_pair_timeout_reason() {
  local timed_out_sides_csv="$1"
  case ",$timed_out_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_timed_out\n' ;;
    *,primary,*) printf 'primary_eval_timed_out\n' ;;
    *,challenger,*) printf 'challenger_eval_timed_out\n' ;;
    *) printf 'eval_timed_out\n' ;;
  esac
}

challenge_pair_hard_failure_reason() {
  local failed_sides_csv="$1"
  case ",$failed_sides_csv," in
    *,primary,challenger,*|*,challenger,primary,*) printf 'both_eval_hard_failed\n' ;;
    *,primary,*) printf 'primary_eval_hard_failed\n' ;;
    *,challenger,*) printf 'challenger_eval_hard_failed\n' ;;
    *) printf 'eval_hard_failed\n' ;;
  esac
}

challenge_pair_records_file() {
  local evals_dir="$REPO_DIR/.wavemill/evals"
  mkdir -p "$evals_dir"
  printf '%s/challenge-records.jsonl\n' "$evals_dir"
}

challenge_pr_url_from_number() {
  local pr="$1"
  local pr_url=""
  if [[ -n "$pr" ]]; then
    pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  fi
  if [[ -n "$pr_url" ]]; then
    printf '%s\n' "$pr_url"
  else
    printf 'https://github.com/unknown/unknown/pull/%s\n' "${pr:-0}"
  fi
}

challenge_pair_record_exists() {
  local pair_id="$1"
  local records_file
  records_file=$(challenge_pair_records_file)
  [[ -f "$records_file" ]] || return 1
  jq -e --arg pair "$pair_id" 'select(.challengePairId == $pair)' "$records_file" >/dev/null 2>&1
}

resolve_challenge_pair_hard_failure() {
  local pair_id="$1"
  local primary_key="$pair_id" challenger_key="${pair_id}_c"
  local primary_exists challenger_exists resolve_output resolve_status resolve_reason
  local retry_max primary_failed challenger_failed primary_completed challenger_completed
  local primary_retry_count challenger_retry_count failed_sides_csv terminal_reason outcome
  local primary_pr challenger_pr primary_model challenger_model primary_pr_url challenger_pr_url
  local winner winner_model rationale timestamp record_json

  [[ -n "$pair_id" ]] || return 1

  if challenge_pair_record_exists "$pair_id"; then
    mark_challenge_compared "$pair_id"
    return 0
  fi

  retry_max=$(challenge_eval_hard_failure_max_retries)
  primary_exists=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i] != null')
  challenger_exists=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i] != null')
  primary_failed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalFailed // false')
  challenger_failed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalFailed // false')
  primary_completed=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_completed=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
  primary_retry_count=$(read_state_value "0" --arg i "$primary_key" '.tasks[$i].evalHardFailureRetryCount // 0')
  challenger_retry_count=$(read_state_value "0" --arg i "$challenger_key" '.tasks[$i].evalHardFailureRetryCount // 0')

  if [[ "$primary_exists" != "true" || "$challenger_exists" != "true" ]]; then
    resolve_output=$(npx tsx "$TOOLS_DIR/resolve-orphan-challenge-pair.ts" \
      --pair-id "$pair_id" \
      --reason orphan-sibling \
      --repo-dir "$REPO_DIR" 2>/dev/null || true)
    resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)
    if [[ "$resolve_status" == "resolved" || "$resolve_status" == "already-resolved" ]]; then
      mark_challenge_compared "$pair_id"
      if [[ "$resolve_status" == "resolved" ]]; then
        resolve_reason=$(jq -r '.reason // "orphan-sibling"' <<<"$resolve_output" 2>/dev/null || echo "orphan-sibling")
        log_warn "challenge pair $pair_id resolved via $resolve_reason"
      fi
      return 0
    fi
  fi

  failed_sides_csv=""
  [[ "$primary_failed" == "true" ]] && failed_sides_csv="primary"
  if [[ "$challenger_failed" == "true" ]]; then
    if [[ -n "$failed_sides_csv" ]]; then
      failed_sides_csv="${failed_sides_csv},challenger"
    else
      failed_sides_csv="challenger"
    fi
  fi
  [[ -n "$failed_sides_csv" ]] || return 1

  if [[ "$primary_failed" == "true" && "$challenger_failed" == "true" ]]; then
    if (( primary_retry_count < retry_max )); then
      return 1
    fi
    if (( challenger_retry_count < retry_max )); then
      return 1
    fi
    outcome="double-forfeit"
    winner="primary"
    rationale="Both sides exhausted hard eval retries without persisting an eval record."
  elif [[ "$primary_failed" == "true" ]]; then
    [[ "$challenger_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="challenger"
    rationale="Primary exhausted hard eval retries without persisting an eval record."
  elif [[ "$challenger_failed" == "true" ]]; then
    [[ "$primary_completed" == "true" ]] || return 1
    outcome="forfeit"
    winner="primary"
    rationale="Challenger exhausted hard eval retries without persisting an eval record."
  else
    return 1
  fi

  terminal_reason=$(challenge_pair_hard_failure_reason "$failed_sides_csv")
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  [[ -n "$primary_pr" && -n "$challenger_pr" ]] || return 1
  primary_model=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  challenger_model=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].challengeModel // .tasks[$i].coderModel // empty')
  primary_pr_url=$(challenge_pr_url_from_number "$primary_pr")
  challenger_pr_url=$(challenge_pr_url_from_number "$challenger_pr")
  if [[ "$winner" == "primary" ]]; then
    winner_model="$primary_model"
  else
    winner_model="$challenger_model"
  fi
  [[ -n "$winner_model" ]] || winner_model="unknown"
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  record_json=$(jq -cn \
    --arg challengePairId "$pair_id" \
    --arg primaryModel "$primary_model" \
    --arg challengerModel "$challenger_model" \
    --arg primaryPrUrl "$primary_pr_url" \
    --arg challengerPrUrl "$challenger_pr_url" \
    --arg winner "$winner" \
    --arg winnerModel "$winner_model" \
    --arg rationale "$rationale" \
    --arg timestamp "$timestamp" \
    --arg comparisonOutcome "$outcome" \
    --arg terminalReason "$terminal_reason" \
    '{
      challengePairId: $challengePairId,
      primaryModel: $primaryModel,
      challengerModel: $challengerModel,
      primaryPrUrl: $primaryPrUrl,
      challengerPrUrl: $challengerPrUrl,
      primaryEvalScore: 0,
      challengerEvalScore: 0,
      winner: $winner,
      winnerModel: $winnerModel,
      rationale: $rationale,
      dimensions: {
        completeness: { primary: 0, challenger: 0 },
        correctness: { primary: 0, challenger: 0 },
        code_quality: { primary: 0, challenger: 0 },
        intervention_impact: { primary: 0, challenger: 0 },
        autonomy: { primary: 0, challenger: 0 }
      },
      timestamp: $timestamp,
      comparisonOutcome: $comparisonOutcome,
      terminalReason: $terminalReason
    }')
  if ! challenge_pair_record_exists "$pair_id"; then
    printf '%s\n' "$record_json" >> "$(challenge_pair_records_file)"
  fi
  mark_challenge_compared "$pair_id"
  log_warn "challenge pair $pair_id resolved via $terminal_reason"
}

challenge_pair_manual_artifact_path() {
  local primary_key="$1"
  local slug worktree
  slug=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].slug // empty')
  worktree=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].worktree // empty')
  [[ -z "$worktree" && -n "$slug" ]] && worktree="${WORKTREE_ROOT}/${slug}"
  [[ -n "$slug" && -n "$worktree" ]] || return 1
  printf '%s/features/%s/ready/challenge-comparison-needed.md\n' "$worktree" "$slug"
}

write_manual_challenge_comparison_artifact() {
  local pair_id="$1" primary_key="$2" challenger_key="$3" timed_out_sides_csv="$4" retry_count="$5" retry_max="$6"
  local artifact_path primary_pr challenger_pr
  artifact_path=$(challenge_pair_manual_artifact_path "$primary_key") || return 1
  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  mkdir -p "$(dirname "$artifact_path")"
  cat > "$artifact_path" <<EOF
# Challenge Comparison Needs Manual Action

Pair ID: $pair_id
Primary issue: $primary_key
Challenger issue: $challenger_key
Primary PR: ${primary_pr:-unknown}
Challenger PR: ${challenger_pr:-unknown}
Timed out member(s): ${timed_out_sides_csv:-unknown}
Retry count: $retry_count/$retry_max

Next action:
1. Re-run the timed-out eval job(s) manually when infrastructure is healthy.
2. If eval cannot be recovered quickly, compare PRs #${primary_pr:-?} and #${challenger_pr:-?} manually.
3. Close the losing PR and proceed with the winner.
EOF
  printf '%s\n' "$artifact_path"
}

eval_record_exists_for_issue_pr() {
  local issue="$1" pr="$2"
  local pr_url evals_dir evals_file

  [[ -z "$issue" || -z "$pr" ]] && return 1

  pr_url=$(gh pr view "$pr" --json url --jq .url 2>/dev/null || true)
  [[ -z "$pr_url" ]] && return 1

  evals_dir=$(wavemill_load_config "$REPO_DIR" | jq -r '.eval.evalsDir // ".wavemill/evals"' 2>/dev/null || echo ".wavemill/evals")
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
  local result_file="$feature_dir/.${stage}-result.json" previous_status=""

  # Capture the transition before either writer replaces the result. A malformed
  # or missing result is intentionally treated as an unknown prior state.
  if [[ -f "$result_file" ]]; then
    previous_status="$(jq -r '.status // empty' "$result_file" 2>/dev/null || true)"
  fi

  # Try the TypeScript CLI first (HOK-1192: structured writes with artifacts support)
  if [[ -n "${TOOLS_DIR:-}" ]]; then
    local cli_args=("$feature_dir" "$stage" "$status")
    [[ -n "$agent" ]] && cli_args+=(--agent "$agent")
    [[ -n "$model" ]] && cli_args+=(--model "$model")
    [[ -n "$notes" ]] && cli_args+=(--notes "$notes")
    [[ -n "$artifacts_json" ]] && cli_args+=(--artifacts "$artifacts_json")

    if npx tsx "$TOOLS_DIR/stage-result-cli.ts" write "${cli_args[@]}" 2>/dev/null; then
      _write_stage_result_trace_event "$feature_dir" "$stage" "$status" "$agent" "$model" "$previous_status"
      return 0
    fi
    log_warn "write_stage_result: TypeScript CLI failed, falling back to shell"
  fi

  # Fallback: inline JSON construction (legacy path)
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
  _write_stage_result_trace_event "$feature_dir" "$stage" "$status" "$agent" "$model" "$previous_status"
}

# Emit trace events when a stage result is written (HOK-2259).
# Best-effort — never fails. Reads trace context from the feature directory.
_write_stage_result_trace_event() {
  local feature_dir="$1" stage="$2" status="$3" agent="${4:-}" model="${5:-}" previous_status="${6:-}"
  local _tid _iid _sl
  _tid=$(trace_read_id "$feature_dir" 2>/dev/null || true)
  [[ -n "$_tid" ]] || return 0
  _iid=$(jq -r '.issueId // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
  _sl=$(jq -r '.slug // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
  [[ -n "$_iid" && -n "$_sl" ]] || return 0

  case "$status" in
    running)
      [[ "$previous_status" != "running" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_started" "ok" "$model" "$agent" 2>/dev/null || true
      ;;
    completed)
      [[ "$previous_status" != "completed" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_completed" "ok" "$model" "$agent" 2>/dev/null || true
      ;;
    failed|aborted)
      [[ "$previous_status" != "$status" ]] || return 0
      trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "$stage" "phase_completed" "failed" "$model" "$agent" \
        "$(jq -cn --arg st "$status" '{meta:{stageStatus:$st}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
      ;;
  esac
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

clear_ready_conflict_markers() {
  local feature_dir="$1"
  rm -f "$feature_dir/.conflict-detected" "$feature_dir/.needs-attention" "$feature_dir/.conflict-recheck-at"
  clear_ready_conflict_attention "$feature_dir"
}

ready_conflict_recheck_interval_seconds() {
  local configured="${WAVEMILL_READY_CONFLICT_RECHECK_SECONDS:-}"
  if [[ "$configured" =~ ^[0-9]+$ ]] && (( configured >= 10 )); then
    printf '%s\n' "$configured"
  else
    printf '60\n'
  fi
}

ready_conflict_recheck_due() {
  local feature_dir="$1"
  local recheck_file="$feature_dir/.conflict-recheck-at"
  local last_recheck interval now
  if [[ ! -f "$recheck_file" ]]; then
    return 0
  fi

  last_recheck="$(cat "$recheck_file" 2>/dev/null || echo "")"
  if [[ ! "$last_recheck" =~ ^[0-9]+$ ]]; then
    return 0
  fi

  interval="$(ready_conflict_recheck_interval_seconds)"
  now="$(date +%s)"
  (( now - last_recheck >= interval ))
}

write_ready_conflict_recheck_at() {
  local feature_dir="$1"
  local recheck_file="$feature_dir/.conflict-recheck-at"
  local tmp_file
  mkdir -p "$feature_dir"
  tmp_file="$(mktemp "$feature_dir/.conflict-recheck-at.tmp.XXXXXX")"
  printf '%s\n' "$(date +%s)" > "$tmp_file"
  mv "$tmp_file" "$recheck_file"
}

ready_conflict_pr_is_clean() {
  local feature_dir="$1" pr_number="$2" issue="$3"
  local pr_json mergeable merge_state

  if pr_json=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr_number" --json mergeable,mergeStateStatus 2>/dev/null); then
    write_ready_conflict_recheck_at "$feature_dir"
  else
    write_ready_conflict_recheck_at "$feature_dir"
    log "debug" "ready conflict recheck for $issue PR #$pr_number failed"
    return 1
  fi

  mergeable="$(printf '%s' "$pr_json" | jq -r '.mergeable // ""' 2>/dev/null || echo "")"
  merge_state="$(printf '%s' "$pr_json" | jq -r '.mergeStateStatus // ""' 2>/dev/null || echo "")"

  if [[ "$mergeable" == "MERGEABLE" && "$merge_state" == "CLEAN" ]]; then
    log "status" "ready conflict recheck for $issue PR #$pr_number: MERGEABLE/CLEAN (clearing stale markers)"
    return 0
  fi

  log "debug" "ready conflict recheck for $issue PR #$pr_number: ${mergeable:-empty}/${merge_state:-empty}"
  return 1
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
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{remediation:{enabled:true,maxAttempts:3,agentCmd:""}}} * $user * $repo * $local).ready.remediation
    ' 2>/dev/null || echo '{"enabled":true,"maxAttempts":3,"agentCmd":""}'
}

ready_watchdog_config_json() {
  local wt_dir="$1"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$wt_dir/.wavemill-config.json"
  local local_config="$wt_dir/.wavemill-config.local.json"
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'

  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')

  jq -n -c \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ({ready:{watchdog:{enabled:true,thresholdMinutes:10,autoRecover:true,timeoutSeconds:30,stableFailureConsecutivePolls:2,stableFailureEscalateAfterPolls:4,safeRemediationCategories:["lint","type","test","build","migration-chain","alembic"]}}} * $user * $repo * $local) as $merged
    | (($merged.monitor.readyWatchdog // {}) + ($merged.ready.watchdog // {}))
    ' 2>/dev/null || echo '{"enabled":true,"thresholdMinutes":10,"autoRecover":true,"timeoutSeconds":30,"stableFailureConsecutivePolls":2,"stableFailureEscalateAfterPolls":4,"safeRemediationCategories":["lint","type","test","build","migration-chain","alembic"]}'
}

run_ready_watchdog_tick() {
  local watchdog_json watchdog_enabled watchdog_timeout
  watchdog_json=$(ready_watchdog_config_json "$REPO_DIR")
  watchdog_enabled=$(printf '%s' "$watchdog_json" | jq -r '.enabled // true' 2>/dev/null || echo "true")
  [[ "$watchdog_enabled" == "true" ]] || return 0

  watchdog_timeout=$(printf '%s' "$watchdog_json" | jq -r '.timeoutSeconds // 30' 2>/dev/null || echo "30")
  [[ "$watchdog_timeout" =~ ^[0-9]+$ ]] || watchdog_timeout=30

  local watchdog_output
  if ! watchdog_output=$(_with_timeout "$watchdog_timeout" \
    npx tsx "$TOOLS_DIR/ready-watchdog.ts" \
      --once \
      --repo-dir "$REPO_DIR" \
      --state-file "$STATE_FILE" \
      --json 2>/dev/null); then
    log_warn "ready watchdog tick failed"
    return 0
  fi

  while IFS= read -r finding; do
    [[ -n "$finding" ]] || continue
    local issue label detail action slug branch base_branch pr_number title wt_dir state_dir remediation_categories
    issue=$(printf '%s' "$finding" | jq -r '.issueId // empty' 2>/dev/null || echo "")
    label=$(printf '%s' "$finding" | jq -r '.displayLabel // empty' 2>/dev/null || echo "")
    detail=$(printf '%s' "$finding" | jq -r '.detail // empty' 2>/dev/null || echo "")
    action=$(printf '%s' "$finding" | jq -r '.action // empty' 2>/dev/null || echo "")
    [[ -n "$issue" && -n "$label" && -n "$detail" ]] || continue
    if [[ "$action" == "queue-remediation" ]]; then
      slug=$(read_state_value "" --arg i "$issue" '.tasks[$i].slug // ""')
      branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].branch // ""')
      base_branch=$(read_state_value "" --arg i "$issue" '.tasks[$i].baseBranch // ""')
      pr_number=$(read_state_value "" --arg i "$issue" '.tasks[$i].pr // ""')
      title=$(read_state_value "" --arg i "$issue" '.tasks[$i].title // "Task"')
      wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
      [[ -z "$wt_dir" && -n "$slug" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
      if [[ -n "$slug" && -n "$branch" && -n "$base_branch" && -n "$pr_number" ]]; then
        state_dir=$(ready_state_dir "$wt_dir" "$slug")
        remediation_categories=$(printf '%s' "$finding" | jq -c '.remediationCategories // []' 2>/dev/null || echo '[]')
        mkdir -p "$state_dir"
        printf '%s\n' "$(jq -cn --argjson categories "$remediation_categories" --arg detail "$detail" '{categories:$categories, detail:$detail}')" \
          > "$state_dir/.ready-watchdog-stable-failure.json"
        launch_ready_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$base_branch" "$pr_number" >/dev/null 2>&1 || true
      fi
    fi
    log "status" "ready watchdog: $issue $label ($action) - $detail"
  done < <(printf '%s' "$watchdog_output" | jq -c '.findings[]?' 2>/dev/null)
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
  local model="" launch_model=""

  case "$stage" in
    coding)
      model=$(read_phase_config "$feature_dir" "coding" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "coderModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.coding-result.json" 2>/dev/null || echo "")
      model="$(resolve_phase_model "coding" "$model" "${fallback:-claude-opus-4-7}")"
      if declare -F agent_resolve_model >/dev/null 2>&1; then
        launch_model="$(agent_resolve_model "coder" "$model" "$REPO_DIR" 2>/dev/null || true)"
      fi
      ;;
    review)
      model=$(read_phase_config "$feature_dir" "review" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$ISSUE" "reviewerModel")
      [[ -z "$model" ]] && model=$(jq -r '.model // empty' "$feature_dir/.review-result.json" 2>/dev/null || echo "")
      model="$(resolve_phase_model "review" "$model" "${fallback:-claude-sonnet-5}")"
      if declare -F agent_resolve_model >/dev/null 2>&1; then
        launch_model="$(agent_resolve_model "reviewer" "$model" "$REPO_DIR" 2>/dev/null || true)"
      fi
      ;;
    *)
      model="$fallback"
      ;;
  esac

  printf '%s\n' "${launch_model:-$model}"
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

  VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES=()

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

  VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES=("${out_of_scope_files[@]}")
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

planning_rejection_files_summary() {
  local -a files=("$@")
  local joined=""
  local file

  if [[ ${#files[@]} -eq 0 ]]; then
    printf 'out-of-scope files'
    return 0
  fi

  for file in "${files[@]:0:3}"; do
    if [[ -n "$joined" ]]; then
      joined+=", "
    fi
    joined+="$file"
  done

  if (( ${#files[@]} > 3 )); then
    joined+=" (+$(( ${#files[@]} - 3 )) more)"
  fi

  printf '%s' "$joined"
}

write_planning_rejection_artifact() {
  local issue="$1" feature_dir="$2"
  shift 2
  local -a files=("$@")
  local artifact="$feature_dir/.planning-rejected.json"
  local files_json created_at

  mkdir -p "$feature_dir"
  if (( ${#files[@]} == 0 )); then
    files_json='[]'
  else
    files_json=$(printf '%s\n' "${files[@]}" | jq -R . | jq -s . 2>/dev/null || printf '[]')
  fi
  created_at=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  jq -n \
    --arg issue "$issue" \
    --arg stage "planning" \
    --arg status "awaiting_user" \
    --arg reason "planning_modified_out_of_scope_files" \
    --arg createdAt "$created_at" \
    --arg recommendedAction "Review plan.md and re-approve the plan. Planning may only write feature artifacts." \
    --argjson outOfScopeFiles "$files_json" \
    '{issue: $issue, stage: $stage, status: $status, reason: $reason, outOfScopeFiles: $outOfScopeFiles, reverted: true, approvalMarkerRemoved: true, recommendedAction: $recommendedAction, createdAt: $createdAt}' > "$artifact"
}

notify_planning_rejection_agent() {
  local feature_dir="$1" win="$2"
  shift 2
  local -a files=("$@")
  local artifact="$feature_dir/.planning-rejected.json"
  local slug files_summary notified tmp message target issue

  [[ -n "${SESSION:-}" && -n "$win" && -f "$artifact" ]] || return 0

  notified=$(jq -r '.notifiedAt // empty' "$artifact" 2>/dev/null || true)
  [[ -z "$notified" ]] || return 0

  slug="$(basename "$feature_dir")"
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
    local expected_worktree=""
    [[ -n "${WORKTREE_ROOT:-}" ]] && expected_worktree="${WORKTREE_ROOT}/${slug}"
    target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$expected_worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$win"
  target="$(_tmux_target_join "$SESSION" "$target" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$target")"

  if command -v _pane_is_dead_or_idle >/dev/null 2>&1 && _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  if [[ "$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1)" == "1" ]]; then
    return 0
  fi

  files_summary="$(planning_rejection_files_summary "${files[@]}")"
  message="Planning approval was rejected because planning modified out-of-scope files: $files_summary. Those changes were reverted and .plan-approved was removed. Do not edit source/config files during planning. Update only features/$slug/plan.md if needed, then wait for user approval again."

  tmux send-keys -t "$target" "$message" C-m 2>/dev/null || return 0

  tmp=$(mktemp "${artifact}.tmp.XXXXXX" 2>/dev/null) || return 0
  jq --arg notifiedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" '.notifiedAt = $notifiedAt' "$artifact" > "$tmp" 2>/dev/null \
    && mv "$tmp" "$artifact" 2>/dev/null \
    || rm -f "$tmp"
}

blocked_completion_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.blocked-completion-announced"
}

blocked_completion_should_announce() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker last_announced effective_mtime

  # Use UNKNOWN sentinel when stat is unavailable so dedupe still works
  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(blocked_completion_announce_marker "$feature_dir")"
  [[ -f "$marker" ]] || return 0

  last_announced="$(head -1 "$marker" 2>/dev/null | tr -d '\r')"
  [[ "$last_announced" != "$effective_mtime" ]]
}

mark_blocked_completion_announced() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker tmp_file effective_mtime

  # Use UNKNOWN sentinel when stat is unavailable so dedupe still works
  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(blocked_completion_announce_marker "$feature_dir")"
  tmp_file="$(mktemp "$feature_dir/.blocked-completion-announced.tmp.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$effective_mtime" > "$tmp_file" && mv "$tmp_file" "$marker" 2>/dev/null || rm -f "$tmp_file"
}

emit_blocked_completion_attention() {
  local issue="$1" feature_dir="$2"
  local artifact_record summary reason artifact_mtime slug win

  artifact_record="$(read_blocked_completion "$feature_dir")"
  [[ -n "$artifact_record" ]] || return 1

  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"
  slug="$(basename "$feature_dir")"
  win="$issue-$slug"

  if blocked_completion_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $summary. Type \"advance $issue\" to launch review."
    mark_blocked_completion_announced "$feature_dir" "$artifact_mtime"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

blocked_completion_live_process_mode() {
  case "${WAVEMILL_BLOCKED_COMPLETION_LIVE_PROCESS_MODE:-attention}" in
    terminate) printf 'terminate\n' ;;
    *) printf 'attention\n' ;;
  esac
}

emit_blocked_completion_liveness_attention() {
  local issue="$1" feature_dir="$2" win="$3" detail="$4" next_action="$5"
  local artifact_record summary reason artifact_mtime
  local hook_protocol="$LIB_DIR/../hooks/wavemill-hook-protocol.sh"

  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"

  if blocked_completion_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $detail. $next_action"
    mark_blocked_completion_announced "$feature_dir" "$artifact_mtime"
  fi

  if [[ -f "$hook_protocol" ]]; then
    source "$hook_protocol" || true
    WAVEMILL_SESSION="$SESSION" WAVEMILL_ISSUE="$issue" \
      wavemill_hook_write "blocked" "blocked_completion_liveness" "$detail" "${current_agent:-unknown}" "$next_action" || true
  fi

  set_window_attention_state "$win" "needs-user"
  AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED="attention"
  active_count=$((active_count + 1))
  return 0
}

write_codex_capacity_blocked_completion() {
  local issue="$1" feature_dir="$2" model="${3:-}" source="${4:-unknown}"
  local artifact recovery_marker artifact_tmp recovery_tmp slug timestamp
  local capacity_message="${CODEX_CAPACITY_MESSAGE:-Selected model is at capacity. Please try a different model.}"
  local capacity_reason="${CODEX_CAPACITY_REASON:-model_at_capacity}"

  artifact="$(blocked_completion_artifact_path "$feature_dir")"
  recovery_marker="$(codex_capacity_recovery_marker "$feature_dir")"
  slug="$(basename "$feature_dir")"
  timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

  [[ -f "$artifact" ]] && return 1
  [[ -f "$recovery_marker" ]] && return 0

  artifact_tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -n \
    --arg reason "$capacity_reason" \
    --arg blockingReason "${capacity_reason}: $capacity_message" \
    --arg evidence "Codex pane was idle at the terminal capacity prompt after confirmation dwell." \
    --arg recommendedAction "retry_with_available_model_or_relaunch_coding" \
    --arg summary "coding blocked: Codex model at capacity" \
    --arg detectedAt "$timestamp" \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg model "$model" \
    --arg source "$source" \
    '{
      stage: "coding",
      implementationComplete: false,
      committed: false,
      passingChecks: [],
      blockingChecks: ["codex_model_capacity"],
      blockingReason: $blockingReason,
      evidence: $evidence,
      recommendedAction: $recommendedAction,
      summary: $summary,
      reason: $reason,
      detectedAt: $detectedAt,
      issue: $issue,
      slug: $slug,
      model: (if ($model | length) > 0 then $model else null end),
      source: $source
    }' > "$artifact_tmp"; then
    rm -f "$artifact_tmp"
    return 1
  fi

  mv "$artifact_tmp" "$artifact" 2>/dev/null || {
    rm -f "$artifact_tmp"
    return 1
  }

  recovery_tmp="$(mktemp "$recovery_marker.tmp.XXXXXX" 2>/dev/null)" || return 1
  if ! jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg model "$model" \
    --arg source "$source" \
    --arg action "wrote_blocked_completion" \
    --arg reason "$capacity_reason" \
    --arg detectedAt "$timestamp" \
    '{
      issue: $issue,
      slug: $slug,
      model: (if ($model | length) > 0 then $model else null end),
      source: $source,
      action: $action,
      reason: $reason,
      detectedAt: $detectedAt
    }' > "$recovery_tmp"; then
    rm -f "$recovery_tmp"
    return 1
  fi

  mv "$recovery_tmp" "$recovery_marker" 2>/dev/null || {
    rm -f "$recovery_tmp"
    return 1
  }

  codex_capacity_clear_dwell_marker "$feature_dir"
}

blocked_completion_current_head() {
  local worktree="$1"
  git -C "$worktree" rev-parse HEAD 2>/dev/null || true
}

coding_output_dirty_paths() {
  local worktree="$1" slug="$2"
  local status_lines line path normalized_path

  status_lines="$(git -C "$worktree" status --porcelain --untracked-files=all 2>/dev/null || true)"
  [[ -z "$status_lines" ]] && return 0

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    path="${line#?? }"
    if [[ "$path" == *" -> "* ]]; then
      path="${path##* -> }"
    fi
    normalized_path="${path#./}"

    if blocked_completion_auto_allowed_dirty_path "$normalized_path" "$slug"; then
      continue
    fi

    printf '%s\n' "$normalized_path"
  done <<< "$status_lines"
}

blocked_completion_commit_matches_head() {
  local artifact_commit="${1:-}" head="${2:-}"

  [[ -z "$artifact_commit" ]] && return 0
  [[ -n "$head" ]] || return 1
  [[ "$artifact_commit" == "$head" ]] && return 0
  [[ "$head" == "$artifact_commit"* ]] && return 0
  return 1
}

# wavemill_owned_feature_artifact_path <normalized_path> <slug>
# Returns 0 when the path is a Wavemill-owned artifact scoped to features/<slug>/.
wavemill_owned_feature_artifact_path() {
  local normalized_path="$1" slug="$2"
  local artifact_prefix="features/$slug/"

  if [[ "$normalized_path" == ${artifact_prefix}.* ]]; then
    return 0
  fi

  case "$normalized_path" in
    "${artifact_prefix}plan.md"|\
    "${artifact_prefix}task-packet"*.md|\
    "${artifact_prefix}selected-task.json"|\
    "${artifact_prefix}trace.jsonl"|\
    "${artifact_prefix}routing.jsonl")
      return 0
      ;;
  esac

  return 1
}

blocked_completion_auto_allowed_dirty_path() {
  local normalized_path="$1" slug="$2"

  if [[ "$normalized_path" == .wavemill/* ]]; then
    return 0
  fi

  # Root prompt registry updates are Wavemill-owned generated metadata.
  if [[ "$normalized_path" == "prompt-registry.jsonl" ]]; then
    return 0
  fi

  wavemill_owned_feature_artifact_path "$normalized_path" "$slug"
}

blocked_completion_worktree_clean_for_auto() {
  local worktree="$1" slug="$2"
  [[ -z "$(coding_output_dirty_paths "$worktree" "$slug")" ]]
}

coding_uncommitted_output_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-uncommitted-output-announced"
}

coding_uncommitted_output_should_announce() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker last_announced effective_mtime

  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(coding_uncommitted_output_announce_marker "$feature_dir")"
  [[ -f "$marker" ]] || return 0

  last_announced="$(head -1 "$marker" 2>/dev/null | tr -d '\r')"
  [[ "$last_announced" != "$effective_mtime" ]]
}

mark_coding_uncommitted_output_announced() {
  local feature_dir="$1" artifact_mtime="${2:-}"
  local marker tmp_file effective_mtime

  effective_mtime="${artifact_mtime:-UNKNOWN}"
  marker="$(coding_uncommitted_output_announce_marker "$feature_dir")"
  tmp_file="$(mktemp "$feature_dir/.coding-uncommitted-output-announced.tmp.XXXXXX" 2>/dev/null)" || return 0
  printf '%s\n' "$effective_mtime" > "$tmp_file" && mv "$tmp_file" "$marker" 2>/dev/null || rm -f "$tmp_file"
}

clear_coding_uncommitted_output_attention() {
  local feature_dir="$1"
  rm -f "$(coding_uncommitted_output_artifact_path "$feature_dir")" "$(coding_uncommitted_output_announce_marker "$feature_dir")"
}

coding_compare_commit_counts() {
  local worktree="$1" base_branch="$2"
  git -C "$worktree" rev-list --left-right --count "$base_branch...HEAD" 2>/dev/null || printf '0\t0\n'
}

write_coding_uncommitted_output_artifact() {
  local issue="$1" feature_dir="$2" base_branch="$3" ahead_count="$4" behind_count="$5" dirty_paths_raw="${6:-}" summary="$7" action="$8" reason="${9:-coding_output_not_committed}"
  local artifact slug artifact_tmp first_path dirty_paths_json

  artifact="$(coding_uncommitted_output_artifact_path "$feature_dir")"
  slug="$(basename "$feature_dir")"
  artifact_tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 1
  first_path="$(printf '%s\n' "$dirty_paths_raw" | head -1)"
  dirty_paths_json="$(printf '%s\n' "$dirty_paths_raw" | jq -R . | jq -s . 2>/dev/null || printf '[]')"

  if ! jq -n \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg baseBranch "$base_branch" \
    --arg reason "$reason" \
    --arg summary "$summary" \
    --arg action "$action" \
    --arg firstDirtyPath "$first_path" \
    --argjson aheadCount "$ahead_count" \
    --argjson behindCount "$behind_count" \
    --argjson dirtyPaths "$dirty_paths_json" \
    --arg detectedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      issue: $issue,
      slug: $slug,
      reason: $reason,
      baseBranch: $baseBranch,
      aheadCount: $aheadCount,
      behindCount: $behindCount,
      dirtyPaths: $dirtyPaths,
      firstDirtyPath: (if ($firstDirtyPath | length) > 0 then $firstDirtyPath else null end),
      summary: $summary,
      action: $action,
      detectedAt: $detectedAt
    }' > "$artifact_tmp"; then
    rm -f "$artifact_tmp"
    return 1
  fi

  mv "$artifact_tmp" "$artifact" 2>/dev/null || {
    rm -f "$artifact_tmp"
    return 1
  }
}

guard_coding_complete_handoff() {
  local issue="$1" feature_dir="$2" worktree="$3" base_branch="$4"
  local slug dirty_paths compare_counts behind_count ahead_count artifact_record summary reason action artifact_mtime
  local handoff_summary handoff_action handoff_reason
  local win

  slug="$(basename "$feature_dir")"
  dirty_paths="$(coding_output_dirty_paths "$worktree" "$slug")"
  if [[ -z "$dirty_paths" ]]; then
    clear_coding_uncommitted_output_attention "$feature_dir"
    return 1
  fi

  compare_counts="$(coding_compare_commit_counts "$worktree" "$base_branch")"
  behind_count="${compare_counts%%[[:space:]]*}"
  ahead_count="${compare_counts##*[[:space:]]}"
  [[ "$behind_count" =~ ^[0-9]+$ ]] || behind_count=0
  [[ "$ahead_count" =~ ^[0-9]+$ ]] || ahead_count=0

  if [[ "$ahead_count" == "0" ]]; then
    handoff_reason="coding_output_not_committed"
    handoff_summary="coding completed marker detected, but branch has no commits beyond $base_branch and worktree still contains uncommitted coding output"
    handoff_action="Commit the coding output, then retry review."
  else
    handoff_reason="coding_output_dirty_tree"
    handoff_summary="coding completed marker detected, but worktree still contains uncommitted coding output"
    handoff_action="Clean the dirty paths, then retry review."
  fi

  write_coding_uncommitted_output_artifact "$issue" "$feature_dir" "$base_branch" "$ahead_count" "$behind_count" "$dirty_paths" "$handoff_summary" "$handoff_action" "$handoff_reason" || true
  artifact_record="$(read_coding_uncommitted_output "$feature_dir")"
  IFS=$'\001' read -r summary reason action artifact_mtime <<< "$artifact_record"
  win="$issue-$slug"

  if coding_uncommitted_output_should_announce "$feature_dir" "$artifact_mtime"; then
    log "status" "$issue needs attention: $summary. $action"
    mark_coding_uncommitted_output_announced "$feature_dir" "$artifact_mtime"
  fi

  write_stage_result "$feature_dir" "coding" "running" "${current_agent:-}" "$(resolve_stage_result_model "$feature_dir" "coding" "claude-opus-4-7")" "Awaiting committed coding output before review"
  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

blocked_completion_validate_for_advance() {
  local issue="$1" feature_dir="$2" mode="${3:-auto}"
  local slug artifact_path artifact_rel_path result_path result_rel_path worktree
  local json_valid=false schema_valid=false stage_running=false stage_is_coding=false
  local implementation_complete=false committed=false recommended_action_matches=false
  local has_passing_checks=false has_blocking_checks=false commit_matches_head=true
  local worktree_clean=true artifact_commit="" current_head="" decision_reason=""
  local manual_soft_failure=false

  slug="$(basename "$feature_dir")"
  worktree="$(git -C "$feature_dir/../.." rev-parse --show-toplevel 2>/dev/null || true)"
  artifact_path="$feature_dir/.coding-blocked-completion.json"
  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  result_path="$feature_dir/.coding-result.json"
  result_rel_path="features/$slug/.coding-result.json"

  if [[ ! -f "$artifact_path" ]]; then
    decision_reason="missing blocked-completion artifact"
  elif ! jq empty "$artifact_path" >/dev/null 2>&1; then
    decision_reason="invalid JSON in $artifact_rel_path"
  else
    json_valid=true

    if jq -e '
      type == "object" and
      (.stage | type == "string") and
      (.implementationComplete | type == "boolean") and
      (.committed | type == "boolean") and
      (.passingChecks | type == "array") and
      all(.passingChecks[]?; type == "string") and
      ((has("blockingChecks") | not) or (.blockingChecks | type == "array")) and
      all((.blockingChecks // [])[]?; type == "string") and
      (.blockingReason | type == "string") and
      (.evidence | type == "string") and
      (.recommendedAction | type == "string") and
      ((has("commit") | not) or (.commit | type == "string"))
    ' "$artifact_path" >/dev/null 2>&1; then
      schema_valid=true
    else
      decision_reason="blocked-completion artifact is missing required fields"
    fi
  fi

  if [[ "$json_valid" == true && "$schema_valid" == true ]]; then
    stage_is_coding=$(jq -r 'if .stage == "coding" then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    implementation_complete=$(jq -r 'if .implementationComplete == true then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    committed=$(jq -r 'if .committed == true then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    recommended_action_matches=$(jq -r 'if .recommendedAction == "advance_to_review" then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    has_passing_checks=$(jq -r 'if ((.passingChecks | length) > 0) then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    has_blocking_checks=$(jq -r 'if ((.blockingChecks | length) > 0) then "true" else "false" end' "$artifact_path" 2>/dev/null || echo false)
    artifact_commit=$(jq -r '.commit // empty' "$artifact_path" 2>/dev/null || echo "")

    if [[ ! -f "$result_path" ]]; then
      decision_reason="${decision_reason:-missing $result_rel_path}"
    elif ! jq -e '.stage == "coding" and .status == "running"' "$result_path" >/dev/null 2>&1; then
      decision_reason="${decision_reason:-$result_rel_path is not coding/running}"
    else
      stage_running=true
    fi

    if [[ "$stage_is_coding" != true ]]; then
      decision_reason="${decision_reason:-blocked-completion artifact stage is not coding}"
    elif [[ "$implementation_complete" != true ]]; then
      decision_reason="${decision_reason:-implementationComplete must be true}"
    elif [[ "$committed" != true ]]; then
      decision_reason="${decision_reason:-committed must be true}"
    elif [[ "$recommended_action_matches" != true ]]; then
      decision_reason="${decision_reason:-recommendedAction must be advance_to_review}"
    elif [[ "$has_passing_checks" != true ]]; then
      decision_reason="${decision_reason:-passingChecks must be non-empty}"
    fi
  fi

  if [[ -n "$artifact_commit" ]]; then
    current_head="$(blocked_completion_current_head "$worktree")"
    if ! blocked_completion_commit_matches_head "$artifact_commit" "$current_head"; then
      commit_matches_head=false
      if [[ "$mode" == "auto" ]]; then
        decision_reason="${decision_reason:-artifact commit does not match HEAD}"
      else
        manual_soft_failure=true
      fi
    fi
  fi

  if ! blocked_completion_worktree_clean_for_auto "$worktree" "$slug"; then
    worktree_clean=false
    if [[ "$mode" == "auto" ]]; then
      decision_reason="${decision_reason:-worktree is not clean enough for auto-advance}"
    else
      manual_soft_failure=true
    fi
  fi

  if [[ -z "$decision_reason" && "$mode" == "manual" && "$manual_soft_failure" == true ]]; then
    decision_reason="manual override accepted with soft guardrail failures"
  fi
  [[ -z "$decision_reason" ]] && decision_reason="eligible"

  jq -n \
    --arg issue "$issue" \
    --arg mode "$mode" \
    --arg artifactPath "$artifact_rel_path" \
    --arg resultPath "$result_rel_path" \
    --arg reason "$decision_reason" \
    --arg commit "$artifact_commit" \
    --arg head "$current_head" \
    --argjson stageRunning "$stage_running" \
    --argjson jsonValid "$json_valid" \
    --argjson schemaValid "$schema_valid" \
    --argjson stageIsCoding "$stage_is_coding" \
    --argjson implementationComplete "$implementation_complete" \
    --argjson committed "$committed" \
    --argjson recommendedActionMatches "$recommended_action_matches" \
    --argjson hasPassingChecks "$has_passing_checks" \
    --argjson hasBlockingChecks "$has_blocking_checks" \
    --argjson commitMatchesHead "$commit_matches_head" \
    --argjson worktreeClean "$worktree_clean" \
    --argjson eligible "$(
      if [[ "$decision_reason" == "eligible" || "$decision_reason" == "manual override accepted with soft guardrail failures" ]]; then
        printf 'true'
      else
        printf 'false'
      fi
    )" \
    '{
      issue: $issue,
      mode: $mode,
      eligible: $eligible,
      reason: $reason,
      artifactPath: $artifactPath,
      resultPath: $resultPath,
      commit: $commit,
      head: $head,
      guardrails: {
        stageRunning: $stageRunning,
        jsonValid: $jsonValid,
        schemaValid: $schemaValid,
        stageIsCoding: $stageIsCoding,
        implementationComplete: $implementationComplete,
        committed: $committed,
        recommendedActionMatches: $recommendedActionMatches,
        hasPassingChecks: $hasPassingChecks,
        hasBlockingChecks: $hasBlockingChecks,
        commitMatchesHead: $commitMatchesHead,
        worktreeClean: $worktreeClean
      }
    }'

  if [[ "$decision_reason" == "eligible" || "$decision_reason" == "manual override accepted with soft guardrail failures" ]]; then
    return 0
  fi

  return 1
}

complete_coding_advance() {
  local issue="$1" feature_dir="$2" audit_path="$3" stage_notes="$4"
  local audit_timestamp="${5:-}" summary="${6:-}" slug="${7:-}" passing_count="${8:-}" blocking_count="${9:-}" decision_json="${10:-}" blocked_json="${11:-}"
  local marker_path advance_agent result_path result_model finished_at audit_tmp

  if [[ -n "$audit_timestamp" ]]; then
    if [[ ! -f "$audit_path" ]] && ! printf '{}\n' | write_json_artifact "$audit_path"; then
      log_warn "$issue advance failed: could not initialize audit artifact"
      return 1
    fi

    if ! state_mutate "$audit_path" '
        .timestamp = $timestamp
        | .issue = $issue
        | .slug = $slug
        | .commit = ($validation.commit // "")
        | .reason = $reason
        | .blocked_completion_path = $blockedCompletionPath
        | .blocked_completion_summary = $blockedCompletionSummary
        | .guardrails = ($validation.guardrails // {})
        | .passing_checks_count = ($passingChecksCount | tonumber)
        | .blocking_checks_count = ($blockingChecksCount | tonumber)
        | .blockedCompletion = (($blocked[0] // {}) | {
            stage,
            implementationComplete,
            committed,
            commit,
            passingChecks,
            blockingChecks,
            blockingReason,
            evidence,
            recommendedAction
          })
      ' \
      --arg timestamp "$audit_timestamp" \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg reason "automatic advance from valid blocked-completion artifact" \
      --arg blockedCompletionPath "features/$slug/.coding-blocked-completion.json" \
      --arg blockedCompletionSummary "$summary" \
      --arg passingChecksCount "$passing_count" \
      --arg blockingChecksCount "$blocking_count" \
      --argjson validation "$decision_json" \
      --argjson blocked "$blocked_json"; then
      log_warn "$issue advance failed: could not finalize audit artifact"
      return 1
    fi
  else
    audit_tmp="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || {
      log_warn "$issue advance failed: could not create audit artifact"
      return 1
    }
    cat > "$audit_tmp"
    if ! mv "$audit_tmp" "$audit_path"; then
      rm -f "$audit_tmp"
      log_warn "$issue advance failed: could not finalize audit artifact"
      return 1
    fi
  fi

  advance_agent="${current_agent:-}"
  result_model="$(resolve_stage_result_model "$feature_dir" "coding" "claude-opus-4-7")"
  result_path="$feature_dir/.coding-result.json"
  if [[ ! -f "$result_path" ]]; then
    log_warn "$issue advance failed: missing coding stage result"
    return 1
  fi

  finished_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  if ! state_mutate "$result_path" '
      .stage = "coding"
      | .status = "completed"
      | .startedAt = (.startedAt // $finishedAt)
      | .finishedAt = $finishedAt
      | .agent = $agent
      | .model = $model
      | .notes = $notes
    ' \
    --arg finishedAt "$finished_at" \
    --arg agent "$advance_agent" \
    --arg model "$result_model" \
    --arg notes "$stage_notes"; then
    log_warn "$issue advance failed: could not update coding stage result"
    return 1
  fi
  _write_stage_result_trace_event "$feature_dir" "coding" "completed" "$advance_agent" "$result_model"

  marker_path="$feature_dir/.coding-complete"
  if ! touch "$marker_path"; then
    log_warn "$issue advance failed: could not create $marker_path"
    return 1
  fi

  quarantine_completed_coding_pane "$issue" "$feature_dir"

  return 0
}

auto_advance_blocked_completion() {
  local issue="$1" feature_dir="$2" win_target="${3:-}" win="${4:-$1-$(basename "$2")}"
  local slug artifact_path artifact_record summary reason artifact_mtime decision_json
  local audit_path audit_timestamp passing_count blocking_count blocked_json
  local pane_pid live_process_mode liveness_rc
  local blocking_command next_action
  local -a blocking_commands=()
  local -a MILL_BLOCKING_PROCESS_PIDS=()

  AUTO_ADVANCE_BLOCKED_COMPLETION_REASON=""
  AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED=""
  artifact_path="$feature_dir/.coding-blocked-completion.json"
  [[ -f "$artifact_path" ]] || return 1

  slug="$(basename "$feature_dir")"
  decision_json="$(blocked_completion_validate_for_advance "$issue" "$feature_dir" auto 2>/dev/null)" || {
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="$(jq -r '.reason // "blocked-completion artifact is ineligible"' <<<"$decision_json" 2>/dev/null || echo "blocked-completion artifact is ineligible")"
    return 1
  }

  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r summary reason artifact_mtime <<< "$artifact_record"
  audit_path="$feature_dir/.coding-auto-advance.json"
  audit_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  passing_count="$(jq -r '(.passingChecks // []) | length' "$artifact_path" 2>/dev/null || echo 0)"
  blocking_count="$(jq -r '(.blockingChecks // []) | length' "$artifact_path" 2>/dev/null || echo 0)"
  blocked_json="$(jq -c '[.]' "$artifact_path")"
  if ! mapfile -t blocking_commands < <(jq -r '(.blockingChecks // [])[]? | strings' "$artifact_path" 2>/dev/null); then
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness checks could not parse blocking checks"
    emit_blocked_completion_liveness_attention \
      "$issue" \
      "$feature_dir" \
      "$win" \
      "blocked-completion auto-advance refused because liveness is indeterminate (could not parse blocking checks)" \
      "Inspect the coding pane for $issue and resolve the blocked completion manually."
    return 1
  fi

  pane_pid="$(tmux display-message -p -t "$win_target" '#{pane_pid}' 2>/dev/null || true)"
  mill_pane_has_live_blocking_process "$pane_pid" "${blocking_commands[@]}"
  liveness_rc=$?
  if [[ "$liveness_rc" -eq 2 ]]; then
    AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness indeterminate: ${MILL_BLOCKING_PROCESS_REASON:-unknown reason}"
    emit_blocked_completion_liveness_attention \
      "$issue" \
      "$feature_dir" \
      "$win" \
      "blocked-completion auto-advance refused because liveness is indeterminate (${MILL_BLOCKING_PROCESS_REASON:-unknown reason})" \
      "Inspect the coding pane for $issue and resolve the blocked completion manually."
    return 1
  fi

  if [[ "$liveness_rc" -eq 0 ]]; then
    blocking_command="${MILL_BLOCKING_PROCESS_COMMAND:-live blocking process}"
    next_action="Stop the live blocking command for $issue (${blocking_command}), then retry review."
    live_process_mode="$(blocked_completion_live_process_mode)"
    if [[ "$live_process_mode" == "terminate" ]] && (( ${#MILL_BLOCKING_PROCESS_PIDS[@]} > 0 )); then
      if mill_terminate_blocking_processes "$pane_pid" "${MILL_BLOCKING_PROCESS_PIDS[@]}"; then
        mill_pane_has_live_blocking_process "$pane_pid" "${blocking_commands[@]}"
        liveness_rc=$?
        if [[ "$liveness_rc" -eq 1 ]]; then
          log "status" "[auto-advance] $issue terminated live blocking process before coding handoff: $blocking_command"
        elif [[ "$liveness_rc" -eq 2 ]]; then
          AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="blocked-completion liveness indeterminate after termination: ${MILL_BLOCKING_PROCESS_REASON:-unknown reason}"
          emit_blocked_completion_liveness_attention \
            "$issue" \
            "$feature_dir" \
            "$win" \
            "blocked-completion auto-advance refused because post-termination liveness is indeterminate (${MILL_BLOCKING_PROCESS_REASON:-unknown reason})" \
            "Inspect the coding pane for $issue and confirm the blocking command has stopped."
          return 1
        else
          blocking_command="${MILL_BLOCKING_PROCESS_COMMAND:-$blocking_command}"
          AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="live blocking process still running after termination attempt"
          emit_blocked_completion_liveness_attention \
            "$issue" \
            "$feature_dir" \
            "$win" \
            "blocked-completion auto-advance refused because a live blocking command is still running after termination attempt ($blocking_command)" \
            "Inspect the coding pane for $issue and stop the remaining blocking command manually."
          return 1
        fi
      else
        AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="failed to terminate live blocking process"
        emit_blocked_completion_liveness_attention \
          "$issue" \
          "$feature_dir" \
          "$win" \
          "blocked-completion auto-advance refused because the live blocking command could not be terminated ($blocking_command)" \
          "Inspect the coding pane for $issue and stop the blocking command manually."
        return 1
      fi
    else
      AUTO_ADVANCE_BLOCKED_COMPLETION_REASON="live blocking process still running"
      emit_blocked_completion_liveness_attention \
        "$issue" \
        "$feature_dir" \
        "$win" \
        "blocked-completion auto-advance refused because a live blocking command is still running ($blocking_command)" \
        "$next_action"
      return 1
    fi
  fi

  if ! complete_coding_advance \
    "$issue" \
    "$feature_dir" \
    "$audit_path" \
    "Blocked verification accepted automatically; review may proceed" \
    "$audit_timestamp" \
    "$summary" \
    "$slug" \
    "$passing_count" \
    "$blocking_count" \
    "$decision_json" \
    "$blocked_json"; then
    return 1
  fi

  log "status" "[auto-advance] $issue advancing coding to review from valid .coding-blocked-completion.json"
  return 0
}

handle_planning_overreach_rejection() {
  local issue="$1" feature_dir="$2" win="$3" current_agent="${4:-}"
  local -a files=("${VALIDATE_PLANNING_LAST_OUT_OF_SCOPE_FILES[@]:-}")
  local files_summary

  files_summary="$(planning_rejection_files_summary "${files[@]}")"
  write_planning_rejection_artifact "$issue" "$feature_dir" "${files[@]}"
  log_warn "$issue needs attention: planning edited $files_summary. Reverted. Review plan.md and re-approve to continue."
  write_stage_result "$feature_dir" "planning" "awaiting_user" "$current_agent" "" "Planning edited $files_summary. Reverted and awaiting re-approval"
  notify_planning_rejection_agent "$feature_dir" "$win" "${files[@]}"
  set_window_attention_state "$win" "needs-user"
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

recover_misplaced_coding_complete_marker() {
  local issue="$1" worktree="$2" feature_dir="$3" slug="$4"
  local expected_marker misplaced_marker rel_marker audit_path audit_tmp recovered_at

  expected_marker="$feature_dir/.coding-complete"
  [[ -f "$expected_marker" ]] && return 1
  [[ -d "$worktree" ]] || return 1

  misplaced_marker="$(
    find "$worktree" \
      -path "$expected_marker" -prune -o \
      -path "*/features/$slug/.coding-complete" -type f -print -quit 2>/dev/null || true
  )"
  if [[ -z "$misplaced_marker" && -f "$worktree/.coding-complete" ]]; then
    if git -C "$worktree" ls-files --error-unmatch .coding-complete >/dev/null 2>&1; then
      return 1
    fi
    misplaced_marker="$worktree/.coding-complete"
  fi
  [[ -n "$misplaced_marker" ]] || return 1
  [[ "$misplaced_marker" != "$expected_marker" ]] || return 1

  if [[ "$misplaced_marker" == "$worktree/.coding-complete" ]]; then
    rel_marker=".coding-complete"
  else
    rel_marker="${misplaced_marker#"$worktree"/}"
  fi
  recovered_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  audit_path="$feature_dir/.coding-marker-recovered.json"
  audit_tmp="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || {
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not create recovery audit"
    return 1
  }

  jq -n \
    --arg issue "$issue" \
    --arg expected "features/$slug/.coding-complete" \
    --arg found "$rel_marker" \
    --arg timestamp "$recovered_at" \
    '{
      issue: $issue,
      type: "misplaced-coding-complete-marker",
      expected: $expected,
      found: $found,
      recoveredAt: $timestamp
    }' > "$audit_tmp" || {
      rm -f "$audit_tmp"
      log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not write recovery audit"
      return 1
    }

  if ! mv "$audit_tmp" "$audit_path"; then
    rm -f "$audit_tmp"
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not finalize recovery audit"
    return 1
  fi

  if ! touch "$expected_marker"; then
    log_warn "$issue → Found misplaced .coding-complete at $rel_marker but could not create expected marker"
    return 1
  fi

  rm -f "$misplaced_marker" 2>/dev/null || true

  log_warn "$issue → Recovered misplaced .coding-complete from $rel_marker"
  return 0
}

# Returns path to the deduplicate announce marker for pane divergence detection.
_coding_divergence_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.coding-pane-divergence-detected"
}

# Detect whether the task pane has completed a different task's slug.
# Uses hook freshness and pane idle state as gating conditions so we do not
# mark tasks needs-user while the agent is still actively working.
# On success, sets globals _DIVERGENCE_SLUG and _DIVERGENCE_SOURCE.
# Returns 0 when divergence evidence is found; 1 otherwise.
_detect_coding_pane_divergence() {
  local issue="$1" slug="$2" worktree="$3" feature_dir="$4" win_target="$5"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  local hook_state hook_ts now staleness pane_tail other_slug

  _DIVERGENCE_SLUG=""
  _DIVERGENCE_SOURCE=""

  # Fresh working/waiting hook means the agent is still active — keep waiting
  if [[ -f "$hook_file" ]]; then
    hook_state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || echo "")
    hook_ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo "0")
    now="$(date +%s)"
    staleness=$(( now - hook_ts ))
    if (( staleness < 300 )) && [[ "$hook_state" == "working" || "$hook_state" == "waiting" ]]; then
      return 1
    fi
  fi

  # Pane must be idle or dead for divergence detection to apply
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  # Check pane tail for a different slug's completion marker path
  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -200 2>/dev/null || true)"
  if [[ -n "$pane_tail" ]]; then
    other_slug="$(printf '%s\n' "$pane_tail" \
      | grep -oE 'features/[^/[:space:]]+/\.coding-complete' \
      | sed 's|^features/||; s|/\.coding-complete$||' \
      | grep -v "^${slug}$" | head -1 || true)"
    if [[ -n "$other_slug" ]]; then
      _DIVERGENCE_SLUG="$other_slug"
      _DIVERGENCE_SOURCE="pane_tail"
      return 0
    fi
  fi

  return 1
}

# Emit a needs-user attention signal when the coding pane has completed a
# different task. This prevents the controller from polling forever when the
# pane identity has drifted from the controller-owned task/slug.
#
# Returns 0 (and increments active_count) when divergence is detected;
# returns 1 when no action is taken so the caller continues normal polling.
emit_pane_divergence_attention() {
  local issue="$1" slug="$2" feature_dir="$3" win="$4" win_target="$5"
  local worktree="${WORKTREE_ROOT:-}/${slug}"
  local artifact announce_marker detected_at tmp_artifact
  local observed_slug observed_source

  _DIVERGENCE_SLUG=""
  _DIVERGENCE_SOURCE=""

  if ! _detect_coding_pane_divergence "$issue" "$slug" "$worktree" "$feature_dir" "$win_target"; then
    return 1
  fi

  observed_slug="$_DIVERGENCE_SLUG"
  observed_source="$_DIVERGENCE_SOURCE"

  artifact="$feature_dir/.coding-pane-divergence.json"
  announce_marker="$(_coding_divergence_announce_marker "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if [[ ! -f "$artifact" ]]; then
    tmp_artifact="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || true
    if [[ -n "$tmp_artifact" ]]; then
      jq -n \
        --arg expectedIssue "$issue" \
        --arg expectedSlug "$slug" \
        --arg expectedMarker "features/$slug/.coding-complete" \
        --arg observedSlug "$observed_slug" \
        --arg observedSource "$observed_source" \
        --arg detectedAt "$detected_at" \
        '{
          expectedIssue: $expectedIssue,
          expectedSlug: $expectedSlug,
          expectedMarker: $expectedMarker,
          observedSlug: $observedSlug,
          observedSource: $observedSource,
          detectedAt: $detectedAt
        }' > "$tmp_artifact" 2>/dev/null \
        && mv "$tmp_artifact" "$artifact" 2>/dev/null \
        || rm -f "$tmp_artifact"
    fi
  fi

  if [[ ! -f "$announce_marker" ]]; then
    log_warn "$issue → Coding pane completed a different task (expected: $slug, observed: $observed_slug via $observed_source). Expected .coding-complete is missing — task needs attention."
    : > "$announce_marker"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
  return 0
}

native_launch_failure_artifact_path() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.native-launch-failure.json"
}

stage_result_field() {
  local feature_dir="$1" stage="$2" field="$3"
  local result_file="$feature_dir/.${stage}-result.json"
  [[ -f "$result_file" ]] || return 0
  jq -r --arg field "$field" '.[$field] // empty' "$result_file" 2>/dev/null || true
}

agent_or_model_is_native_for_recovery() {
  local agent="${1:-}" model="${2:-}" tail="${3:-}"

  case "$agent" in
    native|native-*) return 0 ;;
  esac

  case "$model" in
    native:*|openrouter/*|qwen-*|kimi-*|glm-*) return 0 ;;
  esac

  if printf '%s\n' "$tail" | grep -Eiq '(native-openrouter|native-openai|launch-native-(planning|review|coding)|OpenRouter|wavemill native-agent)'; then
    return 0
  fi

  return 1
}

native_launch_failure_kind() {
  local tail="${1:-}"

  if printf '%s\n' "$tail" | grep -Eiq -- '--model[[:space:]]+[^[:space:]]'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'command not found.*--model'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- '--model.*command not found'; then
    printf 'bare-model-command\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'Agent exited (127)'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exited with status 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exited with code 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'exit status 127'; then
    printf 'agent-exited-127\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Fq 'native launch probe failed'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'native agent .*cannot launch'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'native agent .*does not support'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for planning'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for coding'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  if printf '%s\n' "$tail" | grep -Eiq -- 'not eligible for review'; then
    printf 'native-route-rejected\n'
    return 0
  fi

  return 1
}

write_native_launch_failure_artifact() {
  local issue="$1" feature_dir="$2" stage="$3" agent="$4" model="$5" pane_target="$6" failure_kind="$7" exit_code="$8"
  local artifact tmp detected_at recommended_action

  artifact="$(native_launch_failure_artifact_path "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  recommended_action="Inspect the pane transcript and route config, then relaunch after fixing native provider/model eligibility."
  mkdir -p "$feature_dir"
  tmp="$(mktemp "$artifact.tmp.XXXXXX" 2>/dev/null)" || return 0

  jq -n \
    --arg issue "$issue" \
    --arg stage "$stage" \
    --arg agent "$agent" \
    --arg model "$model" \
    --arg paneTarget "$pane_target" \
    --arg failureKind "$failure_kind" \
    --arg exitCode "$exit_code" \
    --arg detectedAt "$detected_at" \
    --arg recommendedAction "$recommended_action" \
    '{
      type: "native-launch-failure",
      issue: $issue,
      stage: $stage,
      agent: $agent,
      model: $model,
      paneTarget: $paneTarget,
      failureKind: $failureKind,
      exitCode: (if $exitCode == "" then null else ($exitCode | tonumber) end),
      detectedAt: $detectedAt,
      recommendedAction: $recommendedAction
    }' > "$tmp" 2>/dev/null \
    && mv "$tmp" "$artifact" 2>/dev/null \
    || rm -f "$tmp"
}

# Convert dead native launch panes into failed controller-owned stage results.
# This prevents malformed launchers from leaving stages in "running" forever.
emit_native_launch_failure_attention() {
  local issue="$1" feature_dir="$2" stage="$3" win="$4" win_target="$5" fallback_agent="${6:-}" fallback_model="${7:-}"
  local stage_status agent model pane_tail failure_kind exit_code notes artifacts_json

  stage_status="$(read_stage_status "$feature_dir" "$stage")"
  [[ "$stage_status" == "running" ]] || return 1
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -200 2>/dev/null || true)"
  agent="$(stage_result_field "$feature_dir" "$stage" "agent")"
  model="$(stage_result_field "$feature_dir" "$stage" "model")"
  [[ -n "$agent" ]] || agent="$fallback_agent"
  [[ -n "$model" ]] || model="$fallback_model"

  agent_or_model_is_native_for_recovery "$agent" "$model" "$pane_tail" || return 1

  failure_kind="$(native_launch_failure_kind "$pane_tail" || true)"
  [[ -n "$failure_kind" ]] || failure_kind="native-agent-exited-without-artifacts"

  exit_code=""
  if printf '%s\n' "$pane_tail" | grep -Eq '(^|[^0-9])127([^0-9]|$)'; then
    exit_code="127"
  fi

  write_native_launch_failure_artifact "$issue" "$feature_dir" "$stage" "$agent" "$model" "$win_target" "$failure_kind" "$exit_code"

  notes="Native ${stage} launch failed: ${failure_kind}"
  [[ -n "$exit_code" ]] && notes+=" (exit $exit_code)"
  notes+=". Pane $win_target needs attention"

  artifacts_json="$(jq -cn \
    --arg paneTarget "$win_target" \
    --arg failureKind "$failure_kind" \
    --arg exitCode "$exit_code" \
    '{type:"nativeLaunchFailure", paneTarget:$paneTarget, failureKind:$failureKind, exitCode:(if $exitCode == "" then null else ($exitCode | tonumber) end)}' 2>/dev/null || printf '{}')"
  write_stage_result "$feature_dir" "$stage" "failed" "$agent" "$model" "$notes" "$artifacts_json"
  set_window_attention_state "$win" "needs-user"
  log_warn "$issue → Native ${stage} launcher failed (${failure_kind}) in pane $win_target"
  active_count=$((active_count + 1))
  return 0
}

coding_missing_blocked_completion_announce_marker() {
  local feature_dir="$1"
  printf '%s\n' "$feature_dir/.missing-blocked-completion-announced"
}

_coding_terminal_blocked_completion_detected() {
  local feature_dir="$1" win_target="$2"
  local coding_status pane_tail line lower_line
  local commit_phrase="" blocked_phrase=""

  _CODING_TERMINAL_BLOCKED_COMMIT_PHRASE=""
  _CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE=""

  coding_status="$(read_stage_status "$feature_dir" "coding")"
  [[ "$coding_status" == "running" ]] || return 1
  [[ ! -f "$feature_dir/.coding-complete" ]] || return 1
  [[ ! -f "$feature_dir/.coding-blocked-completion.json" ]] || return 1
  [[ -n "$win_target" ]] || return 1
  _pane_is_dead_or_idle "$win_target" 2>/dev/null || return 1

  pane_tail="$(tmux capture-pane -p -t "$win_target" -S -500 2>/dev/null || true)"
  [[ -n "$pane_tail" ]] || return 1

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    lower_line="$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')"

    if [[ -z "$commit_phrase" ]] && [[ \
      "$lower_line" == *"committed as"* || \
      "$lower_line" == *"implementation is committed"* || \
      "$lower_line" == *"implementation committed"* || \
      "$lower_line" == *"changes committed"* \
    ]]; then
      commit_phrase="$line"
    fi

    if [[ -z "$blocked_phrase" ]] && [[ \
      "$lower_line" == *"did not create .coding-complete"* || \
      "$lower_line" == *"verification is blocked"* || \
      "$lower_line" == *"verification blocked"* || \
      "$lower_line" == *"environmentally blocked"* || \
      "$lower_line" == *"environmental blocker"* \
    ]]; then
      blocked_phrase="$line"
    fi
  done <<< "$pane_tail"

  [[ -n "$commit_phrase" ]] || return 1
  [[ -n "$blocked_phrase" ]] || return 1

  _CODING_TERMINAL_BLOCKED_COMMIT_PHRASE="$commit_phrase"
  _CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE="$blocked_phrase"
  return 0
}

emit_terminal_blocked_completion_attention() {
  local issue="$1" slug="$2" feature_dir="$3" win="$4" win_target="$5"
  local artifact_rel_path audit_path announce_marker detected_at tmp_artifact
  local action observed_phrases_json

  if ! _coding_terminal_blocked_completion_detected "$feature_dir" "$win_target"; then
    return 1
  fi

  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  audit_path="$feature_dir/.coding-missing-blocked-completion.json"
  announce_marker="$(coding_missing_blocked_completion_announce_marker "$feature_dir")"
  detected_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  action="Create $artifact_rel_path or run advance $issue."
  observed_phrases_json="$(
    printf '%s\n%s\n' \
      "$_CODING_TERMINAL_BLOCKED_COMMIT_PHRASE" \
      "$_CODING_TERMINAL_BLOCKED_BLOCKED_PHRASE" \
      | jq -R . \
      | jq -s .
  )"

  if [[ ! -f "$audit_path" ]]; then
    tmp_artifact="$(mktemp "$audit_path.tmp.XXXXXX" 2>/dev/null)" || true
    if [[ -n "$tmp_artifact" ]]; then
      jq -n \
        --arg issue "$issue" \
        --arg slug "$slug" \
        --arg detectedAt "$detected_at" \
        --arg missingArtifact "$artifact_rel_path" \
        --arg action "$action" \
        --argjson observedPhrases "$observed_phrases_json" \
        '{
          issue: $issue,
          slug: $slug,
          detectedAt: $detectedAt,
          observedPhrases: $observedPhrases,
          missingArtifact: $missingArtifact,
          action: $action
        }' > "$tmp_artifact" 2>/dev/null \
        && mv "$tmp_artifact" "$audit_path" 2>/dev/null \
        || rm -f "$tmp_artifact"
    fi
  fi

  if [[ ! -f "$announce_marker" ]]; then
    log "status" "$issue needs attention: coding appears complete but .coding-blocked-completion.json is missing. Create $artifact_rel_path or run \"advance $issue\" to continue."
    : > "$announce_marker"
  fi

  set_window_attention_state "$win" "needs-user"
  active_count=$((active_count + 1))
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
    log_task "status" "$issue" "⛔ $issue → Workflow aborted during ${launched_phase} launch"
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
  if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
    if agent_resolve_models_for_roles "$planner_model" "$coder_model" "$reviewer_model"; then
      :
    fi
    planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
    coder_agent="$(agent_resolve_batch_agent_for_role "coder")"
    reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
  else
    planner_agent="$(agent_resolve_from_model "$planner_model" "planning" || true)"
    coder_agent="$(agent_resolve_from_model "$coder_model" "coding" || true)"
    reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review" || true)"
  fi

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

_tmux_window_target_exists() {
  local session="$1" target="$2" expected_path="${3:-}"
  local target_session target_path expected_real target_real pane_dead

  [[ -n "$session" && -n "$target" ]] || return 1
  target_session="$(tmux display-message -p -t "$target" '#{session_name}' 2>/dev/null || true)"
  [[ "$target_session" == "$session" ]] || return 1
  if [[ -n "$expected_path" ]]; then
    target_path="$(tmux display-message -p -t "$target" '#{pane_current_path}' 2>/dev/null || true)"
    if [[ -z "$target_path" ]]; then
      pane_dead="$(tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | head -1 || true)"
      [[ "$pane_dead" == "1" ]] && return 0
      return 1
    fi
    expected_real="$(cd -P "$expected_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$expected_path")"
    target_real="$(cd -P "$target_path" 2>/dev/null && printf '%s\n' "$PWD" || printf '%s\n' "$target_path")"
    [[ "$target_real" == "$expected_real" ]] || return 1
  fi
  return 0
}

_tmux_target_join() {
  local session="$1" target="$2"
  [[ -n "$target" ]] || return 1
  case "$target" in
    @*|*:*) printf '%s\n' "$target" ;;
    *) printf '%s:%s\n' "$session" "$target" ;;
  esac
}

_tmux_task_window_target() {
  local session="$1" issue="$2" slug="$3" state_file="${4:-${STATE_FILE:-}}" wt_dir="${5:-}"
  local stored_target="" canonical target issue_number renamed_target

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    stored_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$state_file" 2>/dev/null || true)"
  fi
  if _tmux_window_target_exists "$session" "$stored_target" "$wt_dir"; then
    printf '%s\n' "$stored_target"
    return 0
  fi

  issue_number="${issue##*-}"
  renamed_target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v issue="$issue" -v issue_number="$issue_number" -v slug="$slug" '
        index($2, issue_number " · " slug " ·") == 1 { print $1; exit }
        index($2, issue_number " · " slug) == 1 { print $1; exit }
        index($2, issue " · " slug " ·") == 1 { print $1; exit }
        index($2, issue " · " slug) == 1 { print $1; exit }
      ')"
  if _tmux_window_target_exists "$session" "$renamed_target" "$wt_dir"; then
    printf '%s\n' "$renamed_target"
    return 0
  fi

  canonical="${issue}-${slug}"
  target="$(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null \
    | awk -F'|' -v name="$canonical" '$2 == name { print $1; exit }')"
  if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
    printf '%s\n' "$target"
    return 0
  fi

  if [[ -n "$wt_dir" ]]; then
    while IFS='|' read -r target _name; do
      [[ -n "$target" ]] || continue
      if _tmux_window_target_exists "$session" "$target" "$wt_dir"; then
        printf '%s\n' "$target"
        return 0
      fi
    done < <(tmux list-windows -t "$session" -F '#{window_id}|#{window_name}' 2>/dev/null || true)
  fi

  return 1
}

# A completed coding agent must not remain available for unrelated interactive
# input while the controller advances the task. This is deliberately best-effort:
# result state is authoritative and review will recreate a task window as needed.
quarantine_completed_coding_pane() {
  local issue="$1" feature_dir="$2" worktree="${3:-}"
  local slug target

  command -v tmux >/dev/null 2>&1 || return 0
  slug="$(basename "$feature_dir")"
  [[ -n "$worktree" ]] || worktree="$(dirname "$(dirname "$feature_dir")")"
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$worktree" 2>/dev/null || true)"
  [[ -n "$target" ]] || return 0

  tmux kill-window -t "$target" 2>/dev/null || true
  return 0
}

_ensure_task_window_exists() {
  local session="$1" issue="$2" slug="$3" wt_dir="$4"
  local target canonical

  if target="$(_tmux_task_window_target "$session" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir")"; then
    printf '%s\n' "$target"
    return 0
  fi

  canonical="${issue}-${slug}"
  log_warn "  Window $canonical missing, recreating..." >&2
  tmux new-window -d -t "$session" -n "$canonical" -c "$wt_dir" 2>/dev/null || true
  target="$(tmux display-message -p -t "$session:$canonical" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$target" ]] || target="$canonical"
  tmux set-option -t "$(_tmux_target_join "$session" "$target")" remain-on-exit on 2>/dev/null || true
  sleep 1
  printf '%s\n' "$target"
}

persist_task_window_id() {
  local issue="$1" target="$2"
  local resolved_target window_id

  [[ -n "$issue" && -n "$target" ]] || return 0
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]] || return 0

  resolved_target="$target"
  [[ "$resolved_target" == @* ]] || resolved_target="$SESSION:$resolved_target"
  window_id="$(tmux display-message -p -t "$resolved_target" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$window_id" ]] || return 0

  state_mutate "$STATE_FILE" \
    '.tasks[$issue].windowId = $windowId | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$issue" \
    --arg windowId "$window_id" >/dev/null 2>&1 || true
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
  local wt_dir
  wt_dir=$(read_state_value "" --arg i "$issue" '.tasks[$i].worktree // ""')
  [[ -z "$wt_dir" ]] && wt_dir="${WORKTREE_ROOT}/${slug}"
  local feature_dir="${wt_dir}/features/${slug}"
  _RESTORE_STATE="none"

  if _tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" >/dev/null 2>&1; then
    return 0
  fi

  if [[ "$phase" == "coding" && -f "$feature_dir/.coding-complete" ]]; then
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
      model="$(resolve_phase_model "planning" "$model" "claude-sonnet-5")"
      if declare -F agent_resolve_model >/dev/null 2>&1; then
        model="$(agent_resolve_model "planner" "$model" "$REPO_DIR")" || return 1
      fi
      depth=$(read_phase_config "$feature_dir" "planning" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "planDepth")
      [[ -z "$depth" ]] && depth="light"
      if ! agent_cmd="$(agent_resolve_from_model "$model" "planning")"; then
        rc=1
      else
        launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
          "$model" "$agent_cmd" "$depth" || rc=$?
      fi
      ;;
    coding)
      if ! reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"; then
        handle_expanded_reroute_handoff_failure "$issue" "$feature_dir"
      fi
      if ! apply_expanded_route_if_present "$feature_dir" "$issue" "$slug" "$wt_dir" "$STATE_FILE"; then
        log_warn "$issue → expanded route invalid; using existing execution state for coding relaunch"
      fi
      emit_execution_active_route "$feature_dir" "$issue"
      model=$(read_phase_config "$feature_dir" "coding" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$issue" "coderModel")
      model="$(resolve_phase_model "coding" "$model" "claude-opus-4-7")"
      if declare -F agent_resolve_model >/dev/null 2>&1; then
        model="$(agent_resolve_model "coder" "$model" "$REPO_DIR")" || return 1
      fi
      depth=$(read_phase_config "$feature_dir" "coding" "depth")
      [[ -z "$depth" ]] && depth=$(get_task_meta "$issue" "codeDepth")
      [[ -z "$depth" ]] && depth="medium"
      if ! agent_cmd="$(agent_resolve_from_model "$model" "coding")"; then
        rc=1
      else
        if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$issue" '.tasks[$issue]? // empty' "$STATE_FILE" >/dev/null 2>&1; then
          state_mutate "$STATE_FILE" \
            '.tasks[$issue].agent = $agent | .tasks[$issue].updated = (now | todate)' \
            --arg issue "$issue" \
            --arg agent "$agent_cmd" >/dev/null 2>&1 || true
        fi
        launch_coding_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
          "$model" "$agent_cmd" "$depth" || rc=$?
      fi
      ;;
    review)
      model=$(read_phase_config "$feature_dir" "review" "model")
      [[ -z "$model" ]] && model=$(get_task_meta "$issue" "reviewerModel")
      model="$(resolve_phase_model "review" "$model" "claude-sonnet-5")"
      if declare -F agent_resolve_model >/dev/null 2>&1; then
        model="$(agent_resolve_model "reviewer" "$model" "$REPO_DIR")" || return 1
      fi
      local review_mode
      review_mode=$(read_phase_config "$feature_dir" "review" "mode")
      [[ -z "$review_mode" ]] && review_mode=$(get_task_meta "$issue" "reviewMode")
      [[ -z "$review_mode" ]] && review_mode="static"
      if ! agent_cmd="$(agent_resolve_from_model "$model" "review")"; then
        rc=1
      else
        launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
          "$model" "$agent_cmd" "$review_mode" || rc=$?
      fi
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

  log "status" "$issue → $phase phase relaunched in restored window"
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
  local session window
  if [[ "$target" == @* ]]; then
    session="$SESSION"
    window="$target"
  else
    session="${target%%:*}"
    window="${target#*:}"
  fi
  local agent_flags=""
  local abort_check_cmd=""
  local feature_dir=""
  local esc_session esc_issue esc_slug esc_linear_issue linear_issue=""

  [[ "$agent_cmd" == "codex" ]] && agent_flags="--dangerously-bypass-approvals-and-sandbox"
  if [[ -n "$slug" ]]; then
    feature_dir="${WORKTREE_ROOT}/${slug}/features/${slug}"
    abort_check_cmd="check_stage_aborted '$feature_dir'"
  fi

  # Export wavemill context environment variables for hook protocol
  if declare -F get_linear_issue_id >/dev/null 2>&1; then
    linear_issue="$(get_linear_issue_id "$issue" 2>/dev/null || true)"
  fi
  [[ -n "$linear_issue" ]] || linear_issue="$issue"
  esc_session=${session//\'/\'\\\'\'}
  esc_issue=${issue//\'/\'\\\'\'}
  esc_slug=${slug//\'/\'\\\'\'}
  esc_linear_issue=${linear_issue//\'/\'\\\'\'}
  tmux send-keys -t "$target" \
    "export WAVEMILL_SESSION='$esc_session' WAVEMILL_ISSUE='$esc_issue' WAVEMILL_LINEAR_ISSUE='$esc_linear_issue' WAVEMILL_SLUG='$esc_slug' WAVEMILL_FEATURE_SLUG='$esc_slug' WAVEMILL_FEATURE_DIR='$feature_dir'" C-m

  export WAVEMILL_FEATURE_SLUG="$slug"
  export WAVEMILL_FEATURE_DIR="$feature_dir"
  export WAVEMILL_LINEAR_ISSUE="$linear_issue"

  agent_launch_interactive "$session" "$window" "$prompt_file" "$agent_cmd" "$model" "$agent_flags" "$abort_check_cmd" "$issue"
}

# Launch the planning phase in an existing tmux window
launch_planning_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local planner_model="$7" planner_agent="$8" plan_depth="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
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

  log_task "status" "$issue" "Launching planning phase for $issue (model: $planner_model, depth: $plan_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$planner_agent" "$planner_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Launch the coding phase in an existing tmux window
launch_coding_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local coder_model="$7" coder_agent="$8" code_depth="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
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

  log_task "status" "$issue" "Launching coding phase for $issue (model: $coder_model, depth: $code_depth, mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$coder_agent" "$coder_model" "$prompt_file" "$slug" "$issue"
  return $?
}

# Launch the review phase in an existing tmux window
launch_review_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local reviewer_model="$7" reviewer_agent="$8" review_mode="$9"
  local operating_mode="normal"
  local win
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
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

  log_task "status" "$issue" "Launching review phase for $issue (model: $reviewer_model, mode: $review_mode, operating mode: $operating_mode)"
  _launch_agent_in_pane "$win" "$reviewer_agent" "$reviewer_model" "$prompt_file" "$slug" "$issue"
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
  local target=""
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
    local resolved_path
    resolved_path="$(ensure_worktree "$branch" "$wt_dir" "$REPO_DIR" 2>/dev/null)" || {
      log_warn "$issue → Failed to recreate worktree for review task"
      return 1
    }
    wt_dir="$resolved_path"
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

  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$wt_dir" 2>/dev/null || true)"
  if [[ -z "$target" ]]; then
    log "status" "⚡ $issue → Restoring review window (PR #$pr)"
    tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir" 2>/dev/null || return 1
    target="$(tmux display-message -p -t "$SESSION:$win" '#{window_id}' 2>/dev/null || true)"
    [[ -n "$target" ]] || target="$win"
    tmux set-option -t "$(_tmux_target_join "$SESSION" "$target")" remain-on-exit on 2>/dev/null || true
    restored_window="true"
    sleep 1
  fi

  if _pane_is_dead_or_idle "$(_tmux_target_join "$SESSION" "$target")"; then
    if declare -F launch_review_phase >/dev/null 2>&1 && declare -F agent_resolve_from_model >/dev/null 2>&1; then
      # Get review phase configuration from state
      local reviewer_model review_mode reviewer_agent
      reviewer_model=$(read_state_value "claude-sonnet-5" --arg i "$issue" '.tasks[$i].reviewerModel // "claude-sonnet-5"')
      review_mode=$(read_state_value "static+llm" --arg i "$issue" '.tasks[$i].reviewMode // "static+llm"')

      # Resolve agent from model
      if reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review")"; then
        # Launch review phase agent
        log "status" "  → Relaunching review agent for $issue (model: $reviewer_model, mode: $review_mode)"
        launch_review_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" "$reviewer_model" "$reviewer_agent" "$review_mode"
        if [[ $? -eq 0 ]]; then
          log "status" "$issue → Review context restored and agent relaunched for PR #$pr"
        else
          log_warn "$issue → Failed to relaunch review agent"
          if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
            log "status" "$issue → Review context restored for PR #$pr (but agent launch failed)"
          fi
          return 1
        fi
      else
        log_warn "$issue → Review relaunch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
          log "status" "$issue → Review context restored for PR #$pr (but agent launch was blocked)"
        fi
        return 1
      fi
    else
      # Keep the restored window useful in stripped-down test or utility contexts
      # where the full launch stack has not been sourced yet.
      tmux send-keys -t "$(_tmux_target_join "$SESSION" "$target")" "cd '$wt_dir'" C-m 2>/dev/null || true
    fi
  fi

  if [[ "$restored_window" == "true" || "$recreated_worktree" == "true" ]]; then
    log "status" "$issue → Review context restored for PR #$pr"
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

ready_queue_state() {
  local state_dir="$1"
  local result_file="$state_dir/.ready-result.json"
  local status verdict queue_state

  [[ -f "$result_file" ]] || { echo ""; return 0; }

  queue_state=$(jq -r '.artifacts.queueState // empty' "$result_file" 2>/dev/null || echo "")
  if [[ -n "$queue_state" ]]; then
    printf '%s\n' "$queue_state"
    return 0
  fi

  status=$(jq -r '.status // empty' "$result_file" 2>/dev/null || echo "")
  verdict=$(jq -r '.artifacts.verdict // empty' "$result_file" 2>/dev/null || echo "")
  if [[ "$status" == "completed" && ( "$verdict" == "pass" || "$verdict" == "warn" ) ]]; then
    printf 'ready\n'
  else
    printf '\n'
  fi
}

ready_queue_field() {
  local state_dir="$1" field="$2"
  local result_file="$state_dir/.ready-result.json"
  [[ -f "$result_file" ]] || { echo ""; return 0; }
  jq -r --arg field "$field" '.artifacts[$field] // empty' "$result_file" 2>/dev/null || echo ""
}

# Reads the transient merge-retry window marker written by the tend process for a
# PR (shared/lib/tend-controller.ts writeMergeRetryMarker). Returns the ISO expiry
# timestamp while tend is actively retrying a transient merge failure, or empty
# when no active retry window exists. Keeps the local merge queue from demoting a
# candidate as "stuck" while tend keeps retrying it in a separate process.
merge_retry_marker_until() {
  local pr="$1"
  local marker_file="$REPO_DIR/.wavemill/merge-retry/${pr}.json"
  [[ -n "$pr" && -f "$marker_file" ]] || { echo ""; return 0; }
  jq -r '.until // empty' "$marker_file" 2>/dev/null || echo ""
}

merge_queue_enabled() {
  [[ "${MERGE_QUEUE_ENABLED:-true}" == "1" || "${MERGE_QUEUE_ENABLED:-true}" == "true" ]]
}

wavemill_run_tsx_tool() {
  local tool="$1"
  shift

  if node --import tsx -e "" >/dev/null 2>&1; then
    node --import tsx "$tool" "$@"
  elif command -v tsx >/dev/null 2>&1; then
    tsx "$tool" "$@"
  else
    npx tsx "$tool" "$@"
  fi
}

write_ready_queue_artifacts() {
  local state_dir="$1" patch_json="$2"
  local result_file="$state_dir/.ready-result.json"
  local existing_artifacts merged_artifacts

  [[ -f "$result_file" ]] || return 0
  existing_artifacts=$(jq -c '.artifacts // {"type":"ready"}' "$result_file" 2>/dev/null || echo '{"type":"ready"}')
  merged_artifacts=$(jq -cn \
    --argjson existing "$existing_artifacts" \
    --argjson patch "$patch_json" '
      reduce ($patch | keys[]) as $key ($existing;
        if $patch[$key] == null then
          del(.[$key])
        else
          .[$key] = $patch[$key]
        end
      ) | .type = "ready"
    ')

  wavemill_run_tsx_tool "$TOOLS_DIR/stage-result-cli.ts" update "$state_dir" ready --artifacts "$merged_artifacts" >/dev/null 2>&1 || \
    log_warn "merge queue: failed to update ready artifacts in $state_dir"
}

mark_ready_stale() {
  local issue="$1" state_dir="$2" old_sha="$3" new_sha="$4"
  local now patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  patch_json=$(jq -cn \
    --arg old_sha "$old_sha" \
    --arg new_sha "$new_sha" \
    --arg now "$now" '
      {
        queueState: "ready-stale",
        staleAt: $now,
        staleBaseSha: $old_sha,
        targetBaseSha: $new_sha,
        candidatePromotedAt: null,
        candidateLastProgressAt: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

promote_merge_candidate() {
  local issue="$1" state_dir="$2" new_sha="$3"
  local now existing_promoted_at patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  existing_promoted_at=$(ready_queue_field "$state_dir" "candidatePromotedAt")
  [[ -z "$existing_promoted_at" ]] && existing_promoted_at="$now"
  patch_json=$(jq -cn \
    --arg new_sha "$new_sha" \
    --arg now "$now" \
    --arg promoted_at "$existing_promoted_at" '
      {
        queueState: "merge-candidate",
        targetBaseSha: $new_sha,
        candidatePromotedAt: $promoted_at,
        candidateLastProgressAt: $now,
        staleAt: null,
        staleBaseSha: null,
        candidateSkipReason: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

demote_merge_candidate() {
  local issue="$1" state_dir="$2" reason="$3"
  local now patch_json
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  patch_json=$(jq -cn \
    --arg reason "$reason" \
    --arg now "$now" '
      {
        queueState: "ready-stale",
        candidateSkippedAt: $now,
        candidateSkipReason: $reason,
        candidatePromotedAt: null,
        candidateLastProgressAt: null,
        mergeRetryInProgressUntil: null
      }
    ')
  write_ready_queue_artifacts "$state_dir" "$patch_json"
}

ready_candidate_selected() {
  local issue="$1"
  [[ -f "$MERGE_QUEUE_SELECTION_FILE" ]] || return 1
  jq -e --arg issue "$issue" '.selectedIssues // [] | index($issue) != null' "$MERGE_QUEUE_SELECTION_FILE" >/dev/null 2>&1
}

ready_changed_files_json() {
  local state_dir="$1" wt_dir="$2" pr_number="$3"
  local result_file="$state_dir/.ready-result.json"
  local cached

  cached=$(jq -c '.artifacts.changedFiles // empty' "$result_file" 2>/dev/null || echo "")
  if [[ -n "$cached" && "$cached" != "null" ]]; then
    printf '%s\n' "$cached"
    return 0
  fi

  if cached=$(cd "$wt_dir" && gh pr view "$pr_number" --json files --jq '[.files[].path]' 2>/dev/null); then
    [[ -n "$cached" ]] && printf '%s\n' "$cached" && return 0
  fi

  printf '[]\n'
}

merge_queue_enrich_ready_artifacts() {
  local state_dir="$1" base_json="$2" mode="${3:-preserve}"
  local queue_state promoted_at target_base now extra_json

  if ! merge_queue_enabled; then
    printf '%s\n' "$base_json"
    return 0
  fi

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  queue_state=$(ready_queue_state "$state_dir")
  promoted_at=$(ready_queue_field "$state_dir" "candidatePromotedAt")
  target_base=$(ready_queue_field "$state_dir" "targetBaseSha")

  case "$mode" in
    completed)
      extra_json='{"queueState":"ready"}'
      ;;
    candidate-progress)
      if [[ "$queue_state" == "merge-candidate" ]]; then
        extra_json=$(jq -cn \
          --arg target_base "$target_base" \
          --arg promoted_at "${promoted_at:-$now}" \
          --arg now "$now" '
            {
              queueState: "merge-candidate",
              targetBaseSha: $target_base,
              candidatePromotedAt: $promoted_at,
              candidateLastProgressAt: $now
            }
          ')
      else
        extra_json='{}'
      fi
      ;;
    *)
      extra_json='{}'
      ;;
  esac

  jq -cn --argjson base "$base_json" --argjson extra "$extra_json" '$base + $extra'
}

refresh_ready_merge_queue_tick() {
  local now input_file output_file input_json output_json config_json
  local issue phase slug pr state_dir ready_status ready_verdict stored_base current_main queue_state wt_dir workflow_status pr_state_val
  local ready_prs='[]'

  : > "$MERGE_QUEUE_SELECTION_FILE"
  if ! merge_queue_enabled; then
    printf '{"selectedIssues":[],"stuckIssues":[]}\n' > "$MERGE_QUEUE_SELECTION_FILE"
    return 0
  fi

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  for issue in "${!BRANCH_BY_ISSUE[@]}"; do
    phase=$(get_task_phase "$issue")
    [[ "$phase" == "ready" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    pr="${PR_BY_ISSUE[$issue]:-}"
    [[ -n "$pr" ]] || continue
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    [[ -f "$state_dir/.ready-result.json" ]] || continue

    ready_status=$(read_stage_status "$state_dir" "ready")
    ready_verdict=$(ready_stage_pending_verdict "$state_dir")
    queue_state=$(ready_queue_state "$state_dir")
    stored_base=$(ready_base_sha "$state_dir")
    current_main=$(get_main_head_sha "$wt_dir" "$BASE_BRANCH")
    workflow_status=$(read_state_value "" --arg i "$issue" '.tasks[$i].status // ""')

    # Skip terminal tasks early (authoritative guard is in merge-queue.ts)
    if [[ "$workflow_status" == "merged" || "$workflow_status" == "completed-external" || "$workflow_status" == "aborted" ]]; then
      continue
    fi

    pr_state_val="$(pr_state "$pr")"

    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) && -n "$current_main" && "$stored_base" != "$current_main" && "$queue_state" != "merge-candidate" ]]; then
      mark_ready_stale "$issue" "$state_dir" "$stored_base" "$current_main"
      queue_state="ready-stale"
    fi

    if [[ "$ready_status" == "completed" && ( "$ready_verdict" == "pass" || "$ready_verdict" == "warn" ) ]] || [[ "$queue_state" == "merge-candidate" || "$queue_state" == "ready-stale" ]]; then
      ready_prs=$(jq -cn \
        --argjson prs "$ready_prs" \
        --arg issue "$issue" \
        --arg slug "$slug" \
        --arg branch "${BRANCH_BY_ISSUE[$issue]}" \
        --argjson pr_number "$pr" \
        --arg ready_base_sha "$stored_base" \
        --arg queue_state "$queue_state" \
        --arg workflow_status "$workflow_status" \
        --arg pr_state "$pr_state_val" \
        --arg ready_at "$(jq -r '.finishedAt // .startedAt // empty' "$state_dir/.ready-result.json" 2>/dev/null || echo "")" \
        --arg candidate_promoted_at "$(ready_queue_field "$state_dir" candidatePromotedAt)" \
        --arg candidate_last_progress_at "$(ready_queue_field "$state_dir" candidateLastProgressAt)" \
        --arg merge_retry_in_progress_until "$(merge_retry_marker_until "$pr")" \
        --arg candidate_skipped_at "$(ready_queue_field "$state_dir" candidateSkippedAt)" \
        --argjson changed_files "$(ready_changed_files_json "$state_dir" "$wt_dir" "$pr")" '
          $prs + [{
            issue: $issue,
            slug: $slug,
            prNumber: $pr_number,
            branch: $branch,
            readyBaseSha: $ready_base_sha,
            queueState: (if $queue_state == "" then null else $queue_state end),
            changedFiles: $changed_files,
            readyAt: (if $ready_at == "" then null else $ready_at end),
            unblocksCount: 0,
            candidatePromotedAt: (if $candidate_promoted_at == "" then null else $candidate_promoted_at end),
            candidateLastProgressAt: (if $candidate_last_progress_at == "" then null else $candidate_last_progress_at end),
            mergeRetryInProgressUntil: (if $merge_retry_in_progress_until == "" then null else $merge_retry_in_progress_until end),
            candidateSkippedAt: (if $candidate_skipped_at == "" then null else $candidate_skipped_at end),
            workflowStatus: (if $workflow_status == "" then null else $workflow_status end),
            prState: (if $pr_state == "" then null else $pr_state end)
          }]
        ')
    fi
  done

  config_json=$(jq -cn \
    --arg enabled "${MERGE_QUEUE_ENABLED:-true}" \
    --argjson max_concurrent "${MERGE_QUEUE_MAX_CONCURRENT:-2}" \
    --argjson stuck_timeout "${MERGE_QUEUE_STUCK_TIMEOUT_SECONDS:-900}" \
    --arg conflict_grouping "${MERGE_QUEUE_CONFLICT_GROUPING_ENABLED:-true}" \
    --argjson skip_cooldown "${MERGE_QUEUE_SKIP_COOLDOWN_SECONDS:-60}" '
      {
        enabled: ($enabled == "true" or $enabled == "1"),
        maxConcurrentCandidates: $max_concurrent,
        stuckTimeoutSeconds: $stuck_timeout,
        conflictGroupingEnabled: ($conflict_grouping == "true" or $conflict_grouping == "1"),
        skipCooldownSeconds: $skip_cooldown
      }
    ')

  input_file=$(mktemp) || return 0
  output_file=$(mktemp) || { rm -f "$input_file"; return 0; }
  jq -cn --arg now "$now" --argjson prs "$ready_prs" --argjson config "$config_json" '{readyPrs:$prs, now:$now, config:$config}' > "$input_file"
  if ! wavemill_run_tsx_tool "$TOOLS_DIR/merge-queue-select.ts" --input "$input_file" > "$output_file" 2>/dev/null; then
    rm -f "$input_file" "$output_file"
    printf '{"selectedIssues":[],"stuckIssues":[]}\n' > "$MERGE_QUEUE_SELECTION_FILE"
    return 0
  fi
  mv "$output_file" "$MERGE_QUEUE_SELECTION_FILE"
  rm -f "$input_file"

  jq -r '.stuckIssues[]?' "$MERGE_QUEUE_SELECTION_FILE" 2>/dev/null | while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    demote_merge_candidate "$issue" "$state_dir" "stuck merge candidate"
  done

  jq -r '.selectedIssues[]?' "$MERGE_QUEUE_SELECTION_FILE" 2>/dev/null | while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    slug="${SLUG_BY_ISSUE[$issue]}"
    wt_dir="${WORKTREE_ROOT}/${slug}"
    state_dir="$(ready_state_dir "$wt_dir" "$slug")"
    current_main=$(get_main_head_sha "$wt_dir" "$BASE_BRANCH")
    [[ -n "$current_main" ]] || continue
    if [[ "$(ready_queue_state "$state_dir")" != "merge-candidate" ]]; then
      promote_merge_candidate "$issue" "$state_dir" "$current_main"
      local pr_for_log
      pr_for_log="${PR_BY_ISSUE[$issue]:-}"
      log "status" "✓ $issue → PR ${pr_for_log:+#$pr_for_log }promoted to merge candidate (clean/green, base current)"
    fi
  done
}

get_main_head_sha() {
  local wt_dir="$1" base_branch="$2"
  local remote_ref="refs/heads/${base_branch}"
  local remote_timeout remote_output remote_rc=0
  remote_timeout="$(wavemill_git_remote_timeout_seconds)"
  remote_output="$(wavemill_git_remote_with_timeout "$remote_timeout" -C "$wt_dir" ls-remote origin "$remote_ref" 2>/dev/null)" || remote_rc=$?

  if (( remote_rc != 0 )); then
    log_warn "git ls-remote failed for worktree=$wt_dir remote=origin ref=$remote_ref timeout=${remote_timeout}s exit=$remote_rc; skipping base-branch freshness this tick"
    printf '\n'
    return 0
  fi

  awk '{print $1}' <<< "$remote_output"
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

READY_TRANSIENT_MAX_ATTEMPTS=6

write_ready_attention_file() {
  local state_dir="$1" message="$2"
  mkdir -p "$state_dir"
  printf '%s\n' "$message" > "$state_dir/.needs-attention"
}

_write_cross_pr_diagnostic() {
  local state_dir="$1" ref_name="$2" cmd_class="$3" diag_stderr="$4"
  local result_file="$state_dir/.ready-result.json"
  local diag_json
  diag_json=$(jq -cn \
    --arg ref "$ref_name" \
    --arg commandClass "$cmd_class" \
    --arg stderr "$diag_stderr" \
    '{commandClass: $commandClass, ref: $ref, stderr: $stderr}') || return 0

  mkdir -p "$state_dir"
  local tmp
  tmp=$(mktemp "$state_dir/.ready-result.XXXXXX") || return 0

  if [[ -f "$result_file" ]]; then
    jq --argjson diag "$diag_json" '. + {crossPrDiagnostic: $diag}' "$result_file" > "$tmp" 2>/dev/null \
      && mv "$tmp" "$result_file"
  else
    printf '{"crossPrDiagnostic":%s}\n' "$diag_json" > "$tmp" \
      && mv "$tmp" "$result_file"
  fi
  rm -f "$tmp"
}

cross_pr_revert_gate_allows_merge() {
  local issue="$1" state_dir="$2" wt_dir="$3" pr_number="$4" base_branch="${5-}"
  local result rc prs files message stderr_file raw_error classification
  local tool_stderr=""
  local extra_args=()
  raw_error=""

  [[ -n "$base_branch" ]] && extra_args+=(--base-ref "$base_branch" --integration-ref "$base_branch")
  stderr_file=$(mktemp 2>/dev/null) || stderr_file=""

  if [[ -n "$stderr_file" ]]; then
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/check-cross-pr-reverts.ts" --repo-dir "$wt_dir" "${extra_args[@]}" 2>"$stderr_file"); then
      rc=0
    else
      rc=$?
    fi
    raw_error=$(cat "$stderr_file" 2>/dev/null || echo "")
    rm -f "$stderr_file"
  elif result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/check-cross-pr-reverts.ts" --repo-dir "$wt_dir" "${extra_args[@]}" 2>/dev/null); then
    rc=0
  else
    rc=$?
  fi

  if [[ "$rc" -eq 0 ]]; then
    return 0
  fi
  tool_stderr="$raw_error"

  if [[ "$rc" -eq 1 ]]; then
    prs=$(printf '%s' "$result" | jq -r '[.unacknowledged[]?.prNumber] | reduce .[] as $item ([]; if index($item) then . else . + [$item] end) | map("#" + tostring) | join(", ")' 2>/dev/null || echo "")
    files=$(printf '%s' "$result" | jq -r '[.unacknowledged[]?.files[]?.path] | reduce .[] as $item ([]; if index($item) then . else . + [$item] end) | join(", ")' 2>/dev/null || echo "")
    [[ -n "$prs" ]] || prs="a recently merged PR"
    message="PR #$pr_number removes files from $prs without explicit acknowledgement."
    if [[ -n "$files" ]]; then
      message="$message Affected files: $files."
    fi
    write_ready_attention_file "$state_dir" "$message"
    npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
      --state-dir "$state_dir" \
      --stage "cross-pr-guard" \
      --tool "check-cross-pr-reverts" \
      --classification "preflight-failure" \
      --reason "$message" \
      --raw-error "$raw_error" \
      --exit-code "$rc" >/dev/null 2>&1 || true
    log "status" "⛔ $issue → Cross-PR revert guard blocked ready phase for PR #$pr_number"
    return 1
  fi

  if [[ "$rc" -eq 2 ]] && printf '%s' "$result" | jq -e '.toolError' >/dev/null 2>&1; then
    local ref_name cmd_class diag_stderr
    ref_name=$(printf '%s' "$result" | jq -r '.toolError.ref // ""' 2>/dev/null || echo "")
    cmd_class=$(printf '%s' "$result" | jq -r '.toolError.commandClass // ""' 2>/dev/null || echo "")
    diag_stderr=$(printf '%s' "$result" | jq -r '.toolError.stderr // ""' 2>/dev/null || echo "")
    [[ -n "$diag_stderr" ]] || diag_stderr="${tool_stderr:0:2048}"
    [[ -z "$ref_name" && -n "$tool_stderr" ]] && ref_name="${tool_stderr:0:200}"
    [[ -z "$ref_name" ]] && ref_name="unknown ref"
    [[ -z "$cmd_class" ]] && cmd_class="unknown command"

    message="Cross-PR revert guard tool failure for PR #$pr_number: $cmd_class failed on ref '$ref_name'."
    if [[ -n "$diag_stderr" ]]; then
      message="$message Diagnostic: $diag_stderr"
    fi

    write_ready_attention_file "$state_dir" "$message"
    _write_cross_pr_diagnostic "$state_dir" "$ref_name" "$cmd_class" "$diag_stderr"
    npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
      --state-dir "$state_dir" \
      --stage "cross-pr-guard" \
      --tool "check-cross-pr-reverts" \
      --classification "preflight-failure" \
      --reason "$message" \
      --raw-error "${diag_stderr:-$raw_error}" \
      --exit-code "$rc" >/dev/null 2>&1 || true
    log_error "  Cross-PR revert guard tool failure for $issue (PR #$pr_number): $cmd_class on '$ref_name'"
    return 1
  fi

  classification="preflight-failure"
  if [[ "$raw_error" == *"not a valid object name"* ]] || [[ "$raw_error" == *"bad revision"* ]] || [[ "$raw_error" == *"does not exist"* ]]; then
    classification="ref-missing"
  fi

  write_ready_attention_file "$state_dir" "Cross-PR revert guard failed for PR #$pr_number."
  npx tsx "$TOOLS_DIR/ready-preflight-diagnostic.ts" \
    --state-dir "$state_dir" \
    --stage "cross-pr-guard" \
    --tool "check-cross-pr-reverts" \
    --classification "$classification" \
    --reason "Cross-PR revert guard failed for PR #$pr_number." \
    --raw-error "$raw_error" \
    --exit-code "$rc" >/dev/null 2>&1 || true
  log_error "  Cross-PR revert guard failed for $issue (PR #$pr_number)"
  return 1
}

transient_mergeability_count() {
  local state_dir="$1"
  local count_file="$state_dir/.transient-mergeability-count"

  if [[ ! -f "$count_file" ]]; then
    echo "0"
    return 0
  fi

  local count
  count=$(cat "$count_file" 2>/dev/null || echo "0")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi

  echo "$count"
}

increment_transient_mergeability_count() {
  local state_dir="$1"
  local count
  count=$(transient_mergeability_count "$state_dir")
  count=$((count + 1))
  mkdir -p "$state_dir"
  printf '%s\n' "$count" > "$state_dir/.transient-mergeability-count"
  echo "$count"
}

clear_transient_mergeability_state() {
  local state_dir="$1"
  rm -f \
    "$state_dir/.transient-mergeability-count" \
    "$state_dir/.needs-attention-transient"
}

write_transient_ready_attention_file() {
  local state_dir="$1" message="$2"
  write_ready_attention_file "$state_dir" "$message"
  : > "$state_dir/.needs-attention-transient"
}

log_ready_failure_result() {
  local issue="$1"
  local result="${2-}"
  local summary debug_file

  summary="$(summarize_ready_result "$result")"
  debug_file="$(ready_debug_log_file)"

  log_error "  Ready checks failed for $issue - $summary"
  if [[ -n "$result" ]]; then
    log_error "  Full ready result: $debug_file"
    log_debug_json "ready" "$result"
  fi
}

log_ready_unparseable_result() {
  local issue="$1"
  local result="${2-}"
  local debug_file

  debug_file="$(ready_debug_log_file)"
  log_error "  Ready checks produced unparseable output for $issue"
  if [[ -n "$result" ]]; then
    log_error "  Full ready result: $debug_file"
    log_debug_json "ready" "$result"
  fi
}

ready_failure_is_actionable_for_remediation() {
  local state_dir="${1-}"
  local verdict="${2-}"
  local failed_check_names="${3-}"
  local ready_result="${4-}"
  local actionable_names failed_check_name failed_check_name_lc
  local IFS=','

  if [[ -f "$state_dir/.ready-watchdog-stable-failure.json" ]]; then
    return 0
  fi

  [[ "$verdict" == "fail" ]] || return 1
  [[ -n "$failed_check_names" ]] || return 1

  actionable_names=",ci-status,test,tests,unit,unit-test,unit-tests,shell,shell-test,shell-tests,lint,typecheck,type-check,build,ci,"
  for failed_check_name in $failed_check_names; do
    failed_check_name_lc="${failed_check_name,,}"
    if [[ "$actionable_names" == *",$failed_check_name_lc,"* ]]; then
      return 0
    fi
  done

  if printf '%s' "$ready_result" | jq -e '
    ["test", "tests", "unit", "unit-tests", "shell", "shell-tests", "lint", "typecheck", "type-check", "build"] as $terms
    | [
        .checks[]?
        | select(.status == "fail")
        | (
            (.name // "") + " "
            + (.message // "") + " "
            + ((.details.failedChecks // []) | map(.name // "") | join(" "))
          )
        | ascii_downcase
      ] as $failed_text
    | any($failed_text[]; . as $text | any($terms[]; . as $term | ($text | contains($term))))
  ' >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

ready_failed_check_summary() {
  local ready_result="${1-}"

  printf '%s' "$ready_result" | jq -r '
    [
      .checks[]?
      | select(.status == "fail")
      | if .name == "ci-status" then
          "ci-status: " + (.message // "CI checks failing")
          + (if ((.details.failedChecks // []) | length) > 0
              then " (" + ((.details.failedChecks // []) | map(.name // "unknown") | join(", ")) + ")"
              else ""
            end)
        else
          (.name // "unknown") + ": " + (.message // "check failed")
        end
    ]
    | join("; ")
  ' 2>/dev/null
}

set_ready_pass_labels() {
  local wt_dir="$1"
  local pr_number="$2"

  (cd "$wt_dir" && npx tsx "$TOOLS_DIR/set-pr-ready-label.ts" "$pr_number")
}

_launch_ready_remediation_attempt() {
  local issue="$1" slug="$2" wt_dir="$3" branch="$4" base_branch="$5" pr_number="$6"
  local state_dir="$7" win="$8" status_file="$9" current_agent="${10}" current_model="${11}"
  local current_head="${12}" checks_run="${13}" checks_passed="${14}" merge_status="${15}"
  local remediation_attempt_number="${16}" remediation_max_attempts="${17}"
  local failed_check_names_json="${18}" failed_check_summary="${19}" ready_result_file="${20}"
  local remediation_agent prompt_file launch_rc remediation_artifacts_json remediation_failed_artifacts_json

  remediation_agent=$(ready_remediation_agent_cmd "$wt_dir")
  [[ -z "$remediation_agent" ]] && remediation_agent="$current_agent"
  [[ -z "$remediation_agent" ]] && remediation_agent="$AGENT_CMD"

  prompt_file="/tmp/${SESSION}-${issue}-ready-remediation-prompt.txt"
  build_ready_remediation_prompt \
    "$pr_number" \
    "$branch" \
    "$wt_dir" \
    "$status_file" \
    "$base_branch" \
    "$remediation_attempt_number" \
    "$remediation_max_attempts" \
    "$failed_check_summary" \
    "$ready_result_file" > "$prompt_file"

  _launch_agent_in_pane "$win" "$remediation_agent" "$current_model" "$prompt_file" "$slug" "$issue"
  launch_rc=$?

  if [[ "$launch_rc" -eq 0 ]]; then
    remediation_artifacts_json=$(jq -cn \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --arg launch_head "$current_head" \
      --argjson pr_number "${pr_number}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson attempts "$remediation_attempt_number" \
      --argjson remediation_failures "$failed_check_names_json" \
      '{
        type: "ready",
        verdict: "fail",
        checksRun: $checks_run,
        checksPassed: $checks_passed,
        mergeConflict: $merge_status,
        prNumber: $pr_number,
        remediationAttempts: $attempts,
        remediationLaunchHead: $launch_head,
        remediationFailures: $remediation_failures
      }')
    remediation_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$remediation_artifacts_json" "candidate-progress")
    write_stage_result "$state_dir" "ready" "running" "$remediation_agent" "$current_model" \
      "Ready remediation in progress for PR #$pr_number" \
      "$remediation_artifacts_json"
    rm -f "$state_dir/.needs-attention"
    log "status" "⚙ $issue → Launched ready remediation (attempt ${remediation_attempt_number}/${remediation_max_attempts}) for PR #$pr_number"
    return 0
  fi

  if [[ "$launch_rc" -eq 2 ]] && check_stage_aborted "$state_dir"; then
    return 2
  fi

  remediation_failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
    "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":$(( remediation_attempt_number - 1 )),\"remediationFailures\":${failed_check_names_json}}" \
    "candidate-progress")
  write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
    "Could not launch ready remediation agent" \
    "$remediation_failed_artifacts_json"
  write_ready_attention_file "$state_dir" "Could not launch remediation agent for PR #$pr_number."
  log_error "  Failed to launch ready remediation agent for $issue"
  return 1
}

launch_ready_watchdog_remediation() {
  local issue="$1" slug="$2" wt_dir="$3" branch="$4" base_branch="$5" pr_number="$6"
  local failed_check_summary="$7" attempt_number="$8" max_attempts="$9" failed_check_names_json="${10}"
  local win state_dir status_file current_agent current_model current_head remediation_attempts remediation_launch_head
  local ready_status checks_run checks_passed merge_status ready_result_file helper_rc

  : "${SESSION:=wavemill}"
  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
  state_dir="$(ready_state_dir "$wt_dir" "$slug")"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  current_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  current_model=$(read_state_value "" --arg i "$issue" '.tasks[$i].model // ""')
  [[ -z "$current_agent" ]] && current_agent="$AGENT_CMD"
  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
  remediation_attempts=$(ready_remediation_attempts "$state_dir")
  remediation_launch_head=$(ready_remediation_launch_head "$state_dir")
  ready_status=$(read_stage_status "$state_dir" "ready")
  ready_result_file="$state_dir/.ready-result.json"
  checks_run=$(jq -r '.artifacts.checksRun // 0' "$ready_result_file" 2>/dev/null || echo "0")
  checks_passed=$(jq -r '.artifacts.checksPassed // 0' "$ready_result_file" 2>/dev/null || echo "0")
  merge_status=$(jq -r '.artifacts.mergeConflict // "UNKNOWN"' "$ready_result_file" 2>/dev/null || echo "UNKNOWN")

  if [[ "$ready_status" == "running" ]] && [[ -n "$remediation_launch_head" ]] && [[ "$remediation_launch_head" == "$current_head" ]]; then
    jq -cn --arg detail "Ready remediation is already running for PR #$pr_number at $current_head." --argjson attempt "$remediation_attempts" \
      '{status:"skipped-in-flight", detail:$detail, attemptNumber:$attempt}'
    return 0
  fi

  if (( remediation_attempts >= max_attempts )); then
    jq -cn --arg detail "Ready remediation capped at ${remediation_attempts}/${max_attempts} attempts for PR #$pr_number." --argjson attempt "$remediation_attempts" \
      '{status:"skipped-max-attempts", detail:$detail, attemptNumber:$attempt}'
    return 0
  fi

  _launch_ready_remediation_attempt \
    "$issue" "$slug" "$wt_dir" "$branch" "$base_branch" "$pr_number" \
    "$state_dir" "$win" "$status_file" "$current_agent" "$current_model" \
    "$current_head" "$checks_run" "$checks_passed" "$merge_status" \
    "$attempt_number" "$max_attempts" "$failed_check_names_json" "$failed_check_summary" "$ready_result_file"
  helper_rc=$?

  if [[ "$helper_rc" -eq 0 ]]; then
    jq -cn --arg detail "Launched ready remediation attempt ${attempt_number}/${max_attempts} for failing checks: $failed_check_summary." --arg head "$current_head" --argjson attempt "$attempt_number" \
      '{status:"launched", detail:$detail, attemptNumber:$attempt, launchHead:$head}'
    return 0
  fi

  jq -cn --arg detail "Failed to launch ready remediation attempt ${attempt_number}/${max_attempts} for PR #$pr_number." --argjson attempt "$attempt_number" \
    '{status:"failed", detail:$detail, attemptNumber:$attempt}'
  return 0
}

if [[ "${WAVEMILL_READY_WATCHDOG_SOURCE_ONLY:-}" == "1" ]]; then
  return 0 2>/dev/null || exit 0
fi

launch_ready_phase() {
  local issue="$1" slug="$2" title="$3" wt_dir="$4" branch="$5" base_branch="$6"
  local pr_number="$7"
  local win
  local state_dir status_file result ready_rc merge_status verdict
  local current_agent current_model prompt_file launch_rc launch_head checks_run checks_passed
  local remediation_attempts remediation_launch_head remediation_enabled remediation_max_attempts
  local remediation_agent failed_check_names failed_check_summary current_head ready_status
  local remediation_artifacts_json failed_check_names_json ready_result_file ready_stderr_file
  local prior_ready_status prior_ready_verdict pending_log_level

  win="$(_ensure_task_window_exists "$SESSION" "$issue" "$slug" "$wt_dir")"
  persist_task_window_id "$issue" "$win"
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

  log "$pending_log_level" "  $issue: Launching ready phase (PR #$pr_number)"

  if ! cross_pr_revert_gate_allows_merge "$issue" "$state_dir" "$wt_dir" "$pr_number" "$base_branch"; then
    return 1
  fi

  ready_stderr_file=$(mktemp) || {
    log_warn "  Failed to capture ready stderr for $issue (mktemp failed)"
    ready_stderr_file=""
  }
  if [[ -n "$ready_stderr_file" ]]; then
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" --state-dir "$state_dir" 2>"$ready_stderr_file"); then
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
    if result=$(cd "$wt_dir" && npx tsx "$TOOLS_DIR/ready.ts" "$pr_number" --state-dir "$state_dir" 2>/dev/null); then
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
    log_ready_unparseable_result "$issue" "$result"
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
    _launch_agent_in_pane "$win" "$current_agent" "$current_model" "$prompt_file" "$slug" "$issue"
    launch_rc=$?

    if [[ "$launch_rc" -eq 0 ]]; then
      launch_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")
      local conflict_artifacts_json
      conflict_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
        "{\"type\":\"ready\",\"prNumber\":$pr_number,\"mergeConflict\":\"CONFLICTED\",\"launchHead\":\"$launch_head\"}" \
        "candidate-progress")
      write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
        "Conflict remediation in progress for PR #$pr_number" \
        "$conflict_artifacts_json"
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
    local transient_count transient_limit pending_artifacts_json
    transient_limit="${READY_TRANSIENT_MAX_ATTEMPTS:-6}"
    transient_count=$(increment_transient_mergeability_count "$state_dir")

    if (( transient_count <= transient_limit )); then
      pending_artifacts_json=$(jq -cn \
        --arg merge_status "${merge_status:-UNKNOWN}" \
        --argjson checks_run "${checks_run:-0}" \
        --argjson checks_passed "${checks_passed:-0}" \
        --argjson pr_number "${pr_number}" \
        --argjson attempts "$transient_count" \
        '{
          type: "ready",
          verdict: "pending",
          checksRun: $checks_run,
          checksPassed: $checks_passed,
          mergeConflict: $merge_status,
          prNumber: $pr_number,
          transientMergeabilityAttempts: $attempts
        }')
      pending_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$pending_artifacts_json" "candidate-progress")
      write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
        "pending GitHub mergeability - will retry (attempt ${transient_count}/${transient_limit})" \
        "$pending_artifacts_json"
      rm -f "$state_dir/.needs-attention" "$state_dir/.needs-attention-transient"
      log "info" "  Merge status for $issue is $merge_status - will retry (attempt ${transient_count}/${transient_limit})"
      return 4
    fi

    write_transient_ready_attention_file "$state_dir" \
      "Merge status $merge_status persisted after $transient_count checks for PR #$pr_number."
    log_error "  Merge status $merge_status persisted for $issue after $transient_count attempts"
    return 1
  fi

  rm -f "$state_dir/.conflict-detected" "$state_dir/.needs-attention" \
    "$state_dir/.conflict-recheck-at" "$state_dir/.needs-attention-transient"
  clear_ready_conflict_attention "$state_dir"
  clear_transient_mergeability_state "$state_dir"

  if [[ "$ready_rc" -eq 0 ]]; then
    local main_sha completed_artifacts_json label_failed_artifacts_json
    main_sha=$(get_main_head_sha "$wt_dir" "$base_branch")
    if ! set_ready_pass_labels "$wt_dir" "$pr_number" >/dev/null 2>&1; then
      label_failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
        "{\"type\":\"ready\",\"verdict\":\"${verdict:-unknown}\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"readyLabelsUpdated\":false,\"readyBaseSha\":\"${main_sha}\"}" \
        "candidate-progress")
      write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
        "Ready passed but failed to restore PR labels" \
        "$label_failed_artifacts_json"
      write_ready_attention_file "$state_dir" "Ready passed for PR #$pr_number, but updating wm:ready labels failed."
      log_error "  Ready passed for $issue but failed to restore PR labels"
      return 1
    fi

    completed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
      "{\"type\":\"ready\",\"verdict\":\"${verdict:-unknown}\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"readyLabelsUpdated\":true,\"readyBaseSha\":\"${main_sha}\"}" \
      "completed")
    write_stage_result "$state_dir" "ready" "completed" "$current_agent" "$current_model" \
      "verdict: ${verdict:-unknown}" \
      "$completed_artifacts_json"
    log "debug" "  $issue: Restored ready labels for PR #$pr_number"
    log "debug" "  $issue: Ready checks completed (verdict: ${verdict:-unknown})"
    return 0
  fi

  if [[ "$ready_rc" -eq 2 ]]; then
    local pending_artifacts_json prior_remediation_failures_json
    prior_remediation_failures_json=$(jq -c '.artifacts.remediationFailures // []' "$ready_result_file" 2>/dev/null || echo '[]')
    pending_artifacts_json=$(jq -cn \
      --arg merge_status "${merge_status:-UNKNOWN}" \
      --argjson checks_run "${checks_run:-0}" \
      --argjson checks_passed "${checks_passed:-0}" \
      --argjson pr_number "${pr_number}" \
      --argjson attempts "${remediation_attempts:-0}" \
      --argjson remediation_failures "$prior_remediation_failures_json" \
      '{
        type: "ready",
        verdict: "pending",
        checksRun: $checks_run,
        checksPassed: $checks_passed,
        mergeConflict: $merge_status,
        prNumber: $pr_number
      } + (if $attempts > 0 then {remediationAttempts: $attempts} else {} end)
        + (if $attempts > 0 and ($remediation_failures | length) > 0
            then {remediationFailures: $remediation_failures}
            else {}
          end)')
    pending_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" "$pending_artifacts_json" "candidate-progress")
    write_stage_result "$state_dir" "ready" "running" "$current_agent" "$current_model" \
      "CI checks pending for PR #$pr_number" \
      "$pending_artifacts_json"
    log "$pending_log_level" "  CI checks pending for $issue (PR #$pr_number) - will retry"
    return 4
  fi

  failed_check_names=$(printf '%s' "$result" | jq -r '[.checks[]? | select(.status == "fail") | .name] | join(",")' 2>/dev/null || echo "")
  failed_check_names_json=$(printf '%s' "$result" | jq -c '[.checks[]? | select(.status == "fail") | .name]' 2>/dev/null || echo '[]')
  remediation_enabled=$(ready_remediation_enabled "$wt_dir")
  remediation_max_attempts=$(ready_remediation_max_attempts "$wt_dir")
  current_head=$(git -C "$wt_dir" rev-parse HEAD 2>/dev/null || echo "")

  if [[ "$remediation_enabled" == "true" ]] && ready_failure_is_actionable_for_remediation "$state_dir" "$verdict" "$failed_check_names" "$result"; then
    if [[ "$ready_status" == "running" ]] && [[ -n "$remediation_launch_head" ]] && [[ "$remediation_launch_head" == "$current_head" ]]; then
      return 5
    fi

    if (( remediation_attempts >= remediation_max_attempts )); then
      local exhausted_artifacts_json
      exhausted_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
        "{\"type\":\"ready\",\"verdict\":\"fail\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number},\"remediationAttempts\":${remediation_attempts},\"remediationFailures\":${failed_check_names_json}}" \
        "candidate-progress")
      write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" \
        "Ready remediation exhausted after ${remediation_attempts} attempt(s)" \
        "$exhausted_artifacts_json"
      write_ready_attention_file "$state_dir" "Remediation exhausted after ${remediation_attempts} attempt(s) for PR #$pr_number."
      log_error "  Ready remediation exhausted for $issue (failed checks: ${failed_check_names})"
      return 1
    fi

    failed_check_summary=$(ready_failed_check_summary "$result")
    [[ -n "$failed_check_summary" ]] || failed_check_summary="${failed_check_names}: checks failing"
    _launch_ready_remediation_attempt \
      "$issue" "$slug" "$wt_dir" "$branch" "$base_branch" "$pr_number" \
      "$state_dir" "$win" "$status_file" "$current_agent" "$current_model" \
      "$current_head" "${checks_run:-0}" "${checks_passed:-0}" "${merge_status:-UNKNOWN}" \
      "$(( remediation_attempts + 1 ))" "$remediation_max_attempts" \
      "$failed_check_names_json" "$failed_check_summary" "$ready_result_file"
    launch_rc=$?
    if [[ "$launch_rc" -eq 0 ]]; then
      return 5
    elif [[ "$launch_rc" -eq 2 ]]; then
      return 2
    fi
    return 1
  fi

  local failed_artifacts_json
  failed_artifacts_json=$(merge_queue_enrich_ready_artifacts "$state_dir" \
    "{\"type\":\"ready\",\"verdict\":\"${verdict:-unknown}\",\"checksRun\":${checks_run:-0},\"checksPassed\":${checks_passed:-0},\"mergeConflict\":\"${merge_status:-UNKNOWN}\",\"prNumber\":${pr_number}${failed_check_names_json:+,\"remediationFailures\":${failed_check_names_json}}}" \
    "candidate-progress")
  write_stage_result "$state_dir" "ready" "failed" "$current_agent" "$current_model" "Ready checks failed" "$failed_artifacts_json"
  write_ready_attention_file "$state_dir" "Ready checks failed for PR #$pr_number."
  log_ready_failure_result "$issue" "$result"
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
  local target="$win" issue="" slug=""
  if [[ "$win" =~ ^([A-Z]+-[0-9]+(_c)?)-(.+)$ ]]; then
    issue="${BASH_REMATCH[1]}"
    slug="${BASH_REMATCH[3]}"
    local expected_worktree=""
    [[ -n "${WORKTREE_ROOT:-}" ]] && expected_worktree="${WORKTREE_ROOT}/${slug}"
    target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "$expected_worktree" 2>/dev/null || true)"
  fi
  [[ -n "$target" ]] || target="$win"
  target="$(_tmux_target_join "$SESSION" "$target" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$target")"
  if [[ "$state" == "needs-user" ]]; then
    tmux set-window-option -t "$target" window-status-style bg=red,fg=white,bold >/dev/null 2>&1 || true
    tmux set-window-option -t "$target" window-status-current-style bg=red,fg=white,bold >/dev/null 2>&1 || true
  else
    tmux set-window-option -u -t "$target" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$target" window-status-current-style >/dev/null 2>&1 || true
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
  linear_issue="${linear_issue#"${linear_issue%%[![:space:]]*}"}"
  linear_issue="${linear_issue%"${linear_issue##*[![:space:]]}"}"
  if [[ "$linear_issue" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    printf '%s\n' "$linear_issue"
    return 0
  fi
  if [[ "$linear_issue" =~ ^https?://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+([/?#].*)?$ ]]; then
    local linear_url_path="${linear_issue#*://linear.app/}"
    linear_url_path="${linear_url_path#*/issue/}"
    printf '%s\n' "${linear_url_path%%[/?#]*}"
    return 0
  fi
  if [[ "$issue" =~ ^([A-Z][A-Z0-9]*-[0-9]+)_c$ ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi
  printf '%s\n' "$issue"
}

expansion_recovery_resolve_issue_id() {
  local issue="$1"
  local linear_issue=""

  if [[ "$issue" != *_c ]]; then
    printf '%s\n' "$issue"
    return 0
  fi

  linear_issue="$(get_task_meta "$issue" "linearIssueId")"
  linear_issue="${linear_issue#"${linear_issue%%[![:space:]]*}"}"
  linear_issue="${linear_issue%"${linear_issue##*[![:space:]]}"}"
  if [[ "$linear_issue" =~ ^[A-Z][A-Z0-9]*-[0-9]+$ ]]; then
    printf '%s\n' "$linear_issue"
    return 0
  fi

  if [[ "$linear_issue" =~ ^https?://linear\.app/[^/]+/issue/[A-Z][A-Z0-9]*-[0-9]+([/?#].*)?$ ]]; then
    local linear_url_path="${linear_issue#*://linear.app/}"
    linear_url_path="${linear_url_path#*/issue/}"
    printf '%s\n' "${linear_url_path%%[/?#]*}"
    return 0
  fi

  return 1
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
  [[ "$role" == "challenger" && "${CHALLENGE_AUTO_MERGE:-false}" != "true" ]]
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
        .value.challengeCompared = true |
        .value |= (
          del(
            .comparisonRunning,
            .comparisonState,
            .comparisonBlockedReason,
            .comparisonRetryCount,
            .comparisonRetryMaxAttempts,
            .comparisonRetryTargetIssue,
            .comparisonTimedOutSides,
            .manualComparisonArtifact
          ) |
          .updated = (now | todateiso8601)
        )
      else
        .
      end
    )' --arg pair "$pair_id"; then
    log_warn "mark_challenge_compared: failed for $pair_id"
  fi
}

sanitize_job_token() {
  printf '%s' "${1:-unknown}" | sed 's/[^A-Za-z0-9._-]/-/g'
}

challenge_job_dir() {
  local dir="$REPO_DIR/.wavemill/jobs/$SESSION"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

build_eval_job_id() {
  local issue="$1" side="$2" pr="$3"
  printf 'eval-%s-%s-%s\n' \
    "$(sanitize_job_token "$issue")" \
    "$(sanitize_job_token "$side")" \
    "$pr"
}

build_comparison_job_id() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  printf 'comparison-%s-%s-%s\n' \
    "$(sanitize_job_token "$pair_id")" \
    "$primary_pr" \
    "$challenger_pr"
}

read_job_state_value() {
  local job_id="$1" default="$2" expr="$3"
  read_state_value "$default" --arg id "$job_id" "$expr"
}

launch_tracked_job() {
  local kind="$1" job_id="$2" issue_id="$3" side="$4" pair_id="$5" pr_numbers="$6" pid="$7" timeout_seconds="$8" log_path="$9" result_path="${10}"
  local args=(
    launch
    --state-file "$STATE_FILE" \
    --kind "$kind" \
    --job-id "$job_id" \
    --pr-numbers "$pr_numbers" \
    --pid "$pid" \
    --timeout-seconds "$timeout_seconds" \
    --log-path "$log_path" \
    --result-path "$result_path"
  )
  [[ -n "$issue_id" ]] && args+=(--issue-id "$issue_id")
  [[ -n "$side" ]] && args+=(--side "$side")
  [[ -n "$pair_id" ]] && args+=(--pair-id "$pair_id")
  [[ -n "${SESSION:-}" ]] && args+=(--session "$SESSION")
  npx tsx "$TOOLS_DIR/job-tracker.ts" "${args[@]}" >/dev/null
}

settle_tracked_job() {
  local job_id="$1"
  npx tsx "$TOOLS_DIR/job-tracker.ts" mark-settled \
    --state-file "$STATE_FILE" \
    --job-id "$job_id" \
    >/dev/null
}

render_challenge_comparison_summary() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3" primary_model="$4" challenger_model="$5" result_path="$6"
  [[ -r "$result_path" ]] || return 0

  local compare_json winner winner_model rationale
  local comp_p comp_c cor_p cor_c qual_p qual_c impact_p impact_c auto_p auto_c
  local primary_eval_score challenger_eval_score
  compare_json=$(jq -c '.comparison // {}' "$result_path" 2>/dev/null || echo "{}")
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

  local disp_primary disp_challenger disp_winner
  local primary_planner challenger_planner primary_reviewer challenger_reviewer
  local disp_primary_planner disp_challenger_planner disp_primary_reviewer disp_challenger_reviewer
  local model_row_label has_routing
  disp_primary=$(echo "$primary_model" | sed 's/-[0-9]\{8\}$//')
  disp_challenger=$(echo "$challenger_model" | sed 's/-[0-9]\{8\}$//')
  disp_winner=$(echo "$winner_model" | sed 's/-[0-9]\{8\}$//')
  primary_planner=$(echo "$compare_json" | jq -r '.comparison.primaryRouting.planner // .primaryRouting.planner // empty' 2>/dev/null)
  challenger_planner=$(echo "$compare_json" | jq -r '.comparison.challengerRouting.planner // .challengerRouting.planner // empty' 2>/dev/null)
  primary_reviewer=$(echo "$compare_json" | jq -r '.comparison.primaryRouting.reviewer // .primaryRouting.reviewer // empty' 2>/dev/null)
  challenger_reviewer=$(echo "$compare_json" | jq -r '.comparison.challengerRouting.reviewer // .challengerRouting.reviewer // empty' 2>/dev/null)
  disp_primary_planner=$(echo "$primary_planner" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_planner=$(echo "$challenger_planner" | sed 's/-[0-9]\{8\}$//')
  disp_primary_reviewer=$(echo "$primary_reviewer" | sed 's/-[0-9]\{8\}$//')
  disp_challenger_reviewer=$(echo "$challenger_reviewer" | sed 's/-[0-9]\{8\}$//')
  has_routing="false"
  if [[ -n "$primary_planner$challenger_planner$primary_reviewer$challenger_reviewer" ]]; then
    has_routing="true"
  fi
  model_row_label="Model"
  [[ "$has_routing" == "true" ]] && model_row_label="Coder"

  log "status" ""
  log "status" "  ┌────────────────────────────────────────────────────────────┐"
  log "status" "  │  ⚖  Challenge Comparison: $pair_id"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  log "status" "  │                    Primary            Challenger           │"
  log "status" "  │  $(printf '%-14s' "$model_row_label")$(printf '%-20s' "$disp_primary") $(printf '%-19s' "$disp_challenger")│"
  if [[ "$has_routing" == "true" ]]; then
    log "status" "  │  Planner        $(printf '%-20s' "${disp_primary_planner:-—}") $(printf '%-19s' "${disp_challenger_planner:-—}")│"
    log "status" "  │  Reviewer       $(printf '%-20s' "${disp_primary_reviewer:-—}") $(printf '%-19s' "${disp_challenger_reviewer:-—}")│"
  fi
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
  echo "$rationale" | fold -s -w 56 | while IFS= read -r rline; do
    log "status" "  │  $(printf '%-58s' "$rline")│"
  done
  log "status" "  └────────────────────────────────────────────────────────────┘"
  log "status" ""
}

handle_comparison_job_success() {
  local pair_id="$1" primary_key="$2" challenger_key="$3" primary_pr="$4" challenger_pr="$5" result_path="$6"
  local primary_model challenger_model loser_key loser_slug loser_pr winner
  primary_model=$(get_task_meta "$primary_key" "challengeModel")
  challenger_model=$(get_task_meta "$challenger_key" "challengeModel")
  render_challenge_comparison_summary "$pair_id" "$primary_pr" "$challenger_pr" "$primary_model" "$challenger_model" "$result_path"

  winner=$(jq -r '.comparison.winner // empty' "$result_path" 2>/dev/null || echo "")
  if [[ "$winner" == "primary" ]]; then
    loser_key="$challenger_key"
  elif [[ "$winner" == "challenger" ]]; then
    loser_key="$primary_key"
  fi

  if [[ -n "${loser_key:-}" ]]; then
    loser_slug=$(get_task_meta "$loser_key" "slug")
    loser_pr=$(get_task_meta "$loser_key" "pr")
    if [[ -n "$loser_slug" ]]; then
      if [[ "${CHALLENGE_AUTO_MERGE:-false}" == "true" ]]; then
        log "status" "  ⚖ Auto-merge enabled: cleaning up losing side: $loser_key"
        if [[ -n "$loser_pr" ]] && [[ "$(pr_state "$loser_pr")" == "OPEN" ]]; then
          gh pr close "$loser_pr" \
            --comment "Closing: lost challenge comparison to ${winner} side." 2>/dev/null || true
          log "status" "Closed losing PR #$loser_pr"
        fi
        cleanup_completed_task "$loser_key" "$loser_slug" "challenge loser"
      else
        log "status" "  ⚖ Both PRs remain open for manual review (autoMergeWinner=false)"
      fi
    fi
  fi
}

poll_challenge_jobs() {
  local poll_json
  if ! poll_json=$(npx tsx "$TOOLS_DIR/job-tracker.ts" poll --state-file "$STATE_FILE" 2>/dev/null); then
    log_warn "challenge job poll failed"
    return 0
  fi

  while IFS= read -r job_json; do
    [[ -z "$job_json" ]] && continue
    local job_id kind status issue_id pair_id excerpt reason log_path result_path side
    local primary_pr challenger_pr primary_key challenger_key
    job_id=$(echo "$job_json" | jq -r '.id')
    kind=$(echo "$job_json" | jq -r '.kind')
    status=$(echo "$job_json" | jq -r '.status')
    issue_id=$(echo "$job_json" | jq -r '.issueId // empty')
    pair_id=$(echo "$job_json" | jq -r '.pairId // empty')
    excerpt=$(echo "$job_json" | jq -r '.excerpt // empty')
    reason=$(echo "$job_json" | jq -r '.reason // empty')
    log_path=$(echo "$job_json" | jq -r '.logPath // empty')
    result_path=$(echo "$job_json" | jq -r '.resultPath // empty')
    side=$(echo "$job_json" | jq -r '.side // empty')

    if [[ "$kind" == "eval" && "$status" == "succeeded" ]]; then
      log "status" "Challenge eval completed for $issue_id${side:+ ($side)}"
      settle_tracked_job "$job_id"
      continue
    fi

    if [[ "$kind" == "comparison" && "$status" == "succeeded" ]]; then
      primary_pr=$(echo "$job_json" | jq -r '.prNumbers[0] // empty')
      challenger_pr=$(echo "$job_json" | jq -r '.prNumbers[1] // empty')
      primary_key="$pair_id"
      challenger_key="${pair_id}_c"
      handle_comparison_job_success "$pair_id" "$primary_key" "$challenger_key" "$primary_pr" "$challenger_pr" "$result_path"
      settle_tracked_job "$job_id"
      continue
    fi

    if [[ "$kind" == "eval" && ( "$reason" == "no_result_file" || "$reason" == "timed_out" ) && -n "$issue_id" ]]; then
      local pr_num
      pr_num=$(echo "$job_json" | jq -r '.prNumbers[0] // empty')
      if [[ -n "$result_path" ]] && [[ -f "$result_path" ]] \
        && [[ "$(jq -r '.ok // .persisted // false' "$result_path" 2>/dev/null || echo "false")" == "true" ]]; then
        log_warn "challenge eval for $issue_id ${reason}: result was persisted, marking completed"
        mark_eval_completed "$issue_id"
        settle_tracked_job "$job_id"
        continue
      fi
      if [[ -n "$pr_num" ]] && eval_record_exists_for_issue_pr "$issue_id" "$pr_num"; then
        log_warn "challenge eval for $issue_id ${reason}: eval record was persisted, marking completed"
        mark_eval_completed "$issue_id"
        settle_tracked_job "$job_id"
        continue
      fi
    fi
    if [[ "$kind" == "eval" && "$reason" == "timed_out" && -n "$issue_id" && -n "$pair_id" ]]; then
      local retry_max retry_count timed_out_sides_csv timeout_reason primary_key challenger_key artifact_path
      local issue_pr issue_branch issue_slug
      primary_key="$pair_id"
      challenger_key="${pair_id}_c"
      settle_tracked_job "$job_id"
      retry_max=$(challenge_eval_retry_max_attempts)
      retry_count=$(read_state_value "0" --arg i "$primary_key" '.tasks[$i].comparisonRetryCount // 0')
      timed_out_sides_csv=$(challenge_pair_timed_out_sides_csv "$primary_key")
      if [[ -n "$timed_out_sides_csv" ]]; then
        case ",$timed_out_sides_csv," in
          *,"$side",*) ;;
          *) timed_out_sides_csv="${timed_out_sides_csv},${side}" ;;
        esac
      else
        timed_out_sides_csv="$side"
      fi
      timed_out_sides_csv="${timed_out_sides_csv#,}"
      timeout_reason=$(challenge_pair_timeout_reason "$timed_out_sides_csv")

      if (( retry_count < retry_max )); then
        retry_count=$((retry_count + 1))
        write_challenge_pair_state "$pair_id" "retrying_eval" "$timeout_reason" "$retry_count" "$retry_max" "$issue_id" "$timed_out_sides_csv" ""
        state_mutate "$STATE_FILE" '
          .tasks[$issue].evalFailed = false
          | .tasks[$issue].evalCompleted = false
          | .tasks[$issue].updated = (now | todateiso8601)
        ' --arg issue "$issue_id" >/dev/null || true
        issue_pr=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].pr // empty')
        issue_branch=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].branch // empty')
        issue_slug=$(read_state_value "" --arg i "$issue_id" '.tasks[$i].slug // empty')
        log "status" "challenge comparison retrying for $pair_id: $side eval timed out (attempt $retry_count/$retry_max)"
        if [[ -n "$issue_pr" && -n "$issue_branch" && -n "$issue_slug" ]]; then
          maybe_run_challenge_eval "$issue_id" "$issue_pr" "$issue_branch" "$issue_slug"
        else
          log_warn "challenge eval retry launch skipped for $issue_id: missing PR/branch/slug"
        fi
        continue
      fi

      artifact_path=$(write_manual_challenge_comparison_artifact "$pair_id" "$primary_key" "$challenger_key" "$timed_out_sides_csv" "$retry_count" "$retry_max" || true)
      write_challenge_pair_state "$pair_id" "manual_comparison_needed" "$timeout_reason" "$retry_count" "$retry_max" "" "$timed_out_sides_csv" "$artifact_path"
      log_warn "challenge comparison blocked for $pair_id: ${timed_out_sides_csv} eval timed out. manual comparison needed${artifact_path:+ ($artifact_path)}"
      continue
    fi

    if [[ "$kind" == "eval" ]]; then
      log_warn "challenge eval failed for $issue_id (${reason:-$status}); log: $log_path"
    else
      log_warn "challenge comparison failed for $pair_id (${reason:-$status}); log: $log_path"
    fi
    if [[ -n "$excerpt" ]]; then
      while IFS= read -r line; do
        [[ -n "$line" ]] && log_warn "  $line"
      done <<<"$excerpt"
    fi
    settle_tracked_job "$job_id"
  done < <(echo "$poll_json" | jq -c '.unsettled[]?')
}

maybe_run_challenge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4"
  local eval_completed eval_failed eval_hard_retry_count eval_hard_retry_max
  local pair_id solution_model linear_issue eval_agent side challenge_stage job_id job_status job_dir log_path result_path pid eval_timeout
  eval_completed=$(read_state_value "false" --arg i "$issue" '.tasks[$i].evalCompleted // false')
  [[ "$eval_completed" == "true" ]] && return 0

  pair_id=$(get_task_meta "$issue" "challengePairId")
  if [[ "$(read_state_value "false" --arg i "$issue" '.tasks[$i].challengeCompared // false')" == "true" ]]; then
    return 0
  fi
  eval_failed=$(read_state_value "false" --arg i "$issue" '.tasks[$i].evalFailed // false')
  if [[ "$eval_failed" == "true" ]]; then
    eval_hard_retry_count=$(read_state_value "0" --arg i "$issue" '.tasks[$i].evalHardFailureRetryCount // 0')
    eval_hard_retry_max=$(challenge_eval_hard_failure_max_retries)
    if (( eval_hard_retry_count < eval_hard_retry_max )); then
      eval_hard_retry_count=$((eval_hard_retry_count + 1))
      state_mutate "$STATE_FILE" '
        .tasks[$issue].evalFailed = false
        | .tasks[$issue].evalCompleted = false
        | .tasks[$issue].evalHardFailureRetryCount = $retryCount
        | .tasks[$issue].updated = (now | todateiso8601)
      ' --arg issue "$issue" --argjson retryCount "$eval_hard_retry_count" >/dev/null || true
      log "status" "challenge eval retrying for $issue: hard failure (attempt $eval_hard_retry_count/$eval_hard_retry_max)"
    else
      resolve_challenge_pair_hard_failure "$pair_id" >/dev/null || true
      return 0
    fi
  fi
  solution_model=$(get_task_meta "$issue" "challengeModel")
  linear_issue=$(get_linear_issue_id "$issue")
  eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
  [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
  side=$(get_task_meta "$issue" "challengeRole")
  [[ -z "$side" ]] && side="primary"
  challenge_stage=$(get_task_meta "$issue" "challengeStage")
  job_id=$(build_eval_job_id "$issue" "$side" "$pr")
  job_status=$(read_job_state_value "$job_id" "" '.jobs[$id].status // empty')
  if [[ "$job_status" == "running" || "$job_status" == "succeeded" ]]; then
    return 0
  fi

  job_dir=$(challenge_job_dir)
  log_path="$job_dir/${job_id}.log"
  result_path="$job_dir/${job_id}.result.json"

  log "status" "  📊 [mill] eval running: issue=$issue side=$side pr=#$pr phase=eval"
  if ! mark_challenge_eval_running "$issue" "$side" "$pr" "eval" >/dev/null; then
    log_warn "challenge eval launch skipped for $issue: failed to persist running state"
    return 1
  fi

  npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
    --issue "$linear_issue" --pr "$pr" --branch "$branch" \
    --worktree "${WORKTREE_ROOT}/${slug}" \
    --workflow-type mill --repo-dir "$REPO_DIR" \
    --agent "$eval_agent" \
    --solution-model "$solution_model" \
    --challenge-pair "$pair_id" \
    --challenge-stage "${challenge_stage:-}" \
    --result-file "$result_path" \
    --debug \
    >"$log_path" 2>&1 &
  pid=$!

  eval_timeout="$(post_merge_eval_timeout_seconds)"
  launch_tracked_job "eval" "$job_id" "$issue" "$side" "$pair_id" "$pr" "$pid" "$eval_timeout" "$log_path" "$result_path"
  log "status" "  📊 Challenge eval running in background for $issue (pid $pid)"
}

post_merge_eval_timeout_seconds() {
  local timeout
  timeout=$(wavemill_load_config "$REPO_DIR" | jq -r '.eval.postMergeTimeoutSeconds // 600' 2>/dev/null || echo "600")
  if [[ "$timeout" =~ ^[0-9]+$ ]] && (( timeout >= 30 )); then
    echo "$timeout"
  else
    echo "600"
  fi
}

launch_background_post_merge_eval() {
  local issue="$1" pr="$2" branch="$3" slug="$4" issue_ref="$5" reason="$6" preresolved_agent="${7:-}"
  local eval_agent eval_log eval_timeout rc result_path persisted

  if [[ -n "$preresolved_agent" ]]; then
    eval_agent="$preresolved_agent"
  else
    validate_agent_set "$issue"
    eval_agent=$(read_state_value "" --arg i "$issue" '.tasks[$i].agent // ""')
    [[ -z "$eval_agent" ]] && eval_agent="$AGENT_CMD"
  fi

  eval_log="/tmp/${SESSION}-eval-${issue}.log"
  result_path="/tmp/${SESSION:-wavemill}-eval-${issue}-result.json"
  eval_timeout="$(post_merge_eval_timeout_seconds)"
  : >"$eval_log"
  rm -f "$result_path"

  (
    {
      printf 'Launching %s eval in background\n' "$reason"
      if [[ -n "$pr" ]]; then
        if _with_timeout "$eval_timeout" npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --pr "$pr" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --result-file "$result_path" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      else
        if _with_timeout "$eval_timeout" npx tsx "$TOOLS_DIR/run-eval-hook.ts" \
          --issue "$issue_ref" --branch "$branch" \
          --worktree "${WORKTREE_ROOT}/${slug}" \
          --workflow-type mill --repo-dir "$REPO_DIR" \
          --agent "$eval_agent" \
          --result-file "$result_path" \
          --debug; then
          rc=0
        else
          rc=$?
        fi
      fi
      printf 'Eval process exited with code %s\n' "$rc"
      persisted=$(jq -r '.persisted // false' "$result_path" 2>/dev/null || echo "false")
      rm -f "$result_path"
      if [[ "$persisted" == "true" ]]; then
        mark_eval_completed "$issue"
      else
        printf 'WARN: Eval not persisted for %s (rc=%s); setting evalFailed=true\n' "$issue" "$rc"
        mark_eval_failed "$issue"
      fi
    } >>"$eval_log" 2>&1
  ) >/dev/null 2>&1 &

  log "debug" "  ↳ Eval running in background; log: $eval_log"
}

maybe_run_challenge_comparison() {
  local issue="$1"
  local pair_id primary_key challenger_key compared primary_pr challenger_pr primary_eval challenger_eval linear_issue primary_model challenger_model
  local primary_planner primary_reviewer primary_plan_depth primary_code_depth primary_review_mode
  local challenger_planner challenger_reviewer challenger_plan_depth challenger_code_depth challenger_review_mode
  local job_id job_status job_reason pairing_repaired job_dir log_path result_path pid
  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -z "$pair_id" ]] && return 0
  primary_key="$pair_id"
  challenger_key="${pair_id}_c"
  compared=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].challengeCompared // false')
  [[ "$compared" == "true" ]] && return 0
  if [[ "$(read_state_value "" --arg i "$primary_key" '.tasks[$i].comparisonState // empty')" == "manual_comparison_needed" ]]; then
    return 0
  fi

  primary_pr=$(read_state_value "" --arg i "$primary_key" '.tasks[$i].pr // empty')
  challenger_pr=$(read_state_value "" --arg i "$challenger_key" '.tasks[$i].pr // empty')
  primary_eval=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].evalCompleted // false')
  challenger_eval=$(read_state_value "false" --arg i "$challenger_key" '.tasks[$i].evalCompleted // false')
  [[ -z "$primary_pr" || -z "$challenger_pr" || "$primary_eval" != "true" || "$challenger_eval" != "true" ]] && return 0
  job_id=$(build_comparison_job_id "$pair_id" "$primary_pr" "$challenger_pr")
  job_status=$(read_job_state_value "$job_id" "" '.jobs[$id].status // empty')
  if [[ -n "$job_status" ]]; then
    # A prior comparison already ran. By default that's terminal: succeeded /
    # running need no action, and genuinely failing comparisons (LLM errors,
    # invalid scores) must not relaunch every poll and burn repeated LLM calls.
    #
    # The one exception is a failure caused by drifted challenge pairing
    # metadata ("Missing eval records"): the eval scores exist but the
    # challenger record is filed under the wrong pair id. We attempt a single
    # self-healing repair + retry, gated by a one-shot flag so a pair can never
    # loop here. launch_tracked_job upserts by job id, overwriting the failed
    # entry when we proceed below.
    job_reason=$(read_job_state_value "$job_id" "" '.jobs[$id].reason // empty')
    pairing_repaired=$(read_state_value "false" --arg i "$primary_key" '.tasks[$i].comparisonPairingRepaired // false')
    if [[ "$job_status" == "failed" && "$job_reason" == *"Missing eval records"* && "$pairing_repaired" != "true" ]]; then
      log "status" "  ⚖ $pair_id comparison failed on eval pairing — attempting one-shot repair and retry"
      npx tsx "$TOOLS_DIR/repair-challenge-pairing.ts" --pair-id "$pair_id" --repo-dir "$REPO_DIR" >/dev/null 2>&1 || \
        log_warn "challenge pairing repair failed for $pair_id (continuing to retry comparison)"
      state_mutate "$STATE_FILE" '.tasks[$i].comparisonPairingRepaired = true' --arg i "$primary_key" >/dev/null || true
    else
      return 0
    fi
  fi

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

  log "status" "  ⚖ [mill] comparison running: pair=$pair_id primary_pr=#$primary_pr challenger_pr=#$challenger_pr"
  job_dir=$(challenge_job_dir)
  log_path="$job_dir/${job_id}.log"
  result_path="$job_dir/${job_id}.result.json"
  if ! mark_challenge_comparison_running "$pair_id" "$primary_pr" "$challenger_pr" >/dev/null; then
    log_warn "challenge comparison launch skipped for $pair_id: failed to persist running state"
    return 1
  fi
  npx tsx "$TOOLS_DIR/compare-prs.ts" \
    --issue "$linear_issue" --pair-id "$pair_id" \
    --primary-pr "$primary_pr" --challenger-pr "$challenger_pr" \
    --primary-model "$primary_model" --challenger-model "$challenger_model" \
    --primary-planner "$primary_planner" --primary-reviewer "$primary_reviewer" \
    --primary-plan-depth "$primary_plan_depth" --primary-code-depth "$primary_code_depth" --primary-review-mode "$primary_review_mode" \
    --challenger-planner "$challenger_planner" --challenger-reviewer "$challenger_reviewer" \
    --challenger-plan-depth "$challenger_plan_depth" --challenger-code-depth "$challenger_code_depth" --challenger-review-mode "$challenger_review_mode" \
    --repo-dir "$REPO_DIR" --comment \
    --result-file "$result_path" \
    >"$log_path" 2>&1 &
  pid=$!

  launch_tracked_job "comparison" "$job_id" "" "" "$pair_id" "${primary_pr},${challenger_pr}" "$pid" "240" "$log_path" "$result_path"
  log "status" "  ⚖ Challenge comparison running in background for $pair_id (pid $pid)"
}

maybe_resolve_unresolvable_challenge_pair() {
  local issue="$1"
  local pair_id resolve_output resolve_status resolve_reason

  pair_id=$(get_task_meta "$issue" "challengePairId")
  [[ -n "$pair_id" ]] || return 0

  if challenge_pair_record_exists "$pair_id"; then
    mark_challenge_compared "$pair_id" >/dev/null || true
    return 0
  fi

  resolve_output=$(npx tsx "$TOOLS_DIR/resolve-orphan-challenge-pair.ts" \
    --pair-id "$pair_id" \
    --repo-dir "$REPO_DIR" 2>/dev/null || true)
  resolve_status=$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)

  case "$resolve_status" in
    resolved)
      resolve_reason=$(jq -r '.reason // "unknown"' <<<"$resolve_output" 2>/dev/null || echo "unknown")
      mark_challenge_compared "$pair_id" >/dev/null || true
      log_warn "challenge pair $pair_id resolved automatically via $resolve_reason"
      ;;
    already-resolved)
      mark_challenge_compared "$pair_id" >/dev/null || true
      ;;
  esac
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

    if [[ -f "$feature_dir/.initial-route.json" ]]; then
      if jq -e . "$feature_dir/.initial-route.json" >/dev/null 2>&1; then
        cp "$feature_dir/.initial-route.json" "$archive_dir/initial-route.json" 2>/dev/null || true
      else
        log_warn "  Skipping invalid route artifact archive: $feature_dir/.initial-route.json"
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

    if [[ -f "$feature_dir/routing.jsonl" ]]; then
      cp "$feature_dir/routing.jsonl" "$archive_dir/routing.jsonl" 2>/dev/null || true
    fi

    # Trace JSONL (HOK-2259)
    if [[ -f "$feature_dir/trace.jsonl" ]]; then
      cp "$feature_dir/trace.jsonl" "$archive_dir/trace.jsonl" 2>/dev/null || true
    fi

    # Emit cleanup_archived trace event (HOK-2259) — after archive copy so the event lands in the copy
    local _tid _iid _sl
    _tid=$(trace_read_id "$feature_dir" 2>/dev/null || true)
    if [[ -n "$_tid" ]]; then
      _iid=$(jq -r '.issueId // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
      _sl=$(jq -r '.slug // empty' "$feature_dir/.trace-context.json" 2>/dev/null || true)
      if [[ -n "$_iid" && -n "$_sl" ]]; then
        trace_append_event "$feature_dir" "$_tid" "$_iid" "$_sl" "cleanup" "cleanup_archived" "ok" "" "" \
          "$(jq -cn --arg dir "$archive_dir" '{meta:{archiveDir:$dir}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
        # Also copy the updated trace.jsonl (with the cleanup_archived event) to archive
        [[ -f "$feature_dir/trace.jsonl" ]] && cp "$feature_dir/trace.jsonl" "$archive_dir/trace.jsonl" 2>/dev/null || true
      fi
    fi
  fi

  # Count archived files for logging
  local count
  count=$(find "$archive_dir" -type f 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -gt 0 ]]; then
    log "debug" "Archived $count stage artifact(s) to .wavemill/evals/artifacts/$issue/"
  fi
}

cleanup_completed_task() {
  local issue="$1"
  local slug="$2"
  local completion_reason="${3:-}"
  local win="$issue-$slug"
  local target=""
  local target_gone="false"

  # Archive stage artifacts before removing worktree (for eval judge attribution)
  archive_stage_artifacts "$issue" "$slug"

  # Kill tmux window only when the target is confirmed gone afterward.
  target="$(_tmux_task_window_target "$SESSION" "$issue" "$slug" "${STATE_FILE:-}" "${WORKTREE_ROOT}/${slug}" 2>/dev/null || true)"
  if [[ -z "$target" ]] || ! command -v tmux >/dev/null 2>&1; then
    target_gone="true"
  else
    tmux kill-window -t "$(_tmux_target_join "$SESSION" "$target")" 2>/dev/null || true
    if ! _tmux_window_target_exists "$SESSION" "$target"; then
      target_gone="true"
    fi
  fi

  if [[ "$target_gone" != "true" ]]; then
    set_window_attention_state "$win" "needs-user"
    log_warn "  $issue cleanup could not close tmux window; keeping task state"
    return 1
  fi

  log "debug" "Closed window: $win"

  # Remove worktree
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  if [[ -d "$wt_dir" ]]; then
    git -C "$REPO_DIR" worktree remove "$wt_dir" --force >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
    log "debug" "Removed worktree: $wt_dir"
  fi

  # Delete branch after removing the worktree so Git can detach cleanly first.
  local task_branch="task/${slug}"
  if [[ "$task_branch" == "main" || "$task_branch" == "master" ]]; then
    log_warn "  Refusing to delete protected branch: $task_branch"
  elif git -C "$REPO_DIR" show-ref --verify --quiet "refs/heads/$task_branch" 2>/dev/null; then
    if git -C "$REPO_DIR" branch -D "$task_branch" >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null; then
      log "debug" "Deleted local branch: $task_branch"
    else
      log_warn "  Local branch cleanup failed after worktree removal: $task_branch"
    fi
  fi

  # Clean up state
  git -C "$REPO_DIR" worktree prune >>"${MILL_LOG_FILE:-/dev/null}" 2>/dev/null || true
  rm -f "/tmp/wavemill-${SESSION}-${issue}.hook" 2>/dev/null || true
  remove_task_state "$issue"
  CLEANED["$issue"]=1

  # Log completion with optional reason
  if [[ -n "$completion_reason" ]]; then
    log "$issue: Complete ($completion_reason)"
  else
    log "$issue: Complete"
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

inject_depends_on_pr_block() {
  local issue="${1:-}" pr_number="${2:-}" meta_json="${3:-}"
  if [[ -z "$issue" || -z "$pr_number" || -z "$meta_json" ]]; then
    echo "Usage: inject_depends_on_pr_block <issue> <pr_number> <meta_json>" >&2
    return 1
  fi

  local current_body
  if ! current_body=$(_with_timeout "$API_TIMEOUT" gh pr view "$pr_number" --json body --jq '.body // ""' 2>/dev/null); then
    log_warn "$issue: could not read PR #$pr_number body for depends_on metadata"
    return 0
  fi
  if [[ "$current_body" == *"depends_on:"* ]]; then
    return 0
  fi

  local depends_block
  depends_block=$(jq -r '
    "depends_on:\n" +
    "  - pr: \"#" + (.number | tostring) + "\"\n" +
    "    issue: \"" + .parent_issue + "\"\n" +
    "    branch: \"" + .branch + "\"\n" +
    "    url: \"" + .url + "\""
  ' <<<"$meta_json" 2>/dev/null) || {
    log_warn "$issue: could not build depends_on metadata block for PR #$pr_number"
    return 0
  }

  local new_body="$depends_block"
  if [[ -n "$current_body" ]]; then
    new_body+=$'\n\n'"$current_body"
  fi

  if ! _with_timeout "$API_TIMEOUT" gh pr edit "$pr_number" --body "$new_body" >/dev/null 2>&1; then
    log_warn "$issue: could not update PR #$pr_number with depends_on metadata"
  fi
}

dispatch_queued_children_for_parent() {
  local parent_issue="${1:-}" parent_pr_number="${2:-}"
  if [[ -z "$parent_issue" || -z "$parent_pr_number" ]]; then
    echo "Usage: dispatch_queued_children_for_parent <parent_issue> <pr_number>" >&2
    return 1
  fi

  local children_json
  children_json=$(find_queued_children_for_parent "$parent_issue") || return 1
  [[ "$children_json" == "[]" ]] && return 0

  local parent_branch="" resolved_pr_number="" parent_pr_url="" resolve_reason=""
  local resolve_err
  resolve_err=$(mktemp) || return 1
  if IFS='|' read -r parent_branch resolved_pr_number parent_pr_url < <(resolve_parent_pr_branch "$parent_pr_number" 2>"$resolve_err"); then
    :
  else
    resolve_reason=$(tr '\n' ' ' <"$resolve_err" | sed 's/[[:space:]]\+/ /g; s/^ //; s/ $//')
  fi
  rm -f "$resolve_err"

  local child_issue child_slug child_title entry
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    child_issue=$(jq -r '.issue_id' <<<"$entry")
    child_slug=$(jq -r '.slug // ""' <<<"$entry")
    child_title=$(jq -r '.title // ""' <<<"$entry")

    if [[ -z "$child_slug" ]]; then
      child_slug="${child_issue,,}"
    fi
    if [[ -z "$child_title" ]]; then
      child_title="$child_issue"
    fi

    if [[ -n "$parent_branch" ]]; then
      record_depends_on_metadata "$child_issue" "$resolved_pr_number" "$parent_pr_url" "$parent_branch" "$parent_issue" || {
        log_warn "$child_issue: failed to record depends_on metadata"
        continue
      }
      queue_remove_task "$child_issue" || {
        log_warn "$child_issue: failed to remove queued dependency entry"
        continue
      }

      BRANCH_BY_ISSUE["$child_issue"]="task/${child_slug}"
      SLUG_BY_ISSUE["$child_issue"]="$child_slug"

      if ! launch_task "$child_issue" "$child_slug" "$child_title" 1 "$parent_branch"; then
        log_warn "$child_issue: failed to launch from parent PR branch $parent_branch"
      fi
    else
      local reason="parent_pr_branch_unresolvable: ${resolve_reason:-unknown error}"
      queue_mark_waiting "$child_issue" "$reason" || log_warn "$child_issue: failed to mark queued dependency waiting"
      log_warn "$child_issue -> queued waiting: $reason"
    fi
  done < <(jq -c '.[]' <<<"$children_json")
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
  REROUTE_EXPANDED_LAST_REASON=""

  if [[ ! -f "$route_batch_tool" ]]; then
    REROUTE_EXPANDED_LAST_REASON="disabled"
    return 1
  fi

  input_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-input.jsonl"
  output_file="/tmp/${SESSION}-${current_issue}-expanded-reroute-output.jsonl"
  stderr_file="/tmp/${SESSION}-${current_issue}-expanded-reroute.stderr"
  : > "$input_file"

  if ! append_expanded_reroute_input "$input_file" "$current_issue" "$current_slug" "$current_feature_dir"; then
    REROUTE_EXPANDED_LAST_REASON="not_eligible"
    rm -f "$input_file" "$output_file" "$stderr_file"
    return 1
  fi
  count=$((count + 1))

  if [[ -f "${STATE_FILE:-}" ]]; then
    local sibling_issue sibling_slug sibling_worktree sibling_feature_dir
    while IFS=$'\t' read -r sibling_issue sibling_slug sibling_worktree; do
      [[ -n "$sibling_issue" && -n "$sibling_slug" && -n "$sibling_worktree" ]] || continue
      [[ "$sibling_issue" == "$current_issue" ]] && continue

      sibling_feature_dir="$sibling_worktree/features/$sibling_slug"
      [[ -d "$sibling_feature_dir" ]] || continue
      [[ -f "$sibling_feature_dir/.post-expansion-route.json" ]] && continue
      [[ -f "$sibling_feature_dir/.coding-result.json" ]] && continue
      [[ -f "$sibling_feature_dir/.planning-result.json" ]] || continue
      if ! jq -e '.status == "completed"' "$sibling_feature_dir/.planning-result.json" >/dev/null 2>&1; then
        continue
      fi

      if append_expanded_reroute_input "$input_file" "$sibling_issue" "$sibling_slug" "$sibling_feature_dir"; then
        count=$((count + 1))
      fi
    done < <(jq -r '.tasks | to_entries[] | select(.key != "" and ((.value.slug // "") != "")) | [.key, (.value.slug // ""), (.value.worktree // "")] | @tsv' "$STATE_FILE" 2>/dev/null || true)
  fi

  [[ -n "${DEFAULT_MAX_COST_USD:-}" ]] && route_max_cost_args=(--max-cost "$DEFAULT_MAX_COST_USD")

  if ! _with_timeout "$API_TIMEOUT" npx tsx "$route_batch_tool" \
    --expanded-jsonl "$input_file" \
    --repo-dir "$REPO_DIR" \
    "${route_max_cost_args[@]}" >"$output_file" 2>"$stderr_file"; then
    REROUTE_EXPANDED_LAST_REASON="routing_error"
    replay_route_transparency_logs "$stderr_file"
    if [[ -f "$current_feature_dir/.post-expansion-route.json" ]]; then
      REROUTE_EXPANDED_LAST_REASON="routing_error_using_existing_artifact"
      log_route_lifecycle "expansion_skipped" \
        "issue=$current_issue" \
        "reason=routing_error_using_existing_artifact" \
        "active_route=\"$(route_lifecycle_route_id "$current_feature_dir/.routing-complete" 2>/dev/null || true)\""
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

handle_expanded_reroute_handoff_failure() {
  local issue="$1" feature_dir="$2"
  local reason="${REROUTE_EXPANDED_LAST_REASON:-routing_error}"
  local active_route
  active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"

  case "$reason" in
    disabled|not_eligible)
      log_route_lifecycle "expansion_skipped" \
        "issue=$issue" \
        "reason=$reason" \
        "active_route=\"$active_route\""
      log "info" "$issue → expanded reroute skipped ($reason), attempting promotion from existing artifacts"
      ;;
    *)
      log_route_lifecycle "expansion_failed" \
        "issue=$issue" \
        "reason=$reason" \
        "active_route=\"$active_route\""
      log_warn "$issue → expanded reroute helper failed, attempting promotion from existing artifacts"
      ;;
  esac
}

recover_missing_expansion_artifact() {
  local issue="$1" slug="$2" feature_dir="$3"
  local expand_tool="$TOOLS_DIR/expand-issue.ts"
  local packet_file="$feature_dir/task-packet.md"
  local route_file="$feature_dir/.post-expansion-route.json"
  local recovery_log_dir="$REPO_DIR/.wavemill/logs"
  local recovery_log_file="$recovery_log_dir/expansion-recovery-${issue}.log"
  local recovery_timeout="" recovery_issue=""
  local packet_content="" detail="" rc=0

  if expansion_recovery_already_attempted "$feature_dir"; then
    log "warn" "[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=$issue"
    return 1
  fi

  if ! expansion_recovery_mark_attempted "$feature_dir" "$issue" "missing"; then
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=failed-to-record-attempt"
    return 1
  fi

  mkdir -p "$recovery_log_dir"

  if [[ ! -f "$expand_tool" ]]; then
    detail="expand-tool-missing"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "127" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail"
    return 1
  fi

  if ! recovery_issue="$(expansion_recovery_resolve_issue_id "$issue")"; then
    detail="synthetic-challenger-linear-issue-id-missing-or-invalid"
    expansion_recovery_mark_result "$feature_dir" "$issue" "skipped" "$detail" "0" || true
    log "warn" "[expansion-handshake] RECOVERY_SKIPPED issue=$issue detail=$detail"
    return 1
  fi

  recovery_timeout="$(get_expansion_handshake_timeout_seconds "$REPO_DIR")"
  if _with_timeout "$recovery_timeout" npx tsx "$expand_tool" "$recovery_issue" --output "$packet_file" >"$recovery_log_file" 2>&1; then
    :
  else
    rc=$?
    if [[ "$rc" == "124" || "$rc" == "143" ]]; then
      detail="expand-issue-timed-out"
    else
      detail="expand-issue-exited-non-zero"
    fi
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "$rc" || true
    if [[ "$detail" == "expand-issue-timed-out" ]]; then
      log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail timeoutSeconds=$recovery_timeout exit=$rc log=\"$recovery_log_file\""
    else
      log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail exit=$rc log=\"$recovery_log_file\""
    fi
    return 1
  fi

  packet_content="$(cat "$packet_file" 2>/dev/null || echo "")"
  if [[ ! -s "$packet_file" ]] || ! is_task_packet "$packet_content"; then
    detail="expanded-task-packet-missing-or-invalid"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! reroute_expanded_packets_for_coding_handoff "$issue" "$slug" "$feature_dir"; then
    detail="expanded-reroute-${REROUTE_EXPANDED_LAST_REASON:-failed}"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if [[ ! -f "$route_file" ]]; then
    detail="expanded-route-artifact-missing-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    detail="expanded-route-invalid-json-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  if ! validate_expanded_route_artifact "$route_file"; then
    detail="expanded-route-missing-required-field-after-reroute"
    expansion_recovery_mark_result "$feature_dir" "$issue" "failed" "$detail" "1" || true
    log "warn" "[expansion-handshake] RECOVERY_FAILED issue=$issue detail=$detail log=\"$recovery_log_file\""
    return 1
  fi

  expansion_recovery_mark_result "$feature_dir" "$issue" "succeeded" "expanded-route-recovered" "0" || true
  log "info" "[expansion-handshake] RECOVERY_OK issue=$issue log=\"$recovery_log_file\""
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

refresh_backlog_cache() {
  local now
  now=$(date +%s)

  # Use cache if fresh enough
  if (( now - LAST_BACKLOG_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$BACKLOG_CACHE" ]]; then
    return 0
  fi

  local backlog_json
  backlog_json=$(_with_timeout 60 npx tsx "$TOOLS_DIR/list-backlog-json.ts" "$PROJECT_NAME" 2>/dev/null) || true

  if [[ -z "$backlog_json" ]] || [[ "$backlog_json" == "[]" ]]; then
    BACKLOG_CACHE=""
    BACKLOG_JSON_CACHE=""
    QUEUE_PLAN_CACHE=""
    LAST_QUEUE_PLAN_FETCH=0
    LAST_BACKLOG_FETCH=$now
    return 0
  fi

  BACKLOG_JSON_CACHE="$backlog_json"
  QUEUE_PLAN_CACHE=""
  LAST_QUEUE_PLAN_FETCH=0

  # Use shared scoring function from wavemill-common.sh (eliminates duplication)
  # Strip has_detailed_plan (field 6) to match pick_candidates() 6-field format:
  # identifier|slug|title|area|score|blocked_by_count
  local focus_milestones_json="[]"
  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    focus_milestones_json="$(wavemill_load_config "$REPO_DIR" | jq -c '.backlog.focusMilestones // []' 2>/dev/null || printf '[]')"
  fi
  BACKLOG_CACHE=$(score_and_rank_issues "$backlog_json" 30 "$focus_milestones_json" | awk -F'|' -v OFS='|' '{print $1,$2,$3,$4,$5,$7}')
  LAST_BACKLOG_FETCH=$now
  return 0
}

print_cached_candidates() {
  echo "$BACKLOG_CACHE"
}

# NOTE: cache mutation must run in the parent shell, not in $(...) subshells.
fetch_candidates() {
  refresh_backlog_cache || return
  print_cached_candidates
}

fetch_queue_plan() {
  local now plan_input queue_plan
  now=$(date +%s)
  [[ -n "${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}" ]] && : > "$FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE"

  if (( now - LAST_QUEUE_PLAN_FETCH < BACKLOG_CACHE_TTL )) && [[ -n "$QUEUE_PLAN_CACHE" ]]; then
    echo "$QUEUE_PLAN_CACHE"
    return 0
  fi

  [[ -n "$BACKLOG_JSON_CACHE" ]] || {
    record_fetch_queue_plan_failure "cache_empty" ""
    return 1
  }
  queue_plan=$(build_queue_plan_once "$BACKLOG_JSON_CACHE") || return 1

  QUEUE_PLAN_CACHE="$queue_plan"
  LAST_QUEUE_PLAN_FETCH=$now
  echo "$QUEUE_PLAN_CACHE"
}

# fetch_queue_plan runs in command substitution, so diagnostics use a caller-owned file.
record_fetch_queue_plan_failure() {
  local step="$1" stderr_text="${2-}" exit_code="${3:-1}" diagnostics_file="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
  [[ -n "$diagnostics_file" ]] || return 0

  local bounded
  if [[ -n "$stderr_text" ]]; then
    bounded="$(printf '%s' "$stderr_text" | sed -n '1,5p' | tr '\n' ' ' | head -c 512)"
    [[ -n "$bounded" ]] || bounded="(no stderr captured)"
  else
    bounded="(no stderr captured)"
  fi

  printf 'step=%s exit=%s stderr=%s\n' "$step" "$exit_code" "$bounded" > "$diagnostics_file" 2>/dev/null || true
}

log_fetch_queue_plan_failure() {
  local diagnostics_file="$1"
  [[ -s "$diagnostics_file" ]] || return 0

  local details step reason
  details="$(cat "$diagnostics_file" 2>/dev/null || true)"
  step="$(printf '%s' "$details" | sed -n 's/.*step=\([^ ]*\).*/\1/p')"
  reason="$(classify_queue_failure_reason "$step" "$details")"
  [[ -n "$details" ]] && log "debug" "[fetch_queue_plan] failed reason=$reason $details"
}

classify_queue_failure_reason() {
  local step="$1" details="${2:-}" lowered
  case "$step" in
    cache_empty|empty_queue)   echo "empty_queue" ;;
    jq_massage_failed)         echo "invalid_input" ;;
    plan_queue_failed)
      lowered="$(printf '%s' "$details" | tr '[:upper:]' '[:lower:]')"
      if [[ "$lowered" == *cache* || "$lowered" == *refresh* ]]; then
        echo "cache_refresh_failed"
      else
        echo "dependency_planning_failed"
      fi
      ;;
    validation_failed)         echo "invalid_input" ;;
    *)                         echo "unknown" ;;
  esac
}

get_queue_failure_reason() {
  local diagnostics_file="${1:-}" details step
  [[ -s "$diagnostics_file" ]] || { echo "unknown"; return 0; }
  details="$(cat "$diagnostics_file" 2>/dev/null || true)"
  step="$(printf '%s' "$details" | sed -n 's/.*step=\([^ ]*\).*/\1/p')"
  classify_queue_failure_reason "$step" "$details"
}

build_queue_plan_once() {
  local backlog_json="$1"
  local plan_input queue_plan tmp_stderr stderr_text cache_key

  tmp_stderr="$(mktemp -t wavemill-fqp-stderr.XXXXXX)" || {
    record_fetch_queue_plan_failure "diagnostics_setup_failed" "mktemp failed"
    return 1
  }

  plan_input=$(jq -c '
    map({
      id: .identifier,
      title: .title,
      description: .description,
      labels: ((.labels.nodes // []) | map(.name) | sort),
      priority: (.priority // null),
      priorityLabel: (.priorityLabel // null),
      estimate: (.estimate // null),
      state: (.state.name // null),
      dueDate: (.dueDate // null),
      projectMilestone: (.projectMilestone // null),
      blocks: (
        (.relations.nodes // [])
        | map(select(.type == "blocks" and .relatedIssue.identifier != null and .relatedIssue.completedAt == null and .relatedIssue.canceledAt == null) | .relatedIssue.identifier)
        | sort
      ),
      sharedSurface: ((.sharedSurface // []) | sort),
      dependsOn: (
        (.inverseRelations.nodes // [])
        | map(select(.type == "blocks" and .issue.identifier != null and .issue.completedAt == null and .issue.canceledAt == null) | .issue.identifier)
        | sort
      )
    })
  ' <<<"$backlog_json" 2>"$tmp_stderr") || {
    stderr_text="$(cat "$tmp_stderr" 2>/dev/null || true)"
    rm -f "$tmp_stderr"
    record_fetch_queue_plan_failure "jq_massage_failed" "$stderr_text"
    return 1
  }

  : > "$tmp_stderr"
  if [[ -n "${PROJECT_NAME:-}" ]]; then
    cache_key="$PROJECT_NAME"
    queue_plan=$(printf '%s\n' "$plan_input" | _with_timeout 60 npx tsx "$TOOLS_DIR/plan-queue.ts" --stdin --json --cache-key "$cache_key" --refresh-missing-cache 2>"$tmp_stderr") || {
      local exit_code=$?
      stderr_text="$(cat "$tmp_stderr" 2>/dev/null || true)"
      rm -f "$tmp_stderr"
      record_fetch_queue_plan_failure "plan_queue_failed" "$stderr_text" "$exit_code"
      return 1
    }
  else
    queue_plan=$(printf '%s\n' "$plan_input" | _with_timeout 15 npx tsx "$TOOLS_DIR/plan-queue.ts" --stdin --json 2>"$tmp_stderr") || {
      local exit_code=$?
      stderr_text="$(cat "$tmp_stderr" 2>/dev/null || true)"
      rm -f "$tmp_stderr"
      record_fetch_queue_plan_failure "plan_queue_failed" "$stderr_text" "$exit_code"
      return 1
    }
  fi

  if [[ -z "${queue_plan//[[:space:]]/}" ]]; then
    rm -f "$tmp_stderr"
    record_fetch_queue_plan_failure "empty_queue" "" 0
    return 1
  fi

  : > "$tmp_stderr"
  jq -e 'has("availableNow")' >/dev/null 2>"$tmp_stderr" <<<"$queue_plan" || {
    local exit_code=$?
    stderr_text="$(cat "$tmp_stderr" 2>/dev/null || true)"
    rm -f "$tmp_stderr"
    record_fetch_queue_plan_failure "validation_failed" "$stderr_text" "$exit_code"
    return 1
  }

  rm -f "$tmp_stderr"
  echo "$queue_plan"
}

invoke_first_wave_helper() {
  local queue_plan="$1" candidates="$2" max_parallel="${3:-$MAX_PARALLEL}"
  [[ -z "$queue_plan" ]] && return 1

  local tasks_json input_json
  tasks_json=$(awk -F'|' 'NF >= 5 && $1 != "" {
    id = $1
    gsub(/"/, "\\\"", id)
    printf "{\"id\":\"%s\",\"score\":%s}\n", id, ($5 + 0)
  }' <<<"$candidates" | jq -s '.') || return 1

  input_json=$(jq -n \
    --argjson p "$queue_plan" \
    --argjson t "$tasks_json" \
    --argjson m "$max_parallel" \
    '{"plan": $p, "tasks": $t, "maxParallel": ($m | tonumber)}') || return 1

  printf '%s\n' "$input_json" | _with_timeout 10 npx tsx "$TOOLS_DIR/select-wave.ts" 2>/dev/null
}

BACKLOG_LAST_TIER=""
BACKLOG_DEFAULT_AVAILABLE_CAP=12

render_grouped_task_list() {
  local queue_plan="$1" available="$2" budget="${3:-999}" expanded="${4:-false}"
  local deps_expanded="${5:-false}" active_issue_ids="${6:-}"
  local counter=0 output="" select_lines="" section_body="" line rec group_index task_id blockers triage_id task_key
  local backlog_cap="${BACKLOG_DEFAULT_AVAILABLE_CAP:-12}"
  local tier=0 hidden_count=0 config_max="" indicator_label="expand"
  local deps_hidden_count=0 available_limit=0 queued_line_budget=0 max_queued_entries=0
  local -a available_entries=() queued_entries=() on_deck_queued=() off_deck_queued=()
  local available_section_lines=0 queued_section_lines=0 total_lines=0
  declare -A id_to_record=()
  declare -A rendered_ids=()
  declare -A on_deck_set=()

  jq -e . >/dev/null 2>&1 <<<"$queue_plan" || return 1

  if [[ -n "${REPO_DIR:-}" ]] && declare -F wavemill_load_config >/dev/null 2>&1; then
    backlog_cap="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.defaultAvailableNowCap // 12' 2>/dev/null || printf '12')"
    config_max="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.maxLines // empty' 2>/dev/null || true)"
  fi
  if ! [[ "$backlog_cap" =~ ^[0-9]+$ ]] || (( backlog_cap < 1 )); then
    backlog_cap=12
  fi
  if ! [[ "$budget" =~ ^[0-9]+$ ]]; then
    budget=999
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    task_id=${line%%|*}
    if [[ -n "$task_id" ]]; then
      id_to_record["$task_id"]="$line"
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      id_to_record["$task_key"]="$line"
    fi
  done <<<"$available"

  section_body=""
  while IFS= read -r task_id; do
    [[ -n "$task_id" ]] || continue
    task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    available_entries+=("$rec")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.availableNow[]?' <<<"$queue_plan" 2>/dev/null)

  section_body=""
  while IFS=$'\t' read -r task_id blockers; do
    [[ -n "$task_id" ]] || continue
    task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    queued_entries+=("${rec}"$'\t'"$blockers")
    rendered_ids["$task_key"]=1
  done < <(jq -r '.queuedAfterDependencies[]? | [.taskId, (.ancestors | join(", "))] | @tsv' <<<"$queue_plan" 2>/dev/null)

  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    local avail_id="${line%%|*}"
    [[ -n "$avail_id" ]] && on_deck_set["$(printf '%s' "$avail_id" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$available"
  while IFS= read -r line; do
    [[ -n "$line" ]] || continue
    on_deck_set["$(printf '%s' "$line" | tr '[:lower:]' '[:upper:]')"]=1
  done <<<"$active_issue_ids"

  for line in "${queued_entries[@]}"; do
    IFS=$'\t' read -r rec blockers <<<"$line"
    local is_on_deck=true blocker bkey
    if [[ -z "$blockers" ]]; then
      is_on_deck=true
    else
      while IFS= read -r blocker; do
        [[ -n "$blocker" ]] || continue
        bkey="$(printf '%s' "${blocker// /}" | tr '[:lower:]' '[:upper:]')"
        if [[ -z "${on_deck_set[$bkey]:-}" ]]; then
          is_on_deck=false
          break
        fi
      done < <(printf '%s\n' "$blockers" | tr ',' '\n')
    fi
    if [[ "$is_on_deck" == "true" ]]; then
      on_deck_queued+=("$line")
    else
      off_deck_queued+=("$line")
    fi
  done
  deps_hidden_count=${#off_deck_queued[@]}
  if [[ "$deps_expanded" == "true" ]]; then
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}" "${off_deck_queued[@]+"${off_deck_queued[@]}"}")
  else
    queued_entries=("${on_deck_queued[@]+"${on_deck_queued[@]}"}")
  fi

  if (( ${#available_entries[@]} > 1 )); then
    local -a sorted_available_entries=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_available_entries+=("$rec")
    done < <(printf '%s\n' "${available_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    available_entries=("${sorted_available_entries[@]}")
  fi
  if (( ${#queued_entries[@]} > 1 )); then
    local -a sorted_queued_entries=()
    while IFS= read -r rec; do
      [[ -n "$rec" ]] && sorted_queued_entries+=("$rec")
    done < <(printf '%s\n' "${queued_entries[@]}" | sort -t'|' -k5,5nr -k1,1)
    queued_entries=("${sorted_queued_entries[@]}")
  fi

  available_section_lines=0
  if (( ${#available_entries[@]} > 0 )); then
    available_section_lines=$((1 + ${#available_entries[@]}))
  fi
  queued_section_lines=0
  if (( ${#queued_entries[@]} > 0 )); then
    queued_section_lines=$((2 + ${#queued_entries[@]} * 2))
  fi
  total_lines=$((available_section_lines + queued_section_lines))

  if [[ "$expanded" != "true" ]] && (( total_lines > budget )); then
    if (( ${#queued_entries[@]} > 0 )); then
      queued_line_budget=$((budget - available_section_lines - 2))
      max_queued_entries=$((queued_line_budget / 2))
      if (( max_queued_entries > 0 )); then
        tier=1
        if (( max_queued_entries < ${#queued_entries[@]} )); then
          hidden_count=$((hidden_count + ${#queued_entries[@]} - max_queued_entries))
          queued_entries=("${queued_entries[@]:0:max_queued_entries}")
        else
          tier=0
        fi
      else
        hidden_count=$((hidden_count + ${#queued_entries[@]}))
        queued_entries=()
        tier=2
      fi
    fi

    if (( available_section_lines > budget )); then
      tier=3
      hidden_count=$((hidden_count + ${#queued_entries[@]}))
      queued_entries=()
      local min_visible=$((budget - 1))
      (( min_visible < 10 )) && min_visible=10
      available_limit=$min_visible
      if (( backlog_cap < available_limit )); then
        available_limit=$backlog_cap
      fi
      if (( available_limit > budget - 1 )); then
        available_limit=$((budget - 1))
      fi
      if (( ${#available_entries[@]} > available_limit )); then
        hidden_count=$((hidden_count + ${#available_entries[@]} - available_limit))
        available_entries=("${available_entries[@]:0:available_limit}")
      fi
    fi
  fi

  if (( ${#available_entries[@]} > 0 )); then
    output+="Available Now - Parallel Wave 1"$'\n'
    for rec in "${available_entries[@]}"; do
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      select_lines+="${rec}"$'\n'
    done
  fi

  if (( ${#queued_entries[@]} > 0 )); then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Queued After Dependencies"$'\n'
    for line in "${queued_entries[@]}"; do
      IFS=$'\t' read -r rec blockers <<<"$line"
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      output+="$(printf '  %s. %s - %s (blocked by: %s)' "$counter" "$task_id" "$title" "$blockers")"$'\n'
      select_lines+="${rec}"$'\n'
    done
    if [[ "$deps_expanded" != "true" ]] && (( deps_hidden_count > 0 )); then
      output+="$(printf '  +%s hidden - d to expand' "$deps_hidden_count")"$'\n'
    elif [[ "$deps_expanded" == "true" ]] && (( deps_hidden_count > 0 )); then
      output+="  (d to collapse)"$'\n'
    fi
  fi

  section_body=""
  group_index=0
  while IFS= read -r blockers; do
    [[ -n "$blockers" ]] || continue
    group_index=$((group_index + 1))
    local cluster_body=""
    while IFS= read -r task_id; do
      [[ -n "$task_id" ]] || continue
      task_key="$(printf '%s' "$task_id" | tr '[:lower:]' '[:upper:]')"
      [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
      rec="${id_to_record[$task_id]:-${id_to_record[$task_key]:-}}"
      [[ -n "$rec" ]] || continue
      IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
      counter=$((counter + 1))
      cluster_body+="$(printf '    %s. %s - %s' "$counter" "$task_id" "$title")"$'\n'
      select_lines+="${rec}"$'\n'
      rendered_ids["$task_key"]=1
    done < <(jq -r '.[]' <<<"$blockers" 2>/dev/null)
    if [[ -n "$cluster_body" ]]; then
      section_body+="$(printf '  [conflict cluster %s]' "$group_index")"$'\n'
      section_body+="$cluster_body"
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
    task_key="$(printf '%s' "$triage_id" | tr '[:lower:]' '[:upper:]')"
    [[ -n "${rendered_ids[$task_key]:-}" ]] && continue
    rec="${id_to_record[$triage_id]:-${id_to_record[$task_key]:-}}"
    [[ -n "$rec" ]] || continue
    IFS='|' read -r task_id _slug title _area _score _blocked <<<"$rec"
    counter=$((counter + 1))
    section_body+="$(printf '  %s. %s - %s [triage]' "$counter" "$task_id" "$title")"$'\n'
    select_lines+="${rec}"$'\n'
    rendered_ids["$task_key"]=1
  done < <(jq -r '.needsTriage[]? | .edge.to' <<<"$queue_plan" 2>/dev/null)
  if [[ -n "$section_body" ]]; then
    [[ -n "$output" ]] && output+=$'\n'
    output+="Needs Triage"$'\n'
    output+="${section_body}"
  fi

  if [[ "$expanded" != "true" ]] && (( tier > 0 )) && (( hidden_count > 0 )); then
    output+="$(printf '... %s tasks hidden (m to expand)' "$hidden_count")"$'\n'
  elif [[ "$expanded" == "true" ]] && (( total_lines > budget )); then
    output+="(m to collapse)"$'\n'
    indicator_label="collapse"
  fi

  (( counter > 0 )) || return 1

  if [[ "$tier" != "${BACKLOG_LAST_TIER:-}" ]] && declare -F log >/dev/null 2>&1; then
    local backlog_annotation=" (backlog.maxLines=${config_max:-auto})"
    if declare -F wavemill_config_annotation >/dev/null 2>&1; then
      backlog_annotation="$(wavemill_config_annotation "backlog.maxLines" "${config_max:-auto}")"
    fi
    log "info" "[backlog] tier=$tier budget=$budget${backlog_annotation}"
    BACKLOG_LAST_TIER="$tier"
  fi

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
  local issue="$1" slug="$2" title="$3" remaining_slots="${4:-1}" override_base="${5:-}"
  local branch="task/${slug}"
  local wt_dir="${WORKTREE_ROOT}/${slug}"
  local feature_dir="${wt_dir}/features/${slug}"
  local linear_issue="$issue"
  local challenge_model=""
  local effective_base="${override_base:-$BASE_BRANCH}"
  LAST_LAUNCHED_SLOTS=1

  linear_issue=$(get_linear_issue_id "$issue")
  challenge_model=$(get_task_meta "$issue" "challengeModel")

  log "status" "$issue: Launching - $title"

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

  # Task packet handling — write title plus raw description (agent will expand in-pane)
  local packet_file="/tmp/${SESSION}-${issue}-taskpacket.md"
  if [[ -f "$packet_file" ]]; then
    :
  else
    if is_task_packet "$issue_desc"; then
      log "info" "$issue has task packet"
      printf '%s\n' "$issue_desc" > "$packet_file"
    else
      log "info" "$issue title and raw description saved (agent will expand)"
      if [[ -n "$issue_desc" ]]; then
        printf '%s\n\n%s\n' "$title" "$issue_desc" > "$packet_file"
      else
        printf '%s\n' "$title" > "$packet_file"
      fi
    fi
  fi
  local packet_content
  packet_content=$(cat "$packet_file" 2>/dev/null || echo "")

  # Refresh base branch on a TTL so repeated dynamic launches avoid redundant fetches.
  wavemill_fetch_base_branch "$effective_base" 2>/dev/null || true

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
    local requested_wt_dir="$wt_dir"
    local resolved_path
    resolved_path="$(ensure_worktree "$branch" "$wt_dir" "$REPO_DIR" 2>>"$MILL_LOG_FILE")" || {
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    }
    wt_dir="$resolved_path"
    if [[ "$wt_dir" == "$requested_wt_dir" ]]; then
      created_new=true
    fi
  else
    log "info" "  Creating branch $branch from origin/$effective_base"
    if ! git -C "$REPO_DIR" worktree add "$wt_dir" -b "$branch" "origin/$effective_base" >>"$MILL_LOG_FILE" 2>&1; then
      log_error "$issue: worktree add failed (log: $MILL_LOG_FILE)"
      return 1
    fi
    created_new=true
  fi
  mkdir -p "$feature_dir"

  # ── Trace correlation (HOK-2259) — resolve or create stable traceId ──
  local _trace_id
  _trace_id=$(trace_get_or_create "$feature_dir" "$issue" "$slug" 2>/dev/null || true)

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
    # Read stored routing for this challenge entry
    planner_model=$(get_task_meta "$issue" "plannerModel")
    reviewer_model=$(get_task_meta "$issue" "reviewerModel")
    plan_depth=$(get_task_meta "$issue" "planDepth")
    code_depth=$(get_task_meta "$issue" "codeDepth")
    review_mode=$(get_task_meta "$issue" "reviewMode")
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if agent_resolve_models_for_roles "${planner_model:-$task_model}" "$task_model" "${reviewer_model:-$task_model}"; then
        :
      fi
      planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
      reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding" || true)"
      planner_agent="$(agent_resolve_from_model "${planner_model:-$task_model}" "planning" || true)"
      reviewer_agent="$(agent_resolve_from_model "${reviewer_model:-$task_model}" "review" || true)"
    fi
    log "info" "  Challenge: $task_agent_cmd --model $task_model (planner=$planner_model, reviewer=$reviewer_model)"
  elif [[ -n "${FORCE_MODEL:-}" ]]; then
    # Validate model (should have been validated earlier, but double-check)
    if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
      log_error "  Invalid FORCE_MODEL for $issue: $FORCE_MODEL"
      log_error "  Skipping this task."
      continue
    fi
    task_model="$FORCE_MODEL"
    task_agent_cmd="$(agent_resolve_from_model "$FORCE_MODEL" "coding" || true)"
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
        log "info" "  Workflow route cache hit from batch cache"
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
          log "info" "  Workflow route cache hit from batch cache"
        else
          route_source="startup-cache"
          log "info" "  Workflow route cache hit from startup cache"
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
          log "info" "  Workflow route selected via heuristic fallback"
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
        if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
          if agent_resolve_models_for_roles "$planner_model" "$task_model" "$reviewer_model"; then
            :
          fi
          planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
          task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
          reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
        else
          if [[ -n "$planner_model" ]]; then
            planner_agent="$(agent_resolve_from_model "$planner_model" "planning" || true)"
          fi
          if [[ -n "$task_model" ]]; then
            task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding" || true)"
          fi
          if [[ -n "$reviewer_model" ]]; then
            reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review" || true)"
          fi
        fi

        if [[ "$route_source" == "live" ]]; then
          log "info" "  $issue Route: planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "batch-cache" ]]; then
          log "info" "  $issue Route (from batch cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        elif [[ "$route_source" == "startup-cache" ]]; then
          log "info" "  $issue Route (from startup cache): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
        else
          log "info" "  $issue Route (heuristic fallback): planner=$planner_model ($plan_depth), coder=$task_model ($code_depth), reviewer=$reviewer_model ($review_mode)"
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
  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$task_agent_cmd"; then
      log_error "  Native coder route is not launchable: agent=$task_agent_cmd model=$task_model"
      return 1
    fi
    log_warn "  Agent '$task_agent_cmd' not found, falling back to '$AGENT_CMD'"
    task_agent_cmd="$AGENT_CMD"
    task_model=""
  fi

  # Validate planner and reviewer agents if they were set
  if [[ -n "$planner_agent" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$planner_agent"; then
      log_error "  Native planner route is not launchable: agent=$planner_agent model=$planner_model"
      return 1
    fi
    log_warn "  Planner agent '$planner_agent' not found, using coder agent"
    planner_agent="$task_agent_cmd"
    planner_model="$task_model"
  fi
  if [[ -n "$reviewer_agent" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    if agent_is_native_cmd "$reviewer_agent"; then
      log_error "  Native reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
      return 1
    fi
    log_warn "  Reviewer agent '$reviewer_agent' not found, using coder agent"
    reviewer_agent="$task_agent_cmd"
    reviewer_model="$task_model"
  fi

  if [[ -z "${WAVEMILL_DISABLE_CHALLENGE:-}" ]] && should_update_linear_state "$issue" && (( remaining_slots >= 1 )); then
    local challenge_args challenge_plan challenge_mode challenge_reason challenge_stage primary_varied challenger_varied
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
      if [[ -d "${WORKTREE_ROOT}/${slug}/features/${slug}" ]]; then
        challenge_args+=(--feature-dir "${WORKTREE_ROOT}/${slug}/features/${slug}")
      fi
      challenge_plan=$(_with_timeout "$API_TIMEOUT" npx tsx "$TOOLS_DIR/resolve-challenge-task.ts" "${challenge_args[@]}" 2>/dev/null || echo "")
      challenge_mode=$(echo "$challenge_plan" | jq -r '.mode // "single"' 2>/dev/null || echo "single")
      challenge_reason=$(echo "$challenge_plan" | jq -r '.reason // empty' 2>/dev/null || echo "")
    fi
    if [[ "$challenge_mode" == "challenge" ]]; then
      challenge_enabled_for_launch="true"
      challenge_pair="$issue"
      challenge_stage=$(echo "$challenge_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
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

      should_launch_challenger="true"
      LAST_LAUNCHED_SLOTS=1  # Challenger is free overhead, doesn't consume a slot
      primary_varied=$(echo "$challenge_plan" | jq -r '.entries[0].variedModel // .entries[0].model // empty' 2>/dev/null)
      challenger_varied=$(echo "$challenge_plan" | jq -r '.entries[1].variedModel // .entries[1].model // empty' 2>/dev/null)
      log "status" "  Challenge selected (stage=${challenge_stage}: ${primary_varied} vs ${challenger_varied}) [challenger is extra pane]"
    elif [[ -n "$challenge_reason" ]] && [[ "$challenge_reason" != "challenge_disabled" ]] && [[ "$challenge_reason" != "roll_not_selected" ]]; then
      log "debug" "  Challenge skipped ($challenge_reason), launching single-model run"
    fi
  fi

  if [[ -z "${FORCE_MODEL:-}" ]]; then
    [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && planner_model="$WAVEMILL_PLANNER_MODEL"
    [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && task_model="$WAVEMILL_CODER_MODEL"
    [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
  fi

  if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
    if ! agent_resolve_models_for_roles "$planner_model" "$task_model" "$reviewer_model"; then
      log_error "  Selected route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
      return 1
    fi
    planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
    task_agent_cmd="$(agent_resolve_batch_agent_for_role "coder")"
    reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
  else
    if [[ -n "$planner_model" ]]; then
      if ! planner_agent="$(agent_resolve_from_model "$planner_model" "planning")"; then
        log_error "  Selected planner route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
    fi
    if [[ -n "$task_model" ]]; then
      if ! task_agent_cmd="$(agent_resolve_from_model "$task_model" "coding")"; then
        log_error "  Selected coder route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
    fi
    if [[ -n "$reviewer_model" ]]; then
      if ! reviewer_agent="$(agent_resolve_from_model "$reviewer_model" "review")"; then
        log_error "  Selected reviewer route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
    fi
  fi

  if [[ -n "$planner_model" && -z "$planner_agent" ]]; then
    log_error "  Selected planner route is not launchable: agent resolution returned empty for model=$planner_model"
    return 1
  fi
  if [[ -n "$task_model" && -z "$task_agent_cmd" ]]; then
    log_error "  Selected coder route is not launchable: agent resolution returned empty for model=$task_model"
    return 1
  fi
  if [[ -n "$reviewer_model" && -z "$reviewer_agent" ]]; then
    log_error "  Selected reviewer route is not launchable: agent resolution returned empty for model=$reviewer_model"
    return 1
  fi

  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    log_error "  Selected coder route is not launchable: agent=$task_agent_cmd model=$task_model"
    return 1
  fi
  if [[ -n "$planner_model" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    log_error "  Selected planner route is not launchable: agent=$planner_agent model=$planner_model"
    return 1
  fi
  if [[ -n "$reviewer_model" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    log_error "  Selected reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
    return 1
  fi

  local challenger_planner_agent="" challenger_reviewer_agent=""
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if ! agent_resolve_models_for_roles "$challenger_planner" "$challenger_model" "$challenger_reviewer"; then
        log_error "  Selected challenger route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
      challenger_planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      challenger_agent="$(agent_resolve_batch_agent_for_role "coder")"
      challenger_reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      if [[ -n "$challenger_planner" ]] && ! challenger_planner_agent="$(agent_resolve_from_model "$challenger_planner" "planning")"; then
        log_error "  Selected challenger planner route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
      if [[ -n "$challenger_model" ]] && ! challenger_agent="$(agent_resolve_from_model "$challenger_model" "coding")"; then
        log_error "  Selected challenger coder route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
      if [[ -n "$challenger_reviewer" ]] && ! challenger_reviewer_agent="$(agent_resolve_from_model "$challenger_reviewer" "review")"; then
        log_error "  Selected challenger reviewer route is not launchable: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
        return 1
      fi
    fi

    if [[ -n "$challenger_planner" && -z "$challenger_planner_agent" ]]; then
      log_error "  Selected challenger planner route is not launchable: agent resolution returned empty for model=$challenger_planner"
      return 1
    fi
    if [[ -n "$challenger_model" && -z "$challenger_agent" ]]; then
      log_error "  Selected challenger coder route is not launchable: agent resolution returned empty for model=$challenger_model"
      return 1
    fi
    if [[ -n "$challenger_reviewer" && -z "$challenger_reviewer_agent" ]]; then
      log_error "  Selected challenger reviewer route is not launchable: agent resolution returned empty for model=$challenger_reviewer"
      return 1
    fi

    if ! agent_validate_phase_launch "$challenger_agent" "coding" "$challenger_model" "$REPO_DIR"; then
      log_error "  Selected challenger coder route is not launchable: agent=$challenger_agent model=$challenger_model"
      return 1
    fi
    if [[ -n "$challenger_planner_agent" ]] && ! agent_validate_phase_launch "$challenger_planner_agent" "planning" "$challenger_planner" "$REPO_DIR"; then
      log_error "  Selected challenger planner route is not launchable: agent=$challenger_planner_agent model=$challenger_planner"
      return 1
    fi
    if [[ -n "$challenger_reviewer_agent" ]] && ! agent_validate_phase_launch "$challenger_reviewer_agent" "review" "$challenger_reviewer" "$REPO_DIR"; then
      log_error "  Selected challenger reviewer route is not launchable: agent=$challenger_reviewer_agent model=$challenger_reviewer"
      return 1
    fi
  fi

  if ! agent_validate_phase_launch "$task_agent_cmd" "coding" "$task_model" "$REPO_DIR"; then
    log_error "  Selected coder route is not launchable: agent=$task_agent_cmd model=$task_model"
    return 1
  fi
  if [[ -n "$planner_agent" ]] && ! agent_validate_phase_launch "$planner_agent" "planning" "$planner_model" "$REPO_DIR"; then
    log_error "  Selected planner route is not launchable: agent=$planner_agent model=$planner_model"
    return 1
  fi
  if [[ -n "$reviewer_agent" ]] && ! agent_validate_phase_launch "$reviewer_agent" "review" "$reviewer_model" "$REPO_DIR"; then
    log_error "  Selected reviewer route is not launchable: agent=$reviewer_agent model=$reviewer_model"
    return 1
  fi

  local challenger_planner_agent="" challenger_reviewer_agent=""
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    if declare -F agent_resolve_models_for_roles >/dev/null 2>&1; then
      if agent_resolve_models_for_roles "$challenger_planner" "$challenger_model" "$challenger_reviewer"; then
        :
      fi
      challenger_planner_agent="$(agent_resolve_batch_agent_for_role "planner")"
      challenger_agent="$(agent_resolve_batch_agent_for_role "coder")"
      challenger_reviewer_agent="$(agent_resolve_batch_agent_for_role "reviewer")"
    else
      [[ -n "$challenger_planner" ]] && challenger_planner_agent="$(agent_resolve_from_model "$challenger_planner" "planning" || true)"
      [[ -n "$challenger_model" ]] && challenger_agent="$(agent_resolve_from_model "$challenger_model" "coding" || true)"
      [[ -n "$challenger_reviewer" ]] && challenger_reviewer_agent="$(agent_resolve_from_model "$challenger_reviewer" "review" || true)"
    fi

    if ! agent_validate_phase_launch "$challenger_agent" "coding" "$challenger_model" "$REPO_DIR"; then
      log_error "  Selected challenger coder route is not launchable: agent=$challenger_agent model=$challenger_model"
      return 1
    fi
    if [[ -n "$challenger_planner_agent" ]] && ! agent_validate_phase_launch "$challenger_planner_agent" "planning" "$challenger_planner" "$REPO_DIR"; then
      log_error "  Selected challenger planner route is not launchable: agent=$challenger_planner_agent model=$challenger_planner"
      return 1
    fi
    if [[ -n "$challenger_reviewer_agent" ]] && ! agent_validate_phase_launch "$challenger_reviewer_agent" "review" "$challenger_reviewer" "$REPO_DIR"; then
      log_error "  Selected challenger reviewer route is not launchable: agent=$challenger_reviewer_agent model=$challenger_reviewer"
      return 1
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
  save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "${planner_agent:-$task_agent_cmd}" "$linear_issue" "$effective_challenge" "$challenge_pair" "${challenge_role:-}" "$task_model" "$planner_model" "$task_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "${challenge_stage:-}"
  if [[ "$challenge_enabled_for_launch" == "true" ]]; then
    save_task_state "$challenger_key" "$challenger_slug" "task/${challenger_slug}" "${WORKTREE_ROOT}/${challenger_slug}" "" "" "${challenger_planner_agent:-$challenger_agent}" "$linear_issue" "true" "$challenge_pair" "challenger" "$challenger_model" "$challenger_planner" "$challenger_model" "$challenger_reviewer" "$challenger_plan_depth" "$challenger_code_depth" "$challenger_review_mode" "$challenge_stage"
    state_mutate "$STATE_FILE" '.tasks[$issue].challengeStage = $stage' --arg issue "$challenger_key" --arg stage "$challenge_stage" || true
  fi
  if [[ -n "${challenge_stage:-}" ]]; then
    state_mutate "$STATE_FILE" '.tasks[$issue].challengeStage = $stage' --arg issue "$issue" --arg stage "$challenge_stage" || true
  fi
  set_task_phase "$issue" "$initial_phase"

  # Verify agent was saved correctly (helps debug future issues)
  if [[ "${DEBUG_AGENT:-}" == "1" ]]; then
    local saved_agent
    local expected_saved_agent="${planner_agent:-$task_agent_cmd}"
    saved_agent=$(jq -r --arg i "$issue" '.tasks[$i].agent // ""' "$STATE_FILE" 2>/dev/null)
    if [[ "$saved_agent" != "$expected_saved_agent" ]]; then
      log_warn "  ⚠ Agent save mismatch: expected='$expected_saved_agent' but got='$saved_agent'"
    else
      log "info" "Agent set to: $expected_saved_agent"
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
  local win_target
  tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir"
  win_target="$(tmux display-message -p -t "$SESSION:$win" '#{window_id}' 2>/dev/null || true)"
  [[ -n "$win_target" ]] || win_target="$win"
  persist_task_window_id "$issue" "$win_target"
  # Prevent window destruction if the pane shell exits (e.g. from a stray Ctrl-D).
  # This lets _pane_is_dead_or_idle detect and respawn dead panes during phase transitions.
  tmux set-option -t "$(_tmux_target_join "$SESSION" "$win_target")" remain-on-exit on 2>/dev/null || true
  set_window_attention_state "$win" "clear"

  # Run setup command in new worktrees (e.g., npm install)
  if [[ -n "${SETUP_CMD:-}" ]] && [[ "$created_new" == "true" ]]; then
    log "info" "  Running setup: $SETUP_CMD"
    local _sentinel="/tmp/.wavemill-setup-${issue//[^a-zA-Z0-9_-]/_}"
    rm -f "$_sentinel"
    tmux send-keys -t "$(_tmux_target_join "$SESSION" "$win_target")" \
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

  local startup_route_file="/tmp/${SESSION}-${issue}-route.json"
  if [[ -f "$startup_route_file" ]] && jq -e '.planner and .coder and .reviewer' "$startup_route_file" >/dev/null 2>&1; then
    jq \
      --arg planner "${planner_model:-claude-sonnet-5}" \
      --arg coder "${task_model:-claude-opus-4-7}" \
      --arg reviewer "${reviewer_model:-claude-sonnet-5}" \
      --arg planDepth "${plan_depth:-light}" \
      --arg codeDepth "${code_depth:-medium}" \
      --arg reviewMode "${review_mode:-static}" \
      --arg source "bootstrap" \
      --arg inputKind "issue" \
      --arg inputPath "features/$slug/selected-task.json" \
      --argjson maxCostUsd "${routing_max_cost_usd:-null}" \
      '(.provenance // {}) as $p
      | .planner = $planner
      | .coder = $coder
      | .reviewer = $reviewer
      | .planDepth = $planDepth
      | .codeDepth = $codeDepth
      | .reviewMode = $reviewMode
      | .reviewRecommended = $reviewMode
      | .provenance = ($p + {
          source: (if (($p.source // "") == "") then $source else $p.source end),
          inputKind: (if (($p.inputKind // "") == "") then $inputKind else $p.inputKind end),
          inputPath: (if (($p.inputPath // "") == "") then $inputPath else $p.inputPath end),
          inputHash: ($p.inputHash // ""),
          routedAt: (if (($p.routedAt // "") == "") then (now | todateiso8601) else $p.routedAt end),
          routerMode: (if (($p.routerMode // "") == "") then "normal" else $p.routerMode end)
        })
      | if $maxCostUsd == null
        then .
        else .maxCostUsd = $maxCostUsd | .constraints = ((.constraints // {}) + {maxCostUsd: $maxCostUsd})
        end' "$startup_route_file" \
      | write_json_artifact "$routing_file"
  else
    jq -n \
      --arg planner "${planner_model:-claude-sonnet-5}" \
      --arg coder "${task_model:-claude-opus-4-7}" \
      --arg reviewer "${reviewer_model:-claude-sonnet-5}" \
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
        },
        maxCostUsd: $maxCostUsd
      } + (if $maxCostUsd == null then {} else {constraints: {maxCostUsd: $maxCostUsd}} end)' \
      | write_json_artifact "$routing_file"
  fi

  # Save initial route for eval comparison (routed on raw description).
  # Always stamp source='bootstrap' regardless of what the batch router recorded,
  # so .initial-route.json remains unambiguous bootstrap evidence.
  if [[ -f "$feature_dir/.initial-route.json" ]]; then
    log "info" "  Keeping existing .initial-route.json for $issue"
  else
    jq '.provenance.source = "bootstrap"' "$routing_file" \
      | write_json_artifact "$feature_dir/.initial-route.json"
  fi
  local bootstrap_route
  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" ]]; then
    log_route_lifecycle "bootstrap_assigned" "issue=$issue" "route=\"$bootstrap_route\""
  fi

  # Emit task_launched trace event (best-effort)
  trace_append_event "$feature_dir" "$_trace_id" "$issue" "$slug" "launch" "task_launched" "ok" "" "$AGENT_CMD" \
    "$(jq -cn --arg agent "$AGENT_CMD" --arg coder "${task_model:-}" --arg planner "${planner_model:-}" \
      --arg reviewer "${reviewer_model:-}" --arg mode "${PLANNING_MODE:-}" \
      '{meta:{agentCmd:$agent,coderModel:$coder,plannerModel:$planner,reviewerModel:$reviewer,planningMode:$mode}}' 2>/dev/null || echo '{}')" 2>/dev/null || true

  # Emit route_assigned trace event (best-effort)
  if [[ -n "$bootstrap_route" ]]; then
    trace_append_event "$feature_dir" "$_trace_id" "$issue" "$slug" "launch" "route_assigned" "ok" "${task_model:-}" "$AGENT_CMD" \
      "$(jq -cn --arg rt "$bootstrap_route" --arg src "bootstrap" '{meta:{routeId:$rt,routeSource:$src}}' 2>/dev/null || echo '{}')" 2>/dev/null || true
  fi

  # Launch planning phase directly with the routed model (skip routing agent)
  local planner_launch_model resolved_planner_agent
  planner_launch_model="${planner_model:-claude-sonnet-5}"
  if declare -F agent_resolve_model >/dev/null 2>&1; then
    planner_launch_model="$(agent_resolve_model "planner" "${planner_model:-claude-sonnet-5}" "$REPO_DIR")" || return 1
  fi
  if ! resolved_planner_agent="$(agent_resolve_from_model "$planner_launch_model" "planning")"; then
    write_stage_result "$feature_dir" "planning" "failed" "" "$planner_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Planning launch blocked by agent resolution failure.}"
    set_task_phase "$issue" "routing"
    set_window_attention_state "$win" "needs-user"
    log "warn" "⚠ $issue → Planning launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
    return 0
  fi

  # Record planning stage as running before the first launch so the monitor
  # keeps the task active even before any planning artifacts exist.
  write_stage_result "$feature_dir" "planning" "running" "$resolved_planner_agent" "$planner_launch_model"

  launch_planning_phase "$issue" "$slug" "$title" "$wt_dir" "$branch" "$BASE_BRANCH" \
    "$planner_launch_model" "$resolved_planner_agent" "${plan_depth:-light}"
  local launch_rc=$?
  if ! handle_phase_launch_result "$issue" "$feature_dir" "planning" "routing" "$launch_rc" "$win" \
    "$resolved_planner_agent" "$planner_launch_model"; then
    return 0
  fi
  log "status" "$issue Routing complete (direct), launched planning with $planner_launch_model"

  log "status" "$issue launched (phase: ${initial_phase}, agent: ${resolved_planner_agent}${planner_launch_model:+ --model $planner_launch_model})"
  [[ -n "$planner_model" ]] && log "info" "$issue: Routing: planner=$planner_model, coder=$task_model, reviewer=$reviewer_model"

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
  log "status" "  Max parallel: $EFFECTIVE_MAX_PARALLEL (reduced from $MAX_PARALLEL - all models degraded)$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
else
  log "info" "  Max parallel: $MAX_PARALLEL$(wavemill_config_annotation "mill.maxParallel" "$MAX_PARALLEL")"
fi
log "info" "  Checking every ${POLL_SECONDS}s$(wavemill_config_annotation "mill.pollSeconds" "$POLL_SECONDS")"
log "info" "  Type 'q' to quit, or 'touch $STATE_DIR/.stop-loop' to stop"
printf '\033[1mTask Backlog\033[0m\n'

QUIT_REQUESTED=false
_active_count_prev=0
LAST_DISPLAY=""       # fingerprint of what was last printed
LAST_ACTIVE_COUNT=-1  # force first render
LAST_WAITING_MSG=""   # track last waiting message to avoid repetition
READY_STALE_MERGE_LANE_LOG_KEYS=$'\n'
TASK_LIST_RENDERED=0              # track task list cursor region in control pane
WAVEMILL_PANE_REPAINT_LAST_LINES=0  # line-count state for repaint helper
SELECT_SHOW_ALL=false
USING_GROUPED_VIEW=false
GROUPED_SELECT_FROM=""
GROUPED_DISPLAY=""
declare -a COMMAND_QUEUE=()
declare -a COMMAND_QUEUE_OFFSETS=()
COMMAND_FILE="$(wavemill_command_file_path "$SESSION")"
COMMAND_OFFSET_WARNED=false

clear_task_list_display() {
  if (( TASK_LIST_RENDERED == 1 )); then
    printf '\033[u'  # restore cursor to saved anchor
    printf '\033[J'  # clear from anchor to end of screen
    TASK_LIST_RENDERED=0
    WAVEMILL_PANE_REPAINT_LAST_LINES=0
  fi
}

# Paint a task-list frame, managing the cursor anchor and repaint state.
# On first call (TASK_LIST_RENDERED=0): emits a blank separator line and
# saves the cursor as the anchor.  On subsequent calls (TASK_LIST_RENDERED=1):
# restores the cursor to the saved anchor before repainting.
paint_task_list_frame() {
  local frame="$1"
  if (( TASK_LIST_RENDERED == 1 )); then
    printf '\033[u'  # restore cursor to anchor
  else
    printf '\n'      # blank separator before first paint
    printf '\033[s'  # save cursor as anchor
  fi
  wavemill_pane_repaint "$frame"
  TASK_LIST_RENDERED=1
}

log_ready_stale_merge_lane_once() {
  local issue="$1" pr="$2" stored_base_sha="$3" current_main_sha="$4"
  local key="${issue}|${pr}|${stored_base_sha}|${current_main_sha}"
  local logged_keys="${READY_STALE_MERGE_LANE_LOG_KEYS:-$'\n'}"

  if [[ "$logged_keys" == *$'\n'"$key"$'\n'* ]]; then
    return 0
  fi

  READY_STALE_MERGE_LANE_LOG_KEYS="${logged_keys}${key}"$'\n'
  log "status" "⚠ $issue → Ready marked stale; waiting for merge lane (PR #$pr)"
}

monitor_command_timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

read_command_file_line_count() {
  local line_count=0
  [[ -f "$COMMAND_FILE" ]] && line_count=$(wc -l < "$COMMAND_FILE" 2>/dev/null | tr -d ' ')
  [[ "$line_count" =~ ^[0-9]+$ ]] || line_count=0
  printf '%s\n' "$line_count"
}

read_command_offset() {
  local line_count offset_raw
  line_count=$(read_command_file_line_count)

  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '%s\n' "0"
    return 0
  fi

  offset_raw=$(jq -r '.monitorCommandOffset // empty' "$STATE_FILE" 2>/dev/null || echo "")
  if [[ -z "$offset_raw" || "$offset_raw" == "null" ]]; then
    if (( line_count > 0 )); then
      [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset missing (init at EOF)."
      COMMAND_OFFSET_WARNED=true
      write_command_offset "$line_count" || true
      printf '%s\n' "$line_count"
      return 0
    fi
    write_command_offset "0" || true
    printf '%s\n' "0"
    return 0
  fi

  if ! [[ "$offset_raw" =~ ^[0-9]+$ ]]; then
    [[ "$COMMAND_OFFSET_WARNED" == "false" ]] && log_warn "Command offset invalid (init at EOF)."
    COMMAND_OFFSET_WARNED=true
    write_command_offset "$line_count" || true
    printf '%s\n' "$line_count"
    return 0
  fi
  if (( offset_raw > line_count )); then
    write_command_offset "$line_count" || true
    printf '%s\n' "$line_count"
    return 0
  fi
  printf '%s\n' "$offset_raw"
}

write_command_offset() {
  local new_offset="$1"
  [[ "$new_offset" =~ ^[0-9]+$ ]] || return 1
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 1
  state_mutate "$STATE_FILE" \
    '.monitorCommandOffset = $offset | .updated = (now | todate)' \
    --argjson offset "$new_offset" >/dev/null
}

highest_pending_command_offset() {
  local highest=0 offset
  for offset in "${COMMAND_QUEUE_OFFSETS[@]:-}"; do
    [[ "$offset" =~ ^[0-9]+$ ]] || continue
    if (( offset > highest )); then
      highest=$offset
    fi
  done
  printf '%s\n' "$highest"
}

queue_command_event() {
  local offset="$1" event="$2"
  COMMAND_QUEUE+=("$event")
  COMMAND_QUEUE_OFFSETS+=("$offset")
}

requeue_consumed_command_front() {
  if [[ -n "${REPLY:-}" && -n "${REPLY_OFFSET:-}" ]]; then
    COMMAND_QUEUE=("$REPLY" "${COMMAND_QUEUE[@]}")
    COMMAND_QUEUE_OFFSETS=("$REPLY_OFFSET" "${COMMAND_QUEUE_OFFSETS[@]}")
  fi
}

acknowledge_command_offset() {
  local offset="$1" current
  [[ "$offset" =~ ^[0-9]+$ ]] || return 1
  current="$(read_command_offset)"
  [[ "$current" =~ ^[0-9]+$ ]] || current=0
  if (( offset > current )); then
    write_command_offset "$offset" || true
  fi
}

monitor_list_deferred_commands() {
  if [[ ! -r "$STATE_FILE" || ! -s "$STATE_FILE" ]]; then
    printf '[]\n'
    return 0
  fi
  jq -c '.monitorDeferredCommands // []' "$STATE_FILE" 2>/dev/null || printf '[]\n'
}

monitor_remove_deferred_command() {
  local event="$1"
  [[ -n "$event" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.monitorDeferredCommands = ((.monitorDeferredCommands // []) | map(select(.event != $event))) | .updated = (now | todate)' \
    --arg event "$event" >/dev/null || true
}

monitor_defer_command() {
  local event="$1" reason="$2"
  local kind args_json now_ts

  case "$event" in
    select\ *)
      kind="select"
      args_json=$(printf '%s\n' "${event#select }" | tr ' ' '\n' | sed '/^$/d' | jq -Rsc 'split("\n") | map(select(length > 0))')
      ;;
    enter)
      kind="enter"
      args_json='[]'
      ;;
    more)
      kind="more"
      args_json='[]'
      ;;
    *)
      kind="unknown"
      args_json='[]'
      ;;
  esac

  now_ts="$(monitor_command_timestamp)"
  state_mutate "$STATE_FILE" '
    .monitorDeferredCommands = (
      (.monitorDeferredCommands // []) as $existing
      | ($existing | map(select(.event == $event)) | .[0]) as $prior
      | ($existing | map(select(.event != $event))) + [{
          event: $event,
          kind: $kind,
          args: $args,
          reason: $reason,
          queued_at: ($prior.queued_at // $now),
          last_checked_at: $now
        }]
    )
    | .updated = (now | todate)
  ' \
    --arg event "$event" \
    --arg kind "$kind" \
    --arg reason "$reason" \
    --arg now "$now_ts" \
    --argjson args "$args_json" >/dev/null || true
}

drain_command_events() {
  local line_count offset highest_pending start new_lines current_offset
  [[ -f "$COMMAND_FILE" ]] || return 0
  line_count=$(read_command_file_line_count)
  offset="$(read_command_offset)"
  [[ "$offset" =~ ^[0-9]+$ ]] || offset=0
  highest_pending="$(highest_pending_command_offset)"
  [[ "$highest_pending" =~ ^[0-9]+$ ]] || highest_pending=0
  if (( highest_pending > offset )); then
    offset=$highest_pending
  fi
  (( line_count <= offset )) && return 0

  start=$((offset + 1))
  new_lines="$(sed -n "${start},${line_count}p" "$COMMAND_FILE" 2>/dev/null || true)"
  current_offset=$start
  while IFS= read -r evt; do
    [[ -z "$evt" ]] && continue
    queue_command_event "$current_offset" "$evt"
    current_offset=$((current_offset + 1))
  done <<< "$new_lines"
}

consume_next_command() {
  if (( ${#COMMAND_QUEUE[@]} == 0 )); then
    return 1
  fi
  if (( ${#COMMAND_QUEUE_OFFSETS[@]} == 0 )); then
    COMMAND_QUEUE=()
    return 1
  fi
  REPLY="${COMMAND_QUEUE[0]}"
  REPLY_OFFSET="${COMMAND_QUEUE_OFFSETS[0]}"
  if (( ${#COMMAND_QUEUE[@]} == 1 )); then
    COMMAND_QUEUE=()
    COMMAND_QUEUE_OFFSETS=()
  else
    COMMAND_QUEUE=("${COMMAND_QUEUE[@]:1}")
    COMMAND_QUEUE_OFFSETS=("${COMMAND_QUEUE_OFFSETS[@]:1}")
  fi
  return 0
}

invalidate_backlog_prompt_state() {
  LAST_BACKLOG_FETCH=0
  LAST_DISPLAY=""
  LAST_WAITING_MSG=""
  SELECT_SHOW_ALL=false
  USING_GROUPED_VIEW=false
  clear_task_list_display
}

launch_selected_task_lines() {
  local selected_lines="$1" free_slots="$2"
  local launched=0 local_line sel_issue sel_slug sel_title
  LAST_COMMAND_LAUNCHED_SLOTS=0

  [[ -n "$selected_lines" ]] || return 0

  if (( $(grep -c . <<<"$selected_lines") > 1 )); then
    if batch_route_selected_tasks "$selected_lines"; then
      log "info" "Prepared batch routing for $(grep -c . <<<"$selected_lines") selected tasks"
    else
      log_warn "Batch routing failed for selected tasks; falling back to per-task routing"
    fi
  fi

  while IFS= read -r local_line; do
    [[ -z "$local_line" ]] && continue
    (( launched >= free_slots )) && break
    IFS='|' read -r sel_issue sel_slug sel_title _rest <<<"$local_line"
    launch_task "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
    launched=$((launched + LAST_LAUNCHED_SLOTS))
  done <<<"$selected_lines"

  LAST_COMMAND_LAUNCHED_SLOTS=$launched
  if (( launched > 0 )); then
    invalidate_backlog_prompt_state
  fi
}

handle_enter_command() {
  local event="$1" free_slots="$2" queue_plan_json="$3" avail_unblocked="$4" avail_blocked="$5"
  local wave_result wave_ids deferred_ids wave_selected_lines wid wline

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  if (( free_slots <= 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  if [[ "${ENTER_LAUNCHES_WAVE:-true}" != "true" ]]; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  if [[ -z "$queue_plan_json" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_result=$(invoke_first_wave_helper "$queue_plan_json" "$avail_unblocked" "$free_slots" 2>/dev/null) || wave_result=""
  if [[ -z "$wave_result" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
  deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
  if [[ -z "$wave_ids" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    if [[ -n "$deferred_ids" || -n "$avail_blocked" ]]; then
      MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    else
      MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
    fi
    return 0
  fi

  wave_selected_lines=""
  while IFS= read -r wid; do
    [[ -z "$wid" ]] && continue
    wline=$(grep -m1 "^${wid}|" <<<"$avail_unblocked" 2>/dev/null || echo "")
    [[ -n "$wline" ]] && wave_selected_lines+="${wline}"$'\n'
  done <<<"$wave_ids"

  if [[ -z "$wave_selected_lines" ]]; then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="selection_not_currently_visible"
    return 0
  fi

  [[ -n "$deferred_ids" ]] && log "debug" "[wave-launch] deferred=$(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
  launch_selected_task_lines "$wave_selected_lines" "$free_slots"
  if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
    MONITOR_COMMAND_STATUS="launched"
  else
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_launchable_candidates"
  fi
}

handle_select_command() {
  local event="$1" free_slots="$2" select_from="$3"
  local numbers_str selected_lines remaining_numbers unresolved_numbers blocked_numbers
  local n local_line sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked
  local launch_budget=0 launchable_count=0

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  numbers_str="${event#select }"
  if [[ -z "$numbers_str" ]]; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  if (( free_slots <= 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="$event"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  selected_lines=""
  remaining_numbers=()
  unresolved_numbers=()
  blocked_numbers=()
  launch_budget=$free_slots

  for n in $numbers_str; do
    if ! [[ "$n" =~ ^[0-9]+$ ]] || (( n == 0 )); then
      log_warn "Invalid selection: $n (must be a number)"
      continue
    fi
    local_line=$(sed -n "${n}p" <<<"$select_from")
    if [[ -z "$local_line" ]]; then
      unresolved_numbers+=("$n")
      continue
    fi
    IFS='|' read -r sel_issue sel_slug sel_title _sel_area _sel_score _sel_blocked <<<"$local_line"
    if [[ "${_sel_blocked:-0}" =~ ^[0-9]+$ ]] && (( _sel_blocked > 0 )); then
      blocked_numbers+=("$n")
      continue
    fi
    if (( launchable_count >= launch_budget )); then
      remaining_numbers+=("$n")
      continue
    fi
    selected_lines+="${local_line}"$'\n'
    launchable_count=$((launchable_count + 1))
  done

  if [[ -n "$selected_lines" ]]; then
    launch_selected_task_lines "$selected_lines" "$free_slots"
  fi

  if (( ${#remaining_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${remaining_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="no_slots_available"
    return 0
  fi

  if (( ${#blocked_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${blocked_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="dependency_blocked"
    return 0
  fi

  if (( ${#unresolved_numbers[@]} > 0 )); then
    MONITOR_COMMAND_STATUS="deferred"
    MONITOR_COMMAND_DEFER_EVENT="select ${unresolved_numbers[*]}"
    MONITOR_COMMAND_DEFER_REASON="selection_not_currently_visible"
    return 0
  fi

  if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
    MONITOR_COMMAND_STATUS="launched"
  else
    MONITOR_COMMAND_STATUS="invalid"
  fi
}

handle_advance_command() {
  local event="$1"
  local payload issue slug worktree feature_dir current_phase artifact_path artifact_rel_path
  local task_phase decision_json audit_path audit_timestamp soft_failures_json blocked_json
  local artifact_record artifact_summary artifact_mtime

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  payload="${event#advance }"
  if [[ "$payload" == "$event" ]]; then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  set -- $payload
  if (( $# != 1 )); then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi
  issue="$1"

  if [[ ! "$issue" =~ ^[A-Z][A-Z0-9]+-[0-9]+(_c)?$ ]]; then
    log_warn "usage: advance <issue-id>"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  slug=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].slug // empty')
  worktree=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].worktree // empty')
  if [[ -z "$slug" || -z "$worktree" ]]; then
    log_warn "$issue is not tracked"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  feature_dir="$worktree/features/$slug"
  if [[ ! -d "$feature_dir" ]]; then
    log_warn "$issue is not tracked (missing feature dir: $feature_dir)"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  current_phase=$(resolve_phase "$feature_dir")
  task_phase=$(read_state_value "" --arg issue "$issue" '.tasks[$issue].phase // empty')
  if [[ "$current_phase" != "coding" ]]; then
    if [[ -n "$task_phase" && "$task_phase" != "$current_phase" ]]; then
      log_warn "$issue is in phase $current_phase (state: $task_phase); advance only works for coding tasks"
    else
      log_warn "$issue is in phase $current_phase; advance only works for coding tasks"
    fi
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  artifact_path="$feature_dir/.coding-blocked-completion.json"
  artifact_rel_path="features/$slug/.coding-blocked-completion.json"
  if [[ ! -f "$artifact_path" ]]; then
    log_warn "$issue has no valid blocked-completion artifact at $artifact_rel_path"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  decision_json="$(blocked_completion_validate_for_advance "$issue" "$feature_dir" manual 2>/dev/null)" || {
    log_warn "$issue has no valid blocked-completion artifact at $artifact_rel_path"
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  }

  audit_path="$feature_dir/.coding-advance-override.json"
  audit_timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  artifact_record="$(read_blocked_completion "$feature_dir")"
  IFS=$'\001' read -r artifact_summary _reason artifact_mtime <<< "$artifact_record"
  blocked_json="$(jq -c '[.]' "$artifact_path")"
  soft_failures_json="$(jq -c '
    .guardrails
    | to_entries
    | map(select((.key == "commitMatchesHead" or .key == "worktreeClean") and (.value == false)))
    | map(.key)
  ' <<<"$decision_json" 2>/dev/null || echo '[]')"

  if ! jq -n \
    --arg timestamp "$audit_timestamp" \
    --arg issue "$issue" \
    --arg reason "manual advance via mill input" \
    --arg summary "$artifact_summary" \
    --arg path "$artifact_rel_path" \
    --arg resultPath "features/$slug/.coding-result.json" \
    --argjson validation "$decision_json" \
    --argjson softFailures "$soft_failures_json" \
    --argjson blocked "$blocked_json" \
    '{
      timestamp: $timestamp,
      issue: $issue,
      reason: $reason,
      artifact_summary: {
        path: $path,
        summary: $summary,
        stage: (($blocked[0] // {}).stage // ""),
        recommendedAction: (($blocked[0] // {}).recommendedAction // ""),
        implementationComplete: (($blocked[0] // {}).implementationComplete // false),
        committed: (($blocked[0] // {}).committed // false),
        passing_checks_count: (((($blocked[0] // {}).passingChecks) // []) | length),
        blocking_checks_count: (((($blocked[0] // {}).blockingChecks) // []) | length),
        coding_result_path: $resultPath
      },
      guardrails: ($validation.guardrails // {}),
      soft_failures: $softFailures
    }' | complete_coding_advance "$issue" "$feature_dir" "$audit_path" "Blocked verification accepted manually; review may proceed"; then
    MONITOR_COMMAND_STATUS="invalid"
    return 0
  fi

  log "status" "$issue -> advance recorded; review will launch on the next monitor tick"
  MONITOR_COMMAND_STATUS="handled"
}

execute_or_defer_monitor_command() {
  local source="$1" event="$2" event_offset="$3" free_slots="$4" queue_plan_json="$5" avail_unblocked="$6" avail_blocked="$7" select_from="$8"

  MONITOR_COMMAND_STATUS="noop"
  MONITOR_COMMAND_DEFER_EVENT=""
  MONITOR_COMMAND_DEFER_REASON=""

  case "$event" in
    more)
      if [[ "$USING_GROUPED_VIEW" != "true" ]]; then
        SELECT_SHOW_ALL=true
      fi
      MONITOR_COMMAND_STATUS="handled"
      ;;
    unknown\ *)
      log_warn "Unknown input: ${event#unknown }"
      MONITOR_COMMAND_STATUS="invalid"
      ;;
    enter)
      handle_enter_command "$event" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked"
      ;;
    advance|advance\ *)
      handle_advance_command "$event"
      ;;
    select\ *)
      handle_select_command "$event" "$free_slots" "$select_from"
      ;;
    *)
      MONITOR_COMMAND_STATUS="invalid"
      ;;
  esac

  if [[ "$MONITOR_COMMAND_STATUS" == "deferred" && -n "$MONITOR_COMMAND_DEFER_EVENT" ]]; then
    monitor_defer_command "$MONITOR_COMMAND_DEFER_EVENT" "$MONITOR_COMMAND_DEFER_REASON"
  fi

  if [[ "$source" == "deferred" ]]; then
    if [[ "$MONITOR_COMMAND_STATUS" != "deferred" || "$MONITOR_COMMAND_DEFER_EVENT" != "$event" ]]; then
      monitor_remove_deferred_command "$event"
    fi
  elif [[ "$MONITOR_COMMAND_STATUS" != "noop" && "$MONITOR_COMMAND_STATUS" != "pending" ]]; then
    acknowledge_command_offset "$event_offset"
  fi
}

process_new_monitor_commands() {
  local free_slots="$1" queue_plan_json="$2" avail_unblocked="$3" avail_blocked="$4" select_from="$5"
  while consume_next_command; do
    if [[ "$REPLY" == "quit" ]]; then
      requeue_consumed_command_front
      break
    fi
    execute_or_defer_monitor_command "new" "$REPLY" "$REPLY_OFFSET" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
    if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
      free_slots=$((free_slots - LAST_COMMAND_LAUNCHED_SLOTS))
      (( free_slots < 0 )) && free_slots=0
    fi
  done
  REMAINING_FREE_SLOTS="$free_slots"
}

process_deferred_monitor_commands() {
  local free_slots="$1" queue_plan_json="$2" avail_unblocked="$3" avail_blocked="$4" select_from="$5"
  local deferred_json event

  deferred_json="$(monitor_list_deferred_commands)"
  while IFS= read -r event; do
    [[ -z "$event" ]] && continue
    execute_or_defer_monitor_command "deferred" "$event" "" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
    if (( LAST_COMMAND_LAUNCHED_SLOTS > 0 )); then
      free_slots=$((free_slots - LAST_COMMAND_LAUNCHED_SLOTS))
      (( free_slots < 0 )) && free_slots=0
    fi
  done < <(jq -r '.[].event // empty' <<<"$deferred_json" 2>/dev/null)

  REMAINING_FREE_SLOTS="$free_slots"
}

normalize_prompt_command_reply() {
  local event="$1"
  case "$event" in
    enter) printf '%s\n' "enter" ;;
    select\ *) printf '%s\n' "${event#select }" ;;
    more) printf '%s\n' "m" ;;
    quit) printf '%s\n' "q" ;;
    advance\ *) printf '%s\n' "$event" ;;
    unknown\ *) printf '%s\n' "unknown ${event#unknown }" ;;
    *) printf '%s\n' "" ;;
  esac
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
  WT_DIR=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].worktree // ""')
  [[ -z "$WT_DIR" ]] && WT_DIR="${WORKTREE_ROOT}/${SLUG}"
  local WIN_TARGET
  WIN_TARGET="$(_tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "${STATE_FILE:-}" "$WT_DIR" 2>/dev/null || true)"
  if [[ -z "$WIN_TARGET" ]]; then
    WIN_TARGET="$(_tmux_target_join "$SESSION" "$WIN" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$WIN")"
  fi
  local FEATURE_DIR="${WT_DIR}/features/${SLUG}"
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
      merged_ready_dir="$(ready_state_dir "$WT_DIR" "$SLUG")"
      if ! ready_stage_allows_merge "$merged_ready_dir"; then
        merged_before_ready=true
        ready_stage_warn_bypass_once "$merged_ready_dir" "$ISSUE" "$PR" || true
        write_ready_attention_file "$merged_ready_dir" "PR #$PR was merged before the Release Readiness Check passed."
      else
        clear_transient_mergeability_state "$merged_ready_dir"
        rm -f "$merged_ready_dir/.needs-attention"
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
       && tmux list-panes -t "$WIN_TARGET" -F '#{pane_dead}' 2>/dev/null | grep -q '^0$'; then
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
        log "status" "$ISSUE → Found PR #$recovered_pr for errored task (updating state)"
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
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$PR" "" "$current_agent" "$linear_issue" "$challenge_flag" "$challenge_pair" "$challenge_role" "$challenge_model"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$linear_issue" "In Review"
      fi
      # Fetch PR details for user-visible summary
      pr_details=$(_with_timeout "$API_TIMEOUT" gh pr view "$PR" --json title,url --jq '"  " + .title + "\n  " + .url' 2>/dev/null || echo "")
      log "status" "$ISSUE → PR #$PR (In Review)"
      if [[ -n "$pr_details" ]]; then
        log "info" "$pr_details"
      fi

      local depends_on_pr_meta
      depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
      if [[ -n "$depends_on_pr_meta" ]]; then
        inject_depends_on_pr_block "$ISSUE" "$PR" "$depends_on_pr_meta"
      fi

      write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "" "PR #$PR" "{\"type\":\"review\",\"prNumber\":$PR}"
      dispatch_queued_children_for_parent "$ISSUE" "$PR"
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
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
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
      log "status" "$ISSUE → Ready checks completed for PR #$PR"
      return 0
    else
      # No PR in current repo - check Linear issue state for cross-repo completion
      if should_update_linear_state "$ISSUE" && linear_is_completed "$(get_linear_issue_id "$ISSUE")"; then
        log "status" "$ISSUE → Completed externally (cross-repo or manual)"
        set_window_attention_state "$WIN" "clear"

        # Post-completion eval (non-blocking: always exits 0)
        if [[ "$AUTO_EVAL" == "true" ]]; then
          eval_completed=$(read_state_value "false" --arg i "$ISSUE" '.tasks[$i].evalCompleted // false')
          if [[ "$eval_completed" == "false" ]]; then
            log_task "info" "$ISSUE" "📊 Running post-completion eval..."
            launch_background_post_merge_eval "$ISSUE" "" "$BRANCH" "$SLUG" "$ISSUE" "post-completion"
          else
            log "debug" "Eval already completed for $ISSUE"
          fi
        fi

        if [[ "$REQUIRE_CONFIRM" == "true" ]]; then
          log "status" "  → Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")"
          if should_update_linear_state "$ISSUE"; then
            linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
          fi
          # Preserve agent when marking as completed-external
          current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
          save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "completed-external" "$current_agent"
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
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during routing phase"
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
                planner_model="claude-sonnet-5"
                coder_model="claude-opus-4-7"
                reviewer_model="claude-sonnet-5"
                plan_depth="light"
                code_depth="medium"
                review_mode="static"
              else
                planner_model=$(jq -r '.planner // "claude-sonnet-5"' "$routing_file" 2>/dev/null || echo "claude-sonnet-5")
                coder_model=$(jq -r '.coder // "claude-opus-4-7"' "$routing_file" 2>/dev/null || echo "claude-opus-4-7")
                reviewer_model=$(jq -r '.reviewer // "claude-sonnet-5"' "$routing_file" 2>/dev/null || echo "claude-sonnet-5")
                plan_depth=$(jq -r '.planDepth // "light"' "$routing_file" 2>/dev/null || echo "light")
                code_depth=$(jq -r '.codeDepth // "medium"' "$routing_file" 2>/dev/null || echo "medium")
                review_mode=$(jq -r '.reviewMode // "static"' "$routing_file" 2>/dev/null || echo "static")
              fi

              planner_model="$(resolve_phase_model "planning" "$planner_model" "claude-sonnet-5")"
              coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
              reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"

              if [[ -z "${FORCE_MODEL:-}" ]]; then
                [[ -n "${WAVEMILL_PLANNER_MODEL:-}" ]] && planner_model="$WAVEMILL_PLANNER_MODEL"
                [[ -n "${WAVEMILL_CODER_MODEL:-}" ]] && coder_model="$WAVEMILL_CODER_MODEL"
                [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
              fi

              # Save routing results to state
              current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
              linear_issue=$(get_linear_issue_id "$ISSUE")
              save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "" "" "$current_agent" "$linear_issue" "" "" "" "" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode"

              # Write canonical phase config (HOK-1177)
              write_phase_config "$FEATURE_DIR" "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "${FORCE_MODEL:-}"

              # Transition to planning phase
              set_task_phase "$ISSUE" "planning"
              planner_launch_model="$planner_model"
              if declare -F agent_resolve_model >/dev/null 2>&1; then
                planner_launch_model="$(agent_resolve_model "planner" "$planner_model" "$REPO_DIR")" || return 1
              fi
              if ! planner_agent="$(agent_resolve_from_model "$planner_launch_model" "planning")"; then
                write_stage_result "$FEATURE_DIR" "planning" "failed" "" "$planner_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Planning launch blocked by agent resolution failure.}"
                set_task_phase "$ISSUE" "routing"
                set_window_attention_state "$WIN" "needs-user"
                log "warn" "⚠ $ISSUE → Planning launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
                active_count=$((active_count + 1))
                return 0
              fi

              # Get title from state or Linear
              title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
              if [[ -z "$title" ]]; then
                issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
                title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
              fi

              # Record planning stage as running (HOK-1177)
              write_stage_result "$FEATURE_DIR" "planning" "running" "$planner_agent" "$planner_launch_model"

              launch_planning_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$planner_launch_model" "$planner_agent" "$plan_depth"
              local launch_rc=$?
              if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "planning" "routing" "$launch_rc" "$WIN" "$planner_agent" "$planner_launch_model"; then
                return 0
              fi
              set_window_attention_state "$WIN" "clear"
              log "status" "$ISSUE → Routing complete, launching planning phase"
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
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during planning phase"
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
            if ! validate_planning_phase_output "$WT_DIR"; then
              handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
              active_count=$((active_count + 1))
              return 0
            fi
            # Record approval via approve_plan (HOK-1193: controller-owned stage result)
            approve_plan "$FEATURE_DIR" "$current_agent" ""

            if ! reroute_expanded_packets_for_coding_handoff "$ISSUE" "$SLUG" "$FEATURE_DIR"; then
              handle_expanded_reroute_handoff_failure "$ISSUE" "$FEATURE_DIR"
            fi
            if ! apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG" "$WT_DIR" "$STATE_FILE"; then
              log_warn "$ISSUE → expanded route invalid; using bootstrap execution route for coding"
            fi
            emit_execution_active_route "$FEATURE_DIR" "$ISSUE"

            local handshake_reason handshake_policy handshake_block_note
            handshake_reason="$(mill_expansion_handshake_reason "$FEATURE_DIR")"
            handshake_policy="$(get_expansion_handshake_policy "$REPO_DIR")"

            if [[ "$handshake_reason" == "missing" && "$handshake_policy" == "recover" ]]; then
              if recover_missing_expansion_artifact "$ISSUE" "$SLUG" "$FEATURE_DIR"; then
                if ! apply_expanded_route_if_present "$FEATURE_DIR" "$ISSUE" "$SLUG" "$WT_DIR" "$STATE_FILE"; then
                  expansion_recovery_mark_result "$FEATURE_DIR" "$ISSUE" "failed" "expanded-route-promotion-failed" "1" || true
                  log_warn "$ISSUE → recovered expanded route was invalid during promotion; using bootstrap execution route for coding"
                  handshake_reason="recovery-fallback-bootstrap"
                else
                  handshake_reason="$(mill_expansion_handshake_reason "$FEATURE_DIR")"
                fi
                emit_execution_active_route "$FEATURE_DIR" "$ISSUE"
              else
                log_warn "$ISSUE → expansion recovery failed; RECOVERY_FALLBACK_BOOTSTRAP"
                emit_execution_active_route "$FEATURE_DIR" "$ISSUE"
                handshake_reason="recovery-fallback-bootstrap"
              fi
            fi

            if [[ "$handshake_reason" != "recovery-fallback-bootstrap" ]] && ! mill_check_expansion_handshake "$FEATURE_DIR" "$ISSUE" "$REPO_DIR"; then
              rm -f "$FEATURE_DIR/.plan-approved"
              if [[ "$handshake_reason" == "missing" ]]; then
                handshake_block_note="Expansion handshake blocked: raw input requires wavemill expand $ISSUE"
              else
                handshake_block_note="Expansion handshake blocked: invalid expanded routing artifact ($handshake_reason)"
              fi
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "$handshake_block_note"
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
              challenge_stage_meta=$(get_task_meta "$ISSUE" "challengeStage")
              challenge_role_meta=$(get_task_meta "$ISSUE" "challengeRole")
              # Post-expansion refresh re-pairs by coder; stage-varied pairs
              # (plan/review) keep their original pairing.
              #
              # CRITICAL: only the primary may run this refresh. It re-saves
              # BOTH sides of the pair (primary as challengePairId=$ISSUE/primary
              # and the challenger as challengePairId=$ISSUE/challenger). If a
              # challenger task ever reaches this block it would call
              # resolve-challenge-task with --issue <challenger_key> and re-save
              # ITSELF as challengePairId=<challenger_key>/role=primary, severing
              # the link to its real primary. That mislabels the challenger's
              # eval record (it runs as side=primary under the wrong pair id) and
              # makes compare-prs fail with "Missing eval records", stalling the
              # challenge before evaluation. Guard challengers out entirely — the
              # primary's refresh already re-pairs them correctly.
              if [[ "$challenge_role_meta" != "challenger" ]] && [[ -n "$challenge_coder" ]] && [[ -z "$challenge_stage_meta" || "$challenge_stage_meta" == "implementation" ]] && [[ -f "$FEATURE_DIR/.post-expansion-route.json" ]]; then
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
                  new_primary_planner=$(echo "$refreshed_plan" | jq -r '.entries[0].planner // empty' 2>/dev/null)
                  new_primary_reviewer=$(echo "$refreshed_plan" | jq -r '.entries[0].reviewer // empty' 2>/dev/null)
                  new_primary_plan_depth=$(echo "$refreshed_plan" | jq -r '.entries[0].planDepth // empty' 2>/dev/null)
                  new_primary_code_depth=$(echo "$refreshed_plan" | jq -r '.entries[0].codeDepth // empty' 2>/dev/null)
                  new_primary_review_mode=$(echo "$refreshed_plan" | jq -r '.entries[0].reviewMode // empty' 2>/dev/null)
                  new_challenge_stage=$(echo "$refreshed_plan" | jq -r '.challengeStage // "implementation"' 2>/dev/null || echo "implementation")
                  new_challenger_key=$(echo "$refreshed_plan" | jq -r '.entries[1].key // empty' 2>/dev/null)
                  new_challenger_model=$(echo "$refreshed_plan" | jq -r '.entries[1].model // empty' 2>/dev/null)
                  new_challenger_planner=$(echo "$refreshed_plan" | jq -r '.entries[1].planner // empty' 2>/dev/null)
                  new_challenger_reviewer=$(echo "$refreshed_plan" | jq -r '.entries[1].reviewer // empty' 2>/dev/null)
                  new_challenger_plan_depth=$(echo "$refreshed_plan" | jq -r '.entries[1].planDepth // empty' 2>/dev/null)
                  new_challenger_code_depth=$(echo "$refreshed_plan" | jq -r '.entries[1].codeDepth // empty' 2>/dev/null)
                  new_challenger_review_mode=$(echo "$refreshed_plan" | jq -r '.entries[1].reviewMode // empty' 2>/dev/null)

                  refresh_identical="false"
                  if [[ -n "$new_primary" ]] \
                    && [[ "$new_primary" == "$new_challenger_model" ]] \
                    && [[ "$new_primary_planner" == "$new_challenger_planner" ]] \
                    && [[ "$new_primary_reviewer" == "$new_challenger_reviewer" ]] \
                    && [[ "$new_primary_plan_depth" == "$new_challenger_plan_depth" ]] \
                    && [[ "$new_primary_code_depth" == "$new_challenger_code_depth" ]] \
                    && [[ "$new_primary_review_mode" == "$new_challenger_review_mode" ]]; then
                    refresh_identical="true"
                    log_warn "$ISSUE → expanded challenge refresh produced identical primary/challenger routing, preserving existing challenge participants"
                  elif [[ -n "$new_primary" ]]; then
                    current_pr=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].pr // ""')
                    current_status=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].status // ""')
                    current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
                    current_linear_issue=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].linearIssueId // ""')
                    save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$current_pr" "$current_status" "$current_agent" "$current_linear_issue" \
                      "true" "$ISSUE" "primary" "$new_primary" "$new_primary_planner" "$new_primary" "$new_primary_reviewer" "$new_primary_plan_depth" "$new_primary_code_depth" "$new_primary_review_mode" "$new_challenge_stage"
                    challenge_coder="$new_primary"
                    challenge_stage_meta="$new_challenge_stage"
                  fi

                  if [[ "$refresh_identical" != "true" ]] && [[ -n "$new_challenger_key" ]] && [[ -n "$new_challenger_model" ]]; then
                    challenger_slug=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].slug // ""')
                    challenger_branch=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].branch // ""')
                    challenger_worktree=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].worktree // ""')
                    challenger_pr=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].pr // ""')
                    challenger_status=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].status // ""')
                    challenger_agent=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].agent // ""')
                    challenger_linear_issue=$(read_state_value "" --arg i "$new_challenger_key" '.tasks[$i].linearIssueId // ""')
                    if [[ -n "$challenger_slug" ]] && [[ -n "$challenger_branch" ]] && [[ -n "$challenger_worktree" ]]; then
                      save_task_state "$new_challenger_key" "$challenger_slug" "$challenger_branch" "$challenger_worktree" "$challenger_pr" "$challenger_status" "$challenger_agent" "$challenger_linear_issue" \
                        "true" "$ISSUE" "challenger" "$new_challenger_model" "$new_challenger_planner" "$new_challenger_model" "$new_challenger_reviewer" "$new_challenger_plan_depth" "$new_challenger_code_depth" "$new_challenger_review_mode" "$new_challenge_stage"
                    fi
                  fi

                  log "status" "  $ISSUE: Challenge participants refreshed (expanded route): ${new_primary:-$challenge_coder} vs ${new_challenger_model:-unknown}"
                elif [[ "$refreshed_source" == "preserved" ]]; then
                  log "debug" "  $ISSUE: Challenge participants preserved after expanded routing"
                fi
              fi
              # For challenge tasks, the challengeModel only names the coder when the
              # challenge varied the implementation stage. Plan-stage and review-stage
              # challenges leave the coder route untouched (see HOK-2272).
              if [[ -n "$challenge_coder" ]]; then
                case "$challenge_stage_meta" in
                  implementation)
                    coder_model="$challenge_coder"
                    ;;
                  plan|review)
                    log "debug" "  $ISSUE: challenge stage=$challenge_stage_meta — honoring phase-config coder ($coder_model) over challengeModel ($challenge_coder)"
                    ;;
                  "")
                    log_warn "  $ISSUE: challenge has no challengeStage signal — fail-safe to phase-config coder ($coder_model); challengeModel ($challenge_coder) ignored"
                    ;;
                  *)
                    log_warn "  $ISSUE: unrecognized challengeStage=$challenge_stage_meta — fail-safe to phase-config coder ($coder_model); challengeModel ($challenge_coder) ignored"
                    ;;
                esac
              fi
            fi
            coder_model="$(resolve_phase_model "coding" "$coder_model" "claude-opus-4-7")"
            [[ -n "${WAVEMILL_CODER_MODEL:-}" && -z "${FORCE_MODEL:-}" ]] && coder_model="$WAVEMILL_CODER_MODEL"
            code_depth=$(read_phase_config "$FEATURE_DIR" "coding" "depth")
            [[ -z "$code_depth" ]] && code_depth=$(get_task_meta "$ISSUE" "codeDepth")
            [[ -z "$code_depth" ]] && code_depth="medium"

            # Transition to coding phase
            set_task_phase "$ISSUE" "coding"
            coder_launch_model="$coder_model"
            if declare -F agent_resolve_model >/dev/null 2>&1; then
              coder_launch_model="$(agent_resolve_model "coder" "$coder_model" "$REPO_DIR")" || return 1
            fi
            if ! coder_agent="$(agent_resolve_from_model "$coder_launch_model" "coding")"; then
              write_stage_result "$FEATURE_DIR" "coding" "failed" "" "$coder_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Coding launch blocked by agent resolution failure.}"
              set_task_phase "$ISSUE" "planning"
              set_window_attention_state "$WIN" "needs-user"
              log "warn" "⚠ $ISSUE → Coding launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ -f "${STATE_FILE:-}" ]] && jq -e --arg issue "$ISSUE" '.tasks[$issue]? // empty' "$STATE_FILE" >/dev/null 2>&1; then
              if ! state_mutate "$STATE_FILE" \
                '.tasks[$issue].agent = $agent | .tasks[$issue].updated = (now | todate)' \
                --arg issue "$ISSUE" \
                --arg agent "$coder_agent" >/dev/null 2>&1; then
                log_warn "set_task_agent: failed to update $ISSUE for coding"
              fi
            fi

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            # Record coding stage as running (HOK-1177)
            write_stage_result "$FEATURE_DIR" "coding" "running" "$coder_agent" "$coder_launch_model"

            launch_coding_phase "$ISSUE" "$SLUG" "$title" "$WT_DIR" "$BRANCH" "$BASE_BRANCH" "$coder_launch_model" "$coder_agent" "$code_depth"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "coding" "planning" "$launch_rc" "$WIN" "$coder_agent" "$coder_launch_model"; then
                return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "$ISSUE → Plan approved, launching coding phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect planning stage transitions
          local planning_status
          planning_status=$(read_stage_status "$FEATURE_DIR" "planning")

          # Transition 1: awaiting_user + .plan-approved → completed.
          # Approval markers created before the run reaches awaiting_user are
          # stale/in-run markers and must not bypass the operator gate.
          if [[ "$planning_status" == "running" ]] && [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
            rm -f "$FEATURE_DIR/.plan-approved"
            log "warn" "$ISSUE → Ignoring .plan-approved created before planning was awaiting user approval"
          fi

          if [[ "$planning_status" == "awaiting_user" ]]; then
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "$WT_DIR"; then
                handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "$ISSUE → Plan approved (via .plan-approved marker), marking as completed"
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
              log "status" "$ISSUE → plan.md detected, marking planning as awaiting_user"
              write_stage_result "$FEATURE_DIR" "planning" "awaiting_user" "$current_agent" "" "Plan ready for review"
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          if emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "planning" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "planning" "")"; then
            return 0
          fi

          # Check if plan exists but not yet approved (awaiting_user)
          if [[ "$resolved_phase" == "awaiting_user" ]]; then
            # Check if user signaled approval by creating .plan-approved marker
            if [[ -f "$FEATURE_DIR/.plan-approved" ]]; then
              unset "$approval_wait_var" 2>/dev/null || true
              if ! validate_planning_phase_output "$WT_DIR"; then
                handle_planning_overreach_rejection "$ISSUE" "$FEATURE_DIR" "$WIN" "$current_agent"
                active_count=$((active_count + 1))
                return 0
              fi
              log "status" "$ISSUE → User approved plan (via .plan-approved marker)"
              approve_plan "$FEATURE_DIR" "$current_agent" ""
              # Now completed — next poll iteration will pick up and launch coding
              active_count=$((active_count + 1))
              return 0
            fi

            # HOK-1210: Do NOT auto-approve just because the pane is idle.
            # The agent must create .plan-approved after explicit user approval.
            # If the pane is idle or dead without the marker, log once and wait for user.
            if [[ -f "$FEATURE_DIR/plan.md" ]] && _pane_is_dead_or_idle "$WIN_TARGET"; then
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

          if [[ "$planning_status" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed transition artifact — needs attention
          needs_attention="true"
          ;;

        coding)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during coding phase"
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
            if guard_coding_complete_handoff "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH"; then
              return 0
            fi
            validate_coding_phase_output "$BRANCH"
            clear_coding_uncommitted_output_attention "$FEATURE_DIR"
            # Mark coding as completed (HOK-1177)
            write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
            quarantine_completed_coding_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"

            # FORCE_MODEL takes priority, then phase config, then state, then default
            if [[ -n "${FORCE_MODEL:-}" ]]; then
              reviewer_model="$FORCE_MODEL"
            else
              reviewer_model=$(read_phase_config "$FEATURE_DIR" "review" "model")
              [[ -z "$reviewer_model" ]] && reviewer_model=$(get_task_meta "$ISSUE" "reviewerModel")
            fi
            reviewer_model="$(resolve_phase_model "review" "$reviewer_model" "claude-sonnet-5")"
            [[ -n "${WAVEMILL_REVIEWER_MODEL:-}" && -z "${FORCE_MODEL:-}" ]] && reviewer_model="$WAVEMILL_REVIEWER_MODEL"
            review_mode=$(read_phase_config "$FEATURE_DIR" "review" "mode")
            [[ -z "$review_mode" ]] && review_mode=$(get_task_meta "$ISSUE" "reviewMode")
            [[ -z "$review_mode" ]] && review_mode="static"

            # Transition to review phase
            set_task_phase "$ISSUE" "review"
            reviewer_launch_model="$reviewer_model"
            if declare -F agent_resolve_model >/dev/null 2>&1; then
              reviewer_launch_model="$(agent_resolve_model "reviewer" "$reviewer_model" "$REPO_DIR")" || return 1
            fi
            if ! reviewer_agent="$(agent_resolve_from_model "$reviewer_launch_model" "review")"; then
              write_stage_result "$FEATURE_DIR" "review" "failed" "" "$reviewer_launch_model" "${AGENT_RESOLVE_LAST_DIAGNOSTIC:-Review launch blocked by agent resolution failure.}"
              set_task_phase "$ISSUE" "coding"
              set_window_attention_state "$WIN" "needs-user"
              log "warn" "⚠ $ISSUE → Review launch blocked: ${AGENT_RESOLVE_LAST_DIAGNOSTIC:-agent resolution failed}"
              active_count=$((active_count + 1))
              return 0
            fi

            # Get title
            title=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].title // ""')
            if [[ -z "$title" ]]; then
              issue_json=$(cat "/tmp/${SESSION}-${ISSUE}-issue.json" 2>/dev/null || echo "{}")
              title=$(echo "$issue_json" | jq -r '.title // "Task"' 2>/dev/null || echo "Task")
            fi

            # Record review stage as running (HOK-1177)
            write_stage_result "$FEATURE_DIR" "review" "running" "$reviewer_agent" "$reviewer_launch_model"

            launch_review_phase "$ISSUE" "$SLUG" "$title" "${WORKTREE_ROOT}/${SLUG}" "$BRANCH" "$BASE_BRANCH" "$reviewer_launch_model" "$reviewer_agent" "$review_mode"
            local launch_rc=$?
            if ! handle_phase_launch_result "$ISSUE" "$FEATURE_DIR" "review" "coding" "$launch_rc" "$WIN" "$reviewer_agent" "$reviewer_launch_model"; then
              return 0
            fi
            set_window_attention_state "$WIN" "clear"
            log "status" "$ISSUE → Coding complete, launching review phase"
            active_count=$((active_count + 1))
            return 0
          fi

          # HOK-1194: Detect running→completed transition
          # When stage result is "running" and .coding-complete exists,
          # write completed status (next iteration will launch review)
          local coding_status
          coding_status=$(read_stage_status "$FEATURE_DIR" "coding")
          if [[ "$coding_status" == "running" ]]; then
            recover_misplaced_coding_complete_marker "$ISSUE" "${WORKTREE_ROOT}/${SLUG}" "$FEATURE_DIR" "$SLUG" || true
            if [[ -f "$FEATURE_DIR/.coding-complete" ]]; then
              if guard_coding_complete_handoff "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH"; then
                return 0
              fi
              validate_coding_phase_output "$BRANCH"
              log "status" "$ISSUE → .coding-complete detected, marking coding as completed"
              clear_coding_uncommitted_output_attention "$FEATURE_DIR"
              write_stage_result "$FEATURE_DIR" "coding" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"
              quarantine_completed_coding_pane "$ISSUE" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"
              # Next iteration will detect resolved_phase == "review" and launch review
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ ! -f "$FEATURE_DIR/.coding-blocked-completion.json" ]] \
              && [[ "${current_agent:-}" == "codex" || "${AGENT_CMD:-}" == "codex" ]] \
              && codex_capacity_idle_confirmed "$ISSUE" "$SLUG" "$FEATURE_DIR" "${WORKTREE_ROOT}/${SLUG}"; then
              local codex_capacity_source codex_capacity_model
              codex_capacity_source="$(jq -r '.source // "unknown"' "$(codex_capacity_dwell_marker "$FEATURE_DIR")" 2>/dev/null || echo "unknown")"
              codex_capacity_model="$(jq -r '.model // empty' "$FEATURE_DIR/.coding-result.json" 2>/dev/null || echo "")"
              write_codex_capacity_blocked_completion "$ISSUE" "$FEATURE_DIR" "$codex_capacity_model" "$codex_capacity_source" || true
              write_stage_result "$FEATURE_DIR" "coding" "running" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")" "Blocked: Codex model at capacity"
            fi
            if auto_advance_blocked_completion "$ISSUE" "$FEATURE_DIR" "$WIN_TARGET" "$WIN"; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            fi
            if [[ "${AUTO_ADVANCE_BLOCKED_COMPLETION_HANDLED:-}" == "attention" ]]; then
              return 0
            fi
            if emit_blocked_completion_attention "$ISSUE" "$FEATURE_DIR"; then
              return 0
            fi
            if emit_pane_divergence_attention "$ISSUE" "$SLUG" "$FEATURE_DIR" "$WIN" "$WIN_TARGET"; then
              return 0
            fi
            if emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "coding" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "coding" "claude-opus-4-7")"; then
              return 0
            fi
            if emit_terminal_blocked_completion_attention "$ISSUE" "$SLUG" "$FEATURE_DIR" "$WIN" "$WIN_TARGET"; then
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

          if [[ "$coding_status" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # No controller-observed completion artifact
          needs_attention="true"
          ;;

        review)
          if [[ "$resolved_phase" == "aborted" ]]; then
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during review phase"
            write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"
            set_task_phase "$ISSUE" "aborted"
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi

          local review_status
          local pr_number
          review_status=$(read_stage_status "$FEATURE_DIR" "review")
          pr_number=$(find_pr_for_branch "$BRANCH")

          if [[ "$review_status" == "running" && -z "$pr_number" ]]; then
            _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "review"
            if [[ "$_RESTORE_STATE" == "restored" ]]; then
              set_window_attention_state "$WIN" "clear"
              active_count=$((active_count + 1))
              return 0
            elif [[ "$_RESTORE_STATE" == "failed" ]]; then
              set_window_attention_state "$WIN" "needs-user"
              active_count=$((active_count + 1))
              return 0
            fi
          fi

          # Reconcile legacy/stale review state: once a PR exists, review is effectively complete
          # and the controller can move into ready even if the stage file is still "running".
          if [[ "$review_status" == "running" ]]; then
            if [[ -n "$pr_number" ]]; then
              local depends_on_pr_meta
              depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
              if [[ -n "$depends_on_pr_meta" ]]; then
                inject_depends_on_pr_block "$ISSUE" "$pr_number" "$depends_on_pr_meta"
              fi
              write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")" "PR #$pr_number" "{\"type\":\"review\",\"prNumber\":$pr_number}"
              dispatch_queued_children_for_parent "$ISSUE" "$pr_number"
              review_status="completed"
            elif emit_native_launch_failure_attention "$ISSUE" "$FEATURE_DIR" "review" "$WIN" "$WIN_TARGET" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")"; then
              return 0
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

          if [[ "$review_status" == "failed" ]]; then
            set_window_attention_state "$WIN" "needs-user"
            active_count=$((active_count + 1))
            return 0
          fi

          # This branch is only reachable when no PR is cached yet. The live
          # review -> ready transition for PR-backed tasks runs in the PR
          # lifecycle section below so resumed tasks can still advance.
          # Review is no longer running - check if PR was created and transition to ready phase.
          if [[ -n "$pr_number" ]]; then
            # Mark review as completed with PR artifact (HOK-1177)
            local depends_on_pr_meta
            depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
            if [[ -n "$depends_on_pr_meta" ]]; then
              inject_depends_on_pr_block "$ISSUE" "$pr_number" "$depends_on_pr_meta"
            fi
            write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "$(resolve_stage_result_model "$FEATURE_DIR" "review" "claude-sonnet-5")" "PR #$pr_number" "{\"type\":\"review\",\"prNumber\":$pr_number}"
            dispatch_queued_children_for_parent "$ISSUE" "$pr_number"

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
              log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
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
            log "status" "$ISSUE → Ready checks completed for PR #$pr_number"
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
            log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during ready phase"
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

            if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
              local pr_number
              pr_number=$(find_pr_for_branch "$BRANCH")
              if [[ -z "$pr_number" ]]; then
                write_ready_attention_file "$ready_state_dir_path" "Unable to find open PR for branch $BRANCH after conflict remediation."
                set_window_attention_state "$WIN" "needs-user"
                return 0
              fi

              if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
                if ready_conflict_recheck_due "$ready_state_dir_path" && ready_conflict_pr_is_clean "$ready_state_dir_path" "$pr_number" "$ISSUE"; then
                  clear_ready_conflict_markers "$ready_state_dir_path"
                else
                  set_window_attention_state "$WIN" "needs-user"
                  return 0
                fi
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
                log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during conflict remediation"
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

              log "$ISSUE → Conflict remediation complete, ready checks rerun"
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
          if ! _pane_is_dead_or_idle "$WIN_TARGET"; then
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
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted (controller state)"
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
      if ! _tmux_task_window_target "$SESSION" "$ISSUE" "$SLUG" "${STATE_FILE:-}" "$WT_DIR" >/dev/null 2>&1; then
        log "status" "⚠ $ISSUE → Window disappeared during $current_phase phase, recreating..."
        tmux new-window -d -t "$SESSION" -n "$WIN" -c "${WORKTREE_ROOT}/${SLUG}" 2>/dev/null || true
        WIN_TARGET="$(tmux display-message -p -t "$SESSION:$WIN" '#{window_id}' 2>/dev/null || true)"
        [[ -n "$WIN_TARGET" ]] || WIN_TARGET="$WIN"
        persist_task_window_id "$ISSUE" "$WIN_TARGET"
        WIN_TARGET="$(_tmux_target_join "$SESSION" "$WIN_TARGET" 2>/dev/null || printf '%s:%s\n' "$SESSION" "$WIN_TARGET")"
        tmux set-option -t "$WIN_TARGET" remain-on-exit on 2>/dev/null || true
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
          log "status" "$ISSUE → Found PR #$pr_number (updating state)"
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
    else
      clear_transient_mergeability_state "$merged_ready_dir"
      rm -f "$merged_ready_dir/.needs-attention"
    fi

    log "status" "$ISSUE → PR #$PR MERGED"
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
        log_task "info" "$ISSUE" "📊 Running post-merge eval..."
        launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge"
      elif [[ "$AUTO_EVAL" == "true" ]]; then
        log "debug" "Eval already completed for $ISSUE"
      fi
      log "status" "  → Window stays open for review - close it when ready$(wavemill_config_annotation "mill.requireConfirm" "$REQUIRE_CONFIRM")"
      if should_update_linear_state "$ISSUE"; then
        linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
      fi
      # Preserve agent when marking as merged
      current_agent=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].agent // ""')
      save_task_state "$ISSUE" "$SLUG" "$BRANCH" "$WT_DIR" "$PR" "merged" "$current_agent"
      active_count=$((active_count + 1))
      return 0
    fi

    if should_update_linear_state "$ISSUE"; then
      linear_set_state "$(get_linear_issue_id "$ISSUE")" "Done"
    fi
    cleanup_completed_task "$ISSUE" "$SLUG"
    if [[ "$_eval_needed" == "true" ]]; then
      log_task "info" "$ISSUE" "📊 Eval queued in background"
      launch_background_post_merge_eval "$ISSUE" "$PR" "$BRANCH" "$SLUG" "$ISSUE" "post-merge" "$_eval_agent"
    elif [[ "$AUTO_EVAL" == "true" ]]; then
      log "debug" "Eval already completed for $ISSUE"
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
        log "status" "Challenge sibling merged → marking Linear as Done"
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
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during review phase"
        write_stage_result "$FEATURE_DIR" "review" "aborted" "$current_agent"
        set_task_phase "$ISSUE" "aborted"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      review_status=$(read_stage_status "$FEATURE_DIR" "review")
      if [[ "$review_status" == "running" || -z "$review_status" || "$review_status" == "completed" ]]; then
        local depends_on_pr_meta
        depends_on_pr_meta=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].dependsOnPr // empty')
        if [[ -n "$depends_on_pr_meta" ]]; then
          inject_depends_on_pr_block "$ISSUE" "$PR" "$depends_on_pr_meta"
        fi
        write_stage_result "$FEATURE_DIR" "review" "completed" "$current_agent" "" "PR #$PR" "{\"type\":\"review\",\"prNumber\":$PR}"
        dispatch_queued_children_for_parent "$ISSUE" "$PR"
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
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready launch"
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
        log "status" "$ISSUE → Ready checks completed for PR #$PR"
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
    local launch_head current_head title launch_rc _conflict_cleared
    _conflict_cleared=false
    resolved_phase=$(resolve_phase "$FEATURE_DIR")
    if [[ "$resolved_phase" == "aborted" ]]; then
      log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted by user during ready phase"
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

      if [[ "$ready_status" != "running" || -z "$launch_head" || "$launch_head" != "$current_head" ]]; then
        if [[ -n "$attention_head" && -n "$current_head" && "$attention_head" == "$current_head" ]]; then
          if ready_conflict_recheck_due "$ready_state_dir_path" && ready_conflict_pr_is_clean "$ready_state_dir_path" "$PR" "$ISSUE"; then
            clear_ready_conflict_markers "$ready_state_dir_path"
            _conflict_cleared=true
          else
            set_window_attention_state "$WIN" "needs-user"
            return 0
          fi
        fi

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
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during conflict remediation"
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

        log "status" "$ISSUE → Conflict remediation complete, ready checks rerun"
        if [[ "$_conflict_cleared" == "true" ]]; then
          set_window_attention_state "$WIN" "clear"
        else
          set_window_attention_state "$WIN" "needs-user"
        fi
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
        maybe_resolve_unresolvable_challenge_pair "$ISSUE"
      fi

      local challenge_comparison_state
      challenge_comparison_state=$(read_state_value "" --arg i "$ISSUE" '.tasks[$i].comparisonState // empty')
      case "$challenge_comparison_state" in
        manual_comparison_needed)
          set_window_attention_state "$WIN" "needs-user"
          active_count=$((active_count + 1))
          return 0
          ;;
        retrying_eval)
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
          ;;
        comparison_running)
          set_window_attention_state "$WIN" "clear"
          active_count=$((active_count + 1))
          return 0
          ;;
      esac

      # Re-run ready if main has advanced since the pass was recorded (HOK-1359)
      local stored_base_sha current_main_sha queue_state
      stored_base_sha=$(ready_base_sha "$ready_state_dir_path")
      current_main_sha=$(get_main_head_sha "${WORKTREE_ROOT}/${SLUG}" "$BASE_BRANCH")
      queue_state=$(ready_queue_state "$ready_state_dir_path")

      if [[ -n "$current_main_sha" && "$stored_base_sha" != "$current_main_sha" ]]; then
        if merge_queue_enabled; then
          if [[ "$queue_state" != "merge-candidate" ]]; then
            mark_ready_stale "$ISSUE" "$ready_state_dir_path" "$stored_base_sha" "$current_main_sha"
            log_ready_stale_merge_lane_once "$ISSUE" "$PR" "$stored_base_sha" "$current_main_sha"
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
          if ! ready_candidate_selected "$ISSUE"; then
            set_window_attention_state "$WIN" "clear"
            active_count=$((active_count + 1))
            return 0
          fi
        fi
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
          log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during stale-ready re-check"
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
        log "status" "$ISSUE → Ready re-check passed after main advanced (PR #$PR)"
        set_window_attention_state "$WIN" "clear"
        active_count=$((active_count + 1))
        return 0
      fi

      if merge_queue_enabled && [[ "$queue_state" == "merge-candidate" ]]; then
        log "debug" "✓ $ISSUE → PR #$PR is a clean/green merge candidate (waiting in merge lane)"
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
    if [[ "$ready_status" == "failed" ]]; then
      log "status" "↻ $ISSUE → Re-running failed ready checks for PR #$PR"
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
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during failed-ready re-check"
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
        log "status" "⚠ $ISSUE → Ready re-check still failed (PR #$PR)"
        set_window_attention_state "$WIN" "needs-user"
        return 0
      fi

      log "status" "$ISSUE → Ready re-check passed for PR #$PR"
      set_window_attention_state "$WIN" "clear"
      active_count=$((active_count + 1))
      return 0
    fi

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
        log_task "status" "$ISSUE" "⛔ $ISSUE → Workflow aborted during ready re-check"
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

      log "status" "$ISSUE → Ready checks completed for PR #$PR"
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
    maybe_resolve_unresolvable_challenge_pair "$ISSUE"
  fi
  active_count=$((active_count + 1))

  return 0
}

# ── Control pane health watchdog ──────────────────────────────────────
# Respawns dead mill panes (dashboard, log) to prevent layout collapse.
# Called each monitor cycle. Relies on remain-on-exit keeping dead panes
# visible so we can detect and respawn them without losing the layout.
LAST_DASHBOARD_HEALTH_CHECK=0
DASHBOARD_HEALTH_INTERVAL=30  # seconds between checks
LAST_CONTROL_PANE_HEALTH_STATUS=""

classify_control_pane_input_path() {
  local pane_details="${1-}"
  local session_name="${2:-$SESSION}"

  if [[ -z "$pane_details" ]]; then
    printf 'unknown\n'
    return 0
  fi

  if [[ "$pane_details" == *"wavemill-input-reader.sh"* ]]; then
    printf 'healthy\n'
    return 0
  fi

  if [[ "$pane_details" == *"/tmp/${session_name}-monitor.sh"* ]] || [[ "$pane_details" == *"wavemill-monitor.sh"* ]]; then
    printf 'drifted-monitor\n'
    return 0
  fi

  printf 'unknown\n'
}

probe_control_pane_input_path() {
  tmux display-message -p -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" \
    '#{pane_id} #{pane_pid} #{pane_current_command} #{pane_start_command}'
}

recover_control_pane_input_path() {
  local cmd_file monitor_cmd
  cmd_file="$(wavemill_command_file_path "$SESSION")"
  monitor_cmd="$(wavemill_build_control_pane_command recovery "$SESSION" "$MONITOR_SCRIPT" "$MONITOR_ENV" "$LIB_DIR")" || {
    log_warn "Control pane recovery command build failed. Append 'quit' to $cmd_file to exit safely."
    return 1
  }

  tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "$monitor_cmd" 2>/dev/null || {
    log_warn "Control pane recovery failed. Append 'quit' to $cmd_file to exit safely."
    return 1
  }

  return 0
}

check_mill_pane_health() {
  local now
  now=$(date +%s)
  (( now - LAST_DASHBOARD_HEALTH_CHECK < DASHBOARD_HEALTH_INTERVAL )) && return 0
  LAST_DASHBOARD_HEALTH_CHECK=$now

  local pane_count
  pane_count=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')

  # If panes were destroyed (layout collapsed), rebuild from scratch.
  if (( pane_count < 3 )); then
    log_warn "Control window has $pane_count pane(s) (expected 3). Rebuilding layout..."
    local status_script="$LIB_DIR/wavemill-status.sh"

    if (( pane_count == 1 )); then
      # Single pane remaining — recreate both missing panes
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -hb -p 50 "exec bash" 2>/dev/null || true
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -v -p 65 "exec bash" 2>/dev/null || true
    elif (( pane_count == 2 )); then
      # Two panes — add the missing one
      tmux split-window -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" -v -p 65 "exec bash" 2>/dev/null || true
    fi

    # Re-count after splits
    pane_count=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index}' 2>/dev/null | wc -l | tr -d ' ')
    if (( pane_count >= 3 )); then
      # Respawn dashboard (pane 1) and log (pane 2)
      tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
      tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
      # Update dashboard PID
      sleep 0.3
      local new_pid
      new_pid=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" -F '#{pane_pid}' 2>/dev/null || true)
      [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
      log "status" "Control panes rebuilt successfully"
    else
      log_warn "Failed to rebuild mill panes (got $pane_count)"
      return 0
    fi
  fi

  # All 3 panes exist — check for dead ones and respawn in place.
  local dead_panes
  dead_panes=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL" -F '#{pane_index} #{pane_dead}' 2>/dev/null || true)

  while IFS=' ' read -r idx is_dead; do
    [[ "$is_dead" == "1" ]] || continue
    case "$idx" in
      1)
        log_warn "Dashboard pane (control.1) is dead. Respawning..."
        local status_script="$LIB_DIR/wavemill-status.sh"
        tmux respawn-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'" 2>/dev/null || true
        sleep 0.3
        local new_pid
        new_pid=$(tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_MILL.1" -F '#{pane_pid}' 2>/dev/null || true)
        [[ -n "$new_pid" ]] && tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$new_pid" 2>/dev/null || true
        log "status" "Dashboard pane respawned"
        ;;
      2)
        log_warn "Log pane (control.2) is dead. Respawning..."
        tmux respawn-pane -t "$SESSION:$WAVEMILL_WINDOW_MILL.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\"" 2>/dev/null || true
        log "status" "Log pane respawned"
        ;;
    esac
  done <<<"$dead_panes"

  local pane_probe pane_status status_key cmd_file
  cmd_file="$(wavemill_command_file_path "$SESSION")"
  if ! pane_probe=$(probe_control_pane_input_path 2>/dev/null); then
    status_key="probe-failed"
    if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "$status_key" ]]; then
      log_warn "Unable to inspect control pane input path. If quit input is stuck, append 'quit' to $cmd_file."
    fi
    LAST_CONTROL_PANE_HEALTH_STATUS="$status_key"
    return 0
  fi

  pane_status="$(classify_control_pane_input_path "$pane_probe" "$SESSION")"
  case "$pane_status" in
    healthy)
      LAST_CONTROL_PANE_HEALTH_STATUS="healthy"
      return 0
      ;;
    drifted-monitor)
      if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "drifted-monitor" ]]; then
        log_warn "Control pane drift detected (pane 0 is running the monitor directly). Recovering input reader..."
      fi
      LAST_CONTROL_PANE_HEALTH_STATUS="drifted-monitor"
      recover_control_pane_input_path || true
      return 0
      ;;
    *)
      if [[ "$LAST_CONTROL_PANE_HEALTH_STATUS" != "unknown" ]]; then
        log_warn "Control pane input path is unknown. If quit input is stuck, append 'quit' to $cmd_file."
      fi
      LAST_CONTROL_PANE_HEALTH_STATUS="unknown"
      return 0
      ;;
  esac
}

handle_monitor_quit_command() {
  local active_count="${1:-0}"
  if [[ "$QUIT_REQUESTED" == "true" ]]; then
    if (( active_count == 0 )); then
      quit_and_kill_session "Quitting (all tasks complete)."
    else
      quit_and_kill_session "Force quitting (${active_count} task(s) still active)."
    fi
  elif (( active_count == 0 )); then
    quit_and_kill_session "Quitting."
  else
    log "status" "Will quit after ${active_count} active task(s) finish. Press q again to force quit."
    QUIT_REQUESTED=true
  fi
}

# ── Backstage tend-loop health watchdog ──────────────────────────────
LAST_BACKSTAGE_HEALTH_CHECK=0
BACKSTAGE_HEALTH_INTERVAL=30
BACKSTAGE_RESTART_COOLDOWN=60
LAST_BACKSTAGE_HEALTH_STATUS=""

backstage_health_enabled() {
  local merged enabled use_mill_session
  merged="$(wavemill_load_config "$REPO_DIR")"
  enabled="$(printf '%s' "$merged" | jq -r '.integration.enabled // false' 2>/dev/null || echo false)"
  use_mill_session="$(printf '%s' "$merged" | jq -r '.integration.useMillSession // true' 2>/dev/null || echo true)"
  [[ "$enabled" == "true" && "$use_mill_session" == "true" ]]
}

probe_backstage_panes() {
  tmux list-panes -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" \
    -F '#{pane_id}	#{pane_title}	#{pane_dead}	#{pane_current_command}	#{pane_start_command}'
}

read_backstage_health_field() {
  local field="$1"
  local path
  path="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  [[ -n "$path" && -f "$path" ]] || return 1
  jq -r "$field // empty" "$path" 2>/dev/null
}

classify_backstage_health() {
  local pane_details="${1-}"
  local pane_count=0 tend_alive=0 status_panes=0
  local executor_pane_id="" line pane_id pane_title pane_dead _pane_cmd _start_cmd

  if [[ -z "$pane_details" ]]; then
    printf 'backstage-missing\t\t0\t0\n'
    return 0
  fi

  while IFS=$'\t' read -r pane_id pane_title pane_dead _pane_cmd _start_cmd; do
    [[ -n "$pane_id" ]] || continue
    pane_count=$((pane_count + 1))
    if [[ "$pane_title" == "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" && "$pane_dead" != "1" ]]; then
      tend_alive=1
      executor_pane_id="$pane_id"
    fi
    if [[ "$pane_title" == "$WAVEMILL_BACKSTAGE_JOBS_PANE_TITLE" || "$pane_title" == "$WAVEMILL_BACKSTAGE_QUEUE_PANE_TITLE" ]]; then
      status_panes=$((status_panes + 1))
    fi
  done <<< "$pane_details"

  if (( tend_alive == 1 )); then
    printf 'healthy\tbackstage tend loop is running\t%s\t%s\n' "$pane_count" "$executor_pane_id"
    return 0
  fi

  if (( status_panes > 0 )); then
    printf 'missing-tend-loop\tbackstage window is missing the %s executor pane while status panes remain\t%s\t\n' "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE" "$pane_count"
    return 0
  fi

  printf 'backstage-missing\tbackstage window is unavailable\t%s\t\n' "$pane_count"
}

restart_backstage_tend_loop() {
  local integration_cmd new_pane
  integration_cmd="$(wavemill_build_tend_loop_command "$SESSION" "$REPO_DIR" "$TOOLS_DIR" "integration")"
  new_pane="$(tmux split-window -d -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE.0" -h -b -p 60 -c "$REPO_DIR" -P -F '#{pane_id}' "$integration_cmd" 2>/dev/null || true)"
  [[ -n "$new_pane" ]] || return 1
  wavemill_set_tmux_pane_title "$new_pane" "$WAVEMILL_BACKSTAGE_TEND_PANE_TITLE"
  tmux select-layout -t "$SESSION:$WAVEMILL_WINDOW_BACKSTAGE" main-vertical >/dev/null 2>&1 || true
  printf '%s\n' "$new_pane"
}

check_backstage_health() {
  local now health_file pane_probe pane_summary pane_status detail pane_count executor_pane_id
  local prior_attempt_at prior_attempt_count elapsed restart_pane_id

  now=$(date +%s)
  (( now - LAST_BACKSTAGE_HEALTH_CHECK < BACKSTAGE_HEALTH_INTERVAL )) && return 0
  LAST_BACKSTAGE_HEALTH_CHECK=$now

  health_file="$(wavemill_backstage_health_file "$STATE_DIR" 2>/dev/null || true)"
  if ! backstage_health_enabled; then
    [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "disabled" "integration mill-session backstage health checks are disabled"
    LAST_BACKSTAGE_HEALTH_STATUS="disabled"
    return 0
  fi

  pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
  pane_summary="$(classify_backstage_health "$pane_probe")"
  IFS=$'\t' read -r pane_status detail pane_count executor_pane_id <<< "$pane_summary"

  case "$pane_status" in
    healthy)
      [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "healthy" "$detail" 0 "" "$executor_pane_id"
      LAST_BACKSTAGE_HEALTH_STATUS="healthy"
      return 0
      ;;
    'backstage-missing')
      [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "backstage-missing" "$detail" 0 ""
      if [[ "$LAST_BACKSTAGE_HEALTH_STATUS" != "backstage-missing" ]]; then
        log_warn "Backstage health check could not find the backstage window."
      fi
      LAST_BACKSTAGE_HEALTH_STATUS="backstage-missing"
      return 0
      ;;
  esac

  prior_attempt_at="$(read_backstage_health_field '.lastRestartAttemptAt' || true)"
  prior_attempt_count="$(read_backstage_health_field '.restartAttemptCount' || true)"
  [[ "$prior_attempt_count" =~ ^[0-9]+$ ]] || prior_attempt_count=0
  elapsed=$BACKSTAGE_RESTART_COOLDOWN
  if [[ -n "$prior_attempt_at" ]]; then
    local prior_attempt_epoch=0
    prior_attempt_epoch="$(wavemill_iso8601_to_epoch "$prior_attempt_at" 2>/dev/null || echo 0)"
    elapsed=$(( now - prior_attempt_epoch ))
  fi

  if (( prior_attempt_count == 0 )); then
    if [[ "$LAST_BACKSTAGE_HEALTH_STATUS" != "missing-tend-loop" ]]; then
      log_warn "Backstage health check detected a missing tend loop. Attempting one restart in '$WAVEMILL_WINDOW_BACKSTAGE'."
    fi
    restart_pane_id="$(restart_backstage_tend_loop || true)"
    sleep 0.3
    pane_probe="$(probe_backstage_panes 2>/dev/null || true)"
    pane_summary="$(classify_backstage_health "$pane_probe")"
    IFS=$'\t' read -r pane_status detail pane_count executor_pane_id <<< "$pane_summary"
    if [[ "$pane_status" == "healthy" ]]; then
      [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "healthy" "backstage tend loop was restarted automatically" 0 "" "${executor_pane_id:-$restart_pane_id}"
      log "status" "Backstage tend loop restarted"
      LAST_BACKSTAGE_HEALTH_STATUS="healthy"
      return 0
    fi
    [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "missing-tend-loop" "$detail" 1 "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    LAST_BACKSTAGE_HEALTH_STATUS="missing-tend-loop"
    return 0
  fi

  if (( elapsed < BACKSTAGE_RESTART_COOLDOWN )); then
    [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "missing-tend-loop" "$detail" "$prior_attempt_count" "$prior_attempt_at"
    LAST_BACKSTAGE_HEALTH_STATUS="missing-tend-loop"
    return 0
  fi

  detail="Backstage window '$WAVEMILL_WINDOW_BACKSTAGE' is missing the ${WAVEMILL_BACKSTAGE_TEND_PANE_TITLE} executor. Restart 'npx tsx tools/tend.ts --loop --repo-dir $REPO_DIR' in tmux."
  [[ -n "$health_file" ]] && wavemill_write_backstage_health "$health_file" "needs-user" "$detail" "$prior_attempt_count" "$prior_attempt_at"
  if [[ "$LAST_BACKSTAGE_HEALTH_STATUS" != "needs-user" ]]; then
    log_warn "$detail"
  fi
  LAST_BACKSTAGE_HEALTH_STATUS="needs-user"
}

while :; do
  # ── Phase A: Monitor existing tasks ──────────────────────────────────
  _update_effective_max_parallel
  run_linear_retry_drain_tick
  drain_command_events
  while consume_next_command; do
    case "$REPLY" in
      quit)
        handle_monitor_quit_command "${_active_count_prev}"
        ;;
      *)
        requeue_consumed_command_front
        break
        ;;
    esac
  done
  poll_challenge_jobs
  check_backstage_health
  run_ready_watchdog_tick
  check_mill_pane_health
  wavemill_pr_cache_refresh
  refresh_ready_merge_queue_tick
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
        handle_monitor_quit_command "$active_count"
      fi
    fi
    poll_sleep "$POLL_SECONDS"
    continue
  fi

  # ── Phase C: Offer new tasks if slots available ─────────────────────
  # Challengers are free overhead — don't count them against MAX_PARALLEL
  free_slots=$((EFFECTIVE_MAX_PARALLEL - (active_count - active_challenger_count)))
  update_free_slots_state "$free_slots"

  if (( free_slots <= 0 )); then
    refresh_backlog_cache
    candidates=$(print_cached_candidates)
    available=""
    [[ -n "$candidates" ]] && available=$(filter_active_issues "$candidates")

    display_fingerprint="slots-full|${active_count}|${available}"
    if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
      _task_frame="Next tasks (slots full):"$'\n'
      if [[ -n "$available" ]]; then
        _task_frame+="$(echo "$available" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}')"
      elif [[ -n "$candidates" ]]; then
        _task_frame+="  (all listed backlog tasks are already active)"$'\n'
      else
        _task_frame+="  (backlog empty)"$'\n'
      fi
      _task_frame+=$'\n'"0 slots available; waiting for active tasks to finish. Press 'q' to quit or wait ${POLL_SECONDS}s to refresh."$'\n'

      paint_task_list_frame "$_task_frame"
      LAST_DISPLAY="$display_fingerprint"
      LAST_ACTIVE_COUNT=$active_count
      LAST_WAITING_MSG=""
    fi

    poll_sleep "$POLL_SECONDS"
    continue
  fi

  if (( free_slots > 0 )); then
    refresh_backlog_cache
    candidates=$(print_cached_candidates)

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
        display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}|${queue_fp}|${_backlog_budget:-}|${_backlog_expanded:-}|${_deps_expanded:-}"
        if [[ "$display_fingerprint" != "$LAST_DISPLAY" ]] || (( active_count != LAST_ACTIVE_COUNT )); then
          SELECT_SHOW_ALL=false

          # Gather data first so old content stays visible during queue analysis.
          queue_plan_json=""
          queue_plan_diag_file=""
          queue_plan_diag_previous="${FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE:-}"
          queue_plan_diag_file="$(mktemp -t wavemill-fqp-diagnostics.XXXXXX 2>/dev/null || true)"
          FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_file"
          GROUPED_DISPLAY=""
          GROUPED_SELECT_FROM=""
          _backlog_default_expanded="$(wavemill_load_config "$REPO_DIR" | jq -r '.backlog.defaultExpanded // false' 2>/dev/null || echo "false")"
          _backlog_expanded="$(jq -r --arg def "$_backlog_default_expanded" '.backlogExpanded // $def' "$STATE_FILE" 2>/dev/null || echo "$_backlog_default_expanded")"
          _deps_expanded="$(jq -r --arg def "false" '.depsExpanded // $def' "$STATE_FILE" 2>/dev/null || echo "false")"
          _backlog_budget="$(wavemill_backlog_compute_budget "$SESSION" "$WAVEMILL_WINDOW_MILL.0" "$REPO_DIR/.wavemill-config.json" 2>/dev/null || echo 20)"
          _active_issue_ids=""
          for _ai in "${!BRANCH_BY_ISSUE[@]}"; do
            [[ -n "${CLEANED[$_ai]:-}" ]] && continue
            _active_issue_ids+="${_ai}"$'\n'
          done
          if queue_plan_json=$(fetch_queue_plan 2>/dev/null); then
            if [[ -n "$queue_plan_json" ]]; then
              QUEUE_PLAN_CACHE="$queue_plan_json"
              LAST_QUEUE_PLAN_FETCH=$(date +%s)
            fi
            render_grouped_task_list "$queue_plan_json" "$available" "$_backlog_budget" "$_backlog_expanded" "$_deps_expanded" "$_active_issue_ids" || true
            if [[ -n "$GROUPED_DISPLAY" ]]; then
              select_from="$GROUPED_SELECT_FROM"
              USING_GROUPED_VIEW=true
            fi
          fi
          if [[ -z "$GROUPED_DISPLAY" ]]; then
            USING_GROUPED_VIEW=false
            if [[ -z "$queue_plan_json" ]]; then
              _queue_reason="$(get_queue_failure_reason "${queue_plan_diag_file:-}")"
              log_warn "queue analysis unavailable (reason: ${_queue_reason:-unknown}), falling back to flat list"
              [[ -n "$queue_plan_diag_file" ]] && log_fetch_queue_plan_failure "$queue_plan_diag_file"
            fi
          fi
          queue_fp="${queue_plan_json:0:50}"
          display_fingerprint="${free_slots}|${avail_unblocked}|${avail_blocked_count}|${queue_fp}|${_backlog_budget}|${_backlog_expanded}|${_deps_expanded}"
          rm -f "$queue_plan_diag_file"
          FETCH_QUEUE_PLAN_DIAGNOSTICS_FILE="$queue_plan_diag_previous"

          _task_frame="Next tasks:"$'\n'
          if [[ -n "$GROUPED_DISPLAY" ]]; then
            _task_frame+="${GROUPED_DISPLAY}"$'\n'
          else
            if [[ -n "$avail_unblocked" ]]; then
              _task_frame+="$(echo "$avail_unblocked" | head -9 | awk -F'|' '{printf "  %s. %s - %s (score: %.0f)\n", NR, $1, $3, $5}')"
            else
              _task_frame+="  (no unblocked tasks)"$'\n'
            fi
            if (( avail_blocked_count > 0 )); then
              _task_frame+=$'\n'"  ($avail_blocked_count blocked task(s) hidden — enter 'm' to show all)"$'\n'
            fi
          fi
          _task_frame+=$'\n'
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'm' for more, 'd' for deps, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          elif (( avail_blocked_count > 0 )); then
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'm' for more, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          else
            _task_frame+="Enter number(s) to start (e.g. 1 3), press Enter to launch recommended wave, 'q' to quit, or wait ${POLL_SECONDS}s to refresh:"$'\n'
          fi

          paint_task_list_frame "$_task_frame"
          LAST_DISPLAY="$display_fingerprint"
          LAST_ACTIVE_COUNT=$active_count
          LAST_WAITING_MSG=""  # Clear waiting state when tasks are available
        fi

        # Default: selection against unblocked list only
        select_from="$avail_unblocked"
        if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
          select_from="$GROUPED_SELECT_FROM"
        elif [[ "$SELECT_SHOW_ALL" == "true" ]]; then
          select_from=$(printf '%s\n%s' "$avail_unblocked" "$avail_blocked" | grep .)
        fi

        REPLY=""
        MONITOR_PHASE_C_REPLY_OFFSET=""
        if consume_next_command; then
          MONITOR_PHASE_C_REPLY_OFFSET="${REPLY_OFFSET:-}"
          REPLY="$(normalize_prompt_command_reply "$REPLY")"
        fi

        if [[ "$REPLY" =~ ^[Qq]$ ]]; then
          handle_monitor_quit_command "$active_count"
        elif [[ "$REPLY" =~ ^[mM]$ ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            state_mutate "$STATE_FILE" \
              '.backlogExpanded = (if (.backlogExpanded // false) then false else true end) | .updated = (now | todate)'
            LAST_DISPLAY=""
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
        elif [[ "$REPLY" =~ ^[dD]$ ]]; then
          if [[ "$USING_GROUPED_VIEW" == "true" ]]; then
            state_mutate "$STATE_FILE" \
              '.depsExpanded = (if (.depsExpanded // false) then false else true end) | .updated = (now | todate)'
            LAST_DISPLAY=""
          fi
        elif [[ "$REPLY" == advance\ * ]]; then
          execute_or_defer_monitor_command "new" "$REPLY" "$MONITOR_PHASE_C_REPLY_OFFSET" "$free_slots" "$queue_plan_json" "$avail_unblocked" "$avail_blocked" "$select_from"
          MONITOR_PHASE_C_REPLY_OFFSET=""
        elif [[ "$REPLY" =~ ^unknown\  ]]; then
          log_warn "Unknown input: ${REPLY#unknown }"
        elif [[ "$REPLY" == "enter" ]]; then
          if [[ "${ENTER_LAUNCHES_WAVE:-true}" == "true" ]]; then
            wave_plan_json="${queue_plan_json:-$QUEUE_PLAN_CACHE}"
            if [[ -n "$wave_plan_json" ]]; then
              wave_result=$(invoke_first_wave_helper "$wave_plan_json" "$avail_unblocked" "$free_slots" 2>/dev/null) || wave_result=""
            else
              wave_result=""
            fi
            if [[ -n "$wave_result" ]]; then
              wave_ids=$(jq -r '.wave[]?' <<<"$wave_result" 2>/dev/null) || wave_ids=""
              deferred_ids=$(jq -r '.deferred[]?' <<<"$wave_result" 2>/dev/null) || deferred_ids=""
              if [[ -z "$wave_ids" ]]; then
                log "status" "No tasks currently available, waiting on dependencies."
              else
                [[ -n "$deferred_ids" ]] && log "debug" "[wave-launch] deferred=$(tr '\n' ',' <<<"$deferred_ids" | sed 's/,$//')"
                wave_selected_lines=""
                while IFS= read -r wid; do
                  [[ -z "$wid" ]] && continue
                  wline=$(grep -m1 "^${wid}|" <<<"$avail_unblocked" 2>/dev/null || echo "")
                  [[ -n "$wline" ]] && wave_selected_lines+="${wline}"$'\n'
                done <<<"$wave_ids"
                if [[ -n "$wave_selected_lines" ]]; then
                  launched=0
                  while IFS= read -r local_line; do
                    [[ -z "$local_line" ]] && continue
                    (( launched >= free_slots )) && break
                    IFS='|' read -r sel_issue sel_slug sel_title _rest <<<"$local_line"
                    launch_task "$sel_issue" "$sel_slug" "$sel_title" "$((free_slots - launched))"
                    launched=$((launched + LAST_LAUNCHED_SLOTS))
                  done <<<"$wave_selected_lines"
                  LAST_BACKLOG_FETCH=0; LAST_DISPLAY=""; SELECT_SHOW_ALL=false
                  USING_GROUPED_VIEW=false
                  clear_task_list_display
                fi
              fi
            fi
          fi
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
        if [[ -n "$MONITOR_PHASE_C_REPLY_OFFSET" ]]; then
          acknowledge_command_offset "$MONITOR_PHASE_C_REPLY_OFFSET"
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
#      `log "info" "  Type 'q' in mill window to quit"` are syntactically correct
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
if [[ "$DRY_RUN" == "true" ]]; then
  log "info" "Dry-run: skipping forced base-branch fetch."
else
  if ! wavemill_fetch_base_branch "$BASE_BRANCH" --force; then
    log_warn "Startup fetch for $BASE_BRANCH degraded; continuing mill startup with local base-branch state"
  fi
fi

: > "$STATUS_LOG_FILE"
: > "$LAUNCHED_ISSUES_FILE"

LAUNCH_PLAN_FILE="${WAVEMILL_DRY_RUN_PLAN_OUT:-/tmp/${SESSION}-launch-plan.json}"
if ! mkdir -p "$(dirname "$LAUNCH_PLAN_FILE")"; then
  log_error "Failed to create launch-plan directory: $(dirname "$LAUNCH_PLAN_FILE")"
  exit 1
fi
LAUNCH_QUEUE_PLAN=""
if [[ -n "${QUEUE_PLAN_CACHE:-}" ]]; then
  LAUNCH_QUEUE_PLAN="$QUEUE_PLAN_CACHE"
elif [[ -n "${BACKLOG_JSON_CACHE:-}" ]]; then
  LAUNCH_QUEUE_PLAN="$(build_queue_plan_once "$BACKLOG_JSON_CACHE" 2>/dev/null)" || LAUNCH_QUEUE_PLAN=""
fi
write_launch_plan "$LAUNCH_PLAN_FILE" "$LAUNCH_QUEUE_PLAN"
if ! jq empty "$LAUNCH_PLAN_FILE" >/dev/null 2>&1; then
  log_error "Generated launch plan is not valid JSON: $LAUNCH_PLAN_FILE"
  exit 1
fi

if [[ "$DRY_RUN" == "true" ]]; then
  log "status" "Dry-run launch plan written: $LAUNCH_PLAN_FILE"
  exit 0
fi

STARTUP_RUNNER="$SCRIPT_DIR/wavemill-startup-runner.sh"
if [[ ! -f "$STARTUP_RUNNER" ]]; then
  echo "Error: wavemill-startup-runner.sh not found at $STARTUP_RUNNER" >&2
  exit 1
fi

log "status" "Creating tmux session..."
create_tmux_session

printf -v STARTUP_CMD '%q %q' "$STARTUP_RUNNER" "$LAUNCH_PLAN_FILE"
STARTUP_CMD="/opt/homebrew/bin/bash $STARTUP_CMD"
tmux respawn-pane -k -t "$SESSION:$WAVEMILL_WINDOW_MILL.0" "$STARTUP_CMD"


# Now attach to the session
log "status" "Attaching to session: $SESSION"
log "info" "  Ctrl+B then W to switch windows"
log "info" "  Ctrl+B then D to detach"
log "info" "  Type 'q' in mill window to quit"
log "info" "  Or: touch $STATE_DIR/.stop-loop"
echo ""
sleep 1
set +e
tmux attach -t "$SESSION"
attach_rc=$?
set -e

if [[ "$attach_rc" -ne 0 && "$attach_rc" -ne 1 ]]; then
  log_warn "tmux attach exited with status $attach_rc"
fi

log "status" "Session ended. Run 'git -C $REPO_DIR worktree prune' if needed."
