import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { buildNoComparisonReport } from './no-comparison-report.ts';
import type { StoredChallengeComparison } from './challenge-comparison.ts';

function dimensions(): StoredChallengeComparison['dimensions'] {
  return { completeness: { primary: 0, challenger: 0 }, correctness: { primary: 0, challenger: 0 }, code_quality: { primary: 0, challenger: 0 }, intervention_impact: { primary: 0, challenger: 0 }, autonomy: { primary: 0, challenger: 0 } };
}

function record(overrides: Partial<StoredChallengeComparison> & Pick<StoredChallengeComparison, 'challengePairId'>): StoredChallengeComparison {
  return {
    timestamp: '2026-08-10T00:00:00Z',
    comparisonOutcome: 'compared',
    winner: 'primary',
    primaryModel: 'a',
    challengerModel: 'b',
    primaryPrUrl: 'url1',
    challengerPrUrl: 'url2',
    primaryEvalScore: 1,
    challengerEvalScore: 1,
    rationale: 'test',
    dimensions: dimensions(),
    ...overrides,
  };
}

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
    assert.equal(report.launchedPairs, 1);
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
    assert.equal(report.totalPairs, 3);
    assert.equal(report.comparedPairs, 1);
    assert.equal(report.forfeitPairs, 1);
    assert.equal(report.yieldRate, 1 / 3);
    assert.equal(report.noComparisonRate, 2 / 3);
  });

  await t.test('calculates skip rate from skipped, invalid, inconclusive, and forfeit outcomes', () => {
    const comps: StoredChallengeComparison[] = [
      record({ challengePairId: 'compared' }),
      record({
        challengePairId: 'skipped',
        comparisonOutcome: 'skipped',
        winner: 'primary',
        skipReason: 'identical-routing-dimensions',
        noComparisonReason: 'identical_routing_dimensions',
      }),
      record({
        challengePairId: 'invalid-challenge',
        comparisonOutcome: 'invalid_challenge',
        winner: undefined,
        invalidChallenge: true,
        invalidChallengeReason: 'identical_effective_route',
        noComparisonReason: 'identical_effective_route',
      }),
      record({
        challengePairId: 'invalid',
        comparisonOutcome: 'invalid',
        winner: undefined,
        terminalReason: 'provenance_validation_failed',
        provenanceValidation: { valid: false, outcome: 'invalid', issues: [] },
      }),
      record({
        challengePairId: 'inconclusive',
        comparisonOutcome: 'inconclusive',
        winner: undefined,
        terminalReason: 'provenance_validation_failed',
        provenanceValidation: { valid: false, outcome: 'inconclusive', issues: [] },
      }),
      record({
        challengePairId: 'forfeit',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        noComparisonReason: 'orphan_pair',
      }),
      record({
        challengePairId: 'double-forfeit',
        comparisonOutcome: 'double-forfeit',
        winner: undefined,
        terminalReason: 'both_eval_hard_failed',
        noComparisonReason: 'both_eval_hard_failed',
      }),
    ];

    const report = buildNoComparisonReport({ comparisons: comps });
    assert.equal(report.launchedPairs, 7);
    assert.equal(report.totalPairs, 7);
    assert.equal(report.comparedPairs, 1);
    assert.equal(report.forfeitPairs, 1);
    assert.equal(report.doubleForfeitPairs, 1);
    assert.equal(report.skipRate, 6 / 7);
    assert.equal(report.yieldRate, 1 / 7);
    assert.equal(report.noComparisonRate, 6 / 7);
  });

  await t.test('excludes explicit challenger_never_launched phantom pairs from launched denominator', () => {
    const comps: StoredChallengeComparison[] = [
      record({
        challengePairId: 'phantom-explicit',
        comparisonOutcome: 'forfeit',
        terminalReason: 'orphan_pair',
        noComparisonReason: 'challenger_never_launched',
        challengerPrUrl: 'https://github.com/org/repo/pull/123',
        challengerModel: 'claude-opus-4-8',
      }),
      record({ challengePairId: 'real-compared' }),
    ];

    const report = buildNoComparisonReport({ comparisons: comps });
    assert.equal(report.phantomPairs, 1);
    assert.equal(report.launchedPairs, 1);
    assert.equal(report.totalPairs, 2);
    assert.equal(report.comparedPairs, 1);
    assert.equal(report.yieldRate, 1 / 2);
    assert.equal(report.byReason.get('challenger_never_launched')?.count, 1);
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
