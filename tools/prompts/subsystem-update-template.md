# Subsystem Update Generator

You are updating a subsystem specification after a PR has been merged.

Your task is to analyze the PR diff and update specific sections of the subsystem spec.

## Input Data

**Subsystem:** {SUBSYSTEM_NAME}
**Subsystem ID:** {SUBSYSTEM_ID}
**Issue ID:** {ISSUE_ID}
**Issue Title:** {ISSUE_TITLE}
**PR URL:** {PR_URL}

**Current Subsystem Spec:**
```markdown
{CURRENT_SPEC}
```

**PR Diff (filtered to subsystem files):**
```
{PR_DIFF}
```

**Issue Description:**
```
{ISSUE_DESCRIPTION}
```

## Your Task

Update the following sections of the subsystem spec based on the PR changes:

### 1. Recent Changes Section

Add a new entry at the TOP of the "Recent Changes" section:

```markdown
### {TIMESTAMP} - {ISSUE_ID}: {ISSUE_TITLE}
**Changed:** [1-2 sentence summary of what changed in this subsystem]
**Impact:** [How this affects the subsystem's behavior or API]
```

### 2. Architectural Constraints (if applicable)

If the PR introduces new patterns or rules, add them to the DO/DON'T sections:
- Check if new error handling patterns were added
- Check if new utility functions establish conventions
- Check if new validation rules were introduced

**Only update if genuinely new patterns were established.** Do NOT add trivial changes.

### 3. Known Failure Modes (if applicable)

If the PR fixes a bug or addresses a failure mode, add to the table:

| Symptom | Root Cause | Fix |
|---------|------------|-----|
| [Error message or behavior] | [Why it happened] | [How to prevent/fix] |

**Only add if a non-obvious failure mode was discovered and fixed.**

### 4. Update Timestamp

Update the "Last updated" timestamp to: {TIMESTAMP}

## Output Format

Return the COMPLETE updated subsystem spec as markdown. Do not include conversational text, preamble, or XML tags. Output ONLY the updated spec.

Preserve all sections that weren't modified. Only update the sections listed above when changes are relevant.

## Guidelines

1. **Be selective**: Only update if the PR genuinely impacts the subsystem
2. **Be concise**: Keep updates brief and actionable
3. **Preserve structure**: Maintain the exact table format and section headers
4. **No speculation**: Only document what the PR actually changed
5. **Machine-readable**: Use structured formats (tables, lists) not prose

---

Now generate the updated subsystem spec.
