#!/usr/bin/env bash
# Shared hook protocol helpers for wavemill agent status tracking.
#
# This library provides reusable functions for agent hooks to report status
# in a standardized format. Hooks are no-ops outside wavemill contexts.

# Cache for OSC emission config gate (script-scoped).
_WAVEMILL_HOOK_OSC_ENABLED_CACHE=""

# Verify we are running inside a wavemill-launched agent context.
# Hooks must be no-ops outside wavemill to avoid disrupting standalone use.
wavemill_hook_check() {
  [[ -n "${WAVEMILL_SESSION:-}" ]] || exit 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
}

# Check if OSC emission is enabled via config.
# Returns 0 (enabled) by default. Returns 1 only if .hooks.emitOsc is literal boolean false.
# Caches result to avoid repeated config reads.
wavemill_hook_osc_enabled() {
  # Return cached result if available
  if [[ -n "$_WAVEMILL_HOOK_OSC_ENABLED_CACHE" ]]; then
    [[ "$_WAVEMILL_HOOK_OSC_ENABLED_CACHE" == "true" ]]
    return
  fi

  # Default to enabled
  local enabled="true"

  # Check .wavemill-config.json in current directory
  if [[ -f ".wavemill-config.json" ]]; then
    if command -v jq >/dev/null 2>&1; then
      local config_result
      config_result=$(jq -r 'if (.hooks.emitOsc? == false) then "false" else "true" end' ".wavemill-config.json" 2>/dev/null)
      if [[ -n "$config_result" ]]; then
        enabled="$config_result"
      fi
    fi
  fi

  _WAVEMILL_HOOK_OSC_ENABLED_CACHE="$enabled"
  [[ "$enabled" == "true" ]]
}

# Sanitize a string for use in OSC payload by replacing control characters with spaces.
# Args: string to sanitize
wavemill_hook_osc_sanitize() {
  local str="$1"
  # Replace BEL, ESC, CR, and LF with spaces
  str="${str//$'\a'/ }"
  str="${str//$'\e'/ }"
  str="${str//$'\r'/ }"
  str="${str//$'\n'/ }"
  echo "$str"
}

# Build the human-readable OSC notification body.
# Args: state, event, detail, agent
wavemill_hook_osc_body() {
  local state="$1"
  local event="$2"
  local detail="$3"
  local agent="$4"

  local issue="${WAVEMILL_ISSUE:-wavemill}"
  local body

  # Sanitize each field before interpolation
  state=$(wavemill_hook_osc_sanitize "$state")
  event=$(wavemill_hook_osc_sanitize "$event")
  detail=$(wavemill_hook_osc_sanitize "$detail")
  agent=$(wavemill_hook_osc_sanitize "$agent")

  # Build body: "issue [state] event(detail) - agent"
  if [[ -n "$detail" ]]; then
    body="${issue} [${state}] ${event}(${detail}) - ${agent}"
  else
    body="${issue} [${state}] ${event} - ${agent}"
  fi

  echo "$body"
}

# Wrap OSC 777 sequence for tmux if TMUX is set, otherwise return raw.
# Args: raw OSC sequence (without outer framing)
wavemill_hook_tmux_wrap() {
  local sequence="$1"

  if [[ -z "${TMUX:-}" ]]; then
    # No tmux: emit raw sequence
    echo "$sequence"
    return 0
  fi

  # Inside tmux: double inner ESC bytes and wrap with passthrough
  # Inner ESC (0x1B) must be doubled to 0x1B1B in tmux passthrough framing
  local escaped_seq
  escaped_seq="${sequence//$'\e'/$'\e\e'}"

  # Wrap with tmux passthrough: ESC P tmux ; <sequence> ESC \
  printf '%s\n' $'\eP'"tmux;${escaped_seq}"$'\e\\'
}

# Emit OSC 777 notification to terminal, best-effort only.
# Args: state, event, detail, agent
wavemill_hook_emit_osc() {
  local state="$1"
  local event="$2"
  local detail="$3"
  local agent="$4"

  # Early return if OSC emission is disabled
  if ! wavemill_hook_osc_enabled; then
    return 0
  fi

  # Build the notification body
  local body
  body=$(wavemill_hook_osc_body "$state" "$event" "$detail" "$agent")

  # Build raw OSC 777 sequence: ESC ] 777 ; notify ; wavemill ; <body> BEL
  local raw_sequence
  printf -v raw_sequence '\e]777;notify;wavemill;%s\a' "$body"

  # Wrap for tmux if needed
  local final_sequence
  final_sequence=$(wavemill_hook_tmux_wrap "$raw_sequence")

  # Emit to /dev/tty if available, else stderr, swallowing errors
  # Try /dev/tty first (in subshell with stderr suppressed); if that fails, fall back to stderr
  ( printf '%s' "$final_sequence" > /dev/tty ) 2>/dev/null || printf '%s' "$final_sequence" >&2 2>/dev/null || true

  return 0
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
  return 0
}

# Atomically write the standardized hook status payload.
# Args: state, event, detail, agent
#
# States: working (agent is actively processing), idle (agent stopped normally),
#         waiting (agent blocked on user input), error (agent encountered failure)
#
# The hook file uses a 300s TTL - consumers should fall back to other signals
# (pane liveness, process monitoring) if the timestamp is stale.
wavemill_hook_write() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"

  # Only write recognized states
  case "$state" in
    working|idle|waiting|error) ;;
    *) return 0 ;;
  esac

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local timestamp
  timestamp=$(date +%s)

  # Atomic write: build JSON in tmp, then mv (prevents partial reads)
  if jq -n \
    --arg state "$state" \
    --arg event "$event" \
    --arg detail "$detail" \
    --arg agent "$agent" \
    --argjson timestamp "$timestamp" \
    '{state: $state, event: $event, agent: $agent, timestamp: $timestamp}
     + (if $detail != "" then {detail: $detail} else {} end)' > "$tmp_file" 2>/dev/null; then
    if mv "$tmp_file" "$hook_file" 2>/dev/null; then
      wavemill_hook_notify
      wavemill_hook_emit_osc "$state" "$event" "$detail" "$agent" || true
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
