#!/usr/bin/env -S npx tsx
/**
 * Basic unit tests for task-packet-validator
 * Run with: npx tsx shared/lib/task-packet-validator.test.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  extractPlannedNewFiles,
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

  const plannedPacket = `
## Key Files
- \`shared/lib/task-packet-validator.ts\` - Existing file
- \`shared/lib/planned-validator-helper.ts\` (new) - Planned helper
- \`shared/lib/planned-validator-worker.ts\` *(new file)* - Planned worker
- \`shared/lib/missing-validator-helper.ts\` - Missing and unmarked
  `;

  const plannedIssues = validateFileExistence(plannedPacket, process.cwd());
  assert(plannedIssues.length === 1, 'Should ignore planned new files in Key Files');
  assert(plannedIssues[0].description.includes('missing-validator-helper.ts'), 'Should still flag unmarked missing files');

  const plannedFiles = extractPlannedNewFiles(plannedPacket);
  assert(plannedFiles.length === 2, 'Should extract planned new files from Key Files markers');
  assert(plannedFiles.includes('shared/lib/planned-validator-helper.ts'), 'Should capture (new) marker');
  assert(plannedFiles.includes('shared/lib/planned-validator-worker.ts'), 'Should capture *(new file)* marker');
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

  const numberedPacket = `
## 6. Validation Steps
\`\`\`bash
npm test -- shared/lib/task-packet-validator.test.ts
node -e "console.log('validated numbered heading')"
# Expected: exits 0
\`\`\`
  `;

  assert(validateValidationSteps(numberedPacket).length === 0, 'Should accept numbered Validation Steps heading');

  const lowercasePacket = `
## 6.   validation steps
\`\`\`bash
npm run lint -- shared/lib/task-packet-validator.ts
curl -s http://localhost:3000/health
\`\`\`
  `;

  assert(validateValidationSteps(lowercasePacket).length === 0, 'Should accept lowercase Validation Steps heading with extra whitespace');

  const legacyPacket = `
### Validation Steps
\`\`\`bash
npm run typecheck
node -e "console.log('feature specific check')"
\`\`\`
  `;

  assert(validateValidationSteps(legacyPacket).length === 0, 'Should keep accepting legacy unnumbered Validation Steps heading');

  const nestedHeadingPacket = `
## 6. Validation Steps

### Functional Requirement Validation
\`\`\`bash
npm test -- shared/lib/task-packet-validator.test.ts
node -e "console.log('nested heading check')"
\`\`\`
  `;

  assert(validateValidationSteps(nestedHeadingPacket).length === 0, 'Should keep Validation Steps content when nested headings appear immediately after the section heading');

  const proseOnlyPacket = `
## Validation Steps
Validation steps are covered by the normal workflow and should be reviewed manually.
  `;

  const proseIssues = validateValidationSteps(proseOnlyPacket);
  assert(proseIssues.length === 1, 'Should fail when Validation Steps contains only prose');
  assert(proseIssues[0].severity === 'warning', 'Prose-only Validation Steps should be treated as boilerplate');

  const missingPacket = `
## Implementation Approach
1. Update the validator
2. Update the tests
  `;

  const missingIssues = validateValidationSteps(missingPacket);
  assert(missingIssues.length === 1, 'Should flag missing Validation Steps section');
  assert(missingIssues[0].description === 'Validation Steps section is missing', 'Missing section error should keep existing text');
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

function testIssueWriterPromptContract() {
  console.log('\n=== Testing Issue Writer Prompt Contract ===');

  const prompt = readFileSync(resolve(process.cwd(), 'tools/prompts/issue-writer.md'), 'utf-8');

  assert(prompt.includes('## 6. Validation Steps'), 'Issue writer prompt should use canonical numbered Validation Steps heading');
  assert(prompt.includes('`shared/lib/new-validator.ts` (new)'), 'Issue writer prompt should document the (new) Key Files marker');
}

async function main() {
  console.log('Running task-packet-validator tests...\n');

  try {
    testFileExistence();
    testValidationSteps();
    testScopeBoundaries();
    testAcceptanceCriteria();
    testReleaseReadiness();
    testIssueWriterPromptContract();

    console.log('\n✅ All tests passed!');
  } catch (error) {
    console.error('\n❌ Tests failed:', error);
    process.exit(1);
  }
}

main();
