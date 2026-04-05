## Your Task: Review & PR Creation

You are in the **REVIEW PHASE** of a multi-phase workflow (mode: {{REVIEW_MODE}}).

The implementation is complete. Your job is to review and create a PR.

### Your Responsibilities

1. **Run self-review tool** (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. You MUST set a 600s timeout on your Bash tool call.
   npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json
   {{REVIEWER_NOTE}}
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics and proceed to step 3
   The output is structured JSON with verdict, codeReviewFindings, and uiFindings.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   ```
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json
   - Working directory: $(pwd)
   - Tool path: {{TOOLS_DIR}}/review-changes.ts
   - Tool exists: $(ls -lh {{TOOLS_DIR}}/review-changes.ts 2>&1 || echo "NOT FOUND")
   - Git root: $(git rev-parse --show-toplevel 2>&1)
   - Current branch: $(git rev-parse --abbrev-ref HEAD 2>&1)
   - Base branch exists: $(git rev-parse --verify {{BASE_BRANCH}} 2>&1 || echo "NOT FOUND")
   - STDERR output: [paste the actual stderr from the failed command]

   Proceeding to PR creation per instructions.
   ```
   This diagnostic information is CRITICAL for debugging recurring tool failures.

2. **For each iteration where issues are found**:
   - Read the review JSON output carefully
   - Fix all blockers (severity: blocker) and straightforward warnings
   - Make targeted fixes only — do not refactor unrelated code
   - Commit fixes: git commit -m "fix: Address self-review findings (iteration N)"
   - Re-run the review tool (step 1)

3. **Create a PR** using GitHub CLI with a descriptive title and body:
   gh pr create --title "{{ISSUE}}: <concise summary>" --body "<PR body>"
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.

4. **Link the PR to {{ISSUE}}**

### Review Mode: {{REVIEW_MODE}}

{{MODE_GUIDANCE}}

### Success Criteria
- [ ] Self-review tool executed (unless mode is 'none')
- [ ] Blockers fixed (if any were found)
- [ ] PR created with descriptive summary
- [ ] PR linked to {{ISSUE}}

### Important Notes
- Do not skip the review - it's a required step
- Fix blockers before creating PR
- Make targeted fixes only - no scope creep
- If review tool fails with exit code 2, document the failure and proceed
