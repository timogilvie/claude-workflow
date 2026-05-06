#!/usr/bin/env bash
# Wavemill Common Library
# Shared functions used across wavemill-mill.sh and wavemill-expand.sh

# ============================================================================
# LAYERED CONFIGURATION LOADING
# ============================================================================

# Hardcoded defaults (ultimate fallbacks)
_WAVEMILL_DEFAULTS='{
  "linear": { "project": "" },
  "git": {
    "fetchTtlSeconds": 60
  },
  "mill": {
    "session": "",
    "maxParallel": 7,
    "pollSeconds": 10,
    "baseBranch": "main",
    "worktreeRoot": "worktrees",
    "agentCmd": "claude",
    "requireConfirm": true,
    "planningMode": "interactive",
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
  },
  "mergeQueue": {
    "enabled": true,
    "maxConcurrentCandidates": 2,
    "stuckTimeoutSeconds": 900,
    "conflictGroupingEnabled": true,
    "skipCooldownSeconds": 60
  }
}'

# Load layered config: defaults < ~/.wavemill/config.json < .wavemill-config.json
# < .wavemill-config.local.json < env vars
#
# Resolution order (later wins):
#   1. Hardcoded defaults (_WAVEMILL_DEFAULTS)
#   2. User-level config (~/.wavemill/config.json)
#   3. Per-repo config (.wavemill-config.json)
#   4. Per-developer overlay (.wavemill-config.local.json) — gitignored,
#      mirrors the loadWavemillConfig() overlay on the TypeScript side.
#   5. Environment variables (always win)
#
# Sets: SESSION, MAX_PARALLEL, POLL_SECONDS, BASE_BRANCH, WORKTREE_ROOT,
#        AGENT_CMD, REQUIRE_CONFIRM, PLANNING_MODE, MAX_RETRIES, RETRY_DELAY,
#        PROJECT_NAME, MAX_SELECT, MAX_DISPLAY, SETUP_CMD,
#        GIT_FETCH_TTL_SECONDS
#
# Args: $1 = repo directory (default: $PWD)
load_config() {
  local repo_dir="${1:-$PWD}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"
  local local_config="$repo_dir/.wavemill-config.local.json"

  # Read config files (empty object if missing)
  local user_json='{}'
  local repo_json='{}'
  local local_json='{}'
  if [[ -f "$user_config" ]]; then
    user_json=$(cat "$user_config") || user_json='{}'
  fi
  if [[ -f "$repo_config" ]]; then
    repo_json=$(cat "$repo_config") || repo_json='{}'
  fi
  if [[ -f "$local_config" ]]; then
    local_json=$(cat "$local_config") || local_json='{}'
  fi

  # Single jq call: deep-merge all layers, emit shell-safe variable assignments
  local shell_vars
  shell_vars=$(jq -n -r \
    --argjson defaults "$_WAVEMILL_DEFAULTS" \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '
    ($defaults * $user * $repo * $local) as $c |
    [
      "_CFG_PROJECT=\($c.linear.project // "" | @sh)",
      "_CFG_GIT_FETCH_TTL_SECONDS=\($c.git.fetchTtlSeconds // 60)",
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
      "_CFG_ENTER_LAUNCHES_WAVE=\(if ($c.taskSelection | has("enterLaunchesWave")) then $c.taskSelection.enterLaunchesWave else true end)",
      "_CFG_CHALLENGE_ENABLED=\($c.challenge.enabled // false)",
      "_CFG_CHALLENGE_RATE=\($c.challenge.rate // 0.10)",
      "_CFG_CHALLENGE_MODELS=\(($c.challenge.models // null) | @json | @sh)",
      "_CFG_CHALLENGE_COMPARISON_MODEL=\($c.challenge.comparisonModel // "claude-opus-4-7" | @sh)",
      "_CFG_CHALLENGE_AUTO_MERGE=\($c.challenge.autoMergeWinner // false)",
      "_CFG_MERGE_QUEUE_ENABLED=\($c.mergeQueue.enabled // true)",
      "_CFG_MERGE_QUEUE_MAX_CONCURRENT=\($c.mergeQueue.maxConcurrentCandidates // 2)",
      "_CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS=\($c.mergeQueue.stuckTimeoutSeconds // 900)",
      "_CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED=\($c.mergeQueue.conflictGroupingEnabled // true)",
      "_CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS=\($c.mergeQueue.skipCooldownSeconds // 60)",
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
    [[ -f "$local_config" ]] && echo "  $local_config" >&2
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
  GIT_FETCH_TTL_SECONDS="${GIT_FETCH_TTL_SECONDS:-$_CFG_GIT_FETCH_TTL_SECONDS}"
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
  ENTER_LAUNCHES_WAVE="${ENTER_LAUNCHES_WAVE:-$_CFG_ENTER_LAUNCHES_WAVE}"
  CHALLENGE_ENABLED="${CHALLENGE_ENABLED:-$_CFG_CHALLENGE_ENABLED}"
  CHALLENGE_RATE="${CHALLENGE_RATE:-$_CFG_CHALLENGE_RATE}"
  CHALLENGE_MODELS_JSON="${CHALLENGE_MODELS_JSON:-$_CFG_CHALLENGE_MODELS}"
  CHALLENGE_COMPARISON_MODEL="${CHALLENGE_COMPARISON_MODEL:-$_CFG_CHALLENGE_COMPARISON_MODEL}"
  CHALLENGE_AUTO_MERGE="${CHALLENGE_AUTO_MERGE:-$_CFG_CHALLENGE_AUTO_MERGE}"
  MERGE_QUEUE_ENABLED="${MERGE_QUEUE_ENABLED:-$_CFG_MERGE_QUEUE_ENABLED}"
  MERGE_QUEUE_MAX_CONCURRENT="${MERGE_QUEUE_MAX_CONCURRENT:-$_CFG_MERGE_QUEUE_MAX_CONCURRENT}"
  MERGE_QUEUE_STUCK_TIMEOUT_SECONDS="${MERGE_QUEUE_STUCK_TIMEOUT_SECONDS:-$_CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS}"
  MERGE_QUEUE_CONFLICT_GROUPING_ENABLED="${MERGE_QUEUE_CONFLICT_GROUPING_ENABLED:-$_CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED}"
  MERGE_QUEUE_SKIP_COOLDOWN_SECONDS="${MERGE_QUEUE_SKIP_COOLDOWN_SECONDS:-$_CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS}"
  ROUTER_ENABLED="${ROUTER_ENABLED:-$_CFG_ROUTER_ENABLED}"
  ROUTER_DEFAULT_MODEL="${ROUTER_DEFAULT_MODEL:-$_CFG_ROUTER_DEFAULT_MODEL}"
  AUTO_EVAL="${AUTO_EVAL:-$_CFG_AUTO_EVAL}"
  SETUP_CMD="${SETUP_CMD:-$_CFG_SETUP_CMD}"
  DEFAULT_MAX_COST_USD="${DEFAULT_MAX_COST_USD:-$_CFG_DEFAULT_MAX_COST_USD}"

  if [[ "$PLANNING_MODE" != "interactive" ]]; then
    echo "Warning: planningMode='$PLANNING_MODE' is no longer supported; forcing interactive planning." >&2
    PLANNING_MODE="interactive"
  fi

  # WORKTREE_ROOT: resolve relative paths against repo_dir
  local wt_raw="${WORKTREE_ROOT:-$_CFG_WORKTREE_ROOT}"
  if [[ "$wt_raw" != /* ]]; then
    WORKTREE_ROOT="$repo_dir/$wt_raw"
  else
    WORKTREE_ROOT="$wt_raw"
  fi

  # Export for child processes (orchestrator, monitor, agents)
  export SESSION MAX_PARALLEL POLL_SECONDS BASE_BRANCH WORKTREE_ROOT
  export GIT_FETCH_TTL_SECONDS
  export AGENT_CMD REQUIRE_CONFIRM PLANNING_MODE MAX_RETRIES RETRY_DELAY
  export PROJECT_NAME MAX_SELECT MAX_DISPLAY PLAN_MAX_DISPLAY PLAN_RESEARCH PLAN_MODEL
  export DASHBOARD_VERBOSITY DASHBOARD_LOG_TO_FILE
  export ENTER_LAUNCHES_WAVE
  export CHALLENGE_ENABLED CHALLENGE_RATE CHALLENGE_MODELS_JSON
  export CHALLENGE_COMPARISON_MODEL CHALLENGE_AUTO_MERGE
  export MERGE_QUEUE_ENABLED MERGE_QUEUE_MAX_CONCURRENT
  export MERGE_QUEUE_STUCK_TIMEOUT_SECONDS MERGE_QUEUE_CONFLICT_GROUPING_ENABLED
  export MERGE_QUEUE_SKIP_COOLDOWN_SECONDS
  export ROUTER_ENABLED ROUTER_DEFAULT_MODEL AUTO_EVAL SETUP_CMD DEFAULT_MAX_COST_USD

  # Clean up temp variables
  unset _CFG_PROJECT _CFG_GIT_FETCH_TTL_SECONDS _CFG_SESSION _CFG_MAX_PARALLEL _CFG_POLL_SECONDS
  unset _CFG_BASE_BRANCH _CFG_WORKTREE_ROOT _CFG_AGENT_CMD _CFG_REQUIRE_CONFIRM
  unset _CFG_PLANNING_MODE _CFG_MAX_RETRIES _CFG_RETRY_DELAY _CFG_MAX_SELECT _CFG_MAX_DISPLAY
  unset _CFG_PLAN_MAX_DISPLAY _CFG_PLAN_RESEARCH _CFG_PLAN_MODEL
  unset _CFG_DASHBOARD_VERBOSITY _CFG_DASHBOARD_LOG_TO_FILE _CFG_ENTER_LAUNCHES_WAVE
  unset _CFG_CHALLENGE_ENABLED _CFG_CHALLENGE_RATE _CFG_CHALLENGE_MODELS
  unset _CFG_CHALLENGE_COMPARISON_MODEL _CFG_CHALLENGE_AUTO_MERGE
  unset _CFG_MERGE_QUEUE_ENABLED _CFG_MERGE_QUEUE_MAX_CONCURRENT
  unset _CFG_MERGE_QUEUE_STUCK_TIMEOUT_SECONDS _CFG_MERGE_QUEUE_CONFLICT_GROUPING_ENABLED
  unset _CFG_MERGE_QUEUE_SKIP_COOLDOWN_SECONDS
  unset _CFG_ROUTER_ENABLED _CFG_ROUTER_DEFAULT_MODEL _CFG_AUTO_EVAL _CFG_SETUP_CMD _CFG_DEFAULT_MAX_COST_USD

  # Sentinel so downstream scripts can skip re-loading
  _WAVEMILL_CONFIG_LOADED=1
}

wavemill_config_annotation() {
  local path="${1:-}"
  local value="${2:-}"

  printf ' (%s=%s)' "$path" "$value"
}

wavemill_fetch_base_branch() {
  local base_branch="${1:-}"
  shift || true

  local force_fetch="false"
  while (( $# > 0 )); do
    case "$1" in
      --force)
        force_fetch="true"
        ;;
      *)
        return 1
        ;;
    esac
    shift
  done

  [[ -n "$base_branch" ]] || return 1

  local ttl="${GIT_FETCH_TTL_SECONDS:-60}"
  if [[ ! "$ttl" =~ ^[0-9]+$ ]]; then
    ttl=60
  fi

  local now last_fetch_at
  now="$(date +%s)"

  if [[ "$force_fetch" != "true" ]] && (( ttl > 0 )) && [[ -r "${STATE_FILE:-}" ]] && [[ -s "${STATE_FILE:-}" ]]; then
    if last_fetch_at=$(jq -r --arg branch "$base_branch" '.baseBranchFetchCache[$branch].last_fetch_at // empty' "$STATE_FILE" 2>/dev/null); then
      if [[ "$last_fetch_at" =~ ^[0-9]+$ ]] && (( now - last_fetch_at < ttl )); then
        return 0
      fi
    fi
  fi

  local fetch_rc=0
  git -C "$REPO_DIR" fetch origin "$base_branch" || fetch_rc=$?
  if (( fetch_rc != 0 )); then
    return "$fetch_rc"
  fi

  if [[ -n "${STATE_FILE:-}" ]]; then
    local state_dir tmp
    state_dir="$(dirname "$STATE_FILE")"
    mkdir -p "$state_dir" 2>/dev/null || true
    tmp="$(mktemp "${state_dir%/}/fetch-cache.XXXXXX")" || return 0

    if [[ ! -s "$STATE_FILE" ]]; then
      printf '{"tasks":{}}\n' > "$STATE_FILE" 2>/dev/null || true
    fi

    if jq --arg branch "$base_branch" --argjson fetchedAt "$now" \
      '.baseBranchFetchCache = (.baseBranchFetchCache // {})
       | .baseBranchFetchCache[$branch] = ((.baseBranchFetchCache[$branch] // {}) + {last_fetch_at: $fetchedAt})' \
      "$STATE_FILE" > "$tmp" 2>/dev/null; then
      mv "$tmp" "$STATE_FILE"
    else
      rm -f "$tmp"
    fi
  fi
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
  project_name=$(wavemill_load_config "$repo_dir" | jq -r '.linear.project // empty' 2>/dev/null)
  if [[ -z "$project_name" ]]; then
    project_name="${PROJECT_NAME:-}"
  fi
  echo "$project_name"
}

# Returns the operating mode for a specific model: normal|constrained|survival
get_model_operating_mode() {
  local model_id="$1"
  local repo_dir="${2:-${REPO_DIR:-$PWD}}"
  local tools_dir="${TOOLS_DIR:-${repo_dir%/}/tools}"

  npx tsx "$tools_dir/get-operating-mode.ts" model "$model_id" --repo-dir "$repo_dir" 2>/dev/null || echo "normal"
}

# Returns exit code 0 if any model is healthy, 1 if all are degraded/exhausted.
# On unexpected errors (exit code > 1, e.g. npx not found), returns 0 to safely assume models are healthy.
has_any_healthy_model() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  local tools_dir="${TOOLS_DIR:-${repo_dir%/}/tools}"

  npx tsx "$tools_dir/get-operating-mode.ts" any-healthy --repo-dir "$repo_dir" 2>/dev/null
  local exit_code=$?
  if [[ $exit_code -gt 1 ]]; then
    return 0  # Unexpected error, assume models are healthy
  fi
  return $exit_code  # Pass through 0 or 1
}

# ============================================================================
# PR CACHE HELPERS
# ============================================================================

wavemill_pr_cache_refresh() {
  local session="${SESSION:-wavemill}"
  local cache_file="${MONITOR_PR_CACHE:-/tmp/${session}-pr-cache.json}"
  local tmp_file
  # Per-writer tmp file: monitor and dashboard both refresh this cache, and a
  # shared "${cache_file}.tmp" leads to a race where one writer's mv consumes
  # the file before the other's mv runs.
  tmp_file="$(mktemp "${cache_file}.tmp.XXXXXX" 2>/dev/null)" || return 0
  if gh pr list --json number,headRefName,state,statusCheckRollup --limit 50 \
       < /dev/null 2>/dev/null > "$tmp_file"; then
    if [[ -s "$tmp_file" ]]; then
      mv "$tmp_file" "$cache_file" 2>/dev/null || rm -f "$tmp_file"
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi
}

wavemill_pr_lookup_by_branch() {
  local branch="${1:-}"
  local session="${SESSION:-wavemill}"
  local cache_file="${MONITOR_PR_CACHE:-/tmp/${session}-pr-cache.json}"
  [[ -n "$branch" && -f "$cache_file" ]] || return 0
  jq -r --arg b "$branch" \
    '.[] | select(.headRefName == $b) | .number' \
    "${cache_file}" 2>/dev/null | head -1
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
route_read_field() {
  local route_file="$1" field="$2" default_value="${3:-}"
  local value=""

  if [[ ! -f "$route_file" ]]; then
    return 1
  fi

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    return 2
  fi

  value=$(jq -r --arg field "$field" '
    if ($field | contains(".")) then
      ($field | split(".")) as $path | getpath($path) // empty
    else
      .[$field] // .provenance[$field] // empty
    end
  ' "$route_file" 2>/dev/null || true)
  if [[ -n "$value" ]]; then
    echo "$value"
    return 0
  fi

  echo "$default_value"
  return 0
}

write_json_artifact() {
  local target_path="$1"
  local tmp_file
  tmp_file="$(mktemp "${target_path}.tmp.XXXXXX")" || {
    echo "write_json_artifact: failed to allocate temp file for $target_path" >&2
    return 1
  }

  if ! cat > "$tmp_file"; then
    rm -f "$tmp_file"
    echo "write_json_artifact: failed to read JSON payload for $target_path" >&2
    return 1
  fi

  if ! jq -e . "$tmp_file" >/dev/null 2>&1; then
    rm -f "$tmp_file"
    echo "write_json_artifact: invalid JSON for $target_path" >&2
    return 1
  fi

  if ! mv "$tmp_file" "$target_path"; then
    rm -f "$tmp_file"
    echo "write_json_artifact: failed to move temp file into place for $target_path" >&2
    return 1
  fi
}

read_route_json() {
  local session="$1" issue="$2" field="$3" default_value="${4:-}"
  local route_file="/tmp/${session}-${issue}-route.json"
  local suggestion_file="/tmp/${session}-${issue}-model-suggestion.json"
  local value=""

  if value=$(route_read_field "$route_file" "$field" ""); then
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

find_expanded_route_artifact() {
  local feature_dir="$1"
  local route_file=""

  for route_file in \
    "$feature_dir/.post-expansion-route.json" \
    "$feature_dir/.expanded-route.json"; do
    if [[ -f "$route_file" ]]; then
      printf '%s\n' "$route_file"
      return 0
    fi
  done

  return 1
}

get_expansion_handshake_policy() {
  local repo_dir="$1"
  local cfg_policy=""

  cfg_policy=$(wavemill_load_config "$repo_dir" | jq -r '.mill.expansionHandshake.policy // "recover"' 2>/dev/null || echo "recover")
  case "$cfg_policy" in
    recover|block|warn)
      printf '%s\n' "$cfg_policy"
      ;;
    *)
      printf 'recover\n'
      ;;
  esac
}

validate_expanded_route_artifact() {
  local route_file="$1"

  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  jq -e '
    type == "object"
    and (.coder | type == "string" and length > 0)
    and (.codeDepth | type == "string" and length > 0)
    and (.reviewer | type == "string" and length > 0)
    and ((.reviewMode // .reviewRecommended // "") | type == "string" and length > 0)
  ' "$route_file" >/dev/null 2>&1
}

mill_expansion_handshake_reason() {
  local feature_dir="$1"
  local packet_file="$feature_dir/task-packet.md"
  local route_file=""
  local packet_content=""

  if [[ -f "$packet_file" ]]; then
    packet_content=$(cat "$packet_file" 2>/dev/null || echo "")
  fi

  if is_task_packet "$packet_content"; then
    printf 'already-expanded\n'
    return 0
  fi

  route_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  if [[ -n "$route_file" ]]; then
    if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
      printf 'invalid-json\n'
      return 0
    fi
    if validate_expanded_route_artifact "$route_file"; then
      printf 'expanded-route-present\n'
      return 0
    fi
    printf 'missing-required-field\n'
    return 0
  fi

  printf 'missing\n'
  return 0
}

route_lifecycle_route_id() {
  local route_file="$1"
  [[ -n "$route_file" && -f "$route_file" ]] || return 1

  jq -r '
    "coder=\(.coder // ""),codeDepth=\(.codeDepth // ""),reviewer=\(.reviewer // ""),reviewMode=\(.reviewMode // .reviewRecommended // "")"
  ' "$route_file" 2>/dev/null
}

log_route_lifecycle() {
  local event="$1"
  shift || true

  local line="route.lifecycle: event=${event}"
  local token
  for token in "$@"; do
    [[ -n "$token" ]] || continue
    line+=" ${token}"
  done
  log "info" "$line"
}

emit_execution_active_route() {
  local feature_dir="$1" issue="$2"
  local routing_file="$feature_dir/.routing-complete"
  local bootstrap_file="$feature_dir/.initial-route.json"
  local expanded_file=""
  local active_route="" bootstrap_route="" expanded_route="" route_changed="" source=""

  [[ -f "$routing_file" ]] || return 0
  active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
  [[ -n "$active_route" ]] || return 0

  if [[ -f "$bootstrap_file" ]]; then
    bootstrap_route="$(route_lifecycle_route_id "$bootstrap_file" 2>/dev/null || true)"
  fi

  expanded_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  if [[ -n "$expanded_file" ]]; then
    expanded_route="$(route_lifecycle_route_id "$expanded_file" 2>/dev/null || true)"
  fi

  route_changed="false"
  if [[ -n "$bootstrap_route" && "$bootstrap_route" != "$active_route" ]]; then
    route_changed="true"
  fi

  source="bootstrap"
  if [[ -n "$expanded_route" ]]; then
    if [[ "$expanded_route" == "$active_route" ]]; then
      if [[ -n "$bootstrap_route" && "$bootstrap_route" == "$active_route" ]]; then
        source="preserved"
      else
        source="expanded"
      fi
    else
      source="preserved"
    fi
  fi

  log_route_lifecycle "execution_active" \
    "issue=$issue" \
    "route=\"$active_route\"" \
    "route_changed=$route_changed" \
    "source=$source"
}

ensure_phase_config_state_file() {
  local feature_dir="$1"
  local config_file="$feature_dir/.phase-config.json"

  if [[ -f "$config_file" ]] && jq empty "$config_file" >/dev/null 2>&1; then
    return 0
  fi

  mkdir -p "$feature_dir"
  cat > "$config_file" <<'EOF'
{
  "planning": {
    "model": "",
    "agent": "",
    "depth": ""
  },
  "coding": {
    "model": "",
    "agent": "",
    "depth": ""
  },
  "review": {
    "model": "",
    "agent": "",
    "mode": ""
  },
  "resolvedAt": "",
  "forceModel": null
}
EOF
}

apply_expanded_route_if_present() {
  local feature_dir="$1" issue="$2" slug="$3" worktree_dir="$4" state_file="${5:-${STATE_FILE:-}}"
  local route_file routing_file phase_config_file planner_model plan_depth coder_model code_depth reviewer_model review_mode
  local planner_agent="" coder_agent="" reviewer_agent=""
  local active_route="" bootstrap_route="" expanded_route="" route_changed="false" source="expanded"

  route_file="$(find_expanded_route_artifact "$feature_dir" 2>/dev/null || true)"
  [[ -n "$route_file" ]] || return 0

  if ! jq -e '.' "$route_file" >/dev/null 2>&1; then
    log "warn" "expanded route invalid: $route_file (malformed JSON)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  if ! validate_expanded_route_artifact "$route_file"; then
    log "warn" "expanded route invalid: $route_file (missing required execution fields)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  routing_file="$feature_dir/.routing-complete"
  phase_config_file="$feature_dir/.phase-config.json"

  if [[ -f "$routing_file" && ! -f "$feature_dir/.initial-route.json" ]]; then
    cp "$routing_file" "$feature_dir/.initial-route.json"
  fi

  if [[ ! -f "$routing_file" ]]; then
    printf '{}\n' | write_json_artifact "$routing_file"
  fi

  if ! state_mutate "$routing_file" \
    '. as $base
     | $route[0] as $route
     | $base + $route
     | .reviewMode = ($route.reviewMode // $route.reviewRecommended // $base.reviewMode // $base.reviewRecommended // "")
     | .reviewRecommended = .reviewMode
     | .provenance = (($base.provenance // {}) + ($route.provenance // {}) + {
         source: "expanded",
         appliedFrom: $routeFile,
         appliedAt: (
           if (($base.provenance.appliedFrom // "") == $routeFile)
             and (($base.coder // "") == ($route.coder // ""))
             and (($base.codeDepth // "") == ($route.codeDepth // ""))
             and (($base.reviewer // "") == ($route.reviewer // ""))
             and (($base.reviewMode // $base.reviewRecommended // "") == ($route.reviewMode // $route.reviewRecommended // ""))
           then ($base.provenance.appliedAt // (now | todateiso8601))
           else (now | todateiso8601)
           end
         )
       })' \
    --arg routeFile "$route_file" \
    --slurpfile route "$route_file"; then
    log "warn" "expanded route invalid: $route_file (failed to update .routing-complete)"
    active_route="$(route_lifecycle_route_id "$feature_dir/.routing-complete" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  planner_model="$(jq -r '.planner // empty' "$routing_file" 2>/dev/null || true)"
  plan_depth="$(jq -r '.planDepth // empty' "$routing_file" 2>/dev/null || true)"
  coder_model="$(jq -r '.coder // empty' "$routing_file" 2>/dev/null || true)"
  code_depth="$(jq -r '.codeDepth // empty' "$routing_file" 2>/dev/null || true)"
  reviewer_model="$(jq -r '.reviewer // empty' "$routing_file" 2>/dev/null || true)"
  review_mode="$(jq -r '(.reviewMode // .reviewRecommended // empty)' "$routing_file" 2>/dev/null || true)"

  ensure_phase_config_state_file "$feature_dir"

  if declare -F agent_resolve_from_model >/dev/null 2>&1; then
    [[ -n "$planner_model" ]] && planner_agent="$(agent_resolve_from_model "$planner_model")"
    [[ -n "$coder_model" ]] && coder_agent="$(agent_resolve_from_model "$coder_model")"
    [[ -n "$reviewer_model" ]] && reviewer_agent="$(agent_resolve_from_model "$reviewer_model")"
  fi

  if ! state_mutate "$phase_config_file" \
    '.planning.model = $plannerModel
     | .planning.agent = $plannerAgent
     | .planning.depth = $planDepth
     | .coding.model = $coderModel
     | .coding.agent = $coderAgent
     | .coding.depth = $codeDepth
     | .review.model = $reviewerModel
     | .review.agent = $reviewerAgent
     | .review.mode = $reviewMode
     | .resolvedAt = (if (.resolvedAt // "") == "" then (now | todateiso8601) else .resolvedAt end)
     | .forceModel = (.forceModel // null)' \
    --arg plannerModel "$planner_model" \
    --arg plannerAgent "$planner_agent" \
    --arg planDepth "$plan_depth" \
    --arg coderModel "$coder_model" \
    --arg coderAgent "$coder_agent" \
    --arg codeDepth "$code_depth" \
    --arg reviewerModel "$reviewer_model" \
    --arg reviewerAgent "$reviewer_agent" \
    --arg reviewMode "$review_mode"; then
    log "warn" "expanded route invalid: $route_file (failed to update .phase-config.json)"
    active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
    log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
    return 1
  fi

  if [[ -n "$state_file" && -f "$state_file" ]]; then
    if ! state_mutate "$state_file" \
      '.tasks[$issue].plannerModel = $plannerModel
       | .tasks[$issue].coderModel = $coderModel
       | .tasks[$issue].reviewerModel = $reviewerModel
       | .tasks[$issue].planDepth = $planDepth
       | .tasks[$issue].codeDepth = $codeDepth
       | .tasks[$issue].reviewMode = $reviewMode
       | .tasks[$issue].slug = (.tasks[$issue].slug // $slug)
       | .tasks[$issue].worktree = (.tasks[$issue].worktree // $worktree)
       | .tasks[$issue].updated = (now | todate)' \
      --arg issue "$issue" \
      --arg slug "$slug" \
      --arg worktree "$worktree_dir" \
      --arg plannerModel "$planner_model" \
      --arg coderModel "$coder_model" \
      --arg reviewerModel "$reviewer_model" \
      --arg planDepth "$plan_depth" \
      --arg codeDepth "$code_depth" \
      --arg reviewMode "$review_mode"; then
      log "warn" "expanded route invalid: $route_file (failed to update workflow state)"
      active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
      log_route_lifecycle "expansion_failed" "issue=$issue" "reason=invalid_artifact" "active_route=\"${active_route}\""
      return 1
    fi
  fi

  bootstrap_route="$(route_lifecycle_route_id "$feature_dir/.initial-route.json" 2>/dev/null || true)"
  expanded_route="$(route_lifecycle_route_id "$route_file" 2>/dev/null || true)"
  active_route="$(route_lifecycle_route_id "$routing_file" 2>/dev/null || true)"
  if [[ -n "$bootstrap_route" && -n "$active_route" && "$bootstrap_route" != "$active_route" ]]; then
    route_changed="true"
  fi
  if [[ -n "$bootstrap_route" && "$bootstrap_route" == "$active_route" ]]; then
    source="preserved"
  fi

  local is_cache_hit
  is_cache_hit="$(jq -r '.cache_hit // false' "$route_file" 2>/dev/null || echo "false")"

  if [[ "$is_cache_hit" == "true" ]]; then
    local packet_hash
    packet_hash="$(jq -r '.packet_hash // ""' "$route_file" 2>/dev/null || true)"
    log_route_lifecycle "expansion_cache_hit" \
      "issue=$issue" \
      "route=\"${expanded_route}\"" \
      "packet_hash=${packet_hash:0:12}"
  else
    log_route_lifecycle "expanded_assigned" \
      "issue=$issue" \
      "bootstrap_route=\"${bootstrap_route}\"" \
      "expanded_route=\"${expanded_route}\"" \
      "route_changed=$route_changed" \
      "source=$source"
  fi

  return 0
}

# Gate: check expansion handshake before plan→code transition.
# Args: <feature_dir> <issue> <repo_dir>
# Returns 0 (pass or warn) or 1 (block).
mill_check_expansion_handshake() {
  local feature_dir="$1" issue="$2" repo_dir="$3"
  local reason policy

  reason="$(mill_expansion_handshake_reason "$feature_dir")"
  case "$reason" in
    already-expanded|expanded-route-present)
      log "info" "[expansion-handshake] PASS issue=$issue reason=$reason"
      return 0
      ;;
  esac

  policy="$(get_expansion_handshake_policy "$repo_dir")"

  if [[ "$policy" == "warn" ]]; then
    log "warn" "[expansion-handshake] WARN issue=$issue reason=$reason policy=warn"
    return 0
  fi

  log "warn" "[expansion-handshake] BLOCKED issue=$issue reason=$reason policy=$policy recover=\"wavemill expand $issue\""
  return 1
}

expansion_recovery_state_file() {
  local feature_dir="$1"
  printf '%s/.expansion-recovery-state.json\n' "$feature_dir"
}

ensure_expansion_recovery_state_file() {
  local feature_dir="$1"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  if [[ -f "$state_file" ]]; then
    return 0
  fi

  printf '{}\n' | write_json_artifact "$state_file"
}

expansion_recovery_already_attempted() {
  local feature_dir="$1"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  [[ -f "$state_file" ]] || return 1
  jq -e '.attempted == true' "$state_file" >/dev/null 2>&1
}

expansion_recovery_mark_attempted() {
  local feature_dir="$1" issue="$2" reason="$3"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  ensure_expansion_recovery_state_file "$feature_dir" || return 1
  state_mutate "$state_file" \
    '.attempted = true
     | .issue = $issue
     | .reason = $reason
     | .status = (.status // "pending")
     | .attemptedAt = (.attemptedAt // (now | todateiso8601))
     | .completedAt = (.completedAt // null)
     | .exitCode = (.exitCode // null)
     | .detail = (.detail // "")' \
    --arg issue "$issue" \
    --arg reason "$reason"
}

expansion_recovery_mark_result() {
  local feature_dir="$1" issue="$2" status="$3" detail="${4:-}" exit_code="${5:-}"
  local state_file
  state_file="$(expansion_recovery_state_file "$feature_dir")"

  ensure_expansion_recovery_state_file "$feature_dir" || return 1
  state_mutate "$state_file" \
    '.attempted = true
     | .issue = $issue
     | .status = $status
     | .detail = $detail
     | .completedAt = (now | todateiso8601)
     | .exitCode = (if $exitCode == "" then null else ($exitCode | tonumber) end)' \
    --arg issue "$issue" \
    --arg status "$status" \
    --arg detail "$detail" \
    --arg exitCode "$exit_code"
}

wavemill_command_file_path() {
  local session="$1"
  printf '/tmp/wavemill-%s-commands\n' "$session"
}

# Output the merged wavemill config JSON for a repo dir, applying
# .wavemill-config.local.json (gitignored) on top of .wavemill-config.json.
# Mirrors loadWavemillConfig() in shared/lib/config.ts: objects are recursively
# merged via jq's `*`, arrays are replaced. Use this in shell sites that need to
# see per-developer overrides — currently the integration-window spawn gate.
# Most shell reads of the base file remain direct; migrate when an overlay
# need surfaces for them.
wavemill_load_config() {
  local repo_dir="$1"
  local base="$repo_dir/.wavemill-config.json"
  local lcl="$repo_dir/.wavemill-config.local.json"
  if [[ -f "$base" && -f "$lcl" ]]; then
    jq -s '.[0] * .[1]' "$base" "$lcl" 2>/dev/null || cat "$base" 2>/dev/null || echo '{}'
  elif [[ -f "$base" ]]; then
    cat "$base"
  elif [[ -f "$lcl" ]]; then
    cat "$lcl"
  else
    echo '{}'
  fi
}

wavemill_command_offset_path() {
  local session="$1"
  printf '/tmp/wavemill-%s-commands.offset\n' "$session"
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

# Fields mill startup reads from issue.json. Keep this aligned with the
# startup consumers before broadening backlog-payload reuse.
# Note: labels.nodes is also required (checked separately in jq filter below)
_WAVEMILL_REQUIRED_ISSUE_FIELDS=(identifier title description)

# issue_payload_is_complete <json>
# Exit 0 when startup can safely reuse the backlog payload as issue.json.
# Accepts JSON as $1 or on stdin.
issue_payload_is_complete() {
  local json="${1:-}"
  if [[ -z "$json" ]]; then
    json=$(cat)
  fi

  local field_filter field
  field_filter='['
  for field in "${_WAVEMILL_REQUIRED_ISSUE_FIELDS[@]}"; do
    field_filter+="\"$field\","
  done
  field_filter="${field_filter%,}]"

  local ok
  ok=$(printf '%s' "$json" | jq -e --argjson required_fields "$field_filter" '
    . as $record |
    ($required_fields | all(. as $field | (($record[$field] // "") != "")))
    and ((.labels.nodes | type) == "array")
  ' 2>/dev/null) || return 1

  [[ "$ok" == "true" ]]
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
  state_mutate "$state_file" \
    '.tasks[$issue].phase = $phase | .tasks[$issue].updated = (now | todate)' \
    --arg issue "$issue" --arg phase "$phase"
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

normalize_worktree_path() {
  local path="$1"
  local parent_dir base_name

  if [[ -d "$path" ]]; then
    (cd "$path" && pwd -P)
    return 0
  fi

  parent_dir="$(dirname "$path")"
  base_name="$(basename "$path")"
  if [[ -d "$parent_dir" ]]; then
    printf '%s/%s\n' "$(cd "$parent_dir" && pwd -P)" "$base_name"
    return 0
  fi

  printf '%s\n' "$path"
}

ensure_worktree() {
  local branch="$1"
  local desired_path="$2"
  local repo_dir="${3:-$PWD}"
  local worktree_list="" existing_path="" line="" current_path=""
  local hook_script agent_name
  local desired_cmp_path existing_cmp_path

  if ! worktree_list="$(git -C "$repo_dir" worktree list --porcelain 2>/dev/null)"; then
    echo "Error: failed to inspect git worktree registrations for $branch" >&2
    if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] && command -v jq >/dev/null 2>&1; then
      hook_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)/wavemill-hook-protocol.sh"
      if ! declare -F wavemill_hook_write >/dev/null 2>&1 && [[ -f "$hook_script" ]]; then
        # shellcheck source=/dev/null
        source "$hook_script"
      fi
      if declare -F wavemill_hook_write >/dev/null 2>&1; then
        agent_name="${AGENT_CMD:-${CURRENT_AGENT:-wavemill}}"
        wavemill_hook_write "error" "worktree-setup" "worktree-collision" "$agent_name" || true
      fi
    fi
    return 1
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      worktree\ *)
        current_path="${line#worktree }"
        ;;
      branch\ refs/heads/*)
        if [[ "${line#branch refs/heads/}" == "$branch" ]]; then
          existing_path="$current_path"
          break
        fi
        ;;
      "")
        current_path=""
        ;;
    esac
  done <<< "$worktree_list"

  desired_cmp_path="$(normalize_worktree_path "$desired_path")"

  if [[ -z "$existing_path" ]]; then
    git -C "$repo_dir" worktree add "$desired_path" "$branch" >/dev/null || return 1
    printf '%s\n' "$desired_path"
    return 0
  fi

  existing_cmp_path="$(normalize_worktree_path "$existing_path")"

  if [[ "$existing_cmp_path" == "$desired_cmp_path" ]]; then
    if [[ -d "$existing_path" ]]; then
      printf '%s\n' "$desired_path"
      return 0
    fi
    echo "Detected stale worktree registration for $branch at $desired_path; pruning" >&2
  else
    if [[ -d "$existing_path" ]]; then
      echo "Reusing existing worktree for $branch at $existing_path" >&2
      printf '%s\n' "$existing_path"
      return 0
    fi
    echo "Detected stale worktree registration for $branch at $existing_path; recreating at $desired_path" >&2
  fi

  if ! git -C "$repo_dir" worktree prune >/dev/null; then
    echo "Error: failed to prune stale worktree registration for $branch" >&2
  elif git -C "$repo_dir" worktree add "$desired_path" "$branch" >/dev/null; then
    printf '%s\n' "$desired_path"
    return 0
  fi

  echo "Error: failed to prepare worktree for $branch" >&2
  if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]] && command -v jq >/dev/null 2>&1; then
    hook_script="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)/wavemill-hook-protocol.sh"
    if ! declare -F wavemill_hook_write >/dev/null 2>&1 && [[ -f "$hook_script" ]]; then
      # shellcheck source=/dev/null
      source "$hook_script"
    fi
    if declare -F wavemill_hook_write >/dev/null 2>&1; then
      agent_name="${AGENT_CMD:-${CURRENT_AGENT:-wavemill}}"
      wavemill_hook_write "error" "worktree-setup" "worktree-collision" "$agent_name" || true
    fi
  fi
  return 1
}

wavemill_lock_run() {
  local lock_name="$1"
  shift

  local session="${SESSION:-global}"
  local lock_root="/tmp/wavemill-${session}-locks"
  mkdir -p "$lock_root"

  if command -v flock >/dev/null 2>&1; then
    local lock_file="$lock_root/${lock_name}"
    touch "$lock_file"
    { flock -x 9; "$@"; } 9>"$lock_file"
    return
  fi

  local lock_dir="$lock_root/${lock_name}.lk"
  local attempts=0
  local max_retries="${WAVEMILL_LOCK_MAX_RETRIES:-300}"
  local sleep_seconds="${WAVEMILL_LOCK_SLEEP_SECONDS:-0.1}"
  while ! mkdir "$lock_dir" 2>/dev/null; do
    attempts=$((attempts + 1))
    if (( attempts >= max_retries )); then
      if declare -F startup_log >/dev/null 2>&1; then
        startup_log "Warning: wavemill_lock_run timeout on $lock_name; aborting locked operation"
      fi
      return 1
    fi
    sleep "$sleep_seconds"
  done

  "$@"
  local rc=$?
  rmdir "$lock_dir" 2>/dev/null || true
  return "$rc"
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

# Mutate a JSON state file under a portable POSIX lock.
# Usage: state_mutate <state_path> <jq_filter> [jq_args...]
state_mutate() {
  local state_path="$1" jq_filter="$2"
  shift 2

  local lock_dir="${state_path}.lock"
  local tmp_file="${state_path}.tmp.$$.$RANDOM"
  local err_file="/tmp/wavemill-state-mutate-$$.$RANDOM.err"
  local max_retries="${STATE_MUTATE_MAX_RETRIES:-50}"
  local sleep_seconds="${STATE_MUTATE_SLEEP_SECONDS:-0.1}"
  local retry=0

  if [[ ! -f "$state_path" ]]; then
    echo "state_mutate: state file not found: $state_path" >&2
    return 1
  fi

  while ! mkdir "$lock_dir" 2>/dev/null; do
    retry=$((retry + 1))
    if (( retry >= max_retries )); then
      echo "state_mutate: lock timeout on $state_path after $max_retries retries" >&2
      return 1
    fi
    sleep "$sleep_seconds"
  done

  local mutate_status=0
  if jq "$@" "$jq_filter" "$state_path" > "$tmp_file" 2>"$err_file"; then
    mv "$tmp_file" "$state_path" || mutate_status=$?
  else
    mutate_status=$?
    cat "$err_file" >&2
  fi

  rm -f "$tmp_file" "$err_file"
  if ! rmdir "$lock_dir" 2>/dev/null && (( mutate_status == 0 )); then
    echo "state_mutate: failed to release lock: $lock_dir" >&2
    return 1
  fi

  return "$mutate_status"
}

queue_add_task() {
  local issue_id="${1:-}" blocker_issue_id="${2:-}" blocker_pr_number="${3:-}" desired_base_branch="${4:-}" linear_issue_url="${5:-}"
  local slug="${6:-}" title="${7:-}"
  if [[ -z "$issue_id" || -z "$blocker_issue_id" || -z "$blocker_pr_number" || -z "$desired_base_branch" || -z "$linear_issue_url" ]]; then
    echo "Usage: queue_add_task <issue_id> <blocker_issue_id> <blocker_pr_number> <desired_base_branch> <linear_url> [slug] [title]" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(select(.issue_id != $issue_id))) + [{
      issue_id: $issue_id,
      blocker_issue_id: $blocker_issue_id,
      blocker_pr_number: (if $blocker_pr_number == "null" then null else ($blocker_pr_number | tonumber) end),
      desired_base_branch: $desired_base_branch,
      linear_issue_url: $linear_issue_url,
      slug: $slug,
      title: $title,
      queued_at: (now | todate)
    }]' \
    --arg issue_id "$issue_id" \
    --arg blocker_issue_id "$blocker_issue_id" \
    --arg blocker_pr_number "$blocker_pr_number" \
    --arg desired_base_branch "$desired_base_branch" \
    --arg linear_issue_url "$linear_issue_url" \
    --arg slug "$slug" \
    --arg title "$title"
}

queue_remove_task() {
  local issue_id="${1:-}"
  if [[ -z "$issue_id" ]]; then
    echo "Usage: queue_remove_task <issue_id>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(select(.issue_id != $issue_id)))' \
    --arg issue_id "$issue_id"
}

queue_list_tasks() {
  [[ -f "$STATE_FILE" ]] || {
    printf '[]\n'
    return 0
  }
  jq -r '.queued_tasks // []' "$STATE_FILE"
}

find_queued_children_for_parent() {
  local parent_issue="${1:-}"
  if [[ -z "$parent_issue" ]]; then
    echo "Usage: find_queued_children_for_parent <parent_issue>" >&2
    return 1
  fi

  [[ -f "$STATE_FILE" ]] || {
    printf '[]\n'
    return 0
  }

  jq -c --arg parent_issue "$parent_issue" \
    '[.queued_tasks[]? | select(.blocker_issue_id == $parent_issue and ((.waiting_reason // "") == ""))]' \
    "$STATE_FILE"
}

resolve_parent_pr_branch() {
  local pr_number="${1:-}"
  if [[ -z "$pr_number" ]]; then
    echo "Usage: resolve_parent_pr_branch <pr_number>" >&2
    return 1
  fi

  local pr_json
  if ! pr_json=$(gh pr view "$pr_number" --json headRefName,url,number 2>&1); then
    printf '%s\n' "$pr_json" >&2
    return 1
  fi

  local branch url resolved_number
  branch=$(printf '%s' "$pr_json" | jq -r '.headRefName // ""' 2>/dev/null || echo "")
  url=$(printf '%s' "$pr_json" | jq -r '.url // ""' 2>/dev/null || echo "")
  resolved_number=$(printf '%s' "$pr_json" | jq -r '.number // empty' 2>/dev/null || echo "")
  if [[ -z "$branch" || "$branch" == "null" ]]; then
    echo "parent PR #$pr_number is missing headRefName" >&2
    return 1
  fi

  printf '%s|%s|%s\n' "$branch" "${resolved_number:-$pr_number}" "$url"
}

record_depends_on_metadata() {
  local child_issue="${1:-}" pr_number="${2:-}" pr_url="${3:-}" pr_branch="${4:-}" parent_issue="${5:-}"
  if [[ -z "$child_issue" || -z "$pr_number" || -z "$pr_url" || -z "$pr_branch" || -z "$parent_issue" ]]; then
    echo "Usage: record_depends_on_metadata <child_issue> <pr_number> <pr_url> <pr_branch> <parent_issue>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.tasks[$issue] = ((.tasks[$issue] // {}) + {
      dependsOnPr: {
        number: ($pr_number | tonumber),
        url: $pr_url,
        branch: $pr_branch,
        parent_issue: $parent_issue
      }
    })' \
    --arg issue "$child_issue" \
    --arg pr_number "$pr_number" \
    --arg pr_url "$pr_url" \
    --arg pr_branch "$pr_branch" \
    --arg parent_issue "$parent_issue"
}

queue_mark_waiting() {
  local child_issue="${1:-}" reason="${2:-}"
  if [[ -z "$child_issue" || -z "$reason" ]]; then
    echo "Usage: queue_mark_waiting <child_issue> <reason>" >&2
    return 1
  fi

  state_mutate "$STATE_FILE" \
    '.queued_tasks = ((.queued_tasks // []) | map(if .issue_id == $issue then (.waiting_reason = $reason) else . end))' \
    --arg issue "$child_issue" \
    --arg reason "$reason"
}
