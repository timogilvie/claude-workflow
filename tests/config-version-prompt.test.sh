#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_DIR/.."

CANONICAL=$(sed -n "s/.*CURRENT_CONFIG_VERSION = '\\([^']*\\)'.*/\\1/p" "$REPO_ROOT/shared/lib/config.ts")

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cat > "$TMP/.wavemill-config.json" <<'JSON'
{
  "configVersion": "1.2.0"
}
JSON

output="$(
  cd "$TMP"
  set -- help
  # shellcheck source=/dev/null
  source "$REPO_ROOT/wavemill" >/dev/null
  printf 'n\n' | check_config_version 2>&1 || true
)"

pass=0
fail=0

assert_contains() {
  local needle="$1"
  local message="$2"

  if [[ "$output" == *"$needle"* ]]; then
    pass=$((pass + 1))
    echo "  PASS  $message"
  else
    fail=$((fail + 1))
    echo "  FAIL  $message"
    echo "        missing: $needle"
  fi
}

assert_contains "current: $CANONICAL" "notice line shows canonical version"
assert_contains "Upgrade config to version $CANONICAL" "prompt line shows canonical version"

echo ""
echo "--- Results: $pass passed, $fail failed ---"

[[ $fail -eq 0 ]]
