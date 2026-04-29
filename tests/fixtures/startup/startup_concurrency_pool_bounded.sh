#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/startup-progress.sh"

SESSION="startup-pool-$$"
tmp_dir="$(mktemp -d)"
active_file="$tmp_dir/active"
max_file="$tmp_dir/max"
done_file="$tmp_dir/done"
lock_dir="$tmp_dir/lock"
: > "$done_file"
printf '0\n' > "$active_file"
printf '0\n' > "$max_file"
export active_file max_file done_file lock_dir

with_lock() {
  while ! mkdir "$lock_dir" 2>/dev/null; do sleep 0.01; done
  "$@"
  rmdir "$lock_dir"
}

worker() {
  local id="$1"
  with_lock bash -c '
    active=$(cat "$active_file")
    active=$((active + 1))
    printf "%s\n" "$active" > "$active_file"
    max=$(cat "$max_file")
    (( active > max )) && printf "%s\n" "$active" > "$max_file"
  '
  sleep 0.15
  with_lock bash -c '
    active=$(cat "$active_file")
    printf "%s\n" "$((active - 1))" > "$active_file"
  '
  printf '%s\n' "$id" >> "$done_file"
}

worker_pool_run 2 worker a b c d e

max_seen="$(cat "$max_file")"
done_count="$(wc -l < "$done_file" | tr -d ' ')"
if (( max_seen > 2 )); then
  echo "pool exceeded max concurrency: $max_seen" >&2
  exit 1
fi
if [[ "$done_count" != "5" ]]; then
  echo "expected 5 completed tasks, got $done_count" >&2
  exit 1
fi

rm -rf "$tmp_dir"
