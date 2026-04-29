#!/usr/bin/env bash

_startup_progress_bash_supports_wait_n() {
  (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 3) ))
}

startup_progress_clamp_concurrency() {
  local requested="${1:-4}"
  if ! [[ "$requested" =~ ^[0-9]+$ ]]; then
    printf 'Warning: WAVEMILL_STARTUP_CONCURRENCY=%s is invalid; using 4\n' "$requested" >&2
    requested=4
  fi
  if (( requested < 1 )); then
    printf 'Warning: WAVEMILL_STARTUP_CONCURRENCY=%s is below 1; using 1\n' "$requested" >&2
    requested=1
  elif (( requested > 16 )); then
    printf 'Warning: WAVEMILL_STARTUP_CONCURRENCY=%s is above 16; using 16\n' "$requested" >&2
    requested=16
  fi
  printf '%s\n' "$requested"
}

worker_pool_run() {
  local max_concurrent="$1" worker_fn="$2"
  shift 2

  max_concurrent="$(startup_progress_clamp_concurrency "$max_concurrent")"
  if ! _startup_progress_bash_supports_wait_n; then
    printf 'Warning: bash %s does not support wait -n; startup launch will run serially\n' "$BASH_VERSION" >&2
    local serial_rc=0 task
    for task in "$@"; do
      "$worker_fn" "$task" || serial_rc=1
    done
    return "$serial_rc"
  fi

  local result_dir
  result_dir="$(mktemp -d "/tmp/wavemill-startup-pool-${SESSION:-$$}.XXXXXX")" || return 1

  local task_index=0 running=0 task_id pid rc aggregate_rc=0
  local pids=()
  for task_id in "$@"; do
    task_index=$((task_index + 1))
    (
      set +e
      "$worker_fn" "$task_id"
      printf '%s\n' "$?" > "$result_dir/$task_index"
    ) &
    pid=$!
    pids+=("$pid")
    running=$((running + 1))

    while (( running >= max_concurrent )); do
      wait -n || true
      running=$((running - 1))
    done
  done

  for pid in "${pids[@]}"; do
    wait "$pid" || true
  done

  local result
  for result in "$result_dir"/*; do
    [[ -f "$result" ]] || continue
    rc="$(cat "$result" 2>/dev/null || echo 1)"
    [[ "$rc" == "0" ]] || aggregate_rc=1
  done
  rm -rf "$result_dir"
  return "$aggregate_rc"
}

_progress_state_symbol() {
  case "$1" in
    pending) printf '.' ;;
    running) printf '…' ;;
    done) printf '✓' ;;
    failed) printf '✗' ;;
    skipped) printf '-' ;;
    *) printf '%s' "$1" ;;
  esac
}

_progress_clean_detail() {
  local detail="${1:-}"
  printf '%s' "$detail" | tr -d '\001-\037' | cut -c 1-40
}

_progress_render_reader() {
  local fifo="$1" task_count="$2"
  local columns=(route worktree deps agent linear)
  local -A cells details issues
  local i col id state detail finished=0

  for ((i = 1; i <= task_count; i++)); do
    issues["$i"]="$i"
    for col in "${columns[@]}"; do
      cells["$i:$col"]="pending"
      details["$i:$col"]=""
    done
  done

  _progress_draw_table() {
    local rows_done=0 rows_failed=0 row_state issue_label symbol suffix
    printf '\033[H\033[J' >&2
    printf 'issue | route | worktree | deps | agent | linear\n' >&2
    printf '%s\n' '------+-------+----------+------+-------+-------' >&2
    for ((i = 1; i <= task_count; i++)); do
      issue_label="${issues[$i]:-$i}"
      printf '%-5s |' "$issue_label" >&2
      row_state="done"
      for col in "${columns[@]}"; do
        state="${cells["$i:$col"]:-pending}"
        symbol="$(_progress_state_symbol "$state")"
        suffix="${details["$i:$col"]:-}"
        [[ -n "$suffix" ]] && symbol="$symbol $suffix"
        case "$col" in
          route) printf ' %-5.5s |' "$symbol" >&2 ;;
          worktree) printf ' %-8.8s |' "$symbol" >&2 ;;
          deps) printf ' %-4.4s |' "$symbol" >&2 ;;
          agent) printf ' %-5.5s |' "$symbol" >&2 ;;
          linear) printf ' %-5.5s' "$symbol" >&2 ;;
        esac
        [[ "$state" == "failed" ]] && row_state="failed"
        [[ "$state" != "done" && "$state" != "skipped" ]] && [[ "$row_state" != "failed" ]] && row_state="active"
      done
      printf '\n' >&2
      [[ "$row_state" == "done" ]] && rows_done=$((rows_done + 1))
      [[ "$row_state" == "failed" ]] && rows_failed=$((rows_failed + 1))
    done
    printf 'Startup: %s done, %s failed, %s total\n' "$rows_done" "$rows_failed" "$task_count" >&2
  }

  _progress_draw_table
  while true; do
    if ! IFS=$'\t' read -t 0.1 -r id col state detail 2>/dev/null; then
      _progress_draw_table
      continue
    fi
    if [[ "$id" == "__finish__" ]]; then
      finished=1
      _progress_draw_table
      break
    fi
    [[ "$id" =~ ^[0-9]+$ ]] || continue
    if [[ "$col" == "issue" ]]; then
      issues["$id"]="$(_progress_clean_detail "$state")"
    else
      cells["$id:$col"]="$state"
      details["$id:$col"]="$(_progress_clean_detail "${detail:-}")"
    fi
    while IFS=$'\t' read -t 0 -r id col state detail 2>/dev/null; do
      if [[ "$id" == "__finish__" ]]; then
        finished=1
        break
      fi
      [[ "$id" =~ ^[0-9]+$ ]] || continue
      if [[ "$col" == "issue" ]]; then
        issues["$id"]="$(_progress_clean_detail "$state")"
      else
        cells["$id:$col"]="$state"
        details["$id:$col"]="$(_progress_clean_detail "${detail:-}")"
      fi
    done
    _progress_draw_table
    (( finished == 1 )) && break
  done < "$fifo"
}

progress_start() {
  local task_count="$1"
  [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]] && return 0
  PROGRESS_FIFO="/tmp/wavemill-${SESSION:-$$}-startup-progress.fifo"
  rm -f "$PROGRESS_FIFO"
  mkfifo "$PROGRESS_FIFO"
  _progress_render_reader "$PROGRESS_FIFO" "$task_count" &
  PROGRESS_READER_PID=$!
  exec {_PROGRESS_FD}>"$PROGRESS_FIFO"
  export PROGRESS_FIFO PROGRESS_READER_PID _PROGRESS_FD
}

progress_update() {
  [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]] && return 0
  [[ -n "${_PROGRESS_FD:-}" ]] || return 0
  local id="$1" col="$2" state="$3" detail="${4:-}"
  detail="$(_progress_clean_detail "$detail")"
  printf '%s\t%s\t%s\t%s\n' "$id" "$col" "$state" "$detail" >&${_PROGRESS_FD} 2>/dev/null || true
}

progress_finish() {
  [[ "${WAVEMILL_NO_PROGRESS:-0}" == "1" ]] && return 0
  if [[ -n "${_PROGRESS_FD:-}" ]]; then
    printf '__finish__\t\t\t\n' >&${_PROGRESS_FD} 2>/dev/null || true
    exec {_PROGRESS_FD}>&- 2>/dev/null || true
  fi
  [[ -n "${PROGRESS_READER_PID:-}" ]] && wait "$PROGRESS_READER_PID" 2>/dev/null || true
  [[ -n "${PROGRESS_FIFO:-}" ]] && rm -f "$PROGRESS_FIFO"
}
