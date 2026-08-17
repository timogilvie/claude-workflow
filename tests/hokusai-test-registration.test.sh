#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER="$REPO_DIR/tests/run-unit-tests.sh"

missing=()

while IFS= read -r test_file; do
  rel="${test_file#$REPO_DIR/}"
  if ! grep -Eq "^[[:space:]]*$rel([[:space:]]|$)" "$RUNNER"; then
    missing+=("$rel")
  fi
done < <(
  find "$REPO_DIR/shared/lib" "$REPO_DIR/tools" \
    \( -path "$REPO_DIR/shared/lib/hokusai-*.test.ts" -o -path "$REPO_DIR/tools/hokusai-*.test.ts" \) \
    -type f \
    | sort
)

if (( ${#missing[@]} > 0 )); then
  echo "Hokusai test files missing from tests/run-unit-tests.sh:" >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

echo "All Hokusai TypeScript tests are registered."
