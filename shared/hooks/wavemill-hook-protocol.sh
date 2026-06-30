#!/usr/bin/env bash
# Shared hook protocol helpers for wavemill agent status tracking.
#
# This library provides reusable functions for agent hooks to report status
# in a standardized format. Hooks are no-ops outside wavemill contexts.

# Verify we are running inside a wavemill-launched agent context.
# Hooks must be no-ops outside wavemill to avoid disrupting standalone use.
wavemill_hook_check() {
  [[ -n "${WAVEMILL_SESSION:-}" ]] || exit 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
}

# Send USR1 to dashboard process to trigger an immediate refresh.
# Best-effort only: never fail, even when PID is stale or invalid.
wavemill_hook_notify() {
  local dashboard_pid="${WAVEMILL_DASHBOARD_PID:-}"
  [[ -n "$dashboard_pid" ]] || return 0

  # Validate PID before signaling.
  [[ "$dashboard_pid" =~ ^[0-9]+$ ]] || return 0
  [[ "$dashboard_pid" -eq 0 ]] && return 0
  kill -0 "$dashboard_pid" 2>/dev/null || return 0

  kill -USR1 "$dashboard_pid" 2>/dev/null || true
  if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]]; then
    (
      local hook_dir helper state_file
      hook_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null || true)"
      helper="${hook_dir%/hooks}/lib/wavemill-window-titles.sh"
      [[ -f "$helper" ]] || exit 0
      # shellcheck source=wavemill-window-titles.sh
      source "$helper" || exit 0
      state_file="${WAVEMILL_STATE_FILE:-${STATE_FILE:-}}"
      wavemill_apply_window_metadata "${WAVEMILL_SESSION:-}" "${WAVEMILL_ISSUE:-}" "" "$state_file" >/dev/null 2>&1 || true
    ) 2>/dev/null || true
  fi
  return 0
}

_wavemill_hook_osc_allowed_context() {
  case "${WAVEMILL_PHASE:-}" in
    planning|coding|review|reviewing) return 0 ;;
    *) return 1 ;;
  esac
}

_wavemill_hook_config_file() {
  local repo_dir="${WAVEMILL_REPO_DIR:-}"
  local config_file=""
  local git_root=""

  if [[ -n "$repo_dir" ]]; then
    config_file="${repo_dir%/}/.wavemill-config.json"
    [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0
  fi

  config_file="$PWD/.wavemill-config.json"
  [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0

  if command -v git >/dev/null 2>&1; then
    git_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    if [[ -n "$git_root" ]]; then
      config_file="${git_root%/}/.wavemill-config.json"
      [[ -r "$config_file" ]] && printf '%s\n' "$config_file" && return 0
    fi
  fi

  return 1
}

_wavemill_hook_osc_enabled() {
  local config_file=""
  local enabled="true"

  command -v jq >/dev/null 2>&1 || return 0
  config_file="$(_wavemill_hook_config_file)" || return 0

  enabled="$(
    jq -r '
      if (.hooks? | type == "object")
         and (.hooks | has("emitOsc"))
         and .hooks.emitOsc == false then
        "false"
      else
        "true"
      end
    ' "$config_file" 2>/dev/null || printf 'true'
  )"

  [[ "$enabled" != "false" ]]
}

_wavemill_hook_osc_sanitize() {
  local value="${1:-}"
  printf '%s' "$value" | LC_ALL=C tr -d '[:cntrl:];'
}

_wavemill_hook_osc_body() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="${4:-}"
  local context=""

  if [[ -n "$detail" ]]; then
    context="$detail"
  elif [[ -n "$event" ]]; then
    context="$event"
  else
    context="$agent"
  fi

  case "$state" in
    working)
      [[ -n "$context" ]] && printf 'working: %s' "$context" || printf 'working'
      ;;
    waiting)
      [[ -n "$context" ]] && printf 'waiting on %s' "$context" || printf 'waiting'
      ;;
    blocked)
      [[ -n "$context" ]] && printf 'blocked: %s' "$context" || printf 'blocked'
      ;;
    approval-needed)
      [[ -n "$context" ]] && printf 'approval needed: %s' "$context" || printf 'approval needed'
      ;;
    policy-denied)
      [[ -n "$context" ]] && printf 'policy denied: %s' "$context" || printf 'policy denied'
      ;;
    error)
      [[ -n "$context" ]] && printf 'error in %s' "$context" || printf 'error'
      ;;
    idle)
      [[ -n "$context" ]] && printf 'idle: %s' "$context" || printf 'idle'
      ;;
    *)
      printf '%s' "$state"
      ;;
  esac
}

_wavemill_hook_osc_sequence() {
  local title="$(_wavemill_hook_osc_sanitize "${1:-}")"
  local body="$(_wavemill_hook_osc_sanitize "${2:-}")"
  printf '\033]777;notify;%s;%s\033\\' "$title" "$body"
}

_wavemill_hook_osc_wrap() {
  local payload="${1:-}"
  local escaped_payload="$payload"

  if [[ -n "${TMUX:-}" ]]; then
    escaped_payload="${escaped_payload//$'\033'/$'\033\033'}"
    printf '\033Ptmux;%s\033\\' "$escaped_payload"
    return 0
  fi

  printf '%s' "$payload"
}

_wavemill_hook_emit_osc() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"
  local issue="${WAVEMILL_ISSUE:-}"
  local title="wavemill"
  local body=""
  local sequence=""
  local wrapped=""

  _wavemill_hook_osc_allowed_context || return 0
  _wavemill_hook_osc_enabled || return 0

  case "$state" in
    waiting|approval-needed|policy-denied|error) ;;
    *) return 0 ;;
  esac

  if [[ -n "$issue" ]]; then
    title="wavemill $issue"
  fi

  body="$(_wavemill_hook_osc_body "$state" "$event" "$detail" "$agent")"
  sequence="$(_wavemill_hook_osc_sequence "$title" "$body")"
  wrapped="$(_wavemill_hook_osc_wrap "$sequence")"

  printf '%s' "$wrapped" >&2 2>/dev/null || true
  return 0
}

# Atomically write the standardized hook status payload.
# Args: state, event, detail, agent [next_action]
#
# States: working (agent is actively processing), idle (agent stopped normally),
#         waiting (agent blocked on user input), blocked (agent cannot proceed),
#         approval-needed (agent paused awaiting explicit approval),
#         policy-denied (action rejected by policy), error (agent encountered failure)
#
# The optional next_action field carries a short hint for the dashboard (e.g. the
# action the operator should take). It is additive and does not affect readers that
# only know the four-state contract.
#
# The hook file uses a 300s TTL - consumers should fall back to other signals
# (pane liveness, process monitoring) if the timestamp is stale.
wavemill_hook_write() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"
  local next_action="${5:-}"

  # Only write recognized states; unknown states are silently dropped so that
  # readers never see partial or malformed JSON from an unrecognized write.
  case "$state" in
    working|idle|waiting|blocked|approval-needed|policy-denied|error) ;;
    *) return 0 ;;
  esac

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local timestamp
  timestamp=$(date +%s)

  local base_json='{}'
  if [[ -f "$hook_file" ]] && jq -e . "$hook_file" >/dev/null 2>&1; then
    base_json="$(cat "$hook_file")"
  fi

  # Atomic write: build JSON in tmp, then mv (prevents partial reads)
  if jq -n \
    --argjson base "$base_json" \
    --arg state "$state" \
    --arg event "$event" \
    --arg detail "$detail" \
    --arg agent "$agent" \
    --arg next_action "$next_action" \
    --argjson timestamp "$timestamp" \
    '$base + {state: $state, event: $event, agent: $agent, timestamp: $timestamp}
     + (if $detail != "" then {detail: $detail} else {} end)
     + (if $next_action != "" then {next_action: $next_action} else {} end)' > "$tmp_file" 2>/dev/null; then
    if mv "$tmp_file" "$hook_file" 2>/dev/null; then
      wavemill_hook_notify
      _wavemill_hook_emit_osc "$state" "$event" "$detail" "$agent" || true
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi

  return 0
}

wavemill_hook_write_routing() {
  local role="$1"
  local routing_json="$2"

  case "$role" in
    planner|coder|reviewer) ;;
    *) return 0 ;;
  esac

  [[ -n "${WAVEMILL_SESSION:-}" ]] || return 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || return 0
  command -v jq >/dev/null 2>&1 || return 0

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local base_json="{}"

  if [[ -f "$hook_file" ]] && jq -e . "$hook_file" >/dev/null 2>&1; then
    base_json="$(cat "$hook_file")"
  fi

  if jq -n \
    --argjson base "$base_json" \
    --arg role "$role" \
    --argjson routing "$routing_json" \
    '$base + {routing: (($base.routing // {}) + {($role): $routing})}' > "$tmp_file" 2>/dev/null; then
    if mv "$tmp_file" "$hook_file" 2>/dev/null; then
      wavemill_hook_notify
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi
  return 0
}
