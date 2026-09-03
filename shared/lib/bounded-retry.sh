#!/usr/bin/env bash
# Bounded-retry invariant helpers (HOK-2924).
#
# One shared implementation for every relaunch path in the mill: a per-bucket
# attempt counter with exponential backoff, a hard ceiling, a head-keyed reset,
# and a one-shot terminal ("exhausted") state with a greppable recorded reason.
#
# State is file-based, keyed by a <state_dir, bucket> pair. Buckets are stable
# kebab-case slugs (e.g. phase-launch-coding, ready-remediation,
# pending-ready-recheck, failed-ready-recheck, challenge-eval-soft-<pair>-<side>).
# Bucket names must not be prefixes of one another within a state dir: clear
# removes every file under the bucket's prefix.
#
# Storage per bucket, under $state_dir:
#   .retry-<bucket>-count      attempt counter (positive integer)
#   .retry-<bucket>-head       head SHA the counter is keyed to
#   .retry-<bucket>-last-at    epoch seconds of the last increment
#   .retry-<bucket>-exhausted  terminal sentinel; contents = terminal reason
#
# The failed-ready-recheck bucket keeps its pre-HOK-2924 file names
# (.failed-ready-recheck-*) so an in-flight session upgrading to this code
# sees no state loss.
#
# set -e safety: every helper that is invoked bare or via command substitution
# returns 0 on all paths. Only bounded_retry_due, bounded_retry_is_exhausted,
# and bounded_retry_mark_exhausted use their exit status as a signal, and all
# are documented to be called behind `if`.

# Resolve the per-bucket file prefix. Legacy buckets that shipped their own
# file names before the helper existed keep them (upgrade compatibility).
_bounded_retry_prefix() {
  local bucket="$1"
  case "$bucket" in
    failed-ready-recheck) printf '.failed-ready-recheck-' ;;
    *) printf '.retry-%s-' "$bucket" ;;
  esac
}

_bounded_retry_file() {
  local state_dir="$1" bucket="$2" kind="$3"
  printf '%s/%s%s' "$state_dir" "$(_bounded_retry_prefix "$bucket")" "$kind"
}

# Env-var fragment for a bucket: upper-cased, dashes to underscores.
_bounded_retry_env_bucket() {
  local bucket="$1"
  printf '%s' "$bucket" | tr 'a-z-' 'A-Z_'
}

# Backoff base/cap resolution precedence: explicit argument > per-bucket env
# (WAVEMILL_RETRY_BACKOFF_<BUCKET>_{BASE,CAP}_SECONDS) > global env
# (WAVEMILL_RETRY_BACKOFF_{BASE,CAP}_SECONDS) > shipped default (120 / 1800,
# matching the failed-ready re-check path's shipped defaults).
_bounded_retry_resolve_base() {
  local bucket="$1" explicit="${2:-}"
  local env_name value
  if [[ "$explicit" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -n "$bucket" ]]; then
    env_name="WAVEMILL_RETRY_BACKOFF_$(_bounded_retry_env_bucket "$bucket")_BASE_SECONDS"
    value="${!env_name:-}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi
  value="${WAVEMILL_RETRY_BACKOFF_BASE_SECONDS:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  printf '120\n'
}

_bounded_retry_resolve_cap() {
  local bucket="$1" explicit="${2:-}"
  local env_name value
  if [[ "$explicit" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$explicit"
    return 0
  fi
  if [[ -n "$bucket" ]]; then
    env_name="WAVEMILL_RETRY_BACKOFF_$(_bounded_retry_env_bucket "$bucket")_CAP_SECONDS"
    value="${!env_name:-}"
    if [[ "$value" =~ ^[0-9]+$ ]]; then
      printf '%s\n' "$value"
      return 0
    fi
  fi
  value="${WAVEMILL_RETRY_BACKOFF_CAP_SECONDS:-}"
  if [[ "$value" =~ ^[0-9]+$ ]]; then
    printf '%s\n' "$value"
    return 0
  fi
  printf '1800\n'
}

# Current attempt count for a bucket (0 when unset or unreadable).
bounded_retry_count() {
  local state_dir="$1" bucket="$2"
  local count_file count
  count_file="$(_bounded_retry_file "$state_dir" "$bucket" "count")"
  if [[ ! -f "$count_file" ]]; then
    echo "0"
    return 0
  fi
  count=$(cat "$count_file" 2>/dev/null || echo "0")
  if [[ ! "$count" =~ ^[0-9]+$ ]]; then
    echo "0"
    return 0
  fi
  echo "$count"
}

# Head SHA the bucket's counter is keyed to (empty when unset).
bounded_retry_head() {
  local state_dir="$1" bucket="$2"
  local head_file
  head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"
  [[ -f "$head_file" ]] || { echo ""; return 0; }
  cat "$head_file" 2>/dev/null || echo ""
  return 0
}

# Epoch seconds of the last increment (empty when unset or unreadable).
bounded_retry_last_at() {
  local state_dir="$1" bucket="$2"
  local last_at_file last_at
  last_at_file="$(_bounded_retry_file "$state_dir" "$bucket" "last-at")"
  [[ -f "$last_at_file" ]] || { echo ""; return 0; }
  last_at=$(cat "$last_at_file" 2>/dev/null || echo "")
  if [[ ! "$last_at" =~ ^[0-9]+$ ]]; then
    echo ""
    return 0
  fi
  echo "$last_at"
}

# Remove every file under the bucket's prefix — counter, head key, timestamp,
# exhausted sentinel, and any path-specific companions sharing the prefix
# (e.g. .failed-ready-recheck-reason.json). Called on successful launch.
bounded_retry_clear() {
  local state_dir="$1" bucket="$2"
  local prefix
  prefix="$(_bounded_retry_prefix "$bucket")"
  [[ -n "$state_dir" && -n "$bucket" ]] || return 0
  rm -f "$state_dir/$prefix"* 2>/dev/null || true
  return 0
}

# A new commit is genuine new information: wipe the budget (and any exhausted
# terminal state) so the fresh head gets a full set of attempts. An empty
# current head means git failed — never reset on that.
bounded_retry_reset_if_new_head() {
  local state_dir="$1" bucket="$2" current_head="$3"
  local head_file stored_head
  head_file="$(_bounded_retry_file "$state_dir" "$bucket" "head")"

  [[ -n "$current_head" ]] || return 0
  [[ -f "$head_file" ]] || return 0
  stored_head=$(cat "$head_file" 2>/dev/null || echo "")
  [[ -n "$stored_head" ]] || return 0
  if [[ "$stored_head" != "$current_head" ]]; then
    bounded_retry_clear "$state_dir" "$bucket"
  fi
  return 0
}

# Increment the attempt counter, key it to the current head, and stamp the
# attempt time. Echoes the new count.
bounded_retry_increment() {
  local state_dir="$1" bucket="$2" current_head="$3"
  local count
  count=$(bounded_retry_count "$state_dir" "$bucket")
  count=$((count + 1))
  mkdir -p "$state_dir"
  printf '%s\n' "$count" > "$(_bounded_retry_file "$state_dir" "$bucket" "count")"
  # An empty head means git failed; keep any previously recorded head so a
  # later real commit still triggers the budget reset.
  if [[ -n "$current_head" ]]; then
    printf '%s\n' "$current_head" > "$(_bounded_retry_file "$state_dir" "$bucket" "head")"
  fi
  printf '%s\n' "$(date +%s)" > "$(_bounded_retry_file "$state_dir" "$bucket" "last-at")"
  echo "$count"
}

# Delay before attempt (count+1): min(base * 2^(count-1), cap).
bounded_retry_backoff_seconds() {
  local count="$1" base="${2:-}" cap="${3:-}"
  base="$(_bounded_retry_resolve_base "" "$base")"
  cap="$(_bounded_retry_resolve_cap "" "$cap")"
  [[ "$count" =~ ^[0-9]+$ ]] || count=1
  (( count >= 1 )) || count=1

  local delay="$base" i
  for (( i = 1; i < count; i++ )); do
    delay=$((delay * 2))
    if (( delay >= cap )); then
      delay="$cap"
      break
    fi
  done
  (( delay > cap )) && delay="$cap"
  echo "$delay"
}

# Exit 0 when the backoff window for the next attempt has elapsed (or no
# attempt has been recorded yet). Call behind `if`.
bounded_retry_due() {
  local state_dir="$1" bucket="$2" base="${3:-}" cap="${4:-}"
  local last_at now delay

  last_at=$(bounded_retry_last_at "$state_dir" "$bucket")
  [[ -n "$last_at" ]] || return 0

  base="$(_bounded_retry_resolve_base "$bucket" "$base")"
  cap="$(_bounded_retry_resolve_cap "$bucket" "$cap")"
  delay=$(bounded_retry_backoff_seconds "$(bounded_retry_count "$state_dir" "$bucket")" "$base" "$cap")
  now=$(date +%s)
  (( now - last_at >= delay ))
}

# One-shot terminalization with a recorded, greppable reason. Does not touch
# the attempt counter, so a terminal cause detected before any attempt leaves
# the count at 0 (REQ-F4). Returns 0 on the first-time transition (caller
# emits the status line / attention file) and 1 when the sentinel already
# exists. Call behind `if`.
bounded_retry_mark_exhausted() {
  local state_dir="$1" bucket="$2" reason="${3:-}"
  local sentinel
  sentinel="$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")"

  if [[ -f "$sentinel" ]]; then
    return 1
  fi
  mkdir -p "$state_dir"
  printf '%s\n' "$reason" > "$sentinel"
  return 0
}

# Exit 0 when the bucket has been terminalized. Call behind `if`.
bounded_retry_is_exhausted() {
  local state_dir="$1" bucket="$2"
  [[ -f "$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")" ]]
}

# Recorded terminal reason (empty when not exhausted).
bounded_retry_exhaustion_reason() {
  local state_dir="$1" bucket="$2"
  local sentinel
  sentinel="$(_bounded_retry_file "$state_dir" "$bucket" "exhausted")"
  [[ -f "$sentinel" ]] || { echo ""; return 0; }
  cat "$sentinel" 2>/dev/null || echo ""
  return 0
}

# The composed relaunch decision. Echoes exactly one of:
#   proceed         — launch now (caller increments the counter first)
#   backoff         — a retry is scheduled but its delay has not elapsed
#   exhausted       — budget spent; caller terminalizes via
#                     bounded_retry_mark_exhausted with a recorded reason
#   exhausted-quiet — already terminalized; hold silently until a new commit
#
# Usage: bounded_retry_gate <state_dir> <bucket> <current_head> <limit> [<base>] [<cap>]
bounded_retry_gate() {
  local state_dir="$1" bucket="$2" current_head="$3" limit="$4"
  local base="${5:-}" cap="${6:-}"
  local count

  bounded_retry_reset_if_new_head "$state_dir" "$bucket" "$current_head"

  if bounded_retry_is_exhausted "$state_dir" "$bucket"; then
    echo "exhausted-quiet"
    return 0
  fi

  [[ "$limit" =~ ^[0-9]+$ ]] || limit=4
  count=$(bounded_retry_count "$state_dir" "$bucket")
  if (( count >= limit )); then
    echo "exhausted"
    return 0
  fi

  if ! bounded_retry_due "$state_dir" "$bucket" "$base" "$cap"; then
    echo "backoff"
    return 0
  fi

  echo "proceed"
}
