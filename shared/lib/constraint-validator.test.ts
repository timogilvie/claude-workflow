#!/usr/bin/env -S npx tsx
/**
 * Tests for constraint-validator
 * Run with: npx tsx shared/lib/constraint-validator.test.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { validateConstraints, formatValidationResult } from './constraint-validator\.cjs';
import { saveConstraintRules } from './constraint-storage\.cjs';
import type { RuleGenerationResult } from './rule-generator\.cjs';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`✓ ${message}`);
}

// Create temp directory for tests
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-validator-test-'));

function cleanup() {
  if (fs.existsSync(testRoot)) {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
}

// Setup test constraints
function setupPassingConstraint() {
  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-1',
        filename: '01-test-passing.cjs',
        code: `#!/usr/bin/env node
console.log('✓ CONSTRAINT-1: Test constraint passed');
process.exit(0);`,
        constraint: {
          id: 'CONSTRAINT-1',
          category: 'other',
          type: 'auto-validatable',
          description: 'Test passing constraint',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [],
    metadata: {
      issueId: 'TEST-PASS',
      generatedAt: new Date().toISOString(),
      taskPacketHash: 'test123',
    },
  };

  saveConstraintRules('TEST-PASS', ruleGenResult, testRoot);
}

function setupFailingConstraint() {
  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-2',
        filename: '01-test-failing\.cjs',
        code: `#!/usr/bin/env node
console.error('❌ CONSTRAINT-2: Test constraint failed');
console.error('This is a test failure');
process.exit(1);`,
        constraint: {
          id: 'CONSTRAINT-2',
          category: 'other',
          type: 'auto-validatable',
          description: 'Test failing constraint',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [],
    metadata: {
      issueId: 'TEST-FAIL',
      generatedAt: new Date().toISOString(),
      taskPacketHash: 'test456',
    },
  };

  saveConstraintRules('TEST-FAIL', ruleGenResult, testRoot);
}

function setupMixedConstraints() {
  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-3',
        filename: '01-test-pass\.cjs',
        code: `#!/usr/bin/env node
console.log('✓ CONSTRAINT-3: Passed');
process.exit(0);`,
        constraint: {
          id: 'CONSTRAINT-3',
          category: 'other',
          type: 'auto-validatable',
          description: 'Pass',
          severity: 'error',
        },
      },
      {
        id: 'CONSTRAINT-4',
        filename: '02-test-fail\.cjs',
        code: `#!/usr/bin/env node
console.error('❌ CONSTRAINT-4: Failed');
process.exit(1);`,
        constraint: {
          id: 'CONSTRAINT-4',
          category: 'other',
          type: 'auto-validatable',
          description: 'Fail',
          severity: 'error',
        },
      },
      {
        id: 'CONSTRAINT-5',
        filename: '03-test-pass\.cjs',
        code: `#!/usr/bin/env node
console.log('✓ CONSTRAINT-5: Passed');
process.exit(0);`,
        constraint: {
          id: 'CONSTRAINT-5',
          category: 'other',
          type: 'auto-validatable',
          description: 'Pass',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [],
    metadata: {
      issueId: 'TEST-MIXED',
      generatedAt: new Date().toISOString(),
      taskPacketHash: 'test789',
    },
  };

  saveConstraintRules('TEST-MIXED', ruleGenResult, testRoot);
}

function setupManualReviewConstraints() {
  const ruleGenResult: RuleGenerationResult = {
    rules: [
      {
        id: 'CONSTRAINT-6',
        filename: '01-test-pass\.cjs',
        code: `#!/usr/bin/env node
console.log('✓ CONSTRAINT-6: Passed');
process.exit(0);`,
        constraint: {
          id: 'CONSTRAINT-6',
          category: 'other',
          type: 'auto-validatable',
          description: 'Auto check',
          severity: 'error',
        },
      },
    ],
    manualReviewConstraints: [
      {
        id: 'CONSTRAINT-7',
        category: 'code-style',
        type: 'manual-review',
        description: 'Follow coding conventions',
        severity: 'warning',
      },
    ],
    metadata: {
      issueId: 'TEST-MANUAL',
      generatedAt: new Date().toISOString(),
      taskPacketHash: 'test999',
    },
  };

  saveConstraintRules('TEST-MANUAL', ruleGenResult, testRoot);
}

async function testValidatePassingConstraint() {
  console.log('\n=== Testing Validate Passing Constraint ===');

  const result = await validateConstraints('TEST-PASS', testRoot);

  assert(result.passed, 'Validation should pass');
  assert(result.totalRules === 1, 'Should have 1 rule');
  assert(result.passedRules === 1, 'Should have 1 passed rule');
  assert(result.failedRules === 0, 'Should have 0 failed rules');
  assert(result.violations.length === 0, 'Should have no violations');
  assert(!result.manualReviewRequired, 'Should not require manual review');
  assert(result.executionTimeMs > 0, 'Should have execution time');
}

async function testValidateFailingConstraint() {
  console.log('\n=== Testing Validate Failing Constraint ===');

  const result = await validateConstraints('TEST-FAIL', testRoot);

  assert(!result.passed, 'Validation should fail');
  assert(result.totalRules === 1, 'Should have 1 rule');
  assert(result.passedRules === 0, 'Should have 0 passed rules');
  assert(result.failedRules === 1, 'Should have 1 failed rule');
  assert(result.violations.length === 1, 'Should have 1 violation');
  assert(result.violations[0].exitCode === 1, 'Violation should have exit code 1');
  assert(result.violations[0].stderr.includes('failed'), 'Violation should include error message');
}

async function testValidateMixedConstraints() {
  console.log('\n=== Testing Validate Mixed Constraints ===');

  const result = await validateConstraints('TEST-MIXED', testRoot);

  assert(!result.passed, 'Validation should fail overall');
  assert(result.totalRules === 3, 'Should have 3 rules');
  assert(result.passedRules === 2, 'Should have 2 passed rules');
  assert(result.failedRules === 1, 'Should have 1 failed rule');
  assert(result.violations.length === 1, 'Should have 1 violation');
}

async function testValidateWithManualReview() {
  console.log('\n=== Testing Validate With Manual Review ===');

  const result = await validateConstraints('TEST-MANUAL', testRoot);

  assert(result.passed, 'Auto-validation should pass');
  assert(result.manualReviewRequired, 'Should require manual review');
  assert(result.totalRules === 1, 'Should have 1 auto-validatable rule');
}

async function testValidateNonExistentIssue() {
  console.log('\n=== Testing Validate Non-Existent Issue ===');

  try {
    await validateConstraints('TEST-NONE', testRoot);
    assert(false, 'Should throw error for non-existent issue');
  } catch (error: any) {
    assert(
      error.message.includes('No constraint rules found'),
      'Should throw appropriate error message'
    );
  }
}

async function testFormatValidationResult() {
  console.log('\n=== Testing Format Validation Result ===');

  const result = await validateConstraints('TEST-MIXED', testRoot);
  const formatted = formatValidationResult(result);

  assert(formatted.includes('TEST-MIXED'), 'Should include issue ID');
  assert(formatted.includes('FAILED'), 'Should show failure status');
  assert(formatted.includes('Total rules: 3'), 'Should show total rules');
  assert(formatted.includes('Failed: 1'), 'Should show failed count');
  assert(formatted.includes('Violations'), 'Should include violations section');
}

async function testFormatPassingResult() {
  console.log('\n=== Testing Format Passing Result ===');

  const result = await validateConstraints('TEST-PASS', testRoot);
  const formatted = formatValidationResult(result);

  assert(formatted.includes('✅'), 'Should include success icon');
  assert(formatted.includes('passed'), 'Should indicate success');
  assert(formatted.includes('TEST-PASS'), 'Should include issue ID');
}

async function testParallelExecution() {
  console.log('\n=== Testing Parallel Execution ===');

  const result = await validateConstraints('TEST-MIXED', testRoot, { parallel: true });

  assert(result.totalRules === 3, 'Should execute all 3 rules');
  // Parallel execution should be faster, but we can't reliably test timing
  assert(result.executionTimeMs > 0, 'Should have execution time');
}

// Run all tests
(async () => {
  try {
    setupPassingConstraint();
    setupFailingConstraint();
    setupMixedConstraints();
    setupManualReviewConstraints();

    await testValidatePassingConstraint();
    await testValidateFailingConstraint();
    await testValidateMixedConstraints();
    await testValidateWithManualReview();
    await testValidateNonExistentIssue();
    await testFormatValidationResult();
    await testFormatPassingResult();
    await testParallelExecution();

    console.log('\n✅ All tests passed!\n');
    cleanup();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Test suite failed:', error);
    cleanup();
    process.exit(1);
  }
})();
