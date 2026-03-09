import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  formatValidationResult,
  validatePermissionsConfig,
} from './permissions-verifier.ts';
import { clearConfigCache } from './config.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${(error as Error).message}`);
  }
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'permissions-verifier-'));
}

function cleanUp(dir: string) {
  clearConfigCache(dir);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\n--- permissions-verifier tests ---\n');

test('validatePermissionsConfig reports missing permissions config as warning', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(join(repoDir, '.wavemill-config.json'), '{}\n', 'utf-8');
    clearConfigCache(repoDir);

    const result = validatePermissionsConfig(repoDir, false);
    assert.equal(result.valid, true);
    assert.match(result.warnings[0], /No permissions configured/);
  } finally {
    cleanUp(repoDir);
  }
});

test('validatePermissionsConfig rejects unsafe patterns', () => {
  const repoDir = makeTempRepo();
  try {
    writeFileSync(
      join(repoDir, '.wavemill-config.json'),
      JSON.stringify({
        permissions: {
          autoApprovePatterns: ['rm *'],
        },
      }),
      'utf-8',
    );
    clearConfigCache(repoDir);

    const result = validatePermissionsConfig(repoDir, true);
    assert.equal(result.valid, false);
    assert.match(result.errors.join('\n'), /Unsafe patterns detected/);
  } finally {
    cleanUp(repoDir);
  }
});

test('formatValidationResult includes sections and headings', () => {
  const output = formatValidationResult(
    {
      valid: false,
      errors: ['bad'],
      warnings: ['warn'],
      info: ['info'],
    },
    'Configuration Validation',
  );

  assert.match(output, /Configuration Validation/);
  assert.match(output, /Errors/);
  assert.match(output, /Warnings/);
  assert.match(output, /Info/);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
