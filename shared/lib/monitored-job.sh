#!/bin/bash

# Background job tracking for challenge eval and comparison.
# State persisted in .wavemill/state/monitored-jobs.json.
# Logs and exit sentinels in .wavemill/logs/jobs/.
#
# Exit sentinel: <log-stem>.exit  – written by child with numeric exit code
# Timeout: SIGTERM sent to the child PID; record transitions to timed_out

_mj_state_file() { echo "${REPO_DIR:-.}/.wavemill/state/monitored-jobs.json"; }
_mj_log_dir()    { echo "${REPO_DIR:-.}/.wavemill/logs/jobs"; }

# Ensure state file and log dir exist
_mj_init() {
  local sf ld
  sf=$(_mj_state_file)
  ld=$(_mj_log_dir)
  mkdir -p "$(dirname "$sf")" "$ld"
  [[ -f "$sf" ]] || echo '{"jobs":{}}' > "$sf"
}

# Read a single job record as JSON (empty if not found)
mj_get() {
  local job_id="$1" sf
  sf=$(_mj_state_file)
  jq --arg id "$job_id" '.jobs[$id] // empty' < "$sf" 2>/dev/null
}

mj_status() {
  local job_id="$1" rec
  rec=$(mj_get "$job_id")
  [[ -z "$rec" ]] && echo "unknown" && return 0
  printf '%s' "$rec" | jq -r '.status // "unknown"' 2>/dev/null || echo "unknown"
}

mj_is_terminal() {
  local s
  s=$(mj_status "$1")
  [[ "$s" == "succeeded" || "$s" == "failed" || "$s" == "timed_out" ]]
}

# Launch a background job.
# Usage: mj_launch <kind> <job_id> <timeout_seconds> [extra_json_args] -- <cmd> [args...]
# extra_json_args is a jq --argjson or --arg string appended to the record, pass "" to skip.
mj_launch() {
  local kind="$1" job_id="$2" timeout_sec="$3" extra_json="$4"
  shift 4
  [[ "$1" == "--" ]] && shift

  _mj_init

  local sf ld now_epoch now_iso log_path exit_path pid
  sf=$(_mj_state_file)
  ld=$(_mj_log_dir)

  # Idempotence: skip if already running
  local cur_status
  cur_status=$(mj_status "$job_id")
  if [[ "$cur_status" == "running" ]]; then
    log "debug" "  mj_launch: job already running: $job_id" 2>/dev/null || true
    return 0
  fi

  now_epoch=$(date +%s)
  now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Sanitize job_id for use in filenames (colons → dashes)
  local safe_id
  safe_id=$(printf '%s' "$job_id" | tr ':/' '--')
  log_path="$ld/${safe_id}-${now_epoch}.log"
  exit_path="${log_path%.log}.exit"

  # Spawn child: redirect stdout+stderr to log, write exit code to sentinel.
  # set +e ensures the sentinel is always written even when "$@" exits non-zero.
  (
    set +e
    {
      "$@" 2>&1
      printf '%s\n' "$?" > "$exit_path"
    } > "$log_path" 2>&1
  ) &
  pid=$!

  # Build the base record; merge optional extra_json fields
  local base_rec extra_rec merged_rec
  base_rec=$(jq -n \
    --arg id      "$job_id" \
    --arg kind    "$kind" \
    --argjson pid "$pid" \
    --arg sa      "$now_iso" \
    --arg lp      "$log_path" \
    --argjson ts  "$timeout_sec" \
    '{
      id: $id, kind: $kind, pid: $pid,
      started_at: $sa, log_path: $lp,
      timeout_seconds: $ts,
      status: "running", exit_code: null,
      finished_at: null, reaped: false
    }')

  if [[ -n "$extra_json" ]]; then
    merged_rec=$(jq -s '.[0] * .[1]' <(echo "$base_rec") <(echo "$extra_json") 2>/dev/null || echo "$base_rec")
  else
    merged_rec="$base_rec"
  fi

  if ! state_mutate "$sf" \
    '.jobs[$id] = $rec' \
    --arg id "$job_id" \
    --argjson rec "$merged_rec" 2>/dev/null; then
    log_warn "mj_launch: failed to persist record for $job_id; killing child"
    kill -TERM $pid 2>/dev/null || true
    return 1
  fi

  log "debug" "  mj_launch: started $job_id (pid $pid, log: $log_path)"
}

# ── Polling ──────────────────────────────────────────────────────────────────

# Poll all running jobs; transition states based on sentinel / timeout / liveness
poll_monitored_jobs() {
  local sf ld running now_epoch now_iso
  _mj_init
  sf=$(_mj_state_file)
  ld=$(_mj_log_dir)
  now_epoch=$(date +%s)
  now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

  # Poll running jobs for completion/timeout and timed_out jobs for SIGKILL grace
  local active_jobs
  active_jobs=$(jq -r '.jobs | to_entries[] | select(.value.status == "running" or (.value.status == "timed_out" and (.value.kill_at // 0) > 0)) | .key' < "$sf" 2>/dev/null) || true
  [[ -z "$active_jobs" ]] && return 0

  while IFS= read -r job_id; do
    [[ -z "$job_id" ]] && continue
    local rec pid timeout_sec started_at log_path exit_path elapsed started_epoch status
    rec=$(mj_get "$job_id")
    pid=$(printf '%s' "$rec" | jq -r '.pid')
    status=$(printf '%s' "$rec" | jq -r '.status')
    timeout_sec=$(printf '%s' "$rec" | jq -r '.timeout_seconds // 420')
    started_at=$(printf '%s' "$rec" | jq -r '.started_at // ""')
    log_path=$(printf '%s' "$rec" | jq -r '.log_path // ""')
    exit_path="${log_path%.log}.exit"

    # ── timed_out jobs: SIGKILL grace check only ──
    if [[ "$status" == "timed_out" ]]; then
      local kill_at
      kill_at=$(printf '%s' "$rec" | jq -r '.kill_at // 0')
      if (( now_epoch >= kill_at )) && kill -0 "$pid" 2>/dev/null; then
        log "debug" "  ⏱ job timeout (SIGKILL): $job_id"
        kill -KILL "$pid" 2>/dev/null || true
        state_mutate "$sf" '.jobs[$id].kill_at = null' \
          --arg id "$job_id" 2>/dev/null || true
      fi
      continue
    fi

    # ── Completed: exit sentinel present ──
    if [[ -f "$exit_path" ]]; then
      local code
      code=$(< "$exit_path" tr -d '[:space:]' 2>/dev/null || echo "-1")
      rm -f "$exit_path"

      if [[ "$code" == "0" ]]; then
        state_mutate "$sf" \
          '.jobs[$id].status = "succeeded" | .jobs[$id].exit_code = ($c|tonumber) | .jobs[$id].finished_at = $ts' \
          --arg id "$job_id" --arg c "$code" --arg ts "$now_iso" 2>/dev/null || true
        log "debug" "  ✓ job succeeded: $job_id"
      else
        state_mutate "$sf" \
          '.jobs[$id].status = "failed" | .jobs[$id].exit_code = ($c|tonumber) | .jobs[$id].finished_at = $ts' \
          --arg id "$job_id" --arg c "$code" --arg ts "$now_iso" 2>/dev/null || true
        log "debug" "  ✗ job failed: $job_id (exit $code)"
      fi
      continue
    fi

    # ── Timed out: send SIGTERM, transition to timed_out ──
    started_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$started_at" +%s 2>/dev/null \
                    || date -d "$started_at" +%s 2>/dev/null \
                    || echo "$now_epoch")
    elapsed=$(( now_epoch - started_epoch ))
    if (( elapsed >= timeout_sec )); then
      log "debug" "  ⏱ job timeout (SIGTERM): $job_id (${elapsed}s >= ${timeout_sec}s)"
      kill -TERM "$pid" 2>/dev/null || true
      local kill_epoch=$(( now_epoch + 10 ))
      state_mutate "$sf" \
        '.jobs[$id].status = "timed_out" | .jobs[$id].finished_at = $ts | .jobs[$id].kill_at = ($ka | tonumber)' \
        --arg id "$job_id" --arg ts "$now_iso" --arg ka "$kill_epoch" 2>/dev/null || true
      continue
    fi

    # ── Dead without sentinel ──
    if ! kill -0 "$pid" 2>/dev/null; then
      state_mutate "$sf" \
        '.jobs[$id].status = "failed" | .jobs[$id].exit_code = null | .jobs[$id].finished_at = $ts | .jobs[$id].failure_reason = "no_exit_sentinel"' \
        --arg id "$job_id" --arg ts "$now_iso" 2>/dev/null || true
      log_warn "  ✗ job died without sentinel: $job_id"
      continue
    fi

    log "debug" "  ⧗ job running: $job_id (pid $pid, ${elapsed}s elapsed)"
  done <<< "$active_jobs"
}

# Return the last N lines from a job's log (for failure surfacing)
mj_log_excerpt() {
  local job_id="$1" n="${2:-10}"
  local rec lp
  rec=$(mj_get "$job_id")
  [[ -z "$rec" ]] && return 1
  lp=$(printf '%s' "$rec" | jq -r '.log_path // empty')
  [[ -z "$lp" ]] && return 1
  if [[ -f "$lp" ]]; then
    tail -n "$n" "$lp" 2>/dev/null || echo "<log unreadable>"
  else
    echo "<log not found>"
  fi
}

# ── Reaping ──────────────────────────────────────────────────────────────────

_reap_challenge_eval_jobs() {
  local sf terminal_jobs
  _mj_init
  sf=$(_mj_state_file)

  terminal_jobs=$(jq -r '
    .jobs | to_entries[]
    | select(
        .value.kind == "challenge_eval"
        and (.value.status | test("succeeded|failed|timed_out"))
        and (.value.reaped == false)
      )
    | .key
  ' < "$sf" 2>/dev/null) || true
  [[ -z "$terminal_jobs" ]] && return 0

  while IFS= read -r job_id; do
    [[ -z "$job_id" ]] && continue
    local rec status issue_id side pr linear_issue
    rec=$(mj_get "$job_id")
    status=$(printf '%s' "$rec" | jq -r '.status')
    issue_id=$(printf '%s' "$rec" | jq -r '.issue_id')
    side=$(printf '%s' "$rec" | jq -r '.side // "primary"')
    pr=$(printf '%s' "$rec" | jq -r '.pr_number // ""')
    linear_issue=$(printf '%s' "$rec" | jq -r '.linear_issue // ""')

    log "debug" "  ⊳ reaping challenge_eval: $job_id ($status)"

    if [[ "$status" == "succeeded" ]]; then
      mark_eval_completed "$issue_id"
      log "status" "  ✓ Challenge eval done: $issue_id (side=$side, PR #$pr)"
    else
      if eval_record_exists_for_issue_pr "$linear_issue" "$pr" 2>/dev/null; then
        log_warn "  ⚠ eval $issue_id exited non-zero but record exists; marking evalCompleted=true"
        mark_eval_completed "$issue_id"
      else
        log_warn "  ✗ eval failed: $issue_id ($status); marking evalFailed=true"
        mark_eval_failed "$issue_id"
      fi
      # Surface log excerpt on failure
      local excerpt
      excerpt=$(mj_log_excerpt "$job_id" 5 2>/dev/null || true)
      if [[ -n "$excerpt" ]]; then
        log_warn "  Last log lines for $job_id:"
        while IFS= read -r ln; do log_warn "    $ln"; done <<< "$excerpt"
      fi
    fi

    state_mutate "$sf" '.jobs[$id].reaped = true' --arg id "$job_id" 2>/dev/null || true
  done <<< "$terminal_jobs"
}

_reap_challenge_comparison_jobs() {
  local sf terminal_jobs
  _mj_init
  sf=$(_mj_state_file)

  terminal_jobs=$(jq -r '
    .jobs | to_entries[]
    | select(
        .value.kind == "challenge_comparison"
        and (.value.status | test("succeeded|failed|timed_out"))
        and (.value.reaped == false)
      )
    | .key
  ' < "$sf" 2>/dev/null) || true
  [[ -z "$terminal_jobs" ]] && return 0

  while IFS= read -r job_id; do
    [[ -z "$job_id" ]] && continue
    local rec status pair_id primary_pr challenger_pr
    rec=$(mj_get "$job_id")
    status=$(printf '%s' "$rec" | jq -r '.status')
    pair_id=$(printf '%s' "$rec" | jq -r '.pair_id')
    primary_pr=$(printf '%s' "$rec" | jq -r '.primary_pr_number // ""')
    challenger_pr=$(printf '%s' "$rec" | jq -r '.challenger_pr_number // ""')

    log "debug" "  ⊳ reaping challenge_comparison: $job_id ($status)"

    if [[ "$status" == "succeeded" ]]; then
      log "status" "  ✓ Challenge comparison done: $pair_id (PRs #$primary_pr vs #$challenger_pr)"
      _display_comparison_result "$pair_id" "$primary_pr" "$challenger_pr"
      mark_challenge_compared "$pair_id"
    else
      log_warn "  ✗ Comparison failed: $pair_id ($status); not marking challengeCompared"
      local excerpt
      excerpt=$(mj_log_excerpt "$job_id" 5 2>/dev/null || true)
      if [[ -n "$excerpt" ]]; then
        log_warn "  Last log lines for $job_id:"
        while IFS= read -r ln; do log_warn "    $ln"; done <<< "$excerpt"
      fi
    fi

    state_mutate "$sf" '.jobs[$id].reaped = true' --arg id "$job_id" 2>/dev/null || true
  done <<< "$terminal_jobs"
}

_display_comparison_result() {
  local pair_id="$1" primary_pr="$2" challenger_pr="$3"
  local primary_key="${pair_id}" challenger_key="${pair_id}_c"
  local cjson winner winner_model rationale
  local comp_p comp_c cor_p cor_c qual_p qual_c impact_p impact_c auto_p auto_c
  local primary_eval_score challenger_eval_score

  cjson=$(tail -1 "${REPO_DIR}/.wavemill/evals/challenge-records.jsonl" 2>/dev/null) || true
  [[ -z "$cjson" ]] && { log_warn "No challenge record to display for $pair_id"; return 0; }

  winner=$(printf '%s' "$cjson"            | jq -r '.winner // ""')
  winner_model=$(printf '%s' "$cjson"      | jq -r '.winnerModel // ""')
  rationale=$(printf '%s' "$cjson"         | jq -r '.rationale // ""')
  primary_eval_score=$(printf '%s' "$cjson"    | jq -r '.primaryEvalScore // "—"')
  challenger_eval_score=$(printf '%s' "$cjson" | jq -r '.challengerEvalScore // "—"')
  comp_p=$(printf '%s' "$cjson"    | jq -r '.dimensions.completeness.primary // "—"')
  comp_c=$(printf '%s' "$cjson"    | jq -r '.dimensions.completeness.challenger // "—"')
  cor_p=$(printf '%s' "$cjson"     | jq -r '.dimensions.correctness.primary // "—"')
  cor_c=$(printf '%s' "$cjson"     | jq -r '.dimensions.correctness.challenger // "—"')
  qual_p=$(printf '%s' "$cjson"    | jq -r '.dimensions.code_quality.primary // .dimensions.codeQuality.primary // "—"')
  qual_c=$(printf '%s' "$cjson"    | jq -r '.dimensions.code_quality.challenger // .dimensions.codeQuality.challenger // "—"')
  impact_p=$(printf '%s' "$cjson"  | jq -r '.dimensions.intervention_impact.primary // .dimensions.scopeDiscipline.primary // "—"')
  impact_c=$(printf '%s' "$cjson"  | jq -r '.dimensions.intervention_impact.challenger // .dimensions.scopeDiscipline.challenger // "—"')
  auto_p=$(printf '%s' "$cjson"    | jq -r '.dimensions.autonomy.primary // "—"')
  auto_c=$(printf '%s' "$cjson"    | jq -r '.dimensions.autonomy.challenger // "—"')

  local pm cm wm
  pm=$(get_task_meta "$primary_key"    "challengeModel" | sed 's/-[0-9]\{8\}$//')
  cm=$(get_task_meta "$challenger_key" "challengeModel" | sed 's/-[0-9]\{8\}$//')
  wm=$(printf '%s' "$winner_model" | sed 's/-[0-9]\{8\}$//')

  log "status" ""
  log "status" "  ┌────────────────────────────────────────────────────────────┐"
  log "status" "  │  ⚖  Challenge Comparison: $pair_id"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  log "status" "  │                    Primary            Challenger           │"
  log "status" "  │  Model          $(printf '%-20s' "$pm") $(printf '%-19s' "$cm")│"
  log "status" "  │  PR              #$(printf '%-19s' "$primary_pr") #$(printf '%-18s' "$challenger_pr")│"
  log "status" "  │  Eval Score      $(printf '%-20s' "$primary_eval_score") $(printf '%-19s' "$challenger_eval_score")│"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  log "status" "  │  Completeness    $(printf '%-20s' "$comp_p") $(printf '%-19s' "$comp_c")│"
  log "status" "  │  Correctness     $(printf '%-20s' "$cor_p") $(printf '%-19s' "$cor_c")│"
  log "status" "  │  Code Quality    $(printf '%-20s' "$qual_p") $(printf '%-19s' "$qual_c")│"
  log "status" "  │  Intervention    $(printf '%-20s' "$impact_p") $(printf '%-19s' "$impact_c")│"
  log "status" "  │  Autonomy        $(printf '%-20s' "$auto_p") $(printf '%-19s' "$auto_c")│"
  log "status" "  ├────────────────────────────────────────────────────────────┤"
  if [[ "$winner" == "primary" ]]; then
    log "status" "  │  ★ Winner: Primary ($wm) — PR #$primary_pr"
  else
    log "status" "  │  ★ Winner: Challenger ($wm) — PR #$challenger_pr"
  fi
  log "status" "  │                                                            │"
  printf '%s' "$rationale" | fold -s -w 56 | while IFS= read -r rl; do
    log "status" "  │  $(printf '%-58s' "$rl")│"
  done
  log "status" "  └────────────────────────────────────────────────────────────┘"
  log "status" ""

  # Auto-cleanup loser if enabled
  local loser_key loser_slug loser_pr
  if [[ "$winner" == "primary" ]]; then
    loser_key="$challenger_key"
  elif [[ "$winner" == "challenger" ]]; then
    loser_key="$primary_key"
  fi
  if [[ -n "${loser_key:-}" ]]; then
    loser_slug=$(get_task_meta "$loser_key" "slug")
    loser_pr=$(get_task_meta "$loser_key" "pr")
    if [[ -n "$loser_slug" ]]; then
      if [[ "${CHALLENGE_AUTO_MERGE:-false}" == "true" ]]; then
        log "status" "  ⚖ Auto-merge: cleaning up loser $loser_key"
        if [[ -n "$loser_pr" ]] && [[ "$(pr_state "$loser_pr")" == "OPEN" ]]; then
          gh pr close "$loser_pr" \
            --comment "Closing: lost challenge comparison to ${winner} side." 2>/dev/null || true
          log "status" "  ✓ Closed losing PR #$loser_pr"
        fi
        cleanup_completed_task "$loser_key" "$loser_slug" "challenge loser"
      else
        log "status" "  ⚖ Both PRs remain open for manual review (autoMergeWinner=false)"
      fi
    fi
  fi
}

# Top-level reap entry point called each monitor cycle
reap_completed_challenge_jobs() {
  _reap_challenge_eval_jobs
  _reap_challenge_comparison_jobs
}
