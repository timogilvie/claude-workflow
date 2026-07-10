#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
LIB_DIR="$REPO_DIR/shared/lib"
TOOLS_DIR="$REPO_DIR/tools"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1: ${2:-}"; FAIL=$((FAIL + 1)); }

run_resolve() {
  local stdout_file="$1"
  local stderr_file="$2"
  shift 2

  (
    export REPO_DIR
    export TOOLS_DIR
    # shellcheck disable=SC1090
    source "$LIB_DIR/agent-adapters.sh"
    "$@"
  ) >"$stdout_file" 2>"$stderr_file"
}

run_snippet() {
  local stdout_file="$1"
  local stderr_file="$2"
  local snippet="$3"

  (
    export REPO_DIR
    export TOOLS_DIR
    # shellcheck disable=SC1090
    source "$LIB_DIR/agent-adapters.sh"
    eval "$snippet"
  ) >"$stdout_file" 2>"$stderr_file"
}

echo ""
echo "=== agent_resolve_from_model ==="

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "mistral-large-2" "planning"; then
  fail "mistral-large-2 planning should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "mistral-large-2 planning leaves stdout empty"
  else
    fail "mistral-large-2 planning leaves stdout empty" "got: $(cat "$stdout_file")"
  fi
  if grep -q '\[agent-resolution\].*mistral-large-2.*phase=planning' "$stderr_file" && grep -q 'native-agent-certify.ts' "$stderr_file"; then
    pass "mistral-large-2 planning emits actionable diagnostic"
  else
    fail "mistral-large-2 planning emits actionable diagnostic" "$(cat "$stderr_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"; then
  if [[ "$(tr -d '\n' < "$stdout_file")" == "claude" ]]; then
    pass "claude-sonnet-5 coding resolves to claude"
  else
    fail "claude-sonnet-5 coding resolves to claude" "got: $(cat "$stdout_file")"
  fi
else
  fail "claude-sonnet-5 coding resolves to claude" "$(cat "$stderr_file")"
fi
rm -f "$stdout_file" "$stderr_file"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "gpt-5.5" "review"; then
  if [[ "$(tr -d '\n' < "$stdout_file")" == "codex" ]]; then
    pass "gpt-5.5 review resolves to codex"
  else
    fail "gpt-5.5 review resolves to codex" "got: $(cat "$stdout_file")"
  fi
else
  fail "gpt-5.5 review resolves to codex" "$(cat "$stderr_file")"
fi
rm -f "$stdout_file" "$stderr_file"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export AGENT_CMD="codex"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "mistral-large-2" "planning"
); then
  fail "AGENT_CMD does not override mistral failure" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "AGENT_CMD does not override mistral failure"
  else
    fail "AGENT_CMD does not override mistral failure" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

stub_dir="$(mktemp -d)"
cat > "$stub_dir/jq" <<'EOF'
#!/usr/bin/env bash
exit 127
EOF
chmod +x "$stub_dir/jq"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export PATH="$stub_dir:$PATH"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"
); then
  fail "jq failure should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "jq failure keeps stdout empty"
  else
    fail "jq failure keeps stdout empty" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"
rm -rf "$stub_dir"

stub_dir="$(mktemp -d)"
cat > "$stub_dir/tsx" <<'EOF'
#!/usr/bin/env bash
printf 'not-json\n'
exit 0
EOF
chmod +x "$stub_dir/tsx"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if (
  export PATH="$stub_dir:$PATH"
  run_resolve "$stdout_file" "$stderr_file" agent_resolve_from_model "claude-sonnet-5" "coding"
); then
  fail "malformed resolver JSON should fail closed" "expected non-zero exit"
else
  if [[ ! -s "$stdout_file" ]]; then
    pass "malformed resolver JSON keeps stdout empty"
  else
    fail "malformed resolver JSON keeps stdout empty" "got: $(cat "$stdout_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"
rm -rf "$stub_dir"

stdout_file="$(mktemp)"
stderr_file="$(mktemp)"
if run_snippet "$stdout_file" "$stderr_file" '
  agent_resolve_models_for_roles "claude-sonnet-5" "gpt-5.5" "mistral-large-2"
  rc=$?
  printf "planner=%s\n" "$(agent_resolve_batch_agent_for_role planner)"
  printf "coder=%s\n" "$(agent_resolve_batch_agent_for_role coder)"
  printf "reviewer=%s\n" "$(agent_resolve_batch_agent_for_role reviewer)"
  exit "$rc"
'; then
  fail "batch resolution should fail when one role is unroutable" "expected non-zero exit"
else
  if grep -q '^planner=claude$' "$stdout_file" && grep -q '^coder=codex$' "$stdout_file" && grep -q '^reviewer=$' "$stdout_file"; then
    pass "batch resolution preserves successful role agents"
  else
    fail "batch resolution preserves successful role agents" "got: $(cat "$stdout_file")"
  fi
  if grep -q '\[agent-resolution\].*mistral-large-2.*phase=review' "$stderr_file"; then
    pass "batch resolution emits per-role diagnostic"
  else
    fail "batch resolution emits per-role diagnostic" "$(cat "$stderr_file")"
  fi
fi
rm -f "$stdout_file" "$stderr_file"

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
