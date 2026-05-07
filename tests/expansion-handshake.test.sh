#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
source "$REPO_DIR/shared/lib/wavemill-common.sh"

log() {
  local level="${1:-}" message="${2:-}"
  if [[ "$level" == "warn" ]]; then
    printf '%s\n' "$message" >&2
  else
    printf '%s\n' "$message"
  fi
}

log_warn() { printf '%s\n' "$*" >&2; }

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

new_fixture() {
  local name="$1"
  local root
  root="$(mktemp -d "/tmp/${name}.XXXXXX")"
  local feature_dir="$root/features/demo"
  mkdir -p "$feature_dir"
  printf '%s\n%s\n' "$root" "$feature_dir"
}

run_gate() {
  local feature_dir="$1" issue="$2" repo_dir="$3"
  mill_check_expansion_handshake "$feature_dir" "$issue" "$repo_dir"
}

run_reason() {
  local feature_dir="$1"
  mill_expansion_handshake_reason "$feature_dir"
}

echo "=== Expansion Handshake Gate ==="

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-missing")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'fix api timeout in webhook path\n' > "$feature_dir/task-packet.md"
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$(run_reason "$feature_dir")" == "missing" ]] \
    && [[ "$status" -eq 1 ]] \
    && grep -q 'policy=recover' <<< "$output"; then
    pass "REQ-F1 raw + missing route reports recoverable missing state"
  else
    fail "REQ-F1 raw + missing route should report recoverable missing state"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-block")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'basic issue text\n' > "$feature_dir/task-packet.md"
  cat > "$root/.wavemill-config.json" <<'EOF'
{"mill":{"expansionHandshake":{"policy":"block"}}}
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 1 ]] && grep -q '\[expansion-handshake\] BLOCKED' <<< "$output"; then
    pass "REQ-F2 block policy preserves strict handoff"
  else
    fail "REQ-F2 block policy should preserve strict handoff"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-warn")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'basic issue text\n' > "$feature_dir/task-packet.md"
  cat > "$root/.wavemill-config.json" <<'EOF'
{"mill":{"expansionHandshake":{"policy":"warn"}}}
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]] && grep -q '\[expansion-handshake\] WARN' <<< "$output"; then
    pass "REQ-F3 warn policy allows transition with warning"
  else
    fail "REQ-F3 warn policy should allow transition"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-task-packet")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  cat > "$feature_dir/task-packet.md" <<'EOF'
## 1. Objective
Implement handshake gate
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]] && ! grep -q 'reason=already-expanded' <<< "$output"; then
    pass "REQ-F4 expanded packet bypasses route requirement quietly by default"
  else
    fail "REQ-F4 expanded packet should pass quietly by default"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-valid-route")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'raw description\n' > "$feature_dir/task-packet.md"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"medium","reviewer":"claude-sonnet-4-6","reviewMode":"llm"}
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]] && ! grep -q 'reason=expanded-route-present' <<< "$output"; then
    pass "REQ-F5 valid post-expansion route passes quietly by default"
  else
    fail "REQ-F5 valid route should pass quietly by default"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-legacy-route")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'raw description\n' > "$feature_dir/task-packet.md"
  cat > "$feature_dir/.expanded-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"medium","reviewer":"claude-sonnet-4-6","reviewMode":"llm"}
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]] && ! grep -q 'reason=expanded-route-present' <<< "$output"; then
    pass "REQ-F6 legacy expanded route artifact passes quietly by default"
  else
    fail "REQ-F6 legacy expanded route artifact should pass quietly by default"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-verbose")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf '## 1. Objective\nAlready expanded\n' > "$feature_dir/task-packet.md"
  set +e
  output="$(WAVEMILL_ROUTER_LOG_VERBOSE=1 run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 0 ]] && grep -q '\[expansion-handshake\] PASS' <<< "$output"; then
    pass "verbose mode restores PASS handshake logs"
  else
    fail "verbose mode should restore PASS handshake logs"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-invalid-json")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'raw description\n' > "$feature_dir/task-packet.md"
  printf '{' > "$feature_dir/.post-expansion-route.json"
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 1 ]] && grep -q 'reason=invalid-json' <<< "$output"; then
    pass "edge case malformed route reports invalid-json"
  else
    fail "edge case malformed route should block with invalid-json"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expansion-handshake-invalid-fields")
  root="${fixture[0]}"; feature_dir="${fixture[1]}"
  printf 'raw description\n' > "$feature_dir/task-packet.md"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4"}
EOF
  set +e
  output="$(run_gate "$feature_dir" "HOK-1513" "$root" 2>&1)"
  status=$?
  set -e
  if [[ "$status" -eq 1 ]] && grep -q 'reason=missing-required-field' <<< "$output"; then
    pass "edge case missing fields reports missing-required-field"
  else
    fail "edge case missing fields should block"
  fi
  rm -rf "$root"
}

echo
echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -ne 0 ]]; then
  exit 1
fi
