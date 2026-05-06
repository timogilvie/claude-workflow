#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
READER="$REPO_DIR/shared/lib/wavemill-input-reader.sh"
SESSION="input-reader-translate-$$"
CMD_FILE="/tmp/wavemill-${SESSION}-commands"

cleanup() {
  rm -f "$CMD_FILE"
}
trap cleanup EXIT

cat <<'IN' | WAVEMILL_INPUT_PENDING_SLEEP=0 WAVEMILL_SESSION="$SESSION" "$READER" >/dev/null
1 3
m
more
q
quit
exit

1 foo 3
hello world
IN

expected="$(cat <<'OUT'
select 1 3
more
more
quit
quit
quit
enter
unknown 1 foo 3
unknown hello world
OUT
)"
actual="$(cat "$CMD_FILE")"

if [[ "$actual" != "$expected" ]]; then
  echo "FAIL: unexpected command translation"
  echo "Expected:"
  printf '%s\n' "$expected"
  echo "Actual:"
  printf '%s\n' "$actual"
  exit 1
fi

echo "PASS: input reader translates keystrokes"
