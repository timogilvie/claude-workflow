#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

check_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$label"
  else
    echo "    missing: $needle"
    printf '%s\n' "$haystack" | sed 's/^/      /'
    fail "$label"
  fi
}

check_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$label"
  else
    echo "    expected: $expected"
    echo "    actual:   $actual"
    fail "$label"
  fi
}

extract_function_occurrence() {
  local source_file="$1"
  local function_name="$2"
  local occurrence="$3"
  awk -v name="$function_name" -v target="$occurrence" '
    function brace_delta(line, stripped, opens, closes) {
      stripped = line
      gsub(/"([^"\\]|\\.)*"/, "\"\"", stripped)
      gsub(/\047([^\047\\]|\\.)*\047/, "\047\047", stripped)
      opens = gsub(/\{/, "{", stripped)
      closes = gsub(/\}/, "}", stripped)
      return opens - closes
    }
    $0 ~ "^" name "\\(\\)[[:space:]]*\\{" {
      count++
      if (count == target) {
        capture = 1
        depth = 0
      }
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

FUNCTION_FILE="$TEST_TMP/challenge-hard-failure-functions.sh"
: > "$FUNCTION_FILE"
for fn in \
  mark_challenge_eval_running:1 \
  challenge_eval_hard_failure_max_retries:1 \
  challenge_pair_hard_failure_reason:1 \
  challenge_pair_records_file:1 \
  challenge_pr_url_from_number:1 \
  challenge_pair_record_exists:1 \
  mark_challenge_compared:1 \
  resolve_challenge_pair_hard_failure:1 \
  sanitize_job_token:1 \
  challenge_job_dir:1 \
  build_eval_job_id:1 \
  read_job_state_value:1 \
  launch_tracked_job:1 \
  post_merge_eval_timeout_seconds:1 \
  maybe_run_challenge_eval:1
do
  IFS=: read -r name occurrence <<<"$fn"
  extract_function_occurrence "$MILL_SCRIPT" "$name" "$occurrence" >> "$FUNCTION_FILE"
  printf '\n' >> "$FUNCTION_FILE"
done

if [[ ! -s "$FUNCTION_FILE" ]]; then
  echo "Could not extract hard-failure functions"
  exit 1
fi

cat > "$TEST_TMP/run-case.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

source "$REPO_DIR/shared/lib/wavemill-common.sh"
source "$FUNCTION_FILE"

STATE_FILE="$CASE_DIR/state.json"
REPO_DIR="$CASE_DIR/repo"
WORKTREE_ROOT="$CASE_DIR/worktrees"
TOOLS_DIR="$CASE_DIR/tools"
SESSION="challenge-hard-failure-test"
AGENT_CMD="codex"
LOG_OUTPUT=""
EVAL_LAUNCHES=0
JOB_TRACKER_CALLS=0

mkdir -p "$REPO_DIR" "$WORKTREE_ROOT" "$TOOLS_DIR" "$REPO_DIR/.wavemill/evals"

log() { printf -v LOG_OUTPUT "%s%s\n" "$LOG_OUTPUT" "$2"; }
log_warn() { printf -v LOG_OUTPUT "%sWARN: %s\n" "$LOG_OUTPUT" "$1"; }
get_linear_issue_id() { printf '%s\n' "$1"; }
wavemill_load_config() { printf '%s\n' '{"eval":{"postMergeTimeoutSeconds":600}}'; }

read_state_value() {
  local default="${1:-}"
  shift || true
  local expr="${*: -1}"
  local jq_args=()
  if (( $# > 1 )); then
    jq_args=("${@:1:$#-1}")
  fi
  local result=""
  if result=$(jq -r "${jq_args[@]}" "$expr" "$STATE_FILE" 2>/dev/null); then
    :
  else
    result=""
  fi
  if [[ -z "$result" || "$result" == "null" ]]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$result"
  fi
}

get_task_meta() {
  local issue="$1" field="$2"
  jq -r --arg issue "$issue" --arg field "$field" \
    ".tasks[\$issue][\$field] // empty" "$STATE_FILE"
}

gh() {
  if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
    printf 'https://github.com/example/repo/pull/%s\n' "${3:-0}"
    return 0
  fi
  return 1
}

npx() {
  if [[ "$*" == *"job-tracker.ts"* ]]; then
    JOB_TRACKER_CALLS=$((JOB_TRACKER_CALLS + 1))
    return 0
  fi
  if [[ "$*" == *"resolve-orphan-challenge-pair.ts"* ]]; then
    cat > "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" <<JSON
{"challengePairId":"HOK-2462","primaryModel":"model-a","challengerModel":"unknown","primaryPrUrl":"https://github.com/example/repo/pull/101","challengerPrUrl":"https://github.com/unknown/unknown/pull/0","primaryEvalScore":0,"challengerEvalScore":0,"winner":"primary","winnerModel":"model-a","rationale":"Challenge pair became orphaned before a comparison could be launched; the surviving side wins by forfeit.","dimensions":{"completeness":{"primary":0,"challenger":0},"correctness":{"primary":0,"challenger":0},"code_quality":{"primary":0,"challenger":0},"intervention_impact":{"primary":0,"challenger":0},"autonomy":{"primary":0,"challenger":0}},"timestamp":"2026-07-17T00:00:00Z","comparisonOutcome":"forfeit","terminalReason":"orphan_pair"}
JSON
    printf '%s\n' '{"status":"resolved","reason":"orphan-sibling"}'
    return 0
  fi
  if [[ "$*" == *"run-eval-hook.ts"* ]]; then
    EVAL_LAUNCHES=$((EVAL_LAUNCHES + 1))
    cp "$STATE_FILE" "$CASE_DIR/eval-launch-state.json"
    printf 'eval-command-start\n'
    return 0
  fi
  return 0
}

run_retry_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {
    "eval-HOK-2462-primary-101": {
      "id": "eval-HOK-2462-primary-101",
      "status": "failed"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  wait || true
  printf 'retry_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount // empty' "$STATE_FILE")"
  printf 'retry_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$STATE_FILE")"
  printf 'retry_snapshot_exists=%s\n' "$([[ -f "$CASE_DIR/eval-launch-state.json" ]] && echo true || echo false)"
  printf 'retry_snapshot_failed=%s\n' "$(jq -r '.tasks["HOK-2462"].evalFailed' "$CASE_DIR/eval-launch-state.json")"
  printf 'retry_snapshot_counter=%s\n' "$(jq -r '.tasks["HOK-2462"].evalHardFailureRetryCount' "$CASE_DIR/eval-launch-state.json")"
}

run_exhausted_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": false,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  },
  "jobs": {
    "eval-HOK-2462-primary-101": {
      "id": "eval-HOK-2462-primary-101",
      "status": "failed"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  printf 'terminal_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'terminal_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_winner=%s\n' "$(jq -r '.winner' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'terminal_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'terminal_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
}

run_double_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    },
    "HOK-2462_c": {
      "slug": "hok-2462-c",
      "branch": "task/hok-2462-c",
      "worktree": "$WORKTREE_ROOT/hok-2462-c",
      "pr": "102",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": false,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "challenger",
      "challengeModel": "model-b"
    }
  }
}
JSON

  maybe_run_challenge_eval "HOK-2462" "101" "task/hok-2462" "hok-2462"
  maybe_run_challenge_eval "HOK-2462_c" "102" "task/hok-2462-c" "hok-2462-c"
  printf 'double_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'double_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'double_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'double_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
  printf 'double_compared_challenger=%s\n' "$(jq -r '.tasks["HOK-2462_c"].challengeCompared' "$STATE_FILE")"
}

run_orphan_case() {
  cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-2462": {
      "slug": "hok-2462",
      "branch": "task/hok-2462",
      "worktree": "$WORKTREE_ROOT/hok-2462",
      "pr": "101",
      "status": "ready",
      "agent": "codex",
      "phase": "ready",
      "evalCompleted": true,
      "evalFailed": true,
      "evalHardFailureRetryCount": 2,
      "challengeCompared": false,
      "challenge": true,
      "challengePairId": "HOK-2462",
      "challengeRole": "primary",
      "challengeModel": "model-a"
    }
  }
}
JSON

  resolve_challenge_pair_hard_failure "HOK-2462"
  printf 'orphan_lines=%s\n' "$(wc -l < "$REPO_DIR/.wavemill/evals/challenge-records.jsonl" | tr -d '[:space:]')"
  printf 'orphan_outcome=%s\n' "$(jq -r '.comparisonOutcome' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_reason=%s\n' "$(jq -r '.terminalReason' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_winner=%s\n' "$(jq -r '.winner' "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  printf 'orphan_compared_primary=%s\n' "$(jq -r '.tasks["HOK-2462"].challengeCompared' "$STATE_FILE")"
}

"run_${CASE_NAME}_case"
printf 'eval_launches=%s\n' "$EVAL_LAUNCHES"
printf 'job_tracker_calls=%s\n' "$JOB_TRACKER_CALLS"
printf 'logs=%s\n' "$(printf '%s' "$LOG_OUTPUT" | tr '\n' ';')"
EOF
chmod +x "$TEST_TMP/run-case.sh"

echo "=== Challenge Eval Hard Failure ==="

retry_output="$(CASE_NAME=retry CASE_DIR="$TEST_TMP/retry" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
exhausted_output="$(CASE_NAME=exhausted CASE_DIR="$TEST_TMP/exhausted" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
double_output="$(CASE_NAME=double CASE_DIR="$TEST_TMP/double" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"
orphan_output="$(CASE_NAME=orphan CASE_DIR="$TEST_TMP/orphan" REPO_DIR="$REPO_DIR" FUNCTION_FILE="$FUNCTION_FILE" "$TEST_TMP/run-case.sh")"

check_contains "legacy hard failure defaults retry counter to zero then increments" "$retry_output" "retry_counter=1"
check_contains "hard failure retry clears evalFailed before relaunch" "$retry_output" "retry_failed=false"
check_contains "hard failure retry starts the eval command" "$retry_output" "retry_snapshot_exists=true"
check_contains "hard failure retry snapshot shows cleared evalFailed" "$retry_output" "retry_snapshot_failed=false"
check_contains "hard failure retry snapshot persists incremented counter" "$retry_output" "retry_snapshot_counter=1"
check_contains "hard failure retry still records tracked job launch" "$retry_output" "job_tracker_calls=1"
check_contains "hard failure retry logs retry attempt" "$retry_output" "challenge eval retrying for HOK-2462: hard failure (attempt 1/2)"

check_contains "exhausted hard failure writes exactly one terminal record" "$exhausted_output" "terminal_lines=1"
check_contains "exhausted hard failure writes forfeit outcome" "$exhausted_output" "terminal_outcome=forfeit"
check_contains "exhausted hard failure records machine reason" "$exhausted_output" "terminal_reason=primary_eval_hard_failed"
check_contains "exhausted hard failure awards challenger" "$exhausted_output" "terminal_winner=challenger"
check_contains "exhausted hard failure marks primary compared" "$exhausted_output" "terminal_compared_primary=true"
check_contains "exhausted hard failure marks challenger compared" "$exhausted_output" "terminal_compared_challenger=true"
check_contains "exhausted hard failure does not relaunch eval" "$exhausted_output" "eval_launches=0"

check_contains "double hard failure writes exactly one terminal record" "$double_output" "double_lines=1"
check_contains "double hard failure writes double-forfeit outcome" "$double_output" "double_outcome=double-forfeit"
check_contains "double hard failure records both-side reason" "$double_output" "double_reason=both_eval_hard_failed"
check_contains "double hard failure marks primary compared" "$double_output" "double_compared_primary=true"
check_contains "double hard failure marks challenger compared" "$double_output" "double_compared_challenger=true"
check_contains "double hard failure does not relaunch eval" "$double_output" "eval_launches=0"

check_contains "orphan hard failure path writes exactly one terminal record" "$orphan_output" "orphan_lines=1"
check_contains "orphan hard failure path writes forfeit outcome" "$orphan_output" "orphan_outcome=forfeit"
check_contains "orphan hard failure path records orphan reason" "$orphan_output" "orphan_reason=orphan_pair"
check_contains "orphan hard failure path awards surviving primary" "$orphan_output" "orphan_winner=primary"
check_contains "orphan hard failure path marks primary compared" "$orphan_output" "orphan_compared_primary=true"

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
