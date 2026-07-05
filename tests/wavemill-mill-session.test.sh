#!/usr/bin/env bash
set -euo pipefail

# Regression tests for repository-scoped tmux session identity (HOK-2449).
#
# Covers:
#   - wavemill_default_session_name(): repo-scoped, hash-backed, tmux-safe,
#     stable, and distinct for same-basename repositories (the HOK-1075 class).
#   - load_config() precedence: SESSION env > config mill.session > derived.
#   - create_tmux_session(): a same-named session bound to a different (or
#     missing) REPO_DIR is refused non-destructively with actionable help.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMMON="$SCRIPT_DIR/../shared/lib/wavemill-common.sh"
MILL="$SCRIPT_DIR/../shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1${2:+ (expected '$2', got '$3')}"; FAIL=$((FAIL + 1)); }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then pass "$name"; else fail "$name" "$expected" "$actual"; fi
}

check_matches() {
  local name="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then pass "$name"; else fail "$name" "$pattern" "$actual"; fi
}

check_not_matches() {
  local name="$1" pattern="$2" actual="$3"
  if [[ "$actual" =~ $pattern ]]; then fail "$name (unexpected match)" "$pattern" "$actual"; else pass "$name"; fi
}

check_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then pass "$name"; else fail "$name" "contains: $needle" "$haystack"; fi
}

check_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then fail "$name (unexpected)" "absent: $needle" "$haystack"; else pass "$name"; fi
}

TMP="$(mktemp -d)"
FAKE_HOME="$(mktemp -d)"
trap 'rm -rf "$TMP" "$FAKE_HOME"' EXIT

source "$COMMON"

# ============================================================================
# wavemill_default_session_name()
# ============================================================================
echo "=== Default session name helper ==="

# Two different basenames -> different names.
a="$TMP/repo-a"; b="$TMP/repo-b"; mkdir -p "$a" "$b"
name_a="$(wavemill_default_session_name "$a")"
name_b="$(wavemill_default_session_name "$b")"
check_matches "name has slug+hash shape (a)" '^wavemill-[a-z0-9-]+-[a-z0-9]{8}$' "$name_a"
if [[ "$name_a" != "$name_b" ]]; then pass "distinct basenames differ"; else fail "distinct basenames differ" "$name_a != $name_b" "equal"; fi

# Two different repo roots that share the SAME basename -> different names.
sa="$TMP/x/mttr"; sb="$TMP/y/mttr"; mkdir -p "$sa" "$sb"
name_sa="$(wavemill_default_session_name "$sa")"
name_sb="$(wavemill_default_session_name "$sb")"
check_matches "same-basename keeps slug (a)" '^wavemill-mttr-[a-z0-9]{8}$' "$name_sa"
check_matches "same-basename keeps slug (b)" '^wavemill-mttr-[a-z0-9]{8}$' "$name_sb"
if [[ "$name_sa" != "$name_sb" ]]; then pass "same-basename repos get distinct names (HOK-1075)"; else fail "same-basename repos get distinct names" "$name_sa != $name_sb" "equal"; fi

# Deterministic: repeated calls return the same name.
check "repeated call is stable" "$name_sa" "$(wavemill_default_session_name "$sa")"

# Messy names -> tmux-safe (no whitespace, ':' or '.').
messy="$TMP/My Repo.v2:Beta"; mkdir -p "$messy"
name_messy="$(wavemill_default_session_name "$messy")"
check_matches "messy name normalized" '^wavemill-my-repo-v2-beta-[a-z0-9]{8}$' "$name_messy"
check_not_matches "no whitespace in name" '[[:space:]]' "$name_messy"
check_not_matches "no colon in name" ':' "$name_messy"
check_not_matches "no dot in name" '\.' "$name_messy"

# ============================================================================
# load_config() precedence
# ============================================================================
echo ""
echo "=== load_config() session precedence ==="

cfg_repo="$TMP/cfg-repo"; mkdir -p "$cfg_repo"

# Derived default when nothing is set.
derived="$(
  HOME="$FAKE_HOME" bash -c '
    source "'"$COMMON"'"
    unset SESSION
    load_config "'"$cfg_repo"'"
    printf "%s" "$SESSION"
  '
)"
check_matches "derived default is repo-scoped" '^wavemill-cfg-repo-[a-z0-9]{8}$' "$derived"

# Explicit SESSION env var wins verbatim.
env_sess="$(
  HOME="$FAKE_HOME" SESSION="my-custom-session" bash -c '
    source "'"$COMMON"'"
    load_config "'"$cfg_repo"'"
    printf "%s" "$SESSION"
  '
)"
check "explicit SESSION env wins verbatim" "my-custom-session" "$env_sess"

# Empty SESSION="" behaves as unset -> derived default.
empty_sess="$(
  HOME="$FAKE_HOME" SESSION="" bash -c '
    source "'"$COMMON"'"
    load_config "'"$cfg_repo"'"
    printf "%s" "$SESSION"
  '
)"
check_matches "empty SESSION falls back to derived" '^wavemill-cfg-repo-[a-z0-9]{8}$' "$empty_sess"

# Configured mill.session wins when env SESSION is unset.
cfg_sess_repo="$TMP/cfg-sess-repo"; mkdir -p "$cfg_sess_repo"
cat > "$cfg_sess_repo/.wavemill-config.json" <<'EOF'
{ "mill": { "session": "configured-session" } }
EOF
cfg_sess="$(
  HOME="$FAKE_HOME" bash -c '
    source "'"$COMMON"'"
    unset SESSION
    load_config "'"$cfg_sess_repo"'"
    printf "%s" "$SESSION"
  '
)"
check "config mill.session used when env unset" "configured-session" "$cfg_sess"

# ============================================================================
# create_tmux_session() mismatch guard
# ============================================================================
echo ""
echo "=== create_tmux_session() mismatch guard ==="

# Extract just the function definition to avoid running the mill loop / re-exec.
FN_SRC="$(sed -n '/^create_tmux_session() {$/,/^}$/p' "$MILL")"
if [[ -z "$FN_SRC" ]]; then
  fail "extract create_tmux_session()" "non-empty function body" "empty"
else
  pass "extract create_tmux_session()"
fi

# Fake tmux that records every invocation and reports a pre-seeded session.
FAKE_BIN="$TMP/bin"; mkdir -p "$FAKE_BIN"
TMUX_CALLS="$TMP/tmux-calls.log"
cat > "$FAKE_BIN/tmux" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >> "$TMUX_CALLS"
case "$1" in
  has-session)
    [[ "${FAKE_SESSION_EXISTS:-0}" == "1" ]] && exit 0 || exit 1 ;;
  show-environment)
    # $4 is the variable name (show-environment -t <sess> REPO_DIR)
    if [[ "$4" == "REPO_DIR" && -n "${FAKE_EXISTING_DIR:-}" ]]; then
      echo "REPO_DIR=${FAKE_EXISTING_DIR}"
    fi
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
chmod +x "$FAKE_BIN/tmux"

run_guard() {
  # Runs create_tmux_session in an isolated shell with fake tmux on PATH.
  # Args: existing_repo_dir requested_repo_dir  (existing empty => unset)
  local existing="$1" requested="$2"
  PATH="$FAKE_BIN:$PATH" \
  TMUX_CALLS="$TMUX_CALLS" \
  FAKE_SESSION_EXISTS=1 \
  FAKE_EXISTING_DIR="$existing" \
  SESSION="wavemill-shared" \
  REPO_DIR="$requested" \
  SCRIPT_DIR="$TMP" \
  WAVEMILL_WINDOW_MILL="mill" \
  bash -c '
    set -euo pipefail
    '"$FN_SRC"'
    create_tmux_session
  ' 2>&1
}

# Case 1: existing session bound to a DIFFERENT repo -> refuse, non-destructive.
: > "$TMUX_CALLS"
out=""; rc=0
out="$(run_guard "/Users/me/Dropbox/Hokusai/mttr" "/Users/me/Dropbox/wavemill")" || rc=$?
check "mismatch guard exits non-zero" "1" "$rc"
check_contains "error names active session repo" "/Users/me/Dropbox/Hokusai/mttr" "$out"
check_contains "error names requested repo" "/Users/me/Dropbox/wavemill" "$out"
check_contains "error gives attach command" "tmux attach -t 'wavemill-shared'" "$out"
check_contains "error gives kill command" "tmux kill-session -t 'wavemill-shared'" "$out"
check_contains "error gives override example" "SESSION=my-session wavemill mill" "$out"
calls="$(cat "$TMUX_CALLS")"
check_not_contains "no kill-session on mismatch" "kill-session" "$calls"
check_not_contains "no new-session on mismatch" "new-session" "$calls"
check_not_contains "no set-environment on mismatch" "set-environment" "$calls"

# Case 2: existing session with NO REPO_DIR (foreign/unknown) -> refuse.
: > "$TMUX_CALLS"
out=""; rc=0
out="$(run_guard "" "/Users/me/Dropbox/wavemill")" || rc=$?
check "foreign (no REPO_DIR) session refused" "1" "$rc"
check_contains "foreign session repo shown as unknown" "unknown" "$out"
calls="$(cat "$TMUX_CALLS")"
check_not_contains "no kill-session on foreign session" "kill-session" "$calls"

# Case 3: existing session bound to the SAME repo -> proceeds (recreates).
: > "$TMUX_CALLS"
rc=0
run_guard "/Users/me/Dropbox/wavemill" "/Users/me/Dropbox/wavemill" >/dev/null 2>&1 || rc=$?
check "matching repo proceeds" "0" "$rc"
calls="$(cat "$TMUX_CALLS")"
check_contains "matching repo recreates session" "new-session" "$calls"

# ============================================================================
echo ""
echo "=== Summary ==="
echo "PASS: $PASS  FAIL: $FAIL"
[[ "$FAIL" -eq 0 ]]
