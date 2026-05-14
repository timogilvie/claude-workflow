#!/usr/bin/env bash

routing_role_from_window() {
  local window="${1:-}"
  case "$window" in
    planning) echo "planner" ;;
    coding) echo "coder" ;;
    review|reviewing) echo "reviewer" ;;
    *) return 1 ;;
  esac
}

routing_append_jsonl() {
  local feature_dir="$1"
  local decision_json="$2"
  [[ -n "$feature_dir" && -d "$feature_dir" ]] || return 0
  printf '%s\n' "$decision_json" >> "$feature_dir/routing.jsonl" 2>/dev/null || return 1
}

routing_emit_phase() {
  local role="$1"
  local selector="$2"
  local repo_dir="$3"
  local feature_dir="${4:-}"

  [[ -n "$role" && -n "$selector" && -n "$repo_dir" ]] || return 1
  command -v jq >/dev/null 2>&1 || return 0
  command -v npx >/dev/null 2>&1 || return 0

  local tools_dir="${TOOLS_DIR:-$repo_dir/tools}"
  local resolver="$tools_dir/resolve-routing.ts"
  [[ -f "$resolver" ]] || return 0

  local decision_json=""
  if ! decision_json="$(npx tsx "$resolver" --role "$role" --selector "$selector" --repo-dir "$repo_dir" 2>/dev/null)"; then
    return 0
  fi
  if ! jq -e . >/dev/null 2>&1 <<<"$decision_json"; then
    return 0
  fi

  if [[ -n "${WAVEMILL_SESSION:-}" && -n "${WAVEMILL_ISSUE:-}" ]]; then
    local hooks_dir
    hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../hooks" && pwd)"
    if [[ -f "$hooks_dir/wavemill-hook-protocol.sh" ]]; then
      # shellcheck source=/dev/null
      source "$hooks_dir/wavemill-hook-protocol.sh"
      if declare -F wavemill_hook_write_routing >/dev/null 2>&1; then
        wavemill_hook_write_routing "$role" "$decision_json" || true
      fi
    fi
  fi

  routing_append_jsonl "$feature_dir" "$decision_json" || true
  return 0
}
