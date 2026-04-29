#!/opt/homebrew/bin/bash
# wavemill-startup-render.sh — startup progress table renderer
# Source this file into wavemill-startup-runner.sh; do not execute directly.
#
# Exported vars (set by startup_render_init):
#   STARTUP_RENDER_MODE      tty | plain
#   STARTUP_RENDER_ROWS      number of task rows
#   STARTUP_RENDER_ROWS_DIR  /tmp/wavemill-<session>-startup-rows
#   STARTUP_RENDER_DRAW_LOCK /tmp/wavemill-<session>-startup-draw.lock
#   STARTUP_RENDER_LAST_DRAW /tmp/wavemill-<session>-startup-last-draw
#
# Row file format (TAB-separated, 7 fields):
#   issue  route  worktree  deps  agent  linear  status
# Fields 0-5 are displayed columns; field 6 (status) is metadata only
# (triggers red row highlight when status == "error").

# Fixed column widths
_STARTUP_W_ISSUE=10
_STARTUP_W_ROUTE=14
_STARTUP_W_WORKTREE=10
_STARTUP_W_DEPS=6
_STARTUP_W_AGENT=8
_STARTUP_W_LINEAR=12

# Map field name to TAB-separated column index (0-based)
_startup_field_idx() {
  case "$1" in
    issue)    printf '0' ;;
    route)    printf '1' ;;
    worktree) printf '2' ;;
    deps)     printf '3' ;;
    agent)    printf '4' ;;
    linear)   printf '5' ;;
    status)   printf '6' ;;
    *)        return 1   ;;
  esac
}

# Print the bold header line (clears to EOL before printing)
_startup_render_header() {
  printf '\033[2K\r\033[1m%-*s %-*s %-*s %-*s %-*s %-*s\033[0m\n' \
    "$_STARTUP_W_ISSUE"    "ISSUE" \
    "$_STARTUP_W_ROUTE"    "ROUTE" \
    "$_STARTUP_W_WORKTREE" "WORKTREE" \
    "$_STARTUP_W_DEPS"     "DEPS" \
    "$_STARTUP_W_AGENT"    "AGENT" \
    "$_STARTUP_W_LINEAR"   "LINEAR"
}

# Print one data row with optional error highlighting
_startup_render_data_row() {
  local issue="$1" route="$2" worktree="$3" deps="$4" \
        agent="$5" linear="$6" status="${7:-}"
  local red='' reset=''
  [[ "$status" == "error" ]] && { red=$'\033[31m'; reset=$'\033[0m'; }

  # Truncate route column with ellipsis if needed
  local route_fmt
  if (( ${#route} > _STARTUP_W_ROUTE )); then
    route_fmt="${route:0:$(( _STARTUP_W_ROUTE - 1 ))}…"
  else
    route_fmt="$route"
  fi

  printf '\033[2K\r%s%-*s %-*s %-*s %-*s %-*s %-*s%s\n' \
    "$red" \
    "$_STARTUP_W_ISSUE"    "$issue" \
    "$_STARTUP_W_ROUTE"    "$route_fmt" \
    "$_STARTUP_W_WORKTREE" "$worktree" \
    "$_STARTUP_W_DEPS"     "$deps" \
    "$_STARTUP_W_AGENT"    "$agent" \
    "$_STARTUP_W_LINEAR"   "$linear" \
    "$reset"
}

# ─── Public API ──────────────────────────────────────────────────────────────

# startup_render_init <session> <task_count>
# Detects TTY vs plain mode, creates row state directory, prints initial table.
startup_render_init() {
  local session="$1" task_count="$2"

  STARTUP_RENDER_ROWS="$task_count"
  STARTUP_RENDER_ROWS_DIR="/tmp/wavemill-${session}-startup-rows"
  STARTUP_RENDER_DRAW_LOCK="/tmp/wavemill-${session}-startup-draw.lock"
  STARTUP_RENDER_LAST_DRAW="/tmp/wavemill-${session}-startup-last-draw"

  export STARTUP_RENDER_MODE STARTUP_RENDER_ROWS STARTUP_RENDER_ROWS_DIR
  export STARTUP_RENDER_DRAW_LOCK STARTUP_RENDER_LAST_DRAW

  # Mode detection: plain if any signal forces it
  if [[ "${WAVEMILL_STARTUP_RENDER:-}" == "plain" ]] || \
     [[ -v NO_COLOR ]] || \
     [[ "${TERM:-dumb}" == "dumb" ]] || \
     ! command -v tput >/dev/null 2>&1 || \
     ! [[ -t 1 ]]; then
    STARTUP_RENDER_MODE="plain"
  else
    STARTUP_RENDER_MODE="tty"
  fi

  # Set up row state directory
  mkdir -p "$STARTUP_RENDER_ROWS_DIR"
  rm -f "$STARTUP_RENDER_LAST_DRAW"

  local i
  for (( i = 0; i < task_count; i++ )); do
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "—" "—" "—" "—" "—" "—" "" \
      > "$STARTUP_RENDER_ROWS_DIR/row-$i"
  done

  if [[ "$STARTUP_RENDER_MODE" == "tty" ]]; then
    _startup_render_header
    for (( i = 0; i < task_count; i++ )); do
      _startup_render_data_row "—" "—" "—" "—" "—" "—" ""
    done
  fi
}

# _startup_state_level <value>
# Maps a cell value to a numeric state level for monotonic advancement checking.
# Levels: 0=blank/dash, 1=in-progress glyph, 2=completion (✓, ✗, or error).
_startup_state_level() {
  local value="$1"
  case "$value" in
    ""|-|"—") echo 0 ;;
    "✓"|"✗"|"error") echo 2 ;;
    *) echo 1 ;; # Treat any other non-empty value as in-progress
  esac
}

# startup_render_set <row_idx> <field> <value>
# Updates a single field in a row file and triggers a debounced table redraw.
# Enforces monotonic advancement: cells can only advance to higher states.
# row_idx is 0-based. In plain mode this is a no-op.
startup_render_set() {
  local row_idx="$1" field="$2" value="$3"
  [[ "${STARTUP_RENDER_MODE:-plain}" == "plain" ]] && return 0

  # Strip control characters and newline to prevent terminal injection and line corruption
  value="$(printf '%s' "$value" | tr -d '\000-\037\177')"

  local row_file="$STARTUP_RENDER_ROWS_DIR/row-${row_idx}"

  local fidx
  fidx="$(_startup_field_idx "$field")" || return 0

  # Read current fields, update target field, write back atomically
  local parts
  parts=("—" "—" "—" "—" "—" "—" "")
  if [[ -f "$row_file" ]]; then
    IFS=$'\t' read -r -a parts < "$row_file" 2>/dev/null || true
    while (( ${#parts[@]} < 7 )); do parts+=(""); done
  fi

  local current_val="${parts[$fidx]}"
  local current_level new_level
  current_level=$(_startup_state_level "$current_val")
  new_level=$(_startup_state_level "$value")

  # Only allow advancement or same state; prevent regression
  if (( new_level < current_level )); then
    return 0  # Silently ignore regression attempts
  fi

  parts[$fidx]="$value"

  local tmp
  tmp="$(mktemp "${row_file}.XXXXXX")" || return 1
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${parts[0]}" "${parts[1]}" "${parts[2]}" "${parts[3]}" \
    "${parts[4]}" "${parts[5]}" "${parts[6]}" > "$tmp"
  mv "$tmp" "$row_file"

  startup_render_redraw
}

# _startup_spinlock_acquire <lock_file>
# Acquires a spinlock by repeatedly trying to create the lock file.
# Simple fallback when flock is unavailable.
_startup_spinlock_acquire() {
  local lock_file="$1"
  local max_spins=100
  local spins=0

  while [[ -f "$lock_file" ]] && (( spins < max_spins )); do
    sleep 0.01
    (( spins++ ))
  done

  # Create lock file atomically (will race but that's ok for debounce)
  touch "$lock_file" 2>/dev/null || true
}

# _startup_spinlock_release <lock_file>
_startup_spinlock_release() {
  local lock_file="$1"
  rm -f "$lock_file" 2>/dev/null || true
}

# startup_render_redraw
# Redraws the full table in place, debounced to no faster than 50ms.
# Uses flock when available to serialize concurrent redraws; falls back to spinlock.
startup_render_redraw() {
  [[ "${STARTUP_RENDER_MODE:-plain}" != "tty" ]] && return 0

  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200
      _startup_render_do_redraw
    ) 200>"$STARTUP_RENDER_DRAW_LOCK"
  else
    # Spinlock fallback: serialize without flock
    _startup_spinlock_acquire "$STARTUP_RENDER_DRAW_LOCK.spin"
    _startup_render_do_redraw
    _startup_spinlock_release "$STARTUP_RENDER_DRAW_LOCK.spin"
  fi
}

_startup_render_do_redraw() {
  # Debounce: skip if last draw was < 50ms ago
  local now_ms last_ms=0
  now_ms="$(date +%s%3N 2>/dev/null)" || now_ms="$(( $(date +%s) * 1000 ))"
  [[ -f "$STARTUP_RENDER_LAST_DRAW" ]] && \
    last_ms="$(cat "$STARTUP_RENDER_LAST_DRAW" 2>/dev/null)" || last_ms=0
  last_ms="${last_ms:-0}"
  (( now_ms - last_ms < 50 )) && return 0

  printf '%s' "$now_ms" > "$STARTUP_RENDER_LAST_DRAW"

  # Move cursor up past all table rows + header
  printf '\033[%dA' $(( STARTUP_RENDER_ROWS + 1 ))

  _startup_render_header

  local i parts
  for (( i = 0; i < STARTUP_RENDER_ROWS; i++ )); do
    parts=("—" "—" "—" "—" "—" "—" "")
    if [[ -f "$STARTUP_RENDER_ROWS_DIR/row-$i" ]]; then
      IFS=$'\t' read -r -a parts < "$STARTUP_RENDER_ROWS_DIR/row-$i" 2>/dev/null || true
      while (( ${#parts[@]} < 7 )); do parts+=(""); done
    fi
    _startup_render_data_row \
      "${parts[0]:-—}" "${parts[1]:-—}" "${parts[2]:-—}" "${parts[3]:-—}" \
      "${parts[4]:-—}" "${parts[5]:-—}" "${parts[6]:-}"
  done
}

# startup_render_finalize
# Forces a final redraw and prints a summary line below the table.
# Called after all workers complete. No-op in plain mode.
startup_render_finalize() {
  [[ "${STARTUP_RENDER_MODE:-plain}" != "tty" ]] && return 0

  # Reset debounce timer to force a fresh draw
  printf '0' > "$STARTUP_RENDER_LAST_DRAW"

  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200
      _startup_render_do_redraw
    ) 200>"$STARTUP_RENDER_DRAW_LOCK"
  else
    _startup_render_do_redraw
  fi

  # Count outcomes
  local ok=0 err=0 i status
  for (( i = 0; i < STARTUP_RENDER_ROWS; i++ )); do
    status=""
    if [[ -f "$STARTUP_RENDER_ROWS_DIR/row-$i" ]]; then
      status="$(awk -F'\t' 'NR==1{print $7}' \
        "$STARTUP_RENDER_ROWS_DIR/row-$i" 2>/dev/null)" || true
    fi
    if [[ "$status" == "error" ]]; then
      (( err++ )) || true
    else
      (( ok++ )) || true
    fi
  done

  if (( err > 0 )); then
    printf '\033[33m%d task(s) launched, %d failed\033[0m\n' "$ok" "$err"
  else
    printf '\033[32m%d task(s) launched\033[0m\n' "$ok"
  fi
}
