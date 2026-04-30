#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/startup-progress.sh"

SESSION="startup-render-$$"
export SESSION WAVEMILL_NO_PROGRESS=0

out="$(mktemp)"
progress_start 2 2>"$out"
progress_update 1 issue HOK-1
progress_update 2 issue HOK-2_c
progress_update 1 route running
progress_update 1 route done
progress_update 1 worktree done
progress_update 1 deps done
progress_update 1 agent done
progress_update 1 linear done
progress_update 2 route done
progress_update 2 worktree failed
progress_update 2 deps skipped
progress_update 2 agent skipped
progress_update 2 linear skipped
progress_finish

if ! grep -q 'issue .*| route | worktree | deps | agent | linear' "$out"; then
  echo "missing progress table header" >&2
  exit 1
fi
if ! grep -q 'HOK-1' "$out" || ! grep -q 'HOK-2_c' "$out"; then
  echo "missing issue rows" >&2
  exit 1
fi
if ! grep -q 'HOK-1   |' "$out"; then
  echo "non-challenge issue row did not reserve challenge suffix spacing" >&2
  exit 1
fi
if grep -q 'running' "$out"; then
  echo "renderer leaked raw running state" >&2
  exit 1
fi
if ! grep -q 'Startup: 1 done, 1 failed, 2 total' "$out"; then
  echo "missing final summary" >&2
  exit 1
fi

rm -f "$out"

file_out="$(mktemp)"
file_err="$(mktemp)"
progress_start 1 "$file_out" 2>"$file_err"
progress_update 1 issue HOK-3
progress_update 1 route done
progress_update 1 worktree done
progress_update 1 deps done
progress_update 1 agent done
progress_update 1 linear done
progress_finish

if [[ -s "$file_err" ]]; then
  echo "file renderer leaked progress output to stderr" >&2
  exit 1
fi
if ! grep -q 'Startup: 1 done, 0 failed, 1 total' "$file_out"; then
  echo "file renderer did not write final progress summary" >&2
  exit 1
fi
render_count="$(grep -c 'issue | route | worktree | deps | agent | linear' "$file_out")"
if [[ "$render_count" -gt 8 ]]; then
  echo "file renderer redrew too often: $render_count renders" >&2
  exit 1
fi
clear_count="$(perl -0777 -ne 'print scalar(() = /\e\[H\e\[J/g)' "$file_out")"
if [[ "$clear_count" -lt 2 ]]; then
  echo "file renderer did not emit terminal refresh sequences" >&2
  exit 1
fi
final_screen="$(perl -0777 -ne '@screens = split(/\e\[H\e\[J/); print $screens[-1]' "$file_out")"
header_line="$(printf '%s\n' "$final_screen" | grep '^issue ')"
hok3_line="$(printf '%s\n' "$final_screen" | grep '^HOK-3')"
if [[ "$header_line" != 'issue | route | worktree | deps | agent | linear' ]]; then
  echo "file renderer header width is misaligned" >&2
  exit 1
fi
if [[ "$hok3_line" != 'HOK-3 | ✓     | ✓        | ✓    | ✓     | ✓     ' ]]; then
  echo "file renderer row columns are misaligned for unicode symbols" >&2
  exit 1
fi

rm -f "$file_out" "$file_err"
