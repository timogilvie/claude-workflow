#!/opt/homebrew/bin/bash
# Cycle tmux focus through wavemill agent windows that recently finished work.
#
# Intended usage:
#   - Invoked by the tmux `prefix + N` binding created by wavemill-mill.sh
#   - Not intended as a standalone user-facing CLI
#
# Dependencies:
#   - tmux
#   - jq
#   - wavemill hook files at /tmp/wavemill-${SESSION}-${ISSUE}.hook

set -euo pipefail

HOOK_TTL_SECONDS="${WAVEMILL_HOOK_TTL_SECONDS:-300}"

window_issue_id() {
  local window="$1"

  if [[ "$window" =~ ^([[:alnum:]]+-[0-9]+)- ]]; then
    printf '%s\n' "${BASH_REMATCH[1]}"
    return 0
  fi

  return 1
}

hook_is_fresh_idle() {
  local hook_file="$1"
  local now="$2"
  local payload state timestamp age

  payload="$(jq -r '[(.state // ""), (.timestamp // "")] | @tsv' "$hook_file" 2>/dev/null)" || return 1
  IFS=$'\t' read -r state timestamp <<< "$payload"

  [[ "$state" == "idle" ]] || return 1
  [[ "$timestamp" =~ ^[0-9]+$ ]] || return 1

  age=$(( now - timestamp ))
  (( age >= 0 && age < HOOK_TTL_SECONDS ))
}

collect_idle_windows() {
  local session="$1"
  local now="$2"
  local window issue hook_file

  while IFS= read -r window; do
    [[ -n "$window" ]] || continue
    issue="$(window_issue_id "$window")" || continue

    hook_file="/tmp/wavemill-${session}-${issue}.hook"
    [[ -f "$hook_file" ]] || continue

    if hook_is_fresh_idle "$hook_file" "$now"; then
      printf '%s\n' "$window"
    fi
  done < <(tmux list-windows -t "$session" -F '#{window_name}' 2>/dev/null || true)
}

read_last_index() {
  local idx_file="$1"
  local value

  [[ -f "$idx_file" ]] || {
    printf '%s\n' "-1"
    return 0
  }

  value="$(cat "$idx_file" 2>/dev/null || printf '%s' "-1")"
  if [[ "$value" =~ ^-?[0-9]+$ ]]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "-1"
  fi
}

cycle_next_done() {
  local session="$1"
  local now idx_file last_idx count next_idx
  local -a idle_windows=()

  command -v jq >/dev/null 2>&1 || return 0
  command -v tmux >/dev/null 2>&1 || return 0

  now="$(date +%s)"
  mapfile -t idle_windows < <(collect_idle_windows "$session" "$now")
  count="${#idle_windows[@]}"
  (( count > 0 )) || return 0

  idx_file="/tmp/wavemill-${session}-next-done-idx"
  last_idx="$(read_last_index "$idx_file")"
  if (( last_idx < -1 || last_idx >= count )); then
    last_idx=-1
  fi

  next_idx=$(( (last_idx + 1) % count ))
  printf '%s\n' "$next_idx" > "$idx_file" 2>/dev/null || true

  tmux select-window -t "${session}:${idle_windows[$next_idx]}" >/dev/null 2>&1 || true
}

main() {
  local session="${1:-${WAVEMILL_SESSION:-}}"
  [[ -n "$session" ]] || exit 0
  cycle_next_done "$session"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
