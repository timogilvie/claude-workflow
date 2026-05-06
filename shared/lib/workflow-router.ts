/**
 * Workflow router — recommends planner/coder/reviewer models plus stage depth,
 * review mode, expected success, and heuristic cost estimates for a task.
 *
 * Extends the single-model router with stage-aware workflow decisions.
 *
 * @module workflow-router
 */

import { readFileSync } from 'node:fs';
import { buildEvalSummary, evaluateChallenge, type ChallengeRecommendation } from './challenge-scheduler.ts';
import { getAvailableModelsForStage, getBudgetConfig, getChallengeSchedulerConfig, getDifficultyClassifierConfig, getHokusaiRouterConfig, getRouterConfig } from './config.ts';
import { filterDeepSeekModels, type DeepSeekPoolFilterResult } from './deepseek-provider.ts';
import { routeViaHokusai } from './hokusai-router.ts';
import { analyzePrompt, loadRouterConfig, recommendModel, resolveAgent, type PromptCharacteristics, type TaskType } from './model-router.ts';
import { getEffectiveRegistry, getLadder, type RegistryTaskType } from './model-registry.ts';
import { readQuotaSnapshot, type QuotaSnapshot } from './quota-state.ts';
import { resolveModel, topViableCandidate } from './routing-policy.ts';
import { classifyTaskDifficulty, getAllowedModelFloor, type DifficultyFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';
import { loadPricingTable, computeModelCost } from './workflow-cost.ts';
import { loadConfiguredPricingTable } from './workflow-cost.ts';
import {
  routeStageAware,
  routeStageAwareWithContext,
  type StageAwareDecision,
  type StageAwareRouterContext,
} from './stage-aware-router.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import type { ModelClass } from './model-registry.ts';
import { policyAdjustmentLog, routerLog } from './router-log.ts';
import { registerAgentConfig } from './resource-adapters/agent-config-adapter.ts';
import { recordUse } from './resource-manifest.ts';
import type { RuntimeResourceSelection } from './resource-selection.ts';
import type { RouteProvenance } from './route-artifact.ts';
import { isDeepSeekLikeModelId } from './model-registry.ts';
import { validateModelOrThrow } from './model-validator.ts';

export type PlanDepth = 'light' | 'medium' | 'deep';
export type CodeDepth = 'light' | 'medium' | 'deep';
export type ReviewMode = 'none' | 'static' | 'llm' | 'static+llm';

export interface BudgetViolation {
  requestedCost: number;
  maxCostUsd: number;
  operatingMode: OperatingMode;
  attemptedDowngrade: boolean;
  cheapestViableOption: {
    planner: string;
    coder: string;
    reviewer: string;
    totalCost: number;
  } | null;
}

export interface WorkflowRouteDecision {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: PlanDepth;
  codeDepth: CodeDepth;
  reviewRecommended: ReviewMode;
  expectedSuccess: number;
  expectedCostPlan: number;
  expectedCostCode: number;
  expectedCostReview: number;
  confidence: number;
  reasoning: string[];
  signals: {
    taskType: TaskType;
    promptLength: PromptCharacteristics['length'];
    complexityScore: number;
    fileTypes: string[];
    riskScore: number;
    taskDifficulty?: RoutingDifficulty;
  };
  challengeRecommendation?: ChallengeRecommendation;
  constraints?: {
    maxCostUsd?: number;
  };
  maxCostUsd?: number | null;
  budgetViolation?: BudgetViolation;
  resourceSelections?: RuntimeResourceSelection[];
  provenance?: RouteProvenance;
  routingMode?: string;
}

export interface RouteWorkflowOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  plannerModelsAvailable?: string[];
  coderModelsAvailable?: string[];
  reviewerModelsAvailable?: string[];
  maxCostUsd?: number;
  taskDifficulty?: RoutingDifficulty;
  taskTitle?: string;
  taskDescription?: string;
  packetContent?: string;
  skipDifficultyClassification?: boolean;
  additionalEvalsPaths?: string[];
}

function withSignals(
  decision: WorkflowRouteDecision,
  prompt: string,
  taskDifficulty?: RoutingDifficulty,
): WorkflowRouteDecision {
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);

  return {
    ...decision,
    signals: {
      taskType: characteristics.taskType,
      promptLength: characteristics.length,
      complexityScore: characteristics.complexityScore,
      fileTypes: characteristics.fileTypes,
      riskScore,
      ...(taskDifficulty ? { taskDifficulty } : {}),
    },
  };
}

function withChallengeRecommendation<T extends WorkflowRouteDecision>(decision: T, repoDir?: string): T {
  const challengeConfig = getChallengeSchedulerConfig(repoDir);
  if (challengeConfig.enabled === false) {
    return decision;
  }

  const recommendation = evaluateChallenge({
    routingDecision: decision,
    evalSummary: buildEvalSummary(repoDir),
    config: challengeConfig,
    repoDir,
  });

  if (!recommendation.shouldChallenge) {
    return decision;
  }

  return {
    ...decision,
    challengeRecommendation: recommendation,
  };
}

const DEFAULT_MODEL_POOL = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5-20251001',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-chat',
  'deepseek-reasoner',
  'gpt-5.3-codex',
  'gpt-5.4',
  'gpt-5.5',
];

const REPO_RISK_PATTERNS = [
  /\bauth(entication|orization)?\b/i,
  /\bpayment\b/i,
  /\bsecurity\b/i,
  /\bpermission(s)?\b/i,
  /\bmigration\b/i,
  /\bdatabase\b/i,
  /\brouter\b/i,
  /\bcli\b/i,
  /\bworkflow\b/i,
  /\bconfig\b/i,
  /\breview\b/i,
  /\beval\b/i,
];

const BREADTH_PATTERNS = [
  /\bplanning\b/i,
  /\bplanner\b/i,
  /\bcoder\b/i,
  /\breviewer\b/i,
  /\bstdout\b/i,
  /\bjson\b/i,
  /\bmodel(s)?\b/i,
  /\boutput(s)?\b/i,
  /\bcommand\b/i,
  /\bcli\b/i,
  /\btool\b/i,
  /\bextend\b/i,
  /\broute\b/i,
];

interface ResolvedModelPool {
  models: string[];
  warnings: string[];
}

export interface StageTokenProfile {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export const PLAN_TOKENS: Record<PlanDepth, StageTokenProfile> = {
  light: { inputTokens: 35_000, cacheCreationTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 5_000 },
  medium: { inputTokens: 90_000, cacheCreationTokens: 30_000, cacheReadTokens: 70_000, outputTokens: 10_000 },
  deep: { inputTokens: 180_000, cacheCreationTokens: 60_000, cacheReadTokens: 140_000, outputTokens: 18_000 },
};

export const CODE_TOKENS: Record<CodeDepth, StageTokenProfile> = {
  light: { inputTokens: 220_000, cacheCreationTokens: 80_000, cacheReadTokens: 180_000, outputTokens: 12_000 },
  medium: { inputTokens: 850_000, cacheCreationTokens: 260_000, cacheReadTokens: 700_000, outputTokens: 35_000 },
  deep: { inputTokens: 2_800_000, cacheCreationTokens: 950_000, cacheReadTokens: 2_300_000, outputTokens: 110_000 },
};

export const REVIEW_TOKENS: Record<Exclude<ReviewMode, 'none'>, StageTokenProfile> = {
  static: { inputTokens: 18_000, cacheCreationTokens: 4_000, cacheReadTokens: 10_000, outputTokens: 1_500 },
  llm: { inputTokens: 95_000, cacheCreationTokens: 25_000, cacheReadTokens: 80_000, outputTokens: 8_000 },
  'static+llm': { inputTokens: 180_000, cacheCreationTokens: 40_000, cacheReadTokens: 160_000, outputTokens: 12_000 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundToHundredths(value: number): number {
  return Number(value.toFixed(2));
}

function normalizeDecisionConfidence(confidence: number | undefined, fallback = 0.5): number {
  return roundToHundredths(
    clamp(Number.isFinite(confidence) ? confidence as number : fallback, 0.1, 0.95),
  );
}

function computeHeuristicConfidence(
  categoricalConfidence: 'high' | 'medium' | 'low',
  riskScore: number,
): number {
  const baseConfidence =
    categoricalConfidence === 'high' ? 0.85 :
    categoricalConfidence === 'medium' ? 0.65 :
    0.45;

  return roundToHundredths(clamp(baseConfidence - riskScore * 0.02, 0.1, 0.95));
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

function countMatches(prompt: string, patterns: RegExp[]): number {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(prompt) ? 1 : 0), 0);
}

function mergePoolWarnings(...results: DeepSeekPoolFilterResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.warnings))];
}

function filterProviderPool(
  models: string[],
  repoDir?: string,
  stage?: 'planner' | 'coder' | 'reviewer',
): ResolvedModelPool {
  const filtered = filterDeepSeekModels(models, repoDir, stage);
  return {
    models: filtered.models,
    warnings: filtered.warnings,
  };
}

function getModelPool(repoDir?: string): ResolvedModelPool {
  const routerConfig = loadRouterConfig(repoDir);
  const pricingModels = Object.keys(loadConfiguredPricingTable(repoDir));
  return filterProviderPool([...new Set([
    ...(routerConfig.models || []),
    ...pricingModels,
    ...DEFAULT_MODEL_POOL,
  ])], repoDir);
}

function validateDeepSeekPool(models: string[] | undefined, repoDir?: string): void {
  for (const modelId of models ?? []) {
    if (isDeepSeekLikeModelId(modelId)) {
      validateModelOrThrow(modelId, repoDir);
    }
  }
}

function getEffectiveModelPool(options?: RouteWorkflowOptions): ResolvedModelPool {
  if (options?.modelsAvailable && options.modelsAvailable.length > 0) {
    return filterProviderPool([...new Set(options.modelsAvailable)], options.repoDir);
  }

  return getModelPool(options?.repoDir);
}

function intersectPools(basePool: string[], preferredPool?: string[]): string[] {
  if (!preferredPool || preferredPool.length === 0) {
    return [...new Set(basePool)];
  }

  const intersected = preferredPool.filter((modelId) => basePool.includes(modelId));
  if (intersected.length > 0) {
    return [...new Set(intersected)];
  }

  return [...new Set(preferredPool)];
}

function resolveStagePool(
  role: 'planner' | 'coder' | 'reviewer',
  basePool: string[],
  routerConfig: ReturnType<typeof getRouterConfig>,
  options?: RouteWorkflowOptions,
  policyPool?: string[],
): ResolvedModelPool {
  const explicitPool = options?.modelsAvailable && options.modelsAvailable.length > 0
    ? options.modelsAvailable
    : role === 'planner'
      ? options?.plannerModelsAvailable ?? getAvailableModelsForStage(routerConfig, 'planner')
      : role === 'coder'
        ? options?.coderModelsAvailable ?? getAvailableModelsForStage(routerConfig, 'coder')
        : options?.reviewerModelsAvailable ?? getAvailableModelsForStage(routerConfig, 'reviewer');

  validateDeepSeekPool(explicitPool, options?.repoDir);
  const configuredPool = intersectPools(basePool, explicitPool);
  return filterProviderPool(intersectPools(configuredPool, policyPool), options?.repoDir, role);
}

function pickAvailableModel(pool: string[], preferred: string[], fallback: string): string {
  for (const model of preferred) {
    if (pool.includes(model)) return model;
  }
  return pool[0] || fallback;
}

function computeRiskScore(prompt: string, characteristics: PromptCharacteristics): number {
  let score = characteristics.complexityScore;
  const breadthMatches = countMatches(prompt, BREADTH_PATTERNS);

  if (characteristics.length === 'long') score += 2;
  if (characteristics.fileTypes.length >= 3) score += 1;
  if (characteristics.taskType === 'bugfix' || characteristics.taskType === 'infrastructure') score += 2;
  if (characteristics.taskType === 'refactor') score += 1;

  score += countMatches(prompt, REPO_RISK_PATTERNS);
  if (breadthMatches >= 3) {
    score += 2;
  } else if (breadthMatches >= 2) {
    score += 1;
  }

  return score;
}

function choosePlanDepth(characteristics: PromptCharacteristics, riskScore: number): PlanDepth {
  if (
    riskScore >= 4 ||
    characteristics.taskType === 'infrastructure' ||
    characteristics.length === 'long'
  ) {
    return 'deep';
  }
  return 'light';
}

function chooseCodeDepth(characteristics: PromptCharacteristics, riskScore: number): CodeDepth {
  if (riskScore >= 7 || characteristics.taskType === 'infrastructure') {
    return 'deep';
  }
  if (riskScore >= 4 || characteristics.length !== 'short') {
    return 'medium';
  }
  return 'light';
}

function chooseReviewMode(characteristics: PromptCharacteristics, riskScore: number): ReviewMode {
  if (characteristics.taskType === 'documentation') return 'static';
  if (riskScore >= 6 || characteristics.taskType === 'bugfix' || characteristics.taskType === 'infrastructure') {
    return 'static+llm';
  }
  if (riskScore >= 3 || characteristics.taskType === 'feature' || characteristics.taskType === 'refactor') {
    return 'llm';
  }
  return 'static';
}

function readRoutingQuotaState(repoDir?: string): QuotaSnapshot | null {
  try {
    return readQuotaSnapshot(repoDir);
  } catch {
    console.warn('[workflow-router] Could not read quota snapshot; skipping policy resolution');
    return null;
  }
}

function resolvePolicyStagePools(
  options: RouteWorkflowOptions,
): { taskDifficulty: RoutingDifficulty; quotaState: QuotaSnapshot; policyStagePools: ReturnType<typeof buildPolicyStagePools> } | null {
  const repoDir = options.repoDir;
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  if (!taskDifficulty) {
    return null;
  }

  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return null;
  }

  const pool = getModelPool(repoDir).models;
  const policyStagePools = buildPolicyStagePools({ difficulty: taskDifficulty, quotaState, pool, repoDir });

  return { taskDifficulty, quotaState, policyStagePools };
}

function buildPolicyStagePools(params: {
  difficulty: RoutingDifficulty;
  pool: string[];
  quotaState: QuotaSnapshot;
  repoDir?: string;
}): { plannerModels: string[]; coderModels: string[]; reviewerModels: string[] } {
  const basePolicy = {
    difficulty: params.difficulty,
    quotaState: params.quotaState,
    repoDir: params.repoDir,
  } as const;
  const poolSet = new Set(params.pool);

  // Pools inherit the healthy frontier sibling substitution rule from resolveModel:
  // when top-of-ladder frontier is degrading/exhausted and a healthy frontier sibling exists,
  // non-frontier models are excluded from viable candidates
  const toPoolModels = (taskType: 'planning' | 'coding' | 'review'): string[] =>
    resolveModel({ ...basePolicy, taskType })
      .filter((candidate) => candidate.viable && poolSet.has(candidate.modelId))
      .map((candidate) => candidate.modelId);

  return {
    plannerModels: toPoolModels('planning'),
    coderModels: toPoolModels('coding'),
    reviewerModels: toPoolModels('review'),
  };
}

function highestPriorityFrontierWithStatus(
  quotaState: QuotaSnapshot,
  status: 'degrading' | 'exhausted',
  repoDir?: string,
): string | null {
  const registry = getEffectiveRegistry(repoDir);
  const ladder = getLadder(registry, 'planning');
  return (
    ladder.find((modelId) => {
      const caps = registry.models[modelId];
      return caps && caps.class === 'frontier' && quotaState.models[modelId]?.status === status;
    }) ?? null
  );
}


function logDegradedRoutingDecision(
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  repoDir?: string,
): void {
  const quotaState = readRoutingQuotaState(repoDir);
  const degradedFrontier = quotaState
    ? highestPriorityFrontierWithStatus(quotaState, mode === 'survival' ? 'exhausted' : 'degrading', repoDir)
    : null;
  const subject = degradedFrontier ?? 'frontier capacity';
  const status = mode === 'survival' ? 'exhausted' : 'degrading';
  const rationale = mode === 'survival'
    ? 'restricting routing to fast-economy models'
    : 'reserving it for high-complexity steps';

  routerLog(`${mode} mode: ${subject} quota is ${status}; ${rationale}`);
}

function logPolicyAdjustment(
  taskType: 'planning' | 'coding' | 'review',
  chosenModel: string,
  pool: string[],
  quotaState: QuotaSnapshot,
  repoDir?: string,
): void {
  const registry = getEffectiveRegistry(repoDir);
  const chosenCapabilities = registry.models[chosenModel];

  // Frontier substitution path: if chosen is healthy frontier and top-of-ladder frontier is degraded/exhausted
  if (chosenCapabilities && chosenCapabilities.class === 'frontier') {
    const chosenStatus = quotaState.models[chosenModel]?.status ?? 'healthy';
    if (chosenStatus === 'healthy') {
      const ladder = getLadder(registry, taskType);
      const topLadderFrontier = ladder.find((modelId) => {
        const caps = registry.models[modelId];
        return caps && caps.class === 'frontier';
      });

      if (topLadderFrontier && topLadderFrontier !== chosenModel) {
        const topStatus = quotaState.models[topLadderFrontier]?.status ?? 'healthy';
        if (topStatus === 'degrading' || topStatus === 'exhausted') {
          policyAdjustmentLog({
            taskType,
            fromModel: topLadderFrontier,
            toModel: chosenModel,
            metadata: [['quota', topStatus], ['same-class', 'frontier']],
          });
          return;
        }
      }
    }
  }

  // Existing path: ladder-first-in-pool logic
  const preferredModel = getLadder(registry, taskType).find((modelId) => pool.includes(modelId));
  if (!preferredModel || preferredModel === chosenModel) {
    return;
  }

  const quotaStatus = quotaState.models[preferredModel]?.status ?? 'healthy';
  if (quotaStatus === 'healthy') {
    return;
  }

  policyAdjustmentLog({
    taskType,
    fromModel: preferredModel,
    toModel: chosenModel,
    metadata: [['quota', quotaStatus]],
  });
}

function logFinalFrontierSubstitution(
  decision: Pick<WorkflowRouteDecision, 'planner' | 'coder' | 'reviewer'>,
  repoDir?: string,
): void {
  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return;
  }

  const registry = getEffectiveRegistry(repoDir);
  const stages: Array<{ taskType: 'planning' | 'coding' | 'review'; modelId: string }> = [
    { taskType: 'planning', modelId: decision.planner },
    { taskType: 'coding', modelId: decision.coder },
    { taskType: 'review', modelId: decision.reviewer },
  ];

  for (const { taskType, modelId } of stages) {
    const chosenCapabilities = registry.models[modelId];
    if (!chosenCapabilities || chosenCapabilities.class !== 'frontier') {
      continue;
    }

    const chosenStatus = quotaState.models[modelId]?.status ?? 'healthy';
    if (chosenStatus !== 'healthy') {
      continue;
    }

    const topLadderFrontier = getLadder(registry, taskType).find((candidateId) => {
      const candidateCapabilities = registry.models[candidateId];
      return candidateCapabilities && candidateCapabilities.class === 'frontier';
    });

    if (!topLadderFrontier || topLadderFrontier === modelId) {
      continue;
    }

    const topStatus = quotaState.models[topLadderFrontier]?.status ?? 'healthy';
    if (topStatus !== 'degrading' && topStatus !== 'exhausted') {
      continue;
    }

    policyAdjustmentLog({
      taskType,
      fromModel: topLadderFrontier,
      toModel: modelId,
      metadata: [['quota', topStatus], ['same-class', 'frontier']],
    });
  }
}

export function estimateStageCost(
  modelId: string,
  profile: StageTokenProfile | null,
  repoDir?: string,
): number {
  if (!profile) return 0;
  const pricing = loadPricingTable(repoDir)[modelId];
  if (!pricing) return 0;
  return roundMoney(computeModelCost(profile, pricing));
}

/**
 * Compute the absolute cheapest viable model combination from the available pool.
 * Returns null if the pool doesn't contain the minimum viable model (haiku).
 */
function getCheapestOption(
  pool: string[],
  planDepth: PlanDepth,
  codeDepth: CodeDepth,
  reviewMode: ReviewMode,
  repoDir?: string,
): { planner: string; coder: string; reviewer: string; totalCost: number } | null {
  const haiku = 'claude-haiku-4-5-20251001';
  if (!pool.includes(haiku)) {
    return null;
  }

  const planCost = estimateStageCost(haiku, PLAN_TOKENS[planDepth], repoDir);
  const codeCost = estimateStageCost(haiku, CODE_TOKENS[codeDepth], repoDir);
  const reviewCost = reviewMode === 'none'
    ? 0
    : estimateStageCost(haiku, REVIEW_TOKENS[reviewMode as Exclude<ReviewMode, 'none'>], repoDir);

  return {
    planner: haiku,
    coder: haiku,
    reviewer: haiku,
    totalCost: planCost + codeCost + reviewCost,
  };
}

function downgradeModelsForBudget(params: {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: PlanDepth;
  codeDepth: CodeDepth;
  reviewMode: ReviewMode;
  plannerPool: string[];
  coderPool: string[];
  reviewerPool: string[];
  maxCostUsd: number;
  repoDir?: string;
}): { planner: string; coder: string; reviewer: string } | null {
  const { planner, coder, reviewer, planDepth, codeDepth, reviewMode, plannerPool, coderPool, reviewerPool, maxCostUsd, repoDir } = params;

  // Define downgrade tiers for each role (most expensive to cheapest)
  const coderTiers = [
    ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'],
    ['gpt-5.3-codex', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  const plannerTiers = [
    ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  const reviewerTiers = [
    ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  // Try all combinations, starting with minimal downgrades
  for (const coderTier of coderTiers) {
    const downgradedCoder = pickAvailableModel(coderPool, coderTier, coder);
    for (const plannerTier of plannerTiers) {
      const downgradedPlanner = pickAvailableModel(plannerPool, plannerTier, planner);
      for (const reviewerTier of reviewerTiers) {
        const downgradedReviewer = pickAvailableModel(reviewerPool, reviewerTier, reviewer);

        const totalCost =
          estimateStageCost(downgradedPlanner, PLAN_TOKENS[planDepth], repoDir) +
          estimateStageCost(downgradedCoder, CODE_TOKENS[codeDepth], repoDir) +
          (reviewMode === 'none'
            ? 0
            : estimateStageCost(downgradedReviewer, REVIEW_TOKENS[reviewMode as Exclude<ReviewMode, 'none'>], repoDir));

        if (totalCost <= maxCostUsd) {
          return {
            planner: downgradedPlanner,
            coder: downgradedCoder,
            reviewer: downgradedReviewer,
          };
        }
      }
    }
  }

  // Could not find a combination within budget
  return null;
}

/**
 * Enforce a difficulty floor on a selected model.
 *
 * If the floor disallows haiku, upgrades to sonnet or opus from the pool.
 * If the floor prefers opus, upgrades when opus is available.
 */
export function applyDifficultyFloor(
  model: string,
  floor: DifficultyFloor,
  pool: string[],
  role: 'planner' | 'coder' | 'reviewer',
): string {
  const isHaiku = model.toLowerCase().includes('haiku');
  const isSonnetOrBelow = isHaiku || model.toLowerCase().includes('sonnet');

  if (!floor.allowHaiku && isHaiku) {
    // When opus is preferred (e.g. critical), try opus before sonnet
    if (floor.preferOpus) {
      const opus = pickAvailableModel(
        pool,
        ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'],
        model,
      );
      if (!opus.toLowerCase().includes('haiku')) {
        console.warn(
          `[workflow-router] Haiku rejected for ${role} (difficulty floor). Upgraded to ${opus}.`,
        );
        return opus;
      }
    }

    // Fall back to sonnet upgrade
    const upgraded = pickAvailableModel(
      pool,
      ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
      model,
    );
    console.warn(
      `[workflow-router] Haiku rejected for ${role} (difficulty floor). Upgraded to ${upgraded}.`,
    );
    return upgraded;
  }

  if (floor.preferOpus && isSonnetOrBelow) {
    const opus = pickAvailableModel(
      pool,
      ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'],
      model,
    );
    // Only upgrade if opus is actually in the pool
    if (!opus.toLowerCase().includes('haiku') && !opus.toLowerCase().includes('sonnet')) {
      return opus;
    }
  }

  return model;
}

/**
 * Resolve task difficulty for routing, using pre-classified, auto-classified, or skipped value.
 */
function resolveTaskDifficulty(options: RouteWorkflowOptions, repoDir?: string): RoutingDifficulty | undefined {
  if (options.taskDifficulty) {
    return options.taskDifficulty;
  }

  if (options.skipDifficultyClassification) {
    return undefined;
  }

  const hasClassificationInput =
    options.taskTitle || options.taskDescription || options.packetContent;

  if (!hasClassificationInput) {
    return undefined;
  }

  const difficultyConfig = getDifficultyClassifierConfig(repoDir);

  if (difficultyConfig.enabled === false) {
    return undefined;
  }

  try {
    const result = classifyTaskDifficulty({
      title: options.taskTitle,
      description: options.taskDescription,
      packetContent: options.packetContent,
      repoDir,
      model: difficultyConfig.classifierModel,
      skipLlm: difficultyConfig.skipLlm,
      cacheTtlDays: difficultyConfig.cacheTtlDays,
    });
    return result.difficulty;
  } catch {
    console.warn('[workflow-router] Difficulty classification failed, routing without floor');
    return undefined;
  }
}

function computePolicyExpectedSuccess(params: {
  plannerModel: string;
  coderModel: string;
  reviewerModel: string;
  reviewRecommended: ReviewMode;
  riskScore: number;
  repoDir?: string;
}): number {
  const registry = getEffectiveRegistry(params.repoDir);
  const qualityScores = [
    registry.models[params.plannerModel]?.qualityScores.planning ?? 0,
    registry.models[params.coderModel]?.qualityScores.coding ?? 0,
    registry.models[params.reviewerModel]?.qualityScores.review ?? 0,
  ];
  const averageScore = qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length;
  const reviewBoost = params.reviewRecommended === 'static+llm'
    ? 0.04
    : params.reviewRecommended === 'llm'
      ? 0.02
      : 0;

  return roundToHundredths(
    clamp(0.45 + averageScore / 200 + reviewBoost - params.riskScore * 0.02, 0.35, 0.97),
  );
}

function computePolicyConfidence(params: {
  plannerModel: string;
  coderModel: string;
  reviewerModel: string;
  difficulty: RoutingDifficulty;
  quotaState: QuotaSnapshot;
  riskScore: number;
}): number {
  const degradedCount = [params.plannerModel, params.coderModel, params.reviewerModel]
    .filter((modelId) => params.quotaState.models[modelId]?.status === 'degrading')
    .length;
  const difficultyPenalty =
    params.difficulty === 'critical' ? 0.12 :
    params.difficulty === 'hard' ? 0.08 :
    params.difficulty === 'moderate' ? 0.04 :
    0;

  return roundToHundredths(
    clamp(0.82 - difficultyPenalty - params.riskScore * 0.015 - degradedCount * 0.05, 0.1, 0.95),
  );
}

export function readTaskPromptFromFile(filePath: string): string {
  const content = readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    const data = JSON.parse(content);
    return `${data.title || ''}\n\n${data.description || ''}`.trim();
  }
  return content.trim();
}

export function routeWorkflow(prompt: string, options?: RouteWorkflowOptions): WorkflowRouteDecision {
  const repoDir = options?.repoDir;
  const poolResolution = getEffectiveModelPool(options);
  const pool = poolResolution.models;
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);
  const planDepth = choosePlanDepth(characteristics, riskScore);
  const codeDepth = chooseCodeDepth(characteristics, riskScore);
  const reviewRecommended = chooseReviewMode(characteristics, riskScore);

  const routerConfig = getRouterConfig(repoDir);
  const modelRouterConfig = loadRouterConfig(repoDir);
  const policyResolution = resolvePolicyStagePools(options || {});
  const plannerPoolResolution = resolveStagePool('planner', pool, routerConfig, options, policyResolution?.policyStagePools.plannerModels);
  const coderPoolResolution = resolveStagePool('coder', pool, routerConfig, options, policyResolution?.policyStagePools.coderModels);
  const reviewerPoolResolution = resolveStagePool('reviewer', pool, routerConfig, options, policyResolution?.policyStagePools.reviewerModels);
  const plannerPool = plannerPoolResolution.models;
  const coderPool = coderPoolResolution.models;
  const reviewerPool = reviewerPoolResolution.models;
  const coderRecommendation = recommendModel(prompt, {
    ...modelRouterConfig,
    repoDir,
    mode: 'heuristic',
    models: coderPool,
  });

  const planner = planDepth === 'deep'
    ? pickAvailableModel(plannerPool, ['gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel)
    : pickAvailableModel(plannerPool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel);

  const coder = codeDepth === 'deep'
    ? pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, 'gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'], coderRecommendation.recommendedModel)
    : codeDepth === 'medium'
      ? pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'], coderRecommendation.recommendedModel)
      : pickAvailableModel(coderPool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-haiku-4-5-20251001'], coderRecommendation.recommendedModel);

  const reviewer = reviewRecommended === 'static+llm'
    ? pickAvailableModel(reviewerPool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'gpt-5.5', 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4', planner], planner)
    : reviewRecommended === 'llm'
      ? pickAvailableModel(reviewerPool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', planner], planner)
      : pickAvailableModel(reviewerPool, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', planner], planner);

  // Enforce difficulty floor
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  let finalPlanner = planner;
  let finalCoder = coder;
  let finalReviewer = reviewer;
  let difficultyFloorApplied = false;

  if (taskDifficulty) {
    const floor = getAllowedModelFloor(taskDifficulty);
    const newPlanner = applyDifficultyFloor(planner, floor, plannerPool, 'planner');
    const newCoder = applyDifficultyFloor(coder, floor, coderPool, 'coder');
    const newReviewer = applyDifficultyFloor(reviewer, floor, reviewerPool, 'reviewer');

    if (newPlanner !== planner || newCoder !== coder || newReviewer !== reviewer) {
      difficultyFloorApplied = true;
    }

    finalPlanner = newPlanner;
    finalCoder = newCoder;
    finalReviewer = newReviewer;
  }

  // Enforce budget constraint (use mode-specific budget if not explicitly provided)
  let budgetAdjustmentApplied = false;
  let budgetViolation: BudgetViolation | undefined;

  const mode = getCurrentOperatingMode(repoDir);
  const budgetConfig = getBudgetConfig(repoDir);
  const effectiveBudget = options?.maxCostUsd ?? (
    mode === 'survival' ? budgetConfig.survivalMode :
    mode === 'constrained' ? budgetConfig.constrainedMode :
    budgetConfig.normalMode
  );

  const initialCost =
    estimateStageCost(finalPlanner, PLAN_TOKENS[planDepth], repoDir) +
    estimateStageCost(finalCoder, CODE_TOKENS[codeDepth], repoDir) +
    (reviewRecommended === 'none'
      ? 0
      : estimateStageCost(finalReviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir));

  if (initialCost > effectiveBudget) {
    // Try downgrading models to fit within budget
    const downgradedModels = downgradeModelsForBudget({
      planner: finalPlanner,
      coder: finalCoder,
      reviewer: finalReviewer,
      planDepth,
      codeDepth,
      reviewMode: reviewRecommended,
      plannerPool,
      coderPool,
      reviewerPool,
      maxCostUsd: effectiveBudget,
      repoDir,
    });

    if (downgradedModels) {
      finalPlanner = downgradedModels.planner;
      finalCoder = downgradedModels.coder;
      finalReviewer = downgradedModels.reviewer;
      budgetAdjustmentApplied = true;
    } else {
      // Cannot fit budget - record violation
      const cheapestOption = getCheapestOption(pool, planDepth, codeDepth, reviewRecommended, repoDir);
      budgetViolation = {
        requestedCost: initialCost,
        maxCostUsd: effectiveBudget,
        operatingMode: mode,
        attemptedDowngrade: true,
        cheapestViableOption: cheapestOption,
      };
    }
  }

  const confidenceBoost =
    coderRecommendation.confidence === 'high' ? 0.08 :
    coderRecommendation.confidence === 'medium' ? 0.03 : -0.04;

  const expectedSuccess = Number(
    clamp(
      0.84
      + confidenceBoost
      - riskScore * 0.035
      + (reviewRecommended === 'static+llm' ? 0.05 : reviewRecommended === 'llm' ? 0.02 : 0)
      + (planDepth === 'deep' ? 0.03 : 0),
      0.35,
      0.97,
    ).toFixed(2)
  );
  const confidence = computeHeuristicConfidence(coderRecommendation.confidence, riskScore);

  const reasoning = [
    `Task classified as ${characteristics.taskType} with ${characteristics.length} prompt length.`,
    `Risk score ${riskScore} from complexity, scope, and repo-surface keywords.`,
    `Coder baseline uses ${coderRecommendation.recommendedModel} from heuristic eval routing.`,
    `Review mode ${reviewRecommended} chosen to match expected change risk.`,
  ];

  if (taskDifficulty) {
    const floor = getAllowedModelFloor(taskDifficulty);
    const floorSummary = floor.preferOpus
      ? 'opus preferred, never haiku alone'
      : floor.allowHaiku
        ? `sonnet preferred${floor.preferSonnet ? ', haiku allowed' : ''}`
        : 'sonnet floor, haiku rejected';
    reasoning.push(`Task classified as ${taskDifficulty} — model floor applied: ${floorSummary}.`);
  }

  if (budgetAdjustmentApplied) {
    reasoning.push(`Models downgraded to fit within $${effectiveBudget.toFixed(2)} budget constraint (${mode} mode).`);
  }

  if (budgetViolation) {
    reasoning.push(
      `⚠️ BUDGET VIOLATION: Estimated cost $${budgetViolation.requestedCost.toFixed(2)} exceeds ${mode} mode budget $${effectiveBudget.toFixed(2)}. ` +
      `No cheaper model combination available. Task routing may fail.`
    );
  }

  reasoning.push(...mergePoolWarnings(
    poolResolution,
    plannerPoolResolution,
    coderPoolResolution,
    reviewerPoolResolution,
  ));

  return {
    planner: finalPlanner,
    coder: finalCoder,
    reviewer: finalReviewer,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    confidence,
    expectedCostPlan: estimateStageCost(finalPlanner, PLAN_TOKENS[planDepth], repoDir),
    expectedCostCode: estimateStageCost(finalCoder, CODE_TOKENS[codeDepth], repoDir),
    expectedCostReview: reviewRecommended === 'none'
      ? 0
      : estimateStageCost(finalReviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir),
    reasoning,
    signals: {
      taskType: characteristics.taskType,
      promptLength: characteristics.length,
      complexityScore: characteristics.complexityScore,
      fileTypes: characteristics.fileTypes,
      riskScore,
      ...(taskDifficulty ? { taskDifficulty } : {}),
    },
    constraints: { maxCostUsd: effectiveBudget },
    routingMode: 'heuristic',
    ...(budgetViolation ? { budgetViolation } : {}),
    ...(coderRecommendation.resourceSelections?.length
      ? { resourceSelections: coderRecommendation.resourceSelections }
      : {}),
  };
}

function routeWorkflowStageAwareInternal(
  prompt: string,
  options?: RouteWorkflowOptions,
  stageAwareContext?: StageAwareRouterContext,
): StageAwareDecision {
  const repoDir = options?.repoDir;
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);

  // Resolve difficulty and policy pools before stage-aware routing
  // so both KNN selection and difficulty floor application respect frontier substitution
  const policyResolution = resolvePolicyStagePools(options || {});
  const taskDifficulty = policyResolution?.taskDifficulty || resolveTaskDifficulty(options || {}, repoDir);

  let stageAwareDecision;
  try {
    const stageAwareOptions = {
      repoDir,
      modelsAvailable: options?.modelsAvailable,
      plannerModelsAvailable: policyResolution?.policyStagePools.plannerModels,
      coderModelsAvailable: policyResolution?.policyStagePools.coderModels,
      reviewerModelsAvailable: policyResolution?.policyStagePools.reviewerModels,
      maxCostUsd: options?.maxCostUsd,
      additionalEvalsPaths: options?.additionalEvalsPaths,
    };
    stageAwareDecision = stageAwareContext
      ? routeStageAwareWithContext(prompt, stageAwareContext, stageAwareOptions)
      : routeStageAware(prompt, stageAwareOptions);
  } catch (error) {
    console.warn('[workflow-router] Stage-aware routing failed, falling back to heuristic:', error);
    stageAwareDecision = null;
  }

  const baseSignals = {
    taskType: characteristics.taskType,
    promptLength: characteristics.length,
    complexityScore: characteristics.complexityScore,
    fileTypes: characteristics.fileTypes,
    riskScore,
    ...(taskDifficulty ? { taskDifficulty } : {}),
  } as const;

  let decision: StageAwareDecision;
  if (!stageAwareDecision) {
    const fallback = routeWorkflow(prompt, options);
    decision = {
      ...fallback,
      confidence: roundToHundredths(Math.max(0.1, fallback.confidence - 0.1)),
      routingMode: 'heuristic-fallback',
      neighborCount: 0,
      neighborSimilarityRange: [0, 0],
      expectedCost: Number(
        (fallback.expectedCostPlan + fallback.expectedCostCode + fallback.expectedCostReview).toFixed(2)
      ),
    };
  } else if (stageAwareDecision.routingMode === 'stage-aware-partial') {
    // Neighbors lacked model diversity — use neighbor-calibrated stage depths
    // and cost estimates, but overlay heuristic model selection.
    const fallback = routeWorkflow(prompt, options);

    // Apply difficulty floors to stage-aware partial models, using substitution-aware pool
    let finalPlanner = fallback.planner;
    let finalCoder = fallback.coder;
    let finalReviewer = fallback.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      // Use policy-filtered pool if available, otherwise full pool
      const floorPool = policyResolution?.policyStagePools
        ? filterProviderPool([
            ...new Set([
              ...policyResolution.policyStagePools.plannerModels,
              ...policyResolution.policyStagePools.coderModels,
              ...policyResolution.policyStagePools.reviewerModels,
            ]),
          ], repoDir).models
        : getModelPool(repoDir).models;
      finalPlanner = applyDifficultyFloor(fallback.planner, floor, floorPool, 'planner');
      finalCoder = applyDifficultyFloor(fallback.coder, floor, floorPool, 'coder');
      finalReviewer = applyDifficultyFloor(fallback.reviewer, floor, floorPool, 'reviewer');
    }

    decision = {
      ...stageAwareDecision,
      planner: finalPlanner,
      coder: finalCoder,
      reviewer: finalReviewer,
      confidence: normalizeDecisionConfidence(stageAwareDecision.confidence),
      signals: baseSignals,
    };
  } else {
    // Apply difficulty floors to fully stage-aware models, using substitution-aware pool
    let saPlanner = stageAwareDecision.planner;
    let saCoder = stageAwareDecision.coder;
    let saReviewer = stageAwareDecision.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      // Use policy-filtered pool if available, otherwise full pool
      const floorPool = policyResolution?.policyStagePools
        ? filterProviderPool([
            ...new Set([
              ...policyResolution.policyStagePools.plannerModels,
              ...policyResolution.policyStagePools.coderModels,
              ...policyResolution.policyStagePools.reviewerModels,
            ]),
          ], repoDir).models
        : getModelPool(repoDir).models;
      saPlanner = applyDifficultyFloor(stageAwareDecision.planner, floor, floorPool, 'planner');
      saCoder = applyDifficultyFloor(stageAwareDecision.coder, floor, floorPool, 'coder');
      saReviewer = applyDifficultyFloor(stageAwareDecision.reviewer, floor, floorPool, 'reviewer');
    }

    decision = {
      ...stageAwareDecision,
      planner: saPlanner,
      coder: saCoder,
      reviewer: saReviewer,
      confidence: normalizeDecisionConfidence(stageAwareDecision.confidence),
      signals: baseSignals,
    };
  }

  const finalDecision = withChallengeRecommendation(decision, repoDir);
  registerWorkflowDecisionResources(finalDecision, repoDir);
  return finalDecision;
}

export function routeWorkflowStageAware(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision {
  return routeWorkflowStageAwareInternal(prompt, options);
}

export function routeWorkflowStageAwareWithContext(
  prompt: string,
  options: RouteWorkflowOptions | undefined,
  stageAwareContext: StageAwareRouterContext,
): StageAwareDecision {
  return routeWorkflowStageAwareInternal(prompt, options, stageAwareContext);
}

function buildDegradedModelPool(
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  repoDir?: string,
): string[] {
  const registry = getEffectiveRegistry(repoDir);
  const allowedClasses: ModelClass[] = mode === 'survival'
    ? ['fast_economy']
    : ['strong_generalist', 'fast_economy'];

  const pool = Object.entries(registry.models)
    .filter(([, capabilities]) => allowedClasses.includes(capabilities.class))
    .map(([modelId]) => modelId);
  const filteredPool = filterProviderPool(pool, repoDir).models;

  if (filteredPool.length > 0) {
    return filteredPool;
  }

  console.warn(
    `[workflow-router] No degraded model pool available for ${mode} mode; falling back to full routing pool.`,
  );
  return getModelPool(repoDir).models;
}

function prependReasoning(
  decision: StageAwareDecision,
  rationale: string,
): StageAwareDecision {
  return {
    ...decision,
    reasoning: [rationale, ...decision.reasoning],
  };
}

function registerWorkflowDecisionResources(
  decision: WorkflowRouteDecision,
  repoDir?: string,
): void {
  const sessionId = process.env.WAVEMILL_SESSION;
  if (!sessionId) {
    return;
  }
  const routerConfig = loadRouterConfig(repoDir);
  const agentMap = routerConfig.agentMap || {};
  const defaultAgent = routerConfig.defaultAgent || 'claude';

  for (const [phase, model] of [
    ['planning', decision.planner],
    ['coding', decision.coder],
    ['review', decision.reviewer],
  ] as const) {
    const ref = registerAgentConfig({
      phase,
      model,
      cliCmd: resolveAgent(model, agentMap, defaultAgent),
      repoDir,
    });
    if (ref) {
      recordUse(sessionId, phase, ref, repoDir);
    }
  }

  for (const selection of decision.resourceSelections || []) {
    if (selection.resourceRef) {
      const resourcePhase =
        selection.surface === 'router' ? 'planning' :
        selection.surface === 'planner' ? 'planning' :
        selection.surface === 'reviewer' ? 'review' :
        'coding';
      recordUse(sessionId, resourcePhase, selection.resourceRef, repoDir);
    }
  }
}

function routeWorkflowDegradedInternal(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  stageAwareContext?: StageAwareRouterContext,
): StageAwareDecision {
  logDegradedRoutingDecision(mode, options.repoDir);
  const degradedPool = buildDegradedModelPool(mode, options.repoDir);

  // Apply mode-specific budget if not explicitly provided
  const budgetConfig = getBudgetConfig(options.repoDir);
  const modeBudget = mode === 'survival'
    ? budgetConfig.survivalMode
    : budgetConfig.constrainedMode;

  const degradedOptions: RouteWorkflowOptions = {
    ...options,
    modelsAvailable: degradedPool,
    skipDifficultyClassification: true,
    maxCostUsd: options.maxCostUsd ?? modeBudget,
  };
  const rationale = mode === 'survival'
    ? 'Survival mode: frontier models exhausted. Restricted to haiku. KNN signal used without LLM reasoning.'
    : 'Constrained mode: frontier models degrading. Restricted to sonnet/haiku and KNN signal. LLM difficulty classification skipped.';

  return prependReasoning(
    stageAwareContext
      ? routeWorkflowStageAwareWithContext(prompt, degradedOptions, stageAwareContext)
      : routeWorkflowStageAware(prompt, degradedOptions),
    rationale,
  );
}

export function routeWorkflowDegraded(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
): StageAwareDecision {
  return routeWorkflowDegradedInternal(prompt, options, mode);
}

export function routeWorkflowDegradedWithContext(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
  stageAwareContext: StageAwareRouterContext,
): StageAwareDecision {
  return routeWorkflowDegradedInternal(prompt, options, mode, stageAwareContext);
}

export function tryPolicyResolution(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision | null {
  const repoDir = options?.repoDir;
  const routerConfig = loadRouterConfig(repoDir);
  validateDeepSeekPool(routerConfig.models, repoDir);
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  if (!taskDifficulty) {
    return null;
  }

  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return null;
  }

  const pool = getModelPool(repoDir).models;
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);
  const planDepth = choosePlanDepth(characteristics, riskScore);
  const codeDepth = chooseCodeDepth(characteristics, riskScore);
  const reviewRecommended = chooseReviewMode(characteristics, riskScore);
  const basePolicy = {
    difficulty: taskDifficulty,
    quotaState,
    repoDir,
  } as const;

  const plannerModel = topViableCandidate({ ...basePolicy, taskType: 'planning' }, pool);
  const coderModel = topViableCandidate({ ...basePolicy, taskType: 'coding' }, pool);
  const reviewerModel = topViableCandidate({ ...basePolicy, taskType: 'review' }, pool);

  if (!plannerModel || !coderModel || !reviewerModel) {
    console.warn(
      '[workflow-router] Policy resolver found no viable candidate for one or more roles; falling through to stage-aware',
    );
    return null;
  }

  logPolicyAdjustment('planning', plannerModel, pool, quotaState, repoDir);
  logPolicyAdjustment('coding', coderModel, pool, quotaState, repoDir);
  logPolicyAdjustment('review', reviewerModel, pool, quotaState, repoDir);

  const expectedCostPlan = estimateStageCost(plannerModel, PLAN_TOKENS[planDepth], repoDir);
  const expectedCostCode = estimateStageCost(coderModel, CODE_TOKENS[codeDepth], repoDir);
  const expectedCostReview = reviewRecommended === 'none'
    ? 0
    : estimateStageCost(reviewerModel, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir);
  const expectedSuccess = computePolicyExpectedSuccess({
    plannerModel,
    coderModel,
    reviewerModel,
    reviewRecommended,
    riskScore,
    repoDir,
  });
  const confidence = computePolicyConfidence({
    plannerModel,
    coderModel,
    reviewerModel,
    difficulty: taskDifficulty,
    quotaState,
    riskScore,
  });

  return {
    planner: plannerModel,
    coder: coderModel,
    reviewer: reviewerModel,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    confidence,
    expectedCostPlan,
    expectedCostCode,
    expectedCostReview,
    reasoning: [
      'Policy resolver selected models using registry capability scores and quota state.',
      `Task difficulty ${taskDifficulty} applied the routing floor before ranking candidates.`,
      `Planner=${plannerModel}, coder=${coderModel}, reviewer=${reviewerModel} are the top viable in-pool candidates.`,
      `Risk score ${riskScore} from complexity, scope, and repo-surface keywords.`,
    ],
    signals: {
      taskType: characteristics.taskType,
      promptLength: characteristics.length,
      complexityScore: characteristics.complexityScore,
      fileTypes: characteristics.fileTypes,
      riskScore,
      taskDifficulty,
    },
    routingMode: 'policy',
    neighborCount: 0,
    neighborSimilarityRange: [0, 0],
    expectedCost: Number((expectedCostPlan + expectedCostCode + expectedCostReview).toFixed(2)),
    constraints: options?.maxCostUsd === undefined
      ? undefined
      : { maxCostUsd: options.maxCostUsd },
  };
}

export async function routeWorkflowHokusai(
  prompt: string,
  options?: RouteWorkflowOptions,
): Promise<StageAwareDecision> {
  const repoDir = options?.repoDir;
  const policyResolution = resolvePolicyStagePools(options || {});
  const taskDifficulty = policyResolution?.taskDifficulty || resolveTaskDifficulty(options || {}, repoDir);
  const decision = await routeViaHokusai(prompt, {
    ...options,
    plannerModels: policyResolution?.policyStagePools.plannerModels,
    coderModels: policyResolution?.policyStagePools.coderModels,
    reviewerModels: policyResolution?.policyStagePools.reviewerModels,
  });
  if (!decision) {
    return routeWorkflowStageAware(prompt, options);
  }

  const enriched = withSignals(decision, prompt, taskDifficulty);
  const finalDecision = withChallengeRecommendation({
    ...enriched,
    reasoning: policyResolution
      ? [
          ...enriched.reasoning,
          `Hokusai input used policy-filtered candidate pools for ${taskDifficulty} difficulty.`,
        ]
      : enriched.reasoning,
    routingMode: 'hokusai',
    neighborCount: 0,
    neighborSimilarityRange: [0, 0],
    expectedCost: Number(
      (enriched.expectedCostPlan + enriched.expectedCostCode + enriched.expectedCostReview).toFixed(2)
    ),
  }, repoDir);
  registerWorkflowDecisionResources(finalDecision, repoDir);
  return finalDecision;
}

export async function routeWorkflowAuto(
  prompt: string,
  options?: RouteWorkflowOptions,
): Promise<StageAwareDecision> {
  return routeWorkflowAutoWithContext(prompt, options);
}

export async function routeWorkflowAutoWithContext(
  prompt: string,
  options?: RouteWorkflowOptions,
  context?: {
    operatingMode?: OperatingMode;
    stageAwareContext?: StageAwareRouterContext;
  },
): Promise<StageAwareDecision> {
  const operatingMode = context?.operatingMode ?? getCurrentOperatingMode(options?.repoDir);
  if (operatingMode === 'constrained' || operatingMode === 'survival') {
    return context?.stageAwareContext
      ? routeWorkflowDegradedWithContext(prompt, options, operatingMode, context.stageAwareContext)
      : routeWorkflowDegraded(prompt, options, operatingMode);
  }

  const hokusaiConfig = getHokusaiRouterConfig(options?.repoDir);
  if (hokusaiConfig.endpoint) {
    const decision = await routeWorkflowHokusai(prompt, options);
    if (decision.routingMode === 'hokusai') {
      routerLog(`hokusai routing active: planner=${decision.planner} coder=${decision.coder} reviewer=${decision.reviewer}`);
    }
    if (decision.routingMode !== 'policy') {
      logFinalFrontierSubstitution(decision, options?.repoDir);
    }
    return decision;
  }

  const policyDecision = tryPolicyResolution(prompt, options);
  if (policyDecision) {
    const finalDecision = withChallengeRecommendation(policyDecision, options?.repoDir);
    registerWorkflowDecisionResources(finalDecision, options?.repoDir);
    return finalDecision;
  }

  const decision = context?.stageAwareContext
    ? routeWorkflowStageAwareWithContext(prompt, options, context.stageAwareContext)
    : routeWorkflowStageAware(prompt, options);
  logFinalFrontierSubstitution(decision, options?.repoDir);
  return decision;
}

export function summarizeWorkflowRoute(decision: WorkflowRouteDecision, repoDir?: string): string {
  const routerConfig = loadRouterConfig(repoDir);
  const defaultAgent = routerConfig.defaultAgent || 'claude';
  const agentMap = routerConfig.agentMap || {};

  const plannerAgent = resolveAgent(decision.planner, agentMap, defaultAgent, repoDir);
  const coderAgent = resolveAgent(decision.coder, agentMap, defaultAgent, repoDir);
  const reviewerAgent = resolveAgent(decision.reviewer, agentMap, defaultAgent, repoDir);

  const difficultySuffix = decision.signals.taskDifficulty
    ? `  difficulty=${decision.signals.taskDifficulty}`
    : '';

  const lines = [
    `Planner:  ${decision.planner} (${plannerAgent})  depth=${decision.planDepth}  cost=$${decision.expectedCostPlan.toFixed(2)}`,
    `Coder:    ${decision.coder} (${coderAgent})  depth=${decision.codeDepth}  cost=$${decision.expectedCostCode.toFixed(2)}`,
    `Reviewer: ${decision.reviewer} (${reviewerAgent})  mode=${decision.reviewRecommended}  cost=$${decision.expectedCostReview.toFixed(2)}`,
    `Success:  ${(decision.expectedSuccess * 100).toFixed(0)}%  confidence=${decision.confidence.toFixed(2)}  task=${decision.signals.taskType}  risk=${decision.signals.riskScore}${difficultySuffix}`,
    `Signals:  ${decision.reasoning[0]} ${decision.reasoning[1]}`,
  ];

  if (
    'routingMode' in decision
    && typeof (decision as { neighborCount?: unknown }).neighborCount === 'number'
    && Array.isArray((decision as { neighborSimilarityRange?: unknown }).neighborSimilarityRange)
  ) {
    lines.push(
      `Router:   ${decision.routingMode}  neighbors=${decision.neighborCount}  similarity=${decision.neighborSimilarityRange[0].toFixed(2)}-${decision.neighborSimilarityRange[1].toFixed(2)}`
    );
  }

  if (decision.challengeRecommendation?.shouldChallenge) {
    const recommendation = decision.challengeRecommendation;
    const stageSuffix = recommendation.stage ? `  stage=${recommendation.stage}` : '';
    lines.push(
      `Challenge: ${recommendation.reason}  ${recommendation.defaultModel || 'unknown'} vs ${recommendation.challengerModel || 'unknown'}${stageSuffix}`
    );
  }

  return lines.join('\n');
}
