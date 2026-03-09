import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendChallengeComparison, readChallengeComparisons, type ChallengeComparison } from './challenge-comparison.ts';

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

function makeRecord(overrides?: Partial<ChallengeComparison>): ChallengeComparison {
  return {
    challengePairId: 'HOK-970',
    primaryModel: 'claude-sonnet-4-5-20250929',
    challengerModel: 'claude-opus-4-6',
    primaryPrUrl: 'https://github.com/org/repo/pull/1',
    challengerPrUrl: 'https://github.com/org/repo/pull/2',
    primaryEvalScore: 0.8,
    challengerEvalScore: 0.9,
    winner: 'challenger',
    winnerModel: 'claude-opus-4-6',
    rationale: 'Challenger is more complete.',
    dimensions: {
      correctness: { primary: 7, challenger: 9 },
      codeQuality: { primary: 7, challenger: 8 },
      completeness: { primary: 7, challenger: 9 },
      scopeDiscipline: { primary: 8, challenger: 8 },
    },
    timestamp: '2026-03-09T12:00:00Z',
    ...overrides,
  };
}

console.log('\n--- Challenge Comparison Persistence Tests ---\n');

test('appendChallengeComparison writes a record that can be read back', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    appendChallengeComparison(makeRecord(), tmp);
    const records = readChallengeComparisons(tmp);
    assert.equal(records.length, 1);
    assert.equal(records[0].challengePairId, 'HOK-970');
    assert.equal(records[0].winner, 'challenger');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('readChallengeComparisons returns empty array when file is missing', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'challenge-comparison-test-'));
  try {
    const records = readChallengeComparisons(tmp);
    assert.deepEqual(records, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);
  if (failed > 0) process.exitCode = 1;
});
