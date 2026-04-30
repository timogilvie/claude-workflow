#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
TMP_DIR="$(mktemp -d /tmp/wavemill-monitor-pr-cache.XXXXXX)"
BIN_DIR="$TMP_DIR/bin"
COUNTER_FILE="$TMP_DIR/gh-pr-list-count"
HEREDOC_FILE="$TMP_DIR/monitor-heredoc.sh"
export COUNTER_FILE

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

extract_monitor_heredoc() {
  awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { capture=1; next }
    /^MONITOR_EOF$/ { capture=0 }
    capture { print }
  ' "$MILL_SCRIPT"
}

extract_function() {
  local name="$1"
  awk -v fn="$name" '
    $0 ~ ("^" fn "\\(\\) \\{") { capture=1 }
    capture { print }
    capture && /^\}/ { exit }
  ' "$HEREDOC_FILE"
}

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  count=0
  if [[ -f "$COUNTER_FILE" ]]; then
    count=$(<"$COUNTER_FILE")
  fi
  printf '%s\n' "$((count + 1))" > "$COUNTER_FILE"
  printf '%s\n' '[{"number":101,"headRefName":"task/a"},{"number":102,"headRefName":"task/b"}]'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
EOF
chmod +x "$BIN_DIR/gh"
export PATH="$BIN_DIR:$PATH"

_with_timeout() {
  shift
  "$@"
}

extract_monitor_heredoc > "$HEREDOC_FILE"

eval "$(extract_function refresh_cycle_pr_cache)"
eval "$(extract_function lookup_pr_in_cycle_cache)"
eval "$(extract_function find_pr_for_branch)"

CYCLE_PR_CACHE=""
CYCLE_PR_CACHE_FETCHED_AT=0
MILL_PR_CACHE_TTL=30
API_TIMEOUT=5

refresh_cycle_pr_cache
pr_a="$(find_pr_for_branch "task/a")"
pr_b="$(find_pr_for_branch "task/b")"
pr_unknown="$(lookup_pr_in_cycle_cache "task/missing")"

count_after_first=$(<"$COUNTER_FILE")
[[ "$count_after_first" == "1" ]] || {
  echo "FAIL: expected 1 gh pr list call after first refresh, got $count_after_first"
  exit 1
}
[[ "$pr_a" == "101" ]] || {
  echo "FAIL: expected task/a to map to PR 101, got ${pr_a:-<empty>}"
  exit 1
}
[[ "$pr_b" == "102" ]] || {
  echo "FAIL: expected task/b to map to PR 102, got ${pr_b:-<empty>}"
  exit 1
}
[[ -z "$pr_unknown" ]] || {
  echo "FAIL: expected missing branch lookup to be empty, got $pr_unknown"
  exit 1
}

refresh_cycle_pr_cache
count_within_ttl=$(<"$COUNTER_FILE")
[[ "$count_within_ttl" == "1" ]] || {
  echo "FAIL: expected cache refresh within TTL to skip gh, got $count_within_ttl calls"
  exit 1
}

CYCLE_PR_CACHE_FETCHED_AT=0
refresh_cycle_pr_cache
count_after_ttl=$(<"$COUNTER_FILE")
[[ "$count_after_ttl" == "2" ]] || {
  echo "FAIL: expected TTL expiry to trigger second gh call, got $count_after_ttl"
  exit 1
}

echo "PASS: monitor PR cache fetches once per TTL window"
