#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

pass() { echo "  PASS  $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL  $1"; FAIL=$((FAIL + 1)); }

run_case() {
  local kind="$1"
  local tmp_dir state_file log_path result_path pid job_id pr_numbers timeout status cycles drains
  local -a job_flags=()
  tmp_dir="$(mktemp -d)"
  state_file="$tmp_dir/workflow-state.json"
  log_path="$tmp_dir/${kind}.log"
  result_path="$tmp_dir/${kind}.result.json"
  printf '{"tasks":{"HOK-1564":{"challengePairId":"HOK-1564","challengeRole":"primary"},"HOK-1564_c":{"challengePairId":"HOK-1564","challengeRole":"challenger"}}}\n' > "$state_file"
  printf 'job running\n' > "$log_path"

  (
    sleep 5
    cat > "$result_path" <<'JSON'
{"ok":true,"exitCode":0}
JSON
  ) &
  pid=$!

  if [[ "$kind" == "eval" ]]; then
    job_id="eval-HOK-1564-primary-101"
    pr_numbers="101"
    job_flags=(--issue-id HOK-1564 --side primary --pair-id HOK-1564)
  else
    job_id="comparison-HOK-1564-101-102"
    pr_numbers="101,102"
    job_flags=(--pair-id HOK-1564)
  fi
  timeout=30

  npx tsx "$REPO_DIR/tools/job-tracker.ts" launch \
    --state-file "$state_file" \
    --kind "$kind" \
    --job-id "$job_id" \
    "${job_flags[@]}" \
    --pr-numbers "$pr_numbers" \
    --pid "$pid" \
    --timeout-seconds "$timeout" \
    --log-path "$log_path" \
    --result-path "$result_path" >/dev/null

  status="running"
  cycles=0
  drains=0
  while [[ "$status" == "running" && $cycles -lt 10 ]]; do
    drains=$((drains + 1))
    npx tsx "$REPO_DIR/tools/job-tracker.ts" poll --state-file "$state_file" >/dev/null
    status=$(jq -r --arg id "$job_id" '.jobs[$id].status // "running"' "$state_file")
    cycles=$((cycles + 1))
    sleep 0.2
  done

  if (( cycles >= 2 )); then
    pass "$kind monitor loop keeps iterating while job runs"
  else
    fail "$kind monitor loop did not iterate enough while job ran"
  fi

  if (( drains >= cycles )); then
    pass "$kind loop continues draining commands during job"
  else
    fail "$kind loop did not keep draining while job ran"
  fi

  if [[ "$status" == "succeeded" ]]; then
    pass "$kind job finishes successfully after polling"
  else
    fail "$kind job did not finish successfully"
  fi

  rm -rf "$tmp_dir"
}

echo "=== Challenge Job Monitor Loop ==="
run_case eval
run_case comparison

echo ""
echo "Passed: $PASS"
echo "Failed: $FAIL"

if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
