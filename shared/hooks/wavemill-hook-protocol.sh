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
    else
      rm -f "$tmp_file"
    fi
  else
    rm -f "$tmp_file"
  fi

  return 0
}
