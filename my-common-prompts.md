# Common Prompts for Claude Code

Reusable prompts and instructions for any project's CLAUDE.md file.

## Core Instructions

Your context window will be automatically compacted as it approaches its limit. Never stop tasks early due to token budget concerns. Always complete tasks fully.

## Feature Implementation Workflow

You're an AI engineer assistant implementing features from a Linear backlog.

### Step 1: Select Task
Run the Linear backlog tool (check project CLAUDE.md for correct project name):
```bash
npx tsx ~/.claude/tools/get-backlog.ts "Project Name"
```
Number the backlog items and prompt user to select one.

### Step 2: Create Git Branch
```bash
git checkout -b feature/<sanitized-title>
mkdir -p features/<feature-name>
mkdir -p project-knowledge/features
```

### Step 3: Generate PRD with Knowledge Management

1. **Load existing knowledge**: Check `project-knowledge/codebase-map.md`
2. **Investigate**: Use project-investigator subagent for new areas
3. **Generate PRD**: Use template from `~/.claude/templates/prd-prompt.md`
4. **Update knowledge base**: Extract 3-5 key discoveries to codebase-map.md

### Step 4: Generate Tasks
Use template from `~/.claude/templates/tasks-prompt.md`

### Step 5: Implement with Tests First

**5.1 Tests before implementation**
- Draft test files first, get human approval
- Mark tests read-only: `git update-index --skip-worktree <test-files>`

**5.2 Two test tiers**
- Fast suite: Unit tests, < 2s
- Integration suite: Slower tests with real services

**5.3 Red → Green → Refactor**
1. Run fast suite, confirm test fails
2. Write minimal code to pass
3. Run lint and typecheck
4. Run integration tests if crossing boundaries
5. Refactor with tests green

**5.4 Commit discipline**
- All tests, lint, typecheck green
- One logical unit per commit
- Clear messages: `STRUCTURE:` or `BEHAVIOUR:`

### Step 6: Open Pull Request
When tasks complete and tests pass, create PR via GitHub CLI.

### Step 7: Ready for Review Checklist
- [ ] All tasks in `tasks.md` completed
- [ ] Tests pass locally and on CI
- [ ] Codebase knowledge map updated
- [ ] Reviewer confirmed PRD alignment

### Step 8: Post-Feature Knowledge Extraction
After merge:
- Update `project-knowledge/codebase-map.md` with learnings
- Document gotchas and workarounds
- Keep map concise (< 200 lines)

## Additional Resources

| Resource | Location |
|----------|----------|
| Codebase map template | `~/.claude/templates/codebase-map-template.md` |
| PRD prompt | `~/.claude/templates/prd-prompt.md` |
| Tasks prompt | `~/.claude/templates/tasks-prompt.md` |
| Knowledge map update | `~/.claude/templates/knowledge-map-update-prompt.md` |
| Code review prompt | `~/.claude/prompts/code-review.md` |
| Refactoring prompt | `~/.claude/prompts/refactoring.md` |
| API documentation | `~/.claude/prompts/api-documentation.md` |
| Test writing | `~/.claude/prompts/test-writing.md` |
| Performance optimization | `~/.claude/prompts/performance-optimization.md` |
| Troubleshooting | `~/.claude/troubleshooting.md` |

## Notes

- Each step should be completed in sequence
- The codebase map grows with each feature (keep it concise)
- Regular commits with clear messages
- Document deviations from standard process
