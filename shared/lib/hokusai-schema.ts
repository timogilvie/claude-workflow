/**
 * Hokusai model input and output schema adapters.
 *
 * Maps wavemill task descriptors plus repo metadata into the structured
 * Hokusai input shape expected by downstream model selection logic,
 * and converts Hokusai output back to WorkflowRouteDecision.
 *
 * @module hokusai-schema
 */

import type { EvalRecord, RepoContext, RoutingCandidate, TaskDescriptor } from './eval-schema.ts';

// ============================================================================
// Input Schema Types
// ============================================================================

export type HokusaiTaskType =
  | 'bugfix'
  | 'feature'
  | 'refactor'
  | 'infra'
  | 'tests'
  | 'migration'
  | 'docs'
  | 'unknown';

export type HokusaiLanguage =
  | 'python'
  | 'typescript'
  | 'javascript'
  | 'go'
  | 'rust'
  | 'java'
  | 'bash'
  | 'multi'
  | 'unknown';

export type HokusaiDomain =
  | 'backend'
  | 'frontend'
  | 'fullstack'
  | 'devops'
  | 'data'
  | 'ml'
  | 'mobile'
  | 'unknown';

export type HokusaiRepoSizeBucket = 'small' | 'medium' | 'large' | 'xlarge';
export type HokusaiFilesTouchedBucket = '1' | '2_5' | '6_15' | '16_plus';
export type HokusaiDescriptionLengthBucket = 'short' | 'medium' | 'long';
export type HokusaiRiskLevel = 'low' | 'medium' | 'high';

export interface HokusaiTaskDescriptor {
  task_type: HokusaiTaskType;
  language: HokusaiLanguage;
  domain: HokusaiDomain;
  complexity: number;
  repo_size_bucket: HokusaiRepoSizeBucket;
  files_touched_bucket: HokusaiFilesTouchedBucket;
  description_length_bucket: HokusaiDescriptionLengthBucket;
  is_greenfield: boolean;
  is_migration: boolean;
  requires_tests: boolean;
  cross_service: boolean;
  ui_heavy: boolean;
  risk_level: HokusaiRiskLevel;
}

export interface HokusaiConstraints {
  max_cost_usd: number;
}

export interface HokusaiAvailableModels {
  planner_models: string[];
  coder_models: string[];
  reviewer_models: string[];
}

export interface HokusaiInput {
  schema_version: string;
  task_id: string;
  task_descriptor: HokusaiTaskDescriptor;
  constraints: HokusaiConstraints;
  available_models: HokusaiAvailableModels;
}

export interface HokusaiBooleanFlags {
  is_greenfield: boolean;
  is_migration: boolean;
  requires_tests: boolean;
  cross_service: boolean;
  ui_heavy: boolean;
}

export interface HokusaiInputOverrides {
  maxCostUsd?: number;
  max_cost_usd?: number;
  modelsAvailable?: string[];
  availableModels?: string[];
  plannerModels?: string[];
  coderModels?: string[];
  reviewerModels?: string[];
}

// ============================================================================
// Output Schema Types
// ============================================================================

export type HokusaiPlanDepth = 'low' | 'medium' | 'high';
export type HokusaiCodeDepth = 'low' | 'medium' | 'high';
export type HokusaiReviewMode = 'light' | 'standard' | 'deep';

export interface HokusaiRoute {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
  plan_depth: HokusaiPlanDepth;
  code_depth: HokusaiCodeDepth;
  review_mode: HokusaiReviewMode;
}

export interface HokusaiPredictions {
  expected_success_probability: number;
  expected_cost_usd: number;
  confidence: number;
}

export interface HokusaiOutput {
  schema_version: string;
  route: HokusaiRoute;
  predictions: HokusaiPredictions;
}

// ============================================================================
// Submission Schema Types
// ============================================================================

export interface HokusaiSubmissionConstraints {
  max_cost_usd: number | null;
}

export interface HokusaiRouteTaken {
  planner_model: string;
  coder_model: string;
  reviewer_model: string;
}

export interface HokusaiObservedOutcomes {
  completed_successfully: boolean;
  actual_cost_usd: number;
  actual_time_seconds: number;
  intervention_count: number;
}

export interface HokusaiSubmission {
  run_id: string;
  task_id: string;
  constraints: HokusaiSubmissionConstraints;
  route_taken: HokusaiRouteTaken;
  observed_outcomes: HokusaiObservedOutcomes;
}

// ============================================================================
// Input Schema Adapters
// ============================================================================

const COMPLEXITY_MAP: Record<number, number> = {
  1: 1,
  2: 3,
  3: 5,
  4: 7,
  5: 9,
};

const HIGH_RISK_FLAGS = new Set([
  'schema-migration',
  'modifies-existing-runtime',
  'cross-service',
  'large-scope-refactor',
]);

const MEDIUM_RISK_FLAGS = new Set([
  'rsc-serialization',
  'test-infrastructure',
]);

function normalizeLanguageValue(language: string | undefined): HokusaiLanguage | 'unknown-language' {
  const lower = (language || '').trim().toLowerCase();

  if (lower === 'python' || lower === 'py') return 'python';
  if (lower === 'typescript' || lower === 'ts' || lower === 'tsx') return 'typescript';
  if (lower === 'javascript' || lower === 'js' || lower === 'jsx') return 'javascript';
  if (lower === 'go' || lower === 'golang') return 'go';
  if (lower === 'rust' || lower === 'rs') return 'rust';
  if (lower === 'java') return 'java';
  if (lower === 'bash' || lower === 'sh' || lower === 'shell' || lower === 'zsh') return 'bash';

  return lower.length > 0 ? 'unknown-language' : 'unknown';
}

/**
 * Maps wavemill complexity (1-5) to Hokusai complexity score (1-10 scale).
 *
 * @param complexity - Wavemill complexity value (1-5)
 * @returns Hokusai complexity score (1=xs, 3=s, 5=m, 7=l, 9=xl), defaults to 5 if invalid
 */
export function complexityToHokusaiScore(complexity: number | undefined): number {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) {
    return 5;
  }

  return COMPLEXITY_MAP[Math.round(complexity)] || 5;
}

/**
 * Maps repository lines of code to a size bucket.
 *
 * @param loc - Lines of code in the repository
 * @returns Size bucket: 'small' (<5K), 'medium' (5K-50K), 'large' (50K-500K), 'xlarge' (≥500K), defaults to 'medium' if invalid
 */
export function repoSizeToBucket(loc: number | undefined): HokusaiRepoSizeBucket {
  if (typeof loc !== 'number' || !Number.isFinite(loc) || loc < 0) {
    return 'medium';
  }

  if (loc < 5_000) return 'small';
  if (loc < 50_000) return 'medium';
  if (loc < 500_000) return 'large';
  return 'xlarge';
}

/**
 * Maps number of files touched to a bucket.
 *
 * @param count - Number of files touched in the task
 * @returns Files bucket: '1' (1 file), '2_5' (2-5 files), '6_15' (6-15 files), '16_plus' (≥16 files), defaults to '2_5' if invalid
 */
export function filesTouchedToBucket(count: number | undefined): HokusaiFilesTouchedBucket {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return '2_5';
  }

  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 15) return '6_15';
  return '16_plus';
}

/**
 * Maps task description length to a bucket.
 *
 * @param value - Either token count (number) or raw text (string, estimated as chars/4)
 * @returns Length bucket: 'short' (<50 tokens), 'medium' (50-200 tokens), 'long' (≥200 tokens), defaults to 'medium' if invalid
 */
export function descriptionLengthToBucket(
  value: number | string | undefined,
): HokusaiDescriptionLengthBucket {
  let tokenCount: number | undefined;

  if (typeof value === 'number' && Number.isFinite(value)) {
    tokenCount = value;
  } else if (typeof value === 'string') {
    tokenCount = Math.ceil(value.length / 4);
  }

  if (typeof tokenCount !== 'number' || tokenCount < 0) {
    return 'medium';
  }

  if (tokenCount < 50) return 'short';
  if (tokenCount < 200) return 'medium';
  return 'long';
}

/**
 * Determines overall risk level from risk flag array.
 *
 * @param flags - Array of risk flag strings (e.g., 'schema-migration', 'cross-service')
 * @returns Risk level: 'high' (≥2 high-risk flags), 'medium' (≥1 high-risk or ≥2 medium-risk flags), 'low' (default)
 */
export function riskFlagsToLevel(flags: string[] | undefined): HokusaiRiskLevel {
  if (!Array.isArray(flags) || flags.length === 0) {
    return 'low';
  }

  let highCount = 0;
  let mediumCount = 0;

  for (const flag of flags) {
    if (HIGH_RISK_FLAGS.has(flag)) {
      highCount += 1;
    } else if (MEDIUM_RISK_FLAGS.has(flag)) {
      mediumCount += 1;
    }
  }

  if (highCount >= 2) return 'high';
  if (highCount >= 1 || mediumCount >= 2) return 'medium';
  return 'low';
}

/**
 * Maps risk flags to boolean feature flags.
 *
 * @param flags - Array of risk flag strings
 * @returns Object with boolean flags: is_greenfield, is_migration, requires_tests, cross_service, ui_heavy
 */
export function riskFlagsToBooleans(flags: string[] | undefined): HokusaiBooleanFlags {
  const set = new Set(flags || []);

  return {
    is_greenfield: false,
    is_migration: set.has('schema-migration'),
    requires_tests: set.has('test-infrastructure'),
    cross_service: set.has('cross-service'),
    ui_heavy: set.has('rsc-serialization'),
  };
}

/**
 * Maps wavemill task type to Hokusai task type.
 *
 * @param taskType - Task type string from wavemill descriptor
 * @param options - Optional configuration, including hasMigration override
 * @returns Hokusai task type: 'bugfix', 'feature', 'refactor', 'infra', 'tests', 'migration', 'docs', or 'unknown'
 */
export function mapTaskType(
  taskType: string | undefined,
  options?: { hasMigration?: boolean },
): HokusaiTaskType {
  if (options?.hasMigration) {
    return 'migration';
  }

  switch ((taskType || '').trim().toLowerCase()) {
    case 'bugfix':
      return 'bugfix';
    case 'feature':
      return 'feature';
    case 'refactor':
      return 'refactor';
    case 'infra':
      return 'infra';
    case 'docs':
      return 'docs';
    case 'test':
    case 'tests':
      return 'tests';
    default:
      return 'unknown';
  }
}

/**
 * Maps wavemill domain to Hokusai domain.
 *
 * @param domain - Domain string from wavemill descriptor
 * @returns Hokusai domain: 'backend', 'frontend', 'fullstack', 'devops', 'data', 'ml', 'mobile', or 'unknown'
 */
export function mapDomain(domain: string | undefined): HokusaiDomain {
  switch ((domain || '').trim().toLowerCase()) {
    case 'backend':
      return 'backend';
    case 'frontend':
      return 'frontend';
    case 'full-stack':
    case 'fullstack':
      return 'fullstack';
    case 'infrastructure':
    case 'devtools':
    case 'devops':
      return 'devops';
    case 'data-pipeline':
    case 'data':
      return 'data';
    case 'ml':
      return 'ml';
    case 'mobile':
      return 'mobile';
    default:
      return 'unknown';
  }
}

/**
 * Maps language array to Hokusai language (with multi-language detection).
 *
 * @param languages - Array of language strings from wavemill descriptor
 * @param primaryLanguage - Optional primary language fallback from repo context
 * @returns Hokusai language: specific language name, 'multi' (if >1 language), or 'unknown'
 */
export function mapLanguage(languages: string[] | undefined, primaryLanguage?: string): HokusaiLanguage {
  const normalized = new Set<HokusaiLanguage>();

  for (const language of languages || []) {
    const mapped = normalizeLanguageValue(language);
    if (mapped !== 'unknown-language' && mapped !== 'unknown') {
      normalized.add(mapped);
    }
  }

  if (normalized.size > 1) {
    return 'multi';
  }

  if (normalized.size === 1) {
    return [...normalized][0];
  }

  const primary = normalizeLanguageValue(primaryLanguage);
  if (primary !== 'unknown-language') {
    return primary;
  }

  return 'unknown';
}

function pickAvailableModels(
  descriptor: Partial<TaskDescriptor> | undefined,
  overrides?: HokusaiInputOverrides,
): HokusaiAvailableModels {
  const sharedModels =
    overrides?.availableModels
    || overrides?.modelsAvailable
    || descriptor?.constraints?.models_available
    || [];

  return {
    planner_models: overrides?.plannerModels || sharedModels,
    coder_models: overrides?.coderModels || sharedModels,
    reviewer_models: overrides?.reviewerModels || sharedModels,
  };
}

/**
 * Converts wavemill TaskDescriptor + RepoContext to Hokusai model input schema.
 *
 * @param descriptor - Partial wavemill task descriptor with heuristic and learned signals
 * @param repoContext - Optional repository context (size, primary language)
 * @param overrides - Optional constraint/model overrides (max_cost_usd, available_models)
 * @param taskId - Task identifier, defaults to 'unknown'
 * @returns Complete HokusaiInput object with all required fields populated
 */
export function toHokusaiInput(
  descriptor?: Partial<TaskDescriptor>,
  repoContext?: RepoContext,
  overrides?: HokusaiInputOverrides,
  taskId = 'unknown',
): HokusaiInput {
  const heuristic = descriptor?.signals?.heuristic;
  const learned = descriptor?.signals?.learned;
  const riskBooleans = riskFlagsToBooleans(learned?.risk_flags);
  const effectiveRepoContext = repoContext;
  const isMigration = Boolean(heuristic?.has_migration ?? riskBooleans.is_migration);

  return {
    schema_version: '1.0',
    task_id: taskId,
    task_descriptor: {
      task_type: mapTaskType(heuristic?.task_type, { hasMigration: isMigration }),
      language: mapLanguage(heuristic?.languages, effectiveRepoContext?.primaryLanguage),
      domain: mapDomain(learned?.domain),
      complexity: complexityToHokusaiScore(learned?.complexity),
      repo_size_bucket: repoSizeToBucket(
        heuristic?.repo_size_loc ?? effectiveRepoContext?.repoSize?.loc,
      ),
      files_touched_bucket: filesTouchedToBucket(heuristic?.files_touched),
      description_length_bucket: descriptionLengthToBucket(heuristic?.description_tokens),
      is_greenfield: Boolean(heuristic?.is_greenfield ?? riskBooleans.is_greenfield),
      is_migration: isMigration,
      requires_tests: Boolean(heuristic?.has_tests ?? riskBooleans.requires_tests),
      cross_service: Boolean(heuristic?.cross_service ?? riskBooleans.cross_service),
      ui_heavy: Boolean(heuristic?.has_ui ?? riskBooleans.ui_heavy),
      risk_level: riskFlagsToLevel(learned?.risk_flags),
    },
    constraints: {
      max_cost_usd:
        overrides?.max_cost_usd
        ?? overrides?.maxCostUsd
        ?? descriptor?.constraints?.max_cost_usd
        ?? 0,
    },
    available_models: pickAvailableModels(descriptor, overrides),
  };
}

// ============================================================================
// Submission Schema Adapters
// ============================================================================

/**
 * Extracts route information from stages or routing decision.
 *
 * Priority: `taskDescriptor.stages` (planner/coder/reviewer) >
 *           `routingDecision.chosen` (resolve if index, use modelId for all stages) >
 *           null
 *
 * @param record - EvalRecord to extract route from
 * @returns HokusaiRouteTaken object or null if no route data available
 */
function resolveRouteTaken(record: EvalRecord): HokusaiRouteTaken | null {
  // Priority 1: Extract from taskDescriptor.stages
  if (record.taskDescriptor?.stages) {
    const stages = record.taskDescriptor.stages;
    const plannerModel = stages.planner?.model;
    const coderModel = stages.coder?.model;
    const reviewerModel = stages.reviewer?.model;

    if (plannerModel && coderModel && reviewerModel) {
      return {
        planner_model: plannerModel,
        coder_model: coderModel,
        reviewer_model: reviewerModel,
      };
    }
  }

  // Priority 2: Extract from routingDecision.chosen
  if (record.routingDecision?.chosen !== undefined) {
    let chosen: RoutingCandidate;

    if (typeof record.routingDecision.chosen === 'number') {
      // Resolve index reference to actual candidate
      const idx = record.routingDecision.chosen;
      const candidate = record.routingDecision.candidates?.[idx];
      if (!candidate) {
        return null;
      }
      chosen = candidate;
    } else {
      chosen = record.routingDecision.chosen;
    }

    if (chosen.modelId) {
      return {
        planner_model: chosen.modelId,
        coder_model: chosen.modelId,
        reviewer_model: chosen.modelId,
      };
    }
  }

  return null;
}

/**
 * Converts an EvalRecord into a Hokusai training/submission schema.
 *
 * Returns null if required fields are missing:
 * - `record.id` (run_id)
 * - `record.issueId` (task_id)
 * - `record.workflowCost` (actual_cost_usd — must not be undefined/null)
 * - Route information (stages or routingDecision)
 *
 * @param record - EvalRecord to convert
 * @returns HokusaiSubmission object or null if required fields missing
 */
export function toHokusaiSubmission(record: EvalRecord): HokusaiSubmission | null {
  // Guard: required IDs
  if (!record.id || !record.issueId) {
    return null;
  }

  // Guard: workflowCost required (not undefined/null, but 0 is valid)
  if (record.workflowCost === undefined || record.workflowCost === null) {
    return null;
  }

  // Extract route taken
  const route = resolveRouteTaken(record);
  if (!route) {
    return null;
  }

  // Determine completion status
  // Prefer outcomes.success, fallback to score > 0
  const completedSuccessfully =
    record.outcomes?.success !== undefined ? record.outcomes.success : record.score > 0;

  // Determine max_cost_usd
  // Priority: record.constraints?.maxCostUsd > record.taskDescriptor?.constraints?.max_cost_usd > null
  const maxCostUsd =
    record.constraints?.maxCostUsd
    ?? record.taskDescriptor?.constraints?.max_cost_usd
    ?? null;

  return {
    run_id: record.id,
    task_id: record.issueId,
    constraints: {
      max_cost_usd: maxCostUsd,
    },
    route_taken: route,
    observed_outcomes: {
      completed_successfully: completedSuccessfully,
      actual_cost_usd: record.workflowCost,
      actual_time_seconds: record.timeSeconds,
      intervention_count: record.interventionCount,
    },
  };
}

/**
 * Validates a HokusaiSubmission object.
 *
 * Checks all required fields and their constraints.
 *
 * @param submission - HokusaiSubmission to validate
 * @returns Object with valid flag and array of error messages (empty if valid)
 */
export function validateHokusaiSubmission(
  submission: HokusaiSubmission,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // run_id validation
  if (!submission.run_id || typeof submission.run_id !== 'string' || submission.run_id.trim() === '') {
    errors.push('run_id must be a non-empty string');
  }

  // task_id validation
  if (!submission.task_id || typeof submission.task_id !== 'string' || submission.task_id.trim() === '') {
    errors.push('task_id must be a non-empty string');
  }

  // route_taken validation
  if (!submission.route_taken?.planner_model || submission.route_taken.planner_model.trim() === '') {
    errors.push('route_taken.planner_model must be a non-empty string');
  }
  if (!submission.route_taken?.coder_model || submission.route_taken.coder_model.trim() === '') {
    errors.push('route_taken.coder_model must be a non-empty string');
  }
  if (!submission.route_taken?.reviewer_model || submission.route_taken.reviewer_model.trim() === '') {
    errors.push('route_taken.reviewer_model must be a non-empty string');
  }

  // observed_outcomes validation
  const outcomes = submission.observed_outcomes;
  if (typeof outcomes.actual_cost_usd !== 'number' || outcomes.actual_cost_usd < 0) {
    errors.push('observed_outcomes.actual_cost_usd must be a non-negative number');
  }
  if (typeof outcomes.actual_time_seconds !== 'number' || outcomes.actual_time_seconds < 0) {
    errors.push('observed_outcomes.actual_time_seconds must be a non-negative number');
  }
  if (typeof outcomes.intervention_count !== 'number' || outcomes.intervention_count < 0) {
    errors.push('observed_outcomes.intervention_count must be a non-negative number');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
