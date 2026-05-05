#!/opt/homebrew/bin/bash
# Wavemill Status Dashboard - Real-time task status for tmux control panel
#
# Usage: wavemill-status.sh <session> <worktree_root> [state_file]
#
# Displays a compact per-task summary refreshing every 2 seconds by default
# (override with WAVEMILL_DASHBOARD_REFRESH_SECONDS=1..10):
#   ISSUE   TASK           TIME   PHASE         AGENT      PR
#   WAV-42  hero-cta        12m   📋 planning   ● running  —
#   WAV-55  nav-a11y         8m   🔨 executing  ● running  #147 ✓

set -euo pipefail

SESSION="${1:?Usage: wavemill-status.sh <session> <worktree_root> [state_file]}"
WORKTREE_ROOT="${2:?Usage: wavemill-status.sh <session> <worktree_root> [state_file]}"
STATE_FILE="${3:-}"

# Signal-driven refresh uses USR1 for fast updates and polling as fallback.
WAVEMILL_REDRAW=0
trap 'WAVEMILL_REDRAW=1' USR1

DEFAULT_REFRESH=2
MAX_REFRESH=10
PR_CACHE="/tmp/${SESSION}-pr-cache.json"
PR_TTL=15

# Colors
G='\033[32m'; Y='\033[33m'; R='\033[31m'; D='\033[90m'; B='\033[1m'; N='\033[0m'
# Erase from cursor to end-of-line after each rendered row so shorter redraws
# cannot leave stale terminal cells behind.
EL='\033[K'

resolve_dashboard_refresh_seconds() {
  local raw_refresh="${WAVEMILL_DASHBOARD_REFRESH_SECONDS:-$DEFAULT_REFRESH}"

  if [[ "$raw_refresh" =~ ^[0-9]+$ ]] && (( raw_refresh >= 1 && raw_refresh <= MAX_REFRESH )); then
    printf '%s\n' "$raw_refresh"
    return 0
  fi

  if [[ "${WAVEMILL_DASHBOARD_REFRESH_WARNED:-0}" -eq 0 ]]; then
    printf 'wavemill: invalid WAVEMILL_DASHBOARD_REFRESH_SECONDS=%s, using default %s\n' \
      "$raw_refresh" "$DEFAULT_REFRESH" >&2
    WAVEMILL_DASHBOARD_REFRESH_WARNED=1
  fi

  printf '%s\n' "$DEFAULT_REFRESH"
}

REFRESH="$(resolve_dashboard_refresh_seconds)"

# Hide cursor during rendering
tput civis 2>/dev/null || true
trap 'tput cnorm 2>/dev/null || true' EXIT

# ── PR cache (refreshed every PR_TTL seconds) ────────────────────────────

refresh_pr_cache() {
  local now
  now=$(date +%s)
  local mtime=0
  [[ -f "$PR_CACHE" ]] && mtime=$(stat -f %m "$PR_CACHE" 2>/dev/null || echo 0)
  if (( now - mtime >= PR_TTL )); then
    local tmp_file
    # Per-writer tmp file so this dashboard refresh does not race the monitor's
    # wavemill_pr_cache_refresh on a shared "${PR_CACHE}.tmp" path.
    tmp_file=$(mktemp "${PR_CACHE}.tmp.XXXXXX" 2>/dev/null) || return 0
    if gh pr list --json number,headRefName,state,statusCheckRollup --limit 50 \
         < /dev/null 2>/dev/null > "$tmp_file"; then
      if [[ -s "$tmp_file" ]]; then
        mv "$tmp_file" "$PR_CACHE" 2>/dev/null || rm -f "$tmp_file"
      else
        rm -f "$tmp_file"
      fi
    else
      rm -f "$tmp_file"
    fi
  fi
}

pr_for_branch() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return 0
  jq -r --arg b "$branch" \
    '.[] | select(.headRefName == $b) | "\(.number)|\(.state)"' \
    "$PR_CACHE" 2>/dev/null | head -1
}

pr_checks() {
  local branch="$1"
  [[ -f "$PR_CACHE" ]] || return 0
  # Rollup entries are either CheckRun (uses .conclusion) or StatusContext
  # (uses .state, e.g. Vercel/Netlify). Coalesce so both are treated uniformly.
  jq -r --arg b "$branch" '
    def outcome: .conclusion // .state;
    .[] | select(.headRefName == $b) |
    .statusCheckRollup // [] |
    if length == 0 then "none"
    elif all(.[]; outcome == "SUCCESS" or outcome == "NEUTRAL" or outcome == "SKIPPED") then "pass"
    elif any(.[]; outcome == "FAILURE" or outcome == "ERROR" or outcome == "TIMED_OUT" or outcome == "CANCELLED") then "fail"
    else "pending" end
  ' "$PR_CACHE" 2>/dev/null | head -1
}

# ── Agent-reported status (from status file) ──────────────────────────────

agent_reported_status() {
  local issue="$1"
  local status_file="/tmp/${SESSION}-${issue}-status.txt"
  if [[ -f "$status_file" ]]; then
    local raw_status
    raw_status=$(head -1 "$status_file" 2>/dev/null | tr -d '\r' | cut -c1-40)
    case "$raw_status" in
      working|waiting|done)
        echo "$raw_status"
        ;;
      *)
        echo "$raw_status"
        ;;
    esac
  fi
}

# Read detail field from hook JSON (e.g., tool name, error message).
# Only returns detail if hook file is fresh (300s TTL).
agent_hook_detail() {
  local issue="$1"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"
  [[ -f "$hook_file" ]] || return 0

  local ts now staleness
  ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
  now=$(date +%s)
  staleness=$(( now - ts ))
  (( staleness < 300 )) || return 0

  jq -r '.detail // empty' "$hook_file" 2>/dev/null || true
}

# Read the planning stage display status from stage result files.
# Returns: awaiting_approval, approved, running, rejected, aborted, or empty string.
get_planning_display_status() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.planning-result.json"

  if [[ -f "$result_file" ]]; then
    local status
    status=$(jq -r '.status // empty' "$result_file" 2>/dev/null)
    case "$status" in
      awaiting_user) echo "awaiting_approval" ;;
      completed)     echo "approved" ;;
      running)       echo "running" ;;
      failed)        echo "rejected" ;;
      aborted)       echo "aborted" ;;
      *)             echo "" ;;
    esac
    return
  fi

}

get_ready_display_status() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local result_file="$feature_dir/.ready-result.json"

  [[ -f "$result_file" ]] || return 0
  jq -r '.status // empty' "$result_file" 2>/dev/null || true
}

is_ready_conflicted() {
  local worktree="$1" slug="$2"
  local feature_dir=""
  local dir

  for dir in features bugs; do
    if [[ -d "$worktree/$dir/$slug" ]]; then
      feature_dir="$worktree/$dir/$slug"
      [[ -f "$feature_dir/.conflict-detected" ]] && return 0
      return 1
    fi
  done

  [[ -f "$worktree/features/$slug/.conflict-detected" ]]
}

ready_attention_detail() {
  local worktree="$1" slug="$2"
  local feature_dir="$worktree/features/$slug"
  local attention_file="$feature_dir/.needs-attention"

  [[ -f "$attention_file" ]] || return 0
  head -1 "$attention_file" 2>/dev/null | tr -d '\r'
}

# Legacy compat wrapper — used in the render loop below.
plan_waiting_for_review() {
  local task_phase="$1"
  local agent_state="$2"
  local worktree="$3"
  local slug="$4"

  [[ "$task_phase" == "planning" ]] || return 1
  [[ -z "$worktree" || -z "$slug" ]] && return 1

  # Prefer stage result
  local display_status
  display_status=$(get_planning_display_status "$worktree" "$slug")
  [[ "$display_status" == "awaiting_approval" ]] && return 0

  # If planning is no longer running and approval has not been recorded, treat
  # an exited agent as waiting for review until the monitor persists the stage update.
  [[ "$agent_state" == "exited" ]] || return 1
  return 0
}

# ── Elapsed time from directory birth ─────────────────────────────────────

elapsed() {
  local dir="$1"
  [[ -d "$dir" ]] || { echo "—"; return; }
  local birth
  birth=$(stat -f %B "$dir" 2>/dev/null || echo 0)
  (( birth > 0 )) || { echo "—"; return; }
  local mins=$(( ($(date +%s) - birth) / 60 ))
  if (( mins < 60 )); then
    printf "%dm" "$mins"
  else
    printf "%dh%dm" $((mins / 60)) $((mins % 60))
  fi
}

# ── Agent status via tmux pane liveness ───────────────────────────────────

# Read agent status via hook protocol with TTL-based fallback to pane liveness.
# Hook files use a 300s TTL - stale status falls back to tmux pane state.
agent_status() {
  local win="$1"
  local issue="${win%%-*}"
  local hook_file="/tmp/wavemill-${SESSION}-${issue}.hook"

  # Prefer hook-reported state when fresh (300s TTL)
  if [[ -f "$hook_file" ]]; then
    local state ts now staleness
    state=$(jq -r '.state // empty' "$hook_file" 2>/dev/null || true)
    ts=$(jq -r '.timestamp // 0' "$hook_file" 2>/dev/null || echo 0)
    now=$(date +%s)
    staleness=$(( now - ts ))

    if (( staleness < 300 )) && [[ -n "$state" ]]; then
      # Map hook states to dashboard display states
      case "$state" in
        working) echo "running" ;;
        idle)    echo "exited" ;;
        waiting) echo "waiting" ;;
        error)   echo "error" ;;
        *)       echo "$state" ;;
      esac
      return
    fi
  fi

  # Fallback to pane liveness for agents without hook support or stale hooks
  local dead
  dead=$(tmux list-panes -t "$SESSION:$win" -F '#{pane_dead}' 2>/dev/null | head -1) || {
    echo "done"; return
  }
  if [[ "$dead" == "1" ]]; then echo "exited"; else echo "running"; fi
}

# ── Task discovery ────────────────────────────────────────────────────────
# Prefer state file (from mill), fall back to worktree directories.
# Output: issue|slug|branch|worktree|status|phase|pr  per line

gather_tasks() {
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    jq -r '.tasks | to_entries[] | "\(.key)|\(.value.slug)|\(.value.branch)|\(.value.worktree)|\(.value.status // "")|\(.value.phase // "executing")|\(.value.pr // "")"' \
      "$STATE_FILE" 2>/dev/null
  else
    for dir in "$WORKTREE_ROOT"/*/; do
      [[ -d "$dir" ]] || continue
      local slug
      slug=$(basename "$dir")
      local branch
      branch=$(git -C "$dir" branch --show-current 2>/dev/null || echo "?")
      echo "—|$slug|$branch|$dir||executing|"
    done
  fi
}

gather_jobs() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  jq -r '
    (.jobs // {}) |
    if type == "array" then .[] else (to_entries[] | .value) end |
    select(.kind == "eval" or .kind == "comparison") |
    [
      .id,
      .kind,
      (.status // ""),
      (.issueId // "-"),
      (.side // "-"),
      (.pairId // "-"),
      ((.prNumbers // []) | map(tostring) | join("/")),
      (.startedAt // "-"),
      (.logPath // "-"),
      ((.excerpt // "") | gsub("[\r\n]+"; " "))
    ] | join("|")
  ' "$STATE_FILE" 2>/dev/null
}

# ── Check if a task is still active ──────────────────────────────────────
# A task is active if its worktree exists OR its tmux window exists.

is_active() {
  local worktree="$1"
  local win="$2"
  [[ -d "$worktree" ]] && return 0
  tmux list-panes -t "$SESSION:$win" 2>/dev/null >/dev/null && return 0
  return 1
}

# Truncate detail string to fit within available terminal width.
# Format "%-10s  %4s  └─ %s" uses ~20 chars of prefix, leaving ~60 for content on 80-char terminal.
truncate_detail() {
  local detail="$1"
  local max_len=55
  if (( ${#detail} > max_len )); then
    echo "${detail:0:52}..."
  else
    echo "$detail"
  fi
}

format_job_elapsed() {
  local started_at="$1"
  local start_epoch now elapsed ts
  ts="${started_at%%.*}"
  if date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" >/dev/null 2>&1; then
    # BSD/macOS date
    start_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" "+%s" 2>/dev/null || echo 0)
  else
    # GNU/Linux date
    start_epoch=$(date -d "${ts/T/ }" "+%s" 2>/dev/null || echo 0)
  fi
  now=$(date +%s)
  if (( start_epoch <= 0 || now < start_epoch )); then
    echo "—"
    return
  fi
  elapsed=$(( (now - start_epoch) / 60 ))
  if (( elapsed < 60 )); then
    printf "%dm" "$elapsed"
  else
    printf "%dh%dm" $((elapsed / 60)) $((elapsed % 60))
  fi
}

# Classify dashboard tasks into sections based on agent state.
is_actionable_state() {
  local agent_state="$1"
  local task_phase="${2:-}"
  local worktree="${3:-}"
  local slug="${4:-}"
  local ready_status attention_detail

  attention_detail=$(ready_attention_detail "$worktree" "$slug")
  if [[ -n "$attention_detail" ]]; then
    echo "actionable"
    return
  fi

  if [[ "$task_phase" == "ready" ]]; then
    ready_status=$(get_ready_display_status "$worktree" "$slug")
    case "$ready_status" in
      completed|failed|aborted)
        echo "actionable"
        return
        ;;
    esac
  fi

  case "$agent_state" in
    exited|waiting|error) echo "actionable" ;;
    *)                    echo "active" ;;
  esac
}

window_index() {
  local win="$1"
  # `tmux display-message -t session:missing-window` silently falls back to the
  # active window's info instead of erroring, which misreports missing task
  # windows as whichever window is currently focused (typically the control
  # window at index 0). Verify presence first.
  if ! tmux list-windows -t "$SESSION" -F '#{window_name}' 2>/dev/null | grep -qxF "$win"; then
    echo "—"
    return
  fi
  tmux display-message -t "$SESSION:$win" -p '#{window_index}' 2>/dev/null || echo "—"
}

render_section_header() {
  local title="$1"
  local count="$2"
  printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "$title" "$count" >> "$FRAME"
  printf "${D}%-10s  %4s  %-22s  %6s  %-12s  %-11s  %s${N}${EL}\n" \
    "ISSUE" "PANE" "TASK" "TIME" "PHASE" "AGENT" "PR" >> "$FRAME"
  printf "${D}%s${N}${EL}\n" \
    "────────────────────────────────────────────────────────────────────────────────" >> "$FRAME"
}

# Render one task row and any optional follow-up detail line.
render_task_row() {
  local issue="$1" slug="$2" branch="$3" worktree="$4" win="$5"
  local task_status="$6" task_phase="$7" state_pr="$8" agent_state="$9"
  local t st_str pr_str pr_info checks phase_str plan_status ready_status attention_detail reported ds pane

  t=$(elapsed "$worktree")
  reported=""

  if [[ "$task_status" == "merged" ]]; then
    st_str="${G}✓ merged${N}"
  else
    # Prefer rich hook detail (tool names, errors) over legacy text files.
    reported=$(agent_hook_detail "$issue")
    [[ -z "$reported" ]] && reported=$(agent_reported_status "$issue")
    case "$agent_state:$reported" in
      waiting:*)       st_str="${Y}⏳ waiting${N}" ;;
      error:*)         st_str="${R}! error${N}" ;;
      exited:*)        st_str="${D}○ exited${N}" ;;
      running:working) st_str="${G}● working${N}" ;;
      running:waiting) st_str="${Y}⏳ waiting${N}" ;;
      running:done)    st_str="${D}● idle${N}" ;;
      running:*)       st_str="${G}● running${N}" ;;
      *)               st_str="${D}  done${N}" ;;
    esac
  fi

  # Only resolve PR cache entries for tasks already tracked with a PR.
  pr_str="${D}—${N}"
  pr_info=""
  if [[ -n "$state_pr" ]]; then
    pr_info=$(pr_for_branch "$branch")
  fi
  if [[ -n "$pr_info" ]]; then
    IFS='|' read -r pr_num pr_state <<<"$pr_info"
    case "$pr_state" in
      MERGED) pr_str="${G}#${pr_num} MERGED${N}" ;;
      CLOSED) pr_str="${R}#${pr_num} CLOSED${N}" ;;
      OPEN)
        if is_ready_conflicted "$worktree" "$slug"; then
          pr_str="${Y}#${pr_num} ⚠${N}"
        else
          checks=$(pr_checks "$branch")
          case "$checks" in
            pass)    pr_str="${G}#${pr_num} ✓${N}" ;;
            fail)    pr_str="${R}#${pr_num} ✗${N}" ;;
            pending) pr_str="${Y}#${pr_num} …${N}" ;;
            *)       pr_str="#${pr_num}" ;;
          esac
        fi
        ;;
    esac
  fi

  case "$task_phase" in
    planning)
      plan_status=""
      [[ -n "$worktree" && -n "$slug" ]] && plan_status=$(get_planning_display_status "$worktree" "$slug")
      case "$plan_status" in
        awaiting_approval) phase_str="${Y}⏳ awaiting${N}" ;;
        approved)          phase_str="${G}✅ approved${N}" ;;
        rejected)          phase_str="${R}❌ rejected${N}" ;;
        *)                 phase_str="${Y}📋 planning${N}" ;;
      esac
      ;;
    executing) phase_str="${G}🔨 executing${N}" ;;
    coding)    phase_str="${G}💻 coding${N}" ;;
    review)    phase_str="${Y}🔍 review${N}" ;;
    ready)
      if is_ready_conflicted "$worktree" "$slug"; then
        phase_str="${Y}⚠ ready${N}"
      else
        ready_status=$(get_ready_display_status "$worktree" "$slug")
        case "$ready_status" in
          failed|aborted) phase_str="${R}🚦 ready${N}" ;;
          completed)      phase_str="${Y}🚦 ready${N}" ;;
          *)              phase_str="${G}🚦 ready${N}" ;;
        esac
      fi
      ;;
    *)         phase_str="${D}$task_phase${N}" ;;
  esac

  ds="$slug"
  (( ${#ds} > 22 )) && ds="${ds:0:19}..."
  pane=$(window_index "$win")

  printf "%-10s  %4s  %-22s  %6s  %-12b  %-11b  %b${EL}\n" \
    "$issue" "$pane" "$ds" "$t" "$phase_str" "$st_str" "$pr_str" >> "$FRAME"

  if plan_waiting_for_review "$task_phase" "$agent_state" "$worktree" "$slug"; then
    reported="Plan ready — waiting for approval"
  fi
  attention_detail=$(ready_attention_detail "$worktree" "$slug")
  if [[ -z "$reported" && -n "$attention_detail" ]]; then
    reported="$attention_detail"
  fi
  case "$reported" in
    working|waiting|done) reported="" ;;
  esac
  if [[ -n "$reported" ]]; then
    reported=$(truncate_detail "$reported")
    printf "${D}%10s  %4s  └─ %s${N}${EL}\n" "" "" "$reported" >> "$FRAME"
  fi
}

render_inbox_section() {
  local count="${#inbox_tasks[@]}"
  local task_data issue slug branch worktree task_status task_phase state_pr agent_state
  (( count == 0 )) && return

  render_section_header "📥 INBOX" "$count"
  for task_data in "${inbox_tasks[@]}"; do
    IFS='|' read -r issue slug branch worktree win task_status task_phase state_pr agent_state <<<"$task_data"
    render_task_row "$issue" "$slug" "$branch" "$worktree" "$win" "$task_status" "$task_phase" "$state_pr" "$agent_state"
  done
}

render_active_section() {
  local count="${#active_tasks[@]}"
  local task_data issue slug branch worktree task_status task_phase state_pr agent_state

  render_section_header "⚡ ACTIVE" "$count"
  if (( count == 0 )); then
    printf "${D}No active tasks${N}${EL}\n" >> "$FRAME"
    return
  fi

  for task_data in "${active_tasks[@]}"; do
    IFS='|' read -r issue slug branch worktree win task_status task_phase state_pr agent_state <<<"$task_data"
    render_task_row "$issue" "$slug" "$branch" "$worktree" "$win" "$task_status" "$task_phase" "$state_pr" "$agent_state"
  done
}

render_queued_section() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local count
  count=$(jq '(.queued_tasks // []) | length' "$STATE_FILE" 2>/dev/null || echo 0)
  (( count == 0 )) && return 0

  printf "${EL}\n${B}%s${N} ${D}(%s)${N}${EL}\n" "⏸ PENDING DEPENDENCY" "$count" >> "$FRAME"
  printf "${D}%-10s  %-12s  %-8s  %s${N}${EL}\n" "ISSUE" "BLOCKER" "PR" "BASE" >> "$FRAME"
  printf "${D}%s${N}${EL}\n" "──────────────────────────────────────────────" >> "$FRAME"

  jq -r '
    (.queued_tasks // [])[] |
    [
      .issue_id,
      (.blocker_issue_id // "?"),
      (if .blocker_pr_number != null then "#\(.blocker_pr_number)" else "(no PR)" end),
      (.desired_base_branch // "?")
    ] | @tsv
  ' "$STATE_FILE" 2>/dev/null | while IFS=$'\t' read -r issue blocker pr base; do
    printf "%-10s  %-12s  %-8s  %s${EL}\n" "$issue" "$blocker" "$pr" "$base" >> "$FRAME"
  done
}

render_jobs_section() {
  [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]] || return 0
  local jobs count=0 line
  jobs=$(gather_jobs)
  [[ -z "$jobs" ]] && return 0

  printf "${EL}\n${B}%s${N}${EL}\n" "🛠 JOBS" >> "$FRAME"
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    count=$((count + 1))
  done <<<"$jobs"
  printf "${D}Tracked background jobs (${count})${N}${EL}\n" >> "$FRAME"

  while IFS='|' read -r job_id kind job_status issue side pair_id prs started_at log_path excerpt; do
    local label elapsed status_str target detail
    elapsed=$(format_job_elapsed "$started_at")
    label="$kind"
    target="$issue"
    [[ "$kind" == "eval" && "$side" != "-" ]] && target="${issue}:${side}"
    [[ "$kind" == "comparison" ]] && target="${pair_id}:${prs}"

    case "$job_status" in
      running) status_str="${G}running${N}" ;;
      succeeded) status_str="${G}succeeded${N}" ;;
      timeout) status_str="${Y}timeout${N}" ;;
      *) status_str="${R}${job_status}${N}" ;;
    esac

    printf "%-10s  %-18s  %6s  %b  %s${EL}\n" "$label" "$target" "$elapsed" "$status_str" "$(basename "$log_path")" >> "$FRAME"
    if [[ "$job_status" == "failed" || "$job_status" == "timeout" ]]; then
      detail="$excerpt"
      [[ -z "$detail" ]] && detail="$log_path"
      detail=$(truncate_detail "$detail")
      printf "${D}%10s  %18s  %6s  └─ %s${N}${EL}\n" "" "" "" "$detail" >> "$FRAME"
    fi
  done <<<"$jobs"
}

# Clear saved scrollback lines without blanking the visible pane. This keeps
# tmux history from accumulating stale dashboards while avoiding a full-screen
# flash on every refresh.
clear_dashboard_scrollback() {
  tput E3 2>/dev/null || printf '\033[3J'
}

# Redraw the dashboard from the top-left corner in one grouped write so tmux
# sees a single refresh operation rather than separate cursor, content, and
# clear steps.
redraw_dashboard_frame() {
  local frame_file="$1"
  {
    tput cup 0 0 2>/dev/null || printf '\033[H'
    cat "$frame_file"
    tput ed 2>/dev/null || printf '\033[J'
  }
}

render_dashboard() {
  local tasks line issue slug branch worktree task_status task_phase state_pr
  local win agent_state classification task_data free_slots
  declare -ga inbox_tasks=()
  declare -ga active_tasks=()

  # Build entire frame into a temp file (avoids $() stripping newlines)
  : > "$FRAME"
  printf "${B}Wavemill Dashboard${N}  ${D}%s${N}${EL}\n" "$(date '+%H:%M:%S')" >> "$FRAME"
  free_slots=""
  if [[ -r "$STATE_FILE" && -s "$STATE_FILE" ]]; then
    free_slots=$(jq -r '.freeSlots // empty' "$STATE_FILE" 2>/dev/null || echo "")
  fi
  if [[ -n "$free_slots" ]]; then
    printf "${D}├─ %b${N}${EL}\n" "${G}${free_slots} slot(s) available${N}" >> "$FRAME"
  fi

  tasks=$(gather_tasks)
  if [[ -z "$tasks" ]]; then
    printf "${D}No active tasks${N}${EL}\n" >> "$FRAME"
  else
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      IFS='|' read -r issue slug branch worktree task_status task_phase state_pr <<<"$line"
      task_phase="${task_phase:-executing}"

      win="${issue}-${slug}"
      [[ "$issue" == "—" ]] && win="$slug"

      is_active "$worktree" "$win" || continue

      agent_state=""
      if [[ "$task_status" == "merged" ]]; then
        agent_state="exited"
      else
        agent_state=$(agent_status "$win")
      fi

      classification=$(is_actionable_state "$agent_state" "$task_phase" "$worktree" "$slug")
      task_data="$issue|$slug|$branch|$worktree|$win|$task_status|$task_phase|$state_pr|$agent_state"

      if [[ "$classification" == "actionable" ]]; then
        inbox_tasks+=("$task_data")
      else
        active_tasks+=("$task_data")
      fi
    done <<<"$tasks"

    render_inbox_section
    render_active_section
    render_jobs_section
    render_queued_section
  fi

  printf "${EL}\n${D}Refreshes every ${REFRESH}s │ Ctrl+B <PANE>: switch task │ Ctrl+B N: next done${N}${EL}\n" >> "$FRAME"
}

run_dashboard() {
  # Disable errexit inside the render loop. USR1 signals (from hook writes)
  # can interrupt any command mid-execution; under set -e the interrupted
  # command's non-zero exit kills the entire script. The render helpers
  # already guard failures with "|| true" / "2>/dev/null" so errexit adds
  # no safety here — only fragility.
  set +e
  while true; do
    # Block USR1 during rendering to prevent partial frame output.
    # Signals received during this window set WAVEMILL_REDRAW via the trap
    # but are deferred until the interruptible wait below.
    trap '' USR1

    # Keep tmux scrollback clean without blanking the visible pane.
    clear_dashboard_scrollback
    refresh_pr_cache
    render_dashboard
    redraw_dashboard_frame "$FRAME"

    # Re-enable USR1 for the interruptible wait. Any signal received while
    # blocked above will have been queued and will fire the trap now.
    trap 'WAVEMILL_REDRAW=1' USR1
    WAVEMILL_REDRAW=0
    sleep "$REFRESH" &
    SLEEP_PID=$!
    wait "$SLEEP_PID" 2>/dev/null || true
  done
}

# ── Main render loop ─────────────────────────────────────────────────────

FRAME=$(mktemp)
trap 'tput cnorm 2>/dev/null || true; rm -f "$FRAME"' EXIT INT TERM

if [[ "${BASH_SOURCE[0]:-}" == "$0" ]]; then
  run_dashboard
fi
