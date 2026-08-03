/**
 * Tests for pre-PR verification engine.
 * Covers: recipe execution, artifact writes, log capture, error handling.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  runVerificationRecipe,
  writeVerificationArtifact,
  readAndValidateArtifact,
  extractBoundedLogExcerpt,
  getRemediationGuidance,
} from './pre-pr-verification.ts';

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

test('runVerificationRecipe: all commands pass', () => {
  const recipe = {
    commands: ['echo "test1"', 'echo "test2"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.status, 'pass');
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[0].status, 'pass');
  assert.equal(result.commands[1].status, 'pass');
  assert.equal(result.commands[0].exitCode, 0);
});

test('runVerificationRecipe: first command fails', () => {
  const recipe = {
    commands: ['false', 'echo "should not run"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.status, 'fail');
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].status, 'fail');
  assert(result.commands[0].exitCode !== 0);
  assert(result.commands[0].failureReason);
});

test('runVerificationRecipe: captures command exit code', () => {
  const recipe = {
    commands: ['exit 42'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert.equal(result.commands[0].status, 'fail');
  assert.equal(result.commands[0].exitCode, 42);
});

test('runVerificationRecipe: captures duration', () => {
  const recipe = {
    commands: ['sleep 0.1 && echo "done"'],
    timeoutSeconds: 10,
  };

  const result = runVerificationRecipe(recipe, { cwd: process.cwd() });

  assert(result.commands[0].durationMs !== undefined);
  assert(result.commands[0].durationMs > 50); // Should be at least 100ms
});

test('writeVerificationArtifact: writes atomic artifact', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
    const result = {
      status: 'pass' as const,
      commands: [
        {
          index: 0,
          command: 'npm test',
          status: 'pass' as const,
          exitCode: 0,
          durationMs: 1000,
          logPath: 'cmd-0.log',
        },
      ],
    };

    writeVerificationArtifact(result, artifactPath, {
      workingBranch: 'test-branch',
      headSha: 'abc123',
      baseSha: 'def456',
    });

    assert(require('fs').existsSync(artifactPath));
    const content = readFileSync(artifactPath, 'utf-8');
    const artifact = JSON.parse(content);

    assert.equal(artifact.version, '1.0');
    assert.equal(artifact.workingBranch, 'test-branch');
    assert.equal(artifact.headSha, 'abc123');
    assert.equal(artifact.baseSha, 'def456');
    assert.equal(artifact.overallStatus, 'pass');
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: validates matching SHAs', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
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

    const { artifact: read, isValid, shasMismatch } = readAndValidateArtifact(
      artifactPath,
      'abc123',
      'def456',
    );

    assert(read !== null);
    assert.equal(isValid, true);
    assert.equal(shasMismatch, false);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: detects SHA mismatch', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const artifactPath = join(tmpDir, 'artifact.json');
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

    const { shasMismatch } = readAndValidateArtifact(
      artifactPath,
      'different-sha', // Different HEAD SHA
      'def456',
    );

    assert.equal(shasMismatch, true);
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('readAndValidateArtifact: returns null for missing file', () => {
  const { artifact, isValid } = readAndValidateArtifact(
    '/nonexistent/path.json',
  );

  assert.equal(artifact, null);
  assert.equal(isValid, false);
});

test('extractBoundedLogExcerpt: truncates long logs', () => {
  const tmpDir = mkdtempSync(join('/tmp', 'verify-test-'));
  try {
    const logPath = join(tmpDir, 'cmd.log');
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`);
    writeFileSync(logPath, lines.join('\n'), 'utf-8');

    const excerpt = extractBoundedLogExcerpt(logPath, 10);

    assert(excerpt.includes('Line 1'));
    assert(excerpt.includes('Line 200'));
    assert(excerpt.includes('omitted'));
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});

test('getRemediationGuidance: formats failure message', () => {
  const result = {
    status: 'fail' as const,
    commands: [
      {
        index: 0,
        command: 'npm test',
        status: 'pass' as const,
        exitCode: 0,
        durationMs: 1000,
      },
      {
        index: 1,
        command: 'npm run lint',
        status: 'fail' as const,
        exitCode: 1,
        durationMs: 500,
        failureReason: 'Linting errors found',
        logPath: undefined,
      },
    ],
  };

  const guidance = getRemediationGuidance(result);

  assert(guidance.includes('Command #1 failed'));
  assert(guidance.includes('npm run lint'));
  assert(guidance.includes('Linting errors found'));
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
