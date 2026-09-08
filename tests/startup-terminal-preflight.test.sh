#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export PATH="$TMP/bin:$PATH"
mkdir -p "$TMP/bin" "$TMP/pr" "$TMP/repo" "$TMP/worktrees"

cat > "$TMP/bin/gh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == "pr" && "${2:-}" == "view" ]]; then
  pr="$3"
  file="${GH_PR_VIEW_DIR}/${pr}.json"
  [[ -f "$file" ]] || exit 1
  cat "$file"
  exit 0
fi
exit 1
SH
chmod +x "$TMP/bin/gh"

cat > "$TMP/bin/tmux" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${TMUX_CALL_LOG:?}"
case "${1:-}" in
  list-windows|list-panes|display-message|capture-pane|kill-window|select-pane) exit 1 ;;
esac
exit 0
SH
chmod +x "$TMP/bin/tmux"

export GH_PR_VIEW_DIR="$TMP/pr"
export TMUX_CALL_LOG="$TMP/tmux.log"
export STATE_DIR="$TMP/state"
export STATE_FILE="$STATE_DIR/workflow-state.json"
export SESSION="preflight-test"
export REPO_DIR="$TMP/repo"
export WORKTREE_ROOT="$TMP/worktrees"
export BASE_BRANCH="auto/integration"
export TOOLS_DIR="$REPO_DIR/tools"
export LIB_DIR="$REPO_DIR/shared/lib"
export API_TIMEOUT=2
export WAVEMILL_RUN_EPOCH="20260908T000000Z-test"
export RUN_EPOCH="$WAVEMILL_RUN_EPOCH"
mkdir -p "$STATE_DIR" "$REPO_DIR/tools" "$REPO_DIR/shared/lib"
: > "$TMUX_CALL_LOG"

# shellcheck source=../shared/lib/wavemill-common.sh
source "$SCRIPT_DIR/../shared/lib/wavemill-common.sh"
# shellcheck source=../shared/lib/terminal-reconciler.sh
source "$SCRIPT_DIR/../shared/lib/terminal-reconciler.sh"
# shellcheck source=../shared/lib/startup-terminal-preflight.sh
source "$SCRIPT_DIR/../shared/lib/startup-terminal-preflight.sh"

WARN_OUTPUT=""
LOG_OUTPUT=""
LINEAR_OUTPUT=""
log() { LOG_OUTPUT+="$*"$'\n'; }
log_warn() { WARN_OUTPUT+="$*"$'\n'; }
linear_set_state() { LINEAR_OUTPUT+="$1:$2"$'\n'; }
should_update_linear_state() { return 0; }
get_linear_issue_id() { printf '%s\n' "$1"; }
write_stage_result() { return 0; }
wavemill_hook_terminalize() { return 0; }
wavemill_hook_archive_current() { return 0; }

write_pr() {
  local pr="$1" state="$2" merged_at="${3:-}" head="${4:-head-$1}"
  jq -n \
    --arg pr "$pr" \
    --arg state "$state" \
    --arg mergedAt "$merged_at" \
    --arg head "$head" \
    '{
      number: ($pr | tonumber),
      state: $state,
      mergedAt: (if $mergedAt == "" then null else $mergedAt end),
      headRefOid: $head,
      headRefName: ("task/head-" + $pr),
      baseRefName: "auto/integration",
      mergeCommit: {oid: ("merge-" + $pr)}
    }' > "$GH_PR_VIEW_DIR/$pr.json"
}

reset_state() {
  WARN_OUTPUT=""
  LOG_OUTPUT=""
  LINEAR_OUTPUT=""
  : > "$TMUX_CALL_LOG"
  rm -rf "$STATE_DIR" "$TMP/worktrees"
  mkdir -p "$STATE_DIR" "$TMP/worktrees"
}

assert_eq() {
  local actual="$1" expected="$2" message="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL: %s\nexpected: %s\nactual:   %s\n' "$message" "$expected" "$actual" >&2
    [[ -f "$STATE_FILE" ]] && jq . "$STATE_FILE" >&2 || true
    exit 1
  fi
}

write_pr 101 MERGED "2026-09-08T00:00:00Z"
write_pr 102 CLOSED ""
write_pr 103 OPEN ""
write_pr 104 MERGED "2026-09-08T00:00:00Z"

reset_state
mkdir -p "$TMP/worktrees/merged/features/merged"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-1":{"slug":"merged","branch":"task/merged","worktree":"$TMP/worktrees/merged","status":"active","phase":"coding","pr":"101","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-1"].startupPreflight.verdict' "$STATE_FILE")" "terminal:pr_merged" "merged PR verdict"
assert_eq "$(jq -r '.tasks["HOK-1"].status' "$STATE_FILE")" "merged" "merged PR terminal status"
assert_eq "$(jq -r '.tasks["HOK-1"].paneReleased' "$STATE_FILE")" "true" "missing pane release is durable"
assert_eq "$(grep -c 'new-window' "$TMUX_CALL_LOG" || true)" "0" "preflight never creates panes"
linear_before="$(printf '%s' "$LINEAR_OUTPUT" | wc -l | tr -d ' ')"
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
linear_after="$(printf '%s' "$LINEAR_OUTPUT" | wc -l | tr -d ' ')"
assert_eq "$linear_after" "$linear_before" "merged preflight is restart-idempotent"

reset_state
mkdir -p "$TMP/worktrees/closed/features/closed"
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-2":{"slug":"closed","branch":"task/closed","worktree":"$TMP/worktrees/closed","status":"active","phase":"coding","pr":"102","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-2"].startupPreflight.verdict' "$STATE_FILE")" "terminal:pr_closed_unmerged" "closed PR verdict"
assert_eq "$(jq -r '.tasks["HOK-2"].status' "$STATE_FILE")" "closed" "closed PR terminal status"
assert_eq "$(test -d "$TMP/worktrees/closed" && echo yes || echo no)" "yes" "closed-unmerged worktree retained"

reset_state
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-3":{"slug":"active","branch":"task/active","worktree":"$TMP/worktrees/active","status":"active","phase":"coding","pr":"103","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-3"].startupPreflight.verdict' "$STATE_FILE")" "rehydrate" "open PR remains rehydratable"
assert_eq "$(jq -r '.tasks["HOK-3"].status' "$STATE_FILE")" "active" "open PR remains active"
assert_eq "$(jq -r '.tasks["HOK-3"].startupPreflight.runEpoch' "$STATE_FILE")" "$WAVEMILL_RUN_EPOCH" "entry epoch stamped"
assert_eq "$(jq -r '.runEpoch' "$STATE_FILE")" "$WAVEMILL_RUN_EPOCH" "state epoch stamped"

reset_state
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-8":{"slug":"primary","branch":"task/primary","worktree":"$TMP/worktrees/primary","status":"active","phase":"ready","pr":"104","challenge":"true","challengeRole":"primary","challengePairId":"HOK-8","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}},"HOK-8_c":{"slug":"challenger","branch":"task/challenger","worktree":"$TMP/worktrees/challenger","status":"active","phase":"coding","pr":"103","challenge":"true","challengeRole":"challenger","challengePairId":"HOK-8","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-8_c"].startupPreflight.verdict' "$STATE_FILE")" "superseded" "challenger is superseded by merged primary"
assert_eq "$(jq -r '.tasks["HOK-8_c"].status' "$STATE_FILE")" "superseded" "superseded challenger terminal status"

reset_state
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-4":{"slug":"legacy","branch":"task/legacy","worktree":"$TMP/worktrees/legacy","status":"active","phase":"coding"}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-4"].startupPreflight.verdict' "$STATE_FILE")" "verification-required:missing-launch-contract" "legacy active requires verification"
assert_eq "$(jq -r '.tasks["HOK-4"].status' "$STATE_FILE")" "active" "legacy state is not destructively terminalized"

reset_state
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-5":{"slug":"network-a","branch":"task/network-a","worktree":"$TMP/worktrees/network-a","status":"active","phase":"coding","pr":"999","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}},"HOK-6":{"slug":"network-b","branch":"task/network-b","worktree":"$TMP/worktrees/network-b","status":"active","phase":"coding","pr":"998","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
wavemill_startup_terminal_preflight "$STATE_FILE" "$SESSION"
assert_eq "$(jq -r '.tasks["HOK-5"].startupPreflight.verdict' "$STATE_FILE")" "unverified:network" "network failure verdict"
assert_eq "$(jq -r '.networkEpisode.issues | length' "$STATE_DIR/startup-preflight.json")" "2" "network episode aggregates affected issues"
assert_eq "$(printf '%s' "$WARN_OUTPUT" | grep -c 'Startup terminal preflight could not verify')" "1" "network warning emitted once"

reset_state
cat > "$STATE_FILE" <<JSON
{"tasks":{"HOK-7":{"slug":"disabled","branch":"task/disabled","worktree":"$TMP/worktrees/disabled","status":"active","phase":"coding","pr":"101","lifecycle":{"workflowOutcome":"active","resourceDisposition":"allocated","launchContract":{"remoteBranchDeletionPolicy":{"allowed":true,"mode":"merged-pr-task-branch"}}}}}}
JSON
WAVEMILL_STARTUP_TERMINAL_PREFLIGHT=0
if [[ "$(startup_preflight_enabled)" != "false" ]]; then
  echo "gate-off did not disable preflight" >&2
  exit 1
fi
assert_eq "$(jq -r '.tasks["HOK-7"].startupPreflight // empty' "$STATE_FILE")" "" "gate-off leaves entries unstamped"
unset WAVEMILL_STARTUP_TERMINAL_PREFLIGHT

echo "startup terminal preflight test passed"
