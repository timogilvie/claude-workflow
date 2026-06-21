/**
 * Build redacted Hokusai contribution rows from safe Wavemill projections.
 *
 * @module hokusai-contribution-builder
 */

import type { HokusaiAvailableModels, HokusaiTaskDescriptor } from './hokusai-schema.ts';
import {
  COST_BUCKET_THRESHOLDS_USD,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
  TIME_BUCKET_THRESHOLDS_SECONDS,
  validateContributionRow,
  type CandidatePoolMetadata,
  type OutcomeLabels,
  type RoleAvailableModels,
  type SparseCellMetadata,
  type SubmitDataContributionRow,
  type TechnicalTaskRouterContributionRowV1,
  type TechnicalTaskRouterContributionRowV2,
} from './hokusai-contribution-schema.ts';

type InputScalar = string | number | boolean | null;

export interface FeatureOutcomeDiagnosticProjection {
  outcomeDiagnostic?: 'eligible' | 'ineligible_missing_outcome' | 'ineligible_failed_outcome' | 'unknown';
  outcomeSource?: 'feature_outcome_artifact' | 'reconstructed' | 'unknown';
  outcomeArtifactPresent?: boolean;
  outcomeArtifactValid?: boolean;
  outcomeArtifactUsed?: boolean;
  outcomeMissingFields?: string[];
  outcomeInvalidFields?: string[];
  outcomeFailureReason?: string;
}

export interface RedactedEvalContributionProjection extends FeatureOutcomeDiagnosticProjection {
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

export interface RedactedEvalContributionProjectionV2 extends RedactedEvalContributionProjection {
  availableModels?: HokusaiAvailableModels;
  candidatePool?: CandidatePoolMetadata;
  sparseCell?: SparseCellMetadata;
  outcomeLabelOverrides?: Partial<OutcomeLabels>;
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

function deriveBudgetLabel(projection: RedactedEvalContributionProjection): OutcomeLabels['budget_label'] {
  if (
    projection.budgetUsd === undefined
    || projection.actualCostUsd === undefined
    || projection.actualCostUsd === null
  ) {
    return 'unknown';
  }

  return projection.actualCostUsd <= projection.budgetUsd ? 'under_budget' : 'over_budget';
}

function deriveCostLabel(actualCostUsd?: number | null): OutcomeLabels['cost_label'] {
  if (actualCostUsd === undefined || actualCostUsd === null) {
    return 'unknown';
  }

  if (actualCostUsd === 0) {
    return 'free';
  }

  if (actualCostUsd < COST_BUCKET_THRESHOLDS_USD.lowUpperBound) {
    return 'low';
  }

  if (actualCostUsd < COST_BUCKET_THRESHOLDS_USD.mediumUpperBound) {
    return 'medium';
  }

  return 'high';
}

function deriveTimeLabel(wallClockSeconds?: number): OutcomeLabels['time_label'] {
  if (wallClockSeconds === undefined) {
    return 'unknown';
  }

  if (wallClockSeconds < TIME_BUCKET_THRESHOLDS_SECONDS.fastUpperBound) {
    return 'fast';
  }

  if (wallClockSeconds < TIME_BUCKET_THRESHOLDS_SECONDS.mediumUpperBound) {
    return 'medium';
  }

  return 'slow';
}

export function deriveOutcomeLabels(
  projection: RedactedEvalContributionProjectionV2,
): OutcomeLabels {
  const derived: OutcomeLabels = {
    budget_label: deriveBudgetLabel(projection),
    cost_label: deriveCostLabel(projection.actualCostUsd),
    time_label: deriveTimeLabel(projection.wallClockSeconds),
    success_label: projection.observedSuccess ? 'success' : 'failure',
  };

  return {
    ...derived,
    ...projection.outcomeLabelOverrides,
  };
}

function deriveAvailableModels(
  projection: RedactedEvalContributionProjectionV2,
): RoleAvailableModels {
  if (projection.availableModels) {
    return {
      planner_models: [...projection.availableModels.planner_models],
      coder_models: [...projection.availableModels.coder_models],
      reviewer_models: [...projection.availableModels.reviewer_models],
    };
  }

  const allowedModels = projection.allowedModels ? [...projection.allowedModels] : [];
  const plannerModels = projection.selectedModels?.planner ? allowedModels : [];

  return {
    planner_models: plannerModels,
    coder_models: allowedModels,
    reviewer_models: allowedModels,
  };
}

function deriveCandidatePool(
  projection: RedactedEvalContributionProjectionV2,
): CandidatePoolMetadata {
  if (projection.candidatePool) {
    return { ...projection.candidatePool };
  }

  return {
    scenario_id: 'unknown',
    scenario_kind: 'unknown',
    pool_size: projection.allowedModels?.length ?? 0,
  };
}

function deriveSparseCell(
  projection: RedactedEvalContributionProjectionV2,
): SparseCellMetadata {
  if (projection.sparseCell) {
    return { ...projection.sparseCell };
  }

  return {
    cell_id: 'unknown',
    descriptor_signature: 'unknown',
    observed_count: 0,
    is_sparse: false,
  };
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
    ...(projection.outcomeDiagnostic !== undefined
      ? { outcome_diagnostic: projection.outcomeDiagnostic }
      : {}),
    ...(projection.outcomeSource !== undefined
      ? { outcome_source: projection.outcomeSource }
      : {}),
    ...(projection.outcomeArtifactPresent !== undefined
      ? { outcome_artifact_present: projection.outcomeArtifactPresent }
      : {}),
    ...(projection.outcomeArtifactValid !== undefined
      ? { outcome_artifact_valid: projection.outcomeArtifactValid }
      : {}),
    ...(projection.outcomeArtifactUsed !== undefined
      ? { outcome_artifact_used: projection.outcomeArtifactUsed }
      : {}),
    ...(projection.outcomeMissingFields !== undefined
      ? { outcome_missing_fields: projection.outcomeMissingFields }
      : {}),
    ...(projection.outcomeInvalidFields !== undefined
      ? { outcome_invalid_fields: projection.outcomeInvalidFields }
      : {}),
    ...(projection.outcomeFailureReason !== undefined
      ? { outcome_failure_reason: projection.outcomeFailureReason }
      : {}),
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
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
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

export function buildTechnicalTaskRouterContributionRowV2(
  projection: RedactedEvalContributionProjectionV2,
): TechnicalTaskRouterContributionRowV2 {
  if (!projection.taskDescriptor || !projection.allowedModels || !projection.selectedModels) {
    throw new Error('taskDescriptor, allowedModels, and selectedModels are required');
  }

  const row: TechnicalTaskRouterContributionRowV2 = {
    schema_version: TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2,
    task_descriptor: projection.taskDescriptor,
    allowed_models: [...projection.allowedModels],
    selected_models: { ...projection.selectedModels },
    available_models: deriveAvailableModels(projection),
    success_under_budget: projection.observedSuccess && projection.budgetCompliant,
    completion_result: projection.observedSuccess ? 'success' : 'failure',
    outcome_labels: deriveOutcomeLabels(projection),
    candidate_pool: deriveCandidatePool(projection),
    sparse_cell: deriveSparseCell(projection),
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

  return validateContributionRow(row) as TechnicalTaskRouterContributionRowV2;
}
