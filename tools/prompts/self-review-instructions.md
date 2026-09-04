After implementation is complete and tests/lint pass, you MUST run the self-review tool.
This is a REQUIRED step — do not skip it or substitute your own review.

Run the self-review tool up to 3 iterations.

IMPORTANT: Run from your current directory (the worktree). Do NOT change directories.
IMPORTANT: This tool calls the Claude API and takes 2-5 minutes. Configure your tool's built-in timeout (for Claude Code's Bash tool: `timeout: 600000` — 600000 ms = 10 minutes) so the call is not killed at the default cap. Do NOT prefix the command with the external `timeout` binary — it is not installed by default on macOS and will fail with `command not found: timeout`.

{{REVIEW_COMMAND}}

- Exit code 0 = review passed
- Exit code 1 = issues found -> fix blockers and re-run
- Exit code 2 = error -> log comprehensive diagnostics, record the final verdict as `error`, and {{ERROR_FOLLOWUP}} without certifying readiness

The output is structured JSON with `verdict`, `codeReviewFindings`, and `uiFindings`.
Each finding in `codeReviewFindings` or `uiFindings` includes `severity`, `location`, `category`, and `description`. A finding may also carry `dismissed: true` with a `dismissalJustification` (and optional `dismissalEvidence`) when the reviewer disproved its own finding — dismissed blockers are audited false positives that do not count toward the verdict and need no fix.

When exit code 2 occurs, you MUST log the following diagnostics to help debug the failure:
```text
⚠️  Review tool failed with exit code 2

Diagnostics:
- Command: {{REVIEW_COMMAND}}
- Working directory: \$(pwd)
- Tool path: {{REVIEW_TOOL_PATH}}
- Tool exists: \$(ls -lh {{REVIEW_TOOL_PATH}} 2>&1 || echo "NOT FOUND")
- Git root: \$(git rev-parse --show-toplevel 2>&1)
- Current branch: \$(git rev-parse --abbrev-ref HEAD 2>&1)
- Base branch exists: \$(git rev-parse --verify {{BASE_BRANCH}} 2>&1 || echo "NOT FOUND")
- STDERR output: [paste the actual stderr from the failed command]

Proceeding to {{ERROR_FOLLOWUP}} without readiness certification per instructions.
```
This diagnostic information is CRITICAL for debugging recurring tool failures.

For each iteration where issues are found:
- Read the review JSON output carefully
- Fix all blockers (severity: blocker) and straightforward warnings
- If you investigate a blocker and prove it is a false positive, record it as dismissed with a non-empty justification (and cite the verification you ran) instead of fixing a non-existent problem or misreporting the count
- Make targeted fixes only — do not refactor unrelated code
- Run the review scope guard immediately before committing:
  `npx tsx tools/check-review-scope.ts --repo-dir .`
- If the guard exits 1, preserve the index, report the violation, and stop review-fix committing/PR progression. No review commit may be created until the guard passes.
- If the guard exits 2, scope could not be verified (tool/git failure — infrastructure, not a violation): capture the guard's stderr, note "review scope unverified (infrastructure)" in the commit message body and PR body, and proceed with the commit. Do not treat exit 2 as a scope violation.
- If the guard exits 3, scope passed but no PR exists yet for this branch (the normal pre-PR state, not a violation): proceed exactly as for exit 0.
- Commit fixes: `git commit -m "fix: Address self-review findings (iteration N)"`
- Re-run the self-review tool
