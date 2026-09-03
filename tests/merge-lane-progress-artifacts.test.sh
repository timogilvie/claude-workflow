#!/usr/bin/env bash
# HOK-2919: merge-lane progress telemetry mirrored into ready queue artifacts.
#
# Verifies that lane_progress_patch_json surfaces the tend-side lane-progress
# record, that promote_merge_candidate stamps lastProgressAt/laneWaitSeconds,
# and that the telemetry fields persist across subsequent artifact refreshes
# (a later CI-status patch must not clobber them).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MONITOR_FILE="$REPO_ROOT/shared/lib/wavemill-monitor.sh"

PASS=0
FAIL=0
pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

TEST_TMP="$(mktemp -d)"
trap 'rm -rf "$TEST_TMP"' EXIT

extract_function() {
  local source_file="$1"
  local function_name="$2"
  awk -v name="$function_name" '
    function brace_delta(line, opened, closed) {
      opened = gsub(/\{/, "{", line)
      closed = gsub(/\}/, "}", line)
      return opened - closed
    }

    $0 ~ "^" name "\\(\\) \\{" {
      capture=1
      depth=0
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

FUNC_FILE="$TEST_TMP/merge-lane-progress-funcs.sh"
{
  extract_function "$MONITOR_FILE" "lane_progress_patch_json"
  extract_function "$MONITOR_FILE" "ready_queue_field"
  extract_function "$MONITOR_FILE" "write_ready_queue_artifacts"
  extract_function "$MONITOR_FILE" "promote_merge_candidate"
  extract_function "$MONITOR_FILE" "wavemill_run_tsx_tool"
} > "$FUNC_FILE"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$REPO_ROOT/shared/lib/wavemill-common.sh"
# shellcheck disable=SC1090
source "$FUNC_FILE"
log_warn() { echo "warn: $*" >&2; }

REPO_DIR="$TEST_TMP/repo"
TOOLS_DIR="$REPO_ROOT/tools"
STATE_DIR="$TEST_TMP/repo/features/test-slug"
mkdir -p "$STATE_DIR" "$REPO_DIR/.wavemill/merge-lane/42"

# Seed a completed ready result with a known finishedAt for laneWaitSeconds.
node --import tsx "$TOOLS_DIR/stage-result-cli.ts" write "$STATE_DIR" ready completed \
  --artifacts '{"type":"ready","verdict":"pass","prNumber":42}' \
  --finished-at "$(date -u -v-10M +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d '10 minutes ago' +"%Y-%m-%dT%H:%M:%SZ")" \
  >/dev/null

# --- lane_progress_patch_json ---
if [[ "$(lane_progress_patch_json 42)" == "{}" ]]; then
  pass "lane_progress_patch_json emits {} when no progress record exists"
else
  fail "lane_progress_patch_json emitted a patch without a record"
fi

cat > "$REPO_DIR/.wavemill/merge-lane/42/progress.json" <<'JSON'
{
  "prNumber": 42,
  "enteredLaneAt": "2026-08-28T12:10:00Z",
  "lastProgressAt": "2026-08-28T12:30:00Z",
  "lastEvent": "stale-base-refresh",
  "laneWaitSeconds": 600,
  "laneHoldSeconds": 1200,
  "rebaseCount": 2,
  "ciRestartCount": 2,
  "mergeAttemptCount": 1
}
JSON

patch="$(lane_progress_patch_json 42)"
if [[ "$(jq -r '.rebaseCount' <<< "$patch")" == "2" \
  && "$(jq -r '.ciRestartCount' <<< "$patch")" == "2" \
  && "$(jq -r '.laneHoldSeconds' <<< "$patch")" == "1200" \
  && "$(jq -r '.lastProgressAt' <<< "$patch")" == "2026-08-28T12:30:00Z" ]]; then
  pass "lane_progress_patch_json mirrors the tend lane-progress record"
else
  echo "    patch: $patch"
  fail "lane_progress_patch_json lost telemetry fields"
fi

if [[ "$(lane_progress_patch_json "")" == "{}" ]]; then
  pass "lane_progress_patch_json fails closed on an empty PR number"
else
  fail "lane_progress_patch_json emitted a patch for an empty PR number"
fi

# --- promote_merge_candidate stamps progress telemetry ---
promote_merge_candidate "HOK-9999" "$STATE_DIR" "new-base-sha"
last_progress_at="$(ready_queue_field "$STATE_DIR" lastProgressAt)"
lane_wait_seconds="$(ready_queue_field "$STATE_DIR" laneWaitSeconds)"
if [[ -n "$last_progress_at" ]]; then
  pass "promote_merge_candidate stamps lastProgressAt"
else
  fail "promote_merge_candidate did not stamp lastProgressAt"
fi
if [[ "$lane_wait_seconds" =~ ^[0-9]+$ ]] && (( lane_wait_seconds >= 540 && lane_wait_seconds <= 900 )); then
  pass "promote_merge_candidate computes laneWaitSeconds from the ready verdict time"
else
  echo "    laneWaitSeconds: $lane_wait_seconds"
  fail "promote_merge_candidate laneWaitSeconds missing or implausible"
fi

# --- telemetry persists across a later refresh patch ---
write_ready_queue_artifacts "$STATE_DIR" "$patch"
write_ready_queue_artifacts "$STATE_DIR" '{"lastCiConclusion":"pass","lastCiSummary":"pass: 16/3 checks"}'
if [[ "$(ready_queue_field "$STATE_DIR" rebaseCount)" == "2" \
  && "$(ready_queue_field "$STATE_DIR" ciRestartCount)" == "2" \
  && "$(ready_queue_field "$STATE_DIR" laneHoldSeconds)" == "1200" \
  && "$(ready_queue_field "$STATE_DIR" lastCiConclusion)" == "pass" ]]; then
  pass "lane telemetry persists across subsequent artifact refreshes"
else
  fail "a later artifact patch clobbered the lane telemetry"
fi

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"
if (( FAIL > 0 )); then
  exit 1
fi
