import assert from 'node:assert/strict';
import test from 'node:test';
import {
  balanceReport,
  computeDefaultWeight,
  mergeSamples,
  partition,
  validateManifest,
  type PartitionAssignment,
} from './test-partitioner.ts';

function makeTests(count: number, prefix = 'small'): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}.test.ts`);
}

test('partition is deterministic: identical inputs give byte-identical assignments', () => {
  const tests = ['c.test.ts', 'a.test.ts', 'b.test.ts', 'd.test.ts', 'e.test.ts'];
  const weights = { 'a.test.ts': 500, 'b.test.ts': 500, 'c.test.ts': 300, 'd.test.ts': 100 };
  const first = partition({ tests, weights, defaultWeightMs: 250, shardTotal: 2 });
  const second = partition({ tests, weights, defaultWeightMs: 250, shardTotal: 2 });

  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('partition assigns every input test exactly once, including tests absent from the manifest', () => {
  const tests = [...makeTests(17), 'unknown-new.test.ts'];
  const weights: Record<string, number> = {};
  for (const [index, id] of makeTests(17).entries()) weights[id] = (index + 1) * 50;

  const assignment = partition({ tests, weights, defaultWeightMs: 900, shardTotal: 4 });
  const assigned = assignment.shards.flat().sort();

  assert.deepEqual(assigned, [...tests].sort());
  assert.equal(assignment.effectiveWeights['unknown-new.test.ts'], 900);
});

test('partition preserves input-list order within each shard', () => {
  const tests = ['z.test.ts', 'm.test.ts', 'a.test.ts', 'q.test.ts'];
  const assignment = partition({ tests, weights: {}, defaultWeightMs: 10, shardTotal: 2 });

  for (const shard of assignment.shards) {
    const indexes = shard.map((testId) => tests.indexOf(testId));
    assert.deepEqual(indexes, [...indexes].sort((a, b) => a - b));
  }
});

test('REQ-F3 scenario: one 300s test among twenty 10s tests is a named indivisible hotspot', () => {
  const smalls = makeTests(20);
  const tests = ['huge.test.ts', ...smalls];
  const weights: Record<string, number> = { 'huge.test.ts': 300_000 };
  for (const id of smalls) weights[id] = 10_000;

  const assignment = partition({ tests, weights, defaultWeightMs: 10_000, shardTotal: 3 });
  const report = balanceReport(assignment);

  // LPT puts the 300s test alone on one shard and splits the 20 small tests
  // evenly across the other two.
  const hugeShard = assignment.shards.findIndex((shard) => shard.includes('huge.test.ts'));
  assert.equal(assignment.shards[hugeShard].length, 1);
  const otherSizes = assignment.shards.filter((_, i) => i !== hugeShard).map((shard) => shard.length);
  assert.deepEqual(otherSizes.sort(), [10, 10]);

  // The overload is caused by one indivisible test, so it is reported as a
  // named exception, not a violation.
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.equal(report.indivisibleHotspots.length, 1);
  assert.equal(report.indivisibleHotspots[0].test, 'huge.test.ts');
  assert.equal(report.indivisibleHotspots[0].shard, hugeShard + 1);
});

test('balanceReport flags an over-limit shard of divisible tests as a violation', () => {
  const assignment: PartitionAssignment = {
    shards: [['a.test.ts', 'b.test.ts'], ['c.test.ts'], ['d.test.ts']],
    estimates: [200, 100, 100],
    effectiveWeights: { 'a.test.ts': 100, 'b.test.ts': 100, 'c.test.ts': 100, 'd.test.ts': 100 },
  };
  const report = balanceReport(assignment);

  assert.equal(report.ok, false);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].shard, 1);
  assert.deepEqual(report.indivisibleHotspots, []);
});

test('all-equal weights balance file counts across shards', () => {
  const tests = makeTests(21);
  const weights: Record<string, number> = {};
  for (const id of tests) weights[id] = 1000;

  const assignment = partition({ tests, weights, defaultWeightMs: 1000, shardTotal: 3 });

  assert.deepEqual(assignment.shards.map((shard) => shard.length), [7, 7, 7]);
  assert.equal(balanceReport(assignment).ok, true);
});

test('zero, negative, and malformed weights are hard errors naming the entry', () => {
  const tests = ['a.test.ts'];
  assert.throws(
    () => partition({ tests, weights: { 'a.test.ts': 0 }, defaultWeightMs: 10, shardTotal: 1 }),
    /invalid weight for "a\.test\.ts"/,
  );
  assert.throws(
    () => partition({ tests, weights: { 'a.test.ts': -5 }, defaultWeightMs: 10, shardTotal: 1 }),
    /invalid weight for "a\.test\.ts"/,
  );
  assert.throws(
    () => partition({
      tests,
      weights: { 'a.test.ts': Number.NaN },
      defaultWeightMs: 10,
      shardTotal: 1,
    }),
    /invalid weight for "a\.test\.ts"/,
  );
  assert.throws(
    () => partition({ tests, weights: {}, defaultWeightMs: 0, shardTotal: 1 }),
    /invalid weight for "\(defaultWeightMs\)"/,
  );
});

test('partition rejects duplicate test ids and invalid shard counts', () => {
  assert.throws(
    () => partition({ tests: ['a.test.ts', 'a.test.ts'], weights: {}, defaultWeightMs: 10, shardTotal: 2 }),
    /duplicate test id "a\.test\.ts"/,
  );
  assert.throws(
    () => partition({ tests: ['a.test.ts'], weights: {}, defaultWeightMs: 10, shardTotal: 0 }),
    /invalid shardTotal/,
  );
});

test('mergeSamples computes per-test medians and refuses fewer than 3 samples', () => {
  const sample = (ms: number, extra: Array<{ file: string; ms: number }> = []) => ({
    results: [{ file: 'a.test.ts', ms }, ...extra],
  });

  assert.throws(() => mergeSamples([sample(10), sample(20)]), /at least 3 are required/);

  const merged = mergeSamples([
    sample(100, [{ file: 'b.test.ts', ms: 900 }]),
    sample(300),
    sample(200, [{ file: 'b.test.ts', ms: 500 }]),
  ]);
  assert.equal(merged.weights['a.test.ts'], 200);
  // b appears in 2 of 3 samples; median of [500, 900].
  assert.equal(merged.weights['b.test.ts'], 700);
  assert.equal(merged.sampleCount, 3);
});

test('mergeSamples --allow-few permits small sample counts and floors weights at 1ms', () => {
  const merged = mergeSamples([{ results: [{ file: 'a.test.ts', ms: 0.2 }] }], { allowFew: true });
  assert.equal(merged.weights['a.test.ts'], 1);
});

test('mergeSamples rejects malformed entries with a named diagnostic instead of dropping them', () => {
  assert.throws(
    () => mergeSamples([{ results: [{ file: 'a.test.ts', ms: -1 }] }], { allowFew: true }),
    /invalid ms for "a\.test\.ts"/,
  );
  assert.throws(
    () => mergeSamples([{ results: [{ file: '', ms: 5 }] }], { allowFew: true }),
    /entry without a file id/,
  );
  assert.throws(
    () => mergeSamples([{} as never], { allowFew: true }),
    /no results array/,
  );
});

test('computeDefaultWeight is the p90 of known weights', () => {
  const weights: Record<string, number> = {};
  for (let i = 1; i <= 10; i++) weights[`t${i}`] = i * 100;
  assert.equal(computeDefaultWeight(weights), 900);
  assert.equal(computeDefaultWeight({}), 1000);
});

test('validateManifest rejects missing fields and invalid weights', () => {
  const valid = {
    suite: 'unit',
    generatedAt: '2026-01-01T00:00:00Z',
    samples: ['a', 'b', 'c'],
    defaultWeightMs: 500,
    weights: { 'a.test.ts': 10 },
  };
  assert.equal(validateManifest(valid, 'fixture').suite, 'unit');

  assert.throws(() => validateManifest(null, 'fixture'), /not a JSON object/);
  assert.throws(() => validateManifest({ ...valid, suite: '' }, 'fixture'), /missing "suite"/);
  assert.throws(() => validateManifest({ ...valid, weights: null }, 'fixture'), /missing "weights"/);
  assert.throws(
    () => validateManifest({ ...valid, defaultWeightMs: -1 }, 'fixture'),
    /invalid weight for "\(defaultWeightMs\)"/,
  );
  assert.throws(
    () => validateManifest({ ...valid, weights: { 'a.test.ts': 'fast' } }, 'fixture'),
    /invalid weight for "a\.test\.ts"/,
  );
});
