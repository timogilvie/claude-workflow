#!/opt/homebrew/bin/bash
# Agent Adapter Library
# Abstracts agent-specific launch patterns so the orchestrator and mill
# scripts don't need to know how each agent CLI works.
#
# Adding a new agent: add a case block in each function below.

# ============================================================================
# AGENT RESOLUTION
# ============================================================================

# Resolve the agent CLI command for a given model ID using prefix heuristics.
# Mirrors the logic in shared/lib/model-router.ts resolveAgent().
# Args: $1 = model ID (e.g. "claude-opus-4-6", "gpt-5.3-codex")
# Prints: agent command name (e.g. "claude", "codex")
agent_resolve_from_model() {
  local model="$1"
  case "$model" in
    claude-*) echo "claude" ;;
    gpt-*|o[0-9]*) echo "codex" ;;
    *) echo "${AGENT_CMD:-claude}" ;;
  esac
}

# ============================================================================
# MODEL VALIDATION
# ============================================================================

# Validate a model ID exists in config (pricing or agentMap).
# Args: $1 = model ID, $2 = repo directory (optional)
# Returns: 0 if valid, 1 if invalid (prints error to stderr)
# Note: Requires TOOLS_DIR environment variable to be set (from wavemill script)
agent_validate_model() {
  local model="$1"
  local repo_dir="${2:-$(pwd)}"

  # Convert to absolute path
  repo_dir="$(cd "$repo_dir" 2>/dev/null && pwd || echo "$repo_dir")"

  # Derive lib directory from TOOLS_DIR (TOOLS_DIR = repo/tools, LIB_DIR = repo/shared/lib)
  local lib_dir="${TOOLS_DIR%/tools}/shared/lib"
  local validator="model-validator.ts"

  # Call TypeScript validator (cd to lib_dir first for imports to work)
  # Exits 0 if valid, 1 if invalid with error message
  if (cd "$lib_dir" && npx tsx "$validator" "$model" "$repo_dir" 2>&1); then
    return 0
  else
    return 1
  fi
}

# ============================================================================
# AGENT VALIDATION
# ============================================================================

# Check that the agent CLI binary is available on PATH.
# Args: $1 = agent command name (e.g. "claude", "codex")
# Returns: 0 if found, 1 if not
agent_validate() {
  local cmd="$1"
  command -v "$cmd" >/dev/null 2>&1
}

# Check if agent is authenticated and ready to use.
# Args: $1 = agent command name (e.g. "claude", "codex")
# Returns: 0 if authenticated, 1 if not authenticated
# Output: Error message to stderr if not authenticated
# Note: Results are cached per-process to avoid redundant checks
declare -A _AGENT_AUTH_CACHE

agent_check_auth() {
  local cmd="$1"

  # Return cached result if available (valid for this process lifetime)
  if [[ -n "${_AGENT_AUTH_CACHE[$cmd]:-}" ]]; then
    return "${_AGENT_AUTH_CACHE[$cmd]}"
  fi

  case "$cmd" in
    claude)
      # Use 'claude auth status' which exits 0 when logged in
      if ! claude auth status >/dev/null 2>&1; then
        echo "Error: Claude authentication required. Run: claude auth login" >&2
        _AGENT_AUTH_CACHE[$cmd]=1
        return 1
      fi
      ;;
    codex)
      # Check for auth file existence and non-empty (fast path)
      local auth_file="$HOME/.codex/auth.json"
      if [[ ! -s "$auth_file" ]]; then
        echo "Error: Codex authentication required. Run: codex login" >&2
        _AGENT_AUTH_CACHE[$cmd]=1
        return 1
      fi
      ;;
    *)
      # Unknown agent - assume authenticated (don't block unknown agents)
      _AGENT_AUTH_CACHE[$cmd]=0
      return 0
      ;;
  esac

  _AGENT_AUTH_CACHE[$cmd]=0
  return 0
}

# ============================================================================
# PROMPT BUILDERS
# ============================================================================
# Single source of truth for agent prompts. Used by both
# wavemill-orchestrator.sh (initial batch) and launch_task() (monitor loop).

# Build the autonomous (skip-mode) prompt.
# All variables are passed explicitly so there's no implicit coupling.
#
# Args (named via local vars — call with positional):
#   $1 = title        (issue title)
#   $2 = issue        (issue ID, e.g. HOK-123)
#   $3 = wt_dir       (worktree path)
#   $4 = branch       (git branch)
#   $5 = base_branch  (e.g. main)
#   $6 = issue_context (description + details text)
#   $7 = status_file  (path for status reporting)
#   $8 = tools_dir    (path to wavemill tools/)
#   $9 = reviewer_model (optional: recommended reviewer model)
#   $10 = review_mode  (optional: recommended review mode)
# Prints: the complete prompt to stdout
build_autonomous_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8"
  local reviewer_model="${9:-}" review_mode="${10:-}"

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context

Goal:
- Implement the feature/fix described by the issue and title.

IMPORTANT: You are running autonomously with NO user interaction.
- Do NOT ask questions or request user input — make your best judgment call.
- If a decision is ambiguous, choose the most reasonable default and document your choice in the PR description.
- If you truly cannot proceed without clarification, note the blocker in the PR description and implement what you can.

Status Reporting:
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step (e.g. "reading codebase", "implementing auth handler", "running tests", "creating PR"). This feeds the Wavemill dashboard so the user can see your progress.

Success criteria:
- [ ] Implementation matches issue requirements
- [ ] UI is responsive and accessible (if applicable)
- [ ] Lint/tests pass
- [ ] Self-review tool executed (npx tsx $tools_dir/review-changes.ts)
- [ ] No regressions in existing functionality
- [ ] PR created with clear description and linked to $issue

Process:
1. Inspect repo and find relevant code
2. Make minimal, high-quality changes
3. Run tests/lint
4. REQUIRED: Run the self-review tool before creating a PR (do not skip or substitute your own review):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. You MUST set a 600s timeout on your Bash tool call.
   npx tsx $tools_dir/review-changes.ts $base_branch --json
   $(if [[ -n "$reviewer_model" ]]; then
     echo "   NOTE: Workflow router recommends using $reviewer_model for review (mode: ${review_mode:-static})"
   fi)
   - Exit code 0 = passed → proceed to step 5
   - Exit code 1 = issues found → fix blockers, commit fixes, re-run (up to 3 iterations)
   - Exit code 2 = error → log comprehensive diagnostics and proceed to step 5
   The output is structured JSON with verdict, codeReviewFindings (each with severity/location/category/description), and optional uiFindings.
   For each iteration with issues: fix all findings where severity is "blocker" and straightforward "warning" items,
   commit with "fix: Address self-review findings (iteration N)", then re-run the tool.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   \`\`\`
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx $tools_dir/review-changes.ts $base_branch --json
   - Working directory: \$(pwd)
   - Tool path: $tools_dir/review-changes.ts
   - Tool exists: \$(ls -lh $tools_dir/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: \$(git rev-parse --show-toplevel 2>&1)
   - Current branch: \$(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: \$(git rev-parse --verify $base_branch 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation per instructions.
   \`\`\`
   This diagnostic information is CRITICAL for debugging recurring tool failures.
5. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$issue: <concise summary of changes>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
6. Post back with summary of changes, commands run + results, and PR link
_WVML_PROMPT_
}

# Build the interactive (planning-mode) prompt.
#
# Args (positional):
#   $1 = title
#   $2 = issue
#   $3 = wt_dir
#   $4 = branch
#   $5 = base_branch
#   $6 = issue_context
#   $7 = status_file
#   $8 = tools_dir
#   $9 = slug
# Prints: the complete prompt to stdout
build_interactive_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"

  cat <<_WVML_PROMPT_
You are working on: $title ($issue)

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

$issue_context
---

## Status Reporting
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step (e.g. "reading codebase", "implementing auth handler", "running tests", "creating PR"). This feeds the Wavemill dashboard so the user can see your progress.

## Your Workflow

You have THREE phases. Do them in order.

### Phase 1: Planning (interactive)
Task context is pre-seeded at: features/$slug/selected-task.json

1. Read the task context
2. Research the codebase to understand relevant code and patterns
3. Create a detailed implementation plan with phases
4. Save the plan to: features/$slug/plan.md
5. Present the plan summary to the user and wait for approval
6. After approval, create a file: features/$slug/.plan-approved

Do NOT proceed to Phase 2 until the user has approved the plan.
If anything is unclear about the requirements, ask the user for clarification before finalizing the plan.

### Phase 2: Implementation
After plan approval:
1. Execute the plan phase by phase
2. Run tests/lint between phases — pause if anything fails

### Phase 3: Self-Review & PR
After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

1. Run the self-review tool (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. You MUST set a 600s timeout on your Bash tool call.
   npx tsx $tools_dir/review-changes.ts $base_branch --json
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics and proceed to step 3
   The output is structured JSON with verdict, codeReviewFindings, and uiFindings.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   \`\`\`
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx $tools_dir/review-changes.ts $base_branch --json
   - Working directory: \$(pwd)
   - Tool path: $tools_dir/review-changes.ts
   - Tool exists: \$(ls -lh $tools_dir/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: \$(git rev-parse --show-toplevel 2>&1)
   - Current branch: \$(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: \$(git rev-parse --verify $base_branch 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation per instructions.
   \`\`\`
   This diagnostic information is CRITICAL for debugging recurring tool failures.

2. For each iteration where issues are found:
   - Read the review JSON output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - Make targeted fixes only — do not refactor unrelated code
   - Commit fixes: git commit -m "fix: Address self-review findings (iteration N)"
   - Re-run the review tool (step 1)

3. Create a PR using GitHub CLI with a descriptive title and body:
   gh pr create --title "$issue: <concise summary>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
4. Link the PR to $issue

Success criteria:
- [ ] Implementation matches plan and issue requirements
- [ ] Lint/tests pass
- [ ] Self-review tool executed (npx tsx $tools_dir/review-changes.ts)
- [ ] No regressions
- [ ] PR created with descriptive summary linked to $issue

### Phase 4: Review & Respond
After creating the PR:
1. Present a brief summary of what was implemented and any decisions you made
2. Remain available — the user may have questions, want changes, or need you to address CI failures
3. If asked to make changes, push them to the same branch to update the PR
4. Do NOT exit until the user confirms they are done

Start with Phase 1 now. Read the task context and begin researching.
_WVML_PROMPT_
}


# ============================================================================
# AGENT LAUNCH — AUTONOMOUS (SKIP) MODE
# ============================================================================

# Launch an agent in autonomous mode inside a tmux window.
# The agent receives a pre-written instructions file and runs without
# interactive user input.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to instructions file
#   $4 = agent command name
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
agent_launch_autonomous() {
  local session="$1"
  local window="$2"
  local instr_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  # Wrap agent command so exit status is visible and the shell survives
  case "$agent_cmd" in
    claude)
      tmux send-keys -t "$session:$window" "cat '$instr_file' | claude${model_flag}; echo '[wavemill] Agent exited (\$?)'" C-m
      ;;
    codex)
      tmux send-keys -t "$session:$window" "codex exec${model_flag} --dangerously-bypass-approvals-and-sandbox - < '$instr_file'; echo '[wavemill] Agent exited (\$?)'" C-m
      ;;
    *)
      # Generic fallback: start the agent, then paste instructions via tmux buffer.
      tmux send-keys -t "$session:$window" "$agent_cmd" C-m
      sleep 0.3
      local instr
      instr="$(cat "$instr_file")"
      tmux set-buffer "$instr"
      tmux paste-buffer -t "$session:$window"
      tmux send-keys -t "$session:$window" C-m
      ;;
  esac
}

# ============================================================================
# AGENT LAUNCH — INTERACTIVE (PLANNING) MODE
# ============================================================================

# Launch an agent interactively in a tmux window for user-guided planning.
# Creates a small launcher script that execs the agent with the prompt.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = path to prompt file
#   $4 = agent command name
#   $5 = model ID (optional — when set, passes --model flag to the agent CLI)
agent_launch_interactive() {
  local session="$1"
  local window="$2"
  local prompt_file="$3"
  local agent_cmd="$4"
  local model="${5:-}"

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  local launcher="/tmp/${session}-$(basename "$prompt_file" .txt)-launcher.sh"

  # Don't use exec — keep the shell alive so the window persists after agent exit
  case "$agent_cmd" in
    claude)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
claude${model_flag} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    codex)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
codex${model_flag} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    *)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
$agent_cmd "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
  esac

  chmod +x "$launcher"
  tmux send-keys -t "$session:$window" "'$launcher'" C-m
}

# ============================================================================
# AGENT DISPLAY NAME
# ============================================================================

# Return a human-friendly display name for an agent command.
# Args: $1 = agent command name
agent_name() {
  local cmd="$1"
  case "$cmd" in
    claude) echo "Claude" ;;
    codex)  echo "Codex" ;;
    *)      echo "$cmd" ;;
  esac
}
