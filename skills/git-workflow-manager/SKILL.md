---
name: git-workflow-manager
description: Handle git branch creation, commits, and PR creation for feature and bugfix workflows. Follows git best practices with structured commit messages and proper PR formatting.
---

# Git Workflow Manager

This skill handles all git operations for workflow and bugfix commands including branch creation, commits, and PR creation.

## When to Use

Use this skill when:
- Creating a feature or bugfix branch
- Committing changes with structured messages
- Creating pull requests with proper formatting
- Ready to push work for review

## Instructions

### Step 1: Load Task Context
Read the selected task from `/tmp/selected-linear-task.json`:
```bash
cat /tmp/selected-linear-task.json
```

Extract:
- `workflowType`: "feature" or "bugfix"
- `title`: Task title for branch naming
- `taskId`: Linear issue ID for commit references
- `description`: For PR body

### Step 2: Create Git Branch

**Sanitize the title:**
- Convert to lowercase
- Replace spaces with hyphens
- Remove special characters except hyphens
- Limit to 50 characters
- Remove leading/trailing hyphens

**Create branch:**
```bash
# For features
git checkout -b feature/<sanitized-title>

# For bugfixes
git checkout -b bugfix/<sanitized-title>
```

Example:
- Input: "Add User Authentication System"
- Output: `git checkout -b feature/add-user-authentication-system`

**Confirm branch creation:**
```bash
git branch --show-current
```

### Step 3: Commit Changes

**For feature workflows:**

After implementation is complete, create a structured commit:

```bash
git add .

git commit -m "$(cat <<'EOF'
feat: <concise description of what was added>

<Optional detailed explanation of changes>

Implements: <Linear-ID>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**For bugfix workflows:**

After fix is complete, create a structured commit:

```bash
git add .

git commit -m "$(cat <<'EOF'
fix: <concise description of what was fixed>

Root cause: <brief description of root cause>
Solution: <brief description of solution>

Fixes: <Linear-ID>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

**Commit message guidelines:**
- First line: `feat:` or `fix:` prefix + concise summary (max 72 chars)
- Blank line
- Optional detailed explanation
- References to Linear issues
- Claude Code attribution

**Verify commit:**
```bash
git log -1 --oneline
```

### Step 4: Push Branch

Push the branch to remote:
```bash
git push -u origin $(git branch --show-current)
```

Check for any errors:
- Merge conflicts → Report to user
- Permission issues → Report to user
- Network issues → Retry once

### Step 5: Create Pull Request

**Generate PR title:**
- For features: `feat: <Title from Linear task>`
- For bugfixes: `fix: <Title from Linear task>`

**Generate PR body:**

For feature PRs:
```markdown
## Summary
- <Bullet point 1 from tasks.md>
- <Bullet point 2 from tasks.md>
- <Bullet point 3 from tasks.md>

## Test plan
- [ ] All tests pass locally
- [ ] Integration tests pass
- [ ] Manual testing completed
- [ ] Edge cases validated

## Related
- Linear: <Linear-ID with URL>
- PRD: `features/<name>/prd.md`
- Tasks: `features/<name>/tasks.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

For bugfix PRs:
```markdown
## Summary
**Root Cause:** <From investigation.md>
**Solution:** <From fix-tasks.md>

## Changes
- <Bullet point 1 from fix-tasks.md>
- <Bullet point 2 from fix-tasks.md>

## Test plan
- [ ] Bug reproduction test added
- [ ] Fix verified against reproduction steps
- [ ] Regression tests added
- [ ] All tests pass

## Validation Steps for Reviewers
1. <Step 1 to reproduce original bug>
2. <Step 2 to verify fix>

## Related
- Linear: <Linear-ID with URL>
- Investigation: `bugs/<name>/investigation.md`
- Fix tasks: `bugs/<name>/fix-tasks.md`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Create PR using GitHub CLI:**
```bash
gh pr create --title "<PR-TITLE>" --body "$(cat <<'EOF'
<PR-BODY>
EOF
)"
```

**Alternative if gh CLI not available:**
Provide user with:
1. PR title
2. PR body
3. Instructions to create manually

### Step 6: Verify PR Creation

Check PR was created successfully:
```bash
gh pr view --web
```

Or get PR URL:
```bash
gh pr view --json url -q .url
```

### Step 7: Return Summary

Provide user with:
```
✓ Git workflow complete:
  - Branch: feature/add-user-authentication-system
  - Commit: feat: Add user authentication system
  - PR: https://github.com/org/repo/pull/123

Ready for review checklist:
- [ ] All tasks in tasks.md completed
- [ ] Tests pass locally and on CI
- [ ] Feature validated on preview
- [ ] Reviewer confirmed PRD alignment
```

## Examples

### Example 1: Feature Workflow
```
Input: /tmp/selected-linear-task.json with workflowType: "feature"
Process:
1. Create branch: feature/add-email-generation
2. (User implements feature)
3. Commit: "feat: Add DSPy email generation\n\nImplements: HOK-125"
4. Push: git push -u origin feature/add-email-generation
5. Create PR with summary from tasks.md
6. Return PR URL
```

### Example 2: Bugfix Workflow
```
Input: /tmp/selected-linear-task.json with workflowType: "bugfix"
Process:
1. Create branch: bugfix/contact-discovery-timeout
2. (User fixes bug)
3. Commit: "fix: Contact discovery timeout\n\nRoot cause: Missing timeout config\nFixes: HOK-130"
4. Push: git push -u origin bugfix/contact-discovery-timeout
5. Create PR with root cause and solution
6. Return PR URL
```

## Error Handling

### Branch Already Exists
If branch exists:
```bash
git checkout feature/<name>
```
Warn user: "Branch already exists, checked out existing branch"

### Uncommitted Changes
If uncommitted changes exist:
```bash
git status --short
```
Options:
1. Ask user: "Commit these changes? (y/n)"
2. If yes, proceed with commit
3. If no, suggest: `git stash`

### Push Conflicts
If push fails with conflicts:
1. Check if remote branch exists: `git fetch && git branch -r`
2. If exists: `git pull --rebase origin $(git branch --show-current)`
3. Resolve conflicts (ask user for help)
4. Retry push

### PR Creation Fails
If `gh pr create` fails:
1. Check `gh auth status`
2. If not authenticated: `gh auth login`
3. Retry PR creation
4. If still fails, provide manual instructions

### No GitHub CLI
If `gh` command not found:
1. Provide manual PR creation instructions
2. Include PR title and body
3. Guide user to create PR via web UI

## Git Best Practices

### Commit Message Format
Follow [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `test:` for test additions
- `refactor:` for code refactoring

### Branch Naming
- `feature/*` for new features
- `bugfix/*` for bug fixes
- Descriptive but concise names
- Use hyphens, not underscores

### PR Descriptions
- Clear summary of changes
- Test plan with checkboxes
- Links to related issues/docs
- Validation steps for reviewers

## Output

This skill outputs:
- New git branch (feature/* or bugfix/*)
- Structured git commits
- Pull request with formatted description
- Console: Summary with PR URL and checklist

## Integration

This skill integrates with:
- **Input from**: linear-task-selector (task context), document-orchestrator (PRD/tasks)
- **Used by**: workflow, bugfix commands
- **External tools**: git, gh (GitHub CLI)
