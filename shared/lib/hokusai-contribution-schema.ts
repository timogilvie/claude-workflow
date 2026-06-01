/**
 * Validation for redacted Hokusai contribution rows.
 *
 * Queue payloads must only contain already-redacted contribution shapes.
 *
 * @module hokusai-contribution-schema
 */

import type {
  HokusaiTaskDescriptor,
} from './hokusai-schema.ts';

export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION = 'technical_task_router_row/v1';

const FORBIDDEN_KEYS = new Set([
  'prompt',
  'messages',
  'task_text',
  'raw_input',
  'eval_record',
  'originalprompt',
  'original_prompt',
  'description',
  'issue_body',
]);

export interface SubmitDataContributionRow {
  success_under_budget: boolean;
  inputs?: Record<string, ContributionScalar | ContributionScalar[] | Record<string, ContributionScalar>>;
  actual_cost_usd?: number | null;
  wall_clock_seconds?: number;
  task_id?: string;
  harness?: string;
}

export interface TechnicalTaskRouterSelectedModels {
  planner?: string;
  coder: string;
  reviewer: string;
}

export interface TechnicalTaskRouterContributionRowV1 {
  schema_version: typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION;
  task_descriptor: HokusaiTaskDescriptor;
  allowed_models: string[];
  selected_models: TechnicalTaskRouterSelectedModels;
  budget_usd?: number;
  actual_cost_usd?: number | null;
  wall_clock_seconds?: number;
  success_under_budget: boolean;
  completion_result: 'success' | 'failure';
  scorer_ref?: string;
  observed_at: string;
  task_id?: string;
  harness?: string;
}

export type ContributionRow =
  | SubmitDataContributionRow
  | TechnicalTaskRouterContributionRowV1;

type ContributionScalar = string | number | boolean | null;

export class ContributionValidationError extends Error {
  code: 'schema_validation_failed' | 'forbidden_field';

  constructor(code: 'schema_validation_failed' | 'forbidden_field', message: string) {
    super(message);
    this.name = 'ContributionValidationError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isIsoDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertNoForbiddenKeys(value: unknown, path: string[] = []): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      assertNoForbiddenKeys(item, [...path, String(index)]);
    }
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (FORBIDDEN_KEYS.has(normalizedKey)) {
      throw new ContributionValidationError(
        'forbidden_field',
        `Forbidden field at ${[...path, key].join('.')}`,
      );
    }
    assertNoForbiddenKeys(child, [...path, key]);
  }
}

function isSubmitDataContributionRow(value: unknown): value is SubmitDataContributionRow {
  if (!isPlainObject(value)) {
    return false;
  }

  if (typeof value.success_under_budget !== 'boolean') {
    return false;
  }

  if (value.inputs !== undefined && !isPlainObject(value.inputs)) {
    return false;
  }

  if (
    value.actual_cost_usd !== undefined
    && value.actual_cost_usd !== null
    && !isFiniteNonNegativeNumber(value.actual_cost_usd)
  ) {
    return false;
  }

  if (value.wall_clock_seconds !== undefined && !isFiniteNonNegativeNumber(value.wall_clock_seconds)) {
    return false;
  }

  if (value.task_id !== undefined && typeof value.task_id !== 'string') {
    return false;
  }

  if (value.harness !== undefined && typeof value.harness !== 'string') {
    return false;
  }

  return !('schema_version' in value);
}

function isTechnicalTaskRouterContributionRow(value: unknown): value is TechnicalTaskRouterContributionRowV1 {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION) {
    return false;
  }

  if (!isPlainObject(value.task_descriptor)) {
    return false;
  }

  if (!Array.isArray(value.allowed_models) || value.allowed_models.some((entry) => typeof entry !== 'string')) {
    return false;
  }

  if (!isPlainObject(value.selected_models)) {
    return false;
  }

  if (typeof value.selected_models.coder !== 'string' || typeof value.selected_models.reviewer !== 'string') {
    return false;
  }

  if (
    value.selected_models.planner !== undefined
    && typeof value.selected_models.planner !== 'string'
  ) {
    return false;
  }

  if (value.budget_usd !== undefined && !isFiniteNonNegativeNumber(value.budget_usd)) {
    return false;
  }

  if (
    value.actual_cost_usd !== undefined
    && value.actual_cost_usd !== null
    && !isFiniteNonNegativeNumber(value.actual_cost_usd)
  ) {
    return false;
  }

  if (value.wall_clock_seconds !== undefined && !isFiniteNonNegativeNumber(value.wall_clock_seconds)) {
    return false;
  }

  if (typeof value.success_under_budget !== 'boolean') {
    return false;
  }

  if (value.completion_result !== 'success' && value.completion_result !== 'failure') {
    return false;
  }

  if (!isIsoDateString(value.observed_at)) {
    return false;
  }

  if (value.scorer_ref !== undefined && typeof value.scorer_ref !== 'string') {
    return false;
  }

  if (value.task_id !== undefined && typeof value.task_id !== 'string') {
    return false;
  }

  if (value.harness !== undefined && typeof value.harness !== 'string') {
    return false;
  }

  return true;
}

export function validateContributionRow(row: unknown): ContributionRow {
  assertNoForbiddenKeys(row);

  if (isTechnicalTaskRouterContributionRow(row) || isSubmitDataContributionRow(row)) {
    return row;
  }

  throw new ContributionValidationError(
    'schema_validation_failed',
    'Contribution row does not match a supported redacted schema',
  );
}
