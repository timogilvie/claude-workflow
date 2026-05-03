#!/opt/homebrew/bin/bash
set -Eeuo pipefail

command -v tmux >/dev/null || { echo "Error: tmux is required but not installed" >&2; exit 1; }
command -v git >/dev/null || { echo "Error: git is required but not installed" >&2; exit 1; }
command -v npx >/dev/null || { echo "Error: npx is required but not installed" >&2; exit 1; }
command -v jq >/dev/null || { echo "Error: jq is required but not installed" >&2; exit 1; }

PLAN_FILE="${1:-}"
if [[ -z "$PLAN_FILE" || ! -f "$PLAN_FILE" ]]; then
  echo "Usage: $0 /tmp/<session>-launch-plan.json" >&2
  exit 1
fi

if [[ ! -t 2 ]]; then
  export WAVEMILL_NO_PROGRESS=1
fi

SESSION="$(jq -r '.session' "$PLAN_FILE")"
REPO_DIR="$(jq -r '.repoDir' "$PLAN_FILE")"
BASE_BRANCH="$(jq -r '.baseBranch' "$PLAN_FILE")"
WORKTREE_ROOT="$(jq -r '.worktreeRoot' "$PLAN_FILE")"
PLANNING_MODE="$(jq -r '.planningMode' "$PLAN_FILE")"
if [[ "$PLANNING_MODE" != "interactive" ]]; then
  startup_log "Warning: planningMode='$PLANNING_MODE' is no longer supported; forcing interactive planning."
  PLANNING_MODE="interactive"
fi
AGENT_CMD="$(jq -r '.agentCmd' "$PLAN_FILE")"
AGENT_CMD_EXPLICIT="$(jq -r '.agentCmdExplicit // false' "$PLAN_FILE")"
FORCE_MODEL="$(jq -r '.forceModel // empty' "$PLAN_FILE")"
ROUTER_ENABLED="$(jq -r '.routerEnabled // true' "$PLAN_FILE")"
MAX_PARALLEL="$(jq -r '.maxParallel // 0' "$PLAN_FILE")"
STATE_DIR="$(jq -r '.stateDir' "$PLAN_FILE")"
STATE_FILE="$(jq -r '.stateFile' "$PLAN_FILE")"
TOOLS_DIR="$(jq -r '.toolsDir' "$PLAN_FILE")"
LIB_DIR="$(jq -r '.libDir' "$PLAN_FILE")"
INITIAL_PHASE="$(jq -r '.initialPhase' "$PLAN_FILE")"
STATUS_LOG_FILE="$(jq -r '.startupConfig.statusLogFile' "$PLAN_FILE")"
MONITOR_ENV="$(jq -r '.startupConfig.monitorEnv' "$PLAN_FILE")"
MONITOR_SCRIPT="$(jq -r '.startupConfig.monitorScript' "$PLAN_FILE")"
LAUNCHED_ISSUES_FILE="$(jq -r '.startupConfig.launchedIssuesFile' "$PLAN_FILE")"
MILL_LOG_FILE="$(jq -r '.startupConfig.millLogFile // empty' "$PLAN_FILE")"
POLL_SECONDS="$(jq -r '.monitorConfig.pollSeconds // 10' "$PLAN_FILE")"
REQUIRE_CONFIRM="$(jq -r '.monitorConfig.requireConfirm // true' "$PLAN_FILE")"
DRY_RUN="$(jq -r '.monitorConfig.dryRun // false' "$PLAN_FILE")"
PROJECT_NAME="$(jq -r '.monitorConfig.projectName // empty' "$PLAN_FILE")"
AUTO_EVAL="$(jq -r '.monitorConfig.autoEval // true' "$PLAN_FILE")"
DASHBOARD_VERBOSITY="$(jq -r '.monitorConfig.dashboardVerbosity // "info"' "$PLAN_FILE")"
DASHBOARD_LOG_TO_FILE="$(jq -r '.monitorConfig.dashboardLogToFile // true' "$PLAN_FILE")"
DASHBOARD_PID=""

export SESSION REPO_DIR BASE_BRANCH WORKTREE_ROOT PLANNING_MODE AGENT_CMD AGENT_CMD_EXPLICIT
export FORCE_MODEL ROUTER_ENABLED MAX_PARALLEL STATE_DIR STATE_FILE TOOLS_DIR LIB_DIR
export POLL_SECONDS REQUIRE_CONFIRM DRY_RUN PROJECT_NAME AUTO_EVAL DASHBOARD_VERBOSITY
export DASHBOARD_LOG_TO_FILE MILL_LOG_FILE

source "$LIB_DIR/wavemill-common.sh"
source "$LIB_DIR/agent-adapters.sh"
source "$LIB_DIR/startup-progress.sh"

write_shell_assignment() {
  local name="$1" value="${2-}"
  printf '%s=' "$name"
  printf '%q\n' "$value"
}

startup_log() {
  local line="$*"
  if [[ -n "${STARTUP_TASK_LOG_FILE:-}" ]]; then
    printf '%s\n' "$line" >> "$STARTUP_TASK_LOG_FILE" 2>/dev/null || true
    return 0
  fi
  # DO NOT add printf to stdout here - causes [1/7] messages to bleed into monitor pane (HOK-1282)
  # Startup messages are already displayed in pane 2 via tail -f of STATUS_LOG_FILE
  [[ -n "${STATUS_LOG_FILE:-}" ]] && printf '%s\n' "$line" >> "$STATUS_LOG_FILE" 2>/dev/null || true
}

startup_step() {
  local message="$1"
  startup_log "  $message"
}

write_stage_result_local() {
  local feature_dir="$1" stage="$2" status="$3"
  local agent="${4:-}" model="${5:-}" notes="${6:-}"
  local result_file="$feature_dir/.${stage}-result.json"
  local now started_at finished_at tmp

  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  mkdir -p "$feature_dir"

  started_at="$now"
  if [[ -f "$result_file" ]]; then
    local prev_start
    prev_start=$(jq -r '.startedAt // empty' "$result_file" 2>/dev/null || echo "")
    [[ -n "$prev_start" ]] && started_at="$prev_start"
  fi

  finished_at="null"
  if [[ "$status" == "completed" || "$status" == "aborted" || "$status" == "failed" ]]; then
    finished_at="\"$now\""
  fi

  tmp=$(mktemp) || return 1
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

startup_state_lock_acquire() {
  local lock_dir="${STATE_FILE}.lock"
  local attempt
  for attempt in {1..200}; do
    if mkdir "$lock_dir" 2>/dev/null; then
      STARTUP_STATE_LOCK_DIR="$lock_dir"
      return 0
    fi
    sleep 0.05
  done
  return 1
}

startup_state_lock_release() {
  [[ -n "${STARTUP_STATE_LOCK_DIR:-}" ]] && rmdir "$STARTUP_STATE_LOCK_DIR" 2>/dev/null || true
  STARTUP_STATE_LOCK_DIR=""
}

reset_startup_phase_artifacts() {
  local feature_dir="$1"

  rm -f \
    "$feature_dir/.planning-result.json" \
    "$feature_dir/.coding-result.json" \
    "$feature_dir/.review-result.json" \
    "$feature_dir/.ready-result.json" \
    "$feature_dir/.resolved-phase" \
    "$feature_dir/.plan-approved" \
    "$feature_dir/.coding-complete" \
    "$feature_dir/.review-complete" \
    "$feature_dir/.ready-complete" \
    "$feature_dir/.workflow-aborted" \
    "$feature_dir/plan.md"
}

save_task_state() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" pr="${5:-}" status="${6:-}" agent="${7:-}"
  local linear_issue="${8:-$issue}" challenge="${9:-}" challenge_pair="${10:-}" challenge_role="${11:-}" challenge_model="${12:-}"
  local planner_model="${13:-}" coder_model="${14:-}" reviewer_model="${15:-}" plan_depth="${16:-}" code_depth="${17:-}" review_mode="${18:-}" phase="${19:-}"
  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = (.tasks[$issue] // {}) + {
        slug: $slug,
        branch: $branch,
        worktree: $worktree,
        pr: $pr,
        status: $status,
        linearIssueId: $linearIssue,
        updated: (now | todate)
      } + (if $phase != "" then {phase: $phase} else {} end)
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
      | if $reviewMode != "" then .tasks[$issue].reviewMode = $reviewMode else . end
      | if $phase != "" then .tasks[$issue].phase = $phase else . end' \
    --arg issue "$issue" --arg slug "$slug" --arg branch "$branch" \
    --arg worktree "$worktree" --arg pr "$pr" --arg status "$status" --arg agent "$agent" \
    --arg linearIssue "$linear_issue" --arg challenge "$challenge" --arg challengePair "$challenge_pair" \
    --arg challengeRole "$challenge_role" --arg challengeModel "$challenge_model" \
    --arg plannerModel "$planner_model" --arg coderModel "$coder_model" --arg reviewerModel "$reviewer_model" \
    --arg planDepth "$plan_depth" --arg codeDepth "$code_depth" --arg reviewMode "$review_mode" --arg phase "$phase"
}

remove_task_state() {
  local issue="$1"
  state_mutate "$STATE_FILE" 'del(.tasks[$issue]) | .updated = (now | todate)' --arg issue "$issue"
}

set_task_phase_local() {
  local issue="$1" phase="$2"
  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ((.tasks[$issue] // {}) + {
      phase: $phase,
      updated: (now | todate)
    })' \
    --arg issue "$issue" --arg phase "$phase"
}

linear_set_state() {
  local issue="$1" state="$2"
  [[ "$DRY_RUN" == "true" ]] && return 0
  npx tsx "$TOOLS_DIR/set-issue-state.ts" "$issue" "$state" >/dev/null 2>&1
}

linear_batch_set_state() {
  local state="$1"
  shift || true
  local -a issues=("$@")
  local output exit_code=0
  [[ "$DRY_RUN" == "true" ]] && return 0
  [[ "${#issues[@]}" -eq 0 ]] && return 0

  output="$(npx tsx "$TOOLS_DIR/set-issues-state.ts" --state "$state" "${issues[@]}" 2>/dev/null)" || exit_code=$?

  if jq -e '.failed | length > 0' >/dev/null 2>&1 <<<"$output"; then
    while IFS= read -r failure; do
      startup_log "WARN: Linear state update to '$state' failed for $failure"
    done < <(jq -r '.failed[] | "\(.issueId): \(.error)"' <<<"$output")
  elif [[ "$exit_code" -ne 0 ]]; then
    startup_log "WARN: Batch Linear state update to '$state' failed for ${#issues[@]} issue(s)"
  fi
  return 0
}

ensure_state_file() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    printf '{"session":"%s","started":"%s","tasks":{}}\n' \
      "$SESSION" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_FILE"
  fi
}

write_monitor_env() {
  local tasks_file="$1"
  {
    write_shell_assignment "SESSION" "$SESSION"
    write_shell_assignment "REPO_DIR" "$REPO_DIR"
    write_shell_assignment "WORKTREE_ROOT" "$WORKTREE_ROOT"
    write_shell_assignment "TOOLS_DIR" "$TOOLS_DIR"
    write_shell_assignment "LIB_DIR" "$LIB_DIR"
    write_shell_assignment "STATE_DIR" "$STATE_DIR"
    write_shell_assignment "STATE_FILE" "$STATE_FILE"
    write_shell_assignment "POLL_SECONDS" "$POLL_SECONDS"
    write_shell_assignment "REQUIRE_CONFIRM" "$REQUIRE_CONFIRM"
    write_shell_assignment "DRY_RUN" "$DRY_RUN"
    write_shell_assignment "BASE_BRANCH" "$BASE_BRANCH"
    write_shell_assignment "PROJECT_NAME" "$PROJECT_NAME"
    write_shell_assignment "PLANNING_MODE" "$PLANNING_MODE"
    write_shell_assignment "AGENT_CMD" "$AGENT_CMD"
    write_shell_assignment "AGENT_CMD_EXPLICIT" "$AGENT_CMD_EXPLICIT"
    write_shell_assignment "ROUTER_ENABLED" "$ROUTER_ENABLED"
    write_shell_assignment "MAX_PARALLEL" "$MAX_PARALLEL"
    write_shell_assignment "AUTO_EVAL" "$AUTO_EVAL"
    write_shell_assignment "DASHBOARD_VERBOSITY" "$DASHBOARD_VERBOSITY"
    write_shell_assignment "DASHBOARD_LOG_TO_FILE" "$DASHBOARD_LOG_TO_FILE"
    write_shell_assignment "WAVEMILL_DASHBOARD_PID" "${WAVEMILL_DASHBOARD_PID:-}"
    write_shell_assignment "MILL_LOG_FILE" "$MILL_LOG_FILE"
    write_shell_assignment "STATUS_LOG_FILE" "$STATUS_LOG_FILE"
    write_shell_assignment "TASKS_FILE" "$tasks_file"
    write_shell_assignment "CHALLENGE_AUTO_MERGE" "${CHALLENGE_AUTO_MERGE:-false}"
  } > "$MONITOR_ENV"
}

setup_control_dashboard() {
  local status_script="$LIB_DIR/wavemill-status.sh"
  local pane_count
  pane_count=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index}' | wc -l | tr -d ' ')
  if [[ "$pane_count" -eq 1 ]]; then
    # Split 1: vertical split — top-left (pane 0, 35%) / bottom-left (pane 1, 65%)
    tmux split-window -t "$SESSION:control.0" -v -p 65
    # Split 2: full-height horizontal — right pane (pane 2, 50%) spans full window height
    tmux split-window -t "$SESSION:control.0" -h -f -p 50
  elif [[ "$pane_count" -eq 2 ]]; then
    tmux split-window -t "$SESSION:control.0" -h -f -p 50
  fi
  # Pane 0 = top-left (monitor, set later in main)
  # Pane 1 = bottom-left (dashboard)
  # Pane 2 = right full-height (status log)
  tmux respawn-pane -k -t "$SESSION:control.1" "'$status_script' '$SESSION' '$WORKTREE_ROOT' '$STATE_FILE'"

  WAVEMILL_DASHBOARD_PID=""
  for attempt in {1..10}; do
    WAVEMILL_DASHBOARD_PID="$(tmux list-panes -t "$SESSION:control.1" -F '#{pane_pid}' 2>/dev/null || true)"
    [[ -n "$WAVEMILL_DASHBOARD_PID" ]] && break
    sleep 0.1
  done

  if [[ -n "${WAVEMILL_DASHBOARD_PID:-}" ]]; then
    tmux set-environment -t "$SESSION" WAVEMILL_DASHBOARD_PID "$WAVEMILL_DASHBOARD_PID"
  fi

  tmux respawn-pane -k -t "$SESSION:control.2" "bash -c \"clear && printf 'Wavemill Status Log\\n\\n' && tail -n 200 -f '$STATUS_LOG_FILE'\""
  tmux select-pane -t "$SESSION:control.0"
}

spawn_integration_window() {
  local merged enabled use_mill_session integration_cmd

  merged="$(wavemill_load_config "$REPO_DIR")"
  enabled="$(printf '%s' "$merged" | jq -r '.integration.enabled // false' 2>/dev/null || echo false)"
  use_mill_session="$(printf '%s' "$merged" | jq -r '.integration.useMillSession // true' 2>/dev/null || echo true)"

  if [[ "$enabled" != "true" || "$use_mill_session" != "true" ]]; then
    return 0
  fi

  startup_log "Starting integration window (tend loop)..."
  printf -v integration_cmd 'exec env WAVEMILL_SESSION=%q WAVEMILL_ISSUE=%q npx tsx %q --loop --repo-dir %q' \
    "$SESSION" "integration" "$TOOLS_DIR/tend.ts" "$REPO_DIR"
  tmux new-window -d -t "$SESSION" -n integration -c "$REPO_DIR" "$integration_cmd" >/dev/null
  tmux set-window-option -u -t "$SESSION:integration" window-status-style >/dev/null 2>&1 || true
  tmux set-window-option -u -t "$SESSION:integration" window-status-current-style >/dev/null 2>&1 || true
  tmux set-option -t "$SESSION:integration" remain-on-exit off >/dev/null 2>&1 || true
  startup_log "✓ Integration window running."
}

should_update_linear_for_task() {
  local challenge_role="$1"
  [[ "$challenge_role" != "challenger" ]]
}

startup_mark_remaining_skipped() {
  local task_id="$1" current_col="$2"
  local cols=(route worktree deps agent linear)
  local seen_current=false col
  [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]] && return 0
  for col in "${cols[@]}"; do
    if [[ "$col" == "$current_col" ]]; then
      seen_current=true
      continue
    fi
    [[ "$seen_current" == "true" ]] && progress_update "$task_id" "$col" skipped
  done
}

startup_phase_failed() {
  local task_id="$1" col="$2" issue="$3" message="$4"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$task_id" "$col" failed "$message"
  startup_mark_remaining_skipped "$task_id" "$col"
  startup_log "✗ $issue FAILED at $col: $message"
}

# Install JS deps in a worktree when a lockfile is present and node_modules is
# missing. Worktrees created by `git worktree add` start without node_modules,
# so test scripts that depend on local .bin binaries (jest, ts-node, etc.) fail
# unless we install. Detects the package manager from the lockfile and skips
# silently for non-JS repos.
ensure_worktree_dependencies() {
  local wt_dir="$1" issue="$2"
  local pm="" lockfile="" install_cmd=""

  if [[ -f "$wt_dir/pnpm-lock.yaml" ]]; then
    pm="pnpm"; lockfile="pnpm-lock.yaml"
    install_cmd="pnpm install --frozen-lockfile --prefer-offline"
  elif [[ -f "$wt_dir/yarn.lock" ]]; then
    pm="yarn"; lockfile="yarn.lock"
    install_cmd="yarn install --frozen-lockfile --prefer-offline"
  elif [[ -f "$wt_dir/package-lock.json" ]]; then
    pm="npm"; lockfile="package-lock.json"
    install_cmd="npm ci --prefer-offline"
  else
    return 0
  fi

  if [[ -d "$wt_dir/node_modules" ]]; then
    return 0
  fi

  if ! command -v "$pm" >/dev/null 2>&1; then
    startup_log "  Warning: $lockfile present but '$pm' not on PATH; skipping dep install"
    return 0
  fi

  startup_step "[1.5/7] Installing deps ($pm)..."
  local install_stderr
  install_stderr="$(mktemp)"
  if ! (cd "$wt_dir" && eval "$install_cmd") >/dev/null 2>"$install_stderr"; then
    startup_log "✗ $issue FAILED at step [1.5/7]: $pm install"
    [[ -s "$install_stderr" ]] && tail -n 40 "$install_stderr" | sed 's/^/  '"$pm"': /' >> "$STATUS_LOG_FILE"
    [[ -s "$install_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && tail -n 40 "$install_stderr" | sed 's/^/  '"$pm"': /' >> "$STARTUP_TASK_LOG_FILE"
    rm -f "$install_stderr"
    startup_log "  Task will not be launched. Retry with: wavemill mill"
    return 1
  fi
  rm -f "$install_stderr"
  startup_step "[1.5/7] Installing deps ($pm)... ✓"
  return 0
}

startup_run_task_phases() {
  local task_json="$1" ordinal="${2:-}" total="${3:-}"
  local issue slug title branch wt_dir linear_issue task_packet_file details_file issue_json_file
  local planner_model coder_model reviewer_model plan_depth code_depth review_mode route_max_cost_usd
  local challenge challenge_pair challenge_role challenge_model task_agent win
  local packet_content issue_json issue_description issue_context details_context labels_json
  local feature_dir status_file planning_prompt instr_file created_window state_written created_new=false

  local startup_id
  startup_id="$(echo "$task_json" | jq -r '.startupId // empty')"
  issue="$(echo "$task_json" | jq -r '.issue')"
  [[ -z "$startup_id" || "$startup_id" == "null" ]] && startup_id="${ordinal:-1}"
  [[ -z "$ordinal" ]] && ordinal="$startup_id"
  if [[ -z "$total" ]]; then
    total="$(echo "$task_json" | jq -r '.startupTotal // empty')"
  fi
  slug="$(echo "$task_json" | jq -r '.slug')"
  title="$(echo "$task_json" | jq -r '.title')"
  branch="$(echo "$task_json" | jq -r '.branch')"
  wt_dir="$(echo "$task_json" | jq -r '.worktreeDir')"
  linear_issue="$(echo "$task_json" | jq -r '.linearIssueId // .issue')"
  task_packet_file="$(echo "$task_json" | jq -r '.taskPacketFile')"
  details_file="$(echo "$task_json" | jq -r '.taskPacketDetailsFile')"
  issue_json_file="$(echo "$task_json" | jq -r '.issueJsonFile')"
  planner_model="$(echo "$task_json" | jq -r '.route.planner // empty')"
  coder_model="$(echo "$task_json" | jq -r '.route.coder // empty')"
  reviewer_model="$(echo "$task_json" | jq -r '.route.reviewer // empty')"
  plan_depth="$(echo "$task_json" | jq -r '.route.planDepth // "light"')"
  code_depth="$(echo "$task_json" | jq -r '.route.codeDepth // "medium"')"
  review_mode="$(echo "$task_json" | jq -r '.route.reviewMode // "static"')"
  route_max_cost_usd="$(echo "$task_json" | jq -r '.route.maxCostUsd // empty')"
  challenge="$(echo "$task_json" | jq -r '.challenge // false')"
  challenge_pair="$(echo "$task_json" | jq -r '.challengePairId // empty')"
  challenge_role="$(echo "$task_json" | jq -r '.challengeRole // empty')"
  challenge_model="$(echo "$task_json" | jq -r '.challengeModel // empty')"
  task_agent="$(echo "$task_json" | jq -r '.agent // empty')"
  STARTUP_TASK_LOG_FILE=""
  if [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]]; then
    STARTUP_TASK_LOG_FILE="/tmp/wavemill-${SESSION}-${issue}.startup.log"
    : > "$STARTUP_TASK_LOG_FILE"
    progress_update "$startup_id" issue "$issue"
    progress_update "$startup_id" route running
  fi

  if ! [[ "$issue" =~ ^[A-Z]+-[0-9]+(_c)?$|^[a-z0-9-]+$ ]]; then
    startup_phase_failed "$startup_id" route "$issue" "invalid issue id"
    return 1
  fi

  [[ -z "$task_agent" ]] && task_agent="$AGENT_CMD"
  [[ -z "$coder_model" && -n "$challenge_model" ]] && coder_model="$challenge_model"
  [[ -z "$coder_model" && -n "$FORCE_MODEL" ]] && coder_model="$FORCE_MODEL"

  if ! agent_validate "$task_agent"; then
    startup_phase_failed "$startup_id" route "$issue" "agent unavailable"
    return 1
  fi
  if [[ "$task_agent" != "$AGENT_CMD" ]] && ! agent_check_auth "$task_agent" "$coder_model" "$REPO_DIR"; then
    startup_phase_failed "$startup_id" route "$issue" "agent unauthenticated"
    return 1
  fi

  if [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]]; then
    startup_log ""
    startup_log "── Task ${ordinal}/${total}: $issue ($slug) ──"
    startup_log "[${ordinal}/${total}] launching $issue"
  else
    startup_log "── Task $issue ($slug) ──"
    progress_update "$startup_id" route done
    progress_update "$startup_id" worktree running
  fi

  if [[ -d "$wt_dir" ]]; then
    startup_step "[1/7] Reusing worktree...       ✓"
  else
    local worktree_stderr
    worktree_stderr="$(mktemp)"
    if git show-ref --verify --quiet "refs/heads/$branch"; then
      local resolved_path
      if ! resolved_path="$(wavemill_lock_run "git-worktree" ensure_worktree "$branch" "$wt_dir" 2>"$worktree_stderr")"; then
        startup_phase_failed "$startup_id" worktree "$issue" "worktree creation"
        startup_log "  Error: failed to attach existing branch $branch"
        [[ -s "$worktree_stderr" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STATUS_LOG_FILE"
        [[ -s "$worktree_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STARTUP_TASK_LOG_FILE"
        rm -f "$worktree_stderr"
        startup_log "  Task will not be launched. Retry with: wavemill mill"
        return 1
      fi
      wt_dir="$resolved_path"
    else
      if ! wavemill_lock_run "git-worktree" git worktree add "$wt_dir" -b "$branch" "origin/$BASE_BRANCH" >/dev/null 2>"$worktree_stderr"; then
        startup_phase_failed "$startup_id" worktree "$issue" "worktree creation"
        startup_log "  Error: failed to create $branch from origin/$BASE_BRANCH"
        [[ -s "$worktree_stderr" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STATUS_LOG_FILE"
        [[ -s "$worktree_stderr" && -n "${STARTUP_TASK_LOG_FILE:-}" ]] && sed 's/^/  git: /' "$worktree_stderr" >> "$STARTUP_TASK_LOG_FILE"
        rm -f "$worktree_stderr"
        startup_log "  Task will not be launched. Retry with: wavemill mill"
        return 1
      fi
      created_new=true
    fi
    rm -f "$worktree_stderr"
    startup_step "[1/7] Creating worktree...     ✓"
  fi
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" worktree done

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps running
  if ! ensure_worktree_dependencies "$wt_dir" "$issue"; then
    [[ -n "${created_new:-}" && "$created_new" == "true" ]] && \
      git worktree remove --force "$wt_dir" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" deps "$issue" "dependency install"
    return 1
  fi
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" deps done

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" agent running
  AGENT_CMD="$task_agent"
  pretrust_directory "$wt_dir"
  startup_step "[2/7] Pre-trusting directory... ✓"

  win="$issue-$slug"
  wavemill_lock_run "tmux-win" tmux new-window -d -t "$SESSION" -n "$win" -c "$wt_dir" >/dev/null
  tmux set-window-option -u -t "$SESSION:$win" window-status-style >/dev/null 2>&1 || true
  tmux set-window-option -u -t "$SESSION:$win" window-status-current-style >/dev/null 2>&1 || true
  tmux set-option -t "$SESSION:$win" remain-on-exit on >/dev/null 2>&1 || true
  created_window=true
  startup_step "[3/7] Creating tmux window...   ✓"

  packet_content="$(cat "$task_packet_file" 2>/dev/null || true)"
  issue_json="$(cat "$issue_json_file" 2>/dev/null || echo '{}')"
  issue_description="$(echo "$issue_json" | jq -r '.description // ""' 2>/dev/null || echo "")"
  labels_json="$(echo "$issue_json" | jq '[.labels.nodes[]?.name // empty]' 2>/dev/null || echo '[]')"
  status_file="/tmp/${SESSION}-${issue}-status.txt"
  feature_dir="$wt_dir/features/$slug"
  mkdir -p "$feature_dir"
  reset_startup_phase_artifacts "$feature_dir"

  if [[ -f "$details_file" ]]; then
    if [[ "$PLANNING_MODE" == "interactive" ]]; then
      cp "$details_file" "$feature_dir/task-packet-details.md"
      [[ -f "$task_packet_file" ]] && cp "$task_packet_file" "$feature_dir/task-packet-header.md"
      details_context="
📖 Full Details: Comprehensive task packet with all 9 sections available at:
   features/$slug/task-packet-details.md"
    else
      cp "$details_file" "$wt_dir/task-packet-details.md"
      [[ -f "$task_packet_file" ]] && cp "$task_packet_file" "$wt_dir/task-packet-header.md"
      details_context="
📖 Full Details: Read task-packet-details.md in the repo root for implementation constraints and validation steps."
    fi
  else
    details_context=""
  fi

  issue_context="Issue Description:
${issue_description:-$packet_content}
$details_context"

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

  local bootstrap_router_mode
  bootstrap_router_mode="$(npx tsx "$TOOLS_DIR/get-operating-mode.ts" global --repo-dir "$REPO_DIR" 2>/dev/null || echo "normal")"

  jq -n \
    --arg planner "${planner_model:-claude-sonnet-4-6}" \
    --arg coder "${coder_model:-claude-opus-4-7}" \
    --arg reviewer "${reviewer_model:-claude-sonnet-4-6}" \
    --arg planDepth "$plan_depth" \
    --arg codeDepth "$code_depth" \
    --arg reviewMode "$review_mode" \
    --arg source "bootstrap" \
    --arg inputKind "issue" \
    --arg inputPath "features/$slug/selected-task.json" \
    --arg routerMode "$bootstrap_router_mode" \
    --argjson maxCostUsd "${route_max_cost_usd:-null}" \
    '{
      planner: $planner,
      coder: $coder,
      reviewer: $reviewer,
      planDepth: $planDepth,
      codeDepth: $codeDepth,
      reviewMode: $reviewMode,
      reviewRecommended: $reviewMode,
      provenance: {
        source: $source,
        inputKind: $inputKind,
        inputPath: $inputPath,
        inputHash: "",
        routedAt: (now | todateiso8601),
        routerMode: $routerMode
      }
    } + (if $maxCostUsd == null then {} else {maxCostUsd: $maxCostUsd} end)' \
    | write_json_artifact "$feature_dir/.routing-complete"
  if [[ -f "$feature_dir/.initial-route.json" ]]; then
    startup_log "  Keeping existing .initial-route.json for $issue"
  else
    jq '.provenance.source = "bootstrap"' "$feature_dir/.routing-complete" \
      | write_json_artifact "$feature_dir/.initial-route.json"
  fi
  local bootstrap_route
  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" ]]; then
    log_route_lifecycle "bootstrap_assigned" "issue=$issue" "route=\"$bootstrap_route\""
  fi

  local planner_agent
  planner_agent="$(agent_resolve_from_model "${planner_model:-claude-sonnet-4-6}")"
  write_stage_result_local "$feature_dir" "planning" "running" "$planner_agent" "${planner_model:-claude-sonnet-4-6}" "Startup handoff launched planning" || true
  startup_step "[4/7] Writing task artifacts...  ✓"

  # Persist launched tasks as active planning work in the initial state write so
  # downstream startup checks do not depend on a second jq update succeeding.
  local persisted_phase="planning"
  if ! wavemill_lock_run "state" save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent" "$linear_issue" "$challenge" "$challenge_pair" "$challenge_role" "$challenge_model" \
    "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "$persisted_phase"; then
    startup_phase_failed "$startup_id" agent "$issue" "saving workflow state"
    [[ -n "${created_window:-}" ]] && tmux kill-window -t "$SESSION:$win" >/dev/null 2>&1 || true
    return 1
  fi

  if ! wavemill_lock_run "state" set_task_phase_local "$issue" "$persisted_phase"; then
    wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    [[ -n "${created_window:-}" ]] && tmux kill-window -t "$SESSION:$win" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "setting phase"
    return 1
  fi
  state_written=true
  startup_step "[5/7] Saving workflow state...  ✓"

  planning_prompt="/tmp/${SESSION}-${issue}-planning-prompt.txt"
  build_planning_prompt "$title" "$linear_issue" "$wt_dir" "$branch" "$BASE_BRANCH" \
    "$issue_context" "$status_file" "$TOOLS_DIR" "$slug" "$plan_depth" "$planner_agent" > "$planning_prompt"
  if ! agent_launch_interactive "$SESSION" "$win" "$planning_prompt" "$planner_agent" "${planner_model:-claude-sonnet-4-6}"; then
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "$SESSION:$win" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "launching planning agent"
    return 1
  fi

  # Re-persist the launched task after the pane handoff succeeds so the final
  # workflow record reflects a fully launched planning session.
  if ! wavemill_lock_run "state" save_task_state "$issue" "$slug" "$branch" "$wt_dir" "" "" "$task_agent" "$linear_issue" "$challenge" "$challenge_pair" "$challenge_role" "$challenge_model" \
    "$planner_model" "$coder_model" "$reviewer_model" "$plan_depth" "$code_depth" "$review_mode" "$persisted_phase"; then
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "$SESSION:$win" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" agent "$issue" "re-saving workflow state"
    return 1
  fi
  startup_step "[6/7] Launching agent...        ✓"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" agent done

  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" linear running

  # Reassert the launched phase after agent dispatch and Linear updates so the
  # final persisted state reflects active coding work even if a helper touched
  # workflow-state during startup.
  if ! wavemill_lock_run "state" set_task_phase_local "$issue" "$persisted_phase"; then
    [[ -n "${state_written:-}" ]] && wavemill_lock_run "state" remove_task_state "$issue" >/dev/null 2>&1 || true
    tmux kill-window -t "$SESSION:$win" >/dev/null 2>&1 || true
    startup_phase_failed "$startup_id" linear "$issue" "finalizing workflow state"
    return 1
  fi
  startup_step "[7/7] Setting Linear → In Progress... ✓"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" != "1" ]] && progress_update "$startup_id" linear done

  printf '%s\n' "$issue" >> "$LAUNCHED_ISSUES_FILE"
  startup_log "✓ $issue launched (${coder_model:-$planner_model}, phase: $persisted_phase)"
  STARTUP_TASK_LOG_FILE=""
  return 0
}

launch_startup_concurrent() {
  local task_count="$1"
  local pool_size="${WAVEMILL_STARTUP_CONCURRENCY:-4}"

  if ! [[ "$pool_size" =~ ^[1-9][0-9]*$ ]]; then
    startup_log "Error: WAVEMILL_STARTUP_CONCURRENCY must be a positive integer (got $pool_size)"
    return 2
  fi
  if [[ "$task_count" -eq 0 ]]; then
    return 0
  fi
  [[ "$pool_size" -gt "$task_count" ]] && pool_size="$task_count"

  local status_dir
  status_dir="$(mktemp -d "/tmp/wavemill-${SESSION}-worker-status-XXXXXX")"

  local idx=0
  local -a bg_pids=()

  while IFS= read -r task_json; do
    [[ -z "$task_json" ]] && continue
    idx=$((idx + 1))

    local issue exit_file
    issue="$(printf '%s' "$task_json" | jq -r '.issue')"
    exit_file="$status_dir/${issue}.exit"

    while [[ "${#bg_pids[@]}" -ge "$pool_size" ]]; do
      local -a new_bg=()
      local pid
      for pid in "${bg_pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
          new_bg+=("$pid")
        else
          wait "$pid" 2>/dev/null || true
        fi
      done
      bg_pids=("${new_bg[@]}")
      [[ "${#bg_pids[@]}" -ge "$pool_size" ]] && sleep 0.2
    done

    (
      local rc=0
      launch_task_from_plan "$task_json" "$idx" "$task_count" || rc=$?
      printf '%s\n' "$rc" > "$exit_file"
    ) &
    bg_pids+=("$!")
  done < <(jq -c '.tasks[]' "$PLAN_FILE")

  local pid
  for pid in "${bg_pids[@]}"; do
    wait "$pid" 2>/dev/null || true
  done

  local any_failed=0
  while IFS= read -r task_json; do
    [[ -z "$task_json" ]] && continue

    local issue rc_file rc
    issue="$(printf '%s' "$task_json" | jq -r '.issue')"
    rc_file="$status_dir/${issue}.exit"
    if [[ -f "$rc_file" ]]; then
      rc="$(cat "$rc_file")"
    else
      rc=1
    fi
    if [[ "$rc" -ne 0 ]]; then
      startup_log "✗ $issue launch failed (worker exit $rc)"
      any_failed=1
    fi
  done < <(jq -c '.tasks[]' "$PLAN_FILE")

  rm -rf "$status_dir"
  return "$any_failed"
}

main() {
  local task_count idx tasks_file monitor_cmd task_json resumed_count launched_count pool_exit
  local -a linear_batch_ids=()

  ensure_state_file
  : > "$STATUS_LOG_FILE"
  : > "$LAUNCHED_ISSUES_FILE"

  if ! cd "$REPO_DIR"; then
    startup_log "✗ Startup failed: could not cd to repo root: $REPO_DIR"
    exit 1
  fi

  startup_log "═══ Wavemill Startup ═══"
  startup_log "Reading launch plan: $PLAN_FILE"

  task_count="$(jq '.tasks | length' "$PLAN_FILE")"
  startup_log "Tasks to launch: $task_count"
  if [[ "$task_count" -eq 0 ]]; then
    resumed_count="$(jq '(.tasks // {}) | length' "$STATE_FILE" 2>/dev/null || echo 0)"
    startup_log "No new tasks selected. Resuming $resumed_count in-flight task(s) from previous session."
  fi

  if [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]]; then
    idx=0
    while IFS= read -r task_json; do
      [[ -z "$task_json" ]] && continue
      idx=$((idx + 1))
      startup_run_task_phases "$task_json" "$idx" "$task_count" || true
    done < <(jq -c '.tasks[]' "$PLAN_FILE")
  elif [[ "$task_count" -gt 0 ]]; then
    local task_list=()
    mapfile -t task_list < <(jq -c --argjson total "$task_count" '.tasks | to_entries[] | .value + {startupId: (.key + 1), startupTotal: $total}' "$PLAN_FILE")
    progress_start "$task_count" "$STATUS_LOG_FILE"
    worker_pool_run "${WAVEMILL_STARTUP_CONCURRENCY:-4}" startup_run_task_phases "${task_list[@]}"
    pool_exit=$?
    progress_finish
    if [[ "$pool_exit" -ne 0 ]]; then
      startup_log "One or more startup tasks failed; see /tmp/wavemill-${SESSION}-*.startup.log for details."
    fi
  fi

  tasks_file="/tmp/${SESSION}-tasks.txt"
  jq -r '.tasks[] | "\(.issue)|\(.slug)|\(.title)"' "$PLAN_FILE" > "$tasks_file"
  setup_control_dashboard
  spawn_integration_window
  write_monitor_env "$tasks_file"

  launched_count="$(wc -l < "$LAUNCHED_ISSUES_FILE" | tr -d ' ')"
  if [[ "$DRY_RUN" != "true" && "$launched_count" -gt 0 ]]; then
    while IFS= read -r launched_issue; do
      [[ -z "$launched_issue" ]] && continue
      linear_id="$(jq -r --arg issue "$launched_issue" '.tasks[]
        | select(.issue == $issue and ((.challengeRole // "") != "challenger"))
        | (.linearIssueId // .issue)' "$PLAN_FILE" | head -n 1)"
      [[ -n "$linear_id" && "$linear_id" != "null" ]] && linear_batch_ids+=("$linear_id")
    done < "$LAUNCHED_ISSUES_FILE"
    if [[ "${#linear_batch_ids[@]}" -gt 0 ]]; then
      startup_log "Setting Linear state for ${#linear_batch_ids[@]} launched issue(s) in one batch call..."
      linear_batch_set_state "In Progress" "${linear_batch_ids[@]}"
    fi
  fi

  if [[ "$launched_count" -eq 0 && "${resumed_count:-0}" -eq 0 ]]; then
    startup_log ""
    startup_log "No tasks launched. Keeping startup diagnostics visible in control window."
    tmux respawn-pane -k -t "$SESSION:control.0" "bash -lc \"clear; cat '$STATUS_LOG_FILE'; printf '\\nPress Ctrl+B then D to detach.\\n'; tail -f /dev/null\""
    return 0
  fi

  startup_log ""
  startup_log "Starting monitor in control window..."
  local input_reader_script cmd_file offset_file
  input_reader_script="$LIB_DIR/wavemill-input-reader.sh"
  cmd_file="$(wavemill_command_file_path "$SESSION")"
  offset_file="$(wavemill_command_offset_path "$SESSION")"
  printf -v monitor_cmd '%q -lc %q' "/opt/homebrew/bin/bash" \
    "clear; : > $(printf '%q' "$cmd_file"); printf '0\\n' > $(printf '%q' "$offset_file"); $(printf '%q %q' "$MONITOR_SCRIPT" "$MONITOR_ENV") </dev/null & monitor_pid=\$!; trap 'kill \"\$monitor_pid\" >/dev/null 2>&1 || true' EXIT INT TERM; exec env WAVEMILL_SESSION=$(printf '%q' "$SESSION") $(printf '%q %q' "$input_reader_script" "$SESSION")"
  tmux respawn-pane -k -t "$SESSION:control.0" "$monitor_cmd"
}

main "$@"
