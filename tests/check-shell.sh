#!/usr/bin/env bash
set -euo pipefail

# Shell Script Validation Tests
# Checks bash syntax and verifies heredoc function availability
# to prevent the bug class from PRs 48 and 52 (undefined functions
# in the standalone monitor script).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

# ============================================================================
# TEST 1: Bash syntax check on all shell scripts
# ============================================================================
echo "=== Syntax Check (bash -n) ==="

for f in \
  "$LIB_DIR"/wavemill-*.sh \
  "$LIB_DIR"/agent-adapters.sh \
  "$REPO_DIR/wavemill" \
; do
  if [[ ! -f "$f" ]]; then
    fail "File not found: $f"
    continue
  fi
  if bash -n "$f" 2>/dev/null; then
    pass "$(basename "$f")"
  else
    fail "$(basename "$f") has syntax errors"
  fi
done

# ============================================================================
# TEST 2: Heredoc function-availability check
# ============================================================================
# The monitor script in wavemill-mill.sh is generated as a standalone bash
# script via heredoc. It does NOT inherit functions from the parent shell.
# Every function it calls must be:
#   (a) defined inline in the heredoc, OR
#   (b) defined in agent-adapters.sh (which is sourced), OR
#   (c) an external command or bash builtin
#
# This test extracts the heredoc, parses function definitions and calls,
# and flags any function called but not defined.

echo ""
echo "=== Heredoc Function Availability (wavemill-mill.sh monitor script) ==="

MILL_SCRIPT="$LIB_DIR/wavemill-mill.sh"

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found"
else
  # Extract heredoc content (between <<'MONITOR_EOF' and ^MONITOR_EOF)
  # Use awk to extract just the content (excluding the cat line and closing marker)
  HEREDOC_CONTENT=$(awk '
    /^cat > "\$MONITOR_SCRIPT" <<'\''MONITOR_EOF'\''$/ { found=1; next }
    /^MONITOR_EOF$/ { found=0; next }
    found { print }
  ' "$MILL_SCRIPT")

  if [[ -z "$HEREDOC_CONTENT" ]]; then
    fail "Could not extract MONITOR_EOF heredoc from wavemill-mill.sh"
  else
    # Extract function definitions from the heredoc (name followed by () with optional space and {)
    HEREDOC_FUNCS=$(echo "$HEREDOC_CONTENT" | grep -oE '^[a-z_][a-z0-9_]*\(\)' | sed 's/()//' | sort -u)

    # Extract function definitions from agent-adapters.sh (sourced by the heredoc)
    ADAPTER_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/agent-adapters.sh" | sed 's/()//' | sort -u)

    # Extract function definitions from wavemill-common.sh (also sourced by monitor)
    COMMON_FUNCS=$(grep -oE '^[a-z_][a-z0-9_]*\(\)' "$LIB_DIR/wavemill-common.sh" | sed 's/()//' | sort -u)

    # Combine all available function definitions
    ALL_DEFINED=$(printf '%s\n%s\n%s' "$HEREDOC_FUNCS" "$ADAPTER_FUNCS" "$COMMON_FUNCS" | sort -u)

    # Known external commands and bash builtins that are NOT custom functions
    # This list covers standard utilities, coreutils, and tools used by wavemill
    KNOWN_EXTERNALS="bash|cat|cd|chmod|column|command|continue|cut|date|declare|diff|dirname|echo|eval|exec|exit|export|false|find|git|grep|gh|head|jq|kill|local|ls|mkdir|mktemp|mv|npx|printf|read|readlink|return|rm|sed|set|shift|sleep|sort|source|stat|tail|tee|test|tmux|touch|tr|trap|true|tput|uniq|unset|wait|wc|xargs|basename|awk|seq|ascii_downcase"

    # Extract function calls from the heredoc
    # Look for word-boundary function-like names that appear as commands
    # (start of line after optional whitespace, or after $(), ||, &&, if, then, etc.)
    CALLED_FUNCS=$(echo "$HEREDOC_CONTENT" \
      | grep -oE '\b[a-z_][a-z0-9_]{2,}\b' \
      | sort -u \
      | grep -vE "^($KNOWN_EXTERNALS)$" \
      | grep -vE '^(done|else|elif|esac|fi|for|function|if|in|then|until|while|do|case)$' \
      | grep -vE '^(err|out|dev|null|tmp|usr|bin|opt|homebrew|lib|etc|var|tmp|home)$' \
      | grep -vE '^(pipefail|euo|noglob|errexit|nounset)$' \
      | grep -vE '^(env|stdin|stdout|stderr|json|txt|csv|pid|utf)$' \
      | grep -vE '^(true|false|yes|string|number|empty|null|undefined)$')

    # Check which called names look like they could be custom functions
    # and verify they're defined
    MISSING=""
    while IFS= read -r name; do
      [[ -z "$name" ]] && continue
      # Check if this name is defined in our known functions
      if ! echo "$ALL_DEFINED" | grep -qx "$name"; then
        # Only flag names that are actually used as function calls in the heredoc
        # (appear at start of a line after whitespace, or after || or && or $( )
        if echo "$HEREDOC_CONTENT" | grep -qE "(^|[;&|] *|\$\( *)$name " 2>/dev/null; then
          MISSING="$MISSING $name"
        fi
      fi
    done <<< "$CALLED_FUNCS"

    if [[ -z "$MISSING" ]]; then
      pass "All function calls in monitor heredoc are defined"
    else
      fail "Undefined function(s) called in monitor heredoc:$MISSING"
    fi

    # Also verify that functions used in the main monitoring loop are defined
    # These are the critical functions that caused PRs 48 and 52
    CRITICAL_FUNCTIONS=(
      log log_error log_warn
      save_task_state remove_task_state set_task_phase get_task_phase
      find_pr_for_branch pr_state validate_pr_merge
      linear_set_state linear_is_completed
      check_plan_approved
      fetch_candidates filter_active_issues
      launch_task is_task_packet
      cleanup_dashboard_pane
    )

    for func in "${CRITICAL_FUNCTIONS[@]}"; do
      if echo "$ALL_DEFINED" | grep -qx "$func"; then
        pass "Critical function '$func' is defined in monitor scope"
      else
        fail "Critical function '$func' is NOT defined in monitor scope"
      fi
    done
  fi
fi

# ============================================================================
# TEST 3: Monitor PR-detection regression guards
# ============================================================================
echo ""
echo "=== Monitor PR Detection Regression Guards ==="

if [[ ! -f "$MILL_SCRIPT" ]]; then
  fail "wavemill-mill.sh not found for monitor regression checks"
elif [[ -z "${HEREDOC_CONTENT:-}" ]]; then
  fail "Monitor heredoc content unavailable for regression checks"
else
  if echo "$HEREDOC_CONTENT" | grep -qE 'gh pr list --head "\$branch" --state all --json number'; then
    pass "monitor find_pr_for_branch queries all PR states"
  else
    fail "monitor find_pr_for_branch is missing --state all"
  fi

  if echo "$HEREDOC_CONTENT" | grep -qE '^pr_state\(\) \{'; then
    pass "monitor defines pr_state helper"
  else
    fail "monitor is missing pr_state helper definition"
  fi

  if echo "$HEREDOC_CONTENT" | grep -q 'set-issue-state.ts'; then
    pass "monitor linear_set_state uses set-issue-state.ts"
  else
    fail "monitor linear_set_state is not calling set-issue-state.ts"
  fi

  if echo "$HEREDOC_CONTENT" | grep -q 'update-linear-state.ts'; then
    fail "monitor references removed update-linear-state.ts tool"
  else
    pass "monitor does not reference update-linear-state.ts"
  fi

  LINEAR_SET_STATE_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^linear_set_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ')
  if echo "$LINEAR_SET_STATE_BLOCK" | grep -q 'return 1'; then
    fail "monitor linear_set_state must not return 1 (would exit under set -e)"
  else
    pass "monitor linear_set_state failures are non-fatal"
  fi

  MONITOR_LOOP_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^while :; do$/ { in_loop=1 }
    in_loop { print }
    in_loop && /^done$/ { exit }
  ')
  if echo "$MONITOR_LOOP_BLOCK" | grep -qE '^[[:space:]]*local[[:space:]]'; then
    fail "monitor loop contains top-level local declarations (invalid outside functions)"
  else
    pass "monitor loop has no top-level local declarations"
  fi

  if echo "$MONITOR_LOOP_BLOCK" | grep -q 'monitor_issue_state "$ISSUE"' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'issue_rc=$?' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'set +e' \
    && echo "$MONITOR_LOOP_BLOCK" | grep -q 'set -e'; then
    pass "monitor loop guards per-issue processing with explicit error handling"
  else
    fail "monitor loop is missing guarded per-issue processing checks"
  fi

  MONITOR_ISSUE_BLOCK=$(echo "$HEREDOC_CONTENT" | awk '
    /^monitor_issue_state\(\) \{/ { in_fn=1 }
    in_fn { print }
    in_fn && /^\}/ { exit }
  ')
  PLAN_CHECK_LINE=$(echo "$MONITOR_ISSUE_BLOCK" | grep -n 'check_plan_approved "\$SLUG"' | head -n1 | cut -d: -f1 || true)
  PANE_EARLY_RETURN_LINE=$(echo "$MONITOR_ISSUE_BLOCK" | grep -n 'Not completed externally - check if agent pane is still alive' | head -n1 | cut -d: -f1 || true)
  if [[ -n "$PLAN_CHECK_LINE" && -n "$PANE_EARLY_RETURN_LINE" ]] && (( PLAN_CHECK_LINE < PANE_EARLY_RETURN_LINE )); then
    pass "monitor checks planning approval before no-PR pane-alive early return"
  else
    fail "monitor planning approval check runs too late (after pane-alive early return)"
  fi
fi

# ============================================================================
# TEST 3: Verify sourced libraries exist
# ============================================================================
echo ""
echo "=== Sourced Library Verification ==="

# Check that all source statements in shell scripts reference existing files
for script in "$LIB_DIR"/wavemill-*.sh; do
  [[ -f "$script" ]] || continue
  while IFS= read -r line; do
    # Extract the sourced file path (handle both $SCRIPT_DIR and $LIB_DIR variables)
    sourced=$(echo "$line" | sed -E 's/^source "//;s/"$//' \
      | sed "s|\\\$SCRIPT_DIR|$LIB_DIR|g" \
      | sed "s|\\\$LIB_DIR|$LIB_DIR|g" \
      | sed "s|\\\${BASH_SOURCE\[0\]}|$script|g")
    # Skip variable-only paths we can't resolve statically
    if echo "$sourced" | grep -q '\$'; then
      continue
    fi
    if [[ -f "$sourced" ]]; then
      pass "$(basename "$script") sources $(basename "$sourced") (exists)"
    else
      fail "$(basename "$script") sources $sourced (NOT FOUND)"
    fi
  done < <(grep -E '^\s*source\s+"' "$script" 2>/dev/null || true)
done

# ============================================================================
# TEST 4: Optional ShellCheck
# ============================================================================
if command -v shellcheck >/dev/null 2>&1; then
  echo ""
  echo "=== ShellCheck (error severity) ==="
  for f in "$LIB_DIR"/wavemill-common.sh "$LIB_DIR"/agent-adapters.sh; do
    [[ -f "$f" ]] || continue
    if shellcheck --severity=error "$f" 2>/dev/null; then
      pass "shellcheck $(basename "$f")"
    else
      fail "shellcheck $(basename "$f")"
    fi
  done
fi

# ============================================================================
# RESULTS
# ============================================================================
echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
