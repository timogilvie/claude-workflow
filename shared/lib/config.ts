/**
 * Centralized config loader for .wavemill-config.json
 *
 * Provides:
 * - Singleton caching (one load per repo directory per process)
 * - JSON schema validation using Ajv
 * - TypeScript types matching the schema
 * - Typed accessor functions for common config sections
 *
 * @module config
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { errorMessage } from './error-utils.ts';
import type { RegistryTaskType } from './model-registry.ts';

// ────────────────────────────────────────────────────────────────
// TypeScript Types (matching wavemill-config.schema.json)
// ────────────────────────────────────────────────────────────────

/**
 * Current config format version.
 * Increment when making breaking changes to config structure.
 */
export const CURRENT_CONFIG_VERSION = '1.3.0';

export interface MillConfig {
  session?: string;
  maxParallel?: number;
  pollSeconds?: number;
  baseBranch?: string;
  worktreeRoot?: string;
  agentCmd?: string;
  requireConfirm?: boolean;
  planningMode?: 'skip' | 'interactive';
  maxRetries?: number;
  retryDelay?: number;
  setupCommand?: string;
  defaultMaxCostUsd?: number;
}

export interface ExpandConfig {
  maxSelect?: number;
  maxDisplay?: number;
}

export interface PlanConfig {
  maxDisplay?: number;
  research?: boolean;
  model?: string;
  interactive?: boolean;
  timeout?: number;
}

export interface DashboardConfig {
  verbosity?: 'error' | 'status' | 'info' | 'debug';
  logToFile?: boolean;
}

export interface JudgeConfig {
  model?: string;
  provider?: 'anthropic';
}

export interface PricingEntry {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  cacheWriteCostPerMTok?: number;
  cacheReadCostPerMTok?: number;
}

export interface HokusaiRouterConfig {
  endpoint?: string;
  apiKey?: string;
  timeout?: number;
}

export interface HokusaiDataSubmissionConfig {
  enabled?: boolean;
  consentVersion?: string;
  endpoint?: string;
}

export interface HokusaiConfig {
  dataSubmission?: HokusaiDataSubmissionConfig;
}

export interface AvailableModelsConfig {
  planner?: string[];
  coder?: string[];
  reviewer?: string[];
}

export type ModelRegistryClass = 'frontier' | 'strong_generalist' | 'fast_economy';

export interface ModelCapabilitiesOverride {
  vendor?: string;
  class?: ModelRegistryClass;
  strengths?: string[];
  weaknesses?: string[];
  qualityScores?: Partial<Record<RegistryTaskType, number>>;
}

export interface ModelRegistryConfig {
  models?: Record<string, ModelCapabilitiesOverride>;
  ladders?: Partial<Record<RegistryTaskType, string[]>>;
}

export interface AggregationConfig {
  repos?: string[];
  outputPath?: string;
}

export interface InterventionPenaltiesConfig {
  reviewComment?: number;
  postPrCommit?: number;
  manualEdit?: number;
  testFix?: number;
  sessionRedirect?: number;
}

export interface EvalConfig {
  aggregation?: AggregationConfig;
  evalsDir?: string;
  judge?: JudgeConfig;
  pricing?: Record<string, PricingEntry>;
  interventionPenalties?: InterventionPenaltiesConfig;
}

export interface DifficultyClassifierConfig {
  enabled?: boolean;
  classifierModel?: string;
  cacheTtlDays?: number;
  skipLlm?: boolean;
}

export interface RouterConfig {
  enabled?: boolean;
  defaultModel?: string;
  minRecords?: number;
  minModels?: number;
  models?: string[];
  availableModels?: AvailableModelsConfig;
  defaultAgent?: string;
  agentMap?: Record<string, string>;
  mode?: 'heuristic' | 'llm' | 'auto' | 'stage-aware' | 'hokusai';
  llmModel?: string;
  llmProvider?: 'openai' | 'anthropic';
  kNeighbors?: number;
  backfilledEvalsPath?: string;
  stageBlendWeight?: number;
  hokusai?: HokusaiRouterConfig;
  difficulty?: DifficultyClassifierConfig;
}

export interface ChallengeConfig {
  enabled?: boolean;
  rate?: number;
  models?: string[] | null;
  comparisonModel?: string;
  autoMergeWinner?: boolean;
}

export interface ChallengeSchedulerConfig {
  enabled?: boolean;
  confidenceThreshold?: number;
  newModelChallengeCount?: number;
  minEvalRecordsPerStage?: number;
  maxConcurrentChallenges?: number;
}

export interface ValidationLayerConfig {
  enabled?: boolean;
}

export interface ValidationLayer2Config extends ValidationLayerConfig {
  model?: string;
  provider?: 'claude-cli' | 'anthropic';
}

export interface ValidationConfig {
  enabled?: boolean;
  layer1?: ValidationLayerConfig;
  layer2?: ValidationLayer2Config;
  onFailure?: 'conservative' | 'auto-fix' | 'proceed';
}

export interface ConstraintsConfig {
  enabled?: boolean;
  cleanupAfterMerge?: boolean;
}

export interface UiConfig {
  devServer?: string;
  visualVerification?: boolean;
  designStandards?: boolean;
  creativeDirection?: boolean;
}

export interface ReviewConfig {
  maxIterations?: number;
  enabled?: boolean;
}

export interface LinearConfig {
  project?: string;
}

export interface WorktreeModeConfig {
  enabled?: boolean;
  autoApproveReadOnly?: boolean;
}

export interface PermissionsConfig {
  autoApprovePatterns?: string[];
  worktreeMode?: WorktreeModeConfig;
}

export interface QuotaManualOverride {
  status: 'healthy' | 'degrading' | 'exhausted';
  reason?: string;
  expiresAt?: string;
}

export interface QuotaThresholdsConfig {
  volumeThresholdPercent?: number;
  budgetThresholdPercent?: number;
  nearLimitCount?: number;
}

export interface QuotaConfig {
  manualOverrides?: Record<string, QuotaManualOverride>;
  thresholds?: QuotaThresholdsConfig;
}

export interface ReadyConfig {
  checks?: string[];
  requiredChecks?: string[];
  remediation?: ReadyRemediationConfig;
}

export interface ReadyRemediationConfig {
  enabled?: boolean;
  maxAttempts?: number;
  agentCmd?: string;
}

export interface RegistryConfig {
  enabled?: boolean;
  dir?: string;
}

export interface LifecyclePromotionConfig {
  minEvalRecords?: number;
  minMeanScore?: number;
  requireAllAboveAssisted?: boolean;
  requireChallengeWin?: boolean;
}

export interface LifecycleCanaryConfig {
  defaultTrafficPercent?: number;
  maxActiveCanaryAgeDays?: number;
}

export interface LifecycleConfig {
  enabled?: boolean;
  promotion?: LifecyclePromotionConfig;
  canary?: LifecycleCanaryConfig;
  rollbackHistoryDepth?: number;
}

export interface VerificationMandatoryChecksConfig {
  typecheck?: boolean;
  lint?: boolean;
  test?: boolean;
  selfExplanation?: boolean;
}

export interface VerificationPatchSizeCapConfig {
  baseLines?: number;
  adjustByQualityGap?: boolean;
}

export interface VerificationSecondPassReviewConfig {
  enabled?: boolean;
  riskPatterns?: string[];
}

export interface VerificationConfig {
  enabled?: boolean;
  qualityThresholds?: Partial<Record<RegistryTaskType, number>>;
  patchSizeCap?: VerificationPatchSizeCapConfig;
  mandatoryChecks?: VerificationMandatoryChecksConfig;
  secondPassReview?: VerificationSecondPassReviewConfig;
}

export interface BudgetConfig {
  normalMode?: number;
  constrainedMode?: number;
  survivalMode?: number;
}

export interface WavemillConfig {
  configVersion?: string;
  linear?: LinearConfig;
  mill?: MillConfig;
  expand?: ExpandConfig;
  plan?: PlanConfig;
  dashboard?: DashboardConfig;
  eval?: EvalConfig;
  autoEval?: boolean;
  hokusai?: HokusaiConfig;
  router?: RouterConfig;
  challenge?: ChallengeConfig;
  challengeScheduler?: ChallengeSchedulerConfig;
  validation?: ValidationConfig;
  constraints?: ConstraintsConfig;
  ui?: UiConfig;
  review?: ReviewConfig;
  ready?: ReadyConfig;
  permissions?: PermissionsConfig;
  modelRegistry?: ModelRegistryConfig;
  quota?: QuotaConfig;
  verification?: VerificationConfig;
  budget?: BudgetConfig;
  registry?: RegistryConfig;
  lifecycle?: LifecycleConfig;
}

// ────────────────────────────────────────────────────────────────
// Schema Validation
// ────────────────────────────────────────────────────────────────

interface ValidationError {
  instancePath?: string;
  message?: string;
}

type ValidatorFunction = ((data: unknown) => boolean) & {
  errors?: ValidationError[] | null;
};

let compiledValidator: ValidatorFunction | null = null;
let validatorDisabledReason: string | null = null;
let didWarnValidatorDisabled = false;

function warnValidatorDisabled(reason: string): void {
  if (didWarnValidatorDisabled) {
    return;
  }
  console.warn(
    `Wavemill config validation skipped: ${reason}. ` +
    'Install dependencies to restore schema validation.'
  );
  didWarnValidatorDisabled = true;
}

/**
 * Load and compile the JSON schema for validation.
 * Cached after first call.
 */
function getValidator(): ValidatorFunction | null {
  if (process.env.WAVEMILL_DISABLE_AJV_VALIDATION === '1') {
    validatorDisabledReason = 'WAVEMILL_DISABLE_AJV_VALIDATION=1';
    warnValidatorDisabled(validatorDisabledReason);
    return null;
  }

  if (validatorDisabledReason) {
    warnValidatorDisabled(validatorDisabledReason);
    return null;
  }

  if (compiledValidator !== null) {
    return compiledValidator;
  }

  // Load schema from repo root
  const schemaPath = resolve(
    import.meta.url.replace('file://', '').replace('/shared/lib/config.ts', ''),
    'wavemill-config.schema.json'
  );

  if (!existsSync(schemaPath)) {
    throw new Error(
      `Config schema not found at ${schemaPath}. ` +
      `Ensure wavemill-config.schema.json exists in the repo root.`
    );
  }

  const schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  const require = createRequire(import.meta.url);
  let AjvCtor: {
    new (options: { allErrors: boolean; strict: boolean }): { compile(schema: unknown): ValidatorFunction };
  };

  try {
    const ajvModule = require('ajv');
    AjvCtor = (ajvModule.default || ajvModule) as typeof AjvCtor;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = errorMessage(err);
    if (
      code === 'MODULE_NOT_FOUND' ||
      code === 'ERR_MODULE_NOT_FOUND' ||
      /Cannot find package 'ajv'/.test(message) ||
      /Cannot find module 'ajv'/.test(message)
    ) {
      validatorDisabledReason = `ajv unavailable (${message})`;
      warnValidatorDisabled(validatorDisabledReason);
      return null;
    }
    throw err;
  }

  const ajv = new AjvCtor({
    allErrors: true,
    strict: false, // Allow unknown keywords in schema
  });

  compiledValidator = ajv.compile(schema);
  return compiledValidator;
}

/**
 * Validate a config object against the schema.
 * Throws on validation failure with detailed error messages.
 */
function validateConfig(config: unknown): asserts config is WavemillConfig {
  const validate = getValidator();
  if (!validate) {
    return;
  }
  const valid = validate(config);

  if (!valid && validate.errors) {
    const errorMessages = validate.errors
      .map((err) => {
        const path = err.instancePath || 'root';
        const message = err.message || 'unknown error';
        return `  ${path}: ${message}`;
      })
      .join('\n');

    throw new Error(
      `Config validation failed:\n${errorMessages}\n\n` +
      `Check .wavemill-config.json against wavemill-config.schema.json`
    );
  }
}

// ────────────────────────────────────────────────────────────────
// Config Cache
// ────────────────────────────────────────────────────────────────

/**
 * In-memory cache of loaded configs, keyed by absolute repo directory path.
 * Lifetime: process-level singleton (no file watching or TTL).
 */
const configCache = new Map<string, WavemillConfig>();

/**
 * Resolve a repo directory path to an absolute path for cache key consistency.
 */
function resolveRepoDir(repoDir?: string): string {
  return resolve(repoDir || process.cwd());
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

/**
 * Load and validate the wavemill config for a repository.
 *
 * Behavior:
 * - Missing config file → returns empty object (all fields optional)
 * - Invalid JSON → throws SyntaxError
 * - Schema validation failure → throws Error with validation details
 * - Valid config → returns typed config object (cached for future calls)
 *
 * Caching:
 * - Configs are cached per absolute repo directory path
 * - Cache lifetime is process-level (no automatic invalidation)
 * - Use clearConfigCache() to force reload
 *
 * @param repoDir - Repository directory (default: current working directory)
 * @returns Validated config object (may be empty if file doesn't exist)
 *
 * @example
 * ```typescript
 * import { loadWavemillConfig } from './config.ts';
 *
 * const config = loadWavemillConfig();
 * console.log(config.router?.enabled); // typed access
 * ```
 */
export function loadWavemillConfig(repoDir?: string): WavemillConfig {
  const absRepoDir = resolveRepoDir(repoDir);

  // Check cache first
  const cached = configCache.get(absRepoDir);
  if (cached !== undefined) {
    return cached;
  }

  // Load config file
  const configPath = resolve(absRepoDir, '.wavemill-config.json');

  // Missing file is not an error (all fields are optional)
  if (!existsSync(configPath)) {
    const emptyConfig: WavemillConfig = {};
    configCache.set(absRepoDir, emptyConfig);
    return emptyConfig;
  }

  // Read and parse
  let parsed: unknown;
  try {
    const content = readFileSync(configPath, 'utf-8');
    parsed = JSON.parse(content);
  } catch (err) {
    const message = errorMessage(err);
    throw new Error(
      `Failed to parse .wavemill-config.json at ${configPath}: ${message}`
    );
  }

  // Validate against schema
  validateConfig(parsed);

  // Cache and return
  configCache.set(absRepoDir, parsed);
  return parsed;
}

/**
 * Clear the config cache for a specific repo or all repos.
 *
 * Useful for:
 * - Testing (force config reload between tests)
 * - Manual config changes during long-running processes
 *
 * @param repoDir - Repository directory (omit to clear all cached configs)
 *
 * @example
 * ```typescript
 * import { clearConfigCache } from './config.ts';
 *
 * // Clear specific repo
 * clearConfigCache('/path/to/repo');
 *
 * // Clear all
 * clearConfigCache();
 * ```
 */
export function clearConfigCache(repoDir?: string): void {
  if (repoDir !== undefined) {
    const absRepoDir = resolveRepoDir(repoDir);
    configCache.delete(absRepoDir);
  } else {
    configCache.clear();
  }

  // Reset validator state for deterministic tests and long-lived processes.
  compiledValidator = null;
  validatorDisabledReason = null;
  didWarnValidatorDisabled = false;
}

// ────────────────────────────────────────────────────────────────
// Typed Accessor Functions
// ────────────────────────────────────────────────────────────────

/**
 * Get the router config section.
 * Returns empty object if not configured.
 */
export function getRouterConfig(repoDir?: string): RouterConfig {
  return loadWavemillConfig(repoDir).router || {};
}

/**
 * Resolve the model allowlist for a single workflow stage.
 *
 * Resolution order:
 * 1. `router.availableModels.<stage>` when non-empty
 * 2. `router.models` when non-empty
 * 3. `undefined` when no config-based restriction exists
 */
export function getAvailableModelsForStage(
  routerConfig: RouterConfig,
  stage: keyof AvailableModelsConfig,
): string[] | undefined {
  const stageModels = routerConfig.availableModels?.[stage];
  if (stageModels && stageModels.length > 0) {
    return stageModels;
  }

  const sharedModels = routerConfig.models;
  if (sharedModels && sharedModels.length > 0) {
    return sharedModels;
  }

  return undefined;
}

/**
 * Get the Hokusai router config subsection.
 * Returns empty object if not configured.
 */
export function getHokusaiRouterConfig(repoDir?: string): HokusaiRouterConfig {
  return loadWavemillConfig(repoDir).router?.hokusai || {};
}

/**
 * Get the Hokusai data submission config subsection.
 * Returns empty object if not configured.
 */
export function getHokusaiSubmissionConfig(repoDir?: string): HokusaiDataSubmissionConfig {
  return loadWavemillConfig(repoDir).hokusai?.dataSubmission || {};
}

/**
 * Get the challenge config section.
 * Returns empty object if not configured.
 */
export function getChallengeConfig(repoDir?: string): ChallengeConfig {
  return loadWavemillConfig(repoDir).challenge || {};
}

/**
 * Get the challenge scheduler config section.
 * Returns empty object if not configured.
 */
export function getChallengeSchedulerConfig(repoDir?: string): ChallengeSchedulerConfig {
  return loadWavemillConfig(repoDir).challengeScheduler || {};
}

/**
 * Get the eval config section.
 * Returns empty object if not configured.
 */
export function getEvalConfig(repoDir?: string): EvalConfig {
  return loadWavemillConfig(repoDir).eval || {};
}

/**
 * Get the ready stage config section.
 * Returns defaults if not configured.
 */
export function getReadyConfig(repoDir?: string): ReadyConfig {
  const config = loadWavemillConfig(repoDir);
  return {
    checks: config.ready?.checks ?? [],
    requiredChecks: config.ready?.requiredChecks ?? [],
    remediation: {
      enabled: config.ready?.remediation?.enabled ?? true,
      maxAttempts: config.ready?.remediation?.maxAttempts ?? 3,
      agentCmd: config.ready?.remediation?.agentCmd ?? '',
    },
  };
}

/**
 * Get the verification config section.
 * Returns empty object if not configured.
 */
export function getVerificationConfig(repoDir?: string): VerificationConfig {
  return loadWavemillConfig(repoDir).verification || {};
}

/**
 * Get the mill config section.
 * Returns empty object if not configured.
 */
export function getMillConfig(repoDir?: string): MillConfig {
  return loadWavemillConfig(repoDir).mill || {};
}

/**
 * Get the default routing budget for mill tasks.
 * Returns undefined when no budget is configured.
 */
export function getMaxCostUsd(repoDir?: string): number | undefined {
  return loadWavemillConfig(repoDir).mill?.defaultMaxCostUsd;
}

/**
 * Get the UI config section.
 * Returns empty object if not configured.
 */
export function getUiConfig(repoDir?: string): UiConfig {
  return loadWavemillConfig(repoDir).ui || {};
}

/**
 * Get the validation config section.
 * Returns empty object if not configured.
 */
export function getValidationConfig(repoDir?: string): ValidationConfig {
  return loadWavemillConfig(repoDir).validation || {};
}

/**
 * Get the plan config section.
 * Returns empty object if not configured.
 */
export function getPlanConfig(repoDir?: string): PlanConfig {
  return loadWavemillConfig(repoDir).plan || {};
}

/**
 * Get the dashboard config section.
 * Returns empty object if not configured.
 */
export function getDashboardConfig(repoDir?: string): DashboardConfig {
  return loadWavemillConfig(repoDir).dashboard || {};
}

/**
 * Get the permissions config section.
 * Returns empty object if not configured.
 */
export function getPermissionsConfig(repoDir?: string): PermissionsConfig {
  return loadWavemillConfig(repoDir).permissions || {};
}

/**
 * Get the model registry override config section.
 * Returns empty object if not configured.
 */
export function getModelRegistryConfig(repoDir?: string): ModelRegistryConfig {
  return loadWavemillConfig(repoDir).modelRegistry || {};
}

/**
 * Get the difficulty classifier config section from router config.
 * Returns defaults if not configured.
 */
export function getDifficultyClassifierConfig(repoDir?: string): DifficultyClassifierConfig {
  return loadWavemillConfig(repoDir).router?.difficulty || {};
}

/**
 * Get the quota health configuration.
 * Returns empty object when not configured.
 */
export function getQuotaConfig(repoDir?: string): QuotaConfig {
  return loadWavemillConfig(repoDir).quota || {};
}

/**
 * Get the budget configuration with defaults.
 * Returns default budgets when not configured.
 *
 * Default budgets:
 * - Normal mode: $25.00
 * - Constrained mode: $15.00
 * - Survival mode: $5.00
 */
export function getBudgetConfig(repoDir?: string): Required<BudgetConfig> {
  const config = loadWavemillConfig(repoDir).budget || {};
  return {
    normalMode: config.normalMode ?? 25.0,
    constrainedMode: config.constrainedMode ?? 15.0,
    survivalMode: config.survivalMode ?? 5.0,
  };
}

export function getRegistryConfig(repoDir?: string): Required<RegistryConfig> {
  const config = loadWavemillConfig(repoDir).registry || {};
  return {
    enabled: config.enabled ?? true,
    dir: config.dir ?? '.wavemill/registry',
  };
}

export function getLifecycleConfig(repoDir?: string): Required<LifecycleConfig> {
  const registryConfig = getRegistryConfig(repoDir);
  const config = loadWavemillConfig(repoDir).lifecycle || {};
  return {
    enabled: config.enabled ?? registryConfig.enabled,
    promotion: {
      minEvalRecords: config.promotion?.minEvalRecords ?? 5,
      minMeanScore: config.promotion?.minMeanScore ?? 0.8,
      requireAllAboveAssisted: config.promotion?.requireAllAboveAssisted ?? false,
      requireChallengeWin: config.promotion?.requireChallengeWin ?? false,
    },
    canary: {
      defaultTrafficPercent: config.canary?.defaultTrafficPercent ?? 10,
      maxActiveCanaryAgeDays: config.canary?.maxActiveCanaryAgeDays ?? 14,
    },
    rollbackHistoryDepth: config.rollbackHistoryDepth ?? 5,
  };
}
