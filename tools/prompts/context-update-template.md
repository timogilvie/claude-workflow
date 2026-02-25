# Context Update Generator

You are updating a project context file after a PR has been merged.

Your task is to generate a brief, structured summary that captures what changed and any patterns or lessons learned.

## Input Data

**Issue ID:** {ISSUE_ID}
**Issue Title:** {ISSUE_TITLE}
**PR URL:** {PR_URL}

**Issue Description:**
```
{ISSUE_DESCRIPTION}
```

**PR Diff:**
```
{PR_DIFF}
```

## Your Task

Generate a concise summary (2-5 bullet points max) in this **exact format**:

```markdown
### {TIMESTAMP} - {ISSUE_ID}: {ISSUE_TITLE}

**What changed:** [1-2 sentence summary of the implementation]

**Patterns established:** [Any new patterns, conventions, or architectural decisions - OMIT if none]

**Gotchas:** [Known issues, constraints, or lessons learned - OMIT if none]

**Files modified:** `path/to/key/file.ts`, `path/to/another.ts`, `path/to/third.ts`
```

## Guidelines

1. **Be concise**: This is a log entry, not documentation. Future agents should be able to scan it in 10 seconds.

2. **Focus on patterns**: Only include "Patterns established" if something genuinely reusable was created. Examples:
   - ✅ "Introduced `useAuth` hook pattern for authentication state"
   - ✅ "Established convention of co-locating tests with source files"
   - ❌ "Added a new function" (too vague)
   - ❌ "Used React hooks" (too obvious)

3. **Meaningful gotchas**: Only include "Gotchas" if it's a non-obvious constraint. Examples:
   - ✅ "Auth tokens must be refreshed before expiry to avoid race conditions"
   - ✅ "Database migrations must use raw SQL for performance reasons"
   - ❌ "Fixed a bug" (not a gotcha)
   - ❌ "Had to update imports" (too trivial)

4. **Key files only**: List 3-5 most important files. Prefer:
   - New files that define patterns
   - Modified files that establish conventions
   - Core implementation files (not test/config boilerplate)

5. **Omit empty sections**: If there are no new patterns or gotchas, don't include those sections at all.

## Example Output

```markdown
### 2026-02-25T14:32:00Z - HOK-123: Add user authentication

**What changed:** Implemented JWT-based authentication with token refresh. Added login/logout endpoints and auth middleware.

**Patterns established:** Introduced `useAuth` hook for managing auth state across components. All protected routes now use `withAuth` HOC.

**Gotchas:** Refresh tokens must be stored in httpOnly cookies, not localStorage, to prevent XSS attacks. Token refresh happens 5 minutes before expiry.

**Files modified:** `shared/lib/auth.ts`, `components/auth/LoginForm.tsx`, `middleware/withAuth.ts`
```

---

Now generate the summary for the provided PR.
