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
import { getChallengeSchedulerConfig } from './config.ts';
import { analyzePrompt, loadRouterConfig, recommendModel, resolveAgent, type PromptCharacteristics, type TaskType } from './model-router.ts';
import { loadPricingTable, computeModelCost } from './workflow-cost.ts';
import { routeStageAware, type StageAwareDecision } from './stage-aware-router.ts';

export type PlanDepth = 'light' | 'deep';
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
  reasoning: string[];
  signals: {
    taskType: TaskType;
    promptLength: PromptCharacteristics['length'];
    complexityScore: number;
    fileTypes: string[];
    riskScore: number;
  };
  challengeRecommendation?: ChallengeRecommendation;
}

export interface RouteWorkflowOptions {
  repoDir?: string;
  modelsAvailable?: string[];
  maxCostUsd?: number;
}

const DEFAULT_MODEL_POOL = [
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

interface StageTokenProfile {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

const PLAN_TOKENS: Record<PlanDepth, StageTokenProfile> = {
  light: { inputTokens: 35_000, cacheCreationTokens: 10_000, cacheReadTokens: 20_000, outputTokens: 5_000 },
  deep: { inputTokens: 180_000, cacheCreationTokens: 60_000, cacheReadTokens: 140_000, outputTokens: 18_000 },
};

const CODE_TOKENS: Record<CodeDepth, StageTokenProfile> = {
  light: { inputTokens: 220_000, cacheCreationTokens: 80_000, cacheReadTokens: 180_000, outputTokens: 12_000 },
  medium: { inputTokens: 850_000, cacheCreationTokens: 260_000, cacheReadTokens: 700_000, outputTokens: 35_000 },
  deep: { inputTokens: 2_800_000, cacheCreationTokens: 950_000, cacheReadTokens: 2_300_000, outputTokens: 110_000 },
};

const REVIEW_TOKENS: Record<Exclude<ReviewMode, 'none'>, StageTokenProfile> = {
  static: { inputTokens: 18_000, cacheCreationTokens: 4_000, cacheReadTokens: 10_000, outputTokens: 1_500 },
  llm: { inputTokens: 95_000, cacheCreationTokens: 25_000, cacheReadTokens: 80_000, outputTokens: 8_000 },
  'static+llm': { inputTokens: 180_000, cacheCreationTokens: 40_000, cacheReadTokens: 160_000, outputTokens: 12_000 },
};

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

function estimateStageCost(
  modelId: string,
  profile: StageTokenProfile | null,
  repoDir?: string,
): number {
  if (!profile) return 0;
  const pricing = loadPricingTable(repoDir)[modelId];
  if (!pricing) return 0;
  return roundMoney(computeModelCost(profile, pricing));
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
  const pool = getModelPool(repoDir);
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
    ? pickAvailableModel(pool, ['claude-opus-4-6', 'claude-sonnet-4-5-20250929', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel)
    : pickAvailableModel(pool, ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', coderRecommendation.recommendedModel], coderRecommendation.recommendedModel);

  const coder = codeDepth === 'deep'
    ? pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'claude-opus-4-6', 'gpt-5.4'], coderRecommendation.recommendedModel)
    : codeDepth === 'medium'
      ? pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-sonnet-4-5-20250929'], coderRecommendation.recommendedModel)
      : pickAvailableModel(pool, [coderRecommendation.recommendedModel, 'gpt-5.3-codex', 'claude-haiku-4-5-20251001'], coderRecommendation.recommendedModel);

  const reviewer = reviewRecommended === 'static+llm'
    ? pickAvailableModel(pool, ['claude-sonnet-4-5-20250929', 'claude-opus-4-6', planner], planner)
    : reviewRecommended === 'llm'
      ? pickAvailableModel(pool, ['claude-sonnet-4-5-20250929', 'claude-haiku-4-5-20251001', planner], planner)
      : pickAvailableModel(pool, ['claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', planner], planner);

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

  const reasoning = [
    `Task classified as ${characteristics.taskType} with ${characteristics.length} prompt length.`,
    `Risk score ${riskScore} from complexity, scope, and repo-surface keywords.`,
    `Coder baseline uses ${coderRecommendation.recommendedModel} from heuristic eval routing.`,
    `Review mode ${reviewRecommended} chosen to match expected change risk.`,
  ];

  return {
    planner,
    coder,
    reviewer,
    planDepth,
    codeDepth,
    reviewRecommended,
    expectedSuccess,
    expectedCostPlan: estimateStageCost(planner, PLAN_TOKENS[planDepth], repoDir),
    expectedCostCode: estimateStageCost(coder, CODE_TOKENS[codeDepth], repoDir),
    expectedCostReview: reviewRecommended === 'none'
      ? 0
      : estimateStageCost(reviewer, REVIEW_TOKENS[reviewRecommended as Exclude<ReviewMode, 'none'>], repoDir),
    reasoning,
    signals: {
      taskType: characteristics.taskType,
      promptLength: characteristics.length,
      complexityScore: characteristics.complexityScore,
      fileTypes: characteristics.fileTypes,
      riskScore,
    },
  };
}

export function routeWorkflowStageAware(
  prompt: string,
  options?: RouteWorkflowOptions,
): StageAwareDecision {
  const repoDir = options?.repoDir;
  const characteristics = analyzePrompt(prompt);
  const riskScore = computeRiskScore(prompt, characteristics);

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

  let decision: StageAwareDecision;
  if (!stageAwareDecision) {
    const fallback = routeWorkflow(prompt, options);
    decision = {
      ...fallback,
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
    decision = {
      ...stageAwareDecision,
      planner: fallback.planner,
      coder: fallback.coder,
      reviewer: fallback.reviewer,
      signals: {
        taskType: characteristics.taskType,
        promptLength: characteristics.length,
        complexityScore: characteristics.complexityScore,
        fileTypes: characteristics.fileTypes,
        riskScore,
      },
    };
  } else {
    decision = {
      ...stageAwareDecision,
      signals: {
        taskType: characteristics.taskType,
        promptLength: characteristics.length,
        complexityScore: characteristics.complexityScore,
        fileTypes: characteristics.fileTypes,
        riskScore,
      },
    };
  }

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

  if (recommendation.shouldChallenge) {
    return {
      ...decision,
      challengeRecommendation: recommendation,
    };
  }

  return decision;
}

export function summarizeWorkflowRoute(decision: WorkflowRouteDecision, repoDir?: string): string {
  const routerConfig = loadRouterConfig(repoDir);
  const defaultAgent = routerConfig.defaultAgent || 'claude';
  const agentMap = routerConfig.agentMap || {};

  const plannerAgent = resolveAgent(decision.planner, agentMap, defaultAgent);
  const coderAgent = resolveAgent(decision.coder, agentMap, defaultAgent);
  const reviewerAgent = resolveAgent(decision.reviewer, agentMap, defaultAgent);

  const lines = [
    `Planner:  ${decision.planner} (${plannerAgent})  depth=${decision.planDepth}  cost=$${decision.expectedCostPlan.toFixed(2)}`,
    `Coder:    ${decision.coder} (${coderAgent})  depth=${decision.codeDepth}  cost=$${decision.expectedCostCode.toFixed(2)}`,
    `Reviewer: ${decision.reviewer} (${reviewerAgent})  mode=${decision.reviewRecommended}  cost=$${decision.expectedCostReview.toFixed(2)}`,
    `Success:  ${(decision.expectedSuccess * 100).toFixed(0)}%  task=${decision.signals.taskType}  risk=${decision.signals.riskScore}`,
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
