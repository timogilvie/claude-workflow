/**
 * Hokusai model input schema adapters.
 *
 * Maps wavemill task descriptors plus repo metadata into the structured
 * Hokusai input shape expected by downstream model selection logic.
 *
 * @module hokusai-schema
 */

import type { RepoContext, TaskDescriptor } from './eval-schema.ts';

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

export function complexityToHokusaiScore(complexity: number | undefined): number {
  if (typeof complexity !== 'number' || !Number.isFinite(complexity)) {
    return 5;
  }

  return COMPLEXITY_MAP[Math.round(complexity)] || 5;
}

export function repoSizeToBucket(loc: number | undefined): HokusaiRepoSizeBucket {
  if (typeof loc !== 'number' || !Number.isFinite(loc) || loc < 0) {
    return 'medium';
  }

  if (loc < 5_000) return 'small';
  if (loc < 50_000) return 'medium';
  if (loc < 500_000) return 'large';
  return 'xlarge';
}

export function filesTouchedToBucket(count: number | undefined): HokusaiFilesTouchedBucket {
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
    return '2_5';
  }

  if (count === 1) return '1';
  if (count <= 5) return '2_5';
  if (count <= 15) return '6_15';
  return '16_plus';
}

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
