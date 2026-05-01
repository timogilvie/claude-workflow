import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID,
  scoreWavemillSuccessRateUnderBudget,
  type WavemillRouterScoreRecord,
} from './success-rate-under-budget.ts';

function makeRecord(
  overrides: Partial<WavemillRouterScoreRecord> = {},
): WavemillRouterScoreRecord {
  return {
    route_valid: true,
    completed_successfully: true,
    actual_cost_usd: 2,
    max_cost_usd: 3,
    timing_ms: 100,
    intervention_count: 0,
    ...overrides,
  };
}

test('exports the exact scorer id', () => {
  assert.equal(
    WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID,
    'hokusai.scorers.wavemill.success_rate_under_budget:v1',
  );
});

test('scores all-success records', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [makeRecord(), makeRecord({ actual_cost_usd: 1.5, timing_ms: 200 })],
    { measurementPolicy: 'replay_exact_match' },
  );

  assert.equal(result.workflow_success_rate_under_budget, 1);
  assert.equal(result.wavemill_router_diagnostics.scoreable_coverage, 1);
  assert.equal(result.wavemill_router_diagnostics.budget_compliance_rate, 1);
  assert.equal(result.wavemill_router_diagnostics.completion_success_rate, 1);
});

test('scores all-fail records', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [
      makeRecord({ completed_successfully: false }),
      makeRecord({ actual_cost_usd: 4 }),
    ],
    { measurementPolicy: 'replay_exact_match' },
  );

  assert.equal(result.workflow_success_rate_under_budget, 0);
  assert.equal(result.wavemill_router_diagnostics.budget_compliance_rate, 0.5);
  assert.equal(result.wavemill_router_diagnostics.completion_success_rate, 0.5);
});

test('handles mixed success, over-budget success, and completion failure', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [
      makeRecord({ actual_cost_usd: 2, max_cost_usd: 3, completed_successfully: true }),
      makeRecord({ actual_cost_usd: 5, max_cost_usd: 3, completed_successfully: true }),
      makeRecord({ actual_cost_usd: 2, max_cost_usd: 3, completed_successfully: false }),
    ],
    { measurementPolicy: 'challenge_prospective' },
  );

  assert.equal(result.workflow_success_rate_under_budget, 0.333333);
  assert.equal(result.wavemill_router_diagnostics.budget_compliance_rate, 0.666667);
  assert.equal(result.wavemill_router_diagnostics.completion_success_rate, 0.666667);
  assert.equal(
    result.wavemill_router_scoring.measurement_policy,
    'challenge_prospective',
  );
});

test('counts interventions and computes intervention rate from scoreable rows', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [
      makeRecord({ intervention_count: 2 }),
      makeRecord({ intervention_count: 0 }),
      makeRecord({ intervention_count: 1 }),
    ],
    { measurementPolicy: 'replay_exact_match' },
  );

  assert.equal(result.wavemill_router_diagnostics.intervention_count, 3);
  assert.equal(result.wavemill_router_diagnostics.intervention_rate, 0.666667);
});

test('excludes invalid routes from scoreable denominator and includes them in coverage metrics', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [
      makeRecord(),
      makeRecord({ route_valid: false, completed_successfully: undefined }),
      makeRecord({ route_valid: false, actual_cost_usd: undefined }),
    ],
    { measurementPolicy: 'replay_exact_match' },
  );

  assert.equal(result.workflow_success_rate_under_budget, 1);
  assert.equal(result.wavemill_router_diagnostics.scoreable_coverage, 0.333333);
  assert.equal(result.wavemill_router_diagnostics.invalid_route_rate, 0.666667);
  assert.equal(result.wavemill_router_diagnostics.invalid_route_records, 2);
});

test('returns zeroed metrics for empty input', () => {
  const result = scoreWavemillSuccessRateUnderBudget([], {
    measurementPolicy: 'replay_exact_match',
  });

  assert.equal(result.workflow_success_rate_under_budget, 0);
  assert.equal(result.wavemill_router_diagnostics.scoreable_coverage, 0);
  assert.equal(result.wavemill_router_diagnostics.timing_p50_ms, 0);
  assert.equal(result.wavemill_router_diagnostics.timing_p95_ms, 0);
});

test('computes deterministic p50 and p95 timing values', () => {
  const result = scoreWavemillSuccessRateUnderBudget(
    [
      makeRecord({ timing_ms: 50 }),
      makeRecord({ timing_ms: 100 }),
      makeRecord({ timing_ms: 200 }),
      makeRecord({ timing_ms: 1000 }),
    ],
    { measurementPolicy: 'replay_exact_match' },
  );

  assert.equal(result.wavemill_router_diagnostics.timing_p50_ms, 100);
  assert.equal(result.wavemill_router_diagnostics.timing_p95_ms, 1000);
});
