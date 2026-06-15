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

export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1 = 'technical_task_router_row/v1';
export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2 = 'technical_task_router_row/v2';

// Backward compatibility alias
export const TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION = TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1;

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
  schema_version: typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1;
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

export type BenchmarkScenario =
  | 'production_pool'
  | 'challenger_present'
  | 'dominant_model_removed'
  | 'low_budget'
  | 'sparse_cell';

export type RoutingObjective = 'lowest_cost' | 'fastest_completion' | 'highest_reliability';

export interface SelectedStrategy {
  planner_model?: string;
  coder_model?: string;
  reviewer_model?: string;
  routing_objective?: RoutingObjective;
}

export interface TechnicalTaskRouterContributionRowV2 {
  schema_version: typeof TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2;
  row_id: string;
  benchmark_spec_id: typeof TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2;
  eval_id: string;
  model_id: string;
  scenario: BenchmarkScenario;
  candidate_pool_id: string;
  task_descriptor: HokusaiTaskDescriptor;
  allowed_models: string[];
  selected_models: string[];
  selected_strategy?: SelectedStrategy;
  max_cost_usd: number;
  actual_cost_usd: number;
  estimated_cost_usd?: number;
  actual_time_seconds?: number | null;
  estimated_duration_seconds?: number | null;
  estimated_success_under_budget?: number;
  completed_successfully: boolean;
  scorer_ref: typeof TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2;
  observed_at: string;
  metadata?: Record<string, unknown>;
  neighbor_provenance?: Array<{
    row_id: string;
    submission_id: string;
    wallet: string | null;
    training_row_index: number;
    distance: number;
    weight: number;
  }>;
}

export const TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2 = 'technical_task_router.benchmark_score/v2';

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

function isTechnicalTaskRouterContributionRowV1(value: unknown): value is TechnicalTaskRouterContributionRowV1 {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V1) {
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

function isTechnicalTaskRouterContributionRowV2(value: unknown): value is TechnicalTaskRouterContributionRowV2 {
  if (!isPlainObject(value)) {
    return false;
  }

  if (value.schema_version !== TECHNICAL_TASK_ROUTER_ROW_SCHEMA_VERSION_V2) {
    return false;
  }

  if (typeof value.row_id !== 'string' || value.row_id.length === 0) {
    return false;
  }

  if (value.benchmark_spec_id !== TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2) {
    return false;
  }

  if (typeof value.eval_id !== 'string' || value.eval_id.length === 0) {
    return false;
  }

  if (typeof value.model_id !== 'string' || value.model_id.length === 0) {
    return false;
  }

  if (!Array.isArray(value.scenario) && !['production_pool', 'challenger_present', 'dominant_model_removed', 'low_budget', 'sparse_cell'].includes(value.scenario)) {
    return false;
  }

  if (typeof value.candidate_pool_id !== 'string' || value.candidate_pool_id.length === 0) {
    return false;
  }

  if (!isPlainObject(value.task_descriptor)) {
    return false;
  }

  if (!Array.isArray(value.allowed_models) || value.allowed_models.length === 0) {
    return false;
  }

  if (value.allowed_models.some((m) => typeof m !== 'string' || m.length === 0)) {
    return false;
  }

  const uniqueAllowedModels = new Set(value.allowed_models);
  if (uniqueAllowedModels.size !== value.allowed_models.length) {
    return false;
  }

  if (!Array.isArray(value.selected_models)) {
    return false;
  }

  if (value.selected_models.some((m) => typeof m !== 'string' || m.length === 0)) {
    return false;
  }

  if (typeof value.max_cost_usd !== 'number' || !Number.isFinite(value.max_cost_usd) || value.max_cost_usd <= 0) {
    return false;
  }

  if (typeof value.actual_cost_usd !== 'number' || !Number.isFinite(value.actual_cost_usd) || value.actual_cost_usd < 0) {
    return false;
  }

  if (value.estimated_cost_usd !== undefined && !isFiniteNonNegativeNumber(value.estimated_cost_usd)) {
    return false;
  }

  if (value.actual_time_seconds !== undefined && value.actual_time_seconds !== null && !isFiniteNonNegativeNumber(value.actual_time_seconds)) {
    return false;
  }

  if (value.estimated_duration_seconds !== undefined && value.estimated_duration_seconds !== null && !isFiniteNonNegativeNumber(value.estimated_duration_seconds)) {
    return false;
  }

  if (value.estimated_success_under_budget !== undefined) {
    const val = value.estimated_success_under_budget;
    if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 1) {
      return false;
    }
  }

  if (typeof value.completed_successfully !== 'boolean') {
    return false;
  }

  if (value.scorer_ref !== TECHNICAL_TASK_ROUTER_BENCHMARK_SPEC_ID_V2) {
    return false;
  }

  if (!isIsoDateString(value.observed_at)) {
    return false;
  }

  if (value.selected_strategy !== undefined) {
    if (!isPlainObject(value.selected_strategy)) {
      return false;
    }

    const objKeys = Object.keys(value.selected_strategy);
    for (const key of objKeys) {
      if (!['planner_model', 'coder_model', 'reviewer_model', 'routing_objective'].includes(key)) {
        return false;
      }
    }

    if (value.selected_strategy.planner_model !== undefined && typeof value.selected_strategy.planner_model !== 'string') {
      return false;
    }
    if (value.selected_strategy.coder_model !== undefined && typeof value.selected_strategy.coder_model !== 'string') {
      return false;
    }
    if (value.selected_strategy.reviewer_model !== undefined && typeof value.selected_strategy.reviewer_model !== 'string') {
      return false;
    }

    if (value.selected_strategy.routing_objective !== undefined) {
      const ro = value.selected_strategy.routing_objective;
      if (!['lowest_cost', 'fastest_completion', 'highest_reliability'].includes(ro)) {
        return false;
      }
    }
  }

  if (value.metadata !== undefined && !isPlainObject(value.metadata)) {
    return false;
  }

  if (value.neighbor_provenance !== undefined) {
    if (!Array.isArray(value.neighbor_provenance)) {
      return false;
    }
    for (const entry of value.neighbor_provenance) {
      if (!isPlainObject(entry)) {
        return false;
      }
      if (typeof entry.row_id !== 'string' || entry.row_id.length === 0) {
        return false;
      }
      if (typeof entry.submission_id !== 'string' || entry.submission_id.length === 0) {
        return false;
      }
      if (entry.wallet !== null && typeof entry.wallet !== 'string') {
        return false;
      }
      if (typeof entry.training_row_index !== 'number' || !Number.isInteger(entry.training_row_index) || entry.training_row_index < 0) {
        return false;
      }
      if (!isFiniteNonNegativeNumber(entry.distance)) {
        return false;
      }
      if (!isFiniteNonNegativeNumber(entry.weight)) {
        return false;
      }
    }
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
