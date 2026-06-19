#!/usr/bin/env bash
set -euo pipefail

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

FUNCS_FILE="$TEST_TMP/merge-queue-progress-funcs.sh"
: > "$FUNCS_FILE"
for fn in \
  ready_base_sha \
  ready_queue_field \
  ready_queue_state \
  ready_stage_allows_merge \
  promote_merge_candidate \
  refresh_ready_merge_queue_tick \
  log_merge_candidate_advance_once
do
  extract_function "$MILL_SCRIPT" "$fn" >> "$FUNCS_FILE"
  printf '\n' >> "$FUNCS_FILE"
done

run_case() {
  local case_name="$1"
  local case_dir="$TEST_TMP/$case_name"
  mkdir -p "$case_dir"

  CASE_NAME="$case_name" CASE_DIR="$case_dir" FUNCS_FILE="$FUNCS_FILE" bash -lc '
    set -euo pipefail
    source "$FUNCS_FILE"

    declare -Ag BRANCH_BY_ISSUE=()
    declare -Ag SLUG_BY_ISSUE=()
    declare -Ag PR_BY_ISSUE=()

    ISSUE="HOK-2267"
    SLUG="merge-queue-progress"
    WORKTREE_ROOT="$CASE_DIR/worktrees"
    BASE_BRANCH="main"
    MERGE_QUEUE_SELECTION_FILE="$CASE_DIR/merge-queue-selection.json"
    READY_MERGE_CANDIDATE_ADVANCE_LOG_KEYS="$(printf "\n")"
    LOG_FILE="$CASE_DIR/log-output.txt"
    MAIN_SHA_RETURN="sha-main"
    : > "$LOG_FILE"

    mkdir -p "$WORKTREE_ROOT/$SLUG/features/$SLUG/ready"
    STATE_DIR="$WORKTREE_ROOT/$SLUG/features/$SLUG/ready"
    RESULT_FILE="$STATE_DIR/.ready-result.json"

    BRANCH_BY_ISSUE["$ISSUE"]="task/$SLUG"
    SLUG_BY_ISSUE["$ISSUE"]="$SLUG"
    PR_BY_ISSUE["$ISSUE"]="753"

    log() { printf "%s\n" "$*" >> "$LOG_FILE"; }
    merge_queue_enabled() { return 0; }
    get_task_phase() { printf "%s\n" "ready"; }
    read_stage_status() { printf "%s\n" "completed"; }
    ready_stage_pending_verdict() { printf "%s\n" "pass"; }
    ready_changed_files_json() { printf "[]\n"; }
    get_main_head_sha() { printf "%s\n" "$MAIN_SHA_RETURN"; }
    mark_ready_stale() { :; }
    ready_state_dir() { printf "%s\n" "$1/features/$2/ready"; }
    write_ready_queue_artifacts() {
      local state_dir="$1" patch_json="$2"
      local result_file="$state_dir/.ready-result.json"
      local tmp_file
      tmp_file="$(mktemp)"
      jq --argjson patch "$patch_json" "
        .artifacts = ((.artifacts // {type:\"ready\"}) + \$patch | .type = \"ready\")
      " "$result_file" > "$tmp_file"
      mv "$tmp_file" "$result_file"
    }
    npx() {
      if [[ "${1:-}" == "tsx" && "${2:-}" == *"merge-queue-select.ts" ]]; then
        cat <<JSON
{"selectedIssues":["$ISSUE"],"stuckIssues":[]}
JSON
        return 0
      fi
      echo "unexpected npx invocation: $*" >&2
      return 1
    }

    case "$CASE_NAME" in
      promote_ready_candidate)
        cat > "$RESULT_FILE" <<JSON
{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass","readyBaseSha":"sha-main","queueState":"ready"}}
JSON
        ;;
      refresh_existing_candidate)
        cat > "$RESULT_FILE" <<JSON
{"stage":"ready","status":"completed","artifacts":{"type":"ready","verdict":"pass","readyBaseSha":"sha-main","queueState":"merge-candidate","candidatePromotedAt":"2026-06-19T12:00:00Z","candidateLastProgressAt":"2026-06-19T12:00:00Z","targetBaseSha":"sha-main"}}
JSON
        ;;
      *)
        echo "unknown case: $CASE_NAME" >&2
        exit 1
        ;;
    esac

    refresh_ready_merge_queue_tick

    printf "queue_state=%s\n" "$(jq -r ".artifacts.queueState" "$RESULT_FILE")"
    printf "promoted_at=%s\n" "$(jq -r ".artifacts.candidatePromotedAt // empty" "$RESULT_FILE")"
    printf "last_progress_at=%s\n" "$(jq -r ".artifacts.candidateLastProgressAt // empty" "$RESULT_FILE")"
    printf "log_output=%s\n" "$(tr "\n" "|" < "$LOG_FILE" 2>/dev/null || true)"
  '
}

echo "=== Merge Queue Progress ==="

promote_output="$(run_case promote_ready_candidate)"
check_eq "promotion moves ready result into merge-candidate" "merge-candidate" "$(kv_value "$promote_output" queue_state)"
check_contains "promotion records normal-path advancement log" "$promote_output" "Advanced through merge lane"
check_contains "promotion writes candidate progress timestamp" "$promote_output" "last_progress_at="

refresh_output="$(run_case refresh_existing_candidate)"
check_eq "selected merge candidate stays merge-candidate" "merge-candidate" "$(kv_value "$refresh_output" queue_state)"
check_eq "selected merge candidate preserves first promotion time" "2026-06-19T12:00:00Z" "$(kv_value "$refresh_output" promoted_at)"
check_eq "selected merge candidate does not re-log advancement each tick" "" "$(kv_value "$refresh_output" log_output)"
check_contains "selected merge candidate refreshes last-progress timestamp" "$refresh_output" "last_progress_at="

echo ""
echo "--- Results: $PASS passed, $FAIL failed ---"

if (( FAIL > 0 )); then
  exit 1
fi
