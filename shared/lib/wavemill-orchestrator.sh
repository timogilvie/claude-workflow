#!/opt/homebrew/bin/bash
set -euo pipefail


# Validate dependencies
command -v tmux >/dev/null || { echo "Error: tmux is required but not installed"; exit 1; }
command -v git >/dev/null || { echo "Error: git is required but not installed"; exit 1; }
command -v npx >/dev/null || { echo "Error: npx is required but not installed"; exit 1; }
command -v jq >/dev/null || { echo "Error: jq is required but not installed"; exit 1; }




REPO_DIR="${REPO_DIR:-$PWD}"

# Load config if not already loaded by parent (wavemill-mill.sh)
if [[ -z "${_WAVEMILL_CONFIG_LOADED:-}" ]]; then
  _ORCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  source "$_ORCH_DIR/wavemill-common.sh"
  load_config "$REPO_DIR"
fi

# Load agent adapter functions
_ORCH_DIR="${_ORCH_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
source "$_ORCH_DIR/agent-adapters.sh"

# Positional arg overrides config for session name
SESSION="${1:-$SESSION}"
BASE_BRANCH="${BASE_BRANCH:-$(cd "$REPO_DIR" && git symbolic-ref --short HEAD)}"
LINEAR_TOOL="${LINEAR_TOOL:-${TOOLS_DIR:?TOOLS_DIR must be set}/get-issue.ts}"


# Validate agent command exists
agent_validate "$AGENT_CMD" || { echo "Error: Agent command '$AGENT_CMD' not found"; exit 1; }


mkdir -p "$WORKTREE_ROOT"


# Cleanup handler
trap 'echo "Session ended. Run: git -C \"$REPO_DIR\" worktree prune" >&2' EXIT


# tasks are passed as: "ISSUEID|slug|title" ...
# example:
# ./wavemill-orchestrator.sh wavemill \
#   "LIN-123|hero-cta|Improve hero CTA copy" \
#   "LIN-456|nav-a11y|Fix navbar accessibility"


shift || true
TASKS=("$@")


if [[ ${#TASKS[@]} -eq 0 ]]; then
  echo "Pass tasks as: ISSUEID|slug|title"
  exit 1
fi


# Start session with a clean control window.
# Kill any stale session from a previous crashed run so we get a fresh control window.
TMUX_CONF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && cd ../.. && pwd)/.tmux.conf"
if tmux has-session -t "$SESSION" 2>/dev/null; then
  # Safety check: don't kill a session running in a different repo
  _existing_dir=$(tmux show-environment -t "$SESSION" REPO_DIR 2>/dev/null | sed 's/^REPO_DIR=//') || true
  if [[ -n "$_existing_dir" && "$_existing_dir" != "$REPO_DIR" ]]; then
    echo "ERROR: tmux session '$SESSION' is already active in: $_existing_dir" >&2
    echo "Cannot start a new session for: $REPO_DIR" >&2
    echo "" >&2
    echo "Options:" >&2
    echo "  - Stop the existing session first (tmux kill-session -t '$SESSION')" >&2
    echo "  - Use a different session name: SESSION=my-session wavemill mill" >&2
    exit 1
  fi
  # Same repo or unknown — stale session, safe to kill and recreate
  tmux kill-session -t "$SESSION" 2>/dev/null || true
fi
tmux -f "$TMUX_CONF" new-session -d -s "$SESSION" -c "$REPO_DIR" -n control
# Store REPO_DIR in tmux environment so other instances can detect cross-repo conflicts
tmux set-environment -t "$SESSION" REPO_DIR "$REPO_DIR"


# Control window message
tmux send-keys -t "$SESSION:control" "echo 'Control window for $SESSION'" C-m


# Create log file for failures
LOG_FILE="/tmp/${SESSION}-orchestrator.log"
echo "=== Orchestrator Log $(date) ===" > "$LOG_FILE"


# Per-task error handling (disable global exit on error for loop)
set +e
i=0
for t in "${TASKS[@]}"; do
  (
    # Re-enable exit on error for each task subprocess
    set -euo pipefail
    IFS='|' read -r ISSUE SLUG TITLE <<<"$t"
    BRANCH="task/${SLUG}"
    WT_DIR="${WORKTREE_ROOT}/${SLUG}"
    LINEAR_ISSUE="$ISSUE"
    CHALLENGE_MODEL=""

    if [[ -n "${WAVEMILL_STATE_FILE:-}" ]] && [[ -f "$WAVEMILL_STATE_FILE" ]]; then
      LINEAR_ISSUE=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].linearIssueId // .tasks[$issue].challengePairId // $issue' "$WAVEMILL_STATE_FILE" 2>/dev/null || echo "$ISSUE")
      CHALLENGE_MODEL=$(jq -r --arg issue "$ISSUE" '.tasks[$issue].challengeModel // empty' "$WAVEMILL_STATE_FILE" 2>/dev/null || echo "")
    fi


    echo "==> Setting up $ISSUE ($LINEAR_ISSUE): $TITLE"
    cd "$REPO_DIR"


    # Check if task packet was already created by loop script
    PACKET_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket.md"
    ISSUE_DESCRIPTION=""


    if [[ -f "$PACKET_FILE" ]]; then
      # Use pre-expanded task packet
      echo "Using task packet from: $PACKET_FILE"
      ISSUE_DESCRIPTION="$(cat "$PACKET_FILE")"
    else
      # Fetch full issue details from Linear
      echo "Fetching issue details from Linear..."
      ISSUE_DATA=$(npx tsx "$LINEAR_TOOL" "$LINEAR_ISSUE" 2>/dev/null || echo "")
      if [[ -n "$ISSUE_DATA" ]]; then
        ISSUE_DESCRIPTION=$(echo "$ISSUE_DATA" | jq -r '.description // ""' 2>/dev/null || echo "")
      fi
    fi


    # Load model suggestion and select per-task agent + model
    MODEL_SUGGESTION_FILE="/tmp/${SESSION}-${ISSUE}-model-suggestion.json"
    TASK_AGENT_CMD="$AGENT_CMD"
    TASK_MODEL=""
    if [[ -n "$CHALLENGE_MODEL" ]]; then
      TASK_MODEL="$CHALLENGE_MODEL"
      TASK_AGENT_CMD="$(agent_resolve_from_model "$TASK_MODEL")"
      echo "Challenge: $ISSUE -> $TASK_AGENT_CMD --model $TASK_MODEL"
    elif [[ -n "${FORCE_MODEL:-}" ]]; then
      # Validate model before using it
      if ! agent_validate_model "$FORCE_MODEL" "$REPO_DIR"; then
        echo "ERROR: Invalid FORCE_MODEL: $FORCE_MODEL" >&2
        exit 1
      fi
      # FORCE_MODEL env var overrides the router entirely
      TASK_MODEL="$FORCE_MODEL"
      TASK_AGENT_CMD="$(agent_resolve_from_model "$FORCE_MODEL")"
      echo "FORCE_MODEL: $ISSUE -> $TASK_AGENT_CMD --model $TASK_MODEL"
    elif [[ "${AGENT_CMD_EXPLICIT:-}" != "true" ]] && [[ -f "$MODEL_SUGGESTION_FILE" ]]; then
      RECOMMENDED_MODEL=$(jq -r '.recommendedModel // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      RECOMMENDED_AGENT=$(jq -r '.recommendedAgent // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_INSUFFICIENT=$(jq -r '.insufficientData // false' "$MODEL_SUGGESTION_FILE" 2>/dev/null)
      MODEL_CONFIDENCE=$(jq -r '.confidence // empty' "$MODEL_SUGGESTION_FILE" 2>/dev/null)

      if [[ "$MODEL_INSUFFICIENT" != "true" ]] && [[ -n "$RECOMMENDED_MODEL" ]]; then
        TASK_MODEL="$RECOMMENDED_MODEL"
        if [[ -n "$RECOMMENDED_AGENT" ]]; then
          TASK_AGENT_CMD="$RECOMMENDED_AGENT"
        fi
        echo "Router: $ISSUE -> $TASK_AGENT_CMD --model $TASK_MODEL (confidence: $MODEL_CONFIDENCE)"
      else
        echo "Router: $ISSUE -> using default agent (insufficient eval data)"
      fi
    fi

    # Validate the selected agent exists, fall back to global default if not
    if ! agent_validate "$TASK_AGENT_CMD"; then
      echo "WARN: Agent '$TASK_AGENT_CMD' not found, falling back to '$AGENT_CMD'"
      TASK_AGENT_CMD="$AGENT_CMD"
      TASK_MODEL=""
    fi

    # Check authentication only if router selected a different agent
    if [[ "$TASK_AGENT_CMD" != "$AGENT_CMD" ]] && ! agent_check_auth "$TASK_AGENT_CMD"; then
      echo "Error: Agent '$TASK_AGENT_CMD' not authenticated for task $ISSUE" >&2
      exit 1
    fi

    # Override AGENT_CMD for pretrust_directory and other functions in this subshell
    AGENT_CMD="$TASK_AGENT_CMD"

    # Persist resolved agent to state file so monitor/eval uses the correct agent
    if [[ -n "${WAVEMILL_STATE_FILE:-}" ]] && [[ -f "$WAVEMILL_STATE_FILE" ]]; then
      _tmp=$(mktemp) || true
      if [[ -n "${_tmp:-}" ]] && jq --arg issue "$ISSUE" --arg agent "$TASK_AGENT_CMD" \
         'if .tasks[$issue] then .tasks[$issue].agent = $agent else . end' \
         "$WAVEMILL_STATE_FILE" > "$_tmp" 2>/dev/null; then
        mv "$_tmp" "$WAVEMILL_STATE_FILE"
      else
        rm -f "${_tmp:-}"
      fi
    fi


    # Create worktree + branch (check for existing branch first)
    if [[ -d "$WT_DIR" ]]; then
      echo "Worktree exists: $WT_DIR (resuming)"
    else
      if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
        echo "Branch $BRANCH already exists, resuming from it"
        git worktree add "$WT_DIR" "$BRANCH"
      else
        echo "Creating new branch $BRANCH from origin/$BASE_BRANCH"
        git worktree add "$WT_DIR" -b "$BRANCH" "origin/$BASE_BRANCH"
      fi
    fi


    # Pre-trust worktree directory so Claude doesn't prompt
    pretrust_directory "$WT_DIR"

    WIN="$ISSUE-$SLUG"
    tmux new-window -t "$SESSION" -n "$WIN" -c "$WT_DIR"
    tmux set-window-option -u -t "$SESSION:$WIN" window-status-style >/dev/null 2>&1 || true
    tmux set-window-option -u -t "$SESSION:$WIN" window-status-current-style >/dev/null 2>&1 || true


    # ── Agent launch (planning vs skip mode) ──────────────────────────────
    # Prompt assembly uses shared builders in agent-adapters.sh (single
    # source of truth shared with launch_task() in the monitor loop).

    STATUS_FILE="/tmp/${SESSION}-${ISSUE}-status.txt"
    ISSUE_CONTEXT="${ISSUE_DESCRIPTION:+Issue Description:
$ISSUE_DESCRIPTION
}"

    # Copy task-packet details file to worktree if available
    DETAILS_FILE="/tmp/${SESSION}-${ISSUE}-taskpacket-details.md"
    if [[ -f "$DETAILS_FILE" ]]; then
      if [[ "${PLANNING_MODE:-skip}" == "interactive" ]]; then
        FEATURE_DIR="$WT_DIR/features/$SLUG"
        mkdir -p "$FEATURE_DIR"
        cp "$DETAILS_FILE" "$FEATURE_DIR/task-packet-details.md"
        ISSUE_CONTEXT="${ISSUE_CONTEXT}
📖 Full Details: Comprehensive task packet with all 9 sections available at:
   features/$SLUG/task-packet-details.md

Read specific sections on-demand as you plan and implement:
- Section 1: Complete Objective & Scope
- Section 2: Technical Context (dependencies, architecture)
- Section 3: Implementation Approach (step-by-step)
- Section 4: Success Criteria (all requirements with [REQ-FX] tags)
- Section 5: Implementation Constraints (all rules)
- Section 6: Validation Steps (concrete test scenarios)
- Section 7: Definition of Done
- Section 8: Rollback Plan
- Section 9: Proposed Labels"
      else
        cp "$DETAILS_FILE" "$WT_DIR/task-packet-details.md"
        ISSUE_CONTEXT="${ISSUE_CONTEXT}
📖 Full Details: Read task-packet-details.md in the repo root for:
- Complete implementation approach (Section 3)
- All success criteria with [REQ-FX] tags (Section 4)
- Concrete validation steps with test scenarios (Section 6)
- Implementation constraints and rules (Section 5)"
      fi
    fi

    if [[ "${PLANNING_MODE:-skip}" == "interactive" ]]; then
      # ── Interactive (multi-phase) mode ────────────────────────────────
      # Launch in routing phase - monitor will handle phase transitions

      # Pre-seed selected-task.json for routing and planning phases
      FEATURE_DIR="${FEATURE_DIR:-$WT_DIR/features/$SLUG}"
      mkdir -p "$FEATURE_DIR"
      TASK_JSON="$FEATURE_DIR/selected-task.json"

      ISSUE_JSON_FILE="/tmp/${SESSION}-${ISSUE}-issue.json"
      LABELS_JSON="[]"
      if [[ -f "$ISSUE_JSON_FILE" ]]; then
        LABELS_JSON=$(jq '[.labels.nodes[]?.name // empty]' "$ISSUE_JSON_FILE" 2>/dev/null || echo "[]")
      fi

      jq -n \
        --arg taskId "$ISSUE" \
        --arg title "$TITLE" \
        --arg description "$ISSUE_DESCRIPTION" \
        --argjson labels "$LABELS_JSON" \
        --arg featureName "$SLUG" \
        --arg contextPath "features/$SLUG/selected-task.json" \
        '{
          taskId: $taskId,
          title: $title,
          description: $description,
          labels: $labels,
          workflowType: "feature",
          featureName: $featureName,
          contextPath: $contextPath,
          selectedAt: (now | todate)
        }' > "$TASK_JSON"

      # Run workflow routing directly (no LLM needed — routing is deterministic)
      ROUTE_TOOL="$TOOLS_DIR/route-task.ts"
      PLANNER_MODEL="claude-sonnet-4-5-20250929"
      CODER_MODEL="claude-opus-4-6"
      REVIEWER_MODEL="claude-sonnet-4-5-20250929"
      PLAN_DEPTH="light"
      CODE_DEPTH="medium"
      REVIEW_MODE="static"

      if [[ -f "$ROUTE_TOOL" ]] && [[ -f "$TASK_JSON" ]]; then
        ROUTE_JSON=$(npx tsx "$ROUTE_TOOL" --json --file "$TASK_JSON" --repo-dir "$REPO_DIR" 2>/dev/null || echo "")
        if [[ -n "$ROUTE_JSON" ]] && echo "$ROUTE_JSON" | jq -e '.planner' >/dev/null 2>&1; then
          PLANNER_MODEL=$(echo "$ROUTE_JSON" | jq -r '.planner // "claude-sonnet-4-5-20250929"' 2>/dev/null)
          CODER_MODEL=$(echo "$ROUTE_JSON" | jq -r '.coder // "claude-opus-4-6"' 2>/dev/null)
          REVIEWER_MODEL=$(echo "$ROUTE_JSON" | jq -r '.reviewer // "claude-sonnet-4-5-20250929"' 2>/dev/null)
          PLAN_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.planDepth // "light"' 2>/dev/null)
          CODE_DEPTH=$(echo "$ROUTE_JSON" | jq -r '.codeDepth // "medium"' 2>/dev/null)
          REVIEW_MODE=$(echo "$ROUTE_JSON" | jq -r '.reviewRecommended // "static"' 2>/dev/null)
          echo "  Workflow route: planner=$PLANNER_MODEL ($PLAN_DEPTH), coder=$CODER_MODEL ($CODE_DEPTH), reviewer=$REVIEWER_MODEL ($REVIEW_MODE)"
        else
          echo "  Workflow routing unavailable, using defaults"
        fi
      fi

      # If this is a challenge task, the challenge model IS the coder
      if [[ -n "$CHALLENGE_MODEL" ]]; then
        CODER_MODEL="$CHALLENGE_MODEL"
        echo "  Challenge override: coder=$CODER_MODEL (from challengeModel)"
      fi

      # Write .routing-complete (consumed by monitor for phase transitions)
      ROUTING_FILE="$FEATURE_DIR/.routing-complete"
      jq -n \
        --arg planner "$PLANNER_MODEL" \
        --arg coder "$CODER_MODEL" \
        --arg reviewer "$REVIEWER_MODEL" \
        --arg planDepth "$PLAN_DEPTH" \
        --arg codeDepth "$CODE_DEPTH" \
        --arg reviewMode "$REVIEW_MODE" \
        '{
          planner: $planner,
          coder: $coder,
          reviewer: $reviewer,
          planDepth: $planDepth,
          codeDepth: $codeDepth,
          reviewMode: $reviewMode
        }' > "$ROUTING_FILE"

      # Save routing metadata to state
      if [[ -n "${WAVEMILL_STATE_FILE:-}" ]] && [[ -f "$WAVEMILL_STATE_FILE" ]]; then
        _tmp=$(mktemp) || true
        if [[ -n "${_tmp:-}" ]] && jq --arg issue "$ISSUE" \
           --arg planner "$PLANNER_MODEL" --arg coder "$CODER_MODEL" --arg reviewer "$REVIEWER_MODEL" \
           --arg planDepth "$PLAN_DEPTH" --arg codeDepth "$CODE_DEPTH" --arg reviewMode "$REVIEW_MODE" \
           'if .tasks[$issue] then
              .tasks[$issue].plannerModel = $planner |
              .tasks[$issue].coderModel = $coder |
              .tasks[$issue].reviewerModel = $reviewer |
              .tasks[$issue].planDepth = $planDepth |
              .tasks[$issue].codeDepth = $codeDepth |
              .tasks[$issue].reviewMode = $reviewMode |
              .tasks[$issue].phase = "planning"
            else . end' \
           "$WAVEMILL_STATE_FILE" > "$_tmp" 2>/dev/null; then
          mv "$_tmp" "$WAVEMILL_STATE_FILE"
        else
          rm -f "${_tmp:-}"
        fi
      fi

      # Launch planning phase directly with the routed planner model
      PLANNER_AGENT="$(agent_resolve_from_model "$PLANNER_MODEL")"
      PLANNING_PROMPT="/tmp/${SESSION}-${ISSUE}-planning-prompt.txt"
      build_planning_prompt "$TITLE" "$LINEAR_ISSUE" "$WT_DIR" "$BRANCH" "$BASE_BRANCH" \
        "$ISSUE_CONTEXT" "$STATUS_FILE" "$TOOLS_DIR" "$SLUG" "$PLAN_DEPTH" > "$PLANNING_PROMPT"
      agent_launch_interactive "$SESSION" "$WIN" "$PLANNING_PROMPT" "$PLANNER_AGENT" "$PLANNER_MODEL"
      echo "  ✓ Routing complete (direct), launched planning with $PLANNER_MODEL"

    else
      # ── Skip mode (autonomous) ────────────────────────────────────────

      INSTR_FILE="/tmp/${SESSION}-${ISSUE}-instructions.txt"
      build_autonomous_prompt "$TITLE" "$LINEAR_ISSUE" "$WT_DIR" "$BRANCH" "$BASE_BRANCH" \
        "$ISSUE_CONTEXT" "$STATUS_FILE" "$TOOLS_DIR" "" "" > "$INSTR_FILE"

      agent_launch_autonomous "$SESSION" "$WIN" "$INSTR_FILE" "$TASK_AGENT_CMD" "$TASK_MODEL"
    fi


    # Add delay between window launches
    sleep 0.5


    echo "✓ Task $ISSUE setup complete"
  ) || {
    echo "FAILED: $ISSUE - $TITLE" | tee -a "$LOG_FILE"
  }
  i=$((i+1))
done
set -e


# Add status dashboard panel in control window (only if not already exists)
STATUS_SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/wavemill-status.sh"
PANE_COUNT=$(tmux list-panes -t "$SESSION:control" -F '#{pane_index}' | wc -l)
if [[ "$PANE_COUNT" -eq 1 ]]; then
  echo "Setting up status dashboard..."
  tmux split-window -t "$SESSION:control" -h -l 40%
  tmux send-keys -t "$SESSION:control.1" "'$STATUS_SCRIPT' '$SESSION' '$WORKTREE_ROOT' '${WAVEMILL_STATE_FILE:-}'" C-m
else
  echo "Status dashboard already exists, skipping..."
fi


echo ""
echo "✓ All tasks initialized!"
echo "Log file: $LOG_FILE"


# Only attach if not called with ORCHESTRATOR_NO_ATTACH=1
if [[ "${ORCHESTRATOR_NO_ATTACH:-}" != "1" ]]; then
  echo "Attaching to session: $SESSION"
  echo ""
  tmux select-window -t "$SESSION:control"
  tmux select-pane -t "$SESSION:control.0"
  tmux attach -t "$SESSION"
else
  echo "Session ready: $SESSION"
  echo ""
fi
