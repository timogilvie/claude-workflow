#!/usr/bin/env bash
# Regression test: every bare `$VAR` reference in the generated monitor
# heredoc must be available at runtime — either defined inside the heredoc
# itself, sourced via write_monitor_env() in wavemill-startup-runner.sh,
# or a standard shell variable.
#
# Catches the class of bug where a global is added to wavemill-mill.sh and
# referenced inside the monitor heredoc without being plumbed through the
# monitor.env (e.g. MERGE_QUEUE_SELECTION_FILE crash in `wavemill mill`).
#
# A bare reference is `$VAR` or `${VAR}` (no `:-`/`-`/`:+`/`+`/`:=`/`=`/`:?`/`?`
# operator). Variables that ALSO appear with a fallback operator anywhere in
# the heredoc are treated as intentionally optional and not flagged.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
RUNNER_SCRIPT="$REPO_DIR/shared/lib/wavemill-startup-runner.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

HEREDOC_FILE="$TMP/monitor-heredoc.sh"
awk '
  /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
  /^MONITOR_EOF$/ { found=0; next }
  found { print }
' "$MILL_SCRIPT" > "$HEREDOC_FILE"

if [[ ! -s "$HEREDOC_FILE" ]]; then
  echo "FATAL: Could not extract monitor heredoc from $MILL_SCRIPT"
  exit 1
fi

# Standard shell / runtime vars that are always set and never need plumbing
ALLOWLIST=(
  PATH HOME USER SHELL TERM LANG LC_ALL IFS EUID UID HOSTNAME
  PWD OLDPWD RANDOM PIPESTATUS FUNCNAME BASH_SOURCE LINENO REPLY
  BASHPID PPID SECONDS COLUMNS LINES TMPDIR FUNCNEST SHLVL
  BASH_COMMAND BASH_LINENO BASH_REMATCH BASH_SUBSHELL BASH_VERSION
  BASH_ARGV BASH_ARGC BASH_ENV BASH_EXECUTION_STRING
  EDITOR VISUAL TMUX
)

# 1. Bare references: $VAR or ${VAR} or ${VAR[..]} or ${#VAR}
mapfile -t BARE_REFS < <(
  {
    grep -hoE '\$[A-Z_][A-Z_0-9]+' "$HEREDOC_FILE" | sed 's/^\$//'
    grep -hoE '\$\{#?[A-Z_][A-Z_0-9]+(\[[^]]*\])?\}' "$HEREDOC_FILE" \
      | sed -E 's/^\$\{#?//; s/(\[[^]]*\])?\}$//'
  } | sort -u
)

# 2. Variables referenced anywhere with a fallback operator (treated as optional).
#    A site like ${VAR:-} is enough to consider VAR intentionally optional, since
#    that proves the author expects unset.
mapfile -t OPTIONAL_REFS < <(
  grep -hoE '\$\{[A-Z_][A-Z_0-9]+:?[-=?+][^}]*\}' "$HEREDOC_FILE" \
    | sed -E 's/^\$\{([A-Z_][A-Z_0-9]+):?[-=?+].*$/\1/' \
    | sort -u
)

# 3. Variables defined within the heredoc body
mapfile -t ASSIGNED < <(
  {
    # NAME= at start of line (with optional indent)
    grep -hoE '^[[:space:]]*[A-Z_][A-Z_0-9]+=' "$HEREDOC_FILE" \
      | sed -E 's/^[[:space:]]*//; s/=$//'
    # local NAME ... / local NAME=...
    grep -hoE 'local[[:space:]]+[^;|&]+' "$HEREDOC_FILE" \
      | sed 's/^local[[:space:]]*//' \
      | grep -oE '[A-Z_][A-Z_0-9]+' || true
    # export NAME=...
    grep -hoE 'export[[:space:]]+[A-Z_][A-Z_0-9]+' "$HEREDOC_FILE" | awk '{print $2}'
    # declare [-flags] NAME [NAME...]
    grep -hoE 'declare[[:space:]]+(-[Aagilnrtux]+[[:space:]]+)?[A-Z_][A-Z_0-9]+([[:space:]]+[A-Z_][A-Z_0-9]+)*' "$HEREDOC_FILE" \
      | sed -E 's/^declare[[:space:]]+(-[Aagilnrtux]+[[:space:]]+)?//' \
      | tr ' ' '\n' | grep -E '^[A-Z_][A-Z_0-9]+$' || true
    # for VAR in
    grep -hoE 'for[[:space:]]+[A-Z_][A-Z_0-9]+[[:space:]]+in' "$HEREDOC_FILE" | awk '{print $2}'
    # read [-flags] [-arg val ...] VAR [VAR...]
    grep -hE '^[[:space:]]*(while[[:space:]]+)?(IFS=[^[:space:]]*[[:space:]]+)?read[[:space:]]' "$HEREDOC_FILE" \
      | sed -E 's/.*read[[:space:]]+(-[a-zA-Z][[:space:]]+[^[:space:]]+[[:space:]]+|-[a-zA-Z][[:space:]]+)*//' \
      | tr -d '<>;|&' | tr ' ' '\n' \
      | grep -E '^[A-Z_][A-Z_0-9]+$' || true
    # mapfile [-flags] NAME
    grep -hoE 'mapfile[[:space:]]+(-[a-zA-Z][[:space:]]+[^[:space:]]+[[:space:]]+|-[a-zA-Z][[:space:]]+)*[A-Z_][A-Z_0-9]+' "$HEREDOC_FILE" \
      | awk '{print $NF}'
  } | sort -u
)

# 4. Variables exported by write_monitor_env in startup-runner.sh
mapfile -t ENV_PROVIDED < <(
  awk '/^write_monitor_env\(\)/,/^}/' "$RUNNER_SCRIPT" \
    | grep -hoE 'write_shell_assignment[[:space:]]+"[A-Z_][A-Z_0-9]+"' \
    | sed -E 's/.*"([^"]+)"$/\1/' \
    | sort -u
)

if [[ ${#ENV_PROVIDED[@]} -eq 0 ]]; then
  echo "FATAL: Could not extract write_monitor_env() variables from $RUNNER_SCRIPT"
  exit 1
fi

AVAILABLE_FILE="$TMP/available.txt"
{
  printf '%s\n' "${ASSIGNED[@]}"
  printf '%s\n' "${ENV_PROVIDED[@]}"
  printf '%s\n' "${ALLOWLIST[@]}"
  printf '%s\n' "${OPTIONAL_REFS[@]}"
} | grep -v '^$' | sort -u > "$AVAILABLE_FILE"

MISSING=()
for ref in "${BARE_REFS[@]}"; do
  [[ -z "$ref" ]] && continue
  if ! grep -qx "$ref" "$AVAILABLE_FILE"; then
    MISSING+=("$ref")
  fi
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  pass "All bare \$VAR references in monitor heredoc are available at runtime"
else
  fail "Bare \$VAR references in monitor heredoc are not available at runtime:"
  for v in "${MISSING[@]}"; do
    echo "    - \$$v"
    grep -nE "\\\$\\{?$v" "$HEREDOC_FILE" | head -3 | sed 's/^/        /'
  done
  echo ""
  echo "  Each variable above is referenced in the generated monitor script but"
  echo "  is neither (a) defined inside the heredoc, (b) exported by"
  echo "  write_monitor_env() in shared/lib/wavemill-startup-runner.sh, nor"
  echo "  (c) referenced with a \${VAR:-default} guard anywhere."
  echo ""
  echo "  Fix one of:"
  echo "    1. Add write_shell_assignment \"VAR\" \"\$VAR\" to write_monitor_env(),"
  echo "       OR"
  echo "    2. Change the bare reference to use \${VAR:-default} guard form."
fi

# Direct regression guard for the original incident.
if grep -q 'write_shell_assignment "MERGE_QUEUE_SELECTION_FILE"' "$RUNNER_SCRIPT"; then
  pass "MERGE_QUEUE_SELECTION_FILE is exported by write_monitor_env (regression guard)"
else
  fail "MERGE_QUEUE_SELECTION_FILE is NOT exported by write_monitor_env"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
[[ $FAIL -eq 0 ]]
