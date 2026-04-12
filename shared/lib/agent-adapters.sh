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

agent_model_looks_like_depth_tag() {
  local model="$1"
  case "$model" in
    light|medium|deep|standard|fast)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

agent_default_model_for_cmd() {
  local agent_cmd="$1"
  case "$agent_cmd" in
    codex) echo "gpt-5.4" ;;
    claude) echo "claude-sonnet-4-5-20250929" ;;
    *) echo "" ;;
  esac
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

agent_exit_followup_text() {
  local agent_cmd="${1:-claude}"

  # Agent-agnostic: the orchestrator detects session end via pane state (HOK-1177)
  echo "Stop working. The orchestrator will handle cleanup."
}

agent_abort_feedback_text() {
  local agent_cmd="${1:-claude}" marker_path="$2"

  # Agent-agnostic: create the abort marker; orchestrator detects it (HOK-1177)
  echo "create $marker_path and stop working. The orchestrator will handle cleanup."
}

agent_exit_guard_text() {
  local agent_cmd="${1:-claude}" condition_text="$2"

  # Agent-agnostic: focus on artifact completion, not exit semantics (HOK-1177)
  echo "stop working until $condition_text"
}

agent_completion_text() {
  local agent_cmd="${1:-claude}" suffix="${2:-}"

  # Agent-agnostic: orchestrator handles termination detection (HOK-1177)
  if [[ -n "$suffix" ]]; then
    echo "stop working. The orchestrator will detect completion and proceed. $suffix"
  else
    echo "stop working. The orchestrator will detect completion and proceed."
  fi
}

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
  local reviewer_model="${9:-}" review_mode="${10:-}" agent_cmd="${11:-claude}"
  local abort_exit_instruction
  abort_exit_instruction="$(agent_exit_followup_text "$agent_cmd")"

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
- If workflow automation explicitly tells you to stop, abort, close the issue, or discontinue work, do not proceed to later steps.

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
   If workflow automation explicitly tells you to stop, abort, close the issue, or discontinue work:
   - Create the abort marker: touch "$wt_dir/features/$(basename "$wt_dir")/.workflow-aborted"
   - Do NOT create additional completion markers or a PR
   - Report that the workflow is stopping
   - $abort_exit_instruction
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

Do NOT proceed to Phase 2 until the user has approved the plan.
Do NOT create any approval marker files — the orchestrator handles plan approval.
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

# Build the routing phase prompt.
# This phase determines which models to use for planning/coding/review.
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
build_routing_prompt() {
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
Keep it under 50 chars. Update it at each major step.

## Your Task: Workflow Routing

You are in the **ROUTING PHASE** of a multi-phase workflow. Your job is to:

1. Analyze the task requirements
2. Determine the optimal model for each workflow phase:
   - **Planner**: Model for creating the implementation plan
   - **Coder**: Model for implementing the feature/fix
   - **Reviewer**: Model for self-review and PR creation
3. Recommend the workflow depth/mode for each phase

### Steps

1. Read the task context above and understand the requirements
2. Run the routing tool to get recommendations:
   npx tsx $tools_dir/route-task.ts --json --file features/$slug/selected-task.json --repo-dir $wt_dir

3. Save the routing results to features/$slug/.routing-complete as JSON:
   {
     "planner": "claude-sonnet-4-5-20250929",
     "coder": "claude-opus-4-6",
     "reviewer": "claude-sonnet-4-5-20250929",
     "planDepth": "light",
     "codeDepth": "medium",
     "reviewMode": "static"
   }

4. Report completion with a brief summary of the routing decisions

### Success Criteria
- [ ] Routing tool executed successfully
- [ ] Results saved to features/$slug/.routing-complete
- [ ] JSON is valid and contains all required fields

### Important Notes
- Use the routing tool's recommendations directly - don't override them
- If the routing tool fails, use sensible defaults:
  - planner: claude-sonnet-4-5-20250929
  - coder: claude-opus-4-6
  - reviewer: claude-sonnet-4-5-20250929
  - planDepth: light
  - codeDepth: medium
  - reviewMode: static

After completing the routing, your work is done. The next phase (planning) will be launched automatically.
_WVML_PROMPT_
}

# Build the planning phase prompt.
# This phase expands the task packet and creates an implementation plan.
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
#   $10 = plan_depth
# Prints: the complete prompt to stdout
build_planning_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local plan_depth="${10:-light}" agent_cmd="${11:-claude}"
  local abort_feedback_instruction exit_guard_text approved_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "features/$slug/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "the user has explicitly approved your plan")"
  approved_completion_text="$(agent_completion_text "$agent_cmd" "The next phase will be launched automatically.")"

  # Build depth-specific guidance
  local depth_guidance
  if [[ "$plan_depth" == "deep" ]]; then
    depth_guidance="- Create a comprehensive, detailed plan with substeps
- Research multiple approaches and justify your choice
- Document all architectural decisions
- Include detailed test scenarios"
  else
    depth_guidance="- Create a concise plan focused on the critical path
- Document key decisions and approach
- Include basic test coverage"
  fi

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/planning-phase.md"
  local template_content
  if [[ -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
    template_content="${template_content//\{\{PLAN_DEPTH\}\}/$plan_depth}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{TOOLS_DIR\}\}/$tools_dir}"
    template_content="${template_content//\{\{ISSUE\}\}/$issue}"
    template_content="${template_content//\{\{DEPTH_GUIDANCE\}\}/$depth_guidance}"
  else
    template_content="[ERROR: Planning template not found at $template_file]"
  fi

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
Keep it under 50 chars. Update it at each major step.

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the phase requirements are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now" or "move to next phase"
- DO NOT: Create the phase completion marker if the user wants to stop
- DO: After the user explicitly approves, create the approval marker: touch features/$slug/.plan-approved
- DO NOT: $exit_guard_text

After the user approves your plan, create features/$slug/.plan-approved and then $approved_completion_text
_WVML_PROMPT_
}

# Build the coding phase prompt.
# This phase executes the implementation plan.
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
#   $10 = code_depth
# Prints: the complete prompt to stdout
build_coding_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local code_depth="${10:-medium}" agent_cmd="${11:-claude}"
  local abort_feedback_instruction exit_guard_text coding_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "features/$slug/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "ALL phase requirements are met")"
  coding_completion_text="$(agent_completion_text "$agent_cmd" "The next phase will be launched automatically.")"

  # Build depth-specific guidance
  local depth_guidance
  if [[ "$code_depth" == "deep" ]]; then
    depth_guidance="- Implement comprehensive error handling
- Add extensive test coverage
- Consider edge cases and performance
- Add detailed inline documentation"
  elif [[ "$code_depth" == "light" ]]; then
    depth_guidance="- Focus on the happy path
- Basic error handling only
- Minimal test coverage"
  else
    depth_guidance="- Implement core functionality with good error handling
- Add reasonable test coverage
- Handle common edge cases"
  fi

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/coding-phase.md"
  local template_content
  if [[ -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
    template_content="${template_content//\{\{CODE_DEPTH\}\}/$code_depth}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{DEPTH_GUIDANCE\}\}/$depth_guidance}"
  else
    template_content="[ERROR: Coding template not found at $template_file]"
  fi

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
Keep it under 50 chars. Update it at each major step.

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the phase requirements are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now" or "move to next phase"
- DO NOT: Create the phase completion marker if the user wants to stop
- DO NOT: Create .coding-complete just because you received feedback
- DO NOT: $exit_guard_text

### Pre-Completion Checklist

Before creating .coding-complete, verify ALL of these are true:
- All phases from plan.md are implemented
- All tests pass (run the test/lint commands)
- No compilation errors
- Changes are committed to git
If ANY item is false, continue working. Do NOT create the marker.

After implementation is complete and tests pass, create the .coding-complete file, then $coding_completion_text
_WVML_PROMPT_
}

# Build a narrow prompt for automatic merge-conflict resolution in an existing PR worktree.
#
# Args:
#   $1 = pr_number
#   $2 = branch
#   $3 = wt_dir
#   $4 = status_file
#   $5 = base_branch
build_conflict_resolution_prompt() {
  local pr_number="$1" branch="$2" wt_dir="$3" status_file="$4" base_branch="${5:-main}"

  cat <<_WVML_PROMPT_
You are resolving merge conflicts for open PR #$pr_number.

Repo worktree: $wt_dir
Branch: $branch
Base branch: $base_branch

Scope:
- Resolve merge conflicts only.
- Do not do new feature work or refactors unless strictly required to complete the merge.
- Preserve the existing branch intent.

Status Reporting:
Throughout your work, periodically update your status by running:
  echo '<short description of what you are doing right now>' > $status_file
Keep it under 50 chars. Update it at each major step.

Required process:
1. Inspect the current branch state and conflict state.
2. Fetch the latest base branch:
   git fetch origin $base_branch
3. Merge the base branch into the current branch:
   git merge origin/$base_branch
4. Resolve conflicts with the smallest safe changes possible.
5. Run relevant validation for touched code. At minimum, run lint and typecheck if available.
6. Commit the conflict resolution with this exact message:
   fix: Resolve merge conflicts with $base_branch
7. Push the branch to update PR #$pr_number.

Failure handling:
- If you cannot resolve the conflicts safely, stop without broad code changes.
- Leave a clear explanation of the blocker in your final response.
- Do not create markers or a PR. Workflow automation will handle follow-up.
_WVML_PROMPT_
}

# Build the review phase prompt.
# This phase runs self-review and creates the PR.
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
#   $10 = reviewer_model (optional: recommended reviewer model)
#   $11 = review_mode (optional: recommended review mode)
# Prints: the complete prompt to stdout
build_review_prompt() {
  local title="$1" issue="$2" wt_dir="$3" branch="$4" base_branch="$5"
  local issue_context="$6" status_file="$7" tools_dir="$8" slug="$9"
  local reviewer_model="${10:-}" review_mode="${11:-static}" agent_cmd="${12:-claude}"
  local abort_feedback_instruction exit_guard_text review_completion_text
  abort_feedback_instruction="$(agent_abort_feedback_text "$agent_cmd" "$wt_dir/features/$(basename "$wt_dir")/.workflow-aborted")"
  exit_guard_text="$(agent_exit_guard_text "$agent_cmd" "the PR is created and all review steps are done")"
  review_completion_text="$(agent_completion_text "$agent_cmd")"

  # Build reviewer note
  local reviewer_note=""
  if [[ -n "$reviewer_model" ]]; then
    reviewer_note="NOTE: Workflow router recommends using $reviewer_model for review (mode: ${review_mode})"
  fi

  # Build mode-specific guidance
  local mode_guidance
  case "$review_mode" in
    static)
      mode_guidance="- Run static analysis only (fast)
- Fix critical issues found"
      ;;
    llm)
      mode_guidance="- Run LLM-based review (comprehensive)
- Fix all blockers and critical warnings"
      ;;
    static+llm)
      mode_guidance="- Run both static and LLM review (thorough)
- Fix all blockers and most warnings"
      ;;
    none)
      mode_guidance="- Skip review tool, proceed directly to PR"
      ;;
  esac

  # Load template and fill placeholders
  local template_file="$tools_dir/prompts/review-phase.md"
  local template_content
  if [[ -f "$template_file" ]]; then
    template_content=$(cat "$template_file")
    template_content="${template_content//\{\{REVIEW_MODE\}\}/$review_mode}"
    template_content="${template_content//\{\{TOOLS_DIR\}\}/$tools_dir}"
    template_content="${template_content//\{\{BASE_BRANCH\}\}/$base_branch}"
    template_content="${template_content//\{\{ISSUE\}\}/$issue}"
    template_content="${template_content//\{\{SLUG\}\}/$slug}"
    template_content="${template_content//\{\{REVIEWER_NOTE\}\}/$reviewer_note}"
    template_content="${template_content//\{\{MODE_GUIDANCE\}\}/$mode_guidance}"
  else
    template_content="[ERROR: Review template not found at $template_file]"
  fi

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
Keep it under 50 chars. Update it at each major step.

$template_content

### IMPORTANT: Handling User Feedback During This Phase

You may receive text feedback from the user while you are working on this phase.
User feedback is GUIDANCE to improve your approach — it is NOT a signal to complete the phase.

When you receive user feedback:
- DO: Read and incorporate the feedback into your ongoing work
- DO: Adjust your approach based on the guidance
- DO: Continue working until the review and PR creation are genuinely complete
- DO: If the user asks to stop, abort, close the issue, or discontinue work, $abort_feedback_instruction
- DO NOT: Interpret feedback as "wrap up now"
- DO NOT: Create additional completion output if the user wants to stop
- DO NOT: Skip remaining review steps or rush the PR just because you received feedback
- DO NOT: $exit_guard_text

After creating the PR, report the PR URL to the user, then $review_completion_text
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
      tmux send-keys -t "$session:$window" "cat '$instr_file' | claude${model_flag} --dangerously-skip-permissions; echo '[wavemill] Agent exited (\$?)'" C-m
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
  local agent_flags="${6:-}"
  local abort_check_cmd="${7:-}"

  if [[ -n "$model" ]] && ! agent_validate_model "$model" "${REPO_DIR:-$(pwd)}" >/dev/null 2>&1; then
    local fallback_model=""
    fallback_model="$(agent_default_model_for_cmd "$agent_cmd")"
    if agent_model_looks_like_depth_tag "$model"; then
      _agent_log_warn "Rejecting depth tag '$model' as model ID for $agent_cmd"
    else
      _agent_log_warn "Rejecting invalid model '$model' for $agent_cmd"
    fi

    if [[ -n "$fallback_model" ]]; then
      _agent_log_warn "Falling back to $fallback_model"
      model="$fallback_model"
    else
      _agent_log_warn "Launching without explicit --model override"
      model=""
    fi
  fi

  local model_flag=""
  if [[ -n "$model" ]]; then
    model_flag=" --model $model"
  fi

  if [[ -n "$agent_flags" ]]; then
    agent_flags=" $agent_flags"
  fi

  if [[ "$agent_cmd" == "codex" ]] && [[ "$agent_flags" != *" --dangerously-bypass-approvals-and-sandbox"* ]]; then
    agent_flags="${agent_flags} --dangerously-bypass-approvals-and-sandbox"
  fi

  agent_prepare_pane_for_launch "$session" "$window" 15 3 "$abort_check_cmd"
  local prepare_rc=$?
  if [[ "$prepare_rc" -ne 0 ]]; then
    return "$prepare_rc"
  fi

  local launcher="/tmp/${session}-$(basename "$prompt_file" .txt)-launcher.sh"
  local launcher_cmd=""

  # Don't use exec — keep the shell alive so the window persists after agent exit
  case "$agent_cmd" in
    claude)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
claude${model_flag}${agent_flags} --dangerously-skip-permissions "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    codex)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
codex${model_flag}${agent_flags} --no-alt-screen "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
    *)
      cat > "$launcher" <<LAUNCHEOF
#!/bin/bash
$agent_cmd${model_flag}${agent_flags} "\$(cat '$prompt_file')"
echo "[wavemill] Agent exited (\$?)"
LAUNCHEOF
      ;;
  esac

  chmod +x "$launcher"
  printf -v launcher_cmd '%q' "$launcher"

  local launch_attempt=1
  while (( launch_attempt <= 2 )); do
    _agent_log_debug "Injection attempt $launch_attempt for $session:$window"
    tmux send-keys -t "$session:$window" -l -- "$launcher_cmd"
    sleep 0.1
    tmux send-keys -t "$session:$window" C-m

    if _verify_agent_launched "$session" "$window" 5; then
      return 0
    fi

    if (( launch_attempt == 1 )); then
      _agent_log_warn "First injection failed for $session:$window, retrying..."
      tmux send-keys -t "$session:$window" C-c 2>/dev/null || true
      sleep 0.5
    fi
    (( launch_attempt += 1 ))
  done

  _agent_log_warn "Agent launch FAILED after 2 attempts in $session:$window"
  return 1
}

# ============================================================================
# AGENT TERMINATION & PANE READINESS
# ============================================================================

_agent_log_debug() {
  [[ "${DEBUG_AGENT:-}" == "1" ]] || return 0
  echo "$(date '+%H:%M:%S') DEBUG: $*" >&2
}

_agent_log_warn() {
  echo "$(date '+%H:%M:%S') WARN: $*" >&2
}

_pane_current_command() {
  local target="$1"
  tmux display-message -t "$target" -p '#{pane_current_command}' 2>/dev/null || true
}

_pane_child_count() {
  local target="$1"
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -z "$pane_pid" ]]; then
    echo ""
    return 1
  fi

  pgrep -P "$pane_pid" 2>/dev/null | wc -l | tr -d ' '
}

_pane_command_is_shell() {
  local cmd="$1"
  case "$cmd" in
    bash|zsh|sh|fish|dash|ksh) return 0 ;;
    *) return 1 ;;
  esac
}

# Check if a tmux pane is dead or has an idle shell (no foreground children).
# If the pane is dead, it is respawned so a fresh shell is available.
#
# Args:
#   $1 = tmux target (session:window)
# Returns: 0 if pane is idle/ready, 1 if busy
_pane_is_dead_or_idle() {
  local target="$1"

  # Check if pane is dead (shell exited entirely)
  if tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    _agent_log_debug "Pane $target is dead, respawning"
    tmux respawn-pane -t "$target" 2>/dev/null || true
    sleep 0.5
    return 0
  fi

  local current_command
  current_command=$(_pane_current_command "$target")
  local children
  children=$(_pane_child_count "$target")

  if _pane_command_is_shell "$current_command" && [[ "${children:-0}" == "0" ]]; then
    return 0
  fi

  [[ "${children:-0}" == "0" ]] && return 0

  return 1
}

# Terminate any running agent in a tmux pane and wait for the shell prompt.
# Uses a graduated escalation strategy:
#   1. Ctrl-C (interrupt generation) → /exit + Ctrl-D (polite exit)
#   2. Poll for process to exit
#   3. Ctrl-C×2 → Ctrl-\ (SIGQUIT) → pkill children
#
# This MUST be called before sending new commands to a pane that may have
# a running agent — otherwise send-keys goes into the agent, not the shell.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = max wait seconds (optional, default 15)
# Returns: 0 if shell is ready, 1 if timed out
agent_terminate_in_pane() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-15}"
  local target="$session:$window"

  # Quick check — maybe nothing is running
  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # --- Phase 1: Polite exit ---
  # Ctrl-C interrupts any in-progress generation in Claude Code
  tmux send-keys -t "$target" C-c 2>/dev/null || true
  sleep 0.3

  if _pane_is_dead_or_idle "$target"; then return 0; fi

  # /exit is the canonical way to exit Claude Code
  tmux send-keys -t "$target" "/exit" C-m 2>/dev/null || true
  sleep 0.5

  if _pane_is_dead_or_idle "$target"; then return 0; fi

  # Ctrl-D (EOF) exits Codex and most other CLIs
  # ONLY send if a foreground process is still running — Ctrl-D on an idle
  # shell exits the shell itself, which (without remain-on-exit) destroys
  # the tmux window and makes the pane unrecoverable.
  tmux send-keys -t "$target" C-d 2>/dev/null || true
  sleep 0.3

  # --- Phase 2: Poll for exit ---
  local elapsed=0
  while (( elapsed < max_wait )); do
    if _pane_is_dead_or_idle "$target"; then
      return 0
    fi
    sleep 1
    (( elapsed += 1 ))
  done

  # --- Phase 3: Escalate ---
  # Double Ctrl-C (rapid) — some CLIs exit on repeated interrupt
  tmux send-keys -t "$target" C-c C-c 2>/dev/null || true
  sleep 1

  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # Ctrl-\ sends SIGQUIT to the foreground process group
  tmux send-keys -t "$target" C-\\ 2>/dev/null || true
  sleep 1

  if _pane_is_dead_or_idle "$target"; then
    return 0
  fi

  # Last resort: directly kill child processes of the pane shell
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -n "$pane_pid" ]]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 1
    if ! _pane_is_dead_or_idle "$target"; then
      pkill -KILL -P "$pane_pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi

  _pane_is_dead_or_idle "$target"
}

# Check if a tmux pane is ready to receive shell commands.
# Returns 0 if the pane's shell has no foreground child processes.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
# Returns: 0 if ready, 1 if busy
agent_pane_is_ready() {
  local session="$1"
  local window="$2"
  local target="$session:$window"

  if tmux list-panes -t "$target" -F '#{pane_dead}' 2>/dev/null | grep -q '^1$'; then
    _agent_log_debug "Pane $target is dead during readiness check, respawning"
    tmux respawn-pane -t "$target" 2>/dev/null || true
    sleep 0.5
  fi

  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -z "$pane_pid" ]]; then
    return 1
  fi

  local current_command children
  current_command=$(_pane_current_command "$target")
  children=$(_pane_child_count "$target")

  if _pane_command_is_shell "$current_command" && [[ "${children:-0}" == "0" ]]; then
    return 0
  fi

  [[ "${children:-0}" == "0" ]]
}

# Verify an agent process started in a pane after launcher injection.
#
# Args:
#   $1 = tmux session name
#   $2 = tmux window name
#   $3 = max wait seconds (optional, default 5)
# Returns: 0 if launched, 1 if pane remains idle
_verify_agent_launched() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-5}"
  local target="$session:$window"
  local elapsed=0

  while (( elapsed < max_wait )); do
    sleep 1
    (( elapsed += 1 ))

    local current_command children
    current_command=$(_pane_current_command "$target")
    children=$(_pane_child_count "$target")

    if [[ "${children:-0}" != "0" ]]; then
      _agent_log_debug "Agent verified in $target after ${elapsed}s (children=$children)"
      return 0
    fi

    if ! _pane_command_is_shell "$current_command"; then
      _agent_log_debug "Agent verified in $target after ${elapsed}s (cmd=${current_command:-unknown})"
      return 0
    fi
  done

  _agent_log_warn "Agent NOT detected in $target after ${max_wait}s — pane still idle"
  return 1
}

agent_wait_for_pane_ready() {
  local session="$1"
  local window="$2"
  local max_wait="${3:-3}"
  local poll_interval="${4:-0.2}"
  local abort_check_cmd="${5:-}"
  local target="$session:$window"

  local attempts
  attempts=$(awk "BEGIN { v = $max_wait / $poll_interval; if (v < 1) v = 1; printf \"%d\", (v == int(v) ? v : int(v) + 1) }")

  local attempt=1
  while (( attempt <= attempts )); do
    if [[ -n "$abort_check_cmd" ]] && eval "$abort_check_cmd"; then
      _agent_log_warn "  Pane $target readiness wait interrupted by workflow abort"
      return 2
    fi

    if agent_pane_is_ready "$session" "$window"; then
      if (( attempt > 1 )); then
        _agent_log_debug "Pane $target became ready after $attempt attempts"
      fi
      return 0
    fi

    local current_command children
    current_command=$(_pane_current_command "$target")
    children=$(_pane_child_count "$target")
    _agent_log_debug "Pane $target not ready (attempt $attempt/$attempts, current_command=${current_command:-unknown}, children=${children:-unknown})"
    sleep "$poll_interval"
    (( attempt += 1 ))
  done

  return 1
}

agent_prepare_pane_for_launch() {
  local session="$1"
  local window="$2"
  local terminate_wait="${3:-15}"
  local ready_wait="${4:-3}"
  local abort_check_cmd="${5:-}"
  local target="$session:$window"

  if ! agent_terminate_in_pane "$session" "$window" "$terminate_wait"; then
    _agent_log_warn "  Timed out waiting for previous agent to exit in $target"
  fi

  agent_wait_for_pane_ready "$session" "$window" "$ready_wait" 0.2 "$abort_check_cmd"
  local ready_rc=$?
  if [[ "$ready_rc" -eq 0 ]]; then
    return 0
  elif [[ "$ready_rc" -eq 2 ]]; then
    return 2
  fi

  _agent_log_warn "  Pane $target not ready, force-killing children..."
  local pane_pid
  pane_pid=$(tmux display-message -t "$target" -p '#{pane_pid}' 2>/dev/null || echo "")
  if [[ -n "$pane_pid" ]]; then
    pkill -TERM -P "$pane_pid" 2>/dev/null || true
    sleep 0.5
    agent_wait_for_pane_ready "$session" "$window" 1 0.2 "$abort_check_cmd"
    ready_rc=$?
    if [[ "$ready_rc" -eq 2 ]]; then
      return 2
    elif [[ "$ready_rc" -ne 0 ]]; then
      pkill -KILL -P "$pane_pid" 2>/dev/null || true
      sleep 0.5
    fi
  fi

  agent_wait_for_pane_ready "$session" "$window" 1.5 0.2 "$abort_check_cmd"
  ready_rc=$?
  if [[ "$ready_rc" -eq 0 ]]; then
    return 0
  elif [[ "$ready_rc" -eq 2 ]]; then
    return 2
  fi

  _agent_log_warn "  Pane $target STILL not ready after force-kill, respawning pane..."
  tmux respawn-pane -k -t "$target" 2>/dev/null || true
  sleep 0.5

  agent_wait_for_pane_ready "$session" "$window" 2 0.2 "$abort_check_cmd"
  ready_rc=$?
  if [[ "$ready_rc" -eq 2 ]]; then
    return 2
  elif [[ "$ready_rc" -ne 0 ]]; then
    _agent_log_warn "  Pane $target still not ready after respawn; launching anyway"
  fi
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
