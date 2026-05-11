#!/usr/bin/env bash
set -euo pipefail

# Headless mill lifecycle harness.
#
# This test runs one real controller tick at a time against a disposable git
# repository. It keeps the lifecycle/state-machine path real where the PR #294
# regression lived:
#
#   - monitor_issue_state()
#   - resolve_phase()
#   - approve_plan()
#   - validate_planning_phase_output()
#   - stage-result read/write helpers
#
# External boundaries are stubbed so the harness never launches agents, mutates
# tmux, calls gh, or updates Linear. The disposable worktree still uses real git
# status/diff behavior, real stage-result files, features/<slug>/ layout, and
# .wavemill runtime artifacts.
#
# To add a scenario:
#   1. Create a test_<scenario_name>() function.
#   2. Call harness_init_repo to create a disposable worktree.
#   3. Call harness_setup_planning_state with the desired stage status.
#   4. Add runtime/source artifacts needed by the scenario.
#   5. Call harness_run_tick, optionally passing extra setup code that overrides
#      a stub or extracted function inside the tick subshell.
#   6. Assert filesystem and emitted key/value state with check_* helpers.
#
# Run standalone:
#   bash tests/lifecycle-harness.test.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

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

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$name"
  else
    echo "    missing: $needle"
    fail "$name"
  fi
}

check_not_contains() {
  local name="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$name"
  else
    echo "    unexpected: $needle"
    fail "$name"
  fi
}

check_file_exists() {
  local name="$1" path="$2"
  if [[ -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

check_file_absent() {
  local name="$1" path="$2"
  if [[ ! -e "$path" ]]; then
    pass "$name"
  else
    fail "$name"
  fi
}

kv_value() {
  local output="$1" key="$2"
  awk -F= -v key="$key" '$1 == key { print substr($0, length(key) + 2); exit }' <<< "$output"
}

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

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

REAL_FUNC_FILE="$TEST_TMP/lifecycle-real-functions.sh"

harness_extract_real_functions() {
  local func
  : > "$REAL_FUNC_FILE"
  for func in \
    ready_stage_allows_merge \
    ready_stage_pending_verdict \
    log_ready_stale_merge_lane_once \
    monitor_issue_state \
    validate_planning_phase_output \
    planning_rejection_files_summary \
    write_planning_rejection_artifact \
    notify_planning_rejection_agent \
    handle_planning_overreach_rejection \
    validate_coding_phase_output \
    resolve_phase \
    approve_plan \
    write_stage_result \
    read_stage_status \
    read_stage_result \
    check_stage_complete \
    check_stage_awaiting_user \
    check_stage_aborted \
    phase_should_remain_active_without_pr \
    stage_result_is_in_progress \
    ready_conflict_launch_head \
    _persist_phase
  do
    local extracted
    extracted="$(extract_function "$MILL_SCRIPT" "$func")"
    if [[ -z "$extracted" ]]; then
      echo "Could not extract $func() from $MILL_SCRIPT" >&2
      exit 1
    fi
    printf '%s\n\n' "$extracted" >> "$REAL_FUNC_FILE"
  done
}

harness_init_repo() {
  local slug="$1"
  local repo
  repo="$TEST_TMP/$slug"
  mkdir -p "$repo"

  git -C "$repo" init -q
  git -C "$repo" config user.email "tests@example.com"
  git -C "$repo" config user.name "Wavemill Tests"
  git -C "$repo" checkout -q -b main

  mkdir -p "$repo/features/$slug"
  printf 'initial\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -q -m "Initial commit"

  printf '%s\n' "$repo"
}

harness_setup_planning_state() {
  local repo="$1" slug="$2" status="$3"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  printf '# Plan\n\nReady for approval.\n' > "$feature_dir/plan.md"
  touch "$feature_dir/.plan-approved"
  cat > "$feature_dir/.planning-result.json" <<EOF
{
  "stage": "planning",
  "status": "$status",
  "startedAt": "2026-04-15T00:00:00Z",
  "finishedAt": null,
  "agent": "codex",
  "model": "test-model",
  "notes": ""
}
EOF

  git -C "$repo" add "features/$slug/plan.md" "features/$slug/.plan-approved" "features/$slug/.planning-result.json"
  git -C "$repo" commit -q -m "Add planning state"
}

harness_setup_runtime_artifacts() {
  local repo="$1"
  mkdir -p "$repo/.wavemill/logs"
  printf '{"warning":"linear validation unavailable"}\n' > "$repo/.wavemill/logs/linear-validation-warnings.jsonl"
}

harness_seed_bootstrap_route() {
  local repo="$1" slug="$2"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  cat > "$feature_dir/.initial-route.json" <<'EOF'
{
  "planner": "bootstrap-planner",
  "coder": "bootstrap-coder",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "shallow",
  "reviewMode": "static",
  "provenance": {
    "source": "bootstrap"
  }
}
EOF

  cp "$feature_dir/.initial-route.json" "$feature_dir/.routing-complete"

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
    "depth": "shallow"
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
}

harness_common_route_overrides() {
  cat <<EOF
    FORCE_MODEL=""
    source "$REPO_DIR/shared/lib/wavemill-common.sh"
    read_state_value() { printf "%s\\n" "\${1-}"; }
    get_task_phase() { printf "%s\\n" "\$CURRENT_PHASE"; }
    set_task_phase() { CURRENT_PHASE="\$2"; }
    get_task_meta() { :; }
    save_task_state() { :; }
    log() {
      if [[ "\${1:-}" == "warn" ]]; then
        shift
        WARN_OUTPUT+="\$*\\n"
      else
        LOG_OUTPUT+="\$*\\n"
      fi
    }
    eval "\$(declare -f apply_expanded_route_if_present | sed '1s/apply_expanded_route_if_present/apply_expanded_route_if_present_real/')"
    apply_expanded_route_if_present() {
      APPLY_CALLED="true"
      apply_expanded_route_if_present_real "\$@"
    }
    eval "\$(declare -f mill_check_expansion_handshake | sed '1s/mill_check_expansion_handshake/mill_check_expansion_handshake_real/')"
    mill_check_expansion_handshake() {
      HANDSHAKE_CALLED="true"
      mill_check_expansion_handshake_real "\$@"
    }
    eval "\$(declare -f mill_expansion_handshake_reason | sed '1s/mill_expansion_handshake_reason/mill_expansion_handshake_reason_real/')"
    mill_expansion_handshake_reason() {
      mill_expansion_handshake_reason_real "\$@"
    }
    read_phase_config() {
      local feature_dir="\$1" stage="\$2" field="\$3"
      jq -r --arg stage "\$stage" --arg field "\$field" '.[\$stage][\$field] // ""' "\$feature_dir/.phase-config.json" 2>/dev/null || true
    }
EOF
}

harness_read_stage_status() {
  local repo="$1" slug="$2" stage="$3"
  jq -r '.status // empty' "$repo/features/$slug/.${stage}-result.json" 2>/dev/null || true
}

harness_run_tick() {
  local repo="$1" slug="$2" issue="$3" extra_setup="${4:-}"
  local tick_setup_file="$TEST_TMP/${issue}-${slug}-extra-$$.sh"
  printf '%s\n' "$extra_setup" > "$tick_setup_file"

  REPO_UNDER_TEST="$repo" \
  TEST_SLUG="$slug" \
  TEST_ISSUE="$issue" \
  REAL_FUNC_FILE="$REAL_FUNC_FILE" \
  EXTRA_SETUP_FILE="$tick_setup_file" \
  env -u npm_config_prefix bash -lc '
    set -euo pipefail
    source "$REAL_FUNC_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()

    ISSUE="$TEST_ISSUE"
    SLUG="$TEST_SLUG"
    BRANCH="task/$SLUG"
    WORKTREE_ROOT="$(dirname "$REPO_UNDER_TEST")"
    REPO_DIR="$REPO_UNDER_TEST"
    SESSION="lifecycle-harness"
    BASE_BRANCH="main"
    AGENT_CMD="codex"
    STATE_FILE="$REPO_UNDER_TEST/.wavemill/state.json"
    API_TIMEOUT=1
    AUTO_EVAL="false"
    REQUIRE_CONFIRM="false"
    QUIT_REQUESTED="false"
    FORCE_MODEL="test-model"
    CURRENT_PHASE="planning"
    CURRENT_AGENT="codex"
    CODING_LAUNCHED="false"
    CODING_MODEL=""
    CODING_AGENT=""
    CODING_DEPTH=""
    PLANNING_LAUNCHED="false"
    REROUTE_CALLED="false"
    APPLY_CALLED="false"
    HANDSHAKE_CALLED="false"
    CHALLENGE_REFRESH_CALLED="false"
    ACTIVE_COUNT=0
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    ATTENTION_STATE=""

    active_count=0
    BRANCH_BY_ISSUE["$ISSUE"]="$BRANCH"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    mkdir -p "$REPO_UNDER_TEST/.wavemill"
    printf "{\"title\":\"Lifecycle Harness\"}\n" > "/tmp/${SESSION}-${ISSUE}-issue.json"

    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }
    log_error() { WARN_OUTPUT+="$*\n"; }
    set_window_attention_state() { ATTENTION_STATE="$2"; }
    _pane_is_dead_or_idle() { return 0; }
    _ensure_window_exists() { :; }
    tmux() { return 1; }
    sleep() { :; }
    cleanup_completed_task() { :; }
    execute() { "$@" 2>/dev/null || true; }
    _with_timeout() { shift; "$@"; }
    gh() { return 1; }
    find_pr_for_branch() { return 0; }
    check_pr_exists() { return 1; }
    pr_state() { printf "%s\n" "OPEN"; }
    validate_pr_merge() { return 1; }
    should_update_linear_state() { return 1; }
    linear_set_state() { :; }
    linear_is_completed() { return 1; }
    get_linear_issue_id() { printf "%s\n" "$ISSUE"; }
    get_task_meta() { :; }
    save_task_state() { :; }
    read_state_value() { printf "%s\n" "${1-}"; }
    get_task_phase() { printf "%s\n" "$CURRENT_PHASE"; }
    set_task_phase() { CURRENT_PHASE="$2"; }
    resolve_phase_model() { printf "%s\n" "${2:-${3:-test-model}}"; }
    agent_resolve_from_model() { printf "%s\n" "codex"; }
    read_phase_config() {
      case "${2:-}.${3:-}" in
        coding.model) printf "%s\n" "test-model" ;;
        coding.depth) printf "%s\n" "medium" ;;
        review.model) printf "%s\n" "test-model" ;;
        review.mode) printf "%s\n" "static" ;;
        *) printf "\n" ;;
      esac
    }
    write_phase_config() { :; }
    handle_agent_error_recovery() { :; }
    handle_phase_launch_result() { return 0; }
    launch_planning_phase() { PLANNING_LAUNCHED="true"; return 0; }
    launch_coding_phase() {
      CODING_LAUNCHED="true"
      CODING_MODEL="${7:-}"
      CODING_AGENT="${8:-}"
      CODING_DEPTH="${9:-}"
      return 0
    }
    launch_review_phase() { return 0; }
    launch_ready_phase() { return 0; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    ready_base_sha() { printf "\n"; }
    ready_remediation_launch_head() { printf "\n"; }
    ready_remediation_attempts() { printf "%s\n" "0"; }
    write_ready_attention_file() { :; }
    emit_execution_active_route() { :; }
    log_route_lifecycle() { :; }
    route_lifecycle_route_id() { :; }
    reroute_expanded_packets_for_coding_handoff() { REROUTE_CALLED="true"; return 0; }
    apply_expanded_route_if_present() { APPLY_CALLED="true"; return 0; }
    mill_expansion_handshake_reason() { printf "%s\n" "already-expanded"; }
    get_expansion_handshake_policy() { printf "%s\n" "recover"; }
    recover_missing_expansion_artifact() { return 1; }
    mill_check_expansion_handshake() { HANDSHAKE_CALLED="true"; return 0; }
    restore_review_task_window() { return 0; }
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
    check_routing_complete() { return 1; }
    merge_queue_enabled() { return 1; }
    ready_queue_state() { printf "\n"; }
    mark_ready_stale() { :; }
    ready_candidate_selected() { return 1; }
    is_challenge_task() { return 1; }
    maybe_run_challenge_eval() { :; }
    maybe_run_challenge_comparison() { :; }
    get_challenge_sibling_pr() { :; }
    check_challenge_sibling_merged() { return 1; }
    save_migration_reservation() { :; }
    should_cleanup_closed_pr() { return 1; }
    transient_error_recovery_pending() { return 1; }
    codex_has_pending_approval() { return 1; }
    launch_background_post_merge_eval() { :; }

    # Scenario-specific function overrides must run after default stubs and
    # extracted real functions are loaded.
    source "$EXTRA_SETUP_FILE"

    monitor_issue_state "$ISSUE"

    printf "phase=%s\n" "$CURRENT_PHASE"
    printf "planning_status=%s\n" "$(read_stage_status "$REPO_UNDER_TEST/features/$SLUG" planning)"
    printf "coding_status=%s\n" "$(read_stage_status "$REPO_UNDER_TEST/features/$SLUG" coding)"
    printf "coding_launched=%s\n" "$CODING_LAUNCHED"
    printf "coding_model=%s\n" "$CODING_MODEL"
    printf "coding_agent=%s\n" "$CODING_AGENT"
    printf "coding_depth=%s\n" "$CODING_DEPTH"
    printf "planning_launched=%s\n" "$PLANNING_LAUNCHED"
    printf "reroute_called=%s\n" "$REROUTE_CALLED"
    printf "apply_called=%s\n" "$APPLY_CALLED"
    printf "handshake_called=%s\n" "$HANDSHAKE_CALLED"
    printf "challenge_refresh_called=%s\n" "$CHALLENGE_REFRESH_CALLED"
    printf "attention=%s\n" "$ATTENTION_STATE"
    printf "active_count=%s\n" "$active_count"
    printf "warn_output=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" "|")"
  '
}

test_positive_handoff_two_ticks() {
  local slug="planning-approval-positive"
  local issue="HOK-1293-POS"
  local repo tick1 tick2
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "tick 1: planning transitions to completed" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "tick 1: .plan-approved preserved" "$repo/features/$slug/.plan-approved"
  check_eq "tick 1: no coding launch yet" "false" "$(kv_value "$tick1" coding_launched)"
  check_eq "tick 1: no source-overreach warning" "" "$(kv_value "$tick1" warn_output)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "tick 2: controller phase becomes coding" "coding" "$(kv_value "$tick2" phase)"
  check_eq "tick 2: coding stage becomes running" "running" "$(harness_read_stage_status "$repo" "$slug" coding)"
  check_eq "tick 2: coding launch stub invoked" "true" "$(kv_value "$tick2" coding_launched)"
  check_file_exists "tick 2: .plan-approved still preserved" "$repo/features/$slug/.plan-approved"
  check_eq "tick 2: no source-overreach warning" "" "$(kv_value "$tick2" warn_output)"
}

test_source_edit_blocks_handoff() {
  local slug="planning-source-overreach"
  local issue="HOK-1293-NEG"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  mkdir -p "$repo/shared/lib"
  printf 'export const bad = true;\n' > "$repo/shared/lib/foo.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "negative: planning stays awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "negative: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_file_absent "negative: overreach file cleaned up" "$repo/shared/lib/foo.ts"
  check_file_exists "negative: planning rejection artifact written" "$repo/features/$slug/.planning-rejected.json"
  check_eq "negative: planning rejection reason recorded" "planning_modified_out_of_scope_files" "$(jq -r '.reason' "$repo/features/$slug/.planning-rejected.json")"
  check_eq "negative: planning rejection file recorded" "shared/lib/foo.ts" "$(jq -r '.outOfScopeFiles[0]' "$repo/features/$slug/.planning-rejected.json")"
  check_contains "negative: source-overreach warning emitted" "$(kv_value "$tick" warn_output)" "source code"
  check_contains "negative: source-overreach attention emitted" "$(kv_value "$tick" warn_output)" "needs attention"
  check_eq "negative: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_regression_without_wavemill_allowance() {
  local slug="planning-wavemill-regression"
  local issue="HOK-1293-REG"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    validate_planning_phase_output() {
      local wt_dir="$1"
      local feature_dir="$wt_dir/features/$(basename "$wt_dir")"
      local changed_file
      local -a out_of_scope_files=()
      local -a tracked_out_of_scope=()
      local -a untracked_out_of_scope=()

      [[ -d "$wt_dir/.git" || -f "$wt_dir/.git" ]] || return 0

      while IFS= read -r changed_file; do
        [[ -n "$changed_file" ]] || continue
        case "$changed_file" in
          features/*) ;;
          *)
            out_of_scope_files+=("$changed_file")
            if git -C "$wt_dir" ls-files --error-unmatch -- "$changed_file" >/dev/null 2>&1; then
              tracked_out_of_scope+=("$changed_file")
            else
              untracked_out_of_scope+=("$changed_file")
            fi
            ;;
        esac
      done < <(
        {
          git -C "$wt_dir" diff --name-only HEAD -- 2>/dev/null || true
          git -C "$wt_dir" ls-files --others --exclude-standard 2>/dev/null || true
        } | sort -u
      )

      if [[ ${#out_of_scope_files[@]} -eq 0 ]]; then
        return 0
      fi

      log_warn "WARNING: Planning phase modified source code files: ${out_of_scope_files[*]}"

      if [[ ${#tracked_out_of_scope[@]} -gt 0 ]]; then
        git -C "$wt_dir" reset -q HEAD -- "${tracked_out_of_scope[@]}" 2>/dev/null || true
        git -C "$wt_dir" checkout -- "${tracked_out_of_scope[@]}" 2>/dev/null || true
      fi

      if [[ ${#untracked_out_of_scope[@]} -gt 0 ]]; then
        rm -f -- "${untracked_out_of_scope[@]/#/$wt_dir/}" 2>/dev/null || true
      fi

      rm -f "$feature_dir/.plan-approved"
      return 1
    }
  ')"

  check_eq "regression: handoff blocked without .wavemill allowance" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "regression: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_contains "regression: wavemill artifact treated as overreach" "$(kv_value "$tick" warn_output)" ".wavemill/logs/linear-validation-warnings.jsonl"
  check_eq "regression: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_mixed_artifacts_source_edit_wins() {
  local slug="planning-mixed-artifacts"
  local issue="HOK-1293-MIX"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  mkdir -p "$repo/src"
  printf 'export const bad = true;\n' > "$repo/src/bad.ts"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "mixed: planning stays awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "mixed: .plan-approved removed" "$repo/features/$slug/.plan-approved"
  check_file_absent "mixed: source edit cleaned up" "$repo/src/bad.ts"
  check_contains "mixed: source edit appears in warning" "$(kv_value "$tick" warn_output)" "src/bad.ts"
  check_not_contains "mixed: wavemill artifact not treated as overreach" "$(kv_value "$tick" warn_output)" ".wavemill/logs/linear-validation-warnings.jsonl"
  check_eq "mixed: coding launch not invoked" "false" "$(kv_value "$tick" coding_launched)"
}

test_claude_local_settings_allowed() {
  local slug="planning-claude-local-settings"
  local issue="HOK-1293-CLAUDE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/.claude"
  printf '{}\n' > "$repo/.claude/settings.local.json"
  git -C "$repo" add ".claude/settings.local.json"
  git -C "$repo" commit -q -m "Track local Claude settings"

  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"hook.sh"}]}]}}\n' > "$repo/.claude/settings.local.json"

  tick="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "claude settings: planning transitions to completed" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_exists "claude settings: .plan-approved preserved" "$repo/features/$slug/.plan-approved"
  check_eq "claude settings: no coding launch on same tick" "false" "$(kv_value "$tick" coding_launched)"
  check_eq "claude settings: no overreach warning" "" "$(kv_value "$tick" warn_output)"
  check_contains "claude settings: tracked file remains modified" "$(git -C "$repo" status --short .claude/settings.local.json)" "M .claude/settings.local.json"
}

test_coding_uses_expanded_route_over_bootstrap() {
  local slug="expanded-route-wins"
  local issue="HOK-1516-WINS"
  local repo tick initial_before overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  initial_before="$(cat "$repo/features/$slug/.initial-route.json")"

  cat > "$repo/features/$slug/.post-expansion-route.json" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "gpt-5.4",
  "reviewer": "claude-sonnet-4-6",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded-test"
  }
}
EOF

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "expanded wins: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "expanded wins: coding model from expanded route" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "expanded wins: coding depth from expanded route" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "expanded wins: bootstrap model not launched" "false" "$([[ "$(kv_value "$tick" coding_model)" == "bootstrap-coder" ]] && printf true || printf false)"
  check_eq "expanded wins: routing provenance expanded" "expanded" "$(jq -r '.provenance.source' "$repo/features/$slug/.routing-complete")"
  check_eq "expanded wins: phase config model updated" "gpt-5.4" "$(jq -r '.coding.model' "$repo/features/$slug/.phase-config.json")"
  check_eq "expanded wins: phase config depth updated" "deep" "$(jq -r '.coding.depth' "$repo/features/$slug/.phase-config.json")"
  check_eq "expanded wins: initial route remains bootstrap-only" "$initial_before" "$(cat "$repo/features/$slug/.initial-route.json")"
}

test_missing_expansion_recovery_success_launches_with_expanded_route() {
  local slug="missing-expansion-recovery-success"
  local issue="HOK-1569-RECOVER-OK"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" slug=\"\$2\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      cat > \"\$feature_dir/task-packet.md\" <<'EOF'
## 1. Objective

Recover the missing expanded routing artifact.
EOF
      cat > \"\$feature_dir/.post-expansion-route.json\" <<'EOF'
{
  \"planner\": \"expanded-planner\",
  \"coder\": \"gpt-5.4\",
  \"reviewer\": \"claude-sonnet-4-6\",
  \"planDepth\": \"deep\",
  \"codeDepth\": \"deep\",
  \"reviewMode\": \"static+llm\",
  \"provenance\": {
    \"source\": \"expanded-test\"
  }
}
EOF
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"succeeded\" \"stub-success\" \"0\"
      return 0
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover ok: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "recover ok: coding model from expanded route" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "recover ok: coding depth from expanded route" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "recover ok: routing provenance expanded" "expanded" "$(jq -r '.provenance.source' "$repo/features/$slug/.routing-complete")"
  check_eq "recover ok: recovery state succeeded" "succeeded" "$(jq -r '.status' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_eq "recover ok: recovery attempted once" "1" "$(cat "$repo/.wavemill/recovery-count")"
  check_not_contains "recover ok: no blocked warning" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
}

test_missing_expansion_recovery_failure_launches_with_bootstrap() {
  local slug="missing-expansion-recovery-failure"
  local issue="HOK-1569-RECOVER-FAIL"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      if expansion_recovery_already_attempted \"\$feature_dir\"; then
        log warn \"[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=\$issue\"
        return 1
      fi
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"failed\" \"stubbed-failure\" \"1\"
      log warn \"[expansion-handshake] RECOVERY_FAILED issue=\$issue detail=stubbed-failure\"
      return 1
    }
  "
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover fail: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "recover fail: coding model stays bootstrap" "bootstrap-coder" "$(kv_value "$tick" coding_model)"
  check_eq "recover fail: coding depth stays bootstrap" "shallow" "$(kv_value "$tick" coding_depth)"
  check_eq "recover fail: recovery state failed" "failed" "$(jq -r '.status' "$repo/features/$slug/.expansion-recovery-state.json")"
  check_file_exists "recover fail: plan approval preserved" "$repo/features/$slug/.plan-approved"
  check_contains "recover fail: warning includes recovery failure" "$(kv_value "$tick" warn_output)" "RECOVERY_FAILED"
  check_contains "recover fail: warning includes bootstrap fallback" "$(kv_value "$tick" warn_output)" "RECOVERY_FALLBACK_BOOTSTRAP"
}

test_missing_expansion_recovery_not_repeated() {
  local slug="missing-expansion-recovery-not-repeated"
  local issue="HOK-1569-RECOVER-ONCE"
  local repo tick1 tick2 overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"
  printf 'raw issue text\n' > "$repo/features/$slug/task-packet.md"

  overrides="$(harness_common_route_overrides)
    recover_missing_expansion_artifact() {
      local issue=\"\$1\" feature_dir=\"\$3\"
      local count_file=\"\$REPO_UNDER_TEST/.wavemill/recovery-count\"
      local count
      count=\$(cat \"\$count_file\" 2>/dev/null || echo 0)
      if expansion_recovery_already_attempted \"\$feature_dir\"; then
        log warn \"[expansion-handshake] RECOVERY_SKIPPED_ALREADY_ATTEMPTED issue=\$issue\"
        return 1
      fi
      printf '%s\n' \$((count + 1)) > \"\$count_file\"
      expansion_recovery_mark_attempted \"\$feature_dir\" \"\$issue\" \"missing\"
      expansion_recovery_mark_result \"\$feature_dir\" \"\$issue\" \"failed\" \"stubbed-failure\" \"1\"
      log warn \"[expansion-handshake] RECOVERY_FAILED issue=\$issue detail=stubbed-failure\"
      return 1
    }
  "
  tick1="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
  tick2="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "recover once: first tick launches coding" "true" "$(kv_value "$tick1" coding_launched)"
  check_eq "recover once: second tick also launches coding" "true" "$(kv_value "$tick2" coding_launched)"
  check_eq "recover once: helper invoked only once" "1" "$(cat "$repo/.wavemill/recovery-count")"
  check_contains "recover once: second tick reports skip" "$(kv_value "$tick2" warn_output)" "RECOVERY_SKIPPED_ALREADY_ATTEMPTED"
}

test_invalid_expanded_route_blocks_lifecycle_handoff() {
  local case_name route_json slug issue repo tick feature_dir note overrides

  for case_name in malformed missing-fields; do
    slug="invalid-expanded-route-$case_name"
    issue="HOK-1516-INVALID-$case_name"
    repo="$(harness_init_repo "$slug")"
    harness_setup_planning_state "$repo" "$slug" "completed"
    harness_setup_runtime_artifacts "$repo"
    harness_seed_bootstrap_route "$repo" "$slug"
    feature_dir="$repo/features/$slug"
    cp "$feature_dir/.routing-complete" "$TEST_TMP/$slug-routing-before.json"
    cp "$feature_dir/.phase-config.json" "$TEST_TMP/$slug-phase-before.json"

    if [[ "$case_name" == "malformed" ]]; then
      printf '{"coder":\n' > "$feature_dir/.post-expansion-route.json"
    else
      cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"gpt-5.4","reviewMode":"static+llm"}
EOF
    fi

    overrides="$(harness_common_route_overrides)"
    tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"
    note="$(jq -r '.notes // empty' "$feature_dir/.planning-result.json")"

    check_eq "invalid $case_name: coding does not launch" "false" "$(kv_value "$tick" coding_launched)"
    check_file_absent "invalid $case_name: plan approval removed" "$feature_dir/.plan-approved"
    check_eq "invalid $case_name: planning awaits user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
    check_contains "invalid $case_name: planning note names handshake" "$note" "Expansion handshake blocked"
    check_contains "invalid $case_name: warning reports block" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
    check_file_absent "invalid $case_name: no recovery state written" "$feature_dir/.expansion-recovery-state.json"
    if cmp -s "$feature_dir/.routing-complete" "$TEST_TMP/$slug-routing-before.json" \
      && cmp -s "$feature_dir/.phase-config.json" "$TEST_TMP/$slug-phase-before.json"; then
      pass "invalid $case_name: route artifacts unchanged"
    else
      fail "invalid $case_name: route artifacts changed"
    fi
  done
}

test_already_expanded_packet_skips_mandatory_expansion() {
  local slug="already-expanded-packet"
  local issue="HOK-1516-PACKET"
  local repo tick overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"

  cat > "$repo/features/$slug/task-packet.md" <<'EOF'
## 1. Objective

Implement the deterministic test fixture.
EOF
  cat > "$repo/features/$slug/.routing-complete" <<'EOF'
{"coder":"packet-coder","codeDepth":"deep","reviewer":"packet-reviewer","reviewMode":"static","provenance":{"source":"expanded"}}
EOF
  cat > "$repo/features/$slug/.phase-config.json" <<'EOF'
{
  "coding": {
    "model": "packet-coder",
    "agent": "codex",
    "depth": "deep"
  },
  "review": {
    "model": "packet-reviewer",
    "agent": "claude",
    "mode": "static"
  }
}
EOF

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "already-expanded: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "already-expanded: handshake checked" "true" "$(kv_value "$tick" handshake_called)"
  check_eq "already-expanded: model from phase config" "packet-coder" "$(kv_value "$tick" coding_model)"
  check_eq "already-expanded: depth from phase config" "deep" "$(kv_value "$tick" coding_depth)"
  check_not_contains "already-expanded: no mandatory expansion block" "$(kv_value "$tick" warn_output)" "[expansion-handshake] BLOCKED"
  check_file_absent "already-expanded: no expansion sentinel" "$repo/features/$slug/.expanded-route-command-invoked"
}

test_resume_uses_expanded_phase_config_over_stale_state() {
  local slug="resume-expanded-route"
  local issue="HOK-1516-RESUME"
  local repo tick initial_before routing_before phase_before overrides
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "completed"
  harness_setup_runtime_artifacts "$repo"
  harness_seed_bootstrap_route "$repo" "$slug"

  cat > "$repo/features/$slug/task-packet.md" <<'EOF'
## 1. Objective

Resume from expanded lifecycle artifacts.
EOF
  cat > "$repo/features/$slug/.routing-complete" <<'EOF'
{"coder":"gpt-5.4","codeDepth":"deep","reviewer":"claude-sonnet-4-6","reviewMode":"static+llm","provenance":{"source":"expanded"}}
EOF
  cat > "$repo/features/$slug/.phase-config.json" <<'EOF'
{
  "coding": {
    "model": "gpt-5.4",
    "agent": "codex",
    "depth": "deep"
  },
  "review": {
    "model": "claude-sonnet-4-6",
    "agent": "claude",
    "mode": "static+llm"
  }
}
EOF
  initial_before="$(cat "$repo/features/$slug/.initial-route.json")"
  routing_before="$(cat "$repo/features/$slug/.routing-complete")"
  phase_before="$(cat "$repo/features/$slug/.phase-config.json")"

  overrides="$(harness_common_route_overrides)"
  tick="$(harness_run_tick "$repo" "$slug" "$issue" "$overrides")"

  check_eq "resume: coding launches" "true" "$(kv_value "$tick" coding_launched)"
  check_eq "resume: model from phase config" "gpt-5.4" "$(kv_value "$tick" coding_model)"
  check_eq "resume: depth from phase config" "deep" "$(kv_value "$tick" coding_depth)"
  check_eq "resume: stale bootstrap model not used" "false" "$([[ "$(kv_value "$tick" coding_model)" == "bootstrap-coder" ]] && printf true || printf false)"
  check_eq "resume: initial route unchanged" "$initial_before" "$(cat "$repo/features/$slug/.initial-route.json")"
  check_eq "resume: routing artifact unchanged" "$routing_before" "$(cat "$repo/features/$slug/.routing-complete")"
  check_eq "resume: phase config unchanged" "$phase_before" "$(cat "$repo/features/$slug/.phase-config.json")"
}

test_merge_queue_marks_non_candidate_stale_without_rerun() {
  local slug="merge-queue-stale"
  local issue="HOK-1580-STALE"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-old"
  }
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="501"
    get_main_head_sha() { printf "%s\n" "sha-new"; }
    merge_queue_enabled() { return 0; }
    ready_queue_state() { printf "%s\n" "ready"; }
    mark_ready_stale() { printf "%s\n" "marked" > "$REPO_UNDER_TEST/.wavemill/marked"; }
    launch_ready_phase() { printf "%s\n" "launched" > "$REPO_UNDER_TEST/.wavemill/launched"; return 0; }
  ')"

  check_file_exists "merge queue stale: non-candidate marked stale" "$repo/.wavemill/marked"
  check_file_absent "merge queue stale: non-candidate did not rerun ready" "$repo/.wavemill/launched"
  check_eq "merge queue stale: task remains active" "1" "$(kv_value "$tick" active_count)"
  check_eq "merge queue stale: attention remains clear" "clear" "$(kv_value "$tick" attention)"
}

test_merge_queue_disabled_keeps_legacy_rerun() {
  local slug="merge-queue-disabled"
  local issue="HOK-1580-DISABLED"
  local repo tick
  repo="$(harness_init_repo "$slug")"
  mkdir -p "$repo/features/$slug/ready"
  cat > "$repo/features/$slug/ready/.ready-result.json" <<'EOF'
{
  "stage": "ready",
  "status": "completed",
  "artifacts": {
    "type": "ready",
    "verdict": "pass",
    "readyBaseSha": "sha-old"
  }
}
EOF

  tick="$(harness_run_tick "$repo" "$slug" "$issue" '
    CURRENT_PHASE="ready"
    PR_BY_ISSUE["$ISSUE"]="502"
    get_main_head_sha() { printf "%s\n" "sha-new"; }
    merge_queue_enabled() { return 1; }
    launch_ready_phase() { printf "%s\n" "launched" > "$REPO_UNDER_TEST/.wavemill/launched"; return 0; }
  ')"

  check_file_exists "merge queue disabled: legacy rerun still launches" "$repo/.wavemill/launched"
  check_eq "merge queue disabled: task remains active" "1" "$(kv_value "$tick" active_count)"
}

echo "=== Mill Lifecycle: Planning to Coding Handoff ==="
harness_extract_real_functions

test_positive_handoff_two_ticks
test_source_edit_blocks_handoff
test_regression_without_wavemill_allowance
test_mixed_artifacts_source_edit_wins
test_claude_local_settings_allowed
test_coding_uses_expanded_route_over_bootstrap
test_missing_expansion_recovery_success_launches_with_expanded_route
test_missing_expansion_recovery_failure_launches_with_bootstrap
test_missing_expansion_recovery_not_repeated
test_invalid_expanded_route_blocks_lifecycle_handoff
test_already_expanded_packet_skips_mandatory_expansion
test_resume_uses_expanded_phase_config_over_stale_state
test_merge_queue_marks_non_candidate_stale_without_rerun
test_merge_queue_disabled_keeps_legacy_rerun

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS lifecycle harness tests passed"
else
  echo "$FAIL lifecycle harness tests failed ($PASS passed)"
  exit 1
fi
