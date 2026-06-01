/**
 * Build redacted Hokusai contribution rows from safe Wavemill projections.
 *
 * @module hokusai-contribution-builder
 */

import type { HokusaiTaskDescriptor } from './hokusai-schema.ts';
import {
  TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION,
  validateContributionRow,
  type SubmitDataContributionRow,
  type TechnicalTaskRouterContributionRowV1,
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
