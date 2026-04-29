#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
source "$REPO_DIR/shared/lib/startup-progress.sh"

SESSION="startup-no-progress-$$"
export SESSION WAVEMILL_NO_PROGRESS=1

out="$(mktemp)"
{
  progress_start 1
  progress_update 1 issue HOK-1
  progress_update 1 route running
  progress_finish
  printf '[1/1] launching HOK-1\n' >&2
} 2>"$out"

if ! grep -q '^\[1/1\] launching HOK-1$' "$out"; then
  echo "missing legacy launch line" >&2
  exit 1
fi
if grep -q $'\033' "$out"; then
  echo "no-progress output contains ANSI escapes" >&2
  exit 1
fi
if grep -q 'issue | route' "$out"; then
  echo "no-progress output rendered a table" >&2
  exit 1
fi

rm -f "$out"
