#!/usr/bin/env -S npx tsx
/**
 * Basic unit tests for task-packet-validator
 * Run with: npx tsx shared/lib/task-packet-validator.test.ts
 */

import {
  validateFileExistence,
  validateValidationSteps,
  validateScopeBoundaries,
  validateAcceptanceCriteria,
  validateReleaseReadiness,
} from './task-packet-validator.ts';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

function testFileExistence() {
  console.log('\n=== Testing File Existence Validation ===');

  const taskPacket = `
## Key Files
- \`shared/lib/linear.ts\` - Linear API client
- \`tools/expand-issue.ts\` - Issue expansion tool
- \`nonexistent/file.ts\` - This doesn't exist
  `;

  const issues = validateFileExistence(taskPacket, process.cwd());

  assert(issues.length === 1, 'Should find 1 non-existent file');
  assert(issues[0].type === 'file-not-found', 'Issue type should be file-not-found');
  assert(issues[0].description.includes('nonexistent/file.ts'), 'Should mention the missing file');
}

function testValidationSteps() {
  console.log('\n=== Testing Validation Steps ===');

  const boilerplatePacket = `
## Validation Steps
\`\`\`bash
pnpm lint
pnpm test
pnpm build
\`\`\`
  `;

  const issues = validateValidationSteps(boilerplatePacket);
  assert(issues.length === 1, 'Should flag boilerplate validation');
  assert(issues[0].type === 'boilerplate-validation', 'Issue type should be boilerplate-validation');

  const goodPacket = `
## Validation Steps
\`\`\`bash
pnpm lint
pnpm test
curl -X POST http://localhost:3000/api/test -d '{"test": true}'
# Expected: 200 OK with {"success": true}
\`\`\`
  `;

  const goodIssues = validateValidationSteps(goodPacket);
  if (goodIssues.length > 0) {
    console.log('Debug: Good packet validation issues:', JSON.stringify(goodIssues, null, 2));
  }
  assert(goodIssues.length === 0, 'Should pass with custom validation steps');
}

function testScopeBoundaries() {
  console.log('\n=== Testing Scope Boundaries ===');

  const insufficientScope = `
## Scope In
- Add feature

## Scope Out
- Don't break things
  `;

  const issues = validateScopeBoundaries(insufficientScope);
  assert(issues.length === 2, 'Should flag both scopes with only 1 item (need 2+)');
  assert(issues[0].type === 'empty-scope', 'Issue type should be empty-scope');

  const emptyScope = `
## Scope In

## Scope Out
  `;

  const emptyIssues = validateScopeBoundaries(emptyScope);
  assert(emptyIssues.length === 2, 'Should flag both empty scopes');

  const goodScope = `
## Scope In
- Add login endpoint
- Add token validation
- Add error handling

## Scope Out
- No registration endpoint
- No password reset
- No OAuth providers
  `;

  const goodIssues = validateScopeBoundaries(goodScope);
  assert(goodIssues.length === 0, 'Should pass with sufficient scope items (2+)');
}

function testAcceptanceCriteria() {
  console.log('\n=== Testing Acceptance Criteria ===');

  const insufficientCriteria = `
## Functional Requirements
- [ ] Feature works
- [ ] Tests pass
  `;

  const issues = validateAcceptanceCriteria(insufficientCriteria);
  assert(issues.length === 1, 'Should flag insufficient criteria (< 3)');
  assert(issues[0].type === 'insufficient-criteria', 'Issue type should be insufficient-criteria');

  const goodCriteria = `
## Functional Requirements
- [ ] POST /api/login returns 200 with token
- [ ] Invalid credentials return 401
- [ ] Network errors show retry button
- [ ] Token stored in localStorage
  `;

  const goodIssues = validateAcceptanceCriteria(goodCriteria);
  assert(goodIssues.length === 0, 'Should pass with sufficient criteria (>= 3)');
}

function testReleaseReadiness() {
  console.log('\n=== Testing Release Readiness Validation ===');

  // Valid section produces no warnings
  const validPacket = `
## Release Readiness
- **database_change_risk**: required
- **env_changes**: NEW_API_KEY
- **config_changes**: none
- **manual_steps**: Run migration
  `;

  const validIssues = validateReleaseReadiness(validPacket);
  assert(validIssues.length === 0, 'Should pass with valid release readiness section');

  // Missing section produces no warnings (optional)
  const missingPacket = `
## Objective

Build something
  `;

  const missingIssues = validateReleaseReadiness(missingPacket);
  assert(missingIssues.length === 0, 'Should produce no issues when section is absent');

  // Invalid database_change_risk value
  const invalidDbRisk = `
## Release Readiness
- **database_change_risk**: maybe
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
  `;

  const dbRiskIssues = validateReleaseReadiness(invalidDbRisk);
  assert(dbRiskIssues.length === 1, 'Should flag invalid database_change_risk value');
  assert(dbRiskIssues[0].type === 'invalid-release-readiness', 'Issue type should be invalid-release-readiness');
  assert(dbRiskIssues[0].description.includes('maybe'), 'Should mention the invalid value');

  // Missing fields produce warnings
  const missingFields = `
## Release Readiness
- **database_change_risk**: none
  `;

  const fieldIssues = validateReleaseReadiness(missingFields);
  assert(fieldIssues.length === 3, 'Should flag 3 missing fields (env_changes, config_changes, manual_steps)');
  assert(fieldIssues.every(i => i.type === 'invalid-release-readiness'), 'All issues should be invalid-release-readiness');
}

function testNumberedSectionHeadings() {
  console.log('\n=== Testing Numbered Section Headings ===');

  // Numbered validation steps (the exact format that caused the bug)
  const numberedPacket = `
## 6. Validation Steps
\`\`\`bash
pnpm lint
curl -X POST http://localhost:3000/api/test -d '{"test": true}'
\`\`\`
  `;

  const numberedIssues = validateValidationSteps(numberedPacket);
  assert(numberedIssues.length === 0, 'Should find Validation Steps with numbered heading "## 6. Validation Steps"');

  // Numbered scope sections
  const numberedScope = `
## 1. Objective

### Scope In
- Add login endpoint
- Add token validation

### Scope Out
- No registration endpoint
- No password reset
  `;

  const scopeIssues = validateScopeBoundaries(numberedScope);
  assert(scopeIssues.length === 0, 'Should find Scope In/Out under numbered Objective section');

  // Numbered functional requirements
  const numberedCriteria = `
## 4. Success Criteria

### Functional Requirements
- [ ] POST /api/login returns 200 with token
- [ ] Invalid credentials return 401
- [ ] Network errors show retry button
  `;

  const criteriaIssues = validateAcceptanceCriteria(numberedCriteria);
  assert(criteriaIssues.length === 0, 'Should find Functional Requirements under numbered Success Criteria');

  // Numbered release readiness
  const numberedRelease = `
## 10. Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: none
  `;

  const releaseIssues = validateReleaseReadiness(numberedRelease);
  assert(releaseIssues.length === 0, 'Should find Release Readiness with numbered heading');

  // Missing section still detected with numbered headings present
  const missingValidation = `
## 1. Objective
Some objective text

## 2. Technical Context
Some context
  `;

  const missingIssues = validateValidationSteps(missingValidation);
  assert(missingIssues.length === 1, 'Should still detect missing Validation Steps when other sections are numbered');
  assert(missingIssues[0].description === 'Validation Steps section is missing', 'Should report correct error for missing section');
}

async function main() {
  console.log('Running task-packet-validator tests...\n');

  try {
    testFileExistence();
    testValidationSteps();
    testScopeBoundaries();
    testAcceptanceCriteria();
    testReleaseReadiness();
    testNumberedSectionHeadings();

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Tests failed:', error);
    process.exit(1);
  }
}

main();
