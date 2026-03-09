import assert from 'node:assert/strict';
import type { ReviewMetric } from './review-metrics.ts';
import { computeStats, filterMetrics, formatStats } from './review-stats.ts';

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

function makeMetric(overrides: Partial<ReviewMetric> = {}): ReviewMetric {
  return {
    id: 'review-1',
    timestamp: '2026-03-01T12:00:00Z',
    branch: 'task/example',
    targetBranch: 'main',
    issueId: 'HOK-987',
    outcome: 'resolved',
    totalIterations: 1,
    iterations: [
      {
        iterationNumber: 1,
        verdict: 'ready',
        timestamp: '2026-03-01T12:05:00Z',
        findingsSummary: {
          blockers: 1,
          warnings: 1,
          total: 2,
        },
        findings: [
          { severity: 'blocker', category: 'correctness', location: 'a.ts:1' },
          { severity: 'warning', category: 'maintainability', location: 'b.ts:2' },
        ],
      },
    ],
    ...overrides,
  };
}

console.log('\n--- review-stats tests ---\n');

test('filterMetrics applies date, outcome, branch, and issue filters', () => {
  const metrics = [
    makeMetric(),
    makeMetric({
      id: 'review-2',
      timestamp: '2026-02-20T12:00:00Z',
      branch: 'task/other',
      issueId: 'HOK-100',
      outcome: 'escalated',
    }),
  ];

  const result = filterMetrics(metrics, {
    from: '2026-03-01',
    outcome: 'resolved',
    branch: 'example',
    issue: 'HOK-987',
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'review-1');
});

test('computeStats aggregates outcomes, findings, and buckets iterations', () => {
  const metrics = [
    makeMetric(),
    makeMetric({
      id: 'review-2',
      timestamp: '2026-03-02T12:00:00Z',
      branch: 'task/example-2',
      totalIterations: 4,
      outcome: 'error',
      iterations: [
        {
          iterationNumber: 1,
          verdict: 'not_ready',
          timestamp: '2026-03-02T12:05:00Z',
          findingsSummary: {
            blockers: 2,
            warnings: 0,
            total: 2,
          },
          findings: [
            { severity: 'blocker', category: 'correctness', location: 'c.ts:3' },
            { severity: 'blocker', category: 'security', location: 'd.ts:4' },
          ],
        },
      ],
    }),
  ];

  const stats = computeStats(metrics, 5);

  assert.equal(stats.totalReviews, 2);
  assert.equal(stats.avgIterations, 2.5);
  assert.equal(stats.resolutionRate, 50);
  assert.equal(stats.errorRate, 50);
  assert.equal(stats.findingsSummary.blockers, 3);
  assert.equal(stats.findingsSummary.warnings, 1);
  assert.equal(stats.iterationDistribution['1'], 1);
  assert.equal(stats.iterationDistribution['4+'], 1);
  assert.equal(stats.topCategories[0].category, 'correctness');
  assert.equal(stats.recentReviews[0].branch, 'task/example-2');
  assert.equal(stats.recentReviews[0].date, '2026-03-02');
});

test('formatStats renders empty-state and populated output', () => {
  const emptyOutput = formatStats(computeStats([], 5));
  assert.match(emptyOutput, /No review metrics found/);

  const populatedOutput = formatStats(computeStats([makeMetric()], 5));
  assert.match(populatedOutput, /REVIEW METRICS SUMMARY/);
  assert.match(populatedOutput, /Overall Statistics/);
  assert.match(populatedOutput, /Recent Reviews/);
});

process.on('exit', () => {
  console.log(`\nPassed: ${passed}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
});
