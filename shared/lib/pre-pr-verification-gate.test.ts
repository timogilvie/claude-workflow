/**
 * Tests for pre-PR verification gate.
 * Covers: gate checks, artifact validation, recommendations.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import {
  checkPrePrVerificationGate,
  getCompatibilityBehavior,
  formatGateFailure,
  isRemediable,
} from './pre-pr-verification-gate.ts';

// ────────────────────────────────────────────────────────────────
// Test Harness
// ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(err as Error).message}`);
  }
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

test('gate: passes when verification is disabled', () => {
  const result = checkPrePrVerificationGate(
    '/tmp/test',
    { enabled: false, required: false, recipe: { commands: [] } },
  );

  assert.equal(result.passed, true);
});

test('gate: passes when verification is optional', () => {
  const result = checkPrePrVerificationGate(
    '/tmp/test',
    { enabled: true, required: false, recipe: { commands: ['npm test'] } },
  );

  assert.equal(result.passed, true);
});

test('gate: blocks when artifact is missing', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-test-'));
  try {
    const result = checkPrePrVerificationGate(
      tmpDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      'abc123',
      'def456',
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('artifact'));
    assert(result.recommendation);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('gate: passes with valid artifact', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-test-'));
  try {
    // Create valid artifact
    mkdirSync(join(tmpDir, '.wavemill/pre-pr-verification'), {
      recursive: true,
    });
    const artifactPath = join(
      tmpDir,
      '.wavemill/pre-pr-verification/artifact.json',
    );
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc123',
      baseSha: 'def456',
      overallStatus: 'pass' as const,
      commands: [],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const result = checkPrePrVerificationGate(
      tmpDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      'abc123',
      'def456',
    );

    assert.equal(result.passed, true);
    assert(result.artifact);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('gate: blocks on SHA mismatch', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-test-'));
  try {
    mkdirSync(join(tmpDir, '.wavemill/pre-pr-verification'), {
      recursive: true,
    });
    const artifactPath = join(
      tmpDir,
      '.wavemill/pre-pr-verification/artifact.json',
    );
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'old-sha',
      baseSha: 'def456',
      overallStatus: 'pass' as const,
      commands: [],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const result = checkPrePrVerificationGate(
      tmpDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      'new-sha', // Different from artifact
      'def456',
    );

    assert.equal(result.passed, false);
    assert(result.reason?.includes('stale'));
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('gate: blocks on failed verification', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-test-'));
  try {
    mkdirSync(join(tmpDir, '.wavemill/pre-pr-verification'), {
      recursive: true,
    });
    const artifactPath = join(
      tmpDir,
      '.wavemill/pre-pr-verification/artifact.json',
    );
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc123',
      baseSha: 'def456',
      overallStatus: 'fail' as const,
      commands: [
        {
          index: 0,
          command: 'npm test',
          status: 'fail' as const,
          exitCode: 1,
          durationMs: 1000,
          logPath: '/path/to/log',
        },
      ],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const result = checkPrePrVerificationGate(
      tmpDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      'abc123',
      'def456',
    );

    assert.equal(result.passed, false);
    assert(result.requiresRemediation);
    assert(result.remediationPrompt);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('gate: respects operator override', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'gate-test-'));
  try {
    mkdirSync(join(tmpDir, '.wavemill/pre-pr-verification'), {
      recursive: true,
    });
    const artifactPath = join(
      tmpDir,
      '.wavemill/pre-pr-verification/artifact.json',
    );
    const artifact = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc123',
      baseSha: 'def456',
      overallStatus: 'fail' as const, // Failed...
      overriddenBy: {
        reason: 'Manual approval',
        timestamp: new Date().toISOString(),
        operator: 'admin@example.com',
      },
      commands: [],
    };

    writeFileSync(artifactPath, JSON.stringify(artifact), 'utf-8');

    const result = checkPrePrVerificationGate(
      tmpDir,
      { enabled: true, required: true, recipe: { commands: ['npm test'] } },
      'abc123',
      'def456',
    );

    assert.equal(result.passed, true); // ...but overridden, so pass
    assert(result.reason?.includes('overridden'));
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('getCompatibilityBehavior: allows unconfigured by default', () => {
  const behavior = getCompatibilityBehavior(undefined, false);
  assert.equal(behavior, 'allow');
});

test('getCompatibilityBehavior: blocks when mode is "block"', () => {
  const behavior = getCompatibilityBehavior(
    { enabled: false, recipe: { commands: [], compatibility: { mode: 'block' } } },
    false,
  );
  assert.equal(behavior, 'block');
});

test('formatGateFailure: creates readable message', () => {
  const result = {
    passed: false,
    reason: 'Verification failed',
    recommendation: 'Re-run the verification command',
  };

  const message = formatGateFailure(result);

  assert(message.includes('Verification failed'));
  assert(message.includes('Re-run the verification command'));
});

test('isRemediable: true for command failure', () => {
  const result = {
    passed: false,
    artifact: {
      version: '1.0',
      timestamp: new Date().toISOString(),
      workingBranch: 'test',
      headSha: 'abc',
      baseSha: 'def',
      overallStatus: 'fail' as const,
      commands: [],
    },
  };

  assert.equal(isRemediable(result), true);
});

test('isRemediable: false for passing gate', () => {
  const result = { passed: true };
  assert.equal(isRemediable(result), false);
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
