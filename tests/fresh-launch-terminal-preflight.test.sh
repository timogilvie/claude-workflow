#!/usr/bin/env bash
set -euo pipefail

# HOK-2965: Fresh-launch PR reconciliation tests
# Validates that resolve_pr_for_launch() correctly classifies PRs and that
# the startup runner skips terminal entries before resource allocation.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP_DIR="$(mktemp -d /tmp/wavemill-fresh-launch-preflight.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$name"
  fi
}

# --- Fake binaries ---
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN"

write_normal_gh_stub() {
  cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
set -eo pipefail
printf '%s\n' "$*" >> "${GH_CALL_LOG:-/dev/null}"
if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  branch=""
  prev=""
  for arg in "$@"; do
    if [[ "$prev" == "--head" ]]; then
      branch="$arg"
      break
    fi
    prev="$arg"
  done
  fixture="${GH_PR_LIST_DIR:-/tmp}/${branch//\//_}.json"
  if [[ -f "$fixture" ]]; then
    cat "$fixture"
  else
    echo "[]"
  fi
  exit 0
fi
if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  pr="${3:-}"
  [[ -f "${GH_PR_VIEW_DIR:-/dev/null}/$pr.json" ]] || exit 44
  if [[ "$*" == *"--jq .state"* ]]; then
    jq -r '.state // empty' "${GH_PR_VIEW_DIR:-/dev/null}/$pr.json"
  else
    cat "${GH_PR_VIEW_DIR:-/dev/null}/$pr.json"
  fi
  exit 0
fi
exit 1
SH
  chmod +x "$FAKE_BIN/gh"
}

write_normal_gh_stub

cat > "$FAKE_BIN/tmux" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKE_BIN/tmux"

PATH="$FAKE_BIN:$PATH"
export PATH

# Source shared helpers
# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_DIR/shared/lib/wavemill-common.sh"

# Test environment
SESSION="fresh-preflight-test"
STATE_FILE="$TMP_DIR/workflow-state.json"
GH_PR_LIST_DIR="$TMP_DIR/pr-list"
GH_PR_VIEW_DIR="$TMP_DIR/pr-view"
GH_CALL_LOG="$TMP_DIR/gh.log"
BASE_BRANCH="auto/integration"
API_TIMEOUT=5
WAVEMILL_RUN_EPOCH="epoch-test"
export SESSION STATE_FILE GH_PR_LIST_DIR GH_PR_VIEW_DIR GH_CALL_LOG BASE_BRANCH API_TIMEOUT WAVEMILL_RUN_EPOCH

mkdir -p "$GH_PR_LIST_DIR" "$GH_PR_VIEW_DIR"

# Stubs
log() { :; }
log_warn() { :; }
log_error() { :; }

reset_case() {
  rm -f "$GH_CALL_LOG"
  : > "$GH_CALL_LOG"
  RESOLVE_PR_CLASSIFICATION=""
  RESOLVE_PR_NUMBER=""
  RESOLVE_PR_STATE=""
  RESOLVE_PR_HEAD_REF=""
  RESOLVE_PR_BASE_REF=""
  RESOLVE_PR_HEAD_OID=""
  RESOLVE_PR_EVIDENCE_JSON=""
}

write_pr_list_fixture() {
  local branch="$1" json="$2"
  local safe_name="${branch//\//_}"
  printf '%s\n' "$json" > "$GH_PR_LIST_DIR/${safe_name}.json"
}

echo "=== Fresh-Launch PR Resolver (HOK-2965) ==="
echo ""

# --- Test 1: Merged PR on matching base => current-merged ---
reset_case
write_pr_list_fixture "task/merged-work" '[{"number":1306,"state":"MERGED","headRefName":"task/merged-work","baseRefName":"auto/integration","headRefOid":"abc123","mergedAt":"2026-09-02T00:00:00Z"}]'
resolve_pr_for_launch "task/merged-work" "auto/integration" "HOK-2915"
check_eq "merged PR on matching base → current-merged" "current-merged" "$RESOLVE_PR_CLASSIFICATION"
check_eq "merged PR number populated" "1306" "$RESOLVE_PR_NUMBER"

# --- Test 2: Merged PR on different base => historical-merged ---
reset_case
write_pr_list_fixture "task/old-branch" '[{"number":500,"state":"MERGED","headRefName":"task/old-branch","baseRefName":"main","headRefOid":"def456","mergedAt":"2026-01-15T00:00:00Z"}]'
resolve_pr_for_launch "task/old-branch" "auto/integration" "HOK-1001"
check_eq "merged PR on wrong base → historical-merged" "historical-merged" "$RESOLVE_PR_CLASSIFICATION"
check_eq "historical merged PR number populated" "500" "$RESOLVE_PR_NUMBER"

# --- Test 3: Closed (unmerged) PR => historical-closed ---
reset_case
write_pr_list_fixture "task/reopened-issue" '[{"number":1043,"state":"CLOSED","headRefName":"task/reopened-issue","baseRefName":"auto/integration","headRefOid":"xyz789","mergedAt":""}]'
resolve_pr_for_launch "task/reopened-issue" "auto/integration" "HOK-2595"
check_eq "closed unmerged PR → historical-closed" "historical-closed" "$RESOLVE_PR_CLASSIFICATION"
check_eq "closed PR number populated" "1043" "$RESOLVE_PR_NUMBER"

# --- Test 4: Open PR on matching base => current-open ---
reset_case
write_pr_list_fixture "task/active-work" '[{"number":1350,"state":"OPEN","headRefName":"task/active-work","baseRefName":"auto/integration","headRefOid":"active123"}]'
resolve_pr_for_launch "task/active-work" "auto/integration" "HOK-3000"
check_eq "open PR on matching base → current-open" "current-open" "$RESOLVE_PR_CLASSIFICATION"
check_eq "open PR number" "1350" "$RESOLVE_PR_NUMBER"

# --- Test 5: No PRs found => none ---
reset_case
resolve_pr_for_launch "task/brand-new" "auto/integration" "HOK-3001"
check_eq "no PRs found → none" "none" "$RESOLVE_PR_CLASSIFICATION"
check_eq "no PR number" "" "$RESOLVE_PR_NUMBER"

# --- Test 6: gh failure => unverifiable ---
reset_case
cat > "$FAKE_BIN/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${GH_CALL_LOG:-/dev/null}"
exit 1
SH
chmod +x "$FAKE_BIN/gh"
resolve_pr_for_launch "task/unreachable" "auto/integration" "HOK-3002"
check_eq "gh failure → unverifiable" "unverifiable" "$RESOLVE_PR_CLASSIFICATION"

# Restore normal gh stub
write_normal_gh_stub

# --- Test 7: Open PR on wrong base => historical-closed (base mismatch) ---
reset_case
write_pr_list_fixture "task/open-wrong-base" '[{"number":1100,"state":"OPEN","headRefName":"task/open-wrong-base","baseRefName":"main","headRefOid":"wrong123"}]'
resolve_pr_for_launch "task/open-wrong-base" "auto/integration" "HOK-3003"
check_eq "open PR on wrong base → historical-closed" "historical-closed" "$RESOLVE_PR_CLASSIFICATION"

# --- Test 8: Empty branch arg returns none ---
reset_case
resolve_pr_for_launch "" "auto/integration" "HOK-0000"
check_eq "empty branch → none" "none" "$RESOLVE_PR_CLASSIFICATION"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
