#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
READER="$REPO_DIR/shared/lib/wavemill-input-reader.sh"
SESSION="input-reader-respawn-$$"
CMD_FILE="/tmp/wavemill-${SESSION}-commands"
OFFSET_FILE="/tmp/wavemill-${SESSION}-commands.offset"

cleanup() {
  rm -f "$CMD_FILE" "$OFFSET_FILE"
}
trap cleanup EXIT

printf 'select 9\n' > "$CMD_FILE"
printf '1\n' > "$OFFSET_FILE"

printf '1 3\n' | WAVEMILL_SESSION="$SESSION" "$READER" >/dev/null
printf 'm\nq\n' | WAVEMILL_SESSION="$SESSION" "$READER" >/dev/null

expected="$(cat <<'OUT'
select 9
select 1 3
more
quit
OUT
)"
actual="$(cat "$CMD_FILE")"

if [[ "$actual" != "$expected" ]]; then
  echo "FAIL: reader did not append correctly across respawns"
  echo "Expected:"
  printf '%s\n' "$expected"
  echo "Actual:"
  printf '%s\n' "$actual"
  exit 1
fi

if [[ "$(cat "$OFFSET_FILE")" != "1" ]]; then
  echo "FAIL: reader should not mutate offset file"
  exit 1
fi

echo "PASS: input reader respawn preserves append-only file"
