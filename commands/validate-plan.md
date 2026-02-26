Systematically verify that an implementation plan was executed correctly before creating a PR.

## Phase 1: Context Discovery
1. Locate the implementation plan (typically `features/<feature-name>/plan.md`)
2. Gather implementation evidence:
```bash
# Get recent commits
git log --oneline -20

# See what changed
git diff main...HEAD --stat

# Check current status
git status
```

## Phase 2: Plan Verification
Read the plan and verify each phase:

### A. Constraint Validation (New)
Run task-specific constraint rules generated at plan creation time:

```bash
# Detect issue ID from context (e.g., HOK-123)
ISSUE_ID=$(grep -m 1 "issueId" features/*/selected-task.json | grep -o 'HOK-[0-9]*' || echo "")

# Validate constraints if they exist
if [ -d "constraints/$ISSUE_ID" ]; then
  echo "🔍 Validating constraints for $ISSUE_ID..."
  npx tsx tools/validate-constraints.ts $ISSUE_ID
else
  echo "ℹ️  No constraint rules found (optional for this task)"
fi
```

Constraint validation results:
- ✅ All constraint rules passed
- ❌ Constraint violation: File modification prohibited
- ⚠️ Manual review required for 2 constraints

If constraints are enabled (default) and violations exist, validation MUST NOT proceed to PR creation.

### B. Standard Automated Verification
Run all standard automated checks from the plan:
```bash
# Examples - adjust based on project
npm test
npm run lint
npm run build
npm run type-check
```

Document results:
- ✅ All tests pass
- ❌ 3 tests failing in auth.test.ts
- ⚠️ 2 linting warnings

### C. Success Criteria Check
For each success criterion in the plan:
- [ ] Verify it was completed
- [ ] Run any specified tests
- [ ] Document evidence (file changes, test output, etc.)

### D. Code Review Analysis
Spawn research agents to verify implementation quality:
- Check for TODOs or incomplete code
- Verify error handling exists
- Confirm tests cover edge cases
- Look for potential issues

## Phase 3: Generate Validation Report
Create `features/<feature-name>/validation-report.md`:

```markdown
# Validation Report

## Plan Adherence
- [x] Phase 1: Setup - Complete
- [x] Phase 2: Core Implementation - Complete
- [ ] Phase 3: Error Handling - Partial (missing timeout handling)

## Automated Checks
- Tests: ✅ All 47 tests passing
- Linting: ✅ No errors
- Build: ✅ Successful
- Type Check: ❌ 2 type errors in api.ts:45, utils.ts:12

## Constraint Validation
- Total rules: 5
- Passed: 4
- Failed: 1
- Manual review: 2 constraints

### Violations
1. **CONSTRAINT-4**: Don't modify package.json
   - File `package.json` was modified
   - Remediation: Revert changes or update constraint if intentional

### Manual Review Required
See `constraints/HOK-123/manual-review.md` for constraints requiring human verification:
- [ ] Follow existing code conventions
- [ ] Maintain consistent naming patterns

## Code Review Findings
### Issues
1. Missing error handling for API timeout (plan Phase 3)
2. Type errors in api.ts need fixing

### Recommendations
1. Add timeout handling as specified in plan
2. Fix type errors before PR
3. Consider adding integration test for error path

## Manual Testing Needed
- [ ] Test user authentication flow end-to-end
- [ ] Verify error messages display correctly
- [ ] Check mobile responsive design

## Next Steps
1. Fix identified issues
2. Complete manual testing
3. Update plan checkboxes
4. Ready for PR creation
```

## Phase 4: Present Findings
1. Show validation report to user
2. Highlight any blockers or issues
3. Recommend next steps:
   - If validation passes: Proceed to PR
   - If issues found: Fix them first
   - If uncertain: Get user input

## Key Principles
- **Be thorough** - Check every criterion
- **Run all checks** - Don't skip automated tests (including constraint validation)
- **Document findings** - Evidence over assumptions
- **Be constructive** - Suggest fixes, not just problems
- **Think long-term** - Consider maintainability
- **Constraint enforcement** - Mandatory by default; can be disabled via config if too noisy

## Disabling Constraint Validation

If constraint validation is too strict or causing issues, it can be disabled:

1. **Per-repo configuration** (`.wavemill-config.json`):
```json
{
  "constraints": {
    "enabled": false
  }
}
```

2. **Environment variable** (temporary):
```bash
SKIP_CONSTRAINT_VALIDATION=1 npx tsx tools/validate-constraints.ts HOK-123
```

Note: Disabling should be rare. Consider updating constraints instead.

## Output
Validation report saved to: `features/<feature-name>/validation-report.md`

Next step: If validation passes, use `/describe-pr` or create PR directly.
