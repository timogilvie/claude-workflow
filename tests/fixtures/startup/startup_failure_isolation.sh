#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/startup-progress.sh"

SESSION="startup-failure-$$"
export SESSION WAVEMILL_NO_PROGRESS=0
tmp_dir="$(mktemp -d)"
done_file="$tmp_dir/done"
out="$tmp_dir/progress.out"
: > "$done_file"
export done_file

worker() {
  local id="$1"
  progress_update "$id" issue "task-$id"
  progress_update "$id" route done
  progress_update "$id" worktree running
  if [[ "$id" == "2" ]]; then
    progress_update "$id" worktree failed
    progress_update "$id" deps skipped
    progress_update "$id" agent skipped
    progress_update "$id" linear skipped
    return 1
  fi
  progress_update "$id" worktree done
  progress_update "$id" deps done
  progress_update "$id" agent done
  progress_update "$id" linear done
  printf '%s\n' "$id" >> "$done_file"
}

progress_start 3 2>"$out"
set +e
worker_pool_run 3 worker 1 2 3
rc=$?
set -e
progress_finish

if [[ "$rc" == "0" ]]; then
  echo "pool returned success despite worker failure" >&2
  exit 1
fi
done_count="$(wc -l < "$done_file" | tr -d ' ')"
if [[ "$done_count" != "2" ]]; then
  echo "expected two successful workers, got $done_count" >&2
  exit 1
fi
if ! grep -q 'Startup: 2 done, 1 failed, 3 total' "$out"; then
  echo "missing failure summary" >&2
  exit 1
fi

rm -rf "$tmp_dir"
