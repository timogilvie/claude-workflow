# Constraint Validation in Pull Requests

This document describes how to include constraint validation results in PR descriptions for better review visibility.

## PR Template Enhancement

When creating PRs (manually or via automation), include a "Constraint Compliance" section in the PR body:

### Template

```markdown
## Constraint Compliance

**Status:** ✅ All constraints passed (or ❌ Violations found)

### Auto-Validated Constraints
- ✅ **CONSTRAINT-1**: No modifications to config files
- ✅ **CONSTRAINT-2**: All new functions have unit tests
- ❌ **CONSTRAINT-3**: TypeScript strict mode required
  - Remediation: Enable `strict: true` in tsconfig.json

### Manual Review Required
The following constraints require human verification:

- [ ] **CONSTRAINT-4**: Follow existing code conventions
  - Review implementation for consistency with existing patterns
- [ ] **CONSTRAINT-5**: Maintain backward compatibility
  - Verify no breaking API changes

See full constraint report: `constraints/HOK-123/manual-review.md`

---
```

## Automated PR Creation

When using `gh pr create` or similar tools, generate the constraint section programmatically:

```bash
#!/bin/bash
# Generate constraint validation section for PR

ISSUE_ID="HOK-123"
PR_BODY_FILE="/tmp/pr-body.md"

# Run validation and capture output
npx tsx tools/validate-constraints.ts $ISSUE_ID > /tmp/constraint-output.txt 2>&1
CONSTRAINT_STATUS=$?

# Start PR body
cat > "$PR_BODY_FILE" << 'EOF'
## Summary
...your PR summary...

## Constraint Compliance
EOF

# Add constraint validation results
if [ $CONSTRAINT_STATUS -eq 0 ]; then
  echo "**Status:** ✅ All constraints passed" >> "$PR_BODY_FILE"
else
  echo "**Status:** ❌ Constraint violations found" >> "$PR_BODY_FILE"
fi

# Parse and include constraint results
# (Implementation depends on output format)

# Create PR with enhanced body
gh pr create --title "..." --body-file "$PR_BODY_FILE"
```

## Manual Review Checklist

For constraints that can't be automatically validated, create a checklist in the PR:

```markdown
### Manual Constraint Review

Review the following constraints during PR review:

#### Style & Conventions
- [ ] **CONSTRAINT-4**: Code follows existing patterns
  - Check: Naming conventions, file organization, error handling patterns
  - Reference: `docs/CODING-STYLE.md`

#### Performance
- [ ] **CONSTRAINT-5**: No performance regressions
  - Check: Bundle size, render times, API response times
  - Baseline: <metrics from before>

#### Security
- [ ] **CONSTRAINT-6**: No sensitive data exposed
  - Check: No hardcoded credentials, proper input validation
  - Tool: Manual code review + security scanner
```

## Integration with Workflow Tools

### Git Workflow Manager

Update `commands/git-workflow-manager.md` or PR creation scripts to:

1. Run constraint validation before PR creation
2. Parse validation output
3. Include results in PR body
4. Add manual review checklist if applicable

### Example Integration

```bash
# In PR creation workflow:

# 1. Validate constraints
echo "Validating constraints..."
npx tsx tools/validate-constraints.ts $ISSUE_ID
if [ $? -ne 0 ]; then
  echo "❌ Constraint validation failed. Fix violations before creating PR."
  exit 1
fi

# 2. Load manual review constraints
if [ -f "constraints/$ISSUE_ID/manual-review.md" ]; then
  # Parse manual-review.md and add checklist to PR
  MANUAL_CONSTRAINTS=$(cat "constraints/$ISSUE_ID/manual-review.md")
fi

# 3. Create PR with constraint section
gh pr create --title "$PR_TITLE" --body "$(cat <<EOF
## Summary
$PR_SUMMARY

## Constraint Compliance
✅ All auto-validated constraints passed

### Manual Review Required
$MANUAL_CONSTRAINTS

## Changes
$CHANGES

## Test Plan
$TEST_PLAN
EOF
)"
```

## Benefits

1. **Visibility**: Reviewers see constraint status immediately
2. **Accountability**: Clear checklist for manual verification
3. **Audit Trail**: PR history shows what constraints were enforced
4. **Remediation**: Failed constraints include fix instructions
5. **Consistency**: Multiple parallel agents follow same rules

## Example PR

See full example: [Example PR with Constraint Validation](#)

```
Title: feat: Add user authentication (HOK-123)

## Summary
- Implement JWT-based authentication
- Add login/logout endpoints
- Include session management

## Constraint Compliance

**Status:** ✅ All constraints passed

### Auto-Validated Constraints
- ✅ **CONSTRAINT-1**: No modifications to package.json
- ✅ **CONSTRAINT-2**: All new functions have unit tests (12 new tests added)
- ✅ **CONSTRAINT-3**: No exposed API keys

### Manual Review Required
- [ ] **CONSTRAINT-4**: Follow existing error handling patterns
  - Verify error responses match format in `docs/API-ERRORS.md`
- [ ] **CONSTRAINT-5**: Maintain session security best practices
  - Check: HttpOnly cookies, CSRF protection, secure flag

See: `constraints/HOK-123/manual-review.md`

## Changes
- `src/auth/jwt.ts` - JWT token generation/validation
- `src/routes/auth.ts` - Login/logout endpoints
- `tests/auth.test.ts` - Authentication test suite

## Test Plan
...
```

## Configuration

Constraint validation in PRs can be configured via `.wavemill-config.json`:

```json
{
  "constraints": {
    "enabled": true,
    "cleanupAfterMerge": false
  }
}
```

- `enabled: true` (default): Validate constraints before PR creation
- `enabled: false`: Skip constraint validation (not recommended)
- `cleanupAfterMerge: false` (default): Keep rules for audit trail
