import type {
  WavemillRouterDiagnostics,
  WavemillRouterMeasurementPolicy,
  WavemillRouterScoringMetadata,
} from '../../../../shared/lib/eval-schema.ts';

export const WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID =
  'hokusai.scorers.wavemill.success_rate_under_budget:v1';

export interface WavemillRouterScoreRecord {
  issueId?: string;
  joinKey?: string;
  route_valid: boolean;
  completed_successfully?: boolean;
  actual_cost_usd?: number;
  max_cost_usd?: number;
  timing_ms?: number;
  intervention_count?: number;
}

export interface WavemillRouterScoreResult {
  workflow_success_rate_under_budget: number;
  wavemill_router_diagnostics: WavemillRouterDiagnostics;
  wavemill_router_scoring: WavemillRouterScoringMetadata;
}

export interface ScoreWavemillSuccessRateUnderBudgetOptions {
  measurementPolicy: WavemillRouterMeasurementPolicy;
}

function roundMetric(value: number): number {
  return Number(value.toFixed(6));
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? roundMetric(numerator / denominator) : 0;
}

function percentile(sortedValues: number[], percentileRank: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sortedValues.length) - 1),
  );
  return sortedValues[index] ?? 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isScoreable(record: WavemillRouterScoreRecord): boolean {
  return record.route_valid
    && typeof record.completed_successfully === 'boolean'
    && isFiniteNonNegativeNumber(record.actual_cost_usd)
    && isFiniteNonNegativeNumber(record.max_cost_usd);
}

export function scoreWavemillSuccessRateUnderBudget(
  records: WavemillRouterScoreRecord[],
  options: ScoreWavemillSuccessRateUnderBudgetOptions,
): WavemillRouterScoreResult {
  const totalRecords = records.length;
  const invalidRouteRecords = records.filter((record) => !record.route_valid).length;
  const scoreableRecords = records.filter(isScoreable);

  let successUnderBudgetCount = 0;
  let budgetCompliantCount = 0;
  let completionSuccessCount = 0;
  let interventionCount = 0;
  let interventionRecordCount = 0;
  let totalCostUsd = 0;
  const timings: number[] = [];

  for (const record of scoreableRecords) {
    const actualCost = record.actual_cost_usd as number;
    const maxCost = record.max_cost_usd as number;
    const completedSuccessfully = record.completed_successfully as boolean;
    const interventions = Math.max(0, Math.trunc(record.intervention_count ?? 0));

    if (actualCost <= maxCost) {
      budgetCompliantCount += 1;
    }
    if (completedSuccessfully) {
      completionSuccessCount += 1;
    }
    if (completedSuccessfully && actualCost <= maxCost) {
      successUnderBudgetCount += 1;
    }

    interventionCount += interventions;
    if (interventions > 0) {
      interventionRecordCount += 1;
    }

    totalCostUsd += actualCost;
    if (isFiniteNonNegativeNumber(record.timing_ms)) {
      timings.push(record.timing_ms);
    }
  }

  timings.sort((a, b) => a - b);

  return {
    workflow_success_rate_under_budget: rate(
      successUnderBudgetCount,
      scoreableRecords.length,
    ),
    wavemill_router_diagnostics: {
      scoreable_coverage: rate(scoreableRecords.length, totalRecords),
      invalid_route_rate: rate(invalidRouteRecords, totalRecords),
      budget_compliance_rate: rate(budgetCompliantCount, scoreableRecords.length),
      completion_success_rate: rate(completionSuccessCount, scoreableRecords.length),
      total_cost_usd: roundMetric(totalCostUsd),
      timing_p50_ms: percentile(timings, 50),
      timing_p95_ms: percentile(timings, 95),
      intervention_rate: rate(interventionRecordCount, scoreableRecords.length),
      intervention_count: interventionCount,
      total_records: totalRecords,
      scoreable_records: scoreableRecords.length,
      invalid_route_records: invalidRouteRecords,
    },
    wavemill_router_scoring: {
      scorer_id: WAVEMILL_SUCCESS_RATE_UNDER_BUDGET_SCORER_ID,
      measurement_policy: options.measurementPolicy,
    },
  };
}
