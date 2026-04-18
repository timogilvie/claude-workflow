#!/opt/homebrew/bin/bash
# Wavemill Common Library
# Shared functions used across wavemill-mill.sh and wavemill-expand.sh

# ============================================================================
# LAYERED CONFIGURATION LOADING
# ============================================================================

# Hardcoded defaults (ultimate fallbacks)
_WAVEMILL_DEFAULTS='{
  "linear": { "project": "" },
  "mill": {
    "session": "",
    "maxParallel": 7,
    "pollSeconds": 10,
    "baseBranch": "main",
    "worktreeRoot": "worktrees",
    "agentCmd": "claude",
    "requireConfirm": true,
    "planningMode": "skip",
    "maxRetries": 3,
    "retryDelay": 2,
    "setupCommand": "",
    "defaultMaxCostUsd": 25.00
  },
  "expand": {
    "maxSelect": 3,
    "maxDisplay": 9
  },
  "plan": {
    "maxDisplay": 9
  },
  "dashboard": {
    "verbosity": "info",
    "logToFile": true
  },
  "challenge": {
    "enabled": false,
    "rate": 0.10,
    "models": null,
    "comparisonModel": "claude-opus-4-7",
    "autoMergeWinner": false
  }
}'

# Load layered config: defaults < ~/.wavemill/config.json < .wavemill-config.json < env vars
#
# Resolution order (later wins):
#   1. Hardcoded defaults (_WAVEMILL_DEFAULTS)
#   2. User-level config (~/.wavemill/config.json)
#   3. Per-repo config (.wavemill-config.json)
#   4. Environment variables (always win)
#
# Sets: SESSION, MAX_PARALLEL, POLL_SECONDS, BASE_BRANCH, WORKTREE_ROOT,
#        AGENT_CMD, REQUIRE_CONFIRM, PLANNING_MODE, MAX_RETRIES, RETRY_DELAY,
#        PROJECT_NAME, MAX_SELECT, MAX_DISPLAY, SETUP_CMD
#
# Args: $1 = repo directory (default: $PWD)
load_config() {
  local repo_dir="${1:-$PWD}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"

  # Read config files (empty object if missing)
  local user_json='{}'
  local repo_json='{}'
  if [[ -f "$user_config" ]]; then
    user_json=$(cat "$user_config") || user_json='{}'
  fi
  if [[ -f "$repo_config" ]]; then
    repo_json=$(cat "$repo_config") || repo_json='{}'
  fi

  # Single jq call: deep-merge all layers, emit shell-safe variable assignments
  local shell_vars
  shell_vars=$(jq -n -r \
    --argjson defaults "$_WAVEMILL_DEFAULTS" \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    '
    ($defaults * $user * $repo) as $c |
    [
      "_CFG_PROJECT=\($c.linear.project // "" | @sh)",
      "_CFG_SESSION=\($c.mill.session | @sh)",
      "_CFG_MAX_PARALLEL=\($c.mill.maxParallel)",
      "_CFG_POLL_SECONDS=\($c.mill.pollSeconds)",
      "_CFG_BASE_BRANCH=\($c.mill.baseBranch | @sh)",
      "_CFG_WORKTREE_ROOT=\($c.mill.worktreeRoot | @sh)",
      "_CFG_AGENT_CMD=\($c.mill.agentCmd | @sh)",
      "_CFG_REQUIRE_CONFIRM=\($c.mill.requireConfirm)",
      "_CFG_PLANNING_MODE=\($c.mill.planningMode | @sh)",
      "_CFG_MAX_RETRIES=\($c.mill.maxRetries)",
      "_CFG_RETRY_DELAY=\($c.mill.retryDelay)",
      "_CFG_MAX_SELECT=\($c.expand.maxSelect)",
      "_CFG_MAX_DISPLAY=\($c.expand.maxDisplay)",
      "_CFG_PLAN_MAX_DISPLAY=\($c.plan.maxDisplay)",
      "_CFG_PLAN_RESEARCH=\($c.plan.research // false)",
      "_CFG_PLAN_MODEL=\($c.plan.model // "claude-opus-4-7" | @sh)",
      "_CFG_DASHBOARD_VERBOSITY=\($c.dashboard.verbosity // "info" | @sh)",
      "_CFG_DASHBOARD_LOG_TO_FILE=\(if ($c.dashboard | has("logToFile")) then $c.dashboard.logToFile else true end)",
      "_CFG_CHALLENGE_ENABLED=\($c.challenge.enabled // false)",
      "_CFG_CHALLENGE_RATE=\($c.challenge.rate // 0.10)",
      "_CFG_CHALLENGE_MODELS=\(($c.challenge.models // null) | @json | @sh)",
      "_CFG_CHALLENGE_COMPARISON_MODEL=\($c.challenge.comparisonModel // "claude-opus-4-7" | @sh)",
      "_CFG_CHALLENGE_AUTO_MERGE=\($c.challenge.autoMergeWinner // false)",
      "_CFG_ROUTER_ENABLED=\($c.router.enabled // true)",
      "_CFG_ROUTER_DEFAULT_MODEL=\($c.router.defaultModel // "claude-sonnet-4-6" | @sh)",
      "_CFG_AUTO_EVAL=\($c.autoEval // true)",
      "_CFG_SETUP_CMD=\($c.mill.setupCommand // "" | @sh)",
      "_CFG_DEFAULT_MAX_COST_USD=\(($c.mill.defaultMaxCostUsd // null) | if . == null then "" else tostring end | @sh)"
    ] | .[]
    '
  ) || {
    echo "Error: Failed to parse config files. Check JSON syntax in:" >&2
    [[ -f "$user_config" ]] && echo "  $user_config" >&2
    [[ -f "$repo_config" ]] && echo "  $repo_config" >&2
    exit 1
  }

  eval "$shell_vars"

  # Apply env var overrides (env > repo config > user config > defaults)
  #
  # Project selection is special:
  # - LINEAR_PROJECT is the explicit override
  # - repo config should beat an ambient/exported PROJECT_NAME to avoid
  #   cross-repo leakage from prior shells or sessions
  # - legacy PROJECT_NAME is only used when no repo/user project is configured
  if [[ -n "${LINEAR_PROJECT:-}" ]]; then
    PROJECT_NAME="$LINEAR_PROJECT"
  elif [[ -n "$_CFG_PROJECT" ]]; then
    PROJECT_NAME="$_CFG_PROJECT"
  else
    PROJECT_NAME="${PROJECT_NAME:-}"
  fi

  # Session name: env var > config > repo-specific default
  # Repo-specific default prevents cross-repo session collisions
  local _repo_basename
  _repo_basename="$(basename "$repo_dir" | tr '.:-' '___')"
  local _default_session="wavemill-${_repo_basename}"
  if [[ -n "${SESSION:-}" ]]; then
    : # Explicit env var — keep it
  elif [[ -n "$_CFG_SESSION" ]]; then
    SESSION="$_CFG_SESSION"
  else
    SESSION="$_default_session"
  fi
  MAX_PARALLEL="${MAX_PARALLEL:-$_CFG_MAX_PARALLEL}"
  POLL_SECONDS="${POLL_SECONDS:-$_CFG_POLL_SECONDS}"
  BASE_BRANCH="${BASE_BRANCH:-$_CFG_BASE_BRANCH}"
  AGENT_CMD="${AGENT_CMD:-$_CFG_AGENT_CMD}"
  REQUIRE_CONFIRM="${REQUIRE_CONFIRM:-$_CFG_REQUIRE_CONFIRM}"
  PLANNING_MODE="${PLANNING_MODE:-$_CFG_PLANNING_MODE}"
  MAX_RETRIES="${MAX_RETRIES:-$_CFG_MAX_RETRIES}"
  RETRY_DELAY="${RETRY_DELAY:-$_CFG_RETRY_DELAY}"
  MAX_SELECT="${MAX_SELECT:-$_CFG_MAX_SELECT}"
  MAX_DISPLAY="${MAX_DISPLAY:-$_CFG_MAX_DISPLAY}"
  PLAN_MAX_DISPLAY="${PLAN_MAX_DISPLAY:-$_CFG_PLAN_MAX_DISPLAY}"
  PLAN_RESEARCH="${PLAN_RESEARCH:-$_CFG_PLAN_RESEARCH}"
  PLAN_MODEL="${PLAN_MODEL:-$_CFG_PLAN_MODEL}"
  DASHBOARD_VERBOSITY="${DASHBOARD_VERBOSITY:-$_CFG_DASHBOARD_VERBOSITY}"
  DASHBOARD_LOG_TO_FILE="${DASHBOARD_LOG_TO_FILE:-$_CFG_DASHBOARD_LOG_TO_FILE}"
  CHALLENGE_ENABLED="${CHALLENGE_ENABLED:-$_CFG_CHALLENGE_ENABLED}"
  CHALLENGE_RATE="${CHALLENGE_RATE:-$_CFG_CHALLENGE_RATE}"
  CHALLENGE_MODELS_JSON="${CHALLENGE_MODELS_JSON:-$_CFG_CHALLENGE_MODELS}"
  CHALLENGE_COMPARISON_MODEL="${CHALLENGE_COMPARISON_MODEL:-$_CFG_CHALLENGE_COMPARISON_MODEL}"
  CHALLENGE_AUTO_MERGE="${CHALLENGE_AUTO_MERGE:-$_CFG_CHALLENGE_AUTO_MERGE}"
  ROUTER_ENABLED="${ROUTER_ENABLED:-$_CFG_ROUTER_ENABLED}"
  ROUTER_DEFAULT_MODEL="${ROUTER_DEFAULT_MODEL:-$_CFG_ROUTER_DEFAULT_MODEL}"
  AUTO_EVAL="${AUTO_EVAL:-$_CFG_AUTO_EVAL}"
  SETUP_CMD="${SETUP_CMD:-$_CFG_SETUP_CMD}"
  DEFAULT_MAX_COST_USD="${DEFAULT_MAX_COST_USD:-$_CFG_DEFAULT_MAX_COST_USD}"

  # WORKTREE_ROOT: resolve relative paths against repo_dir
  local wt_raw="${WORKTREE_ROOT:-$_CFG_WORKTREE_ROOT}"
  if [[ "$wt_raw" != /* ]]; then
    WORKTREE_ROOT="$repo_dir/$wt_raw"
  else
    WORKTREE_ROOT="$wt_raw"
  fi

  # Export for child processes (orchestrator, monitor, agents)
  export SESSION MAX_PARALLEL POLL_SECONDS BASE_BRANCH WORKTREE_ROOT
  export AGENT_CMD REQUIRE_CONFIRM PLANNING_MODE MAX_RETRIES RETRY_DELAY
  export PROJECT_NAME MAX_SELECT MAX_DISPLAY PLAN_MAX_DISPLAY PLAN_RESEARCH PLAN_MODEL
  export DASHBOARD_VERBOSITY DASHBOARD_LOG_TO_FILE
  export CHALLENGE_ENABLED CHALLENGE_RATE CHALLENGE_MODELS_JSON
  export CHALLENGE_COMPARISON_MODEL CHALLENGE_AUTO_MERGE
  export ROUTER_ENABLED ROUTER_DEFAULT_MODEL AUTO_EVAL SETUP_CMD DEFAULT_MAX_COST_USD

  # Clean up temp variables
  unset _CFG_PROJECT _CFG_SESSION _CFG_MAX_PARALLEL _CFG_POLL_SECONDS
  unset _CFG_BASE_BRANCH _CFG_WORKTREE_ROOT _CFG_AGENT_CMD _CFG_REQUIRE_CONFIRM
  unset _CFG_PLANNING_MODE _CFG_MAX_RETRIES _CFG_RETRY_DELAY _CFG_MAX_SELECT _CFG_MAX_DISPLAY
  unset _CFG_PLAN_MAX_DISPLAY _CFG_PLAN_RESEARCH _CFG_PLAN_MODEL
  unset _CFG_DASHBOARD_VERBOSITY _CFG_DASHBOARD_LOG_TO_FILE
  unset _CFG_CHALLENGE_ENABLED _CFG_CHALLENGE_RATE _CFG_CHALLENGE_MODELS
  unset _CFG_CHALLENGE_COMPARISON_MODEL _CFG_CHALLENGE_AUTO_MERGE
  unset _CFG_ROUTER_ENABLED _CFG_ROUTER_DEFAULT_MODEL _CFG_AUTO_EVAL _CFG_SETUP_CMD _CFG_DEFAULT_MAX_COST_USD

  # Sentinel so downstream scripts can skip re-loading
  _WAVEMILL_CONFIG_LOADED=1
}

# Read current operating mode via TypeScript module.
# Outputs: normal | constrained | survival
# Falls back to "normal" on any error.
get_operating_mode() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  local tools_dir="${TOOLS_DIR:-$repo_dir/tools}"
  local mode
  mode=$(npx tsx "$tools_dir/get-operating-mode.ts" --repo-dir "$repo_dir" 2>/dev/null) || mode=""
  case "$mode" in
    normal|constrained|survival) echo "$mode" ;;
    *) echo "normal" ;;
  esac
}

# Backwards-compatible wrapper for callers that haven't migrated to load_config()
detect_project_name() {
  local repo_dir="${1:-$PWD}"

  # If load_config() already ran, PROJECT_NAME is set
  if [[ -n "${PROJECT_NAME:-}" ]]; then
    echo "$PROJECT_NAME"
    return
  fi

  # Legacy fallback
  local project_name=""
  if [[ -f "$repo_dir/.wavemill-config.json" ]]; then
    project_name=$(jq -r '.linear.project // empty' "$repo_dir/.wavemill-config.json" 2>/dev/null)
  fi
  if [[ -z "$project_name" ]]; then
    project_name="${PROJECT_NAME:-}"
  fi
  echo "$project_name"
}

# ============================================================================
# GITHUB HELPERS
# ============================================================================

# Check whether a branch has any PR in GitHub, including closed or merged PRs.
# Returns 0 when a PR exists and 1 when no PR is found or GitHub cannot be
# queried. Callers use this as a guard before taking destructive cleanup paths.
check_pr_exists() {
  local branch="$1"
  local pr_number=""

  if [[ -z "$branch" ]]; then
    return 1
  fi

  pr_number=$(gh pr list --head "$branch" --state all --json number --jq '.[0].number // empty' 2>/dev/null || echo "")
  [[ -n "$pr_number" ]]
}

# Read a field from the canonical startup routing artifact.
# Fallback chain: route.json -> model-suggestion.json shim -> default value.
#
# Canonical route.json contract (written by tools/route-task.ts):
#   {
#     planner,
#     coder,
#     reviewer,
#     planDepth,
#     codeDepth,
#     reviewRecommended,
#     routingMode,
#     neighborCount,
#     expectedSuccess,
#     constraints,
#     signals,
#     reasoning
#   }
#
# COMPAT: model-suggestion.json is a temporary coder-only shim for pre-HOK-1198
# consumers and pre-HOK-1197 startup sessions. New routing consumers should
# read route.json through this helper instead of reading the shim directly.
#
# Usage: read_route_json <session> <issue> <field> [default]
read_route_json() {
  local session="$1" issue="$2" field="$3" default_value="${4:-}"
  local route_file="/tmp/${session}-${issue}-route.json"
  local suggestion_file="/tmp/${session}-${issue}-model-suggestion.json"
  local value=""

  if [[ -f "$route_file" ]]; then
    value=$(jq -r --arg field "$field" '
      ($field | split(".")) as $path |
      getpath($path) // empty
    ' "$route_file" 2>/dev/null || true)
    if [[ -n "$value" ]]; then
      echo "$value"
      return 0
    fi
  fi

  if [[ -f "$suggestion_file" ]]; then
    case "$field" in
      coder)
        value=$(jq -r '.recommendedModel // empty' "$suggestion_file" 2>/dev/null || true)
        if [[ -n "$value" ]]; then
          echo "$value"
          return 0
        fi
        ;;
    esac
  fi

  echo "$default_value"
}

# ============================================================================
# TASK PACKET DETECTION
# ============================================================================

# Check if issue description is already a detailed task packet
# Recognizes both old (9-section) and new (header) formats
is_task_packet() {
  local description="$1"
  # Check for common task packet markers (h2 or h3 level)
  # Now also recognizes the new "Quick Reference" header format
  echo "$description" | grep -qE "(##+ (1\\.|Objective)|##+ What|##+ Technical Context|##+ Success Criteria|## Task Packet|Quick Reference|## Detailed Sections)"
}

# ============================================================================
# PRIORITY SCORING ALGORITHM
# ============================================================================

# Calculate priority score for a list of issues (JSON input)
# Returns: identifier|slug|title|area|score
score_and_rank_issues() {
  local backlog_json="$1"
  local show_limit="${2:-9}"

  echo "$backlog_json" | jq -r --argjson show_limit "$show_limit" '
    # Filter to backlog/todo only
    map(select((.state.name|ascii_downcase) == "todo" or (.state.name|ascii_downcase) == "backlog"))

    # Enrich each task with scoring factors
    | map(. + {
        # Extract area for conflict detection
        area: (
          (.labels.nodes // [])
          | map(.name)
          | map(select(test("^(Area|Component|Page|Route):")))
          | .[0] // ""
        ),

        # Check if task has detailed description (task packet)
        has_detailed_plan: (
          .description // ""
          | test("##+ (1\\.|Objective|What|Technical Context|Success Criteria|Implementation)")
        ),

        # Check for foundational labels
        is_foundational: (
          (.labels.nodes // [])
          | map(.name | ascii_downcase)
          | any(test("foundational|architecture|epic|infrastructure"))
        ),

        # Count how many issues this blocks (foundational work)
        blocks_count: (
          (.relations.nodes // [])
          | map(select(.type == "blocks" and .relatedIssue.completedAt == null and .relatedIssue.canceledAt == null))
          | length
        ),

        # Count how many incomplete issues block this (dependency risk)
        blocked_by_count: (
          (.inverseRelations.nodes // [])
          | map(select(.type == "blocks" and .issue.completedAt == null and .issue.canceledAt == null))
          | length
        )
      })

    # Calculate composite priority score (higher = higher priority)
    | map(. + {
        score: (
          # Base: Baseline for all items (prevents negative scores)
          20

          # Linear priority (1=urgent, 0=none, 4=low)
          + (if .priority > 0 then (5 - .priority) * 20 else 0 end)

          # Boost: Has detailed task packet (+30 points)
          + (if .has_detailed_plan then 30 else 0 end)

          # Boost: Foundational/architecture work (+25 points)
          + (if .is_foundational then 25 else 0 end)

          # Boost: Blocks other work (+10 per blocked issue)
          + (.blocks_count * 10)

          # Boost: Unblocked work is ready to go (+15 points)
          + (if .blocked_by_count == 0 then 15 else 0 end)

          # Penalty: Blocked by other work (-20 per blocker, harder penalty)
          - (.blocked_by_count * 20)

          # Penalty: Large estimates (prefer smaller, deliverable work)
          - ((.estimate // 3) * 2)
        )
      })

    # Sort by score descending (higher score = higher priority)
    | sort_by(-.score)

    # Take top candidates for display
    | .[0:$show_limit]
    | .[]
    | "\(.identifier)|\(.title|ascii_downcase|gsub("[^a-z0-9]+";"-"))|\(.title)|\(.area)|\(.score)|\(.has_detailed_plan)|\(.blocked_by_count)"
  '
}

# ============================================================================
# ISSUE EXPANSION
# ============================================================================

# Expand issue with expand-issue.ts if available
# Args: issue_id, output_file, [--no-update to skip Linear update]
# Note: Linear is always updated by default. Pass --no-update to opt out.
expand_issue_with_tool() {
  local issue_id="$1"
  local out_file="$2"
  local no_update_flag="${3:-}"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  if [[ ! -f "$tools_dir/expand-issue.ts" ]]; then
    return 1
  fi

  # Build command — Linear update is the default, --no-update opts out
  local cmd_args=("$tools_dir/expand-issue.ts" "$issue_id" "--output" "$out_file")
  if [[ "$no_update_flag" == "--no-update" ]]; then
    cmd_args+=("--no-update")
  fi

  # Run with real-time output using process substitution
  local log_file="/tmp/expand-issue-${issue_id}.log"

  # Show command being run
  echo "  Running: npx tsx expand-issue.ts $issue_id --output ... ${no_update_flag}" >&2

  # Use tee to show output in real-time AND capture to log file
  if npx tsx "${cmd_args[@]}" 2>&1 | tee "$log_file"; then
    return 0
  else
    # Print error summary
    echo "" >&2
    echo "Error expanding issue $issue_id (exit code: $?)" >&2
    echo "Full log saved to: $log_file" >&2
    return 1
  fi
}

# For backwards compatibility with wavemill-mill.sh
# Fetches current description and checks if expansion is needed
# If needed, calls expand_issue_with_tool
write_task_packet() {
  local issue_id="$1"
  local out_file="$2"
  local tools_dir="${TOOLS_DIR:?TOOLS_DIR must be set}"

  # Fetch current description (strip dotenv stdout noise before parsing JSON)
  local issue_json=$(npx tsx "$tools_dir/get-issue.ts" "$issue_id" --json 2>/dev/null | sed '/^\[dotenv/d' || echo "{}")
  local current_desc=$(echo "$issue_json" | jq -r '.description // ""')

  # Check if already a task packet
  if is_task_packet "$current_desc"; then
    # For existing task packets, write to main file
    echo "$current_desc" > "$out_file"
    return 0
  fi

  # Try to expand (Linear update is now the default)
  # This will create three files:
  #   - $out_file (full content for Linear)
  #   - ${out_file%.md}-header.md (brief header)
  #   - ${out_file%.md}-details.md (detailed sections)
  if expand_issue_with_tool "$issue_id" "$out_file"; then
    # Move header to main file for loading by mill
    local header_file="${out_file%.md}-header.md"
    if [[ -f "$header_file" ]]; then
      mv "$header_file" "$out_file"
      # Details file stays as ${out_file%.md}-details.md for on-demand access
    fi
    return 0
  else
    # Fallback: just use the raw description
    echo "$current_desc" > "$out_file"
    return 1
  fi
}

# ============================================================================
# CLAUDE TRUST PRE-SEEDING
# ============================================================================

# Pre-trust a directory in Claude Code's config so it doesn't prompt on launch.
# Each worktree path is treated as a separate "project" by Claude, triggering a
# trust dialog on first use. This function sets hasTrustDialogAccepted=true
# and hasCompletedProjectOnboarding=true before the agent starts.
#
# Args: $1 = directory path to trust
pretrust_directory() {
  local dir_path="$1"
  local claude_json="$HOME/.claude.json"

  # Only relevant for claude agent
  [[ "${AGENT_CMD:-claude}" != "claude" ]] && return 0
  [[ ! -f "$claude_json" ]] && return 0

  # Check if already trusted
  local already_trusted
  already_trusted=$(jq -r --arg p "$dir_path" '.projects[$p].hasTrustDialogAccepted // false' "$claude_json" 2>/dev/null)
  [[ "$already_trusted" == "true" ]] && return 0

  # Set trust fields
  local tmp
  tmp=$(mktemp)
  if jq --arg p "$dir_path" '
    .projects[$p] = (.projects[$p] // {}) |
    .projects[$p].hasTrustDialogAccepted = true |
    .projects[$p].hasCompletedProjectOnboarding = true
  ' "$claude_json" > "$tmp" 2>/dev/null; then
    mv "$tmp" "$claude_json"
  else
    rm -f "$tmp"
  fi
}

# ============================================================================
# TASK PHASE MANAGEMENT
# ============================================================================

# Update the phase field on a task in the state file.
# Args: $1 = state_file, $2 = issue_id, $3 = phase (planning|executing|pr-review|merged)
set_task_phase() {
  local state_file="$1" issue="$2" phase="$3"
  local tmp
  tmp=$(mktemp)
  jq --arg issue "$issue" --arg phase "$phase" \
     '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
     "$state_file" > "$tmp" && mv "$tmp" "$state_file"
}

# ============================================================================
# Hook Configuration
# ============================================================================

# Log a hook warning once per session to avoid repeated noise for the same
# broken installation state across planning/coding/review launches.
warn_once_per_session() {
  local warning_key="$1" message="$2"
  local session="${SESSION:-}"
  local warning_file

  if [[ -z "$session" ]]; then
    log "warn" "$message"
    return 0
  fi

  warning_file="/tmp/wavemill-${session}-hook-warnings.txt"
  if [[ -f "$warning_file" ]] && grep -qxF "$warning_key" "$warning_file" 2>/dev/null; then
    return 0
  fi

  log "warn" "$message"
  printf '%s\n' "$warning_key" >> "$warning_file" 2>/dev/null || true
}

# Configure agent hooks for status tracking in a worktree-specific settings file.
# This writes to .claude/settings.local.json (gitignored) so hooks only affect
# wavemill-launched agents, not standalone Claude usage.
#
# Args: $1 = agent_cmd (claude|codex), $2 = worktree_dir
configure_agent_hooks() {
  local agent_cmd="$1" worktree_dir="$2"
  local tools_dir="${TOOLS_DIR:-}"
  local wavemill_root="${tools_dir%/tools}"
  local hooks_dir="$wavemill_root/shared/hooks"
  local claude_hook="$hooks_dir/claude-status-hook.sh"
  local tmp config_file

  # Gracefully skip if jq is unavailable or worktree is invalid
  command -v jq >/dev/null 2>&1 || return 0
  [[ -n "$worktree_dir" && -d "$worktree_dir" ]] || return 0

  case "$agent_cmd" in
    claude)
      # Claude hooks are part of the wavemill installation, so every repo uses
      # the same canonical adapter.
      if [[ ! -x "$claude_hook" ]]; then
        warn_once_per_session \
          "claude-hook-unavailable:$claude_hook" \
          "  Hook status unavailable (missing wavemill hook $claude_hook)"
        return 0
      fi

      # Create .claude directory if needed
      mkdir -p "$worktree_dir/.claude"
      config_file="$worktree_dir/.claude/settings.local.json"

      # Initialize or validate existing config
      if [[ ! -f "$config_file" ]]; then
        printf '{}\n' > "$config_file"
      elif ! jq empty "$config_file" >/dev/null 2>&1; then
        log "warn" "  Invalid JSON in $config_file, resetting local hook config"
        printf '{}\n' > "$config_file"
      fi

      # Merge hook configuration using jq (atomic via tmp + mv)
      # WAVEMILL_DASHBOARD_PID is available via tmux session environment
      tmp=$(mktemp) || {
        log "warn" "  Failed to allocate temp file for Claude hook config"
        return 0
      }

      if jq \
        --arg hook_cmd "$claude_hook" \
        '
        . as $base |
        ($base.hooks // {}) as $hooks |
        $base + {
          hooks: ($hooks + {
            UserPromptSubmit: (($hooks.UserPromptSubmit // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            PreToolUse: (($hooks.PreToolUse // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            Stop: (($hooks.Stop // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            StopFailure: (($hooks.StopFailure // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command)),
            Notification: (($hooks.Notification // []) + [{hooks: [{type: "command", command: $hook_cmd}]}] | unique_by(.hooks[0].command))
          })
        }
        ' "$config_file" > "$tmp" 2>/dev/null; then
        mv "$tmp" "$config_file"
        log "debug" "  Configured Claude hook status in $config_file"
      else
        rm -f "$tmp"
        log "warn" "  Failed to write Claude hook config at $config_file"
      fi
      ;;

    codex)
      # Codex autonomous launches report completion from their wrapper; while
      # running, the dashboard falls back to pane/process liveness.
      log "debug" "  Codex status tracking via launcher exit hook"
      ;;

    *)
      # Generic agents use process monitoring - no config needed
      log "debug" "  Generic agent status tracking via process monitor"
      ;;
  esac
}
