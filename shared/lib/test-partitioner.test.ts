/**
 * Tests for the deterministic weighted test partitioner (HOK-2939).
 *
 * Covers the task packet's Section 6 fixtures: determinism/exactly-once
 * (REQ-F1/F2), the 300s-hotspot balance scenario with the named
 * indivisible exception (REQ-F3), all-equal balancing, rejection of
 * zero/negative/NaN weights, and the conservative default for unknown tests.
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  partitionTests,
  analyzeBalance,
  validateWeights,
} from './test-partitioner.ts';

const files = (count: number, prefix = 't') =>
  Array.from({ length: count }, (_, i) => `${prefix}${String(i).padStart(3, '0')}.test.ts`);

test('identical inputs produce byte-identical assignments', () => {
  const input = {
    files: files(20),
    weights: Object.fromEntries(files(20).map((f, i) => [f, (i % 7) * 1000 + 500])),
    defaultMs: 30000,
    shardCount: 4,
  };
  const a = partitionTests(input);
  const b = partitionTests(input);
  assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('every input file is assigned exactly once', () => {
  const input = files(37);
  const result = partitionTests({
    files: input,
    weights: { [input[3]]: 120000, [input[10]]: 45000 },
    defaultMs: 30000,
    shardCount: 5,
  });
  const assigned = result.shards.flatMap((s) => s.files);
  assert.strictEqual(assigned.length, input.length);
  assert.deepStrictEqual([...assigned].sort(), [...input].sort());
});

test('shard files preserve original registration order', () => {
  const input = files(12);
  const weights = Object.fromEntries(input.map((f, i) => [f, (12 - i) * 1000]));
  const result = partitionTests({ files: input, weights, defaultMs: 1000, shardCount: 3 });
  for (const shard of result.shards) {
    const indices = shard.files.map((f) => input.indexOf(f));
    assert.deepStrictEqual(indices, [...indices].sort((a, b) => a - b));
  }
});

test('packet fixture: one 300s test and twenty 10s tests distributes deterministically', () => {
  const big = 'big.test.ts';
  const small = files(20, 's');
  const weights: Record<string, number> = { [big]: 300_000 };
  for (const f of small) weights[f] = 10_000;
  const input = { files: [big, ...small], weights, defaultMs: 30000, shardCount: 3 };

  const result = partitionTests(input);
  const again = partitionTests(input);
  assert.strictEqual(JSON.stringify(result), JSON.stringify(again));

  // LPT: the 300s test lands alone-ish on one shard; the twenty 10s tests
  // spread over the other two (100s each).
  const bigShard = result.shards.find((s) => s.files.includes(big))!;
  assert.strictEqual(bigShard.files.length, 1);
  const others = result.shards.filter((s) => !s.files.includes(big));
  assert.deepStrictEqual(others.map((s) => s.estimatedMs), [100_000, 100_000]);

  // The 300s shard exceeds 130% of the median (100s -> threshold 130s), but
  // the single indivisible test alone exceeds the bound, so it is a named
  // exception rather than a failure.
  const balance = analyzeBalance(result);
  assert.strictEqual(balance.ok, true);
  assert.strictEqual(balance.overloaded.length, 0);
  assert.strictEqual(balance.indivisibleHotspots.length, 1);
  assert.strictEqual(balance.indivisibleHotspots[0].file, big);
});

test('overloaded shard without an indivisible hotspot fails balance', () => {
  // Construct a partition by hand: divisible overload (two 80s tests on one
  // shard, median 100s -> threshold 130s, shard at 160s, heaviest test 80s).
  const partition = {
    shards: [
      { files: ['a1', 'a2'], estimatedMs: 160_000 },
      { files: ['b'], estimatedMs: 100_000 },
      { files: ['c'], estimatedMs: 100_000 },
    ],
    effectiveWeights: { a1: 80_000, a2: 80_000, b: 100_000, c: 100_000 },
  };
  const balance = analyzeBalance(partition);
  assert.strictEqual(balance.ok, false);
  assert.deepStrictEqual(balance.overloaded, [{ shardIndex: 0, estimatedMs: 160_000 }]);
  assert.strictEqual(balance.indivisibleHotspots.length, 0);
});

test('all-equal durations balance counts across shards', () => {
  const input = files(20);
  const weights = Object.fromEntries(input.map((f) => [f, 10_000]));
  const result = partitionTests({ files: input, weights, defaultMs: 10_000, shardCount: 4 });
  for (const shard of result.shards) {
    assert.strictEqual(shard.files.length, 5);
    assert.strictEqual(shard.estimatedMs, 50_000);
  }
  const balance = analyzeBalance(result);
  assert.strictEqual(balance.ok, true);
});

test('zero, negative, and NaN weights are rejected with the test named', () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () =>
        partitionTests({
          files: ['ok.test.ts', 'bad.test.ts'],
          weights: { 'bad.test.ts': bad },
          defaultMs: 1000,
          shardCount: 1,
        }),
      /bad\.test\.ts/
    );
  }
});

test('validateWeights names the offending file', () => {
  assert.throws(() => validateWeights({ 'x.test.ts': -1 }, 'ctx'), /ctx.*x\.test\.ts/);
  assert.doesNotThrow(() => validateWeights({ 'x.test.ts': 1 }));
});

test('unknown files receive defaultMs', () => {
  const result = partitionTests({
    files: ['known.test.ts', 'unknown.test.ts'],
    weights: { 'known.test.ts': 5_000 },
    defaultMs: 42_000,
    shardCount: 2,
  });
  assert.strictEqual(result.effectiveWeights['unknown.test.ts'], 42_000);
  assert.strictEqual(result.effectiveWeights['known.test.ts'], 5_000);
});

test('duplicate files are rejected', () => {
  assert.throws(
    () =>
      partitionTests({
        files: ['dup.test.ts', 'dup.test.ts'],
        weights: {},
        defaultMs: 1000,
        shardCount: 1,
      }),
    /duplicate.*dup\.test\.ts/
  );
});

test('invalid shard counts and empty inputs are rejected', () => {
  assert.throws(() => partitionTests({ files: ['a'], weights: {}, defaultMs: 1, shardCount: 0 }), /shardCount/);
  assert.throws(() => partitionTests({ files: ['a'], weights: {}, defaultMs: 1, shardCount: 1.5 }), /shardCount/);
  assert.throws(() => partitionTests({ files: [], weights: {}, defaultMs: 1, shardCount: 1 }), /no test files/);
  assert.throws(() => partitionTests({ files: ['a'], weights: {}, defaultMs: 1, shardCount: 2 }), /empty/);
  assert.throws(() => partitionTests({ files: ['a'], weights: {}, defaultMs: 0, shardCount: 1 }), /defaultMs/);
});

test('weight ties break deterministically by id', () => {
  const input = ['b.test.ts', 'a.test.ts', 'c.test.ts'];
  const weights = Object.fromEntries(input.map((f) => [f, 1000]));
  const a = partitionTests({ files: input, weights, defaultMs: 1000, shardCount: 3 });
  // Ties sort by id ascending: a -> shard 0, b -> shard 1, c -> shard 2.
  assert.deepStrictEqual(
    a.shards.map((s) => s.files),
    [['a.test.ts'], ['b.test.ts'], ['c.test.ts']]
  );
});
