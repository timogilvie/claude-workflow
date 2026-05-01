#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source the shared helpers under test.
source "$REPO_DIR/shared/lib/wavemill-common.sh"

log() {
  local level="${1:-}" message="${2:-}"
  if [[ "$level" == "warn" ]]; then
    printf '%s\n' "$message" >&2
  fi
}

log_warn() {
  printf '%s\n' "$*" >&2
}

agent_resolve_from_model() {
  local model="${1:-}"
  case "$model" in
    gpt-*|o*|codex*) printf 'codex\n' ;;
    claude-*) printf 'claude\n' ;;
    *) printf '\n' ;;
  esac
}

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

new_fixture() {
  local name="$1"
  local root
  root="$(mktemp -d "/tmp/${name}.XXXXXX")"
  local wt_dir="$root/worktree"
  local feature_dir="$wt_dir/features/test-slug"
  local state_file="$root/workflow-state.json"

  mkdir -p "$feature_dir"

  cat > "$feature_dir/.routing-complete" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "medium",
  "reviewMode": "static",
  "reviewRecommended": "static",
  "provenance": {
    "source": "bootstrap"
  }
}
EOF

  cat > "$feature_dir/.phase-config.json" <<'EOF'
{
  "planning": {
    "model": "bootstrap-planner",
    "agent": "claude",
    "depth": "light"
  },
  "coding": {
    "model": "bootstrap-coder",
    "agent": "claude",
    "depth": "medium"
  },
  "review": {
    "model": "bootstrap-reviewer",
    "agent": "claude",
    "mode": "static"
  },
  "resolvedAt": "2026-05-01T00:00:00Z",
  "forceModel": null
}
EOF

  cat > "$state_file" <<EOF
{
  "tasks": {
    "HOK-1512": {
      "slug": "test-slug",
      "worktree": "$wt_dir",
      "phase": "planning",
      "plannerModel": "bootstrap-planner",
      "coderModel": "bootstrap-coder",
      "reviewerModel": "bootstrap-reviewer",
      "planDepth": "light",
      "codeDepth": "medium",
      "reviewMode": "static"
    }
  }
}
EOF

  printf '%s\n%s\n%s\n' "$root" "$wt_dir" "$state_file"
}

run_apply() {
  local feature_dir="$1" state_file="$2"
  apply_expanded_route_if_present "$feature_dir" "HOK-1512" "test-slug" "$(dirname "$(dirname "$feature_dir")")" "$state_file"
}

echo "=== Expanded Route Apply Helper ==="

{
  mapfile -t fixture < <(new_fixture "expanded-route-valid")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  rm -f "$feature_dir/.initial-route.json"
  cp "$feature_dir/.routing-complete" "$root/bootstrap-route.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-4-6",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewRecommended": "static+llm",
  "cache_hit": true,
  "route_source": "cache",
  "packet_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "provenance": {
    "inputHash": "abc123"
  }
}
EOF

  if run_apply "$feature_dir" "$state_file"; then
    if [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.codeDepth' "$feature_dir/.routing-complete")" == "deep" ]] \
      && [[ "$(jq -r '.reviewMode' "$feature_dir/.routing-complete")" == "static+llm" ]] \
      && [[ "$(jq -r '.coding.model' "$feature_dir/.phase-config.json")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.review.mode' "$feature_dir/.phase-config.json")" == "static+llm" ]] \
      && [[ "$(jq -r '.tasks["HOK-1512"].coderModel' "$state_file")" == "gpt-5.4" ]] \
      && [[ "$(jq -r '.tasks["HOK-1512"].reviewMode' "$state_file")" == "static+llm" ]] \
      && [[ "$(jq -r '.cache_hit' "$feature_dir/.routing-complete")" == "true" ]] \
      && [[ "$(jq -r '.route_source' "$feature_dir/.routing-complete")" == "cache" ]] \
      && [[ "$(jq -r '.packet_hash' "$feature_dir/.routing-complete")" == "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ]] \
      && [[ "$(jq -r '.provenance.source' "$feature_dir/.routing-complete")" == "expanded" ]] \
      && cmp -s "$feature_dir/.initial-route.json" "$root/bootstrap-route.json"; then
      pass "valid post-expansion route updates execution state and preserves bootstrap snapshot"
    else
      fail "valid post-expansion route did not update expected fields"
    fi
  else
    fail "valid post-expansion route should apply successfully"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-precedence")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"post-coder","codeDepth":"deep","reviewer":"post-reviewer","reviewMode":"llm"}
EOF
  cat > "$feature_dir/.expanded-route.json" <<'EOF'
{"coder":"fallback-coder","codeDepth":"light","reviewer":"fallback-reviewer","reviewMode":"static"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "post-coder" ]]; then
    pass ".post-expansion-route.json takes precedence over .expanded-route.json"
  else
    fail "expanded route precedence is incorrect"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-fallback")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.expanded-route.json" <<'EOF'
{"coder":"fallback-coder","codeDepth":"light","reviewer":"fallback-reviewer","reviewMode":"static"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && [[ "$(jq -r '.coder' "$feature_dir/.routing-complete")" == "fallback-coder" ]]; then
    pass ".expanded-route.json applies when post-expansion route is absent"
  else
    fail "expanded-route fallback did not apply"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-missing")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cp "$feature_dir/.routing-complete" "$root/routing-before.json"
  cp "$feature_dir/.phase-config.json" "$root/phase-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"bad-coder","reviewMode":"llm"}
EOF

  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne 0 ]] \
    && grep -q 'expanded route invalid' <<< "$output" \
    && cmp -s "$feature_dir/.routing-complete" "$root/routing-before.json" \
    && cmp -s "$feature_dir/.phase-config.json" "$root/phase-before.json"; then
    pass "missing required fields fail closed without mutating execution state"
  else
    fail "missing-field expanded route did not fail closed"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-malformed")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cp "$feature_dir/.routing-complete" "$root/routing-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":
EOF

  set +e
  output="$(run_apply "$feature_dir" "$state_file" 2>&1)"
  status=$?
  set -e

  if [[ "$status" -ne 0 ]] \
    && grep -q 'expanded route invalid' <<< "$output" \
    && cmp -s "$feature_dir/.routing-complete" "$root/routing-before.json"; then
    pass "malformed JSON fails closed with warning"
  else
    fail "malformed expanded route did not fail closed"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-preserve-initial")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  printf '{"preserved":true}\n' > "$feature_dir/.initial-route.json"
  cp "$feature_dir/.initial-route.json" "$root/initial-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-4-6","reviewMode":"llm"}
EOF

  if run_apply "$feature_dir" "$state_file" \
    && cmp -s "$feature_dir/.initial-route.json" "$root/initial-before.json"; then
    pass "existing .initial-route.json remains unchanged"
  else
    fail "existing .initial-route.json was modified"
  fi
  rm -rf "$root"
}

{
  mapfile -t fixture < <(new_fixture "expanded-route-idempotent")
  root="${fixture[0]}"
  wt_dir="${fixture[1]}"
  state_file="${fixture[2]}"
  feature_dir="$wt_dir/features/test-slug"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-4-6","reviewRecommended":"llm"}
EOF

  if run_apply "$feature_dir" "$state_file"; then
    cp "$feature_dir/.phase-config.json" "$root/phase-after-first.json"
    cp "$feature_dir/.initial-route.json" "$root/initial-after-first.json"
    if run_apply "$feature_dir" "$state_file" \
      && cmp -s "$feature_dir/.phase-config.json" "$root/phase-after-first.json" \
      && cmp -s "$feature_dir/.initial-route.json" "$root/initial-after-first.json"; then
      pass "reapplying the same route is idempotent for phase config and initial route"
    else
      fail "reapplying the same route was not idempotent"
    fi
  else
    fail "initial idempotence apply should succeed"
  fi
  rm -rf "$root"
}

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
