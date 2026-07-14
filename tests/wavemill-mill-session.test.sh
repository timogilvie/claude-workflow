#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      capture = 1
      depth = 0
    }
    capture {
      print
      depth += brace_delta($0)
      if (depth == 0) {
        exit
      }
    }
  ' "$source_file"
}

assert_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "expected to find: $needle"
    echo "actual: $haystack"
    exit 1
  fi
}

assert_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL: $label"
    echo "did not expect to find: $needle"
    echo "actual: $haystack"
    exit 1
  fi
}

FUNCS_FILE="$TMP_DIR/create-tmux-session.sh"
extract_function "$MILL_SCRIPT" dotenv_value > "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" hydrate_provider_env_from_dotenv >> "$FUNCS_FILE"
extract_function "$MILL_SCRIPT" create_tmux_session >> "$FUNCS_FILE"
source "$FUNCS_FILE"

SCRIPT_DIR="$REPO_DIR/shared/lib"
WAVEMILL_WINDOW_MILL="mill"
SESSION="collide"
REPO_DIR="/repos/requested"

TMUX_LOG="$TMP_DIR/tmux.log"
TMUX_EXISTING_REPO="/repos/active"
TMUX_HAS_SESSION=1

tmux() {
  printf 'tmux %s\n' "$*" >> "$TMUX_LOG"
  if [[ "${1:-}" == "-f" ]]; then
    shift 2
  fi
  case "${1:-}" in
    has-session)
      [[ "$TMUX_HAS_SESSION" == "1" ]]
      ;;
    show-environment)
      if [[ -n "${TMUX_EXISTING_REPO:-}" ]]; then
        printf 'REPO_DIR=%s\n' "$TMUX_EXISTING_REPO"
      else
        return 1
      fi
      ;;
    kill-session)
      return 0
      ;;
    new-session|set-option|set-environment|bind-key|send-keys)
      return 0
      ;;
    *)
      echo "FAIL: unexpected tmux invocation: $*" >&2
      return 1
      ;;
  esac
}

set +e
output="$(create_tmux_session 2>&1)"
status=$?
set -e

if [[ "$status" -eq 0 ]]; then
  echo "FAIL: mismatched repo should reject existing session"
  exit 1
fi

assert_contains "mismatch mentions session" "$output" "tmux session 'collide'"
assert_contains "mismatch mentions requested repo" "$output" "Requested repo: /repos/requested"
assert_contains "mismatch mentions active repo" "$output" "Active repo:    /repos/active"
assert_contains "mismatch includes attach command" "$output" "tmux attach -t collide"
assert_contains "mismatch includes kill command" "$output" "tmux kill-session -t collide"
assert_contains "mismatch includes override command" "$output" "SESSION=collide-alt wavemill mill"
assert_not_contains "mismatch does not kill foreign session" "$(cat "$TMUX_LOG")" "kill-session"

: > "$TMUX_LOG"
TMUX_EXISTING_REPO=""

set +e
unknown_output="$(create_tmux_session 2>&1)"
unknown_status=$?
set -e

if [[ "$unknown_status" -eq 0 ]]; then
  echo "FAIL: missing REPO_DIR should reject existing session"
  exit 1
fi

assert_contains "missing repo reports unknown" "$unknown_output" "Active repo:    unknown"
assert_not_contains "unknown repo does not kill session" "$(cat "$TMUX_LOG")" "kill-session"

: > "$TMUX_LOG"
TMUX_HAS_SESSION=0
TMUX_EXISTING_REPO=""
REPO_DIR="$TMP_DIR/repo"
mkdir -p "$REPO_DIR"
cat > "$REPO_DIR/.env" <<'EOF'
OPENROUTER_API_KEY=sk-openrouter-from-dotenv
EOF

create_tmux_session >/dev/null

assert_contains \
  "new session exports OPENROUTER_API_KEY from root .env" \
  "$(cat "$TMUX_LOG")" \
  "set-environment -t collide OPENROUTER_API_KEY sk-openrouter-from-dotenv"

echo "PASS: create_tmux_session rejects foreign sessions and hydrates provider env"
