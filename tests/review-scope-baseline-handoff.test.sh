#!/usr/bin/env bash
# HOK-2913: the coding→review handoff must materialize the review-scope
# baseline artifact so the guard reviews against the task-owned path set
# instead of falling back to merge-base scope as the normal case.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }

    $0 ~ "^" name "\\(\\) \\{" {
      capture=1
      depth=0
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

# ── Static contract: review launch materializes the baseline ──
launch_body="$(extract_function "$MILL_SCRIPT" "launch_review_phase")"
if [[ "$launch_body" == *"ensure_review_scope_baseline"* ]]; then
  pass "launch_review_phase calls ensure_review_scope_baseline"
else
  fail "launch_review_phase calls ensure_review_scope_baseline"
fi

# ── Behavior: extract and run ensure_review_scope_baseline for real ──
eval "$(extract_function "$MILL_SCRIPT" "ensure_review_scope_baseline")"

# shellcheck disable=SC2034  # read by the eval'd ensure_review_scope_baseline
TOOLS_DIR="$REPO_DIR/tools"
WARNINGS=""
log_warn() { WARNINGS+="$*"$'\n'; }
# Run tsx from the repo so node module resolution works for the tool.
wavemill_run_tsx_tool() { (cd "$REPO_DIR" && npx tsx "$@"); }

# Build a worktree-shaped repo: integration base, task branch, committed work.
WT="$TEST_TMP/worktree"
mkdir -p "$WT"
git -C "$WT" init -qb auto/integration
git -C "$WT" config user.email test@example.com
git -C "$WT" config user.name "Test User"
echo '{}' > "$WT/.wavemill-config.json"
echo base > "$WT/README.md"
git -C "$WT" add -A
git -C "$WT" commit -qm base
git -C "$WT" checkout -qb task/demo
mkdir -p "$WT/shared/lib"
echo checker > "$WT/shared/lib/new-checker.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "Add checker"

FEATURE_DIR="$WT/features/demo"
mkdir -p "$FEATURE_DIR"
BASELINE="$FEATURE_DIR/.review-scope-baseline.json"

if ensure_review_scope_baseline "HOK-TEST" "$WT" "$FEATURE_DIR"; then
  pass "handoff baseline write succeeds"
else
  fail "handoff baseline write succeeds"
fi

if [[ -f "$BASELINE" ]]; then
  pass "baseline artifact exists after handoff"
else
  fail "baseline artifact exists after handoff"
fi

if jq -e '.paths == ["shared/lib/new-checker.ts"]' "$BASELINE" >/dev/null 2>&1; then
  pass "baseline records the committed coding path set"
else
  echo "    baseline contents: $(cat "$BASELINE" 2>/dev/null)"
  fail "baseline records the committed coding path set"
fi

# A review-fix commit after the handoff must not widen the recorded scope.
echo fix > "$WT/tools-review-fix.ts"
git -C "$WT" add -A
git -C "$WT" commit -qm "review fix"
ensure_review_scope_baseline "HOK-TEST" "$WT" "$FEATURE_DIR" || true
if jq -e '.paths == ["shared/lib/new-checker.ts"]' "$BASELINE" >/dev/null 2>&1; then
  pass "existing baseline is preserved on relaunch"
else
  fail "existing baseline is preserved on relaunch"
fi

# Missing feature dir degrades to a warning, never an error.
if ensure_review_scope_baseline "HOK-TEST" "$WT" "$WT/features/missing"; then
  fail "missing feature dir returns non-zero"
else
  pass "missing feature dir returns non-zero"
fi
if [[ "$WARNINGS" == *"feature dir missing"* ]]; then
  pass "missing feature dir logs a warning"
else
  fail "missing feature dir logs a warning"
fi

echo ""
echo "review-scope-baseline-handoff: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
