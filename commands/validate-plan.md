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

### B.5: UI Validation (Conditional)

**Run this section ONLY if**:
1. UI changes are detected in the diff (hasUiChanges = true)
2. AND `ui.visualVerification` is enabled in config (default: true)

**Check if UI validation is needed**:
```bash
# 1. Gather review context and check for UI changes
npx tsx tools/gather-review-context.ts main > /tmp/review-context.json
HAS_UI_CHANGES=$(cat /tmp/review-context.json | jq -r '.metadata.hasUiChanges')

# 2. Check if visual verification is enabled
VISUAL_ENABLED=$(cat .wavemill-config.json 2>/dev/null | jq -r '.ui.visualVerification // true')

# 3. Run UI validation if both are true
if [ "$HAS_UI_CHANGES" = "true" ] && [ "$VISUAL_ENABLED" = "true" ]; then
  echo "✓ UI validation required - proceeding..."
else
  echo "ℹ️  Skipping UI validation (no UI changes or disabled in config)"
  exit 0
fi
```

**If UI validation is needed, perform these steps**:

#### 1. Gather Design Context

```bash
# Extract design context from review context
cat /tmp/review-context.json | jq '.designContext' > /tmp/design-context.json

# Review discovered design artifacts:
# - Tailwind config theme
# - Component library and version
# - Design guide content (DESIGN.md, STYLE-GUIDE.md)
# - CSS variables (:root blocks)
# - Design tokens
# - Storybook configuration
```

#### 2. Capture Screenshots (requires ui.devServer)

```bash
# Get dev server URL from config
DEV_SERVER=$(cat .wavemill-config.json 2>/dev/null | jq -r '.ui.devServer // "http://localhost:3000"')

# Identify affected pages from task packet or plan
# Look for Pages/Routes section in task packet or plan

# Use frontend-testing skill to capture screenshots:
# - Navigate to each affected page
# - Take screenshot and save to features/<slug>/screenshots/
# - Name files descriptively (e.g., dashboard-after.png, settings-mobile.png)
```

**Frontend-testing commands**:
```
Use the frontend-testing skill to:
1. Navigate to $DEV_SERVER/<route>
2. Wait for page load
3. Take screenshot: features/<slug>/screenshots/<page>-after.png
4. Repeat for each affected page
5. Repeat for different viewports if responsive changes
```

#### 3. Check Browser Console

```bash
# Use frontend-testing skill to check console for each page:
# 1. Navigate to page
# 2. List console messages
# 3. Report any errors or unexpected warnings
```

**Expected states**:
- ✅ **Clean console** - No errors, no warnings
- ⚠️ **Known warnings** - Only acceptable warnings listed in task packet

#### 4. Compare Against Design Standards

**Tailwind Config Adherence**:
- Check if colors used match theme.colors.* from Tailwind config
- Verify spacing follows theme.spacing.* scale
- Confirm typography uses theme.fontFamily.*

**Component Library Usage**:
- Verify components follow library patterns (e.g., Radix UI, shadcn/ui)
- Check for correct component imports and usage
- Confirm no custom reimplementations of library components

**Design Guide Compliance** (if DESIGN.md exists):
- Review design guide requirements
- Verify implementation follows documented patterns
- Check for consistent naming, structure, and conventions

**CSS Variables Consistency**:
- Verify CSS custom properties match :root definitions
- Check for no hardcoded colors/spacing that should use variables

**Document Findings**:
```markdown
### Design Standards Compliance
- **Tailwind Colors**: ✅ Using theme.colors.primary.* (compliant)
- **Component Library**: ✅ Radix UI Accordion used correctly
- **Design Guide**: ✅ Follows component structure from docs/DESIGN.md
- **CSS Variables**: ✅ Uses --color-primary custom property
- **Issues Found**: None

OR

- **Issues Found**:
  - ❌ Hardcoded color #3B82F6 instead of theme.colors.primary.500
  - ⚠️ Custom dropdown instead of Radix UI Select (justify if intentional)
```

#### 5. Document UI Validation Results

Add to validation report:
```markdown
## UI Validation
**Pages Tested**:
- `/dashboard` - Screenshot: features/<slug>/screenshots/dashboard-after.png
- `/settings` - Screenshot: features/<slug>/screenshots/settings-after.png

**Console Status**:
- ✅ Clean console on all pages (no errors, no warnings)

**Design Standards**:
- ✅ Tailwind config adherence: Using theme colors and spacing
- ✅ Component library: Radix UI components used correctly
- ✅ Design guide: Follows DESIGN.md patterns
- ✅ Responsive: Tested mobile (375px), tablet (768px), desktop (1440px)

**Issues**:
- None

OR

**Issues**:
- ⚠️ Console warning on /settings: "Deprecated API usage in third-party lib"
  - Justification: Acceptable per task packet Section 7 (Console Expectations)
- ❌ Hardcoded color found: #3B82F6 should use theme.colors.primary.500
  - File: src/components/Button.tsx:45
  - Fix required before PR
```

**If ui.devServer is not configured**:
```markdown
## UI Validation
- ⚠️ Screenshots skipped: ui.devServer not configured in .wavemill-config.json
- ✅ Console: Manual verification required
- ✅ Design standards: Code review shows Tailwind theme compliance
```

**If UI validation is skipped**:
```markdown
## UI Validation
- Skipped: No UI changes detected in diff
```

OR

```markdown
## UI Validation
- Skipped: ui.visualVerification disabled in .wavemill-config.json
```

---

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

## UI Validation
**Pages Tested**:
- `/dashboard` - Screenshot: features/<slug>/screenshots/dashboard-after.png
- `/settings` - Screenshot: features/<slug>/screenshots/settings-after.png

**Console Status**:
- ✅ Clean console on all pages (no errors, no warnings)

**Design Standards**:
- ✅ Tailwind config adherence: Using theme colors and spacing
- ✅ Component library: Radix UI components used correctly
- ✅ Design guide: Follows DESIGN.md patterns
- ✅ Responsive: Tested mobile (375px), tablet (768px), desktop (1440px)

**Issues**:
- None

*OR if skipped:*

## UI Validation
- Skipped: No UI changes detected in diff
- *OR*: Skipped: ui.visualVerification disabled in config

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
