/**
 * Build redacted Hokusai contribution rows from safe Wavemill projections.
 *
 * @module hokusai-contribution-builder
 */

import type { HokusaiTaskDescriptor } from './hokusai-schema.ts';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
  validateContributionRow,
  type SubmitDataContributionRow,
  type TechnicalTaskRouterContributionRowV1,
  type TechnicalTaskRouterContributionRowV2,
  type BenchmarkScenario,
  type RoutingObjective,
  type SelectedStrategy,
} from './hokusai-contribution-schema.ts';

type InputScalar = string | number | boolean | null;

export interface RedactedEvalContributionProjection {
  taskId?: string;
  runId?: string;
  harness?: string;
  observedAt: string;
  observedSuccess: boolean;
  budgetCompliant: boolean;
  actualCostUsd?: number | null;
  wallClockSeconds?: number;
  inputs?: Record<string, unknown>;
  taskDescriptor?: HokusaiTaskDescriptor;
  allowedModels?: string[];
  selectedModels?: {
    planner?: string;
    coder: string;
    reviewer: string;
  };
  budgetUsd?: number;
  scorerRef?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toCompactInputValue(value: unknown): InputScalar | InputScalar[] | Record<string, InputScalar> | undefined {
  if (value === null) {
    return null;
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    const compact = value.filter(
      (entry): entry is InputScalar =>
        entry === null
        || typeof entry === 'string'
        || typeof entry === 'number'
        || typeof entry === 'boolean',
    );
    return compact.length > 0 ? compact : undefined;
  }

  if (!isPlainObject(value)) {
    return undefined;
  }

  const compactEntries = Object.entries(value).flatMap(([key, entry]) => {
    if (
      entry === null
      || typeof entry === 'string'
      || typeof entry === 'number'
      || typeof entry === 'boolean'
    ) {
      return [[key, entry] as const];
    }
    return [];
  });

  return compactEntries.length > 0 ? Object.fromEntries(compactEntries) : undefined;
}

function toCompactInputs(inputs?: Record<string, unknown>): SubmitDataContributionRow['inputs'] {
  if (!inputs) {
    return undefined;
  }

  const compactEntries = Object.entries(inputs).flatMap(([key, value]) => {
    const compactValue = toCompactInputValue(value);
    return compactValue === undefined ? [] : [[key, compactValue] as const];
  });

  return compactEntries.length > 0 ? Object.fromEntries(compactEntries) : undefined;
}

export function buildSubmitDataContributionRow(
  projection: RedactedEvalContributionProjection,
): SubmitDataContributionRow {
  const row: SubmitDataContributionRow = {
    success_under_budget: projection.observedSuccess && projection.budgetCompliant,
    ...(projection.actualCostUsd !== undefined
      ? { actual_cost_usd: projection.actualCostUsd }
      : {}),
    ...(projection.wallClockSeconds !== undefined
      ? { wall_clock_seconds: projection.wallClockSeconds }
      : {}),
    ...(projection.taskId ? { task_id: projection.taskId } : {}),
    ...(projection.harness ? { harness: projection.harness } : {}),
  };

  const inputs = toCompactInputs(projection.inputs);
  if (inputs) {
    row.inputs = inputs;
  }

  return validateContributionRow(row) as SubmitDataContributionRow;
}

export function buildTechnicalTaskRouterContributionRow(
  projection: RedactedEvalContributionProjection,
): TechnicalTaskRouterContributionRowV1 {
  if (!projection.taskDescriptor || !projection.allowedModels || !projection.selectedModels) {
    throw new Error('taskDescriptor, allowedModels, and selectedModels are required');
  }

  const row: TechnicalTaskRouterContributionRowV1 = {
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1,
    task_descriptor: projection.taskDescriptor,
    allowed_models: [...projection.allowedModels],
    selected_models: { ...projection.selectedModels },
    success_under_budget: projection.observedSuccess && projection.budgetCompliant,
    completion_result: projection.observedSuccess ? 'success' : 'failure',
    observed_at: projection.observedAt,
    ...(projection.budgetUsd !== undefined ? { budget_usd: projection.budgetUsd } : {}),
    ...(projection.actualCostUsd !== undefined
      ? { actual_cost_usd: projection.actualCostUsd }
      : {}),
    ...(projection.wallClockSeconds !== undefined
      ? { wall_clock_seconds: projection.wallClockSeconds }
      : {}),
    ...(projection.scorerRef ? { scorer_ref: projection.scorerRef } : {}),
    ...(projection.taskId ? { task_id: projection.taskId } : {}),
    ...(projection.harness ? { harness: projection.harness } : {}),
  };

  return validateContributionRow(row) as TechnicalTaskRouterContributionRowV1;
}

export interface TechnicalTaskRouterV2ContributionProjection {
  rowId: string;
  evalId: string;
  modelId: string;
  scenario: BenchmarkScenario;
  candidatePoolId: string;
  taskDescriptor: HokusaiTaskDescriptor;
  allowedModels: string[];
  selectedModels: string[];
  selectedStrategy?: SelectedStrategy;
  maxCostUsd: number;
  actualCostUsd: number;
  estimatedCostUsd?: number;
  actualTimeSeconds?: number | null;
  estimatedDurationSeconds?: number | null;
  estimatedSuccessUnderBudget?: number;
  completedSuccessfully: boolean;
  observedAt: string;
  availablePlannerModels?: string[];
  availableCoderModels?: string[];
  availableReviewerModels?: string[];
  metadata?: Record<string, unknown>;
}

export function buildTechnicalTaskRouterContributionRowV2(
  projection: TechnicalTaskRouterV2ContributionProjection,
): TechnicalTaskRouterContributionRowV2 {
  const deduplicatedAllowedModels = Array.from(new Set(projection.allowedModels));

  if (deduplicatedAllowedModels.length === 0) {
    throw new Error('allowedModels must be non-empty');
  }

  if (typeof projection.maxCostUsd !== 'number' || projection.maxCostUsd <= 0) {
    throw new Error('maxCostUsd must be a positive number');
  }

  if (typeof projection.actualCostUsd !== 'number' || projection.actualCostUsd < 0) {
    throw new Error('actualCostUsd must be a non-negative number');
  }

  const metadata: Record<string, unknown> = {
    ...projection.metadata,
  };

  if (projection.availablePlannerModels && projection.availablePlannerModels.length > 0) {
    metadata.available_planner_models = projection.availablePlannerModels;
  }

  if (projection.availableCoderModels && projection.availableCoderModels.length > 0) {
    metadata.available_coder_models = projection.availableCoderModels;
  }

  if (projection.availableReviewerModels && projection.availableReviewerModels.length > 0) {
    metadata.available_reviewer_models = projection.availableReviewerModels;
  }

  const row: TechnicalTaskRouterContributionRowV2 = {
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
    row_id: projection.rowId,
    benchmark_spec_id: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
    eval_id: projection.evalId,
    model_id: projection.modelId,
    scenario: projection.scenario,
    candidate_pool_id: projection.candidatePoolId,
    task_descriptor: projection.taskDescriptor,
    allowed_models: deduplicatedAllowedModels,
    selected_models: [...projection.selectedModels],
    max_cost_usd: projection.maxCostUsd,
    actual_cost_usd: projection.actualCostUsd,
    completed_successfully: projection.completedSuccessfully,
    scorer_ref: TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2,
    observed_at: projection.observedAt,
    ...(projection.selectedStrategy ? { selected_strategy: projection.selectedStrategy } : {}),
    ...(projection.estimatedCostUsd !== undefined ? { estimated_cost_usd: projection.estimatedCostUsd } : {}),
    ...(projection.actualTimeSeconds !== undefined ? { actual_time_seconds: projection.actualTimeSeconds } : {}),
    ...(projection.estimatedDurationSeconds !== undefined ? { estimated_duration_seconds: projection.estimatedDurationSeconds } : {}),
    ...(projection.estimatedSuccessUnderBudget !== undefined ? { estimated_success_under_budget: projection.estimatedSuccessUnderBudget } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };

  return validateContributionRow(row) as TechnicalTaskRouterContributionRowV2;
}
