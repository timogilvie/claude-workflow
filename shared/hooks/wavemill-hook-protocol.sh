#!/usr/bin/env bash
# Shared hook protocol helpers for wavemill agent status tracking.

# Verify we are running inside a wavemill-launched agent context.
# Hooks must be no-ops outside wavemill to avoid disrupting standalone use.
wavemill_hook_check() {
  [[ -n "${WAVEMILL_SESSION:-}" ]] || exit 0
  [[ -n "${WAVEMILL_ISSUE:-}" ]] || exit 0
  command -v jq >/dev/null 2>&1 || exit 0
}

# Atomically write the standardized hook status payload.
# Args: state, event, detail, agent
wavemill_hook_write() {
  local state="$1"
  local event="$2"
  local detail="${3:-}"
  local agent="$4"

  case "$state" in
    working|idle|waiting|error) ;;
    *) return 0 ;;
  esac

  local hook_file="/tmp/wavemill-${WAVEMILL_SESSION}-${WAVEMILL_ISSUE}.hook"
  local tmp_file="${hook_file}.tmp.$$"
  local timestamp
  timestamp=$(date +%s)

  if jq -n \
    --arg state "$state" \
    --arg event "$event" \
    --arg detail "$detail" \
    --arg agent "$agent" \
    --argjson timestamp "$timestamp" \
    '{state: $state, event: $event, agent: $agent, timestamp: $timestamp}
     + (if $detail != "" then {detail: $detail} else {} end)' > "$tmp_file" 2>/dev/null; then
    mv "$tmp_file" "$hook_file" 2>/dev/null || rm -f "$tmp_file"
  else
    rm -f "$tmp_file"
  fi

  return 0
}
