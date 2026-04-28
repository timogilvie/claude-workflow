## Your Task: Review & PR Creation

You are in the **REVIEW PHASE** of a multi-phase workflow (mode: {{REVIEW_MODE}}).

The implementation is complete. Your job is to review and create a PR.

### Your Responsibilities

1. **Run self-review tool** (up to 3 iterations):
   IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
   IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. You MUST set a 600s timeout on your Bash tool call.
   npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json --operating-mode {{OPERATING_MODE}}
   {{REVIEWER_NOTE}}
   - Exit code 0 = review passed → proceed to step 3
   - Exit code 1 = issues found → fix blockers and re-run (step 2)
   - Exit code 2 = error → log comprehensive diagnostics and proceed to step 3
   The output is structured JSON with verdict, codeReviewFindings, and optional uiFindings.

   When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
   ```
   ⚠️  Review tool failed with exit code 2

   Diagnostics:
   - Command: npx tsx {{TOOLS_DIR}}/review-changes.ts {{BASE_BRANCH}} --json --operating-mode {{OPERATING_MODE}}
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
   gh pr create \
     --base {{BASE_BRANCH}} \
     --title "{{ISSUE}}: <concise summary>" \
     --label "wavemill" \
     --body "<PR body>"
   If `gh pr create` fails because the `wavemill` label does not exist in this repository, create the PR without `--label "wavemill"`, then attempt:
   `gh pr edit "<PR_URL>" --add-label "wavemill"`
   If that also fails, note the missing label in the PR body and proceed.
   The PR body MUST include:
   - A "## Summary" section with 2-4 bullet points describing what changed and why
   - A "## Changes" section listing the key files/modules modified
   - A "## Test plan" section describing how the changes were validated
   - A "## Self-review" section noting the review verdict and iterations run
   - A Wavemill metadata block at the end of the body:
     <!-- wavemill-meta
     task: {{ISSUE}}
     -->
   Do NOT use --fill. Write the PR body as a HEREDOC if needed for formatting.
   After creating the PR, add the `wm:ready` label only if the final self-review run exited 0 and there are no unresolved blockers:
   `gh pr edit "<PR_URL>" --add-label "wm:ready"`
   If the `wm:ready` label does not exist in this repository, note it in the PR body and proceed.
   Do NOT add `wm:ready` if:
   - The self-review found unresolved blockers (exit code 1)
   - The workflow is in survival/constrained mode and confidence is low

### Authorship Attribution

Before creating the PR, determine whether you are the principal author:

1. **Check commit authorship** using:
   ```bash
   git shortlog -sn --no-merges {{BASE_BRANCH}}..HEAD
   ```

2. **Principal author determination**:
   - If you authored >50% of commits on this branch, you ARE the principal author
   - If you authored ≤50% of commits, you are NOT the principal author

3. **Attribution rules**:
   - **If you ARE the principal author**: Add standard co-authored-by trailer when creating commits:
     ```
     Co-authored-by: Claude [Model] <noreply@anthropic.com>
     ```
   - **If you are NOT the principal author**: Do NOT add co-authored-by trailers
     - You are reviewing or contributing to someone else's work
     - Use "Reviewed-by" tag if appropriate, or simply omit attribution
     - Never override the PR author field if someone else created the branch

4. **Link the PR to {{ISSUE}}**

{{OPERATING_MODE_GUIDANCE}}

### Review Mode: {{REVIEW_MODE}}

{{MODE_GUIDANCE}}

{{DRAFT_PR_INSTRUCTION}}

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

### FORBIDDEN: Merge Lifecycle

You MUST NEVER perform any of the following actions:
- Add the `wm:merging` label (for example: `gh pr edit ... --add-label wm:merging`)
- Add the `wm:merged` label (for example: `gh pr edit ... --add-label wm:merged`)
- Merge the PR yourself (for example: `gh pr merge ...`)
- Enable auto-merge (for example: `gh pr merge --auto`)

The Wavemill controller manages all merge operations. Agent interference with the merge lifecycle is explicitly prohibited.

### CRITICAL: Phase Boundary Rules

You are ONLY allowed to:
- Run the self-review tool
- Fix issues identified by self-review (targeted fixes only)
- Create the PR via gh pr create
- Create git commits for review fixes

You are FORBIDDEN from:
- Implementing new features or enhancements beyond what's already coded
- Refactoring code that wasn't flagged by the review tool
- Modifying plan.md or task-packet files
- Re-running the planning or coding phases

### Handling User Abort Requests

If the user asks you to stop work, close the issue, abort, or otherwise discontinue this workflow:
- Create the abort marker: touch "{{FEATURE_DIR}}/.workflow-aborted"
- Do NOT create additional completion output or a PR
- Inform the user that the workflow is being stopped
- Stop after creating the marker and reporting the abort.
