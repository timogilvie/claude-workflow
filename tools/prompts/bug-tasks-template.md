ROLE:
You are a senior software engineer creating a detailed task list to fix a confirmed bug. You have already identified the root cause through systematic investigation and now need to create actionable tasks for implementing the fix, preventing regression, and improving system resilience.

INPUT CONTEXT:
- Review the investigation plan in investigation.md
- Review the hypotheses and test results in hypotheses.md and test-results.md
- Review the confirmed root cause in root-cause.md

OUTPUT FORMAT:
Place the output in fix-tasks.md. Tasks should be numbered with checkboxes. Subtasks should use letter designation with checkboxes. Group tasks logically and indicate dependencies.

REQUIRED TASK CATEGORIES:

## 1. Immediate Fix
- [ ] Core fix implementation tasks
- [ ] Edge case handling
- [ ] Error handling improvements
- [ ] Configuration changes if needed

## 2. Testing Tasks
- [ ] Unit tests that reproduce the bug (write first, ensure they fail)
- [ ] Unit tests for the fix (ensure they pass after fix)
- [ ] Integration tests for affected workflows
- [ ] Edge case tests
- [ ] Regression test suite updates
- [ ] Performance tests if applicable
- [ ] Load tests if bug is load-related

## 3. Validation Tasks
- [ ] Validate fix against original reproduction steps
- [ ] Validate no regressions in related functionality
- [ ] Validate performance impact is acceptable
- [ ] Validate in staging environment
- [ ] Create validation checklist for QA/reviewers

## 4. Code Quality Tasks
- [ ] Refactor to prevent similar bugs
- [ ] Add appropriate code comments
- [ ] Update type definitions if needed
- [ ] Add input validation if missing
- [ ] Improve error messages

## 5. Monitoring & Observability
- [ ] Add logging for this failure mode
- [ ] Create CloudWatch alarm for this condition
- [ ] Add metrics to track this issue
- [ ] Create dashboard if needed
- [ ] Add health check if applicable

## 6. Documentation Tasks
- [ ] Update API documentation if behavior changed
- [ ] Document the bug and fix in troubleshooting guide
- [ ] Update runbook with this scenario
- [ ] Add to known issues if partially fixed
- [ ] Update architecture diagrams if needed

## 7. Prevention Tasks
- [ ] Add linting rules to catch this pattern
- [ ] Create pre-commit hooks if applicable
- [ ] Update code review checklist
- [ ] Add to team knowledge base
- [ ] Schedule team learning session if complex

## 8. Rollback Plan
- [ ] Document rollback procedure
- [ ] Identify feature flags if applicable
- [ ] Create rollback script if needed
- [ ] Test rollback procedure

PRIORITY GUIDELINES:
1. Critical: Fix implementation and tests
2. High: Validation and monitoring
3. Medium: Documentation and prevention
4. Low: Nice-to-have improvements

DEPENDENCY NOTES:
- Clearly mark dependencies between tasks
- Ensure test tasks come before implementation where appropriate
- Validation must follow implementation
- Documentation can be parallel to implementation

EXAMPLE FORMAT:
## 1. Immediate Fix
1. [ ] Fix null pointer exception in auth service
   a. [ ] Add null check in validateToken method
   b. [ ] Return appropriate error response
   c. [ ] Log warning when null token received

## 2. Testing Tasks (Dependent on Fix Implementation)
2. [ ] Write comprehensive tests
   a. [ ] Unit test for null token scenario
   b. [ ] Unit test for expired token scenario
   c. [ ] Integration test for auth flow
   d. [ ] Load test to ensure fix handles high volume