#!/usr/bin/env bash
# Idempotent terminal transition reconciliation for wavemill task surfaces.

WAVEMILL_TERMINAL_RECONCILER_LOADED=1

wavemill_terminal_reason_valid() {
  case "${1:-}" in
    review_complete|ready_complete|pr_opened|pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison|operator_abort|recovery_failure|phase_launch_exhausted) return 0 ;;
    *) return 1 ;;
  esac
}

wavemill_terminal_marker_key() {
  local reason="$1" pr_number="${2:-}"
  [[ -n "$pr_number" ]] && printf '%s:%s\n' "$reason" "$pr_number" || printf '%s\n' "$reason"
}

wavemill_terminal_feature_dir() {
  local issue="$1" slug="" worktree=""
  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]] && command -v jq >/dev/null 2>&1; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    worktree="$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-${WAVEMILL_SLUG:-${WAVEMILL_FEATURE_SLUG:-}}}"
  [[ -n "$worktree" ]] || worktree="${WT_DIR:-${WAVEMILL_WT_DIR:-}}"
  [[ -z "$worktree" && -n "${WORKTREE_ROOT:-}" && -n "$slug" ]] && worktree="${WORKTREE_ROOT%/}/$slug"
  if [[ -n "$worktree" && -n "$slug" ]]; then
    for kind in features bugs; do
      [[ -d "${worktree%/}/$kind/$slug" ]] && { printf '%s\n' "${worktree%/}/$kind/$slug"; return 0; }
    done
    printf '%s\n' "${worktree%/}/features/$slug"
    return 0
  fi
  return 1
}

wavemill_pr_live_state() {
  local pr_number="${1:-}"
  [[ -n "$pr_number" ]] || return 1
  command -v gh >/dev/null 2>&1 || return 1
  gh pr view "$pr_number" --json number,state,mergedAt --jq \
    '{number, state, mergedAt, terminalState: (if .mergedAt != null then "MERGED" elif .state == "CLOSED" then "CLOSED" else .state end)}' 2>/dev/null
}

wavemill_terminal_effective_reason() {
  local reason="$1" pr_json="${2:-}" terminal_state=""
  [[ -n "$pr_json" ]] && terminal_state="$(jq -r '.terminalState // empty' <<<"$pr_json" 2>/dev/null || true)"
  case "$terminal_state" in
    MERGED) printf 'pr_merged\n'; return 0 ;;
    CLOSED) [[ "$reason" != "pr_merged" ]] && { printf 'pr_closed_unmerged\n'; return 0; } ;;
  esac
  printf '%s\n' "$reason"
}

wavemill_terminal_hook_state() {
  case "$1" in
    recovery_failure|challenge_invalid|phase_launch_exhausted) printf 'error\n' ;;
    *) printf 'idle\n' ;;
  esac
}

wavemill_terminal_detail() {
  local reason="$1" pr_number="${2:-}"
  case "$reason" in
    review_complete|pr_opened) printf 'PR #%s created' "$pr_number" ;;
    ready_complete) printf 'Ready checks completed%s' "${pr_number:+ for PR #$pr_number}" ;;
    pr_merged) printf 'PR #%s merged' "$pr_number" ;;
    pr_closed_unmerged) printf 'PR #%s closed without merge' "$pr_number" ;;
    challenge_resolved_winner) printf 'Challenge resolved with winner' ;;
    challenge_invalid) printf 'Challenge marked invalid' ;;
    challenge_no_comparison) printf 'Challenge closed without comparison' ;;
    operator_abort) printf 'Workflow aborted by operator' ;;
    recovery_failure) printf 'Recovery failed' ;;
    phase_launch_exhausted) printf 'Phase launch retries exhausted' ;;
    *) printf '%s' "$reason" ;;
  esac
}

wavemill_terminal_phase_for_reason() {
  case "$1" in
    review_complete|pr_opened|ready_complete) printf 'ready\n' ;;
    pr_merged) printf 'done\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure|phase_launch_exhausted) printf 'error\n' ;;
  esac
}

wavemill_terminal_status_for_reason() {
  case "$1" in
    pr_merged) printf 'merged\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure|phase_launch_exhausted) printf 'error\n' ;;
    *) printf '' ;;
  esac
}

wavemill_terminal_workflow_outcome_for_reason() {
  case "$1" in
    pr_merged) printf 'merged\n' ;;
    pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'closed\n' ;;
    operator_abort) printf 'aborted\n' ;;
    recovery_failure|phase_launch_exhausted) printf 'error\n' ;;
    *) printf 'active\n' ;;
  esac
}

wavemill_terminal_stage_for_reason() {
  case "$1" in
    review_complete|pr_opened) printf 'review\n' ;;
    ready_complete|pr_merged|pr_closed_unmerged|challenge_resolved_winner|challenge_invalid|challenge_no_comparison) printf 'ready\n' ;;
    operator_abort|recovery_failure|phase_launch_exhausted) printf '%s\n' "${CURRENT_PHASE:-${WAVEMILL_PHASE:-coding}}" ;;
  esac
}

wavemill_terminal_stage_status_for_reason() {
  case "$1" in
    operator_abort) printf 'aborted\n' ;;
    recovery_failure|challenge_invalid|phase_launch_exhausted) printf 'failed\n' ;;
    *) printf 'completed\n' ;;
  esac
}

wavemill_terminal_marker_value() {
  local issue="$1" reason="$2" pr_number="${3:-}" pr_json="${4:-null}" now
  now="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  jq -cn --arg issue "$issue" --arg reason "$reason" --arg pr "$pr_number" --arg appliedAt "$now" --argjson prJson "$pr_json" \
    '{issue:$issue, reason:$reason, prNumber:(if $pr == "" then null else $pr end), appliedAt:$appliedAt, stateApplied:true, stageApplied:false, hookApplied:false, paneMetadataApplied:false, paneApplied:false, paneReleased:false, linearApplied:false, pr:$prJson}'
}

wavemill_terminal_marker_field() {
  local issue="$1" key="$2" field="$3"
  [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]] || return 0
  jq -r --arg issue "$issue" --arg key "$key" --arg field "$field" \
    '.tasks[$issue].terminalReconciliations[$key][$field] // empty' "$STATE_FILE" 2>/dev/null || true
}

wavemill_terminal_mark_field() {
  local issue="$1" key="$2" field="$3" value="${4:-true}"
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" \
    '.tasks[$issue].terminalReconciliations[$key][$field] = $value
     | .tasks[$issue].terminalReconciliations[$key].updatedAt = (now | todateiso8601)
     | .tasks[$issue].updated = (now | todateiso8601)' \
    --arg issue "$issue" --arg key "$key" --arg field "$field" --argjson value "$value" >/dev/null || true
}

wavemill_terminal_apply_state() {
  local issue="$1" reason="$2" pr_number="${3:-}" marker_json="$4" key phase status workflow_outcome pr_payload
  key="$(wavemill_terminal_marker_key "$reason" "$pr_number")"
  phase="$(wavemill_terminal_phase_for_reason "$reason")"
  status="$(wavemill_terminal_status_for_reason "$reason")"
  workflow_outcome="$(wavemill_terminal_workflow_outcome_for_reason "$reason")"
  pr_payload="$(jq -c '.pr // null' <<<"$marker_json" 2>/dev/null || printf 'null')"
  [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]] || return 0
  state_mutate "$STATE_FILE" '
    (.tasks[$issue].terminalReconciliations[$key] // null) as $existing
    | if $existing == null then .tasks[$issue].terminalReconciliations[$key] = $marker else . end
    | if $phase != "" then .tasks[$issue].phase = $phase else . end
    | if $status != "" then .tasks[$issue].status = $status else . end
    | if $pr != "" then .tasks[$issue].pr = $pr else . end
    | (.tasks[$issue].lifecycle // {}) as $l
    | ($l.resourceDisposition // "") as $existingDisposition
    | .tasks[$issue].lifecycle = ($l + {
        schemaVersion: 1,
        workflowOutcome: $workflowOutcome,
        resourceDisposition: (
          if $workflowOutcome == "active" then
            (if ($existingDisposition | IN("allocated","released","retained","reaping","reaped","verification-required")) then $existingDisposition
             elif (.tasks[$issue].paneState // "") == "released" then "released"
             else "allocated"
             end)
          elif ($existingDisposition | IN("released","retained","reaping","reaped","verification-required")) then $existingDisposition
          else "verification-required"
          end
        )
      })
    | if $workflowOutcome != "active" and ((.tasks[$issue].lifecycle.retention.reason // "") == "") then
        .tasks[$issue].lifecycle.retention = {
          reason: "terminal-reconciliation-resource-verification-required",
          policy: "manual-verification-required",
          actor: "terminal-reconciler",
          timestamp: (now | todateiso8601),
          evidence: {terminalReason: $reason, prNumber: (if $pr == "" then null else $pr end)}
        }
      else .
      end
    | if $pr != "" then .tasks[$issue].lifecycle.deliveryEvidence.prNumber = $pr else . end
    | if ($prJson | type) == "object" then
        .tasks[$issue].lifecycle.deliveryEvidence.prState = ($prJson.terminalState // $prJson.state // .tasks[$issue].lifecycle.deliveryEvidence.prState // "")
        | .tasks[$issue].lifecycle.deliveryEvidence.prBaseBranch = ($prJson.baseRefName // .tasks[$issue].lifecycle.deliveryEvidence.prBaseBranch // "")
        | .tasks[$issue].lifecycle.deliveryEvidence.mergeSha = ($prJson.mergeCommit.oid // $prJson.mergeCommitOid // .tasks[$issue].lifecycle.deliveryEvidence.mergeSha // "")
      else .
      end
    | .tasks[$issue].updated = (now | todateiso8601)
  ' --arg issue "$issue" --arg key "$key" --arg phase "$phase" --arg status "$status" --arg pr "$pr_number" \
    --arg reason "$reason" --arg workflowOutcome "$workflow_outcome" --argjson marker "$marker_json" --argjson prJson "$pr_payload"
}

wavemill_terminalize_hook_for_issue() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}" feature_dir hook_protocol hook_state detail agent
  hook_protocol="${WAVEMILL_HOOK_PROTOCOL:-${LIB_DIR:-${REPO_DIR:-}/shared/lib}/../hooks/wavemill-hook-protocol.sh}"
  [[ -f "$hook_protocol" ]] || hook_protocol="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd)/hooks/wavemill-hook-protocol.sh"
  [[ -f "$hook_protocol" ]] || return 0
  # shellcheck source=../hooks/wavemill-hook-protocol.sh
  source "$hook_protocol" || return 0
  feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
  hook_state="$(wavemill_terminal_hook_state "$reason")"
  detail="$(wavemill_terminal_detail "$reason" "$pr_number")"
  agent="${CURRENT_AGENT:-${AGENT_CMD:-wavemill}}"
  WAVEMILL_SESSION="$session" WAVEMILL_ISSUE="$issue" WAVEMILL_FEATURE_DIR="$feature_dir" \
    wavemill_hook_terminalize "$hook_state" "$reason" "$detail" "$agent" || true
}

wavemill_reconcile_pane_terminal() {
  local session="$1" issue="$2" reason="$3" slug="" target="" win=""
  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-}"
  win="$issue-$slug"
  [[ -n "$target" ]] || target="$session:$win"
  declare -F set_window_attention_state >/dev/null 2>&1 && [[ -n "$slug" ]] && set_window_attention_state "$win" "clear" || true
  declare -F wavemill_apply_window_metadata >/dev/null 2>&1 && wavemill_apply_window_metadata "$session" "$issue" "$target" "${STATE_FILE:-}" >/dev/null 2>&1 || true
  command -v tmux >/dev/null 2>&1 && tmux select-pane -t "$target" -T "$(wavemill_terminal_detail "$reason")" >/dev/null 2>&1 || true
  return 0
}

wavemill_terminal_linear_status() {
  local issue="$1" reason="$2" sibling_pr="" sibling_state=""
  case "$reason" in
    pr_merged) printf 'Done\n' ;;
    pr_closed_unmerged)
      if declare -F is_challenge_task >/dev/null 2>&1 && is_challenge_task "$issue"; then
        declare -F check_challenge_sibling_merged >/dev/null 2>&1 && check_challenge_sibling_merged "$issue" && { printf 'Done\n'; return 0; }
        declare -F get_challenge_sibling_pr >/dev/null 2>&1 && sibling_pr="$(get_challenge_sibling_pr "$issue" 2>/dev/null || true)"
        [[ -n "$sibling_pr" ]] && declare -F pr_state >/dev/null 2>&1 && sibling_state="$(pr_state "$sibling_pr" 2>/dev/null || true)"
        [[ "$sibling_state" == "CLOSED" ]] || return 1
      fi
      printf 'Backlog\n'
      ;;
    challenge_invalid|challenge_no_comparison|operator_abort|recovery_failure|phase_launch_exhausted) printf 'Backlog\n' ;;
    challenge_resolved_winner) printf 'Done\n' ;;
    *) return 1 ;;
  esac
}

wavemill_reconcile_terminal_linear() {
  local issue="$1" reason="$2" status="" linear_issue=""
  declare -F linear_set_state >/dev/null 2>&1 || return 0
  declare -F should_update_linear_state >/dev/null 2>&1 && ! should_update_linear_state "$issue" && return 0
  status="$(wavemill_terminal_linear_status "$issue" "$reason" 2>/dev/null || true)"
  [[ -n "$status" ]] || return 3
  declare -F get_linear_issue_id >/dev/null 2>&1 && linear_issue="$(get_linear_issue_id "$issue")" || linear_issue="$issue"
  linear_set_state "$linear_issue" "$status"
}

wavemill_reconcile_terminal() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}" pr_json="" effective_reason key marker_json linear_rc
  local feature_dir stage stage_status agent model notes artifacts existing_artifacts

  wavemill_terminal_reason_valid "$reason" || return 2
  if [[ -n "$pr_number" ]]; then
    pr_json="$(wavemill_pr_live_state "$pr_number" 2>/dev/null || true)"
    if [[ -z "$pr_json" ]]; then
      declare -F log_warn >/dev/null 2>&1 && log_warn "$issue terminal reconciliation deferred: could not read PR #$pr_number"
      return 1
    fi
  fi
  effective_reason="$(wavemill_terminal_effective_reason "$reason" "${pr_json:-}")"
  key="$(wavemill_terminal_marker_key "$effective_reason" "$pr_number")"
  marker_json="$(wavemill_terminal_marker_value "$issue" "$effective_reason" "$pr_number" "${pr_json:-null}")"
  wavemill_terminal_apply_state "$issue" "$effective_reason" "$pr_number" "$marker_json" || return 1

  feature_dir="$(wavemill_terminal_feature_dir "$issue" 2>/dev/null || true)"
  stage="$(wavemill_terminal_stage_for_reason "$effective_reason")"
  stage_status="$(wavemill_terminal_stage_status_for_reason "$effective_reason")"
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "stageApplied")" != "true" ]] \
    && [[ -n "$feature_dir" && -n "$stage" ]] \
    && declare -F write_stage_result >/dev/null 2>&1; then
    agent="${CURRENT_AGENT:-${AGENT_CMD:-wavemill}}"
    model=""
    declare -F resolve_stage_result_model >/dev/null 2>&1 && model="$(resolve_stage_result_model "$feature_dir" "$stage" "" 2>/dev/null || true)"
    notes="$(wavemill_terminal_detail "$effective_reason" "$pr_number")"
    # Preserve any artifacts the stage agent already recorded (verdict, exitCode,
    # iterations, blockerCount). write_stage_result replaces the file wholesale, so
    # a thin terminal blob here would destroy the evidence the ready gate reads.
    existing_artifacts="{}"
    if [[ -f "$feature_dir/.${stage}-result.json" ]]; then
      existing_artifacts="$(jq -c 'if (.artifacts | type) == "object" then .artifacts else {} end' "$feature_dir/.${stage}-result.json" 2>/dev/null || printf '{}')"
    fi
    [[ -n "$existing_artifacts" ]] || existing_artifacts="{}"
    artifacts="$(jq -cn --argjson existing "$existing_artifacts" --arg type "$stage" --arg reason "$effective_reason" --arg pr "$pr_number" \
      '$existing + {type:$type, terminalReason:$reason} + (if $pr == "" then {} else {prNumber:($pr|tonumber)} end)' 2>/dev/null || true)"
    write_stage_result "$feature_dir" "$stage" "$stage_status" "$agent" "$model" "$notes" "$artifacts" || true
    wavemill_terminal_mark_field "$issue" "$key" "stageApplied" true
  fi

  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "hookApplied")" != "true" ]]; then
    wavemill_terminalize_hook_for_issue "$session" "$issue" "$effective_reason" "$pr_number"
    wavemill_terminal_mark_field "$issue" "$key" "hookApplied" true
  fi
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneMetadataApplied")" != "true" ]] \
    && [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneApplied")" != "true" ]]; then
    wavemill_reconcile_pane_terminal "$session" "$issue" "$effective_reason"
    wavemill_terminal_mark_field "$issue" "$key" "paneMetadataApplied" true
    wavemill_terminal_mark_field "$issue" "$key" "paneApplied" true
  fi
  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "linearApplied")" != "true" ]]; then
    linear_rc=0
    wavemill_reconcile_terminal_linear "$issue" "$effective_reason" || linear_rc=$?
    if [[ "$linear_rc" -eq 0 ]]; then
      wavemill_terminal_mark_field "$issue" "$key" "linearApplied" true
    elif [[ "$linear_rc" -ne 3 ]]; then
      return "$linear_rc"
    fi
  fi

  if [[ "$(wavemill_terminal_marker_field "$issue" "$key" "paneReleased")" != "true" ]]; then
    local pane_policy release_rc=0
    pane_policy="$(wavemill_terminal_pane_policy "$effective_reason")"
    case "$pane_policy" in
      release)
        wavemill_release_terminal_pane "$session" "$issue" "$effective_reason" "$pr_number" || release_rc=$?
        if [[ "$release_rc" -eq 0 ]]; then
          wavemill_terminal_mark_field "$issue" "$key" "paneReleased" true
        else
          wavemill_terminal_mark_field "$issue" "$key" "paneReleaseDeferredReason" "\"release-failed-rc-${release_rc}\""
        fi
        ;;
      retain-manual)
        wavemill_archive_pane_transcript "$issue" "$session" || true
        wavemill_write_terminal_record "$session" "$issue" "$effective_reason" "$pr_number" || true
        wavemill_terminal_mark_field "$issue" "$key" "paneReleaseDeferredReason" "\"retain-manual\""
        ;;
    esac
  fi
}

wavemill_terminal_pane_policy() {
  local reason="$1"
  local outcome
  outcome="$(wavemill_terminal_workflow_outcome_for_reason "$reason")"
  case "$outcome" in
    merged|closed) printf 'release\n' ;;
    aborted|error) printf 'retain-manual\n' ;;
    *) printf 'none\n' ;;
  esac
}

wavemill_terminal_pane_release_enabled() {
  local wt_dir="${1:-${WT_DIR:-${WORKTREE_ROOT:+$WORKTREE_ROOT/}}}"
  if [[ "${WAVEMILL_TERMINAL_PANE_RELEASE:-}" == "0" ]]; then
    return 1
  fi
  local repo_dir="${REPO_DIR:-}"
  [[ -n "$repo_dir" ]] || return 0
  local cfg
  cfg="$(wavemill_load_config "$repo_dir" 2>/dev/null || echo '{}')"
  local enabled
  enabled="$(printf '%s' "$cfg" | jq -r '.cleanup.terminalPaneRelease.enabled // true' 2>/dev/null || echo 'true')"
  [[ "$enabled" == "false" ]] && return 1
  return 0
}

wavemill_archive_pane_transcript() {
  local issue="$1" session="${2:-${SESSION:-}}"
  local archive_dir="${REPO_DIR:-.}/.wavemill/evals/artifacts/${issue}"
  local transcript_path="$archive_dir/pane-transcript.txt"
  local slug="" target="" tmp_path

  [[ -f "$transcript_path" ]] && return 0

  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-}"
  [[ -n "$target" ]] || target="$session:$issue-$slug"

  if ! command -v tmux >/dev/null 2>&1; then
    return 0
  fi

  mkdir -p "$archive_dir" 2>/dev/null || return 1
  tmp_path="$(mktemp "$archive_dir/.pane-transcript.XXXXXX")" || return 1

  if tmux capture-pane -p -J -S - -t "$target" > "$tmp_path" 2>/dev/null; then
    mv "$tmp_path" "$transcript_path"
    return 0
  fi

  rm -f "$tmp_path" 2>/dev/null || true
  return 0
}

wavemill_write_terminal_record() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}"
  local archive_dir="${REPO_DIR:-.}/.wavemill/evals/artifacts/${issue}"
  local record_path="$archive_dir/terminal-record.json"
  local slug="" worktree="" branch="" base_branch="" window_target="" tmp_path

  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    worktree="$(jq -r --arg issue "$issue" '.tasks[$issue].worktree // empty' "$STATE_FILE" 2>/dev/null || true)"
    branch="$(jq -r --arg issue "$issue" '.tasks[$issue].branch // empty' "$STATE_FILE" 2>/dev/null || true)"
    window_target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-}"
  [[ -n "$worktree" ]] || worktree="${WORKTREE_ROOT:+$WORKTREE_ROOT/$slug}"
  [[ -n "$branch" ]] || branch="task/$slug"
  base_branch="${BASE_BRANCH:-auto/integration}"

  local transcript_archived="false"
  [[ -f "$archive_dir/pane-transcript.txt" ]] && transcript_archived="true"

  local git_disposition="pending-cleanup"
  if [[ -n "$worktree" && -d "$worktree" ]]; then
    git_disposition="retained"
  fi

  mkdir -p "$archive_dir" 2>/dev/null || return 1
  tmp_path="$(mktemp "$archive_dir/.terminal-record.XXXXXX")" || return 1

  if jq -cn \
    --arg issue "$issue" \
    --arg slug "$slug" \
    --arg session "$session" \
    --arg reason "$reason" \
    --arg prNumber "$pr_number" \
    --arg windowTarget "$window_target" \
    --arg worktree "$worktree" \
    --arg branch "$branch" \
    --arg baseBranch "$base_branch" \
    --arg transcriptArchived "$transcript_archived" \
    --arg gitDisposition "$git_disposition" \
    --arg recordedAt "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{
      issue: $issue,
      slug: $slug,
      session: $session,
      reason: $reason,
      prNumber: (if $prNumber == "" then null else $prNumber end),
      windowTarget: $windowTarget,
      worktree: $worktree,
      branch: $branch,
      baseBranch: $baseBranch,
      transcriptArchived: ($transcriptArchived == "true"),
      gitDisposition: $gitDisposition,
      recordedAt: $recordedAt,
      recover: ("retained worktree at " + $worktree + " branch " + $branch)
    }' > "$tmp_path"; then
    mv "$tmp_path" "$record_path"
    return 0
  fi

  rm -f "$tmp_path" 2>/dev/null || true
  return 1
}

wavemill_release_terminal_pane() {
  local session="$1" issue="$2" reason="$3" pr_number="${4:-}"
  local slug="" target="" pane_state=""

  if [[ -n "${STATE_FILE:-}" && -r "${STATE_FILE:-}" ]]; then
    slug="$(jq -r --arg issue "$issue" '.tasks[$issue].slug // empty' "$STATE_FILE" 2>/dev/null || true)"
    target="$(jq -r --arg issue "$issue" '.tasks[$issue].windowId // empty' "$STATE_FILE" 2>/dev/null || true)"
    pane_state="$(jq -r --arg issue "$issue" '.tasks[$issue].paneState // empty' "$STATE_FILE" 2>/dev/null || true)"
  fi
  [[ -n "$slug" ]] || slug="${SLUG:-}"
  [[ -n "$target" ]] || target="$session:$issue-$slug"

  local wt_dir="${WORKTREE_ROOT:+$WORKTREE_ROOT/$slug}"

  if [[ "$pane_state" == "released" ]]; then
    if ! command -v tmux >/dev/null 2>&1; then
      return 0
    fi
    if declare -F _tmux_window_target_exists >/dev/null 2>&1; then
      _tmux_window_target_exists "$session" "$target" "$wt_dir" 2>/dev/null || return 0
    else
      return 0
    fi
  fi

  if ! wavemill_terminal_pane_release_enabled "$wt_dir"; then
    wavemill_archive_pane_transcript "$issue" "$session" || true
    wavemill_write_terminal_record "$session" "$issue" "$reason" "$pr_number" || true
    return 0
  fi

  wavemill_archive_pane_transcript "$issue" "$session" || return 1
  wavemill_write_terminal_record "$session" "$issue" "$reason" "$pr_number" || return 1

  if command -v tmux >/dev/null 2>&1; then
    if declare -F _tmux_target_join >/dev/null 2>&1; then
      tmux kill-window -t "$(_tmux_target_join "$session" "$target")" 2>/dev/null || true
    else
      tmux kill-window -t "$session:$target" 2>/dev/null || true
    fi
    if declare -F _tmux_window_target_exists >/dev/null 2>&1; then
      if _tmux_window_target_exists "$session" "$target" "$wt_dir" 2>/dev/null; then
        set_task_lifecycle_disposition "$issue" "" "retained" "tmux-window-close-failed" "wavemill_release_terminal_pane" 2>/dev/null || true
        return 1
      fi
    fi
  fi

  rm -f "/tmp/wavemill-${session}-${issue}.hook" 2>/dev/null || true

  if [[ -n "${STATE_FILE:-}" && -f "${STATE_FILE:-}" ]]; then
    local retention_reason=""
    if [[ -n "$wt_dir" && -d "$wt_dir" ]]; then
      retention_reason="pane-released-git-work-retained"
    fi
    state_mutate "$STATE_FILE" '
      .tasks[$issue].paneState = "released"
      | .tasks[$issue].paneReleasedAt = (now | todateiso8601)
      | if $retentionReason != "" then
          .tasks[$issue].lifecycle.resourceDisposition = "retained"
          | .tasks[$issue].lifecycle.retention = {
              reason: $retentionReason,
              policy: "pane-released-git-retained",
              actor: "terminal-reconciler",
              timestamp: (now | todateiso8601)
            }
        else
          (if (.tasks[$issue].lifecycle.resourceDisposition // "") == "verification-required" then .
           else .tasks[$issue].lifecycle.resourceDisposition = "released"
           end)
        end
      | .tasks[$issue].updated = (now | todateiso8601)' \
      --arg issue "$issue" --arg retentionReason "$retention_reason" >/dev/null || true
  fi

  declare -F log >/dev/null 2>&1 && log "status" "🧹 $issue → terminal pane released (reason: $reason${pr_number:+, PR #$pr_number})" || true
  return 0
}
