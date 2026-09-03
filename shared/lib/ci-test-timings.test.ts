/**
 * Tests for CI timing aggregation and run reporting (HOK-2939): median math,
 * deterministic manifest output, the <3-samples refusal path, malformed-doc
 * diagnostics, and REQ-F6 duration summarization.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTimingDoc,
  medianOf,
  p90Of,
  collectWeights,
  serializeManifest,
  summarizeRun,
  summarizeRuns,
  formatSeconds,
  formatReport,
  type TimingDoc,
} from './ci-test-timings.ts';

function doc(suite: string, runId: string, tests: Array<[string, number]>, generatedAt = '2026-09-02T00:00:00Z'): TimingDoc {
  return {
    suite,
    shard: '1/1',
    runId,
    sha: 'abc',
    generatedAt,
    tests: tests.map(([id, elapsedMs]) => ({ id, elapsedMs, result: 'pass' })),
  };
}

test('medianOf and p90Of', () => {
  assert.equal(medianOf([3, 1, 2]), 2);
  assert.equal(medianOf([4, 1, 2, 3]), 2.5);
  assert.equal(p90Of([1]), 1);
  assert.equal(p90Of([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]), 90);
  assert.throws(() => medianOf([]), /empty/);
});

test('parseTimingDoc validates structure with the source named', () => {
  assert.throws(() => parseTimingDoc('nope', 'f.json'), /f\.json.*not valid JSON/);
  assert.throws(() => parseTimingDoc('{}', 'f.json'), /expected \{suite, tests\[\]\}/);
  assert.throws(
    () => parseTimingDoc(JSON.stringify({ suite: 'unit', tests: [{ id: 'a', elapsedMs: -1 }] }), 'f.json'),
    /invalid elapsedMs for "a"/
  );
  const parsed = parseTimingDoc(JSON.stringify(doc('unit', 'r1', [['a', 5]])), 'f.json');
  assert.equal(parsed.tests[0].elapsedMs, 5);
});

test('collectWeights computes per-test medians across runs', () => {
  const docs = [
    doc('unit', 'r1', [['a.test.ts', 100], ['b.test.ts', 10]]),
    doc('unit', 'r2', [['a.test.ts', 300], ['b.test.ts', 20]]),
    doc('unit', 'r3', [['a.test.ts', 200], ['b.test.ts', 90]]),
  ];
  const manifest = collectWeights(docs, { defaultMs: 30000 });
  assert.equal(manifest.suites.unit['a.test.ts'], 200);
  assert.equal(manifest.suites.unit['b.test.ts'], 20);
  assert.equal(manifest.defaultMs, 30000);
  assert.equal(manifest.version, 1);
});

test('collectWeights output is deterministic (sorted keys, stable sources)', () => {
  const docs = [
    doc('unit', 'r1', [['z.test.ts', 5], ['a.test.ts', 7]]),
    doc('custom', 'r1', [['c.test.ts', 9]]),
    doc('unit', 'r2', [['a.test.ts', 7], ['z.test.ts', 5]]),
    doc('custom', 'r2', [['c.test.ts', 9]]),
    doc('unit', 'r3', [['a.test.ts', 7], ['z.test.ts', 5]]),
    doc('custom', 'r3', [['c.test.ts', 9]]),
  ];
  const a = serializeManifest(collectWeights(docs, { defaultMs: 1000 }));
  const b = serializeManifest(collectWeights([...docs], { defaultMs: 1000 }));
  assert.equal(a, b);
  // suite keys sorted: custom before unit; test keys sorted within suite.
  assert.ok(a.indexOf('"custom"') < a.indexOf('"unit"'));
  assert.ok(a.indexOf('"a.test.ts"') < a.indexOf('"z.test.ts"'));
});

test('collectWeights refuses under-sampled tests unless allowFewer', () => {
  const docs = [
    doc('unit', 'r1', [['a.test.ts', 100]]),
    doc('unit', 'r2', [['a.test.ts', 100]]),
  ];
  assert.throws(() => collectWeights(docs, { defaultMs: 1000 }), /fewer than 3 samples.*a\.test\.ts/s);
  const manifest = collectWeights(docs, { defaultMs: 1000, allowFewer: true });
  assert.equal(manifest.suites.unit['a.test.ts'], 100);
  assert.throws(() => collectWeights([], { defaultMs: 1000 }), /no timing documents/);
});

test('collectWeights clamps sub-millisecond medians to 1ms', () => {
  const docs = [
    doc('unit', 'r1', [['fast.test.ts', 0]]),
    doc('unit', 'r2', [['fast.test.ts', 0]]),
    doc('unit', 'r3', [['fast.test.ts', 0]]),
  ];
  const manifest = collectWeights(docs, { defaultMs: 1000 });
  assert.equal(manifest.suites.unit['fast.test.ts'], 1);
});

test('summarizeRun computes created->aggregator duration', () => {
  const summary = summarizeRun({
    runId: '1',
    createdAt: '2026-09-02T00:00:00Z',
    jobs: [
      { name: 'Unit Tests (shard 1/5)', startedAt: '2026-09-02T00:00:10Z', completedAt: '2026-09-02T00:03:10Z', conclusion: 'success' },
      { name: 'Shell and Unit Tests', startedAt: '2026-09-02T00:04:00Z', completedAt: '2026-09-02T00:04:12Z', conclusion: 'success' },
    ],
  });
  assert.equal(summary.aggregatorSeconds, 252);
  assert.equal(summary.jobs.find((job) => job.name.startsWith('Unit'))!.seconds, 180);
});

test('summarizeRun rejects runs without a completed aggregator', () => {
  assert.throws(
    () => summarizeRun({ runId: '2', createdAt: '2026-09-02T00:00:00Z', jobs: [{ name: 'other' }] }),
    /aggregator job "Shell and Unit Tests" not found/
  );
});

test('summarizeRuns reports median and p90 across runs', () => {
  const runs = [100, 200, 300, 400, 500].map((seconds, index) => ({
    runId: String(index),
    createdAt: '2026-09-02T00:00:00Z',
    jobs: [
      {
        name: 'Shell and Unit Tests',
        startedAt: '2026-09-02T00:00:00Z',
        completedAt: new Date(Date.parse('2026-09-02T00:00:00Z') + seconds * 1000).toISOString(),
        conclusion: 'success',
      },
    ],
  }));
  const summary = summarizeRuns(runs);
  assert.equal(summary.medianSeconds, 300);
  assert.equal(summary.p90Seconds, 500);
  const report = formatReport(summary);
  assert.match(report, /median created->aggregator: 5:00 \(300s\)/);
  assert.throws(() => summarizeRuns([]), /no runs/);
});

test('formatSeconds renders mm:ss', () => {
  assert.equal(formatSeconds(300), '5:00');
  assert.equal(formatSeconds(65), '1:05');
  assert.equal(formatSeconds(0), '0:00');
});
