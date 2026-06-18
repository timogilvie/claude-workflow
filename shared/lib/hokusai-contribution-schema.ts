/**
 * Validation for redacted Hokusai contribution rows.
 *
 * Queue payloads must only contain already-redacted contribution shapes.
 *
 * @module hokusai-contribution-schema
 */

import type {
  HokusaiAvailableModels,
  HokusaiTaskDescriptor,
} from './hokusai-schema.ts';

export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION = 'technical_task_router_row/v1';
export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2 = 'technical_task_router_row/v2';
export const COST_BUCKET_THRESHOLDS_USD = {
  lowUpperBound: 1,
  mediumUpperBound: 5,
} as const;
export const TIME_BUCKET_THRESHOLDS_SECONDS = {
  fastUpperBound: 300,
  mediumUpperBound: 1800,
} as const;

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

export type RoleAvailableModels = HokusaiAvailableModels;

export interface OutcomeLabels {
  budget_label: 'under_budget' | 'over_budget' | 'unknown';
  cost_label: 'free' | 'low' | 'medium' | 'high' | 'unknown';
  time_label: 'fast' | 'medium' | 'slow' | 'unknown';
  success_label: 'success' | 'failure';
}

export interface CandidatePoolMetadata {
  scenario_id: string;
  scenario_kind: string;
  pool_size: number;
  baseline_model?: string;
}

export interface SparseCellMetadata {
  cell_id: string;
  descriptor_signature: string;
  observed_count: number;
  is_sparse: boolean;
}

export interface TechnicalTaskRouterContributionRowV2 {
  schema_version: typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2;
  task_descriptor: HokusaiTaskDescriptor;
  allowed_models: string[];
  selected_models: TechnicalTaskRouterSelectedModels;
  available_models: RoleAvailableModels;
  budget_usd?: number;
  actual_cost_usd?: number | null;
  wall_clock_seconds?: number;
  success_under_budget: boolean;
  completion_result: 'success' | 'failure';
  outcome_labels: OutcomeLabels;
  candidate_pool: CandidatePoolMetadata;
  sparse_cell: SparseCellMetadata;
  scorer_ref?: string;
  observed_at: string;
  task_id?: string;
  harness?: string;
}

export type ContributionRow =
  | SubmitDataContributionRow
  | TechnicalTaskRouterContributionRowV1
  | TechnicalTaskRouterContributionRowV2;

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

function hasOnlyAllowedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isTechnicalTaskRouterSelectedModels(value: unknown): value is TechnicalTaskRouterSelectedModels {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, ['planner', 'coder', 'reviewer'])) {
    return false;
  }

  if (typeof value.coder !== 'string' || typeof value.reviewer !== 'string') {
    return false;
  }

  return value.planner === undefined || typeof value.planner === 'string';
}

function isRoleAvailableModels(value: unknown): value is RoleAvailableModels {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, ['planner_models', 'coder_models', 'reviewer_models'])) {
    return false;
  }

  return (
    isStringArray(value.planner_models)
    && isStringArray(value.coder_models)
    && isStringArray(value.reviewer_models)
  );
}

function isOutcomeLabels(value: unknown): value is OutcomeLabels {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, ['budget_label', 'cost_label', 'time_label', 'success_label'])) {
    return false;
  }

  return (
    (value.budget_label === 'under_budget' || value.budget_label === 'over_budget' || value.budget_label === 'unknown')
    && (value.cost_label === 'free' || value.cost_label === 'low' || value.cost_label === 'medium' || value.cost_label === 'high' || value.cost_label === 'unknown')
    && (value.time_label === 'fast' || value.time_label === 'medium' || value.time_label === 'slow' || value.time_label === 'unknown')
    && (value.success_label === 'success' || value.success_label === 'failure')
  );
}

function isCandidatePoolMetadata(value: unknown): value is CandidatePoolMetadata {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, ['scenario_id', 'scenario_kind', 'pool_size', 'baseline_model'])) {
    return false;
  }

  return (
    typeof value.scenario_id === 'string'
    && typeof value.scenario_kind === 'string'
    && isFiniteNonNegativeNumber(value.pool_size)
    && (value.baseline_model === undefined || typeof value.baseline_model === 'string')
  );
}

function isSparseCellMetadata(value: unknown): value is SparseCellMetadata {
  if (!isPlainObject(value)) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, ['cell_id', 'descriptor_signature', 'observed_count', 'is_sparse'])) {
    return false;
  }

  return (
    typeof value.cell_id === 'string'
    && typeof value.descriptor_signature === 'string'
    && isFiniteNonNegativeNumber(value.observed_count)
    && typeof value.is_sparse === 'boolean'
  );
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

  if (!hasOnlyAllowedKeys(value, ['success_under_budget', 'inputs', 'actual_cost_usd', 'wall_clock_seconds', 'task_id', 'harness'])) {
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

function isTechnicalTaskRouterContributionRowV1(value: unknown): value is TechnicalTaskRouterContributionRowV1 {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, [
    'schema_version',
    'task_descriptor',
    'allowed_models',
    'selected_models',
    'budget_usd',
    'actual_cost_usd',
    'wall_clock_seconds',
    'success_under_budget',
    'completion_result',
    'scorer_ref',
    'observed_at',
    'task_id',
    'harness',
    'candidate_pools',
    'current_candidate_pools',
    'audit_metadata',
    'scenario',
    'scenarios',
  ])) {
    return false;
  }

  if (!isPlainObject(value.task_descriptor)) {
    return false;
  }

  if (!isStringArray(value.allowed_models)) {
    return false;
  }

  if (!isTechnicalTaskRouterSelectedModels(value.selected_models)) {
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

export function isTechnicalTaskRouterContributionRowV2(
  value: unknown,
): value is TechnicalTaskRouterContributionRowV2 {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2) {
    return false;
  }

  if (!hasOnlyAllowedKeys(value, [
    'schema_version',
    'task_descriptor',
    'allowed_models',
    'selected_models',
    'available_models',
    'budget_usd',
    'actual_cost_usd',
    'wall_clock_seconds',
    'success_under_budget',
    'completion_result',
    'outcome_labels',
    'candidate_pool',
    'sparse_cell',
    'scorer_ref',
    'observed_at',
    'task_id',
    'harness',
    'candidate_pools',
    'current_candidate_pools',
    'audit_metadata',
    'scenario',
    'scenarios',
  ])) {
    return false;
  }

  if (!isPlainObject(value.task_descriptor)) {
    return false;
  }

  if (!isStringArray(value.allowed_models)) {
    return false;
  }

  if (!isTechnicalTaskRouterSelectedModels(value.selected_models)) {
    return false;
  }

  if (!isRoleAvailableModels(value.available_models)) {
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

  if (!isOutcomeLabels(value.outcome_labels)) {
    return false;
  }

  if (!isCandidatePoolMetadata(value.candidate_pool)) {
    return false;
  }

  if (!isSparseCellMetadata(value.sparse_cell)) {
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

  if (isTechnicalTaskRouterContributionRowV1(row) || isTechnicalTaskRouterContributionRowV2(row) || isSubmitDataContributionRow(row)) {
    return row;
  }

  throw new ContributionValidationError(
    'schema_validation_failed',
    'Contribution row does not match a supported redacted schema',
  );
}
