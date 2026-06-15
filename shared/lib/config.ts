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
import { parseModelSelector } from './model-registry.ts';
import type {
  LatencyTier,
  MultimodalSupport,
  ReasoningTier,
  RegistryTaskType,
  ToolSupport,
} from './model-registry.ts';

// ────────────────────────────────────────────────────────────────
// TypeScript Types (matching wavemill-config.schema.json)
// ────────────────────────────────────────────────────────────────

/**
 * Current config format version.
 * Increment when making breaking changes to config structure.
 */
export const CURRENT_CONFIG_VERSION = '1.4.0';

export interface MillConfig {
  session?: string;
  maxParallel?: number;
  pollSeconds?: number;
  baseBranch?: string;
  worktreeRoot?: string;
  agentCmd?: string;
  requireConfirm?: boolean;
  planningMode?: 'interactive';
  maxRetries?: number;
  retryDelay?: number;
  setupCommand?: string;
  defaultMaxCostUsd?: number;
  expansionHandshake?: ExpansionHandshakeConfig;
}

export interface ExpansionHandshakeConfig {
  policy?: 'recover' | 'block' | 'warn';
  timeoutSeconds?: number;
}

export interface GitConfig {
  fetchTtlSeconds?: number;
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

export interface AgentStageConfig {
  model?: string;
}

export interface AgentsConfig {
  planner?: AgentStageConfig;
  coder?: AgentStageConfig;
  reviewer?: AgentStageConfig;
}

export interface DashboardConfig {
  verbosity?: 'error' | 'status' | 'info' | 'debug';
  logToFile?: boolean;
}

export interface TaskSelectionConfig {
  enterLaunchesWave?: boolean;
}

export interface ProjectContextConfig {
  compactionThresholdKb?: number;
  recentWorkKeep?: number;
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
  apiKeyEnv?: string;
  timeout?: number;
}

export interface HokusaiDataSubmissionConfig {
  enabled?: boolean;
  consentVersion?: string;
  endpoint?: string;
}

export interface HokusaiContributionsConfig {
  enabled?: boolean;
  endpoint?: string | null;
  endpointTokenEnv?: string;
  batchSize?: number;
  exportPath?: string | null;
  maxRetries?: number;
  backoffInitialMs?: number;
  backoffMaxMs?: number;
  timeoutMs?: number;
}

export interface HokusaiConfig {
  dataSubmission?: HokusaiDataSubmissionConfig;
  contributions?: HokusaiContributionsConfig;
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
  disabled?: boolean;
  qualityScores?: Partial<Record<RegistryTaskType, number>>;
  pricing?: PricingEntry;
  defaultLadderEligible?: boolean;
  contextWindowTokens?: number;
  toolSupport?: ToolSupport;
  multimodal?: MultimodalSupport;
  latencyTier?: LatencyTier;
  reasoningTier?: ReasoningTier;
  costPerMillionInputTokensUsd?: number;
  costPerMillionOutputTokensUsd?: number;
  agent?: string;
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

export interface MintEligibilityConfig {
  enabled?: boolean;
  coverageThreshold?: number;
  maxInvalidRouteRate?: number;
}

export interface EvalConfig {
  aggregation?: AggregationConfig;
  evalsDir?: string;
  judge?: JudgeConfig;
  pricing?: Record<string, PricingEntry>;
  interventionPenalties?: InterventionPenaltiesConfig;
  successThreshold?: number;
  postMergeTimeoutSeconds?: number;
  mintEligibility?: MintEligibilityConfig;
  maxPromptBytes?: number;
  oversizePolicy?: 'fail' | 'truncate';
}

export interface EvalContextUpdatesConfig {
  enabled?: boolean;
  timeoutSeconds?: number;
  maxRetries?: number;
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
  rubricAware?: {
    mode?: 'off' | 'shadow' | 'on';
    minCoverage?: number;
    weight?: number;
  };
  capabilityFiltering?: {
    enabled?: boolean;
  };
  hokusai?: HokusaiRouterConfig;
  difficulty?: DifficultyClassifierConfig;
}

export interface ChallengeGateConfig {
  coolOffSeconds?: number;
}

export interface ChallengeConfig {
  enabled?: boolean;
  rate?: number;
  models?: string[] | null;
  allowDeepseek?: boolean;
  comparisonModel?: string;
  autoMergeWinner?: boolean;
  gate?: ChallengeGateConfig;
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
  provider?: 'claude-cli' | 'anthropic' | 'codex';
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

export interface CrossPrRevertCheckConfig {
  enabled?: boolean;
  maxRecentMerges?: number;
}

export interface ReviewMergeConfig {
  crossPrRevertCheck?: CrossPrRevertCheckConfig;
}

export type DeepSeekProviderStage = keyof AvailableModelsConfig;

export interface DeepSeekLauncherConfig {
  model?: string;
  subagentModel?: string;
  secretSource?: string;
  stateDir?: string;
}

export interface DeepSeekProviderConfig {
  enabled?: boolean;
  apiKeyEnv?: string;
  baseUrl?: string;
  models?: string[];
  stages?: DeepSeekProviderStage[];
  effortLevel?: 'low' | 'medium' | 'high';
  launcher?: DeepSeekLauncherConfig;
}

export interface ProvidersConfig {
  deepseek?: DeepSeekProviderConfig;
}

export interface IntegrationConfig {
  enabled: boolean;
  integrationBranch: string;
  promotionBranch: string;
  autoUpdatePromotionBranch: boolean;
  mergeMethod: 'merge' | 'squash' | 'rebase';
  deleteBranchAfterMerge: boolean;
  haltOnRed: boolean;
  requiredChecks: string[];
  highRiskPolicy: 'block' | 'manual' | 'allow';
  useMillSession: boolean;
  readyPolicy?: IntegrationReadyPolicyConfig;
}

export type PromotionProtectedIntegrationStrategy =
  | 'skip-reconciliation'
  | 'block'
  | 'use-promotion-head';

export interface PromotionConfig {
  protectedIntegrationStrategy: PromotionProtectedIntegrationStrategy;
  promotionHeadBranch: string;
}

export interface ResolvedReviewMergeConfig {
  crossPrRevertCheck: {
    enabled: boolean;
    maxRecentMerges: number;
  };
}

export interface IntegrationReadyPolicyConfig {
  enabled?: boolean;
  integrationBranch?: string;
  riskPolicy?: 'block' | 'require-label' | 'auto';
  enforceMigrationCoupling?: boolean;
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
  migrationKind?: 'alembic' | 'sql' | 'none';
  migrationPatterns?: string[];
  migrationChecks?: ReadyMigrationChecksConfig;
  migrationDangerLabels?: Record<string, string>;
  migrationForbiddenPatterns?: string[];
  remediation?: ReadyRemediationConfig;
  watchdog?: ReadyWatchdogConfig;
}

export interface ReadyMigrationBaseRefreshConfig {
  enabled?: boolean;
  timeoutSeconds?: number;
}

export interface ReadyMigrationChecksConfig {
  enabled?: boolean;
  autoDetectAlembic?: boolean;
  baseRefresh?: ReadyMigrationBaseRefreshConfig;
}

export interface ReadyRemediationConfig {
  enabled?: boolean;
  maxAttempts?: number;
  agentCmd?: string;
}

export interface ReadyWatchdogConfig {
  enabled?: boolean;
  thresholdMinutes?: number;
  autoRecover?: boolean;
  timeoutSeconds?: number;
  stableFailureConsecutivePolls?: number;
  stableFailureEscalateAfterPolls?: number;
  safeRemediationCategories?: string[];
}

export interface MergeQueueConfig {
  enabled?: boolean;
  maxConcurrentCandidates?: number;
  stuckTimeoutSeconds?: number;
  conflictGroupingEnabled?: boolean;
  skipCooldownSeconds?: number;
}

export interface MonitorConfig {
  readyWatchdog?: ReadyWatchdogConfig;
}

export interface RegistryConfig {
  enabled?: boolean;
  dir?: string;
}

export type RuntimeResourceSurface = 'router' | 'planner' | 'reviewer';
export type RuntimeResourceVariantKind = 'baseline' | 'optimized' | 'canary';

export interface RuntimeResourceSurfaceConfig {
  enabled?: boolean;
  variant?: RuntimeResourceVariantKind;
  resourceId?: string;
  version?: string;
  path?: string;
}

export interface RuntimeResourceSelectionConfig {
  enabled?: boolean;
  defaultVariant?: RuntimeResourceVariantKind;
  fallbackToBaseline?: boolean;
  canaryRate?: number;
  surfaces?: Partial<Record<RuntimeResourceSurface, RuntimeResourceSurfaceConfig>>;
}

export interface ResourcesConfig {
  runtimeSelection?: RuntimeResourceSelectionConfig;
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
  git?: GitConfig;
  mill?: MillConfig;
  expand?: ExpandConfig;
  plan?: PlanConfig;
  agents?: AgentsConfig;
  dashboard?: DashboardConfig;
  taskSelection?: TaskSelectionConfig;
  projectContext?: ProjectContextConfig;
  eval?: EvalConfig;
  evalContextUpdates?: EvalContextUpdatesConfig;
  autoEval?: boolean;
  hokusai?: HokusaiConfig;
  router?: RouterConfig;
  challenge?: ChallengeConfig;
  challengeScheduler?: ChallengeSchedulerConfig;
  validation?: ValidationConfig;
  constraints?: ConstraintsConfig;
  ui?: UiConfig;
  review?: ReviewConfig;
  reviewMerge?: ReviewMergeConfig;
  providers?: ProvidersConfig;
  integration?: Partial<IntegrationConfig>;
  promotion?: Partial<PromotionConfig>;
  ready?: ReadyConfig;
  mergeQueue?: MergeQueueConfig;
  monitor?: MonitorConfig;
  permissions?: PermissionsConfig;
  modelRegistry?: ModelRegistryConfig;
  quota?: QuotaConfig;
  verification?: VerificationConfig;
  budget?: BudgetConfig;
  registry?: RegistryConfig;
  resources?: ResourcesConfig;
}

export const INTEGRATION_DEFAULTS: IntegrationConfig = {
  enabled: false,
  integrationBranch: 'auto/integration',
  promotionBranch: 'main',
  autoUpdatePromotionBranch: false,
  mergeMethod: 'squash',
  deleteBranchAfterMerge: true,
  haltOnRed: true,
  requiredChecks: [],
  highRiskPolicy: 'manual',
  useMillSession: true,
};

export const PROMOTION_DEFAULTS: PromotionConfig = {
  protectedIntegrationStrategy: 'skip-reconciliation',
  promotionHeadBranch: 'auto/promotion',
};

export const REVIEW_MERGE_DEFAULTS: ResolvedReviewMergeConfig = {
  crossPrRevertCheck: {
    enabled: true,
    maxRecentMerges: 50,
  },
};

export const DEFAULT_READY_MIGRATION_PATTERNS = [
  'migrations/',
  'alembic/versions/',
] as const;

export const DEFAULT_READY_MIGRATION_DANGER_LABELS = {
  drop_column: 'migration:destructive',
  drop_table: 'migration:destructive',
  alter_column_type: 'migration:long-running',
} as const;

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

  validateReadyPolicySubset(config);
  validateAgentsModelSelectors(config);
}

function canonicalizeReadyCheckName(name: string): string {
  return name === 'merge-conflicts' ? 'merge-conflict' : name;
}

// These are the universal checks always included by resolveReadyPolicy when no explicit
// ready.checks are configured. Keeping them here (rather than importing from ready-stage.ts)
// avoids a circular dependency since ready-stage.ts imports from config.ts.
const UNIVERSAL_CHECK_NAMES = ['pr-exists', 'merge-conflict', 'ci-status'];

function validateReadyPolicySubset(config: unknown): void {
  if (typeof config !== 'object' || config === null) {
    return;
  }

  const ready = (config as WavemillConfig).ready;
  if (!ready || !Array.isArray(ready.requiredChecks) || ready.requiredChecks.length === 0) {
    return;
  }

  // Effective check set = explicitly configured checks + universal defaults (always present at runtime).
  const configuredChecks = Array.isArray(ready.checks) ? ready.checks : [];
  const effectiveCheckSet = new Set(
    [...configuredChecks, ...UNIVERSAL_CHECK_NAMES].map(canonicalizeReadyCheckName)
  );
  for (const requiredCheck of ready.requiredChecks) {
    const canonicalRequired = canonicalizeReadyCheckName(requiredCheck);
    if (!effectiveCheckSet.has(canonicalRequired)) {
      throw new Error(
        `Config validation failed:\n` +
        `  /ready/requiredChecks: "${requiredCheck}" must also be present in ready.checks\n\n` +
        `Check .wavemill-config.json against wavemill-config.schema.json`
      );
    }
  }
}

function validateAgentsModelSelectors(config: unknown): void {
  if (typeof config !== 'object' || config === null) {
    return;
  }

  const agents = (config as WavemillConfig).agents;
  if (!agents) {
    return;
  }

  const phases = ['planner', 'coder', 'reviewer'] as const;
  for (const phase of phases) {
    const model = agents[phase]?.model;
    if (model === undefined) {
      continue;
    }

    const parsed = parseModelSelector(model);
    if (parsed.ok) {
      continue;
    }

    throw new Error(
      `Config validation failed:\n` +
      `  /agents/${phase}/model: "${model}" is not a valid model selector.\n` +
      `  Valid forms: "inherit", a family alias (e.g. "opus", "sonnet", "haiku"), or a pinned model ID (e.g. "claude-opus-4-7").\n` +
      `  Parse error: ${parsed.error.message}`
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
const baseConfigCache = new Map<string, WavemillConfig>();

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
function normalizeLegacyPlanningMode(config: unknown): WavemillConfig {
  if (
    typeof config === 'object' &&
    config !== null &&
    'mill' in config &&
    typeof (config as { mill?: { planningMode?: string } }).mill === 'object' &&
    (config as { mill?: { planningMode?: string } }).mill?.planningMode === 'skip'
  ) {
    (config as { mill: { planningMode: 'interactive' } }).mill.planningMode = 'interactive';
  }

  validateConfig(config);
  return config as WavemillConfig;
}

function loadBaseConfigFromDisk(absRepoDir: string): WavemillConfig {
  const configPath = resolve(absRepoDir, '.wavemill-config.json');
  const base = existsSync(configPath) ? readAndParseConfig(configPath) : {};
  return normalizeLegacyPlanningMode(base);
}

/**
 * Load the tracked repo config from `.wavemill-config.json` only.
 *
 * This ignores `.wavemill-config.local.json` and is intended for workflows that
 * operate on the tracked base file itself, such as config upgrade checks and
 * sync planning.
 */
export function loadWavemillBaseConfig(repoDir?: string): WavemillConfig {
  const absRepoDir = resolveRepoDir(repoDir);

  const cached = baseConfigCache.get(absRepoDir);
  if (cached !== undefined) {
    return cached;
  }

  const baseConfig = loadBaseConfigFromDisk(absRepoDir);
  baseConfigCache.set(absRepoDir, baseConfig);
  return baseConfig;
}

/**
 * Load the runtime config by overlaying `.wavemill-config.local.json` on top of
 * `.wavemill-config.json`, with local values winning.
 */
export function loadWavemillConfig(repoDir?: string): WavemillConfig {
  const absRepoDir = resolveRepoDir(repoDir);

  const cached = configCache.get(absRepoDir);
  if (cached !== undefined) {
    return cached;
  }

  const localConfigPath = resolve(absRepoDir, '.wavemill-config.local.json');

  // Missing base file is not an error (all fields are optional). A `.local.json`
  // alone with no base is also valid — it acts as the entire config.
  const base = existsSync(resolve(absRepoDir, '.wavemill-config.json'))
    ? loadWavemillBaseConfig(absRepoDir)
    : {};
  const overlay = existsSync(localConfigPath) ? readAndParseConfig(localConfigPath) : null;
  const merged = overlay ? deepMergeConfig(base, overlay) : base;

  // Validate the merged result against the schema. The overlay file is partial,
  // so validating it alone would be too permissive; validating the merge catches
  // type mismatches and unknown keys regardless of which file contributed them.
  const validated = normalizeLegacyPlanningMode(merged);

  configCache.set(absRepoDir, validated);
  return validated;
}

function readAndParseConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${errorMessage(err)}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Deep-merge an overlay config onto a base config. Used to apply
 * `.wavemill-config.local.json` on top of `.wavemill-config.json`.
 *
 * - Objects: recursively merged, overlay keys win.
 * - Arrays: replaced entirely by the overlay (no concatenation). This keeps
 *   precedence predictable for arrays like `permissions.autoApprovePatterns`
 *   or `eval.aggregation.repos` where users typically want full control.
 * - Primitives and `null`: overlay value wins.
 */
function deepMergeConfig(base: unknown, overlay: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(overlay)) return overlay;
  const result: Record<string, unknown> = { ...base };
  for (const [key, overlayValue] of Object.entries(overlay)) {
    const baseValue = base[key];
    if (isPlainObject(baseValue) && isPlainObject(overlayValue)) {
      result[key] = deepMergeConfig(baseValue, overlayValue);
    } else {
      result[key] = overlayValue;
    }
  }
  return result;
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
    baseConfigCache.delete(absRepoDir);
  } else {
    configCache.clear();
    baseConfigCache.clear();
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

export function isRouterCapabilityFilteringEnabled(repoDir?: string): boolean {
  return getRouterConfig(repoDir).capabilityFiltering?.enabled === true;
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
 * Get the Hokusai contribution queue config subsection with normalized defaults.
 */
export function getHokusaiContributionsConfig(repoDir?: string): Required<HokusaiContributionsConfig> {
  const config = loadWavemillConfig(repoDir).hokusai?.contributions || {};
  return {
    enabled: config.enabled ?? false,
    endpoint: config.endpoint ?? null,
    endpointTokenEnv: config.endpointTokenEnv ?? '',
    batchSize: config.batchSize ?? 50,
    exportPath: config.exportPath ?? null,
    maxRetries: config.maxRetries ?? 5,
    backoffInitialMs: config.backoffInitialMs ?? 1_000,
    backoffMaxMs: config.backoffMaxMs ?? 300_000,
    timeoutMs: config.timeoutMs ?? 30_000,
  };
}

/**
 * Get the challenge config section.
 * Returns empty object if not configured.
 */
export function getChallengeConfig(repoDir?: string): ChallengeConfig {
  return loadWavemillConfig(repoDir).challenge || {};
}

export function getChallengeGateConfig(repoDir?: string): Required<ChallengeGateConfig> {
  const gate = loadWavemillConfig(repoDir).challenge?.gate ?? {};
  return {
    coolOffSeconds: gate.coolOffSeconds ?? 300,
  };
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

export function getEvalContextUpdatesConfig(repoDir?: string): Required<EvalContextUpdatesConfig> {
  const config = loadWavemillConfig(repoDir).evalContextUpdates ?? {};
  return {
    enabled: config.enabled ?? true,
    timeoutSeconds: config.timeoutSeconds ?? 60,
    maxRetries: config.maxRetries ?? 0,
  };
}

export function getMintEligibilityConfig(repoDir?: string): MintEligibilityConfig | undefined {
  return getEvalConfig(repoDir).mintEligibility;
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
    migrationKind: config.ready?.migrationKind,
    migrationPatterns: config.ready?.migrationPatterns ?? [...DEFAULT_READY_MIGRATION_PATTERNS],
    migrationChecks: getMigrationChecksConfig(repoDir),
    migrationDangerLabels: {
      ...DEFAULT_READY_MIGRATION_DANGER_LABELS,
      ...(config.ready?.migrationDangerLabels ?? {}),
    },
    migrationForbiddenPatterns: config.ready?.migrationForbiddenPatterns ?? [],
    remediation: {
      enabled: config.ready?.remediation?.enabled ?? true,
      maxAttempts: config.ready?.remediation?.maxAttempts ?? 3,
      agentCmd: config.ready?.remediation?.agentCmd ?? '',
    },
    watchdog: getReadyWatchdogConfig(repoDir),
  };
}

export function getReadyWatchdogConfig(repoDir?: string): Required<ReadyWatchdogConfig> {
  const config = loadWavemillConfig(repoDir);
  const readyWatchdog = config.ready?.watchdog ?? {};
  const legacyMonitorWatchdog = config.monitor?.readyWatchdog ?? {};
  const merged = {
    ...legacyMonitorWatchdog,
    ...readyWatchdog,
  };

  return {
    enabled: merged.enabled ?? true,
    thresholdMinutes: merged.thresholdMinutes ?? 10,
    autoRecover: merged.autoRecover ?? true,
    timeoutSeconds: merged.timeoutSeconds ?? 30,
    stableFailureConsecutivePolls: merged.stableFailureConsecutivePolls ?? 2,
    stableFailureEscalateAfterPolls: merged.stableFailureEscalateAfterPolls ?? 4,
    safeRemediationCategories: merged.safeRemediationCategories ?? ['lint', 'type', 'test', 'build', 'migration-chain', 'alembic'],
  };
}

export function getMigrationChecksConfig(repoDir?: string): Required<ReadyMigrationChecksConfig> & {
  baseRefresh: Required<ReadyMigrationBaseRefreshConfig>;
} {
  const config = loadWavemillConfig(repoDir);
  const migrationChecks = config.ready?.migrationChecks ?? {};
  const baseRefresh = migrationChecks.baseRefresh ?? {};

  return {
    enabled: migrationChecks.enabled ?? true,
    autoDetectAlembic: migrationChecks.autoDetectAlembic ?? true,
    baseRefresh: {
      enabled: baseRefresh.enabled ?? true,
      timeoutSeconds: baseRefresh.timeoutSeconds ?? 30,
    },
  };
}

export function getReadyRemediationConfig(repoDir?: string): Required<ReadyRemediationConfig> {
  const remediation = loadWavemillConfig(repoDir).ready?.remediation ?? {};
  return {
    enabled: remediation.enabled ?? true,
    maxAttempts: remediation.maxAttempts ?? 3,
    agentCmd: remediation.agentCmd ?? '',
  };
}

export function getMergeQueueConfig(repoDir?: string): Required<MergeQueueConfig> {
  const config = loadWavemillConfig(repoDir).mergeQueue ?? {};
  return {
    enabled: config.enabled ?? true,
    maxConcurrentCandidates: config.maxConcurrentCandidates ?? 2,
    stuckTimeoutSeconds: config.stuckTimeoutSeconds ?? 900,
    conflictGroupingEnabled: config.conflictGroupingEnabled ?? true,
    skipCooldownSeconds: config.skipCooldownSeconds ?? 60,
  };
}

/**
 * Get the integration mode config section.
 * Returns defaults when not configured.
 */
export function getIntegrationConfig(repoDir?: string): IntegrationConfig {
  const config = loadWavemillConfig(repoDir);
  const integration = { ...INTEGRATION_DEFAULTS, ...(config.integration ?? {}) };
  if (!config.integration?.integrationBranch && config.mill?.baseBranch) {
    integration.integrationBranch = config.mill.baseBranch;
  }
  return integration;
}

/**
 * Get the promotion config section.
 * Returns defaults when not configured.
 */
export function getPromotionConfig(repoDir?: string): PromotionConfig {
  return { ...PROMOTION_DEFAULTS, ...(loadWavemillConfig(repoDir).promotion ?? {}) };
}

/**
 * Get the review/merge hardening config section.
 * Returns defaults when not configured.
 */
export function getReviewMergeConfig(repoDir?: string): ResolvedReviewMergeConfig {
  const config = loadWavemillConfig(repoDir).reviewMerge ?? {};
  const crossPrRevertCheck = config.crossPrRevertCheck ?? {};
  return {
    crossPrRevertCheck: {
      enabled: crossPrRevertCheck.enabled ?? REVIEW_MERGE_DEFAULTS.crossPrRevertCheck.enabled,
      maxRecentMerges:
        crossPrRevertCheck.maxRecentMerges ?? REVIEW_MERGE_DEFAULTS.crossPrRevertCheck.maxRecentMerges,
    },
  };
}

/**
 * Get the integration ready-policy config section.
 * Returns defaults with integration-branch fallback.
 */
export function getIntegrationReadyPolicy(repoDir?: string): IntegrationReadyPolicyConfig {
  const integration = getIntegrationConfig(repoDir);
  const readyPolicy = integration.readyPolicy ?? {};
  return {
    enabled: readyPolicy.enabled ?? false,
    integrationBranch: readyPolicy.integrationBranch ?? integration.integrationBranch,
    riskPolicy: readyPolicy.riskPolicy ?? 'require-label',
    enforceMigrationCoupling: readyPolicy.enforceMigrationCoupling ?? true,
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

export function getExpansionHandshakeConfig(repoDir?: string): { policy: 'recover' | 'block' | 'warn'; timeoutSeconds: number } {
  const config = loadWavemillConfig(repoDir).mill?.expansionHandshake ?? {};
  return {
    policy: config.policy ?? 'recover',
    timeoutSeconds: config.timeoutSeconds ?? 300,
  };
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

export function getAgentsConfig(repoDir?: string): AgentsConfig {
  return loadWavemillConfig(repoDir).agents || {};
}

/**
 * Get the dashboard config section.
 * Returns empty object if not configured.
 */
export function getDashboardConfig(repoDir?: string): DashboardConfig {
  return loadWavemillConfig(repoDir).dashboard || {};
}

export function getTaskSelectionConfig(repoDir?: string): TaskSelectionConfig {
  return loadWavemillConfig(repoDir).taskSelection || {};
}

export function getProjectContextConfig(repoDir?: string): Required<ProjectContextConfig> {
  const config = loadWavemillConfig(repoDir).projectContext || {};
  return {
    compactionThresholdKb: config.compactionThresholdKb ?? 100,
    recentWorkKeep: config.recentWorkKeep ?? 25,
  };
}

/**
 * Get the provider config section.
 * Returns empty object if not configured.
 */
export function getProvidersConfig(repoDir?: string): ProvidersConfig {
  return loadWavemillConfig(repoDir).providers || {};
}

/**
 * Get the DeepSeek provider config section.
 * Returns empty object if not configured.
 */
export function getDeepSeekProviderConfig(repoDir?: string): DeepSeekProviderConfig {
  return loadWavemillConfig(repoDir).providers?.deepseek || {};
}

/**
 * Get the DeepSeek launcher config section.
 * Returns empty object if not configured.
 */
export function getDeepSeekLauncherConfig(repoDir?: string): DeepSeekLauncherConfig {
  return loadWavemillConfig(repoDir).providers?.deepseek?.launcher || {};
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

export function getRuntimeResourceSelectionConfig(repoDir?: string): Required<Omit<RuntimeResourceSelectionConfig, 'surfaces'>> & {
  surfaces: Partial<Record<RuntimeResourceSurface, RuntimeResourceSurfaceConfig>>;
} {
  const config = loadWavemillConfig(repoDir).resources?.runtimeSelection || {};
  return {
    enabled: config.enabled ?? false,
    defaultVariant: config.defaultVariant ?? 'baseline',
    fallbackToBaseline: config.fallbackToBaseline ?? true,
    canaryRate: config.canaryRate ?? 0,
    surfaces: config.surfaces ?? {},
  };
}
