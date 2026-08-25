#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"

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
      if (depth == 0) exit
    }
  ' "$source_file"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

helper_file="$tmp/primary-merge-helper.sh"
extract_function "$MILL_SCRIPT" "resolve_pair_on_primary_merge" > "$helper_file"

case_dir="$tmp/case"
mkdir -p "$case_dir/repo/.wavemill/evals"
STATE_FILE="$case_dir/repo/.wavemill/workflow-state.json"
cat > "$STATE_FILE" <<'JSON'
{
  "tasks": {
    "HOK-2881": {
      "pr": 1230,
      "branch": "task/primary",
      "challengePairId": "HOK-2881",
      "challengeRole": "primary",
      "challengeModel": "gpt-5",
      "evalCompleted": true
    },
    "HOK-2881_c": {
      "branch": "task/primary-challenger",
      "challengePairId": "HOK-2881",
      "challengeRole": "challenger",
      "challengeModel": "claude-sonnet-4",
      "phase": "review",
      "status": "active"
    }
  }
}
JSON
printf '{}\n' > "$case_dir/repo/.wavemill-config.json"

output="$(
  CASE_DIR="$case_dir" REPO_ROOT="$REPO_DIR" bash -lc '
    set -euo pipefail
    source "$CASE_DIR/../primary-merge-helper.sh"

    REPO_DIR="$CASE_DIR/repo"
    TOOLS_DIR="$REPO_ROOT/tools"
    STATE_FILE="$REPO_DIR/.wavemill/workflow-state.json"
    LOG_OUTPUT=""
    WARN_OUTPUT=""
    COMPARED_PAIR=""

    get_task_meta() {
      local issue="$1" key="$2"
      jq -r --arg issue "$issue" --arg key "$key" ".tasks[\$issue][\$key] // \"\"" "$STATE_FILE"
    }
    mark_challenge_compared() {
      COMPARED_PAIR="$1"
      return 0
    }
    log() { LOG_OUTPUT+="$*\n"; }
    log_warn() { WARN_OUTPUT+="$*\n"; }

    resolve_pair_on_primary_merge "HOK-2881" "1230"

    printf "phase=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].phase" "$STATE_FILE")"
    printf "status=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].status" "$STATE_FILE")"
    printf "reason=%s\n" "$(jq -r ".tasks[\"HOK-2881_c\"].abortedReason" "$STATE_FILE")"
    printf "compared=%s\n" "$COMPARED_PAIR"
    printf "winner=%s\n" "$(jq -r ".winner" "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
    printf "terminal=%s\n" "$(jq -r ".terminalReason" "$REPO_DIR/.wavemill/evals/challenge-records.jsonl")"
  '
)"

[[ "$output" == *"phase=aborted"* ]] || { echo "$output"; echo "challenger phase was not aborted" >&2; exit 1; }
[[ "$output" == *"status=aborted"* ]] || { echo "$output"; echo "challenger status was not aborted" >&2; exit 1; }
[[ "$output" == *"reason=Primary already merged as PR #1230"* ]] || { echo "$output"; echo "abort reason mismatch" >&2; exit 1; }
[[ "$output" == *"compared=HOK-2881"* ]] || { echo "$output"; echo "pair was not marked compared" >&2; exit 1; }
[[ "$output" == *"winner=primary"* ]] || { echo "$output"; echo "comparison record winner mismatch" >&2; exit 1; }
[[ "$output" == *"terminal=primary_merged"* ]] || { echo "$output"; echo "terminal reason mismatch" >&2; exit 1; }

echo "challenge-primary-merge-cleanup test passed"
