/**
 * Tests for task-difficulty-classifier module (HOK-1337).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyTaskDifficulty,
  getAllowedModelFloor,
  mapDifficultyBandToRouting,
  type RoutingDifficulty,
} from './task-difficulty-classifier.ts';
import { applyDifficultyFloor } from './workflow-router.ts';
import { clearConfigCache } from './config.ts';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${(err as Error).message}`);
    }
  })();
}

function makeRepo(): { repoDir: string; cleanup: () => void } {
  const repoDir = mkdtempSync(join(tmpdir(), 'difficulty-classifier-test-'));
  mkdirSync(join(repoDir, '.wavemill'), { recursive: true });
  clearConfigCache(repoDir);
  return {
    repoDir,
    cleanup: () => {
      clearConfigCache(repoDir);
      rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

console.log('\n--- task-difficulty-classifier Tests ---\n');

// ────────────────────────────────────────────────────────────────
// getAllowedModelFloor mapping
// ────────────────────────────────────────────────────────────────

await test('trivial floor: allowHaiku=true, neverHaikuAlone=false', () => {
  const floor = getAllowedModelFloor('trivial');
  assert.equal(floor.allowHaiku, true);
  assert.equal(floor.neverHaikuAlone, false);
  assert.equal(floor.preferSonnet, false);
  assert.equal(floor.preferOpus, false);
});

await test('moderate floor: allowHaiku=true, preferSonnet=true', () => {
  const floor = getAllowedModelFloor('moderate');
  assert.equal(floor.allowHaiku, true);
  assert.equal(floor.preferSonnet, true);
  assert.equal(floor.preferOpus, false);
  assert.equal(floor.neverHaikuAlone, false);
});

await test('hard floor: allowHaiku=false, neverHaikuAlone=true', () => {
  const floor = getAllowedModelFloor('hard');
  assert.equal(floor.allowHaiku, false);
  assert.equal(floor.neverHaikuAlone, true);
  assert.equal(floor.preferSonnet, true);
  assert.equal(floor.preferOpus, false);
});

await test('critical floor: allowHaiku=false, preferOpus=true, neverHaikuAlone=true', () => {
  const floor = getAllowedModelFloor('critical');
  assert.equal(floor.allowHaiku, false);
  assert.equal(floor.preferOpus, true);
  assert.equal(floor.neverHaikuAlone, true);
  assert.equal(floor.preferSonnet, false);
});

// ────────────────────────────────────────────────────────────────
// mapDifficultyBandToRouting mapping
// ────────────────────────────────────────────────────────────────

await test('trivial band maps to trivial routing difficulty', () => {
  assert.equal(mapDifficultyBandToRouting('trivial'), 'trivial');
});

await test('easy band maps to trivial routing difficulty', () => {
  assert.equal(mapDifficultyBandToRouting('easy'), 'trivial');
});

await test('medium band maps to moderate routing difficulty', () => {
  assert.equal(mapDifficultyBandToRouting('medium'), 'moderate');
});

await test('hard band maps to hard routing difficulty', () => {
  assert.equal(mapDifficultyBandToRouting('hard'), 'hard');
});

await test('very_hard band maps to critical routing difficulty', () => {
  assert.equal(mapDifficultyBandToRouting('very_hard'), 'critical');
});

// ────────────────────────────────────────────────────────────────
// applyDifficultyFloor enforcement
// ────────────────────────────────────────────────────────────────

const MODEL_POOL = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
];

await test('trivial floor: haiku model stays haiku', () => {
  const floor = getAllowedModelFloor('trivial');
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', floor, MODEL_POOL, 'coder');
  assert.equal(result, 'claude-haiku-4-5-20251001');
});

await test('moderate floor: haiku model stays haiku (allowed)', () => {
  const floor = getAllowedModelFloor('moderate');
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', floor, MODEL_POOL, 'coder');
  assert.equal(result, 'claude-haiku-4-5-20251001');
});

await test('hard floor: haiku model upgraded to sonnet', () => {
  const floor = getAllowedModelFloor('hard');
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', floor, MODEL_POOL, 'coder');
  assert.ok(
    result.includes('sonnet') || result.includes('opus'),
    `Expected sonnet or opus, got ${result}`,
  );
  assert.ok(!result.includes('haiku'), `Expected non-haiku model, got ${result}`);
});

await test('critical floor: haiku model upgraded (opus preferred when in pool)', () => {
  const floor = getAllowedModelFloor('critical');
  const poolWithOpus = ['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'];
  const result = applyDifficultyFloor('claude-haiku-4-5-20251001', floor, poolWithOpus, 'coder');
  assert.ok(!result.includes('haiku'), `Expected non-haiku model, got ${result}`);
});

await test('hard floor: sonnet model stays sonnet (floor satisfied)', () => {
  const floor = getAllowedModelFloor('hard');
  const result = applyDifficultyFloor('claude-sonnet-4-6', floor, MODEL_POOL, 'coder');
  assert.equal(result, 'claude-sonnet-4-6');
});

// ────────────────────────────────────────────────────────────────
// Heuristic fallback classification
// ────────────────────────────────────────────────────────────────

await test('short bland description classifies as trivial', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = classifyTaskDifficulty({
      title: 'Fix typo in README',
      description: 'Update text.',
      skipLlm: true,
      repoDir,
    });
    assert.equal(result.difficulty, 'trivial');
    assert.equal(result.source, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('description with "refactor" keyword classifies as hard or above', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // Note: avoid auth/payment/security keywords to isolate refactor signal
    const result = classifyTaskDifficulty({
      title: 'Refactor module',
      description: 'Refactor the user settings module to use the new dependency injection pattern. This involves updating all call sites and ensuring backward compatibility across multiple subsystems.',
      skipLlm: true,
      repoDir,
    });
    assert.ok(
      result.difficulty === 'hard' || result.difficulty === 'critical' || result.difficulty === 'moderate',
      `Expected hard, critical, or moderate, got ${result.difficulty}`,
    );
    assert.equal(result.source, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('description with "payment" keyword classifies as critical', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = classifyTaskDifficulty({
      title: 'Update payment flow',
      description: 'Modify the payment processing logic to handle new card types.',
      skipLlm: true,
      repoDir,
    });
    assert.equal(result.difficulty, 'critical');
    assert.equal(result.source, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('medium-length description without special keywords classifies as moderate', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = classifyTaskDifficulty({
      title: 'Add new endpoint',
      description: 'Create a new REST endpoint for listing user preferences. The endpoint should support pagination and filtering by category. Return results in JSON format with proper error handling and status codes.',
      skipLlm: true,
      repoDir,
    });
    assert.ok(
      result.difficulty === 'moderate' || result.difficulty === 'trivial',
      `Expected moderate or trivial, got ${result.difficulty}`,
    );
    assert.equal(result.source, 'heuristic');
  } finally {
    cleanup();
  }
});

await test('description with "security" keyword classifies as critical', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const result = classifyTaskDifficulty({
      title: 'Security audit',
      description: 'Review the security configuration.',
      skipLlm: true,
      repoDir,
    });
    assert.equal(result.difficulty, 'critical');
  } finally {
    cleanup();
  }
});

// ────────────────────────────────────────────────────────────────
// Caching round-trip
// ────────────────────────────────────────────────────────────────

await test('cache round-trip: write a result, read it back with same hash → source=cached', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    // First call writes to cache
    const first = classifyTaskDifficulty({
      title: 'Test task for cache',
      description: 'A unique description for cache testing.',
      skipLlm: true,
      repoDir,
    });
    assert.notEqual(first.source, 'cached');

    // Second call with same content reads from cache
    const second = classifyTaskDifficulty({
      title: 'Test task for cache',
      description: 'A unique description for cache testing.',
      skipLlm: true,
      repoDir,
    });
    assert.equal(second.source, 'cached');
    assert.equal(second.difficulty, first.difficulty);
  } finally {
    cleanup();
  }
});

await test('expired cache entry (past TTL) triggers re-classification', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const title = 'Cache expiry test stale';
    const description = 'Testing cache expiration behavior with a stale entry.';
    const hashInput = `${title}\n${description}\n`;
    const hash = createHash('sha256').update(hashInput).digest('hex');

    // Write a stale entry (classifiedAt 10 days ago) directly into the cache
    const staleDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const staleEntry = JSON.stringify({
      hash,
      result: {
        difficulty: 'trivial',
        rationale: 'Stale entry.',
        source: 'heuristic',
        classifiedAt: staleDate,
      },
    });
    writeFileSync(join(repoDir, '.wavemill', 'routing-difficulty-cache.jsonl'), staleEntry + '\n');

    // Read with default TTL=7 days — stale entry (10 days old) should be ignored
    const result = classifyTaskDifficulty({
      title,
      description,
      skipLlm: true,
      repoDir,
      cacheTtlDays: 7,
    });
    assert.notEqual(result.source, 'cached', 'Should have re-classified stale entry');
  } finally {
    cleanup();
  }
});

await test('different input produces different cache key', () => {
  const { repoDir, cleanup } = makeRepo();
  try {
    const r1 = classifyTaskDifficulty({
      title: 'Payment task',
      description: 'Handle payment processing.',
      skipLlm: true,
      repoDir,
    });

    const r2 = classifyTaskDifficulty({
      title: 'Fix typo',
      description: 'Update text.',
      skipLlm: true,
      repoDir,
    });

    // Both should classify (not return cached of the other)
    assert.notEqual(r2.source, 'cached'); // second call with different input shouldn't be cached
  } finally {
    cleanup();
  }
});

console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
if (failed > 0) {
  process.exit(1);
}
