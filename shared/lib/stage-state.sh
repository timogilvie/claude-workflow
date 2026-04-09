#!/opt/homebrew/bin/bash
# Stage State Management Library
# Controller-owned stage state for phased workflow orchestration (HOK-1177).
#
# Manages .phase-config.json as the canonical source of stage state,
# with legacy marker-file fallback for backward compatibility.

# ============================================================================
# TRANSITION VALIDATION
# ============================================================================

# Validate that a stage transition is allowed.
# Returns 0 if valid, 1 if invalid.
_stage_state_validate_transition() {
  local from="$1" to="$2"
  case "${from}:${to}" in
    routing:planning)       return 0 ;;
    planning:awaiting_user) return 0 ;;
    planning:aborted)       return 0 ;;
    awaiting_user:coding)   return 0 ;;
    awaiting_user:planning) return 0 ;;
    awaiting_user:aborted)  return 0 ;;
    coding:review)          return 0 ;;
    coding:aborted)         return 0 ;;
    review:ready)           return 0 ;;
    review:aborted)         return 0 ;;
    ready:aborted)          return 0 ;;
    *)                      return 1 ;;
  esac
}

# ============================================================================
# PHASE CONFIG MANAGEMENT
# ============================================================================

# Initialize .phase-config.json in a feature directory.
# No-op if the file already exists (resume safety).
#
# Args:
#   $1 = feature_dir (absolute path to features/<slug>/)
#   $2 = initial_stage (default: "planning")
stage_state_init() {
  local feature_dir="$1"
  local initial_stage="${2:-planning}"
  local config_file="$feature_dir/.phase-config.json"

  if [[ -f "$config_file" ]]; then
    return 0
  fi

  mkdir -p "$feature_dir"

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local tmp
  tmp=$(mktemp) || { log_warn "stage_state_init: mktemp failed"; return 1; }

  # Build initial stages object: initial_stage is in_progress, others pending
  local stages_json='{}'
  local all_stages=("planning" "awaiting_user" "coding" "review" "ready")
  for s in "${all_stages[@]}"; do
    if [[ "$s" == "$initial_stage" ]]; then
      stages_json=$(printf '%s' "$stages_json" | jq --arg s "$s" --arg now "$now" \
        '.[$s] = {"status": "in_progress", "started_at": $now}')
    else
      stages_json=$(printf '%s' "$stages_json" | jq --arg s "$s" \
        '.[$s] = {"status": "pending"}')
    fi
  done

  if jq -n \
    --argjson version 1 \
    --arg current_stage "$initial_stage" \
    --argjson stages "$stages_json" \
    --arg now "$now" \
    --arg reason "task_start" \
    '{
      version: $version,
      current_stage: $current_stage,
      stages: $stages,
      history: [{ from: null, to: $current_stage, timestamp: $now, reason: $reason }]
    }' > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
    mv "$tmp" "$config_file"
  else
    rm -f "$tmp"
    log_warn "stage_state_init: failed to write $config_file"
    return 1
  fi
}

# Read current stage from .phase-config.json.
# Falls back to legacy marker detection when the config file is absent or malformed.
#
# Args:
#   $1 = feature_dir
# Stdout: current stage name
stage_state_get_current() {
  local feature_dir="$1"
  local config_file="$feature_dir/.phase-config.json"

  if [[ ! -f "$config_file" ]]; then
    stage_state_legacy_detect "$feature_dir"
    return 0
  fi

  local current
  if current=$(jq -r '.current_stage // empty' "$config_file" 2>/dev/null) && [[ -n "$current" ]]; then
    printf '%s\n' "$current"
  else
    log_warn "stage_state_get_current: malformed $config_file, falling back to legacy detection"
    stage_state_legacy_detect "$feature_dir"
  fi
}

# Transition to a new stage. Validates the transition, updates .phase-config.json,
# and appends to history.
#
# Args:
#   $1 = feature_dir
#   $2 = new_stage
#   $3 = reason (e.g., "plan_complete", "plan_approved", "coding_complete")
# Returns: 0 on success, 1 on invalid transition or write failure
stage_state_transition() {
  local feature_dir="$1"
  local new_stage="$2"
  local reason="${3:-}"
  local config_file="$feature_dir/.phase-config.json"

  # If no config file exists yet, initialize it with the target stage
  if [[ ! -f "$config_file" ]]; then
    stage_state_init "$feature_dir" "$new_stage"
    return $?
  fi

  local current
  current=$(jq -r '.current_stage // empty' "$config_file" 2>/dev/null)
  if [[ -z "$current" ]]; then
    log_warn "stage_state_transition: cannot read current stage from $config_file"
    return 1
  fi

  if ! _stage_state_validate_transition "$current" "$new_stage"; then
    log_warn "stage_state_transition: invalid transition $current -> $new_stage"
    return 1
  fi

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  local tmp
  tmp=$(mktemp) || { log_warn "stage_state_transition: mktemp failed"; return 1; }

  if jq \
    --arg new_stage "$new_stage" \
    --arg old_stage "$current" \
    --arg now "$now" \
    --arg reason "$reason" \
    '
      .current_stage = $new_stage |
      .stages[$old_stage].status = "completed" |
      .stages[$old_stage].finished_at = $now |
      .stages[$new_stage].status = "in_progress" |
      .stages[$new_stage].started_at = $now |
      .history += [{ from: $old_stage, to: $new_stage, timestamp: $now, reason: $reason }]
    ' "$config_file" > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
    mv "$tmp" "$config_file"

    # Dual-write legacy markers for backward compatibility during rollout
    case "$new_stage" in
      planning)  touch "$feature_dir/.routing-complete" ;;
      coding)    touch "$feature_dir/.plan-approved" ;;
      review)    touch "$feature_dir/.coding-complete" ;;
      aborted)   touch "$feature_dir/.workflow-aborted" ;;
    esac
  else
    rm -f "$tmp"
    log_warn "stage_state_transition: failed to update $config_file"
    return 1
  fi
}

# ============================================================================
# LEGACY FALLBACK
# ============================================================================

# Infer stage from legacy marker files when .phase-config.json is absent.
#
# Args:
#   $1 = feature_dir
# Stdout: inferred stage name
stage_state_legacy_detect() {
  local feature_dir="$1"

  if [[ -f "$feature_dir/.workflow-aborted" ]]; then
    printf '%s\n' "aborted"
  elif [[ -f "$feature_dir/.coding-complete" ]]; then
    printf '%s\n' "review"
  elif [[ -f "$feature_dir/.plan-approved" ]]; then
    printf '%s\n' "coding"
  elif [[ -f "$feature_dir/.routing-complete" ]]; then
    printf '%s\n' "planning"
  else
    printf '%s\n' "routing"
  fi
}

# ============================================================================
# STAGE RESULTS
# ============================================================================

# Write a stage-result JSON file after a stage completes.
#
# Args:
#   $1 = feature_dir
#   $2 = stage name
#   $3 = status (completed|failed|aborted)
#   $4 = agent (claude|codex)
#   $5 = model ID
#   $6... = artifact paths (optional, remaining args)
stage_state_write_result() {
  local feature_dir="$1"
  local stage="$2"
  local status="$3"
  local agent="${4:-}"
  local model="${5:-}"
  shift 5 2>/dev/null || true

  local result_file="$feature_dir/.${stage}-result.json"
  mkdir -p "$feature_dir"

  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Read started_at from .phase-config.json if available
  local started_at="$now"
  local config_file="$feature_dir/.phase-config.json"
  if [[ -f "$config_file" ]]; then
    local cfg_started
    cfg_started=$(jq -r --arg s "$stage" '.stages[$s].started_at // empty' "$config_file" 2>/dev/null)
    if [[ -n "$cfg_started" ]]; then
      started_at="$cfg_started"
    fi
  fi

  # Build artifacts array from remaining args
  local artifacts_json='[]'
  for artifact in "$@"; do
    artifacts_json=$(printf '%s' "$artifacts_json" | jq --arg a "$artifact" '. += [$a]')
  done

  local tmp
  tmp=$(mktemp) || { log_warn "stage_state_write_result: mktemp failed"; return 1; }

  if jq -n \
    --arg stage "$stage" \
    --arg status "$status" \
    --arg startedAt "$started_at" \
    --arg finishedAt "$now" \
    --arg agent "$agent" \
    --arg model "$model" \
    --argjson artifacts "$artifacts_json" \
    '{
      stage: $stage,
      status: $status,
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      agent: $agent,
      model: $model,
      artifacts: $artifacts
    }' > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
    mv "$tmp" "$result_file"
  else
    rm -f "$tmp"
    log_warn "stage_state_write_result: failed to write $result_file"
    return 1
  fi
}

# ============================================================================
# CONVENIENCE HELPERS
# ============================================================================

# Check if current stage is awaiting_user.
# Returns 0 if true, 1 otherwise.
stage_state_is_awaiting_user() {
  local feature_dir="$1"
  local current
  current=$(stage_state_get_current "$feature_dir")
  [[ "$current" == "awaiting_user" ]]
}
