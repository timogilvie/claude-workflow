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
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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
  local source_file func
  : > "$REAL_FUNC_FILE"
  while IFS='|' read -r source_file func; do
    local extracted
    extracted="$(extract_function "$source_file" "$func")"
    if [[ -z "$extracted" ]]; then
      echo "Could not extract $func() from $source_file" >&2
      exit 1
    fi
    printf '%s\n\n' "$extracted" >> "$REAL_FUNC_FILE"
  done <<EOF
$MILL_SCRIPT|ready_stage_allows_merge
$MILL_SCRIPT|ready_stage_pending_verdict
$MILL_SCRIPT|monitor_issue_state
$MILL_SCRIPT|validate_planning_phase_output
$MILL_SCRIPT|validate_coding_phase_output
$MILL_SCRIPT|resolve_phase
$MILL_SCRIPT|approve_plan
$MILL_SCRIPT|write_stage_result
$MILL_SCRIPT|read_stage_status
$MILL_SCRIPT|read_stage_result
$MILL_SCRIPT|check_stage_complete
$MILL_SCRIPT|check_stage_awaiting_user
$MILL_SCRIPT|check_stage_aborted
$MILL_SCRIPT|phase_should_remain_active_without_pr
$MILL_SCRIPT|stage_result_is_in_progress
$MILL_SCRIPT|ready_conflict_launch_head
$MILL_SCRIPT|_persist_phase
$MILL_SCRIPT|read_phase_config
$MILL_SCRIPT|_restore_inflight_task_window_if_missing
$COMMON_SCRIPT|route_read_field
$COMMON_SCRIPT|write_json_artifact
$COMMON_SCRIPT|find_expanded_route_artifact
$COMMON_SCRIPT|validate_expanded_route_artifact
$COMMON_SCRIPT|ensure_phase_config_state_file
$COMMON_SCRIPT|apply_expanded_route_if_present
$COMMON_SCRIPT|mill_check_expansion_handshake
$COMMON_SCRIPT|is_task_packet
$COMMON_SCRIPT|state_mutate
EOF
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

harness_setup_route_artifacts() {
  local repo="$1" slug="$2" bootstrap_coder="$3" bootstrap_depth="$4" expanded_coder="$5" expanded_depth="$6"
  local feature_dir="$repo/features/$slug"
  mkdir -p "$feature_dir"

  cat > "$feature_dir/task-packet.md" <<'EOF'
Raw issue text that still requires expansion routing.
EOF

  cat > "$feature_dir/.routing-complete" <<EOF
{
  "planner": "bootstrap-planner",
  "coder": "$bootstrap_coder",
  "reviewer": "bootstrap-reviewer",
  "planDepth": "light",
  "codeDepth": "$bootstrap_depth",
  "reviewMode": "static",
  "reviewRecommended": "static",
  "provenance": {
    "source": "bootstrap"
  }
}
EOF
  cp "$feature_dir/.routing-complete" "$feature_dir/.initial-route.json"

  cat > "$feature_dir/.phase-config.json" <<EOF
{
  "planning": {
    "model": "bootstrap-planner",
    "agent": "claude",
    "depth": "light"
  },
  "coding": {
    "model": "$bootstrap_coder",
    "agent": "claude",
    "depth": "$bootstrap_depth"
  },
  "review": {
    "model": "bootstrap-reviewer",
    "agent": "claude",
    "mode": "static"
  },
  "resolvedAt": "2026-04-15T00:00:00Z",
  "forceModel": null
}
EOF

  cat > "$feature_dir/.post-expansion-route.json" <<EOF
{
  "planner": "expanded-planner",
  "coder": "$expanded_coder",
  "reviewer": "expanded-reviewer",
  "planDepth": "deep",
  "codeDepth": "$expanded_depth",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded"
  }
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
  HARNESS_REPO_DIR="$REPO_DIR" \
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
    CODING_LAUNCH_ARGS=""
    PLANNING_LAUNCHED="false"
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
      CODING_LAUNCH_ARGS="$*"
      return 0
    }
    launch_review_phase() { return 0; }
    launch_ready_phase() { return 0; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    write_ready_attention_file() { :; }
    reroute_expanded_packets_for_coding_handoff() { return 0; }
    apply_expanded_route_if_present() { return 0; }
    mill_check_expansion_handshake() { return 0; }
    restore_review_task_window() { return 0; }
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
    check_routing_complete() { return 1; }
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
    printf "coding_launch_args=%s\n" "$CODING_LAUNCH_ARGS"
    printf "planning_launched=%s\n" "$PLANNING_LAUNCHED"
    printf "attention=%s\n" "$ATTENTION_STATE"
    printf "active_count=%s\n" "$active_count"
    printf "warn_output=%s\n" "$(printf "%s" "$WARN_OUTPUT" | tr "\n" "|")"
  '
}

harness_run_restore() {
  local repo="$1" slug="$2" issue="$3" phase="$4" extra_setup="${5:-}"
  local restore_setup_file="$TEST_TMP/${issue}-${slug}-${phase}-restore-$$.sh"
  printf '%s\n' "$extra_setup" > "$restore_setup_file"

  REPO_UNDER_TEST="$repo" \
  TEST_SLUG="$slug" \
  TEST_ISSUE="$issue" \
  TEST_PHASE="$phase" \
  REAL_FUNC_FILE="$REAL_FUNC_FILE" \
  EXTRA_SETUP_FILE="$restore_setup_file" \
  env -u npm_config_prefix bash -lc '
    set -euo pipefail
    source "$REAL_FUNC_FILE"

    ISSUE="$TEST_ISSUE"
    SLUG="$TEST_SLUG"
    PHASE="$TEST_PHASE"
    BRANCH="task/$SLUG"
    WORKTREE_ROOT="$(dirname "$REPO_UNDER_TEST")"
    REPO_DIR="$REPO_UNDER_TEST"
    SESSION="lifecycle-harness"
    BASE_BRANCH="main"
    STATE_FILE="$REPO_UNDER_TEST/.wavemill/state.json"
    FORCE_MODEL=""
    CODING_LAUNCHED="false"
    CODING_LAUNCH_ARGS=""
    _RESTORE_STATE=""

    mkdir -p "$REPO_UNDER_TEST/.wavemill"
    printf "{\"title\":\"Lifecycle Harness\"}\n" > "/tmp/${SESSION}-${ISSUE}-issue.json"

    log() { :; }
    log_warn() { :; }
    log_error() { :; }
    tmux() { return 1; }
    sleep() { :; }
    read_state_value() { printf "%s\n" "${1-}"; }
    get_task_meta() { :; }
    resolve_phase_model() { printf "%s\n" "${2:-${3:-test-model}}"; }
    agent_resolve_from_model() { printf "%s\n" "codex"; }
    launch_planning_phase() { return 0; }
    launch_coding_phase() {
      CODING_LAUNCHED="true"
      CODING_LAUNCH_ARGS="$*"
      return 0
    }
    reroute_expanded_packets_for_coding_handoff() { return 0; }
    source "$EXTRA_SETUP_FILE"

    _restore_inflight_task_window_if_missing "$ISSUE" "$SLUG" "$BRANCH" "$PHASE"

    printf "restore_state=%s\n" "$_RESTORE_STATE"
    printf "coding_launched=%s\n" "$CODING_LAUNCHED"
    printf "coding_launch_args=%s\n" "$CODING_LAUNCH_ARGS"
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
  check_contains "negative: source-overreach warning emitted" "$(kv_value "$tick" warn_output)" "source code"
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

test_expanded_route_handoff_uses_authoritative_route() {
  local slug="expanded-route-authoritative"
  local issue="HOK-1516-ROUTE"
  local repo tick1 tick2 feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_route_artifacts "$repo" "$slug" "bootstrap-coder" "medium" "expanded-coder" "deep"
  feature_dir="$repo/features/$slug"
  cp "$feature_dir/.initial-route.json" "$TEST_TMP/${slug}-initial.json"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "expanded route tick 1: planning completes" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_eq "expanded route tick 1: coding not launched yet" "false" "$(kv_value "$tick1" coding_launched)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" '
    source "$REAL_FUNC_FILE"
    FORCE_MODEL=""
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
  ')"
  check_eq "expanded route tick 2: coding launched" "true" "$(kv_value "$tick2" coding_launched)"
  check_contains "expanded route tick 2: launch uses expanded coder" "$(kv_value "$tick2" coding_launch_args)" "expanded-coder"
  check_contains "expanded route tick 2: launch uses expanded depth" "$(kv_value "$tick2" coding_launch_args)" " deep"
  check_eq "expanded route tick 2: routing-complete coder promoted" "expanded-coder" "$(jq -r '.coder' "$feature_dir/.routing-complete")"
  check_eq "expanded route tick 2: routing-complete depth promoted" "deep" "$(jq -r '.codeDepth' "$feature_dir/.routing-complete")"
  check_eq "expanded route tick 2: phase-config coding model promoted" "expanded-coder" "$(jq -r '.coding.model' "$feature_dir/.phase-config.json")"
  check_eq "expanded route tick 2: phase-config coding depth promoted" "deep" "$(jq -r '.coding.depth' "$feature_dir/.phase-config.json")"
  check_eq "expanded route tick 2: review mode promoted" "static+llm" "$(jq -r '.review.mode' "$feature_dir/.phase-config.json")"
  if cmp -s "$feature_dir/.initial-route.json" "$TEST_TMP/${slug}-initial.json"; then
    pass "expanded route tick 2: initial-route remains bootstrap-only"
  else
    fail "expanded route tick 2: initial-route changed after promotion"
  fi
}

test_invalid_expanded_route_blocks_without_bootstrap_leak() {
  local slug="expanded-route-invalid"
  local issue="HOK-1516-INVALID"
  local repo tick1 tick2 feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_route_artifacts "$repo" "$slug" "bootstrap-coder" "medium" "expanded-coder" "deep"
  feature_dir="$repo/features/$slug"
  cp "$feature_dir/.routing-complete" "$TEST_TMP/${slug}-routing-before.json"
  cp "$feature_dir/.phase-config.json" "$TEST_TMP/${slug}-phase-before.json"
  cat > "$feature_dir/.post-expansion-route.json" <<'EOF'
{"coder":"expanded-coder","reviewMode":"static+llm"}
EOF

  tick1="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "invalid route tick 1: planning completes" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" '
    source "$REAL_FUNC_FILE"
    FORCE_MODEL=""
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
  ')"
  check_eq "invalid route tick 2: coding blocked" "false" "$(kv_value "$tick2" coding_launched)"
  check_eq "invalid route tick 2: planning reset to awaiting_user" "awaiting_user" "$(harness_read_stage_status "$repo" "$slug" planning)"
  check_file_absent "invalid route tick 2: plan approval removed" "$feature_dir/.plan-approved"
  check_contains "invalid route tick 2: invalid route warning emitted" "$(kv_value "$tick2" warn_output)" "expanded route invalid"
  if cmp -s "$feature_dir/.routing-complete" "$TEST_TMP/${slug}-routing-before.json"; then
    pass "invalid route tick 2: routing-complete stays bootstrap"
  else
    fail "invalid route tick 2: routing-complete mutated from invalid expanded route"
  fi
  if cmp -s "$feature_dir/.phase-config.json" "$TEST_TMP/${slug}-phase-before.json"; then
    pass "invalid route tick 2: phase-config stays bootstrap"
  else
    fail "invalid route tick 2: phase-config mutated from invalid expanded route"
  fi
}

test_already_expanded_packet_skips_mandatory_expansion_gate() {
  local slug="expanded-packet-authoritative"
  local issue="HOK-1516-PACKET"
  local repo tick1 tick2 feature_dir
  repo="$(harness_init_repo "$slug")"
  harness_setup_planning_state "$repo" "$slug" "awaiting_user"
  harness_setup_runtime_artifacts "$repo"
  feature_dir="$repo/features/$slug"

  cat > "$feature_dir/task-packet.md" <<'EOF'
## 1. Objective
Use the already-expanded packet as the authoritative input.
EOF
  cat > "$feature_dir/.routing-complete" <<'EOF'
{
  "planner": "expanded-planner",
  "coder": "expanded-packet-coder",
  "reviewer": "expanded-reviewer",
  "planDepth": "deep",
  "codeDepth": "deep",
  "reviewMode": "static+llm",
  "provenance": {
    "source": "expanded"
  }
}
EOF
  cp "$feature_dir/.routing-complete" "$feature_dir/.initial-route.json"
  cat > "$feature_dir/.phase-config.json" <<'EOF'
{
  "planning": {
    "model": "expanded-planner",
    "agent": "codex",
    "depth": "deep"
  },
  "coding": {
    "model": "expanded-packet-coder",
    "agent": "codex",
    "depth": "deep"
  },
  "review": {
    "model": "expanded-reviewer",
    "agent": "codex",
    "mode": "static+llm"
  },
  "resolvedAt": "2026-04-15T00:00:00Z",
  "forceModel": null
}
EOF
  rm -f "$feature_dir/.post-expansion-route.json"

  tick1="$(harness_run_tick "$repo" "$slug" "$issue")"
  check_eq "expanded packet tick 1: planning completes" "completed" "$(harness_read_stage_status "$repo" "$slug" planning)"

  tick2="$(harness_run_tick "$repo" "$slug" "$issue" '
    source "$REAL_FUNC_FILE"
    FORCE_MODEL=""
    _restore_inflight_task_window_if_missing() { _RESTORE_STATE="none"; return 0; }
    reroute_expanded_packets_for_coding_handoff() { return 1; }
  ')"
  check_eq "expanded packet tick 2: coding launched" "true" "$(kv_value "$tick2" coding_launched)"
  check_contains "expanded packet tick 2: launch uses authoritative coder" "$(kv_value "$tick2" coding_launch_args)" "expanded-packet-coder"
  check_contains "expanded packet tick 2: launch uses authoritative depth" "$(kv_value "$tick2" coding_launch_args)" " deep"
  check_contains "expanded packet tick 2: reroute failure does not block" "$(kv_value "$tick2" warn_output)" "expanded reroute helper failed"
  check_file_exists "expanded packet tick 2: plan approval preserved" "$feature_dir/.plan-approved"
}

test_resume_refreshes_phase_config_from_expanded_route() {
  local slug="expanded-route-resume"
  local issue="HOK-1516-RESUME"
  local repo feature_dir restore_output
  repo="$(harness_init_repo "$slug")"
  harness_setup_runtime_artifacts "$repo"
  harness_setup_route_artifacts "$repo" "$slug" "bootstrap-coder" "medium" "resume-expanded-coder" "deep"
  feature_dir="$repo/features/$slug"

  restore_output="$(harness_run_restore "$repo" "$slug" "$issue" "coding" '
    source "$REAL_FUNC_FILE"
  ')"
  check_eq "resume: coding relaunch reported restored" "restored" "$(kv_value "$restore_output" restore_state)"
  check_eq "resume: coding launch invoked" "true" "$(kv_value "$restore_output" coding_launched)"
  check_contains "resume: launch uses expanded coder" "$(kv_value "$restore_output" coding_launch_args)" "resume-expanded-coder"
  check_contains "resume: launch uses expanded depth" "$(kv_value "$restore_output" coding_launch_args)" " deep"
  check_eq "resume: phase-config coding model regenerated" "resume-expanded-coder" "$(jq -r '.coding.model' "$feature_dir/.phase-config.json")"
  check_eq "resume: phase-config coding depth regenerated" "deep" "$(jq -r '.coding.depth' "$feature_dir/.phase-config.json")"
}

echo "=== Mill Lifecycle: Planning to Coding Handoff ==="
harness_extract_real_functions

test_positive_handoff_two_ticks
test_source_edit_blocks_handoff
test_regression_without_wavemill_allowance
test_mixed_artifacts_source_edit_wins
test_claude_local_settings_allowed
test_expanded_route_handoff_uses_authoritative_route
test_invalid_expanded_route_blocks_without_bootstrap_leak
test_already_expanded_packet_skips_mandatory_expansion_gate
test_resume_refreshes_phase_config_from_expanded_route

echo ""
if [[ "$FAIL" -eq 0 ]]; then
  echo "All $PASS lifecycle harness tests passed"
else
  echo "$FAIL lifecycle harness tests failed ($PASS passed)"
  exit 1
fi
