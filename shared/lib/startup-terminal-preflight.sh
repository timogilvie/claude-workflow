#!/usr/bin/env bash
# Startup gate for persisted task entries whose authoritative PR/challenge
# state is already terminal.

WAVEMILL_STARTUP_PREFLIGHT_LOADED=1

declare -gA STARTUP_PREFLIGHT_PR_STATE_CACHE=()
declare -gA STARTUP_PREFLIGHT_PR_JSON_CACHE=()
declare -gA STARTUP_PREFLIGHT_PR_MERGED_AT_CACHE=()

startup_preflight_enabled() {
  if [[ "${WAVEMILL_STARTUP_TERMINAL_PREFLIGHT:-}" == "0" ]]; then
    printf 'false\n'
    return 0
  fi
  local repo_dir="${REPO_DIR:-}"
  local user_config="$HOME/.wavemill/config.json"
  local repo_config="$repo_dir/.wavemill-config.json"
  local local_config="$repo_dir/.wavemill-config.local.json"
  local user_json='{}' repo_json='{}' local_json='{}'
  [[ -f "$user_config" ]] && user_json=$(cat "$user_config" 2>/dev/null || echo '{}')
  [[ -f "$repo_config" ]] && repo_json=$(cat "$repo_config" 2>/dev/null || echo '{}')
  [[ -f "$local_config" ]] && local_json=$(cat "$local_config" 2>/dev/null || echo '{}')
  jq -nr \
    --argjson user "$user_json" \
    --argjson repo "$repo_json" \
    --argjson local "$local_json" \
    '({startup:{terminalPreflight:{enabled:true}}} * $user * $repo * $local).startup.terminalPreflight.enabled
     | if . == false then "false" else "true" end' 2>/dev/null || printf 'true\n'
}

startup_preflight_run_epoch() {
  printf '%s\n' "${WAVEMILL_RUN_EPOCH:-${RUN_EPOCH:-}}"
}

startup_preflight_stamp_run_epoch() {
  local state_file="$1" run_epoch="$2"
  [[ -n "$state_file" && -f "$state_file" && -n "$run_epoch" ]] || return 0
  state_mutate "$state_file" '.runEpoch = $runEpoch | .updated = (now | todateiso8601)' \
    --arg runEpoch "$run_epoch" >/dev/null 2>&1 || true
}

startup_preflight_resolve_pr_evidence() {
  local pr="${1:-}"
  WAVEMILL_STARTUP_PREFLIGHT_PR_STATE="UNKNOWN"
  WAVEMILL_STARTUP_PREFLIGHT_PR_JSON=""
  WAVEMILL_STARTUP_PREFLIGHT_PR_MERGED_AT=""
  [[ -n "$pr" ]] || return 1

  if [[ -n "${STARTUP_PREFLIGHT_PR_STATE_CACHE[$pr]:-}" ]]; then
    WAVEMILL_STARTUP_PREFLIGHT_PR_STATE="${STARTUP_PREFLIGHT_PR_STATE_CACHE[$pr]}"
    WAVEMILL_STARTUP_PREFLIGHT_PR_JSON="${STARTUP_PREFLIGHT_PR_JSON_CACHE[$pr]:-}"
    WAVEMILL_STARTUP_PREFLIGHT_PR_MERGED_AT="${STARTUP_PREFLIGHT_PR_MERGED_AT_CACHE[$pr]:-}"
    [[ "$WAVEMILL_STARTUP_PREFLIGHT_PR_STATE" != "UNKNOWN" ]]
    return $?
  fi

  if wavemill_fetch_pr_terminal_evidence "$pr"; then
    STARTUP_PREFLIGHT_PR_STATE_CACHE[$pr]="$WAVEMILL_PR_EVIDENCE_STATE"
    STARTUP_PREFLIGHT_PR_JSON_CACHE[$pr]="$WAVEMILL_PR_EVIDENCE_JSON"
    STARTUP_PREFLIGHT_PR_MERGED_AT_CACHE[$pr]="$WAVEMILL_PR_EVIDENCE_MERGED_AT"
    WAVEMILL_STARTUP_PREFLIGHT_PR_STATE="$WAVEMILL_PR_EVIDENCE_STATE"
    WAVEMILL_STARTUP_PREFLIGHT_PR_JSON="$WAVEMILL_PR_EVIDENCE_JSON"
    WAVEMILL_STARTUP_PREFLIGHT_PR_MERGED_AT="$WAVEMILL_PR_EVIDENCE_MERGED_AT"
    return 0
  fi

  STARTUP_PREFLIGHT_PR_STATE_CACHE[$pr]="UNKNOWN"
  STARTUP_PREFLIGHT_PR_JSON_CACHE[$pr]=""
  STARTUP_PREFLIGHT_PR_MERGED_AT_CACHE[$pr]=""
  return 1
}

startup_preflight_classify_entry() {
  local entry_json="$1"
  jq -r "$(task_lifecycle_jq_filter '
    . as $task
    | ($task.status // "") as $status
    | ($task.phase // "") as $phase
    | ($task.lifecycle.workflowOutcome // "") as $outcome
    | ($task.__startupPreflightPrState // "") as $prState
    | ($task.__startupPreflightPrMergedAt // "") as $mergedAt
    | ($task.__startupPreflightSiblingPrState // "") as $siblingState
    | ($task.slug // "") as $slug
    | ($task.branch // "") as $branch
    | ($task.lifecycle | type == "object") as $hasLifecycle
    | if (($status | IN("superseded")) or ($phase | IN("superseded")) or $siblingState == "MERGED") then
        "superseded"
      elif (($task | wm_terminal_status) and $outcome == "active") then
        "verification-required:contradictory-terminal-state"
      elif $prState == "MERGED" or $outcome == "merged" or $status == "merged" then
        "terminal:pr_merged"
      elif $prState == "CLOSED" and ($mergedAt == "" or $mergedAt == "null") then
        "terminal:pr_closed_unmerged"
      elif ($task | wm_terminal_status) or ($outcome != "" and $outcome != "active") then
        "terminal:persisted"
      elif ($prState == "UNKNOWN") then
        "unverified:network"
      elif ($hasLifecycle | not) then
        "verification-required:missing-launch-contract"
      elif ($slug != "" and $branch != "") then
        "rehydrate"
      else
        "verification-required:insufficient-provenance"
      end
  ')" <<<"$entry_json" 2>/dev/null || printf 'verification-required:malformed-entry\n'
}

startup_preflight_stamp_entry() {
  local state_file="$1" issue="$2" verdict="$3" reason="$4" pr_state="$5" run_epoch="$6"
  [[ -n "$state_file" && -f "$state_file" && -n "$issue" ]] || return 0
  state_mutate "$state_file" '
    if .tasks[$issue] == null then . else
      .tasks[$issue].startupPreflight = {
        verdict: $verdict,
        reason: $reason,
        prState: $prState,
        checkedAt: (now | todateiso8601),
        runEpoch: $runEpoch
      }
      | if ($verdict | startswith("verification-required")) then
          .tasks[$issue].lifecycle = ((.tasks[$issue].lifecycle // {}) + {
            schemaVersion: 1,
            workflowOutcome: (.tasks[$issue].lifecycle.workflowOutcome // "active"),
            resourceDisposition: (.tasks[$issue].lifecycle.resourceDisposition // "verification-required"),
            verificationRequiredReason: $reason
          })
        else .
        end
      | .tasks[$issue].updated = (now | todateiso8601)
    end' \
    --arg issue "$issue" --arg verdict "$verdict" --arg reason "$reason" \
    --arg prState "$pr_state" --arg runEpoch "$run_epoch" >/dev/null 2>&1 || true
}

startup_preflight_reconcile_primary_pair() {
  local issue="$1" pr="$2" role pair_id resolve_output resolve_status resolve_reason
  [[ -n "$issue" && -n "$pr" ]] || return 0
  if declare -F resolve_pair_on_primary_merge >/dev/null 2>&1; then
    resolve_pair_on_primary_merge "$issue" "$pr" || true
    return 0
  fi
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" && -n "${TOOLS_DIR:-}" && -n "${REPO_DIR:-}" ]] || return 0
  role="$(jq -r --arg issue "$issue" '.tasks[$issue].challengeRole // empty' "$STATE_FILE" 2>/dev/null || true)"
  pair_id="$(jq -r --arg issue "$issue" '.tasks[$issue].challengePairId // empty' "$STATE_FILE" 2>/dev/null || true)"
  [[ "$role" == "primary" && -n "$pair_id" && -f "$TOOLS_DIR/resolve-primary-merged-pair.ts" ]] || return 0
  resolve_output="$(npx tsx "$TOOLS_DIR/resolve-primary-merged-pair.ts" --pair-id "$pair_id" --primary-pr "$pr" --repo-dir "$REPO_DIR" 2>/dev/null || true)"
  resolve_status="$(jq -r '.status // empty' <<<"$resolve_output" 2>/dev/null || true)"
  case "$resolve_status" in
    resolved)
      resolve_reason="$(jq -r '.reason // "unknown"' <<<"$resolve_output" 2>/dev/null || echo "unknown")"
      declare -F log_warn >/dev/null 2>&1 && log_warn "challenge pair $pair_id resolved automatically via $resolve_reason" || true
      ;;
    already-resolved)
      declare -F log >/dev/null 2>&1 && log "status" "challenge pair $pair_id already resolved, primary merge cleanup continuing" || true
      ;;
  esac
}

startup_preflight_reconcile_entry() {
  local session="$1" issue="$2" verdict="$3" pr="$4" reason="$verdict"
  case "$verdict" in
    terminal:pr_merged)
      [[ -n "$pr" ]] && wavemill_record_pr_delivery_evidence "$issue" "$pr"
      startup_preflight_reconcile_primary_pair "$issue" "$pr"
      [[ -n "$pr" ]] && wavemill_reconcile_terminal "$session" "$issue" "pr_merged" "$pr" || wavemill_reconcile_terminal "$session" "$issue" "pr_merged" ""
      ;;
    terminal:pr_closed_unmerged)
      [[ -n "$pr" ]] && wavemill_record_pr_delivery_evidence "$issue" "$pr"
      wavemill_reconcile_terminal "$session" "$issue" "pr_closed_unmerged" "$pr"
      ;;
    superseded)
      wavemill_reconcile_terminal "$session" "$issue" "challenge_superseded" "$pr"
      ;;
    terminal:persisted)
      reason="$(jq -r --arg issue "$issue" '
        (.tasks[$issue] // {}) as $task
        | if ($task.status // "") == "superseded" or ($task.phase // "") == "superseded" then "challenge_superseded"
          elif ($task.status // "") == "aborted" or ($task.phase // "") == "aborted" then "operator_abort"
          elif ($task.status // "") == "error" or ($task.phase // "") == "error" then "recovery_failure"
          elif ($task.status // "") == "merged" or ($task.lifecycle.workflowOutcome // "") == "merged" then "pr_merged"
          else "pr_closed_unmerged"
          end
      ' "$STATE_FILE" 2>/dev/null || printf 'pr_closed_unmerged\n')"
      wavemill_reconcile_terminal "$session" "$issue" "$reason" "$pr"
      ;;
  esac
}

startup_preflight_report_write() {
  local state_file="$1" run_epoch="$2" started_at="$3" completed_at="$4" entries_json="$5" network_json="$6"
  local state_dir report tmp
  state_dir="$(dirname "$state_file")"
  report="$state_dir/startup-preflight.json"
  tmp="$(mktemp "$state_dir/.startup-preflight.XXXXXX")" || return 0
  jq -n \
    --arg runEpoch "$run_epoch" \
    --arg startedAt "$started_at" \
    --arg completedAt "$completed_at" \
    --argjson entries "$entries_json" \
    --argjson networkEpisode "$network_json" \
    '{runEpoch:$runEpoch, startedAt:$startedAt, completedAt:$completedAt, entries:$entries}
     + (if ($networkEpisode.issues // [] | length) > 0 then {networkEpisode:$networkEpisode} else {} end)' >"$tmp" 2>/dev/null \
    && mv "$tmp" "$report" 2>/dev/null || rm -f "$tmp" 2>/dev/null || true
}

wavemill_startup_terminal_preflight() {
  local state_file="$1" session="$2" run_epoch started_at completed_at entries issues issue entry_json pr role pair_id sibling_key sibling_pr sibling_state
  local pr_state pr_merged_at verdict reason entries_json='{}' network_issues='[]' network_json='{}'
  [[ -n "$state_file" && -f "$state_file" ]] || return 0
  run_epoch="$(startup_preflight_run_epoch)"
  [[ -n "$run_epoch" ]] || run_epoch="$(date -u +%Y%m%dT%H%M%SZ)-$$"
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  startup_preflight_stamp_run_epoch "$state_file" "$run_epoch"

  issues="$(jq -r '(.tasks // {}) | keys[]' "$state_file" 2>/dev/null || true)"
  while IFS= read -r issue; do
    [[ -n "$issue" ]] || continue
    entry_json="$(jq -c --arg issue "$issue" '.tasks[$issue] // {}' "$state_file" 2>/dev/null || printf '{}')"
    pr="$(jq -r '.pr // .lifecycle.deliveryEvidence.prNumber // empty' <<<"$entry_json" 2>/dev/null || true)"
    pr_state=""
    pr_merged_at=""
    if [[ -n "$pr" ]]; then
      if startup_preflight_resolve_pr_evidence "$pr"; then
        pr_state="$WAVEMILL_STARTUP_PREFLIGHT_PR_STATE"
        pr_merged_at="$WAVEMILL_STARTUP_PREFLIGHT_PR_MERGED_AT"
      else
        pr_state="UNKNOWN"
      fi
    fi

    role="$(jq -r '.challengeRole // empty' <<<"$entry_json" 2>/dev/null || true)"
    pair_id="$(jq -r '.challengePairId // empty' <<<"$entry_json" 2>/dev/null || true)"
    sibling_state=""
    if [[ "$role" == "challenger" && -n "$pair_id" ]]; then
      sibling_key="$pair_id"
      sibling_pr="$(jq -r --arg sibling "$sibling_key" '.tasks[$sibling].pr // .tasks[$sibling].lifecycle.deliveryEvidence.prNumber // empty' "$state_file" 2>/dev/null || true)"
      if [[ -n "$sibling_pr" ]]; then
        startup_preflight_resolve_pr_evidence "$sibling_pr" >/dev/null 2>&1 || true
        sibling_state="$WAVEMILL_STARTUP_PREFLIGHT_PR_STATE"
      fi
    fi

    entry_json="$(jq -c \
      --arg prState "$pr_state" \
      --arg prMergedAt "$pr_merged_at" \
      --arg siblingState "$sibling_state" \
      '. + {
        __startupPreflightPrState: $prState,
        __startupPreflightPrMergedAt: $prMergedAt,
        __startupPreflightSiblingPrState: $siblingState
      }' <<<"$entry_json" 2>/dev/null || printf '%s' "$entry_json")"
    verdict="$(startup_preflight_classify_entry "$entry_json")"
    reason="${verdict#*:}"
    [[ "$reason" == "$verdict" ]] && reason="$verdict"
    startup_preflight_stamp_entry "$state_file" "$issue" "$verdict" "$reason" "${pr_state:-}" "$run_epoch"

    case "$verdict" in
      terminal:*|superseded)
        startup_preflight_reconcile_entry "$session" "$issue" "$verdict" "$pr" >/dev/null 2>&1 || true
        ;;
      unverified:network)
        network_issues="$(jq -c --arg issue "$issue" '. + [$issue]' <<<"$network_issues" 2>/dev/null || printf '[]')"
        ;;
    esac

    entries_json="$(jq -c \
      --arg issue "$issue" \
      --arg verdict "$verdict" \
      --arg reason "$reason" \
      --arg prState "${pr_state:-}" \
      '. + {($issue): {verdict:$verdict, reason:$reason, prState:$prState}}' <<<"$entries_json" 2>/dev/null || printf '{}')"
  done <<<"$issues"

  if [[ "$(jq -r 'length' <<<"$network_issues" 2>/dev/null || echo 0)" != "0" ]]; then
    local affected
    affected="$(jq -r 'join(", ")' <<<"$network_issues" 2>/dev/null || true)"
    declare -F log_warn >/dev/null 2>&1 && log_warn "Startup terminal preflight could not verify PR state for: $affected. Network/API unavailable; preserved task state." || true
    network_json="$(jq -cn --argjson issues "$network_issues" '{issues:$issues, reason:"github-pr-state-unavailable"}')"
  fi
  completed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  startup_preflight_report_write "$state_file" "$run_epoch" "$started_at" "$completed_at" "$entries_json" "$network_json"
  return 0
}

startup_preflight_task_blocks_restore() {
  local issue="$1"
  [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" && -n "$issue" ]] || return 1
  jq -e --arg issue "$issue" "$(task_lifecycle_jq_filter '
    (.tasks[$issue] // {}) as $task
    | (($task | wm_workflow_outcome) != "active")
      or ($task | wm_terminal_status)
      or (($task.startupPreflight.verdict // "") | startswith("verification-required"))
  ')" "$STATE_FILE" >/dev/null 2>&1
}

startup_preflight_restore_terminal_reason() {
  local issue="$1"
  jq -r --arg issue "$issue" '
    (.tasks[$issue] // {}) as $task
    | if ($task.status // "") == "superseded" or ($task.phase // "") == "superseded" then "challenge_superseded"
      elif ($task.status // "") == "aborted" or ($task.phase // "") == "aborted" then "operator_abort"
      elif ($task.status // "") == "error" or ($task.phase // "") == "error" then "recovery_failure"
      elif ($task.status // "") == "merged" or ($task.lifecycle.workflowOutcome // "") == "merged" then "pr_merged"
      elif (($task.startupPreflight.verdict // "") | startswith("verification-required")) then "recovery_failure"
      else "pr_closed_unmerged"
      end
  ' "$STATE_FILE" 2>/dev/null || printf 'recovery_failure\n'
}
