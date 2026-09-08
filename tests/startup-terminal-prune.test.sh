#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MILL_SCRIPT="$REPO_DIR/shared/lib/wavemill-mill.sh"
COMMON_SCRIPT="$REPO_DIR/shared/lib/wavemill-common.sh"

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

funcs="$tmp/startup-prune-functions.sh"
{
  extract_function "$COMMON_SCRIPT" "task_lifecycle_jq_defs"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "task_lifecycle_jq_filter"
  printf '\n'
  extract_function "$COMMON_SCRIPT" "remove_task_state"
  printf '\n'
  extract_function "$MILL_SCRIPT" "cleanup_terminal_missing_worktree_entries"
  printf '\n'
  extract_function "$MILL_SCRIPT" "detect_inflight_tasks"
} > "$funcs"

STATE_FILE="$tmp/workflow-state.json"
missing_terminal="$tmp/worktrees/missing-terminal"
missing_active="$tmp/worktrees/missing-active"
existing_terminal="$tmp/worktrees/existing-terminal"
mkdir -p "$existing_terminal"
cat > "$STATE_FILE" <<JSON
{
  "tasks": {
    "HOK-ABORTED": {
      "status": "aborted",
      "phase": "aborted",
      "worktree": "$missing_terminal"
    },
    "HOK-ACTIVE": {
      "status": "active",
      "phase": "coding",
      "worktree": "$missing_active"
    },
    "HOK-MERGED": {
      "status": "merged",
      "phase": "ready",
      "worktree": "$existing_terminal"
    },
    "HOK-SUPERSEDED": {
      "status": "superseded",
      "phase": "superseded",
      "slug": "superseded",
      "worktree": "$existing_terminal"
    },
    "HOK-DEFERRED": {
      "status": "active",
      "phase": "review",
      "slug": "deferred",
      "worktree": "$existing_terminal",
      "rehydration": {
        "eligibility": "deferred",
        "reason": "pr_state_unverifiable"
      }
    },
    "HOK-PREFLIGHT-TERMINAL": {
      "status": "active",
      "phase": "review",
      "slug": "preflight-terminal",
      "worktree": "$existing_terminal",
      "rehydration": {
        "eligibility": "terminal",
        "reason": "pr_merged"
      }
    }
  }
}
JSON

# shellcheck source=/dev/null
source "$funcs"

LOG_OUTPUT=""
WARN_OUTPUT=""
log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { WARN_OUTPUT+="$*"$'\n'; }
state_mutate() {
  local file="$1" filter="$2"
  shift 2
  jq "$filter" "$@" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

cleanup_terminal_missing_worktree_entries

if [[ "$(jq -r '.tasks | has("HOK-ABORTED")' "$STATE_FILE")" != "false" ]]; then
  echo "terminal task with missing worktree was not removed" >&2
  jq . "$STATE_FILE" >&2
  exit 1
fi

if [[ "$(jq -r '.tasks | has("HOK-ACTIVE")' "$STATE_FILE")" != "true" ]]; then
  echo "non-terminal task with missing worktree was removed" >&2
  jq . "$STATE_FILE" >&2
  exit 1
fi

if [[ "$(jq -r '.tasks | has("HOK-MERGED")' "$STATE_FILE")" != "true" ]]; then
  echo "terminal task with existing worktree was removed" >&2
  jq . "$STATE_FILE" >&2
  exit 1
fi

inflight="$(detect_inflight_tasks)"
if [[ "$inflight" != *"HOK-ACTIVE|"* ]]; then
  echo "active task was not emitted for rehydration" >&2
  printf '%s\n' "$inflight" >&2
  exit 1
fi
if [[ "$inflight" != *"HOK-DEFERRED|"* ]]; then
  echo "deferred active task was not emitted for safe rehydration" >&2
  printf '%s\n' "$inflight" >&2
  exit 1
fi
if [[ "$inflight" == *"HOK-MERGED|"* || "$inflight" == *"HOK-SUPERSEDED|"* || "$inflight" == *"HOK-PREFLIGHT-TERMINAL|"* ]]; then
  echo "terminal task was emitted for rehydration" >&2
  printf '%s\n' "$inflight" >&2
  exit 1
fi

if [[ "$LOG_OUTPUT" != *"Dropped 1 terminal task state entry"* ]]; then
  echo "startup prune did not log removal count" >&2
  printf '%s\n' "$LOG_OUTPUT" >&2
  exit 1
fi

echo "startup terminal prune test passed"
