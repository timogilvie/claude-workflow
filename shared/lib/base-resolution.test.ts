/**
 * Tests for base branch resolution and freshness detection.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { detectBaseAdvance, FetchError } from './base-resolution.ts';

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

test('detectBaseAdvance: same SHAs returns false', () => {
  const result = detectBaseAdvance('abc123def456', 'abc123def456');
  assert.equal(result, false);
});

test('detectBaseAdvance: different SHAs returns true', () => {
  const result = detectBaseAdvance('abc123def456', 'xyz789');
  assert.equal(result, true);
});

test('FetchError: constructs error with all fields', () => {
  const err = new FetchError(
    'network_error',
    'Timeout during fetch',
    'main',
    'origin',
    'Network timeout after 30s',
  );

  assert.equal(err.type, 'network_error');
  assert.equal(err.baseBranch, 'main');
  assert.equal(err.remote, 'origin');
  assert(err.diagnostics.includes('timeout'));
});

// ────────────────────────────────────────────────────────────────
// Results
// ────────────────────────────────────────────────────────────────

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---\n`);
if (failed > 0) {
  process.exit(1);
}
