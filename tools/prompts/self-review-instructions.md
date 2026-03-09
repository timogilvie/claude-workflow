After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

Run the self-review tool up to 3 iterations.

IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. You MUST set a 600s timeout on your Bash tool call.

{{REVIEW_COMMAND}}

- Exit code 0 = review passed
- Exit code 1 = issues found -> fix blockers and re-run
- Exit code 2 = error -> log comprehensive diagnostics and {{ERROR_FOLLOWUP}}

The output is structured JSON with `verdict`, `codeReviewFindings`, and `uiFindings`.
Each finding in `codeReviewFindings` or `uiFindings` includes `severity`, `location`, `category`, and `description`.

When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
```text
⚠️  Review tool failed with exit code 2

Diagnostics:
- Command: {{REVIEW_COMMAND}}
- Working directory: $(pwd)
- Tool path: {{REVIEW_TOOL_PATH}}
- Tool exists: $(ls -lh {{REVIEW_TOOL_PATH}} 2>&1 || echo "NOT FOUND")
- Git root: $(git rev-parse --show-toplevel 2>&1)
- Current branch: $(git rev-parse --abbrev-ref HEAD 2>&1)
- Base branch exists: $(git rev-parse --verify {{BASE_BRANCH}} 2>&1 || echo "NOT FOUND")
- STDERR output: [paste the actual stderr from the failed command]

Proceeding to {{ERROR_FOLLOWUP}} per instructions.
```
This diagnostic information is CRITICAL for debugging recurring tool failures.

For each iteration where issues are found:
- Read the review JSON output carefully
- Fix all blockers (severity: blocker) and straightforward warnings
- Make targeted fixes only — do not refactor unrelated code
- Commit fixes: `git commit -m "fix: Address self-review findings (iteration N)"`
- Re-run the self-review tool
