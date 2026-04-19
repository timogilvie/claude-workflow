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
import { getChallengeSchedulerConfig, getDifficultyClassifierConfig, getHokusaiRouterConfig } from './config.ts';
import { routeViaHokusai } from './hokusai-router.ts';
import { analyzePrompt, loadRouterConfig, recommendModel, resolveAgent, type PromptCharacteristics, type TaskType } from './model-router.ts';
import { getEffectiveRegistry } from './model-registry.ts';
import { readQuotaSnapshot, type QuotaSnapshot } from './quota-state.ts';
import { resolveModel, topViableCandidate } from './routing-policy.ts';
import { classifyTaskDifficulty, getAllowedModelFloor, type DifficultyFloor, type RoutingDifficulty } from './task-difficulty-classifier.ts';
import { loadPricingTable, computeModelCost } from './workflow-cost.ts';
import { routeStageAware, type StageAwareDecision } from './stage-aware-router.ts';
import { getCurrentOperatingMode, type OperatingMode } from './operating-mode.ts';
import type { ModelClass } from './model-registry.ts';

export type PlanDepth = 'light' | 'medium' | 'deep';
export type CodeDepth = 'light' | 'medium' | 'deep';
export type ReviewMode = 'none' | 'static' | 'llm' | 'static+llm';

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
}

export interface RouteWorkflowOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  maxCostUsd?: number;
  taskDifficulty?: RoutingDifficulty;
  taskTitle?: string;
  taskDescription?: string;
  packetContent?: string;
  skipDifficultyClassification?: boolean;
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
  'gpt-5.3-codex',
  'gpt-5.4',
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

function getModelPool(repoDir?: string): string[] {
  const routerConfig = loadRouterConfig(repoDir);
  const pricingModels = Object.keys(loadPricingTable(repoDir));
  return [...new Set([
    ...(routerConfig.models || []),
    ...pricingModels,
    ...DEFAULT_MODEL_POOL,
  ])];
}

function getEffectiveModelPool(options?: RouteWorkflowOptions): string[] {
  if (options?.modelsAvailable && options.modelsAvailable.length > 0) {
    return [...new Set(options.modelsAvailable)];
  }

  return getModelPool(options?.repoDir);
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

function downgradeModelsForBudget(params: {
  planner: string;
  coder: string;
  reviewer: string;
  planDepth: PlanDepth;
  codeDepth: CodeDepth;
  reviewMode: ReviewMode;
  pool: string[];
  maxCostUsd: number;
  repoDir?: string;
}): { planner: string; coder: string; reviewer: string } | null {
  const { planner, coder, reviewer, planDepth, codeDepth, reviewMode, pool, maxCostUsd, repoDir } = params;

  // Define downgrade tiers for each role (most expensive to cheapest)
  const coderTiers = [
    ['claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'],
    ['gpt-5.3-codex', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  const plannerTiers = [
    ['claude-opus-4-7', 'claude-opus-4-6'],
    ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  const reviewerTiers = [
    ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'],
    ['claude-haiku-4-5-20251001'],
  ];

  // Try all combinations, starting with minimal downgrades
  for (const coderTier of coderTiers) {
    const downgradedCoder = pickAvailableModel(pool, coderTier, coder);
    for (const plannerTier of plannerTiers) {
      const downgradedPlanner = pickAvailableModel(pool, plannerTier, planner);
      for (const reviewerTier of reviewerTiers) {
        const downgradedReviewer = pickAvailableModel(pool, reviewerTier, reviewer);

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
        ['claude-opus-4-7', 'claude-opus-4-6'],
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
      ['claude-opus-4-7', 'claude-opus-4-6'],
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
  const pool = getEffectiveModelPool(options);
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);
  const planDepth = choosePlanDepth(characteristics, riskScore);
  const codeDepth = chooseCodeDepth(characteristics, riskScore);
  const reviewRecommended = chooseReviewMode(characteristics, riskScore);

  const routerConfig = loadRouterConfig(repoDir);
  const coderRecommendation = recommendModel(prompt, {
    ...routerConfig,
    repoDir,
    mode: 'heuristic',
    models: pool,
  });

  const planner = planDepth === 'deep'
    ? pickAvailableModel(pool, ['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel)
    : pickAvailableModel(pool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel);

  const coder = codeDepth === 'deep'
    ? pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'claude-opus-4-7', 'claude-opus-4-6', 'gpt-5.4'], coderRecommendation.recommendedModel)
    : codeDepth === 'medium'
      ? pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929'], coderRecommendation.recommendedModel)
      : pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-haiku-4-5-20251001'], coderRecommendation.recommendedModel);

  const reviewer = reviewRecommended === 'static+llm'
    ? pickAvailableModel(pool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-opus-4-7', 'claude-opus-4-6', planner], planner)
    : reviewRecommended === 'llm'
      ? pickAvailableModel(pool, ['claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', planner], planner)
      : pickAvailableModel(pool, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6', 'claude-sonnet-4-5-20250929', planner], planner);

  // Enforce difficulty floor
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  let finalPlanner = planner;
  let finalCoder = coder;
  let finalReviewer = reviewer;
  let difficultyFloorApplied = false;

  if (taskDifficulty) {
    const floor = getAllowedModelFloor(taskDifficulty);
    const newPlanner = applyDifficultyFloor(planner, floor, pool, 'planner');
    const newCoder = applyDifficultyFloor(coder, floor, pool, 'coder');
    const newReviewer = applyDifficultyFloor(reviewer, floor, pool, 'reviewer');

    if (newPlanner !== planner || newCoder !== coder || newReviewer !== reviewer) {
      difficultyFloorApplied = true;
    }

    finalPlanner = newPlanner;
    finalCoder = newCoder;
    finalReviewer = newReviewer;
  }

  // Enforce budget constraint if provided
  let budgetAdjustmentApplied = false;

  if (typeof options?.maxCostUsd === 'number') {
    const initialCost =
      estimateStageCost(planner, PLAN_TOKENS[planDepth], repoDir) +
      estimateStageCost(coder, CODE_TOKENS[codeDepth], repoDir) +
      (reviewRecommended === 'none'
        ? 0
        : estimateStageCost(reviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir));

    if (initialCost > options.maxCostUsd) {
      // Try downgrading models to fit within budget
      const downgradedModels = downgradeModelsForBudget({
        planner,
        coder,
        reviewer,
        planDepth,
        codeDepth,
        reviewMode: reviewRecommended,
        pool,
        maxCostUsd: options.maxCostUsd,
        repoDir,
      });

      if (downgradedModels) {
        finalPlanner = downgradedModels.planner;
        finalCoder = downgradedModels.coder;
        finalReviewer = downgradedModels.reviewer;
        budgetAdjustmentApplied = true;
      }
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
    reasoning.push(`Models downgraded to fit within $${options!.maxCostUsd} budget constraint.`);
  }

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
    constraints: options?.maxCostUsd === undefined
      ? undefined
      : { maxCostUsd: options.maxCostUsd },
  };
}

export function routeWorkflowStageAware(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision {
  const repoDir = options?.repoDir;
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);

  // Resolve difficulty before stage-aware routing so floor can be applied
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);

  let stageAwareDecision;
  try {
    stageAwareDecision = routeStageAware(prompt, {
      repoDir,
      modelsAvailable: options?.modelsAvailable,
      maxCostUsd: options?.maxCostUsd,
    });
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

    // Apply difficulty floors to stage-aware partial models
    let finalPlanner = fallback.planner;
    let finalCoder = fallback.coder;
    let finalReviewer = fallback.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      const pool = getModelPool(repoDir);
      finalPlanner = applyDifficultyFloor(fallback.planner, floor, pool, 'planner');
      finalCoder = applyDifficultyFloor(fallback.coder, floor, pool, 'coder');
      finalReviewer = applyDifficultyFloor(fallback.reviewer, floor, pool, 'reviewer');
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
    // Apply difficulty floors to fully stage-aware models
    let saPlanner = stageAwareDecision.planner;
    let saCoder = stageAwareDecision.coder;
    let saReviewer = stageAwareDecision.reviewer;
    if (taskDifficulty) {
      const floor = getAllowedModelFloor(taskDifficulty);
      const pool = getModelPool(repoDir);
      saPlanner = applyDifficultyFloor(stageAwareDecision.planner, floor, pool, 'planner');
      saCoder = applyDifficultyFloor(stageAwareDecision.coder, floor, pool, 'coder');
      saReviewer = applyDifficultyFloor(stageAwareDecision.reviewer, floor, pool, 'reviewer');
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

  return withChallengeRecommendation(decision, repoDir);
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

  if (pool.length > 0) {
    return pool;
  }

  console.warn(
    `[workflow-router] No degraded model pool available for ${mode} mode; falling back to full routing pool.`,
  );
  return getModelPool(repoDir);
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

export function routeWorkflowDegraded(
  prompt: string,
  options: RouteWorkflowOptions = {},
  mode: Extract<OperatingMode, 'constrained' | 'survival'>,
): StageAwareDecision {
  const degradedPool = buildDegradedModelPool(mode, options.repoDir);
  const degradedOptions: RouteWorkflowOptions = {
    ...options,
    modelsAvailable: degradedPool,
    skipDifficultyClassification: true,
  };
  const rationale = mode === 'survival'
    ? 'Survival mode: frontier models exhausted. Restricted to haiku. KNN signal used without LLM reasoning.'
    : 'Constrained mode: frontier models degrading. Restricted to sonnet/haiku and KNN signal. LLM difficulty classification skipped.';

  return prependReasoning(
    routeWorkflowStageAware(prompt, degradedOptions),
    rationale,
  );
}

export function tryPolicyResolution(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision | null {
  const repoDir = options?.repoDir;
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  if (!taskDifficulty) {
    return null;
  }

  const quotaState = readRoutingQuotaState(repoDir);
  if (!quotaState) {
    return null;
  }

  const pool = getModelPool(repoDir);
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
  const taskDifficulty = resolveTaskDifficulty(options || {}, repoDir);
  const quotaState = taskDifficulty ? readRoutingQuotaState(repoDir) : null;
  const pool = getModelPool(repoDir);
  const policyStagePools = taskDifficulty && quotaState
    ? buildPolicyStagePools({ difficulty: taskDifficulty, quotaState, pool, repoDir })
    : null;
  const decision = await routeViaHokusai(prompt, {
    ...options,
    plannerModels: policyStagePools?.plannerModels,
    coderModels: policyStagePools?.coderModels,
    reviewerModels: policyStagePools?.reviewerModels,
  });
  if (!decision) {
    return routeWorkflowStageAware(prompt, options);
  }

  const enriched = withSignals(decision, prompt, taskDifficulty);
  return withChallengeRecommendation({
    ...enriched,
    reasoning: policyStagePools
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
}

export async function routeWorkflowAuto(
  prompt: string,
  options?: RouteWorkflowOptions,
): Promise<StageAwareDecision> {
  const operatingMode = getCurrentOperatingMode(options?.repoDir);
  if (operatingMode === 'constrained' || operatingMode === 'survival') {
    return routeWorkflowDegraded(prompt, options, operatingMode);
  }

  const hokusaiConfig = getHokusaiRouterConfig(options?.repoDir);
  if (hokusaiConfig.endpoint) {
    return routeWorkflowHokusai(prompt, options);
  }

  const policyDecision = tryPolicyResolution(prompt, options);
  if (policyDecision) {
    return withChallengeRecommendation(policyDecision, options?.repoDir);
  }

  return routeWorkflowStageAware(prompt, options);
}

export function summarizeWorkflowRoute(decision: WorkflowRouteDecision, repoDir?: string): string {
  const routerConfig = loadRouterConfig(repoDir);
  const defaultAgent = routerConfig.defaultAgent || 'claude';
  const agentMap = routerConfig.agentMap || {};

  const plannerAgent = resolveAgent(decision.planner, agentMap, defaultAgent);
  const coderAgent = resolveAgent(decision.coder, agentMap, defaultAgent);
  const reviewerAgent = resolveAgent(decision.reviewer, agentMap, defaultAgent);

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

  if ('routingMode' in decision) {
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
