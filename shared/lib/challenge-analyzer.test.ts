import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeAggregations,
  formatChallengeTextOutput,
  joinRecords,
} from './challenge-analyzer.ts';
import type { StoredChallengeComparison } from './challenge-comparison.ts';
import type { EvalRecord } from './eval-schema.ts';

function createEvalRecord(overrides: Partial<EvalRecord>): EvalRecord {
  return {
    id: 'eval-id',
    schemaVersion: '1.0.0',
    originalPrompt: 'prompt',
    modelId: 'model',
    modelVersion: 'v1',
    score: 0.9,
    scoreBand: 'Minor Feedback',
    timeSeconds: 10,
    timestamp: '2026-01-01T00:00:00.000Z',
    interventionRequired: false,
    interventionCount: 0,
    interventionDetails: [],
    rationale: 'looks good',
    ...overrides,
  };
}

test('joinRecords pairs challenge comparisons with matching eval records', () => {
  const comparisons: StoredChallengeComparison[] = [
    {
      challengePairId: 'pair-1',
      primaryModel: 'model-a',
      challengerModel: 'model-b',
      primaryPrUrl: 'https://example.com/pr/1',
      challengerPrUrl: 'https://example.com/pr/2',
      primaryEvalScore: 0.9,
      challengerEvalScore: 0.7,
      winner: 'primary',
      winnerModel: 'model-a',
      rationale: 'A won',
      dimensions: {
        completeness: { primary: 8, challenger: 6 },
        correctness: { primary: 8, challenger: 6 },
        code_quality: { primary: 8, challenger: 6 },
        intervention_impact: { primary: 8, challenger: 6 },
        autonomy: { primary: 8, challenger: 6 },
      },
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ];

  const evals: EvalRecord[] = [
    createEvalRecord({ challengePairId: 'pair-1', prUrl: 'https://example.com/pr/1' }),
    createEvalRecord({ id: 'eval-2', challengePairId: 'pair-1', prUrl: 'https://example.com/pr/2' }),
  ];

  const joined = joinRecords(comparisons, evals);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].primaryEval?.prUrl, 'https://example.com/pr/1');
  assert.equal(joined[0].challengerEval?.prUrl, 'https://example.com/pr/2');
});

test('computeAggregations calculates role, stage, and cost summaries', () => {
  const comparisons: StoredChallengeComparison[] = [
    {
      challengePairId: 'pair-1',
      primaryModel: 'model-a',
      challengerModel: 'model-b',
      primaryPrUrl: 'https://example.com/pr/1',
      challengerPrUrl: 'https://example.com/pr/2',
      primaryEvalScore: 0.9,
      challengerEvalScore: 0.7,
      winner: 'primary',
      winnerModel: 'model-a',
      rationale: 'A won',
      dimensions: {
        completeness: { primary: 8, challenger: 6 },
        correctness: { primary: 8, challenger: 6 },
        code_quality: { primary: 8, challenger: 6 },
        intervention_impact: { primary: 8, challenger: 6 },
        autonomy: { primary: 8, challenger: 6 },
      },
      timestamp: '2026-01-01T00:00:00.000Z',
      primaryRouting: {
        planner: 'planner-a',
        coder: 'model-a',
        reviewer: 'reviewer-a',
        planDepth: 'deep',
        codeDepth: 'high',
        reviewMode: 'full',
        routerVariant: 'baseline',
        plannerPromptVariant: 'optimized',
        reviewerPromptVariant: 'baseline',
      },
      challengerRouting: {
        planner: 'planner-b',
        coder: 'model-b',
        reviewer: 'reviewer-b',
        planDepth: 'medium',
        codeDepth: 'medium',
        reviewMode: 'lite',
        routerVariant: 'canary',
        plannerPromptVariant: 'baseline',
        reviewerPromptVariant: 'optimized',
      },
      challengeType: 'multi-variable',
    },
  ];

  const evals: EvalRecord[] = [
    createEvalRecord({
      challengePairId: 'pair-1',
      prUrl: 'https://example.com/pr/1',
      workflowCost: 1.25,
      stageOutcomes: {
        expansion: { score: 0.9, rationale: 'good' },
        plan: { score: 0.8, rationale: 'good' },
        implementation: { score: 0.85, rationale: 'good' },
        review: { score: 0.88, rationale: 'good' },
      },
    }),
    createEvalRecord({
      id: 'eval-2',
      challengePairId: 'pair-1',
      prUrl: 'https://example.com/pr/2',
      workflowCost: 2.5,
      stageOutcomes: {
        expansion: { score: 0.6, rationale: 'ok' },
        plan: { score: 0.65, rationale: 'ok' },
        implementation: { score: 0.7, rationale: 'ok' },
        review: { score: 0.72, rationale: 'ok' },
      },
    }),
  ];

  const stats = computeAggregations(joinRecords(comparisons, evals));
  assert.equal(stats.totalComparisons, 1);
  assert.equal(stats.overallWinRates.get('model-a')?.wins, 1);
  assert.equal(stats.winRatesByRole.planner['planner-a']?.wins, 1);
  assert.equal(stats.stageQuality.plan?.count, 1);
  assert.equal(stats.costEfficiency?.winnerAvg, 1.25);
  assert.equal(stats.winRatesByResourceVariant.planner.get('optimized')?.wins, 1);

  const output = formatChallengeTextOutput(stats);
  assert.match(output, /Overall Win Rates:/);
  assert.match(output, /Cost Efficiency:/);
  assert.match(output, /By Planner Resource Variant:/);
});

test('joinRecords accepts legacy comparison dimensions without crashing', () => {
  const comparisons: StoredChallengeComparison[] = [
    {
      challengePairId: 'pair-legacy',
      primaryModel: 'model-a',
      challengerModel: 'model-b',
      primaryPrUrl: 'https://example.com/pr/10',
      challengerPrUrl: 'https://example.com/pr/11',
      primaryEvalScore: 0.75,
      challengerEvalScore: 0.7,
      winner: 'primary',
      winnerModel: 'model-a',
      rationale: 'legacy row',
      dimensions: {
        correctness: { primary: 8, challenger: 7 },
        codeQuality: { primary: 8, challenger: 7 },
        completeness: { primary: 8, challenger: 7 },
        scopeDiscipline: { primary: 8, challenger: 7 },
      },
      timestamp: '2026-01-02T00:00:00.000Z',
    },
  ];

  const joined = joinRecords(comparisons, []);
  const stats = computeAggregations(joined);
  assert.equal(stats.totalComparisons, 1);
  assert.equal(stats.overallWinRates.get('model-a')?.wins, 1);
});
