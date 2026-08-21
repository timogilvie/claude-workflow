import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildNoComparisonReport } from './no-comparison-report.ts';
import type { StoredChallengeComparison } from './challenge-comparison.ts';

test('no-comparison-report', async (t) => {
  await t.test('dedupes by challengePairId, latest timestamp wins', () => {
    const comps: StoredChallengeComparison[] = [
      {
        challengePairId: 'pair1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 0,
        challengerEvalScore: 0,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
      {
        challengePairId: 'pair1',
        timestamp: '2026-08-11T00:00:00Z',
        comparisonOutcome: 'compared',
        winner: 'primary',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 4,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
    ];

    const report = buildNoComparisonReport({ comparisons: comps });
    assert.equal(report.comparedPairs, 1);
    assert.equal(report.launchedPairs, 0);
  });

  await t.test('counts phantom pairs separately', () => {
    const comps: StoredChallengeComparison[] = [
      {
        challengePairId: 'phantom1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        challengerPrUrl: 'https://github.com/unknown/unknown/pull/0',
        challengerModel: 'unknown',
        primaryModel: 'a',
        primaryPrUrl: 'url1',
        primaryEvalScore: 0,
        challengerEvalScore: 0,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
      {
        challengePairId: 'real1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        challengerPrUrl: 'https://github.com/unknown/unknown/pull/123',
        challengerModel: 'real-model',
        primaryModel: 'a',
        primaryPrUrl: 'url1',
        primaryEvalScore: 0,
        challengerEvalScore: 0,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
    ];

    const report = buildNoComparisonReport({ comparisons: comps });
    assert.equal(report.phantomPairs, 1);
    assert.equal(report.launchedPairs, 1);
  });

  await t.test('calculates rates correctly', () => {
    const comps: StoredChallengeComparison[] = [
      {
        challengePairId: 'pair1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'compared',
        winner: 'primary',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 4,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
      {
        challengePairId: 'pair2',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'invalid_challenge',
        invalidChallengeReason: 'identical_effective_route',
        noComparisonReason: 'identical_effective_route',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 5,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
      {
        challengePairId: 'pair3',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        challengerPrUrl: 'https://github.com/unknown/unknown/pull/123',
        challengerModel: 'real-model',
        noComparisonReason: 'orphan_pair',
        primaryModel: 'a',
        primaryPrUrl: 'url1',
        primaryEvalScore: 0,
        challengerEvalScore: 0,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
    ];

    const report = buildNoComparisonReport({ comparisons: comps });
    assert.equal(report.launchedPairs, 3);
    assert.equal(report.comparedPairs, 1);
    assert.equal(report.noComparisonRate, 2 / 3);
  });

  await t.test('filters by date range', () => {
    const comps: StoredChallengeComparison[] = [
      {
        challengePairId: 'pair1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'compared',
        winner: 'primary',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 4,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
      {
        challengePairId: 'pair2',
        timestamp: '2026-08-12T00:00:00Z',
        comparisonOutcome: 'compared',
        winner: 'primary',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 4,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
    ];

    const report = buildNoComparisonReport({
      comparisons: comps,
      since: new Date('2026-08-11'),
    });
    assert.equal(report.launchedPairs, 1);
    assert.equal(report.comparedPairs, 1);
  });

  await t.test('detects unrecorded pairs', () => {
    const comps: StoredChallengeComparison[] = [
      {
        challengePairId: 'pair1',
        timestamp: '2026-08-10T00:00:00Z',
        comparisonOutcome: 'compared',
        winner: 'primary',
        primaryModel: 'a',
        challengerModel: 'b',
        primaryPrUrl: 'url1',
        challengerPrUrl: 'url2',
        primaryEvalScore: 5,
        challengerEvalScore: 4,
        rationale: 'test',
        dimensions: { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } },
      },
    ];
    const evals = [
      { challengePairId: 'pair1' },
      { challengePairId: 'pair2' },
      { challengePairId: 'pair2' },
    ];

    const report = buildNoComparisonReport({
      comparisons: comps,
      evals,
    });
    assert.ok(report.unrecordedPairs);
    assert.equal(report.unrecordedPairs.length, 1);
    assert.equal(report.unrecordedPairs[0].pairId, 'pair2');
    assert.equal(report.unrecordedPairs[0].evalCount, 2);
  });
});
