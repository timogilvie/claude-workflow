#!/usr/bin/env bash
# Queue planner health state and lifecycle helpers.

QUEUE_HEALTH_VERSION=1
QUEUE_HEALTH_TIMEOUT_DEFAULT=120
QUEUE_HEALTH_TIMEOUT_MIN=10
QUEUE_HEALTH_TIMEOUT_MAX=600
QUEUE_HEALTH_BACKOFF_BASE_DEFAULT=60
QUEUE_HEALTH_BACKOFF_CAP_MULTIPLIER=8

queue_health_state_root() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  if [[ -n "${WAVEMILL_QUEUE_HEALTH_STATE_DIR:-}" ]]; then
    printf '%s\n' "$WAVEMILL_QUEUE_HEALTH_STATE_DIR"
    return 0
  fi
  printf '%s\n' "$repo_dir/.wavemill/state"
}

queue_health_state_file() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  printf '%s\n' "$(queue_health_state_root "$repo_dir")/queue-health.json"
}

queue_health_events_file() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}"
  printf '%s\n' "$(queue_health_state_root "$repo_dir")/queue-health-events.jsonl"
}

queue_health_default_record() {
  jq -cn --argjson version "$QUEUE_HEALTH_VERSION" '{
    version: $version,
    status: "healthy_unknown",
    reason: "",
    detail: "",
    last_success_epoch: 0,
    last_success_iso: "",
    last_failure_epoch: 0,
    last_seen_epoch: 0,
    consecutive_failures: 0,
    backoff: {
      base_seconds: 0,
      cap_seconds: 0,
      next_retry_epoch: 0,
      delay_seconds: 0
    },
    planner: {
      command: [],
      pid: 0,
      pgid: 0,
      timeout_seconds: 0,
      elapsed_seconds: 0,
      exit_code: 0,
      signal: "",
      signal_source: "none",
      stderr_excerpt: "",
      stdout_excerpt: "",
      input_snapshot_hash: "",
      dependency_graph_hash: ""
    },
    incident: {
      key: "",
      first_seen_epoch: 0,
      last_seen_epoch: 0,
      last_event: ""
    },
    next_action: ""
  }'
}

queue_health_ensure_state() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}" state_file tmp
  state_file="$(queue_health_state_file "$repo_dir")"
  mkdir -p "$(dirname "$state_file")"
  if [[ -f "$state_file" ]] && jq -e 'type == "object"' "$state_file" >/dev/null 2>&1; then
    return 0
  fi
  tmp="${state_file}.tmp.$$"
  queue_health_default_record > "$tmp" && mv "$tmp" "$state_file"
}

queue_health_read() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}" state_file
  state_file="$(queue_health_state_file "$repo_dir")"
  if [[ -f "$state_file" ]] && jq -e 'type == "object"' "$state_file" >/dev/null 2>&1; then
    jq -c '
      {
        version: (.version // 1),
        status: (.status // "healthy_unknown"),
        reason: (.reason // ""),
        detail: (.detail // ""),
        last_success_epoch: (.last_success_epoch // 0),
        last_success_iso: (.last_success_iso // ""),
        last_failure_epoch: (.last_failure_epoch // 0),
        last_seen_epoch: (.last_seen_epoch // 0),
        consecutive_failures: (.consecutive_failures // 0),
        backoff: {
          base_seconds: (.backoff.base_seconds // 0),
          cap_seconds: (.backoff.cap_seconds // 0),
          next_retry_epoch: (.backoff.next_retry_epoch // 0),
          delay_seconds: (.backoff.delay_seconds // 0)
        },
        planner: {
          command: (.planner.command // []),
          pid: (.planner.pid // 0),
          pgid: (.planner.pgid // 0),
          timeout_seconds: (.planner.timeout_seconds // 0),
          elapsed_seconds: (.planner.elapsed_seconds // 0),
          exit_code: (.planner.exit_code // 0),
          signal: (.planner.signal // ""),
          signal_source: (.planner.signal_source // "none"),
          stderr_excerpt: (.planner.stderr_excerpt // ""),
          stdout_excerpt: (.planner.stdout_excerpt // ""),
          input_snapshot_hash: (.planner.input_snapshot_hash // ""),
          dependency_graph_hash: (.planner.dependency_graph_hash // "")
        },
        incident: {
          key: (.incident.key // ""),
          first_seen_epoch: (.incident.first_seen_epoch // 0),
          last_seen_epoch: (.incident.last_seen_epoch // 0),
          last_event: (.incident.last_event // "")
        },
        next_action: (.next_action // "")
      }' "$state_file"
    return 0
  fi
  queue_health_default_record | jq -c .
}

queue_health_now_epoch() {
  printf '%s\n' "${WAVEMILL_QUEUE_HEALTH_NOW:-$(date +%s)}"
}

queue_health_iso_now() {
  local now="${1:-$(queue_health_now_epoch)}"
  date -u -r "$now" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u -d "@$now" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
    || date -u +"%Y-%m-%dT%H:%M:%SZ"
}

queue_health_timeout_seconds() {
  local raw="${WAVEMILL_QUEUE_PLAN_TIMEOUT_SECONDS:-}"
  if [[ -z "$raw" ]]; then
    printf '%s\n' "$QUEUE_HEALTH_TIMEOUT_DEFAULT"
    return 0
  fi
  if [[ "$raw" =~ ^[0-9]+$ ]] \
    && (( raw >= QUEUE_HEALTH_TIMEOUT_MIN )) \
    && (( raw <= QUEUE_HEALTH_TIMEOUT_MAX )); then
    printf '%s\n' "$raw"
    return 0
  fi
  if [[ "${__WAVEMILL_QUEUE_PLAN_TIMEOUT_INVALID_WARNED:-false}" != "true" ]]; then
    if declare -F warn_once_per_session >/dev/null 2>&1; then
      warn_once_per_session "queue-plan-timeout-invalid:$raw" \
        "Invalid WAVEMILL_QUEUE_PLAN_TIMEOUT_SECONDS=$raw; using ${QUEUE_HEALTH_TIMEOUT_DEFAULT}s"
    elif declare -F log_warn >/dev/null 2>&1; then
      log_warn "Invalid WAVEMILL_QUEUE_PLAN_TIMEOUT_SECONDS=$raw; using ${QUEUE_HEALTH_TIMEOUT_DEFAULT}s"
    fi
    __WAVEMILL_QUEUE_PLAN_TIMEOUT_INVALID_WARNED=true
  fi
  printf '%s\n' "$QUEUE_HEALTH_TIMEOUT_DEFAULT"
}

queue_health_backoff_base_seconds() {
  local base="${BACKLOG_CACHE_TTL:-$QUEUE_HEALTH_BACKOFF_BASE_DEFAULT}"
  [[ "$base" =~ ^[0-9]+$ && "$base" -gt 0 ]] || base="$QUEUE_HEALTH_BACKOFF_BASE_DEFAULT"
  printf '%s\n' "$base"
}

queue_health_redact_and_bound() {
  local file="$1" limit="${2:-4096}"
  [[ -r "$file" ]] || return 0
  LC_ALL=C head -c "$limit" "$file" 2>/dev/null \
    | perl -0777 -pe 's/((?:api[_-]?key|token|secret|password|authorization)[[:space:]]*[:=][[:space:]]*)[^[:space:],"'\'';]+/${1}[REDACTED]/ig; s/(Bearer[[:space:]]+)[A-Za-z0-9._~+\/=-]+/${1}[REDACTED]/ig'
}

queue_health_classify_exit() {
  local exit_code="${1:-1}" deadline_hit="${2:-false}" stderr_file="${3:-}" lowered=""
  if [[ "$deadline_hit" == "true" ]]; then
    printf 'timeout\n'
    return 0
  fi
  if [[ -r "$stderr_file" ]]; then
    lowered="$(tr '[:upper:]' '[:lower:]' < "$stderr_file" 2>/dev/null | head -c 4096)"
  fi
  if [[ "$lowered" == *malformed* || "$lowered" == *invalid\ graph* || "$lowered" == *cycle* || "$lowered" == *parse\ error* ]]; then
    printf 'malformed_graph\n'
    return 0
  fi
  if [[ "$lowered" == *cache* || "$lowered" == *refresh* ]]; then
    printf 'cache_refresh_failed\n'
    return 0
  fi
  case "$exit_code" in
    143|137) printf 'external_cancellation\n' ;;
    124) printf 'timeout\n' ;;
    *) printf 'dependency_planning_failed\n' ;;
  esac
}

queue_health_reason_for_cause() {
  case "${1:-}" in
    timeout) printf 'queue_plan_timeout\n' ;;
    external_cancellation) printf 'queue_plan_external_cancellation\n' ;;
    malformed_graph|invalid_input) printf 'invalid_input\n' ;;
    planner_crash) printf 'planner_crash\n' ;;
    cache_refresh_failed) printf 'cache_refresh_failed\n' ;;
    empty_queue) printf 'empty_queue\n' ;;
    *) printf 'dependency_planning_failed\n' ;;
  esac
}

queue_health_event_append() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}" status="$2" reason="$3" metadata_json="${4:-}"
  local events_file session now first_seen incident_key tmp_event
  [[ -n "$metadata_json" ]] || metadata_json="{}"
  events_file="$(queue_health_events_file "$repo_dir")"
  mkdir -p "$(dirname "$events_file")"
  session="${SESSION:-unknown}"
  now="$(queue_health_now_epoch)"
  first_seen="$(jq -r '.first_seen_epoch // .last_failure_epoch // 0' <<<"$metadata_json" 2>/dev/null || echo 0)"
  [[ "$first_seen" =~ ^[0-9]+$ && "$first_seen" -gt 0 ]] || first_seen="$now"
  incident_key="queue-plan-degraded:${session}:${reason}"
  tmp_event="$(jq -cn \
    --arg status "$status" \
    --arg incident_key "$incident_key" \
    --arg session "$session" \
    --arg reason "$reason" \
    --argjson now "$now" \
    --argjson first_seen "$first_seen" \
    --argjson metadata "$metadata_json" '
      {
        schema_version: 1,
        type: "queue_health_condition",
        status: $status,
        incident_key: $incident_key,
        session: $session,
        reason: $reason,
        cause: ($metadata.cause // ""),
        first_seen_epoch: $first_seen,
        last_seen_epoch: $now,
        next_retry_epoch: ($metadata.next_retry_epoch // 0),
        planner: {
          pid: ($metadata.pid // 0),
          pgid: ($metadata.pgid // 0),
          exit_code: ($metadata.exit_code // 0),
          timeout_seconds: ($metadata.timeout_seconds // 0),
          elapsed_seconds: ($metadata.elapsed_seconds // 0)
        },
        input_snapshot_hash: ($metadata.input_snapshot_hash // ""),
        dependency_graph_hash: ($metadata.dependency_graph_hash // "")
      }')" || return 0
  printf '%s\n' "$tmp_event" >> "$events_file" 2>/dev/null || {
    if declare -F log_warn >/dev/null 2>&1; then
      log_warn "queue health event append failed: $events_file"
    fi
  }
}

queue_health_record_success() {
  local metadata_json="${1:-}" repo_dir="${2:-${REPO_DIR:-$PWD}}" state_file prior_status prior_reason now iso
  [[ -n "$metadata_json" ]] || metadata_json="{}"
  queue_health_ensure_state "$repo_dir" || return 0
  state_file="$(queue_health_state_file "$repo_dir")"
  prior_status="$(jq -r '.status // "healthy_unknown"' "$state_file" 2>/dev/null || echo healthy_unknown)"
  prior_reason="$(jq -r '.reason // ""' "$state_file" 2>/dev/null || echo "")"
  now="$(queue_health_now_epoch)"
  iso="$(queue_health_iso_now "$now")"
  state_mutate "$state_file" '
    .version = 1
    | .status = "healthy"
    | .reason = ""
    | .detail = ""
    | .last_success_epoch = $now
    | .last_success_iso = $iso
    | .last_seen_epoch = $now
    | .consecutive_failures = 0
    | .backoff = {base_seconds: 0, cap_seconds: 0, next_retry_epoch: 0, delay_seconds: 0}
    | .planner = {
        command: ($metadata.command // []),
        pid: ($metadata.pid // 0),
        pgid: ($metadata.pgid // 0),
        timeout_seconds: ($metadata.timeout_seconds // 0),
        elapsed_seconds: ($metadata.elapsed_seconds // 0),
        exit_code: 0,
        signal: "",
        signal_source: "none",
        stderr_excerpt: ($metadata.stderr_excerpt // ""),
        stdout_excerpt: "",
        input_snapshot_hash: ($metadata.input_snapshot_hash // ""),
        dependency_graph_hash: ($metadata.dependency_graph_hash // "")
      }
    | .incident.last_seen_epoch = $now
    | .incident.last_event = "resolved"
    | .next_action = ""
  ' --argjson now "$now" --arg iso "$iso" --argjson metadata "$metadata_json" >/dev/null || return 0
  if [[ "$prior_status" == "degraded" ]]; then
    queue_health_event_append "$repo_dir" "resolved" "$prior_reason" "$metadata_json"
  fi
}

queue_health_record_failure() {
  local cause="$1" metadata_json="${2:-}" repo_dir="${3:-${REPO_DIR:-$PWD}}"
  local state_file prior_status prior_reason reason now failures base cap exp delay next_retry detail first_seen
  [[ -n "$metadata_json" ]] || metadata_json="{}"
  queue_health_ensure_state "$repo_dir" || return 0
  state_file="$(queue_health_state_file "$repo_dir")"
  prior_status="$(jq -r '.status // "healthy_unknown"' "$state_file" 2>/dev/null || echo healthy_unknown)"
  prior_reason="$(jq -r '.reason // ""' "$state_file" 2>/dev/null || echo "")"
  reason="$(queue_health_reason_for_cause "$cause")"
  now="$(queue_health_now_epoch)"
  failures="$(jq -r '.consecutive_failures // 0' "$state_file" 2>/dev/null || echo 0)"
  [[ "$failures" =~ ^[0-9]+$ ]] || failures=0
  failures=$((failures + 1))
  base="$(queue_health_backoff_base_seconds)"
  cap=$((base * QUEUE_HEALTH_BACKOFF_CAP_MULTIPLIER))
  exp=$((failures - 1))
  (( exp > 3 )) && exp=3
  delay=$((base * (1 << exp)))
  (( delay > cap )) && delay="$cap"
  next_retry=$((now + delay))
  detail="$(jq -r '.detail // .stderr_excerpt // ""' <<<"$metadata_json" 2>/dev/null | tr '\n' ' ' | head -c 512)"
  first_seen="$(jq -r '.incident.first_seen_epoch // 0' "$state_file" 2>/dev/null || echo 0)"
  if [[ "$prior_status" != "degraded" || "$prior_reason" != "$reason" || ! "$first_seen" =~ ^[0-9]+$ || "$first_seen" -eq 0 ]]; then
    first_seen="$now"
  fi

  state_mutate "$state_file" '
    .version = 1
    | .status = "degraded"
    | .reason = $reason
    | .detail = $detail
    | .last_failure_epoch = $now
    | .last_seen_epoch = $now
    | .consecutive_failures = $failures
    | .backoff = {base_seconds: $base, cap_seconds: $cap, next_retry_epoch: $next_retry, delay_seconds: $delay}
    | .planner = {
        command: ($metadata.command // []),
        pid: ($metadata.pid // 0),
        pgid: ($metadata.pgid // 0),
        timeout_seconds: ($metadata.timeout_seconds // 0),
        elapsed_seconds: ($metadata.elapsed_seconds // 0),
        exit_code: ($metadata.exit_code // 0),
        signal: ($metadata.signal // ""),
        signal_source: ($metadata.signal_source // "unknown"),
        stderr_excerpt: ($metadata.stderr_excerpt // ""),
        stdout_excerpt: ($metadata.stdout_excerpt // ""),
        input_snapshot_hash: ($metadata.input_snapshot_hash // ""),
        dependency_graph_hash: ($metadata.dependency_graph_hash // "")
      }
    | .incident = {
        key: ("queue-plan-degraded:" + $session + ":" + $reason),
        first_seen_epoch: $first_seen,
        last_seen_epoch: $now,
        last_event: "degraded"
      }
    | .next_action = ("retry at " + ($next_retry | todate))
  ' \
    --arg reason "$reason" \
    --arg detail "$detail" \
    --arg session "${SESSION:-unknown}" \
    --argjson now "$now" \
    --argjson failures "$failures" \
    --argjson base "$base" \
    --argjson cap "$cap" \
    --argjson delay "$delay" \
    --argjson next_retry "$next_retry" \
    --argjson first_seen "$first_seen" \
    --argjson metadata "$metadata_json" >/dev/null || return 0

  if [[ "$prior_status" != "degraded" || "$prior_reason" != "$reason" ]]; then
    queue_health_event_append "$repo_dir" "degraded" "$reason" \
      "$(jq -c --arg cause "$cause" --argjson next_retry "$next_retry" --argjson first_seen "$first_seen" \
        '. + {cause: $cause, next_retry_epoch: $next_retry, first_seen_epoch: $first_seen}' <<<"$metadata_json")"
  fi
}

queue_health_should_retry_now() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}" record status next_retry now
  record="$(queue_health_read "$repo_dir")"
  status="$(jq -r '.status // "healthy_unknown"' <<<"$record")"
  [[ "$status" == "degraded" ]] || return 0
  next_retry="$(jq -r '.backoff.next_retry_epoch // 0' <<<"$record")"
  now="$(queue_health_now_epoch)"
  [[ "$next_retry" =~ ^[0-9]+$ ]] || return 0
  (( now >= next_retry ))
}

queue_health_is_degraded() {
  local repo_dir="${1:-${REPO_DIR:-$PWD}}" status
  status="$(queue_health_read "$repo_dir" | jq -r '.status // "healthy_unknown"')"
  [[ "$status" == "degraded" ]]
}

queue_health_hash_text() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
  else
    cksum | awk '{print $1}'
  fi
}

queue_health_filter_dependency_safe_flat_candidates() {
  local available="$1" backlog_json="$2" safe_ids
  [[ -n "$available" ]] || return 0
  if [[ -z "$backlog_json" ]] || ! jq empty <<<"$backlog_json" >/dev/null 2>&1; then
    return 0
  fi
  safe_ids="$(jq -r '
    .[]
    | select(
        ((.inverseRelations.nodes // []) | map(select(.type == "blocks")) | length) == 0
        and ((.relations.nodes // []) | map(select(.type == "blocks")) | length) == 0
        and ((.sharedSurface // []) | length) == 0
      )
    | .identifier
  ' <<<"$backlog_json" 2>/dev/null || true)"
  awk -F'|' -v ids="$safe_ids" '
    BEGIN {
      split(ids, a, "\n")
      for (i in a) if (a[i] != "") safe[a[i]] = 1
    }
    ($6 == "" || $6 == 0) && safe[$1] { print }
  ' <<<"$available"
}

queue_health_dependency_held_count() {
  local available="$1" backlog_json="$2" safe count_all count_safe
  [[ -n "$available" ]] || { printf '0\n'; return 0; }
  safe="$(queue_health_filter_dependency_safe_flat_candidates "$available" "$backlog_json")"
  count_all="$(awk -F'|' '($6 == "" || $6 == 0) { c++ } END { print c + 0 }' <<<"$available")"
  count_safe="$(grep -c . <<<"$safe" 2>/dev/null || true)"
  printf '%s\n' "$((count_all - count_safe))"
}
